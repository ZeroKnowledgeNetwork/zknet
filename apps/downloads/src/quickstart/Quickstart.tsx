import type { ReactNode } from "react";
import { config } from "../config.ts";
import { Code, Footer, Header, Link } from "../ui.tsx";

// The client's frames, made by `nx run ui-shots:shots` (its guide-* views) and
// copied into public/quickstart/; regenerated when the client or the live
// network changes. Each opens at full size.
const Shot = ({ src, alt }: { src: string; alt: string }) => (
  <a href={`/quickstart/${src}`} className="block">
    <img
      src={`/quickstart/${src}`}
      alt={alt}
      width={1000}
      height={720}
      loading="lazy"
      className="w-full h-auto rounded-box border border-base-300"
    />
  </a>
);

function Step({
  n,
  title,
  shot,
  children,
}: {
  n: number;
  title: string;
  shot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid lg:grid-cols-[1fr_1.4fr] gap-6 lg:gap-10 items-start">
      <div className="flex gap-4 min-w-0">
        <span className="font-display text-primary text-2xl" aria-hidden>
          {n}
        </span>
        <div className="space-y-3 min-w-0">
          <h3 className="text-lg">{title}</h3>
          {children}
        </div>
      </div>
      {shot && <div className="min-w-0">{shot}</div>}
    </li>
  );
}

// The local URL a wallet uses, as the WalletShield page lists it
const RPC_URL = "http://localhost:7070/ethereum";

const WALLET_FIELDS: [string, string][] = [
  ["Network name", "Ethereum via ZKNet (any name)"],
  ["RPC URL", RPC_URL],
  ["Chain ID", "1"],
  ["Currency symbol", "ETH"],
];

// A real request and its answer, through the devnet on 2026-11-12
const CHECK = `curl -s -X POST -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \\
  ${RPC_URL}

{"jsonrpc":"2.0","result":"0x192dca7","id":1}`;

// zknet 0.1.0-beta.1's own output on a first connect (2026-11-12), with the
// network client's startup log elided at "…"
const CONNECT = `$ zknet connect
Starting zknet-client-cli v0.1.0-beta.1 on linux-x64
App data directory: /home/you/.local/share/zknet-client-cli
WalletShield: listen :7070 · log INFO
No network named: connecting to the default, devnet-78c3fdc8
Connecting to network devnet-78c3fdc8...
  ClientToml: downloading 11412 bytes
  ServicesJson: downloading 447 bytes
  Walletshield: downloading 6456040 bytes
  ClientToml: downloaded
  ServicesJson: downloaded
  Walletshield: downloaded
  Walletshield: verified, build client@0.2.0-beta.6
Starting network client...
…
14:43:05.647 INFO walletshield: connected to the mixnet epoch=2485401 exits=2
14:43:05.647 INFO walletshield: listening addr=:7070`;

const LIST = `$ zknet list
NETWORK ID        KIND      CREATED      STATUS      NAME
devnet-78c3fdc8   devnet    8 days ago   available   Devnet · 2026-11-04`;

