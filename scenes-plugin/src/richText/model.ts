// Rich text: formatting inside a text element. Stored in the element's
// `customData.rich`; the element's `originalText` stays the plain text
// (list markers included), so everything that only knows plain text — search,
// copy, other Excalidraw apps, agents — still sees the words. The formatting
// counts only while its plain text equals `originalText` (an edit by a tool
// that doesn't know it simply drops it).

/** formatting of a piece of text */
export type Marks = {
  /** bold */
  b?: true;
  /** italic */
  i?: true;
  /** underline */
  u?: true;
  /** strikethrough */
  s?: true;
  /** text color */
  c?: string;
  /** highlight (background) color */
  h?: string;
  /** link */
  a?: string;
  /** size, relative to the element's font size */
  z?: number;
};

export type Run = Marks & { t: string };

export type ParaKind = "ul" | "ol" | "todo";

export type Para = {
  /** list item kind (none: a plain paragraph) */
  k?: ParaKind;
  /** list nesting level, 0 = top */
  d?: number;
  /** a checked checklist item */
  x?: true;
  r: Run[];
};

export type RichDoc = { v: 1; p: Para[] };

export const MARK_KEYS = ["b", "i", "u", "s", "c", "h", "a", "z"] as const;
export type MarkKey = (typeof MARK_KEYS)[number];

export const MAX_DEPTH = 4;

const BULLETS = ["•", "◦", "▪"];

/** the marker each paragraph shows in front of it ("" for none) */
export const markersOf = (doc: RichDoc) => {
  // numbering per level: a plain paragraph ends all lists, a list item ends
  // the deeper levels, and a bullet or checklist item the numbering at its own
  const counters: number[] = [];
  return doc.p.map((para) => {
    const depth = para.d || 0;
    if (!para.k) {
      counters.length = 0;
      return "";
    }
    counters.length = Math.min(counters.length, depth + 1);
    if (para.k === "ol") {
      counters[depth] = (counters[depth] || 0) + 1;
      return `${counters[depth]}. `;
    }
    counters[depth] = 0;
    if (para.k === "ul") {
      return `${BULLETS[depth % BULLETS.length]} `;
    }
    if (para.k === "todo") {
      return para.x ? "☑ " : "☐ ";
    }
    return "";
  });
};

export const paraText = (para: Para) => para.r.map((run) => run.t).join("");

/** the plain text: the element's `originalText` */
export const plainOf = (doc: RichDoc) => {
  const markers = markersOf(doc);
  return doc.p.map((para, index) => markers[index] + paraText(para)).join("\n");
};

export const sameMarks = (a: Marks, b: Marks) => MARK_KEYS.every((key) => a[key] === b[key]);

export const marksOf = (run: Marks): Marks => {
  const marks: Marks = {};
  for (const key of MARK_KEYS) {
    if (run[key] !== undefined) {
      (marks as any)[key] = run[key];
    }
  }
  return marks;
};

// Scenes come from anywhere (shared links, files, agents, the clipboard), so
// formatting is checked value by value: it ends up in HTML and in links.

/** a CSS color: #hex, rgb()/rgba() with numbers, or a color name */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,30})$/i;

/** links only to the web and to mail (no javascript:, data: …) */
export const safeLink = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) {
    return null;
  }
  const link = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(link) && !/[\u0000-\u001f\s<>"]/.test(link) ? link : null;
};

const cleanMark = (key: MarkKey, value: unknown): unknown => {
  switch (key) {
    case "b":
    case "i":
    case "u":
    case "s":
      return value === true ? true : undefined;
    case "c":
    case "h":
      return typeof value === "string" && COLOR_RE.test(value.trim()) ? value.trim() : undefined;
    case "a":
      return safeLink(value) ?? undefined;
    case "z":
      return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 10 && Math.abs(value - 1) >= 0.001
        ? value
        : undefined;
  }
};

const cleanMarks = (run: Run): Run => {
  const next: Run = { t: typeof run.t === "string" ? run.t : "" };
  for (const key of MARK_KEYS) {
    const value = cleanMark(key, run[key]);
    if (value !== undefined) {
      (next as any)[key] = value;
    }
  }
  return next;
};

