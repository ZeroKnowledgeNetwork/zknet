// SPDX-FileCopyrightText: © 2023 David Stainton
// SPDX-FileCopyrightText: © 2024 the ZKNetwork authors
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/carlmjohnson/versioninfo"
	"github.com/charmbracelet/log"
	"github.com/fxamacker/cbor/v2"

	"github.com/katzenpost/hpqc/hash"
	"github.com/katzenpost/hpqc/rand"

	"github.com/katzenpost/katzenpost/client"
	"github.com/katzenpost/katzenpost/client/config"
	"github.com/katzenpost/katzenpost/client/thin"
	ttransport "github.com/katzenpost/katzenpost/client/thin/transport"
	ctransport "github.com/katzenpost/katzenpost/client/transport"
	sConstants "github.com/katzenpost/katzenpost/core/sphinx/constants"

	"github.com/ZeroKnowledgeNetwork/opt/common"
	"github.com/ZeroKnowledgeNetwork/opt/server_plugins/cbor_plugins/rpc_proxy"
)

var (
	timeout         = 20 // (default) context timeout
	RPCProxyService = "rpc_proxy"

	// Note: UserForwardPayloadLength should match the same value passed to genconfig.
	UserForwardPayloadLength = 30000

	// errTooLarge marks a request that does not fit one mixnet payload.
	errTooLarge = errors.New("payload too large")
)

// version identifies the build: set with -ldflags "-X main.version=..." where
// the build has no VCS metadata to stamp (a docker build sees no .git).
var version string

// buildVersion is version, or the VCS stamp of a plain go build.
func buildVersion() string {
	if version != "" {
		return version
	}
	return versioninfo.Short()
}

// healthPath is answered locally, without a mixnet round trip, so a client can
// tell an absent WalletShield from an unreachable mixnet.
const healthPath = "/_/health"

// failureStatus is the HTTP status of each reply WalletShield originates
// instead of relaying from the upstream.
var failureStatus = map[string]int{
	rpc_proxy.ReasonMixTimeout:           http.StatusGatewayTimeout,
	rpc_proxy.ReasonExitRefused:          http.StatusBadGateway,
	rpc_proxy.ReasonUpstreamUnreachable:  http.StatusBadGateway,
	rpc_proxy.ReasonTooLarge:             http.StatusRequestEntityTooLarge,
	rpc_proxy.ReasonBadReply:             http.StatusBadGateway,
	rpc_proxy.ReasonExitBusy:             http.StatusServiceUnavailable,
	rpc_proxy.ReasonProviderSelectionOff: http.StatusBadGateway,
}

// sendRequest carries one inner request (rpc_proxy.NewInnerRequest) to the
// exit. userURL, when not empty, is the upstream the user chose
// (rpc_proxy.Request.URL).
func sendRequest(thin *thin.ThinClient, httpRequestBytes []byte, userURL string) ([]byte, error) {
	// Compress the HTTP request
	compressedPayload, err := common.CompressData(httpRequestBytes)
	if err != nil {
		return nil, fmt.Errorf("common.CompressData failed: %w", err)
	}

	// Create the request wrapper
	request := &rpc_proxy.Request{
		Payload: compressedPayload,
		URL:     userURL,
	}

	// Marshal to CBOR
	blob, err := cbor.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("cbor.Marshal failed: %w", err)
	}

	// Validate payload size
	if len(blob) > UserForwardPayloadLength {
		return nil, fmt.Errorf("%w: payload size %d exceeds maximum %d bytes", errTooLarge, len(blob), UserForwardPayloadLength)
	}

	surbID := &[sConstants.SURBIDLength]byte{}
	_, err = rand.Reader.Read(surbID[:])
	if err != nil {
		panic(err)
	}

	// Select a target service node and compute the DestinationIdHash
	target, err := thin.GetService(RPCProxyService)
	if err != nil {
		return nil, fmt.Errorf("thin.GetService failed: %w", err)
	}
	nodeId := hash.Sum256(target.MixDescriptor.IdentityKey)

	timeoutCtx, cancel := context.WithTimeout(context.TODO(), time.Duration(timeout)*time.Second)
	defer cancel()
	return thin.BlockingSendMessage(timeoutCtx, blob, &nodeId, target.RecipientQueueID)
}

type Server struct {
	log    *log.Logger
	daemon *client.Daemon
	thin   *thin.ThinClient

	// send carries one inner request, and the user's provider URL
	// when there is one, over the mixnet and returns the raw reply.
	send func(httpRequestBytes []byte, userURL string) ([]byte, error)

	// requests numbers the requests for the log.
	requests atomic.Uint64
}

