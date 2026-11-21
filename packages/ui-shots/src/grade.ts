// Grading the measurements against WCAG 2.2: text 4.5:1, or 3:1 when large
// (SC 1.4.3); non-text parts and graphics 3:1 (SC 1.4.11); a focus indicator
// 3:1 (SC 1.4.11 applied to SC 2.4.7). Disabled controls are exempt.
import type { FocusRow, Row } from "./measure.ts";

export type Kind = Row["kind"] | "fill(info)";

export type Graded = Omit<Row, "kind"> & {
  kind: Kind;
  view: string;
  need: number; // 0: reported, not graded
  pass: boolean;
  allowed?: string; // why a failing row is accepted
};

export type Allow = { view: RegExp; kind: Kind; el: RegExp; why: string };

// Failures the walker reports that a person doesn't see
export const ALLOW: Allow[] = [
  {
    view: /^client-walletshield/,
    kind: "non-text",
    el: /input\.tab$/,
    why: "the WalletShield tab is a radio input whose label and underline are ::after/::before, which the walker can't see",
  },
];

// The element itself, without its ancestors
export const leaf = (el: string) => el.split(" > ").at(-1) ?? el;

// A button, badge or alert is identified by its label, so its fill isn't graded (SC 1.4.11)
const LABELLED = ["span.badge", "div.alert", ".btn"];

export function gradeRow(view: string, r: Row, allow: Allow[] = ALLOW): Graded {
  let kind: Kind = r.kind;
  let need: number;
  if (r.kind === "non-text" && LABELLED.some((c) => leaf(r.el).includes(c))) {
    kind = "fill(info)";
    need = 0;
  } else if (r.kind === "non-text" || r.kind === "icon" || r.kind === "status-dot") need = 3;
  else need = r.large ? 3 : 4.5;
  const g: Graded = { ...r, kind, view, need, pass: r.ratio >= need };
  if (!g.pass) {
    const a = allow.find((a) => a.kind === kind && a.view.test(view) && a.el.test(r.el));
    if (a) g.allowed = a.why;
  }
  return g;
}

export type FocusGraded = FocusRow & { view: string; pass: boolean };

export const gradeFocus = (view: string, f: FocusRow): FocusGraded => ({
  ...f,
  view,
  pass: f.ratio !== null && f.ratio >= 3,
});

export type Measured = {
  cspErrors: string[];
  focusRows: Record<string, FocusRow[]>;
  results: Record<string, Row[]>;
};

export type Grade = {
  rows: Graded[];
  failures: Graded[]; // below threshold, not disabled, not allowed
  allowed: Graded[];
  focus: FocusGraded[]; // one per distinct indicator
  focusFailures: FocusGraded[];
  cspErrors: string[];
  ok: boolean;
};

const surface = (view: string) => (view.startsWith("client") ? "client" : "downloads");

// Rows with the same surface, kind, element and colors are one finding, seen in several views
const dedupe = <T extends { view: string }>(rows: T[], key: (r: T) => string) => {
  const by = new Map<string, T & { views: string[] }>();
  for (const r of rows) {
    const k = key(r);
    const seen = by.get(k);
    if (seen) {
      if (!seen.views.includes(r.view)) seen.views.push(r.view);
    } else by.set(k, { ...r, views: [r.view] });
  }
  return [...by.values()];
};

export function grade(m: Measured, allow: Allow[] = ALLOW): Grade {
  const rows = Object.entries(m.results).flatMap(([view, rs]) =>
    rs.map((r) => gradeRow(view, r, allow)),
  );
  const failing = rows.filter((r) => !r.pass && !r.disabled);
  const key = (r: Graded) =>
    [surface(r.view), r.kind, leaf(r.el), r.fg ?? r.fill, r.bg ?? r.around].join("|");
  const failures = dedupe(
    failing.filter((r) => !r.allowed),
    key,
  );
  const allowed = dedupe(
    failing.filter((r) => r.allowed),
    key,
  );
  const focus = dedupe(
    Object.entries(m.focusRows).flatMap(([view, fs]) => fs.map((f) => gradeFocus(view, f))),
    (f) => [surface(f.view), f.el, f.outline, f.boxShadow.slice(0, 20)].join("|"),
  );
  const focusFailures = focus.filter((f) => !f.pass);
  return {
    rows,
    failures,
    allowed,
    focus,
    focusFailures,
    cspErrors: m.cspErrors,
    ok: failures.length === 0 && focusFailures.length === 0 && m.cspErrors.length === 0,
  };
}

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|");
const views = (r: { views?: string[]; view: string }) =>
  (r.views ?? [r.view]).map((v) => v.replace(/^client-/, "")).join(", ");

// The report: what fails, what is accepted and why, and the lowest passing rows
export function markdown(label: string, g: Grade, lowest = 12): string {
  const out: string[] = [`# ui-shots: ${label}`, ""];
  out.push(
    `${g.ok ? "PASS" : "FAIL"}: ${g.failures.length} below threshold, ${g.focusFailures.length} focus indicators below 3:1, ${g.cspErrors.length} CSP errors; ${g.allowed.length} accepted.`,
    "",
  );
  const table = (
    title: string,
    rs: (Graded & { views?: string[] })[],
    extra?: (r: Graded) => string,
  ) => {
    out.push(`## ${title}`, "");
    if (rs.length === 0) {
      out.push("None.", "");
      return;
    }
    out.push(
      `| ratio | needs | kind | element | text | colors | views${extra ? " | why" : ""} |`,
      `|---:|---:|---|---|---|---|---|${extra ? "---|" : ""}`,
    );
    for (const r of rs)
      out.push(
        `| ${r.ratio.toFixed(2)} | ${r.need} | ${r.kind} | \`${cell(leaf(r.el).slice(0, 60))}\` | ${cell(r.text.slice(0, 30))} | ${r.fg ?? r.fill} on ${r.bg ?? r.around} | ${views(r)} |${extra ? ` ${cell(extra(r))} |` : ""}`,
      );
    out.push("");
  };
  table("Below threshold", g.failures);
  table("Accepted", g.allowed, (r) => r.allowed ?? "");
  const passing = g.rows
    .filter((r) => r.pass && r.need > 0)
    .sort((a, b) => a.ratio / a.need - b.ratio / b.need);
  table(
    `Lowest passing (${lowest})`,
    dedupe(passing, (r) =>
      [surface(r.view), r.kind, leaf(r.el), r.fg ?? r.fill, r.bg ?? r.around].join("|"),
    ).slice(0, lowest),
  );
  out.push(
    "## Focus indicators",
    "",
    "| ratio | outline | on | element | text | views |",
    "|---:|---|---|---|---|---|",
  );
  for (const f of g.focus)
    out.push(
      `| ${f.ratio ?? "none"} | ${cell(f.outline)} | ${f.around} | \`${cell(f.el.slice(0, 50))}\` | ${cell(f.text.slice(0, 20))} | ${views(f)} |`,
    );
  out.push("");
  if (g.cspErrors.length) out.push("## CSP errors", "", ...g.cspErrors.map((e) => `- ${e}`), "");
  return out.join("\n");
}