/** merges neighbors with the same formatting, drops empty pieces */
export const normalizeDoc = (doc: RichDoc): RichDoc => ({
  v: 1,
  p: (doc.p.length ? doc.p : [{ r: [] }]).map((para) => {
    const runs: Run[] = [];
    for (const raw of para.r) {
      const run = cleanMarks(raw);
      if (!run.t) {
        continue;
      }
      const last = runs[runs.length - 1];
      if (last && sameMarks(last, run)) {
        last.t += run.t;
      } else {
        runs.push(run);
      }
    }
    const next: Para = { r: runs };
    if (para.k === "ul" || para.k === "ol" || para.k === "todo") {
      next.k = para.k;
      const depth = Math.max(0, Math.min(MAX_DEPTH, Math.round(para.d || 0)));
      if (depth) {
        next.d = depth;
      }
      if (para.k === "todo" && para.x) {
        next.x = true;
      }
    }
    return next;
  }),
});

export const docFromPlain = (text: string): RichDoc => ({
  v: 1,
  p: text.split("\n").map((line) => ({ r: line ? [{ t: line }] : [] })),
});

/** true if the doc has no formatting at all (plain text would do) */
export const isPlainDoc = (doc: RichDoc) =>
  doc.p.every((para) => !para.k && para.r.every((run) => MARK_KEYS.every((key) => run[key] === undefined)));

const isDoc = (value: any): value is RichDoc =>
  !!value &&
  value.v === 1 &&
  Array.isArray(value.p) &&
  value.p.every(
    (para: any) =>
      para && typeof para === "object" && Array.isArray(para.r) && para.r.every((run: any) => run && typeof run.t === "string"),
  );

/** the checked, normalized version of a stored doc (stored docs are never used as they are) */
const checked = new WeakMap<object, RichDoc>();
const checkedDoc = (doc: RichDoc) => {
  let clean = checked.get(doc);
  if (!clean) {
    clean = normalizeDoc(doc);
    checked.set(doc, clean);
  }
  return clean;
};

/**
 * The formatting of a text element, if it still applies to its text
 * (`originalText`, or the one given).
 */
export const richDocOf = (
  element: { type?: string; customData?: Record<string, any> | null; originalText?: string } | null | undefined,
  originalText = element?.originalText,
): RichDoc | null => {
  const doc = element?.customData?.rich;
  if (!isDoc(doc) || typeof originalText !== "string") {
    return null;
  }
  const clean = checkedDoc(doc);
  return plainOf(clean) === originalText ? clean : null;
};

// ---------------------------------------------------------------------------
// positions: a position is (paragraph, offset into its text — markers not
// counted). The plain text offsets of `originalText` (markers counted) map
// to and from them.

export type Pos = { p: number; o: number };

export const posToPlain = (doc: RichDoc, pos: Pos, markers = markersOf(doc)) => {
  let offset = 0;
  for (let i = 0; i < pos.p; i++) {
    offset += markers[i].length + paraText(doc.p[i]).length + 1;
  }
  return offset + markers[pos.p].length + pos.o;
};

export const plainToPos = (doc: RichDoc, offset: number, markers = markersOf(doc)): Pos => {
  let rest = Math.max(0, offset);
  for (let p = 0; p < doc.p.length; p++) {
    const length = paraText(doc.p[p]).length;
    const full = markers[p].length + length;
    if (rest <= full || p === doc.p.length - 1) {
      return { p, o: Math.max(0, Math.min(length, rest - markers[p].length)) };
    }
    rest -= full + 1;
  }
  return { p: 0, o: 0 };
};

export const comparePos = (a: Pos, b: Pos) => a.p - b.p || a.o - b.o;

/** splits a paragraph's runs at an offset: [before, after] */
const splitRuns = (runs: Run[], offset: number): [Run[], Run[]] => {
  const before: Run[] = [];
  const after: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.t.length;
    if (end <= offset) {
      before.push(run);
    } else if (at >= offset) {
      after.push(run);
    } else {
      before.push({ ...run, t: run.t.slice(0, offset - at) });
      after.push({ ...run, t: run.t.slice(offset - at) });
    }
    at = end;
  }
  return [before, after];
};

const cloneDoc = (doc: RichDoc): RichDoc => ({ v: 1, p: doc.p.map((para) => ({ ...para, r: para.r.map((run) => ({ ...run })) })) });

