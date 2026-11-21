// A static server for a production build that sends the build's own
// Content-Security-Policy (Pages' _headers), so a CSP violation shows in the
// page's console as it would when deployed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".sh": "text/plain",
};

export type Served = { url: string; csp: string | null; close: () => void };

// A path resolves to its file, or a directory's index.html, as Pages serves a
// multi-page build; anything else gets the root index.html
export function resolve(root: string, pathname: string): string {
  const f = path.join(root, decodeURIComponent(pathname));
  if (!f.startsWith(root)) return path.join(root, "index.html");
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  const index = path.join(f, "index.html");
  if (fs.existsSync(index)) return index;
  return path.join(root, "index.html");
}

export function serve(root: string): Promise<Served> {
  const h = path.join(root, "_headers");
  const csp = fs.existsSync(h)
    ? (fs.readFileSync(h, "utf8").match(/Content-Security-Policy: (.*)/)?.[1] ?? null)
    : null;
  const srv = http.createServer((req, res) => {
    const f = resolve(root, new URL(req.url ?? "/", "http://x").pathname);
    const headers: Record<string, string> = {
      "content-type": MIME[path.extname(f)] ?? "application/octet-stream",
    };
    if (csp) headers["content-security-policy"] = csp;
    res.writeHead(200, headers);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) =>
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      r({ url: `http://127.0.0.1:${port}/`, csp, close: () => srv.close() });
    }),
  );
}