export default function Quickstart() {
  return (
    <div className="min-h-screen bg-base-100 text-base-content font-sans">
      <Header
        nav={[
          ["Download", "/"],
          ["Source", config.sourceUrl],
          ["All releases", config.releasesUrl],
        ]}
      />

      <main>
        <section className="max-w-6xl mx-auto px-4 pt-6 pb-12 space-y-5">
          <h1 className="text-3xl sm:text-4xl leading-tight">
            Connect to <span className="text-primary">ZKNet</span>
          </h1>
          <p className="text-lg max-w-3xl">
            Install the client, connect to a mix network, and point your wallet at it.
          </p>
          <p className="flex items-center gap-2 text-sm">
            <span className="badge badge-secondary font-display">BETA</span>
            <span className="opacity-80">Evolving fast: expect changes.</span>
          </p>
        </section>

        <section id="desktop" className="bg-base-200 border-y border-base-300">
          <div className="max-w-6xl mx-auto px-4 py-12">
            <h2 className="text-2xl mb-8">The desktop client</h2>
            <ol className="space-y-12">
              <Step n={1} title="Install">
                <p className="opacity-80">
                  Download the client for your platform from the{" "}
                  <a className="link link-primary" href="/">
                    download page
                  </a>{" "}
                  and install it. On a server, or if you'd rather use a terminal, use the{" "}
                  <a className="link" href="#cli">
                    command-line client
                  </a>
                  .
                </p>
              </Step>
              <Step
                n={2}
                title="Choose a network"
                shot={
                  <Shot
                    src="networks.png"
                    alt="The ZKNetwork client's network list: one devnet, Available, its id filled in beside the Connect button."
                  />
                }
              >
                <p className="opacity-80">
                  Open ZKNetwork. It lists the mix networks you can join, newest first, and fills in
                  the newest.
                </p>
                <p className="opacity-80">
                  <strong>Available</strong>: its client is downloaded when you connect.{" "}
                  <strong>Ready</strong>: it's already on this device.
                </p>
              </Step>
              <Step
                n={3}
                title="Connect"
                shot={
                  <Shot
                    src="connected.png"
                    alt="The client connected: Connected Network: devnet-78c3fdc8, and a Disconnect button."
                  />
                }
              >
                <p className="opacity-80">
                  Press <strong>Connect</strong>. The client downloads the network's client if it
                  needs to, checks its signature, and starts it.
                </p>
                <p className="opacity-80">
                  Once it shows <strong>Connected Network</strong>, WalletShield is running on your
                  computer. <strong>Disconnect</strong> stops it.
                </p>
              </Step>
            </ol>
          </div>
        </section>

        <section id="wallet" className="max-w-6xl mx-auto px-4 py-12 space-y-8">
          <div className="space-y-3 max-w-3xl">
            <h2 className="text-2xl">WalletShield: The First App on ZKNet</h2>
            <p className="opacity-80">
              WalletShield routes your wallet's RPC traffic through post-quantum mixnet deployments,
              so RPC providers can't link your network identity to your wallet activity.
            </p>
            <p className="opacity-80">
              Every balance check, transaction, and contract call goes through an RPC provider,
              which can expose your IP and reveal patterns in your activity. WalletShield encrypts
              these requests, mixes them with other users' traffic and decoy traffic, and relays
              them through multiple nodes. Providers see requests coming from the mixnet, not from
              your device.
            </p>
            <p className="opacity-80">
              <strong>Works with any wallet that supports a custom RPC URL.</strong> It's the first
              of many apps built on ZKNet.
            </p>
          </div>
          <ol className="space-y-12" start={4}>
            <Step
              n={4}
              title="Point your wallet at it"
              shot={
                <Shot
                  src="walletshield.png"
                  alt="The client's WalletShield page: Ethereum, Polygon and BSC, each with a local RPC URL such as http://localhost:7070/ethereum."
                />
              }
            >
              <p className="opacity-80">
                In the client's menu, open <strong>WalletShield</strong>. It lists the chains the
                network serves, each with its local URL; click one to copy it.
              </p>
              <p className="opacity-80">
                In your wallet, add a network (most wallets call it a custom network) with that URL:
              </p>
              <table className="table table-sm bg-base-200 rounded-box">
                <tbody>
                  {WALLET_FIELDS.map(([k, v]) => (
                    <tr key={k}>
                      <th className="font-normal opacity-80 whitespace-nowrap">{k}</th>
                      <td className="font-mono text-xs break-all">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm opacity-80">
                The chain ID is the chain's own, the one beside its URL.
              </p>
            </Step>
            <Step n={5} title="Check that it works" shot={<Code>{CHECK}</Code>}>
              <p className="opacity-80">Ask for the latest block, from a terminal.</p>
              <p className="opacity-80">
                The answer arrives in a few seconds: the mixnet holds and reorders requests on
                purpose, so their timing can't give you away.
              </p>
            </Step>
          </ol>
        </section>

        <section id="cli" className="bg-base-200 border-y border-base-300">
          <div className="max-w-6xl mx-auto px-4 py-12 grid lg:grid-cols-[1fr_1.4fr] gap-8">
            <div className="space-y-3">
              <h2 className="text-2xl">In a terminal</h2>
              <p className="opacity-80">
                <code>zknet connect</code> does the same in one command: it connects to the newest
                network and runs WalletShield on port 7070 until you press <kbd>Ctrl</kbd>+
                <kbd>C</kbd>. Point your wallet at it as in step 4.
              </p>
              <p className="opacity-80">
                Name a network to choose another: <code>zknet connect &lt;network-id&gt;</code>.
              </p>
            </div>
            <div className="space-y-4 min-w-0">
              {config.siteUrl && <Code>{`curl -fsSL ${config.siteUrl}/install.sh | sh`}</Code>}
              <Code>{CONNECT}</Code>
              <Code>{LIST}</Code>
            </div>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 py-12">
          <h2 className="text-2xl mb-6">Good to know</h2>
          <ul className="grid md:grid-cols-3 gap-6 text-sm">
            <li className="space-y-1">
              <h3 className="text-sm">Run it where your wallet runs</h3>
              <p className="opacity-80">
                With the client on the same computer as your wallet, every request leaves your
                computer already shielded.
              </p>
            </li>
            <li className="space-y-1">
              <h3 className="text-sm">One client, every wallet</h3>
              <p className="opacity-80">
                Point as many wallets at it as you like, on any chain it lists.
              </p>
            </li>
            <li className="space-y-1">
              <h3 className="text-sm">Quiet times stay private too</h3>
              <p className="opacity-80">
                While connected, the client keeps up a steady stream of decoy traffic, so no one can
                tell when you're active. It uses bandwidth to do it, even when your wallet is idle.
              </p>
            </li>
          </ul>
          <p className="text-sm opacity-70 mt-8">
            Today's networks are devnets: as ZKNet evolves, a newer one takes over, and the client
            always offers the newest.{" "}
            <Link href={config.sourceUrl}>Source and build instructions</Link>
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
