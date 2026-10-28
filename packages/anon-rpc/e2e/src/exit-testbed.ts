// The live tier's exit test bed: an https stub the dev mix's exit can reach,
// and the exit config that lets it.
//
// The exit refuses every private address for a user-chosen URL, and a
// containerized exit reaches the host only on its compose network's private
// gateway. So the bed sets the exit's test-bed knobs, [UserURLs] AllowCIDRs
// (the gateway alone) and RootCAs (the stub's self-signed certificate), and
// restarts the service node; close() puts the packaged config back. Run only
// against a disposable dev mix.
//
// The worker refuses private literals itself, so the stub is named: the
// restarted exit container gets /etc/hosts entries under the reserved `.test`
// TLD (public wildcard DNS such as nip.io is no help: resolvers commonly drop
// private answers). A second name resolves to an RFC 1918 address the bed
// does not allow, to show the exit's after-DNS refusal.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { selfSigned } from "./fork.js";

/** The dev mix's net directory, as packages/opt/docker lays it out. */
export const DEFAULT_BED = "/tmp/katzenpost.opt/docker/mixnet-alpine";

const CA_FILE = "testbed-stub.pem";

/** The stub's name, and a name for a private address the bed does not allow. */
export const STUB_HOST = "stub.exit-testbed.test";
export const PRIVATE_HOST = "rfc1918.exit-testbed.test";

export interface ExitTestbed {
  /** The stub's https origin, by STUB_HOST. */
  origin: string;
  /** Requests the stub received, as `METHOD path`. */
  seen: string[];
  close(): Promise<void>;
}

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/**
 * Stub routes: `/slow` answers after `slowMs`, `/delay/<ms>` after `<ms>`,
 * `/big` with `bigBytes` bytes, `/redirect-private` with a 307 to a private
 * address, anything else with a JSON-RPC result.
 */
export async function startExitTestbed(
  bed = DEFAULT_BED,
  opts: { slowMs?: number; bigBytes?: number } = {},
): Promise<ExitTestbed> {
  const names = docker("ps", "--filter", "name=servicenode1", "--format", "{{.Names}}")
    .split("\n")
    .filter(Boolean);
  if (names.length !== 1)
    throw new Error(
      `expected one running servicenode1 container, found: ${names.join(", ") || "none"}`,
    );
  const container = names[0]!;
  const gateway = docker(
    "inspect",
    container,
    "-f",
    "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}",
  );
  const mount = docker(
    "inspect",
    container,
    "-f",
    `{{range .Mounts}}{{if eq .Source "${bed}"}}{{.Destination}}{{end}}{{end}}`,
  );
  if (!gateway || !mount)
    throw new Error(`${container}: no network gateway, or ${bed} is not mounted`);

  const tls = selfSigned(gateway, STUB_HOST);
  const seen: string[] = [];
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    const delay = /^\/delay\/(\d+)$/.exec(req.url ?? "");
    if (delay) {
      setTimeout(
        () =>
          res
            .writeHead(200, { "content-type": "application/json" })
            .end('{"jsonrpc":"2.0","id":1,"result":"0xdelay"}'),
        Number(delay[1]),
      );
    } else if (req.url === "/slow") {
      setTimeout(
        () =>
          res
            .writeHead(200, { "content-type": "application/json" })
            .end('{"jsonrpc":"2.0","id":1,"result":"0xslow"}'),
        opts.slowMs ?? 15_000,
      );
    } else if (req.url === "/big") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(Buffer.alloc(opts.bigBytes ?? 2 * 1024 * 1024, 0x20));
    } else if (req.url === "/redirect-private") {
      res.writeHead(307, { location: "https://10.0.0.1/" }).end();
    } else {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","id":1,"result":"0xstub"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, gateway, resolve));
  const origin = `https://${STUB_HOST}:${(server.address() as AddressInfo).port}`;

  const configFile = join(bed, "servicenode1/rpc_proxy_config.toml");
  const packaged = readFileSync(configFile, "utf8");
  writeFileSync(join(bed, "servicenode1", CA_FILE), tls.cert);
  writeFileSync(
    configFile,
    packaged
      .replace(/^(\s*AllowCIDRs\s*=).*$/m, `$1 ["${gateway}/32"]`)
      .replace(/^(\s*RootCAs\s*=).*$/m, `$1 "${mount}/servicenode1/${CA_FILE}"`),
  );
  docker("restart", container);
  // After the restart: a restart rewrites /etc/hosts. close() restarts it again.
  docker(
    "exec",
    container,
    "sh",
    "-c",
    `printf '%s %s\n%s %s\n' ${gateway} ${STUB_HOST} 10.0.0.1 ${PRIVATE_HOST} >> /etc/hosts`,
  );

  return {
    origin,
    seen,
    async close() {
      writeFileSync(configFile, packaged);
      rmSync(join(bed, "servicenode1", CA_FILE), { force: true });
      docker("restart", container);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