/** the formatting at a position: of the character before it (or after, at a paragraph's start) */
export const marksAt = (doc: RichDoc, pos: Pos): Marks => {
  const runs = doc.p[pos.p]?.r || [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.t.length;
    if (pos.o > at && pos.o <= end) {
      return marksOf(run);
    }
    at = end;
  }
  return runs[0] ? marksOf(runs[0]) : {};
};

/** removes [from, to) */
export const deleteRange = (doc: RichDoc, from: Pos, to: Pos): RichDoc => {
  if (comparePos(from, to) >= 0) {
    return doc;
  }
  const next = cloneDoc(doc);
  const [before] = splitRuns(next.p[from.p].r, from.o);
  const [, after] = splitRuns(next.p[to.p].r, to.o);
  next.p.splice(from.p, to.p - from.p + 1, { ...next.p[from.p], r: [...before, ...after] });
  return normalizeDoc(next);
};

/** inserts text (newlines start new paragraphs, like the one it's in) */
export const insertText = (doc: RichDoc, at: Pos, text: string, marks: Marks): { doc: RichDoc; end: Pos } => {
  const next = cloneDoc(doc);
  const para = next.p[at.p];
  const [before, after] = splitRuns(para.r, at.o);
  const lines = text.split("\n");
  const paras: Para[] = lines.map((line, index) => ({
    ...(index ? { ...para, x: undefined } : para),
    r: [
      ...(index === 0 ? before : []),
      ...(line ? [{ ...marks, t: line }] : []),
      ...(index === lines.length - 1 ? after : []),
    ],
  }));
  next.p.splice(at.p, 1, ...paras);
  const last = lines[lines.length - 1].length;
  return {
    doc: normalizeDoc(next),
    end: { p: at.p + lines.length - 1, o: (lines.length === 1 ? at.o : 0) + last },
  };
};

/** splits the paragraph at a position (Enter) */
export const splitParagraph = (doc: RichDoc, at: Pos): { doc: RichDoc; end: Pos } => {
  const para = doc.p[at.p];
  // Enter in an empty list item: one level out, or out of the list
  if (para.k && !paraText(para)) {
    const next = cloneDoc(doc);
    next.p[at.p] = para.d ? { ...para, d: para.d - 1 } : { r: [] };
    return { doc: normalizeDoc(next), end: at };
  }
  const next = cloneDoc(doc);
  const [before, after] = splitRuns(para.r, at.o);
  const { x: _checked, ...kind } = para;
  next.p.splice(at.p, 1, { ...para, r: before }, { ...kind, r: after });
  return { doc: normalizeDoc(next), end: { p: at.p + 1, o: 0 } };
};

/** the part [from, to) of a doc, as a doc */
export const sliceDoc = (doc: RichDoc, from: Pos, to: Pos): RichDoc => {
  const paras: Para[] = [];
  for (let p = from.p; p <= to.p; p++) {
    const para = doc.p[p];
    let runs = para.r;
    if (p === to.p) {
      runs = splitRuns(runs, to.o)[0];
    }
    if (p === from.p) {
      runs = splitRuns(runs, from.o)[1];
    }
    paras.push({ ...para, r: runs.map((run) => ({ ...run })) });
  }
  return normalizeDoc({ v: 1, p: paras });
};

/**
 * Inserts a doc at a position: its first paragraph's text joins the
 * paragraph there, the others come with their own list kinds.
 */
export const insertDoc = (doc: RichDoc, at: Pos, piece: RichDoc): { doc: RichDoc; end: Pos } => {
  const next = cloneDoc(doc);
  const para = next.p[at.p];
  const [before, after] = splitRuns(para.r, at.o);
  const pieces = piece.p.map((p) => ({ ...p, r: p.r.map((run) => ({ ...run })) }));
  const last = pieces[pieces.length - 1];
  const endOffset = (pieces.length === 1 ? at.o : 0) + paraText(last).length;
  const paras: Para[] = pieces.map((p, index) => ({
    ...(index === 0 ? para : p.k || p.r.length ? p : { ...para, x: undefined }),
    r: [...(index === 0 ? before : []), ...p.r, ...(index === pieces.length - 1 ? after : [])],
  }));
  next.p.splice(at.p, 1, ...paras);
  return { doc: normalizeDoc(next), end: { p: at.p + pieces.length - 1, o: endOffset } };
};

