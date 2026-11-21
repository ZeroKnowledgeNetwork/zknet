// Screenshots of the desktop client and the downloads page from their production
// builds, with every visible color measured and graded. Exits 1 when anything is
// below its WCAG threshold, a focus indicator is, or the page logs a CSP error.
//
//   node packages/ui-shots/src/shots.ts [--label <name>] [--env-file <path>] [--origin <url>]
//
// Run it through Nx (`nx run ui-shots:shots`), which builds both apps first.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { chromium, type Browser, type Page } from "@playwright/test";
import { backend, installBackend, type Mode } from "./fixture.ts";
import { grade, markdown, type Measured } from "./grade.ts";
import { focusProbe, measure, type FocusRow, type Row } from "./measure.ts";
import { serve } from "./serve.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const project = path.resolve(import.meta.dirname, "..");

const { values: opt } = parseArgs({
  options: {
    label: { type: "string", default: "current" },
    // the downloads page's settings (apps/downloads/.env.example's keys); given,
    // the page is rebuilt with them, since Vite bakes them in at build time
    "env-file": { type: "string" },
    // the origin the downloads page is served as; default: the env file's VITE_SITE_URL
    origin: { type: "string" },
  },
});
if (!/^[\w.-]+$/.test(opt.label))
  throw new Error(`--label: letters, digits, '.', '_' and '-' only`);

const outDir = path.join(project, "out", opt.label);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const clientDist = path.join(root, "apps/client/dist");
let downloadsDist = path.join(root, "apps/downloads/dist");
let siteEnv: Record<string, string> = {};

if (opt["env-file"]) {
  const file = path.resolve(opt["env-file"]);
  siteEnv = parseEnv(fs.readFileSync(file, "utf8")) as Record<string, string>;
  downloadsDist = path.join(outDir, "build/downloads");
  // the process environment wins over apps/downloads/.env in Vite, empty values included
  const r = spawnSync(
    "node_modules/.bin/vite",
    ["build", "--outDir", downloadsDist, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: path.join(root, "apps/downloads"),
      env: { ...process.env, ...siteEnv },
      stdio: "inherit",
    },
  );
  if (r.status !== 0) throw new Error(`downloads build with ${file} failed`);
}
for (const d of [clientDist, downloadsDist])
  if (!fs.existsSync(path.join(d, "index.html")))
    throw new Error(`${d}: no build; run through nx, which builds it first`);
const origin = (opt.origin || siteEnv.VITE_SITE_URL || "https://get.zknet.io").replace(/\/$/, "");

const CLIENT_VIEWPORT = { width: 1000, height: 720 };
const results: Record<string, Row[]> = {};
const focusRows: Record<string, FocusRow[]> = {};
const cspErrors: string[] = [];

// Partial raster repaints only what changed, and its tiles can anti-alias a
// rounded corner differently from run to run; whole raster on one thread makes
// a frame depend only on what's on the page
const browser: Browser = await chromium.launch({
  args: ["--disable-partial-raster", "--num-raster-threads=1"],
});

async function shoot(page: Page, view: string) {
  await page.waitForTimeout(400);
  // finite transitions finish and infinite animations rest at their start, so a
  // frame doesn't depend on when it was taken
  await page.screenshot({
    path: path.join(outDir, `${view}.png`),
    fullPage: true,
    animations: "disabled",
  });
  results[view] = await page.evaluate(measure);
}

// Tab through the page from a click at its corner: programmatic focus() doesn't
// show :focus-visible on buttons, a real Tab does
async function tabAll(page: Page, key: string) {
  const out: FocusRow[] = [];
  await page.mouse.click(1, 1);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const f = await page.evaluate(focusProbe);
    if (f) out.push(f);
  }
  focusRows[key] = out;
}