// setListenAddress overrides the address of the client daemon's configured
// thin-client listen transport. The transport flavor is chosen by the config
// file's [Listen] subtable; only the address is overridable here.
func setListenAddress(c *ctransport.ListenConfig, addr string) error {
	if err := c.Validate(); err != nil {
		return fmt.Errorf("cannot override client listen address: %w", err)
	}
	switch {
	case c.Unix != nil:
		c.Unix.Address = addr
		c.Unix.Addresses = nil
	case c.Tcp != nil:
		c.Tcp.Address = addr
	case c.Ws != nil:
		c.Ws.Address = addr
	}
	return nil
}

// setDialAddress overrides the address the thin client dials, mirroring
// setListenAddress for the [Dial] subtable.
func setDialAddress(c *ttransport.DialConfig, addr string) error {
	if err := c.Validate(); err != nil {
		return fmt.Errorf("cannot override thin client dial address: %w", err)
	}
	switch {
	case c.Unix != nil:
		c.Unix.Address = addr
	case c.Tcp != nil:
		c.Tcp.Address = addr
	case c.Ws != nil:
		c.Ws.Address = addr
	}
	return nil
}

// isThinConfig reports whether the config at path is a thin client config: one
// that dials an existing client daemon instead of starting its own. The thin
// loader rejects every key it does not know, so a full client config never
// passes as one. The config, not the caller, decides the mode.
func isThinConfig(path string) bool {
	_, err := thin.LoadFile(path)
	return err == nil
}

func main() {
	var logLevel string
	var listenAddr string
	var listenAddrClient string
	var configPath string
	var delayStart int
	var testProbe bool
	var testProbeCount int
	var testProbeResponseDelay int
	var testProbeSendDelay int
	var thinClientOnly bool

	flag.StringVar(&configPath, "config", "", "file path of the client configuration TOML file")
	flag.IntVar(&delayStart, "delay_start", 0, "max random seconds to delay start")
	flag.StringVar(&logLevel, "log_level", "DEBUG", "logging level: DEBUG (every request in full), INFO (one line per request), WARN or ERROR")
	flag.StringVar(&listenAddr, "listen", "", "local socket to listen HTTP on")
	flag.StringVar(&listenAddrClient, "listen_client", "", "local network address for the client daemon")
	flag.BoolVar(&testProbe, "probe", false, "send test probes instead of handling requests")
	flag.IntVar(&testProbeCount, "probe_count", 1, "number of test probes to send")
	flag.IntVar(&testProbeResponseDelay, "probe_response_delay", 0, "test probe response deplay")
	flag.IntVar(&testProbeSendDelay, "probe_send_delay", 10, "test probe delay between probes")
	flag.IntVar(&timeout, "timeout", timeout, "seconds to wait for a request")
	flag.BoolVar(&thinClientOnly, "thin", false, "force thin client mode (default: inferred from -config)")
	flag.Parse()

	if listenAddr == "" && !testProbe {
		panic("listen flag must be set")
	}
	if configPath == "" {
		panic("config flag must be set")
	}

	// logging
	level, err := log.ParseLevel(logLevel)
	if err != nil {
		panic(err)
	}
	mylog := newLogger(os.Stdout, level)
	thinClientOnly = thinClientOnly || isThinConfig(configPath)
	mode := "daemon"
	if thinClientOnly {
		mode = "thin"
	}
	mylog.Info("starting", "version", buildVersion(), "mode", mode, "log", level)

	if delayStart > 0 {
		d := rand.NewMath().Intn(delayStart)
		mylog.Infof("Delaying start for %d seconds...", d)
		time.Sleep(time.Duration(d) * time.Second)
	}

	// start client daemon
	var d *client.Daemon
	var cfgThin *thin.Config
	if !thinClientOnly {
		cfg, err := config.LoadFile(configPath)
		if err != nil {
			panic(err)
		}

		if listenAddrClient != "" {
			if err := setListenAddress(cfg.Listen, listenAddrClient); err != nil {
				panic(err)
			}
		}

		d, err = client.NewDaemon(cfg)
		if err != nil {
			panic(err)
		}
		err = d.Start()
		if err != nil {
			panic(err)
		}

		cfgThin = thin.FromConfig(cfg)

		mylog.Debug("waiting 3s for the client daemon to start")
		time.Sleep(time.Second * 3) // XXX ugly hack but works: FIXME
	} else {
		cfgThin, err = thin.LoadFile(configPath)
		if err != nil {
			panic(fmt.Errorf("failed to open thin client config: %s", err))
		}

		if listenAddrClient != "" {
			if err := setDialAddress(cfgThin.Dial, listenAddrClient); err != nil {
				panic(err)
			}
		}
	}

	logging := &config.Logging{
		Disable: false,
		Level:   level.String(),
	}

	thin := thin.NewThinClient(cfgThin, logging)
	err = thin.Dial()
	if err != nil {
		mylog.Fatal("cannot connect to the client daemon", "err", err)
	}
	logMixnet(mylog, thin)

	// http server
	server := &Server{
		log:    mylog,
		thin:   thin,
		daemon: d,
	}
	server.send = func(b []byte, userURL string) ([]byte, error) { return sendRequest(thin, b, userURL) }

	if testProbe {
		server.SendTestProbes(testProbeSendDelay, testProbeCount, testProbeResponseDelay)
		d.Shutdown()
	} else {
		http.HandleFunc("/", withCORS(server.Handler))
		mylog.Info("listening", "addr", listenAddr)
		err := http.ListenAndServe(listenAddr, nil)
		if err != nil {
			// Check if the error is related to the port being in use
			if strings.Contains(err.Error(), "bind: address already in use") {
				mylog.Error("cannot listen: the port is in use; is another WalletShield running?", "addr", listenAddr)
			} else {
				mylog.Error("cannot listen", "addr", listenAddr, "err", err)
			}
		}
	}
}

