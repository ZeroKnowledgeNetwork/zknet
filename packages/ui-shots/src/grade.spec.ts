import { describe, expect, it } from "vitest";
import { grade, gradeRow, markdown, type Measured } from "./grade.ts";
import type { Row } from "./measure.ts";

const text = (ratio: number, more: Partial<Row> = {}): Row => ({
  kind: "text",
  el: "div.card > p.opacity-80",
  text: "Some words",
  ratio,
  fg: "#aaaaaa",
  bg: "#050b01",
  px: 16,
  large: false,
  ...more,
});

describe("gradeRow", () => {
  it("needs 4.5 of text and 3 of large text", () => {
    expect(gradeRow("downloads", text(4.49)).pass).toBe(false);
    expect(gradeRow("downloads", text(4.5)).pass).toBe(true);
    expect(gradeRow("downloads", text(3, { large: true })).pass).toBe(true);
  });

  it("needs 3 of non-text parts, icons and status dots", () => {
    for (const kind of ["non-text", "icon", "status-dot"] as const) {
      const r = gradeRow("client-networks", { kind, el: "span.status", text: "", ratio: 2.99 });
      expect([r.need, r.pass]).toEqual([3, false]);
    }
  });

  it("reports a labelled component's fill without grading it", () => {
    const r = gradeRow("downloads", {
      kind: "non-text",
      el: "div > a.btn.btn-primary",
      text: "Download",
      ratio: 1.1,
    });
    expect([r.kind, r.need, r.pass]).toEqual(["fill(info)", 0, true]);
  });

  it("accepts the WalletShield radio tab, and only there", () => {
    const tab: Row = { kind: "non-text", el: "div.tabs > input.tab", text: "", ratio: 1 };
    expect(gradeRow("client-walletshield", tab).allowed).toMatch(/radio input/);
    expect(gradeRow("client-settings", tab).allowed).toBeUndefined();
  });
});

describe("grade", () => {
  const measured = (rows: Record<string, Row[]>, more: Partial<Measured> = {}): Measured => ({
    cspErrors: [],
    focusRows: {},
    results: rows,
    ...more,
  });

  it("fails on a row below threshold, once however many views show it", () => {
    const g = grade(measured({ "client-networks": [text(3)], "client-error": [text(3)] }));
    expect(g.ok).toBe(false);
    expect(g.failures).toHaveLength(1);
    expect(g.failures[0]).toMatchObject({ views: ["client-networks", "client-error"] });
  });

  it("exempts disabled controls", () => {
    expect(grade(measured({ downloads: [text(2, { disabled: true })] })).ok).toBe(true);
  });

  it("passes with only accepted failures", () => {
    const tab: Row = { kind: "non-text", el: "div.tabs > input.tab", text: "", ratio: 1 };
    const g = grade(measured({ "client-walletshield": [tab] }));
    expect([g.ok, g.allowed.length]).toEqual([true, 1]);
  });

  it("fails on a focus indicator below 3, or none, and on any CSP error", () => {
    const focus = (ratio: number | null) => ({
      el: "button.btn",
      text: "Connect",
      outline: ratio ? "2px solid #28d628" : "none",
      boxShadow: "none",
      around: "#050b01",
      ratio,
    });
    expect(grade(measured({}, { focusRows: { downloads: [focus(9.8)] } })).ok).toBe(true);
    expect(grade(measured({}, { focusRows: { downloads: [focus(2.5)] } })).ok).toBe(false);
    expect(grade(measured({}, { focusRows: { downloads: [focus(null)] } })).ok).toBe(false);
    expect(grade(measured({}, { cspErrors: ["downloads: Refused to load"] })).ok).toBe(false);
  });
});

describe("markdown", () => {
  it("states the verdict first and escapes table cells", () => {
    const g = grade({
      cspErrors: [],
      focusRows: {},
      results: { downloads: [text(3, { text: "a | b" })] },
    });
    const md = markdown("t", g);
    expect(md.split("\n")[2]).toMatch(/^FAIL: 1 below threshold/);
    expect(md).toContain("a \\| b");
  });
});
