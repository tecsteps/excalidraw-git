// PDF export of slides: every slide becomes an SVG page (text stays text,
// fonts are embedded once for the whole deck, pictures once per file) and
// the scenes server prints the page with headless Chrome. Without the
// server, the browser's print dialog does the same ("Save as PDF").

import { Fonts, exportToSvg, getNonDeletedElements } from "@excalidraw/excalidraw";

import { BASE_URL, IS_ONLINE } from "./api";
import { withTemplate } from "./cowork";
import { getSlides, slideData } from "./slides";

import type { Frame } from "./slides";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

/** 16:9 like presentation software: 13.333 × 7.5 in */
const PAGE_WIDTH_IN = 13.333;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Which slides: "all" (skipped ones left out), or numbers (1-based, deck
 * order), frame ids and ranges like "2-4" — given as a list or "1, 3-5".
 */
export const pickSlides = (
  elements: readonly ExcalidrawElement[],
  spec: "all" | string | Array<number | string> = "all",
  { includeSkipped = false }: { includeSkipped?: boolean } = {},
): Frame[] => {
  const slides = getSlides(elements);
  if (spec === "all" || (typeof spec === "string" && !spec.trim())) {
    return slides.filter((slide) => includeSkipped || !slideData(slide).skip);
  }
  const parts = typeof spec === "string" ? spec.split(",") : spec;
  const picked: Frame[] = [];
  for (const raw of parts) {
    const part = typeof raw === "number" ? raw : raw.trim();
    const range = typeof part === "string" && part.match(/^(\d+)\s*-\s*(\d+)$/);
    const found = range
      ? slides.slice(Number(range[1]) - 1, Number(range[2]))
      : typeof part === "number" || /^\d+$/.test(part)
      ? [slides[Number(part) - 1]]
      : [slides.find((slide) => slide.id === part)];
    if (!found.length || found.some((slide) => !slide)) {
      throw new Error(`No slide "${part}": the deck has ${slides.length} slides`);
    }
    for (const slide of found as Frame[]) {
      if (!picked.includes(slide)) {
        picked.push(slide);
      }
    }
  }
  return picked;
};

/** one self-contained HTML page with a page per slide, ready to print */
export const slidesHtml = async (
  input: readonly ExcalidrawElement[],
  files: BinaryFiles,
  frames: readonly Frame[],
  { deck, background = "#ffffff" }: { deck: string; background?: string },
) => {
  if (!frames.length) {
    throw new Error("No slides to export");
  }
  const elements = getNonDeletedElements(withTemplate([...input], deck));
  const byId = new Map(elements.map((el) => [el.id, el]));
  const onSlides = (frame: Frame) =>
    elements.filter((el) => el.id === frame.id || el.frameId === frame.id);
  const used = frames.flatMap((frame) => onSlides(frame));

  // fonts: one subset per font for the whole deck
  const fontFaces = await Fonts.generateFontFaceDeclarations(used);
  const seenSymbols = new Set<string>();
  const pages: string[] = [];
  for (const original of frames) {
    const frame = (byId.get(original.id) as Frame) ?? original;
    const svg = await exportToSvg({
      elements: onSlides(frame),
      files,
      appState: { exportBackground: true, viewBackgroundColor: background, exportWithDarkMode: false },
      exportPadding: 0,
      exportingFrame: frame,
      skipInliningFonts: true,
    });
    // a picture used on many slides (e.g. the template's logo) is embedded once
    svg.querySelectorAll("symbol[id]").forEach((symbol) => {
      if (seenSymbols.has(symbol.id)) {
        symbol.remove();
      } else {
        seenSymbols.add(symbol.id);
      }
    });
    svg.querySelectorAll("style.style-fonts").forEach((style) => style.remove());
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    pages.push(svg.outerHTML);
  }

  const first = frames[0];
  const pageHeight = (PAGE_WIDTH_IN * first.height) / first.width;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(deck)}</title>
<style>
${fontFaces.join("\n")}
@page { size: ${PAGE_WIDTH_IN}in ${pageHeight.toFixed(3)}in; margin: 0; }
html, body { margin: 0; padding: 0; background: ${escapeHtml(background)}; }
.page { width: ${PAGE_WIDTH_IN}in; height: ${pageHeight.toFixed(3)}in; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.page > svg { display: block; width: 100%; height: 100%; }
</style></head>
<body>
${pages.map((page) => `<div class="page">${page}</div>`).join("\n")}
</body></html>`;
};

/** print the page to a PDF (scenes server + headless Chrome) */
export const printToPdf = async (html: string) => {
  if (IS_ONLINE) {
    // Kurviq has no print server: the browser's dialog does it
    throw new Error("PDF printing needs the local scenes server");
  }
  const res = await fetch(`${BASE_URL}/api/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) {
    let message = `PDF export failed (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return res.blob();
};

/** without the server: the browser's own print dialog (Save as PDF) */
export const printInBrowser = (html: string) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const print = () => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  doc.fonts.ready.then(() => setTimeout(print, 300));
};