// newLogger is WalletShield's logger: HH:MM:SS.mmm LEVEL walletshield: <msg>
// key=value ...
func newLogger(w io.Writer, level log.Level) *log.Logger {
	return log.NewWithOptions(w, log.Options{
		Prefix:          "walletshield",
		Level:           level,
		ReportTimestamp: true,
		TimeFormat:      "15:04:05.000",
	})
}

// logMixnet reports what the client sees of the mixnet once connected: the
// PKI epoch and how many exits offer the proxy service.
func logMixnet(l *log.Logger, t *thin.ThinClient) {
	doc := t.PKIDocument()
	if doc == nil {
		l.Warn("connected to the client daemon, but it has no PKI document yet")
		return
	}
	exits, _ := t.GetServices(RPCProxyService)
	if len(exits) == 0 {
		l.Warn("connected to the mixnet, but no exit offers "+RPCProxyService+"; requests will fail", "epoch", doc.Epoch)
		return
	}
	l.Info("connected to the mixnet", "epoch", doc.Epoch, "exits", len(exits))
}

// The request log. WalletShield runs on the user's own machine, so its log
// is the user's to read; the levels set how much of it they see. Each request
// is numbered (id), and every line about it carries id, route and to:
//
//	network  POST /<network key>, to= the key
//	url      POST /_/url with the provider in ZKNet-URL, to= its host
//	probe    /_/probe/<delay>, an exit round trip without an upstream
//
// INFO logs one "rpc" line per request when it ends: the JSON-RPC method,
// status, body sizes and total time (took), or a WARN with the failure reason.
// It never carries a body, a header value or a URL beyond the provider's host.
//
// The rpc line is the record. DEBUG attaches what it lacks, keyed by id, in the
// same stream: a "request" line on arrival with the route, the full URL, the
// headers as they arrived and the body, and a "reply" line when the exit
// answered, with the headers that came back from it and the body. Their JSON
// is written raw, one record per line, so a value pastes into jq.

// rpcMethod names a JSON-RPC request body for the log: its method, batch(N)
// for a batch, or ? when the body is not JSON-RPC.
func rpcMethod(body []byte) string {
	body = bytes.TrimSpace(body)
	if len(body) > 0 && body[0] == '[' {
		var batch []json.RawMessage
		if json.Unmarshal(body, &batch) == nil {
			return fmt.Sprintf("batch(%d)", len(batch))
		}
		return "?"
	}
	var call struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(body, &call) == nil && call.Method != "" {
		return call.Method
	}
	return "?"
}

// route classifies a request for the log; see above.
func route(path, userURL string) (form, to string) {
	switch {
	case path == rpc_proxy.UserURLPath:
		to = "(none)"
		if u, err := url.Parse(userURL); err == nil && u.Host != "" {
			to = u.Host
		} else if userURL != "" {
			to = "(unparsable)"
		}
		return "url", to
	case strings.HasPrefix(path, "/_/probe"):
		return "probe", "exit"
	default:
		return "network", strings.TrimPrefix(path, "/")
	}
}

// rawJSON is b compacted for a one-line log value, or b as a quoted string
// when it is not JSON.
func rawJSON(b []byte) string {
	var c bytes.Buffer
	if len(bytes.TrimSpace(b)) > 0 && json.Compact(&c, b) == nil {
		return c.String()
	}
	return strconv.Quote(string(b))
}

