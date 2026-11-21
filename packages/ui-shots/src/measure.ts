// In-page measurements: Playwright serializes these functions into the page, so
// each one is self-contained. Colors are read through a canvas, which resolves
// oklab()/color-mix() exactly as painted; getComputedStyle would return them
// unresolved.

export type Row = {
  kind: "text" | "placeholder" | "non-text" | "icon" | "status-dot";
  el: string; // the element and up to two ancestors, tag.class
  text: string;
  ratio: number;
  fg?: string; // text and placeholders: the color, composited over the backdrop
  bg?: string;
  fill?: string; // non-text, icons and dots: the part that identifies it
  around?: string; // what it sits on
  border?: string | null;
  outline?: string | null;
  px?: number;
  bold?: boolean;
  large?: boolean;
  disabled?: boolean;
};

export type FocusRow = {
  el: string;
  text: string;
  outline: string;
  boxShadow: string;
  around: string;
  ratio: number | null;
};

// Every visible text run, placeholder, component edge, icon and status dot, with
// its contrast against what it is painted on
export function measure(): Row[] {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  type RGB = number[];
  const rgba = (c: string): RGB => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top: RGB, a: number, base: RGB) => top.map((v, i) => v * a + base[i] * (1 - a));
  const chain = (el: Element) => {
    const out: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) out.unshift(n);
    return out;
  };
  const opac = (n: Element) => parseFloat(getComputedStyle(n).opacity);
  // the backgrounds composited from the root down to el (inclusive), opacity multiplied down
  const backdrop = (el: Element, inclusive = true) => {
    const ch = chain(el);
    if (!inclusive) ch.pop();
    let c: RGB = [255, 255, 255];
    const ops = ch.map(opac);
    ch.forEach((n, i) => {
      const [r, g, b, a] = rgba(getComputedStyle(n).backgroundColor);
      const groupA = ops.slice(0, i + 1).reduce((x, y) => x * y, 1);
      if (a > 0) c = over([r, g, b], a * groupA, c);
    });
    return c;
  };
  const groupOpacity = (el: Element) =>
    chain(el)
      .map(opac)
      .reduce((x, y) => x * y, 1);
  const lum = ([r, g, b]: RGB) => {
    const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: RGB, b: RGB) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = (c: RGB) =>
    "#" +
    c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("");
  const collapsed = (el: Element) =>
    el.closest(".collapse:not(:has(> input:checked)) > .collapse-content") !== null;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      el.closest("[aria-hidden=true]") === null &&
      !collapsed(el)
    );
  };
  // icons and dots are aria-hidden, which is exactly why they need their own pass
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !collapsed(el)
    );
  };
  const desc = (el: Element) => {
    const parts: string[] = [];
    for (let n: Element | null = el, i = 0; n && i < 3; n = n.parentElement, i++) {
      const cls = [...n.classList].join(".");
      parts.unshift(n.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
    return parts.join(" > ");
  };
  const rows: Row[] = [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let t: Node | null; (t = walker.nextNode());) {
    const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent?.trim() || !visible(el)) continue;
    if (["SCRIPT", "STYLE", "OPTION"].includes(el.tagName)) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const [r, g, b, a] = rgba(s.color);
    const bg = backdrop(el);
    const fg = over([r, g, b], a * groupOpacity(el), bg);
    const px = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight) >= 700;
    rows.push({
      kind: "text",
      el: desc(el),
      text: t.textContent.trim().slice(0, 48),
      fg: hex(fg),
      bg: hex(bg),
      ratio: +ratio(fg, bg).toFixed(2),
      px,
      bold,
      large: px >= 24 || (bold && px >= 18.66),
      disabled: !!el.closest(":disabled, .btn-disabled, [aria-disabled=true]"),
    });
  }

  for (const el of document.querySelectorAll<HTMLInputElement>("input[placeholder]")) {
    if (!visible(el) || el.value) continue;
    const [r, g, b, a] = rgba(getComputedStyle(el, "::placeholder").color);
    const bg = backdrop(el);
    const fg = over([r, g, b], a * groupOpacity(el), bg);
    rows.push({
      kind: "placeholder",
      el: desc(el),
      text: el.placeholder,
      fg: hex(fg),
      bg: hex(bg),
      ratio: +ratio(fg, bg).toFixed(2),
      px: parseFloat(getComputedStyle(el).fontSize),
      large: false,
    });
  }

  // non-text: the best of fill, border and outline against what's around it
  const NT =
    ".badge, .btn, .status, .input, .checkbox, .alert, .progress, tr[aria-selected=true], .tab, .toggle";
  for (const el of document.querySelectorAll(NT)) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const around = backdrop(el, false);
    const go = groupOpacity(el);
    const [r, g, b, a] = rgba(s.backgroundColor);
    const fill = a > 0 ? over([r, g, b], a * go, around) : around;
    const bw = parseFloat(s.borderTopWidth);
    const [br, bgc, bb, ba] = rgba(s.borderTopColor);
    const border = bw > 0 && ba > 0 ? over([br, bgc, bb], ba * go, around) : null;
    const ow = parseFloat(s.outlineWidth);
    const [or, og, ob, oa] = rgba(s.outlineColor);
    const outline =
      s.outlineStyle !== "none" && ow > 0 && oa > 0 ? over([or, og, ob], oa * go, around) : null;
    const best = Math.max(
      ratio(fill, around),
      border ? ratio(border, around) : 1,
      outline ? ratio(outline, around) : 1,
    );
    rows.push({
      kind: "non-text",
      el: desc(el),
      text: (el.textContent || "").trim().slice(0, 32),
      around: hex(around),
      fill: hex(fill),
      border: border && hex(border),
      outline: outline && hex(outline),
      ratio: +best.toFixed(2),
      disabled: !!el.closest(":disabled"),
    });
  }

  // graphics that carry meaning: icons (currentColor) and status dots
  for (const el of document.querySelectorAll("svg, .status")) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    const around = backdrop(el, false);
    const go = groupOpacity(el);
    const dot = el.matches(".status");
    let paint = dot ? s.backgroundColor : s.stroke !== "none" && s.stroke ? s.stroke : s.fill;
    if (!paint || paint === "none") paint = s.color;
    const [r, g, b, a] = rgba(paint);
    if (a === 0) continue;
    const fg = over([r, g, b], a * go, around);
    rows.push({
      kind: dot ? "status-dot" : "icon",
      el: desc(el),
      text: (
        el.closest("[aria-label],[title]")?.getAttribute("aria-label") ||
        el.parentElement?.textContent ||
        ""
      )
        .trim()
        .slice(0, 32),
      fill: hex(fg),
      around: hex(around),
      ratio: +ratio(fg, around).toFixed(2),
    });
  }
  return rows;
}

// The focus indicator of the active element, as the browser paints it
export function focusProbe(): FocusRow | null {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  const rgba = (c: string) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = (c: number[]) =>
    "#" +
    c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("");
  let around = [255, 255, 255];
  for (let n = el.parentElement; n; n = n.parentElement) {
    const [r, g, b, a] = rgba(getComputedStyle(n).backgroundColor);
    if (a >= 1) {
      around = [r, g, b];
      break;
    }
  }
  const s = getComputedStyle(el);
  const ow = parseFloat(s.outlineWidth);
  const oc = rgba(s.outlineColor);
  const hasOutline = s.outlineStyle !== "none" && ow > 0 && oc[3] > 0;
  return {
    el: el.tagName.toLowerCase() + "." + [...el.classList].join("."),
    text: (el.textContent || el.getAttribute("aria-label") || (el as HTMLInputElement).value || "")
      .trim()
      .slice(0, 30),
    outline: hasOutline ? `${ow}px ${s.outlineStyle} ${hex(oc)}` : "none",
    boxShadow: s.boxShadow === "none" ? "none" : s.boxShadow.slice(0, 60),
    around: hex(around),
    ratio: hasOutline ? +ratio(oc, around).toFixed(2) : null,
  };
}