/** applies a change to the formatting of [from, to) */
export const formatRange = (doc: RichDoc, from: Pos, to: Pos, change: (marks: Marks) => Marks): RichDoc => {
  const next = cloneDoc(doc);
  for (let p = from.p; p <= to.p; p++) {
    const para = next.p[p];
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    const runs: Run[] = [];
    let at = 0;
    for (const run of para.r) {
      const runEnd = at + run.t.length;
      const a = Math.max(start, at);
      const b = Math.min(end, runEnd);
      if (b <= a) {
        runs.push(run);
      } else {
        if (a > at) {
          runs.push({ ...run, t: run.t.slice(0, a - at) });
        }
        runs.push({ ...change(marksOf(run)), t: run.t.slice(a - at, b - at) });
        if (b < runEnd) {
          runs.push({ ...run, t: run.t.slice(b - at) });
        }
      }
      at = runEnd;
    }
    para.r = runs;
  }
  return normalizeDoc(next);
};

/** the formatting all of [from, to) shares (for the toolbar's state) */
export const commonMarks = (doc: RichDoc, from: Pos, to: Pos): Marks => {
  if (comparePos(from, to) >= 0) {
    return marksAt(doc, from);
  }
  let common: Marks | null = null;
  for (let p = from.p; p <= to.p; p++) {
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    let at = 0;
    for (const run of doc.p[p].r) {
      const runEnd = at + run.t.length;
      if (Math.min(end, runEnd) > Math.max(start, at)) {
        const marks = marksOf(run);
        if (!common) {
          common = marks;
        } else {
          for (const key of MARK_KEYS) {
            if (common[key] !== marks[key]) {
              delete common[key];
            }
          }
        }
      }
      at = runEnd;
    }
  }
  return common || {};
};

/** the values a mark takes in [from, to) (undefined: some text without it) */
export const markValues = (doc: RichDoc, from: Pos, to: Pos, key: MarkKey) => {
  const values = new Set<Marks[MarkKey]>();
  if (comparePos(from, to) >= 0) {
    values.add(marksAt(doc, from)[key]);
    return values;
  }
  for (let p = from.p; p <= to.p; p++) {
    const start = p === from.p ? from.o : 0;
    const end = p === to.p ? to.o : Infinity;
    let at = 0;
    for (const run of doc.p[p].r) {
      const runEnd = at + run.t.length;
      if (Math.min(end, runEnd) > Math.max(start, at)) {
        values.add(run[key]);
      }
      at = runEnd;
    }
  }
  return values;
};

/** the stretch around a position that has the same value of a mark (e.g. a link) */
export const markRangeAt = (doc: RichDoc, pos: Pos, key: MarkKey): { from: Pos; to: Pos } | null => {
  const runs = doc.p[pos.p]?.r || [];
  const value = marksAt(doc, pos)[key];
  if (value === undefined) {
    return null;
  }
  let at = 0;
  const spans = runs.map((run) => {
    const span = { start: at, end: at + run.t.length, same: run[key] === value };
    at = span.end;
    return span;
  });
  const index = spans.findIndex((span) => span.same && pos.o >= span.start && pos.o <= span.end);
  if (index < 0) {
    return null;
  }
  let first = index;
  let last = index;
  while (first > 0 && spans[first - 1].same) first--;
  while (last < spans.length - 1 && spans[last + 1].same) last++;
  return { from: { p: pos.p, o: spans[first].start }, to: { p: pos.p, o: spans[last].end } };
};

export const setParagraphs =(doc: RichDoc, from: number, to: number, change: (para: Para) => Para): RichDoc => {
  const next = cloneDoc(doc);
  for (let p = from; p <= to; p++) {
    next.p[p] = change(next.p[p]);
  }
  return normalizeDoc(next);
};

// ---------------------------------------------------------------------------
// markdown-ish text <-> doc, for agents (see the MCP's `richText`)

const MD_MARKS: Array<[RegExp, MarkKey]> = [
  [/^\*\*([\s\S]+?)\*\*/, "b"],
  [/^__([\s\S]+?)__/, "u"],
  [/^~~([\s\S]+?)~~/, "s"],
  [/^\*([^*\s][\s\S]*?)\*/, "i"],
];

