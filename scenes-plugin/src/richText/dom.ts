// Reading formatted text back from HTML: the editor's own DOM (after the
// browser typed into it), and HTML pasted from elsewhere (web pages, docs).

import { MAX_DEPTH, normalizeDoc } from "./model";

import type { Marks, Para, ParaKind, RichDoc } from "./model";

const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "P", "PRE", "SECTION", "TD", "TH", "TR",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "NOSCRIPT", "SVG", "IMG", "INPUT"]);
const HEADING_SIZES: Record<string, number> = { H1: 1.6, H2: 1.3, H3: 1.1 };

type Block = { k?: ParaKind; d?: number; x?: true };

const marksFrom = (el: HTMLElement, marks: Marks, external: boolean): Marks => {
  const tag = el.tagName;
  const data = el.dataset || {};
  const hasData = ["b", "i", "u", "s", "c", "h", "a", "z"].some((key) => key in data);
  // a span of the editor's own without formatting: plain text (whatever an
  // outer span the browser wrapped around it says)
  const next: Marks = !external && tag === "SPAN" && !hasData && el.parentElement?.classList.contains("rt-p") ? {} : { ...marks };
  if (tag === "B" || tag === "STRONG") next.b = true;
  if (tag === "I" || tag === "EM") next.i = true;
  if (tag === "U" || tag === "INS") next.u = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.s = true;
  if (tag === "A" && el.getAttribute("href") && external) next.a = el.getAttribute("href")!;
  if (external && HEADING_SIZES[tag]) {
    next.b = true;
    next.z = HEADING_SIZES[tag];
  }
  const style = el.style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) next.b = true;
    else if (weight === "normal" || (Number(weight) > 0 && Number(weight) < 600)) delete next.b;
    if (style.fontStyle === "italic" || style.fontStyle === "oblique") next.i = true;
    else if (style.fontStyle === "normal") delete next.i;
    const decoration = `${style.textDecorationLine || ""} ${style.textDecoration || ""}`;
    if (/underline/.test(decoration) && external) next.u = true;
    if (/line-through/.test(decoration) && external) next.s = true;
  }
  // the editor's own spans say exactly what they are
  if (hasData) {
    for (const key of ["b", "i", "u", "s"] as const) {
      if (key in data) next[key] = true;
      else delete next[key];
    }
    for (const key of ["c", "h", "a"] as const) {
      if (data[key]) next[key] = data[key];
      else delete next[key];
    }
    if (Number(data.z) > 0) next.z = Number(data.z);
    else delete next.z;
  }
  return next;
};

const blockFrom = (el: HTMLElement, external: boolean): Block => {
  if (!external) {
    const data = el.dataset;
    const k = data.k === "ul" || data.k === "ol" || data.k === "todo" ? data.k : undefined;
    return k ? { k, d: Number(data.d) || 0, ...(data.x ? { x: true as const } : {}) } : {};
  }
  if (el.tagName !== "LI") {
    return {};
  }
  let depth = -1;
  let kind: ParaKind = "ul";
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "UL" || parent.tagName === "OL") {
      if (depth < 0) kind = parent.tagName === "OL" ? "ol" : "ul";
      depth++;
    }
  }
  const checkbox = el.querySelector("input[type=checkbox]") as HTMLInputElement | null;
  if (checkbox) {
    return { k: "todo", d: Math.max(0, Math.min(MAX_DEPTH, depth)), ...(checkbox.checked ? { x: true as const } : {}) };
  }
  return { k: kind, d: Math.max(0, Math.min(MAX_DEPTH, depth)) };
};

/**
 * Formatted text from a DOM: the editor's (`external: false`), or pasted
 * HTML (`external: true`, whitespace collapses as on a web page).
 */
export const parseDom = (root: Node, { external }: { external: boolean }): RichDoc => {
  const paras: Para[] = [];
  let current: Para | null = null;
  let block: Block = {};
  const open = () => (current ??= { ...block, r: [] });
  const close = () => {
    if (current) {
      paras.push(current);
    }
    current = null;
  };

  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === 3) {
      let text = (node as Text).data.replace(/ /g, " ").replace(/​/g, "");
      if (external) {
        text = text.replace(/[\t\n\r ]+/g, " ");
        if (!current?.r.length) {
          text = text.replace(/^ /, "");
        }
        if (!text) {
          return;
        }
      }
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (index) {
          close();
        }
        const para = open();
        if (line) {
          para.r.push({ ...marks, t: line });
        }
      });
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as HTMLElement;
    if (SKIP.has(el.tagName.toUpperCase())) {
      return;
    }
    if (el.tagName === "BR") {
      if (external) {
        open();
        close();
      }
      return;
    }
    const nextMarks = marksFrom(el, marks, external);
    const isBlock = external ? BLOCKS.has(el.tagName) : el.classList?.contains("rt-p") || (el.tagName === "DIV" && el !== root);
    if (!isBlock) {
      el.childNodes.forEach((child) => walk(child, nextMarks));
      return;
    }
    const outer = block;
    close();
    const own = blockFrom(el, external);
    block = el.tagName === "LI" || !external ? own : { ...outer, ...own };
    // the editor's paragraphs exist even when empty; pasted blocks only
    // with something in them (a <p> in an <li> is one paragraph, not two)
    if (!external) {
      open();
    }
    el.childNodes.forEach((child) => walk(child, nextMarks));
    close();
    block = outer;
  };

  root.childNodes.forEach((child) => walk(child, {}));
  close();

  if (external) {
    // trailing spaces of lines, and empty lines around the text
    for (const para of paras) {
      const last = para.r[para.r.length - 1];
      if (last) {
        last.t = last.t.replace(/ +$/, "");
      }
    }
    while (paras.length > 1 && !paras[0].r.some((run) => run.t)) paras.shift();
    while (paras.length > 1 && !paras[paras.length - 1].r.some((run) => run.t)) paras.pop();
  }
  return normalizeDoc({ v: 1, p: paras.length ? paras : [{ r: [] }] });
};