// headersJSON is h as a compact JSON object.
func headersJSON(h http.Header) string {
	if h == nil {
		h = http.Header{}
	}
	b, _ := json.Marshal(h)
	return string(b)
}

// logValue is s as a log value: as is, or quoted when it would not read as
// one value.
func logValue(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\r\n\"\\") {
		return strconv.Quote(s)
	}
	return s
}

func (s *Server) Handler(w http.ResponseWriter, req *http.Request) {
	start := time.Now()

	if req.Method == http.MethodGet && req.URL.Path == healthPath {
		writeJSON(w, http.StatusOK, map[string]string{"version": buildVersion()})
		return
	}

	id := s.requests.Add(1)
	debug := s.log.GetLevel() <= log.DebugLevel
	l := s.log.With("id", id)
	rpc, in := "?", 0
	warn := func(reason, message string) {
		l.Warn("rpc", "rpc", rpc, "status", failureStatus[reason], "reason", reason, "in", size(in), "took", since(start), "err", message)
	}
	fail := func(reason, message string) {
		warn(reason, message)
		writeFailure(w, reason, message)
	}

	myurl, err := url.Parse(req.RequestURI)
	if err != nil {
		fail(rpc_proxy.ReasonExitRefused, "the request URI does not parse")
		return
	}

	// The DEBUG request line shows the headers as they arrived, ZKNet-URL
	// included.
	var inHeaders string
	if debug {
		inHeaders = headersJSON(req.Header)
	}
	full := *myurl
	if !full.IsAbs() {
		full.Scheme, full.Host = "http", req.Host
	}
	fullURL := full.String()

	// Provider selection: POST /_/url names its upstream in URLHeader. The
	// header never crosses the mixnet; INFO logs only the URL's host.
	userURL := req.Header.Get(rpc_proxy.URLHeader)
	form, to := route(myurl.Path, userURL)
	l = l.With("route", form, "to", to)
	if form == "url" {
		fullURL = userURL
		if userURL == "" {
			fullURL = "(none)"
		}
	} else {
		userURL = ""
	}

	body, err := io.ReadAll(req.Body)
	if err != nil {
		fail(rpc_proxy.ReasonExitRefused, "cannot read the request body")
		return
	}
	rpc, in = rpcMethod(body), len(body)
	if debug {
		s.log.Debug(fmt.Sprintf("request id=%d route=%s url=%s headers=%s body=%s",
			id, form, logValue(fullURL), inHeaders, rawJSON(body)))
	}
	// reply logs, at DEBUG, the headers that came back from the exit and the
	// body the caller receives.
	reply := func(header http.Header, body []byte) {
		if debug {
			s.log.Debug(fmt.Sprintf("reply id=%d headers=%s body=%s", id, headersJSON(header), rawJSON(body)))
		}
	}

	if form == "url" && userURL == "" {
		fail(rpc_proxy.ReasonExitRefused, fmt.Sprintf("POST %s needs a %s header", rpc_proxy.UserURLPath, rpc_proxy.URLHeader))
		return
	}

	// The exit gets a request built afresh from the fields it uses, never
	// the caller's: no browser header crosses the mixnet. A query is dropped.
	inner, err := rpc_proxy.NewInnerRequest(req.Method, myurl.EscapedPath(), req.Header.Get("Content-Type"), body)
	if err != nil {
		fail(rpc_proxy.ReasonExitRefused, err.Error())
		return
	}

	rawReply, err := s.send(inner, userURL)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			fail(rpc_proxy.ReasonTooLarge, err.Error())
		} else {
			fail(rpc_proxy.ReasonMixTimeout, err.Error())
		}
		return
	}

	// use the streaming decoder and simply return the first cbor object
	// and then discard the decoder and buffer
	response := new(rpc_proxy.Response)
	dec := cbor.NewDecoder(bytes.NewReader(rawReply))
	err = dec.Decode(response)
	if err != nil {
		fail(rpc_proxy.ReasonBadReply, fmt.Sprintf("cannot decode exit reply: %s", err))
		return
	}

	if response.Error != "" {
		reason := exitReason(response)
		body := failureHeaders(w, reason, response.Error)
		reply(http.Header{http.CanonicalHeaderKey(rpc_proxy.ErrorHeader): {reason}}, body)
		warn(reason, response.Error)
		w.WriteHeader(failureStatus[reason])
		w.Write(body)
		return
	}

	responsePayload, err := common.DecompressData(response.Payload)
	if err != nil {
		fail(rpc_proxy.ReasonBadReply, fmt.Sprintf("cannot decompress exit reply: %s", err))
		return
	}

	status := response.Status
	header := rpc_proxy.FilterHeaders(response.Header)
	if status < 200 || status > 599 {
		fail(rpc_proxy.ReasonBadReply, fmt.Sprintf("invalid upstream status %d", status))
		return
	}

	for k, v := range header {
		w.Header()[k] = v
	}
	if _, ok := header["Content-Type"]; !ok {
		// Relay the upstream's absent Content-Type instead of sniffing one.
		w.Header()["Content-Type"] = nil
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(responsePayload)))
	reply(header, responsePayload)
	l.Info("rpc", "rpc", rpc, "status", status, "in", size(in), "out", size(len(responsePayload)), "took", since(start))
	w.WriteHeader(status)
	w.Write(responsePayload)
}

