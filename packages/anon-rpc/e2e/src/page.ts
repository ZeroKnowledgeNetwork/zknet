// Builds the host page against a harness and serves it.
//
// Default: the npm-pinned @anon-rpc/browser-harness this package depends on.
// Fork tier: an alias to a harness built from an anon-rpc checkout. The
// esbuild metafile records which harness file actually went into the page, so
// a spec can prove what it ran against.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { E2E_DIR } from "./paths.js";

export interface HarnessSource {
  /** Label surfaced as window.e2e.harness. */
  label: string;
  /** The harness module file the page imports; undefined resolves the npm dependency. */
  file?: string;
}

/** The npm-pinned harness: name@version from its installed package.json. */
export function pinnedHarness(): HarnessSource & { version: string; dir: string } {
  const require = createRequire(join(E2E_DIR, "package.json"));
  const pkgFile = require.resolve("@anon-rpc/browser-harness/package.json");
  const { name, version } = JSON.parse(readFileSync(pkgFile, "utf8")) as {
    name: string;
    version: string;
  };
  return { label: `npm:${name}@${version}`, version, dir: join(pkgFile, "..") };
}

export interface PageBundle {
  js: string;
  /** Inputs esbuild bundled whose path names the harness, relative to this package. */
  harnessInputs: string[];
  label: string;
}

export async function bundlePage(harness: HarnessSource): Promise<PageBundle> {
  const result = await build({
    absWorkingDir: E2E_DIR,
    entryPoints: ["page/main.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    logLevel: "warning",
    define: { __HARNESS__: JSON.stringify(harness.label) },
    ...(harness.file ? { alias: { "@anon-rpc/browser-harness": harness.file } } : {}),
  });
  const js = result.outputFiles[0]?.text ?? "";
  const harnessInputs = Object.keys(result.metafile.inputs).filter((p) =>
    /browser-harness/.test(p),
  );
  return { js, harnessInputs, label: harness.label };
}

const INDEX = `<!doctype html>
<meta charset="utf-8" />
<title>ZKNet anon-rpc e2e host page</title>
<script type="module" src="/page.js"></script>
<p>Host page for the ZKNet anon-rpc worker e2e (driven through window.e2e).</p>
`;

export interface PageServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serve the page on 127.0.0.1. `tls` serves https (the fork tier's public
 * page); otherwise http, which Chromium treats as a loopback, LNA-ungated page.
 */
export async function servePage(
  page: PageBundle,
  tls?: { key: string; cert: string },
): Promise<PageServer> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(INDEX);
    } else if (path === "/page.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(page.js);
    } else {
      res.writeHead(404).end();
    }
  };
  const server: Server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `${tls ? "https" : "http"}://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