const parseInline = (text: string, marks: Marks, runs: Run[]) => {
  let plain = "";
  const flush = () => {
    if (plain) {
      runs.push({ ...marks, t: plain });
      plain = "";
    }
  };
  let rest = text;
  while (rest) {
    if (rest[0] === "\\" && rest.length > 1 && /[*_~[\]{}\\]/.test(rest[1])) {
      plain += rest[1];
      rest = rest.slice(2);
      continue;
    }
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (link) {
      flush();
      parseInline(link[1], { ...marks, a: link[2] }, runs);
      rest = rest.slice(link[0].length);
      continue;
    }
    // {color=#e03131 highlight=#ffec99 size=0.8}text{/}
    const styled = rest.match(/^\{((?:\s*(?:color|highlight|size)=[^\s}]+)+)\s*\}([\s\S]*?)\{\/\}/);
    if (styled) {
      flush();
      const next: Marks = { ...marks };
      for (const [, key, value] of styled[1].matchAll(/(color|highlight|size)=([^\s}]+)/g)) {
        if (key === "color") {
          next.c = value;
        } else if (key === "highlight") {
          next.h = value;
        } else if (Number(value) > 0) {
          next.z = Number(value);
        }
      }
      parseInline(styled[2], next, runs);
      rest = rest.slice(styled[0].length);
      continue;
    }
    const mark = MD_MARKS.map(([re, key]) => [rest.match(re), key] as const).find(([m]) => m);
    if (mark) {
      flush();
      parseInline(mark[0]![1], { ...marks, [mark[1]]: true }, runs);
      rest = rest.slice(mark[0]![0].length);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
};

/**
 * Markdown-like text to a doc: `# ` (size 1.6, bold), `## ` (1.3, bold),
 * `- ` / `* ` bullets, `1. ` numbered, `[ ] ` / `[x] ` checklist (indent with
 * 2 spaces per level); inline **bold**, *italic*, __underline__,
 * ~~strike~~, [link](url) and {color=#hex highlight=#hex size=0.8}…{/}.
 */
export const docFromMarkdown = (markdown: string): RichDoc => {
  const paras: Para[] = markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const indent = line.match(/^ */)![0].length;
    let rest = line.slice(indent);
    const para: Para = { r: [] };
    const base: Marks = {};
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(#{1,3}) /))) {
      base.b = true;
      base.z = [1.6, 1.3, 1.1][m[1].length - 1];
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^[-*] \[( |x|X)\] /)) || (m = rest.match(/^\[( |x|X)\] /))) {
      para.k = "todo";
      if (m[1].toLowerCase() === "x") {
        para.x = true;
      }
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^[-*•] /))) {
      para.k = "ul";
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^\d+[.)] /))) {
      para.k = "ol";
      rest = rest.slice(m[0].length);
    }
    if (para.k) {
      para.d = Math.min(MAX_DEPTH, Math.floor(indent / 2));
    } else if (indent) {
      rest = line;
    }
    parseInline(rest, base, para.r);
    return para;
  });
  return normalizeDoc({ v: 1, p: paras });
};

const escapeMd = (text: string) => text.replace(/([*_~[\]{}\\])/g, "\\$1");

/** a doc as the markdown-like text docFromMarkdown reads */
export const markdownOf = (doc: RichDoc) =>
  doc.p
    .map((para) => {
      const indent = para.k ? "  ".repeat(para.d || 0) : "";
      const prefix =
        para.k === "ul" ? "- " : para.k === "ol" ? "1. " : para.k === "todo" ? (para.x ? "[x] " : "[ ] ") : "";
      const body = para.r
        .map((run) => {
          let text = escapeMd(run.t);
          const style = [
            run.c && `color=${run.c}`,
            run.h && `highlight=${run.h}`,
            run.z && `size=${Math.round(run.z * 100) / 100}`,
          ].filter(Boolean);
          if (style.length) {
            text = `{${style.join(" ")}}${text}{/}`;
          }
          if (run.s) text = `~~${text}~~`;
          if (run.u) text = `__${text}__`;
          if (run.i) text = `*${text}*`;
          if (run.b) text = `**${text}**`;
          if (run.a) text = `[${text}](${run.a})`;
          return text;
        })
        .join("");
      return indent + prefix + body;
    })
    .join("\n");