async function client(view: string, mode: Mode, act?: (p: Page) => Promise<unknown>) {
  const srv = await serve(clientDist);
  const page = await browser.newPage({ viewport: CLIENT_VIEWPORT, colorScheme: "dark" });
  await page.addInitScript(installBackend, backend(mode));
  page.on("pageerror", (e) => console.error(`[${view}] pageerror`, e.message));
  await page.goto(srv.url);
  await page.waitForSelector("table", { timeout: 8000 });
  await page.evaluate(() => document.fonts.ready);
  if (act) await act(page);
  await shoot(page, `client-${view}`);
  await page.close();
  srv.close();
}

const nav = async (page: Page, name: string) => {
  await page.click("label.drawer-button");
  await page.waitForTimeout(250);
  await page.click(`.menu >> text=${name}`);
  await page.waitForTimeout(250);
};
const connect = async (page: Page) => {
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Connected Network");
};

await client("networks", "normal");
await client("connecting", "connecting", (p) => p.click("button[type=submit]"));
await client("error", "fetch-error", async (p) => {
  await p.click("button[type=submit]");
  await p.waitForSelector(".alert-error");
});
// Reset, because the form won't submit Apply with its field empty. The pointer
// stays over Reset, so the frame shows its hover state and tooltip on purpose:
// a hovered button is darker than a resting one.
await client("settings", "normal", async (p) => {
  await nav(p, "Settings");
  await p.click('button:has-text("Reset")');
  await p.waitForSelector(".alert-success");
});
// before connecting: the RPC page's alert, the info color on the page
await client("walletshield-idle", "normal", (p) => nav(p, "WalletShield"));
await client("walletshield", "normal", async (p) => {
  await connect(p);
  await nav(p, "WalletShield");
  await p.waitForSelector("table");
});
await client("console", "normal", async (p) => {
  await connect(p);
  await p.click(".collapse > input");
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
});
await client("focus", "normal", async (p) => {
  await tabAll(p, "client-networks");
  await p.focus("input.join-item");
  await p.mouse.click(1, 1);
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
});

// The downloads page, served as its real origin: the release host answers CORS
// for that origin only, and the build's CSP applies
{
  const srv = await serve(downloadsDist);
  if (!srv.csp) console.error("the downloads build has no _headers CSP");
  const pages: [string, string, { width: number; height: number }][] = [
    ["downloads", "/", { width: 1280, height: 900 }],
    ["downloads-mobile", "/", { width: 390, height: 844 }],
  ];
  for (const [view, at, viewport] of pages) {
    const page = await browser.newPage({ viewport, colorScheme: "dark" });
    page.on("console", (m) => {
      if (/Content.Security.Policy|Refused/i.test(m.text())) cspErrors.push(`${view}: ${m.text()}`);
    });
    await page.route(`${origin}/**`, async (route) => {
      const u = new URL(route.request().url());
      const r = await fetch(srv.url + u.pathname.slice(1));
      await route.fulfill({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: Buffer.from(await r.arrayBuffer()),
      });
    });
    await page.goto(origin + at, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Download", { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    await shoot(page, view);
    if (viewport.width >= 1000) await tabAll(page, view);
    await page.close();
  }
  srv.close();
}

await browser.close();

const measured: Measured = { cspErrors, focusRows, results };
fs.writeFileSync(path.join(outDir, "measure.json"), JSON.stringify(measured, null, 1));
const g = grade(measured);
const report = markdown(opt.label, g);
fs.writeFileSync(path.join(outDir, "report.md"), report);
console.log(report.split("\n").slice(0, 3).join("\n"));
for (const r of g.failures)
  console.log(`  ${r.ratio.toFixed(2)}/${r.need} ${r.kind} ${r.el} "${r.text}" [${r.view}]`);
for (const f of g.focusFailures)
  console.log(`  focus ${f.ratio ?? "none"} ${f.el} "${f.text}" [${f.view}]`);
for (const e of cspErrors) console.log(`  ${e}`);
console.log(`→ ${path.relative(root, outDir)}/`);
process.exit(g.ok ? 0 : 1);