// since is the time from t, rounded for the log.
func since(t time.Time) time.Duration {
	return time.Since(t).Round(time.Millisecond)
}

// size is a byte count for the log.
func size(n int) string {
	return fmt.Sprintf("%dB", n)
}

// exitReason returns the Reason of an exit error reply; a reason this
// WalletShield does not know is ReasonExitRefused.
func exitReason(r *rpc_proxy.Response) string {
	if _, ok := failureStatus[r.Reason]; ok {
		return r.Reason
	}
	return rpc_proxy.ReasonExitRefused
}

// writeFailure answers with a reply WalletShield originates, marked by
// ErrorHeader so it is never mistaken for an upstream reply.
func writeFailure(w http.ResponseWriter, reason, message string) {
	body := failureHeaders(w, reason, message)
	w.WriteHeader(failureStatus[reason])
	w.Write(body)
}

// failureHeaders sets the headers of a failure reply and returns its body.
func failureHeaders(w http.ResponseWriter, reason, message string) []byte {
	type failure struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	}
	w.Header().Set(rpc_proxy.ErrorHeader, reason)
	return jsonHeaders(w, map[string]failure{"error": {reason, message}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body := jsonHeaders(w, v)
	w.WriteHeader(status)
	w.Write(body)
}

// jsonHeaders sets the headers of a JSON reply and returns its body.
func jsonHeaders(w http.ResponseWriter, v any) []byte {
	body, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	return body
}

// probeStats tallies the probes of -probe mode.
type probeStats struct {
	sent, got                int
	rttMin, rttMax, rttTotal time.Duration
}

func (p *probeStats) lost() { p.sent++ }

func (p *probeStats) received(rtt time.Duration) {
	p.sent++
	p.got++
	p.rttTotal += rtt
	if p.got == 1 || rtt < p.rttMin {
		p.rttMin = rtt
	}
	p.rttMax = max(p.rttMax, rtt)
}

// log logs the tally so far, in the units of the rpc line's took:
// probe sent= received= loss= rtt_min= rtt_avg= rtt_max=, without the rtt
// fields until a probe comes back.
func (p *probeStats) log(l *log.Logger) {
	loss := float64(p.sent-p.got) / float64(p.sent) * 100
	kv := []any{"sent", p.sent, "received", p.got, "loss", fmt.Sprintf("%.0f%%", loss)}
	if p.got > 0 {
		avg := (p.rttTotal / time.Duration(p.got)).Round(time.Millisecond)
		kv = append(kv, "rtt_min", p.rttMin, "rtt_avg", avg, "rtt_max", p.rttMax)
	}
	l.Info("probe", kv...)
}

func (s *Server) SendTestProbes(testProbeSendDelay int, testProbeCount int, testProbeResponseDelay int) {
	path := fmt.Sprintf("/_/probe/%d", testProbeResponseDelay)
	httpRequestBytes, err := rpc_proxy.NewInnerRequest(http.MethodGet, path, "", nil)
	if err != nil {
		s.log.Errorf("rpc_proxy.NewInnerRequest failed: %s", err)
		return
	}

	var stats probeStats
	for {
		t := time.Now()
		_, err = sendRequest(s.thin, httpRequestBytes, "")
		if err != nil {
			s.log.Warn("probe", "sent", stats.sent+1, "took", since(t), "err", err)
			stats.lost()
		} else {
			stats.received(since(t))
		}
		stats.log(s.log)

		// probe indefinitely if testProbeCount is 0
		if testProbeCount != 0 && stats.sent >= testProbeCount {
			os.Exit(0)
		}

		time.Sleep(time.Duration(testProbeSendDelay) * time.Second)
	}
}
