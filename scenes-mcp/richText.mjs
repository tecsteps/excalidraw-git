// Formatted text (customData.rich, see scenes-plugin/src/richText/model.ts)
// shown to agents in the markdown-like form they write it in (`markdown`).

const BULLETS = ["•", "◦", "▪"];

const markersOf = (doc) => {
  const counters = [];
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
    return para.x ? "☑ " : "☐ ";
  });
};

const plainOf = (doc) => {
  const markers = markersOf(doc);
  return doc.p.map((para, index) => markers[index] + para.r.map((run) => run.t).join("")).join("\n");
};

const escapeMd = (text) => text.replace(/([*_~[\]{}\\])/g, "\\$1");

/** the formatting of a text element as markdown-like text (null: none, or no longer matching its text) */
export const markdownOfElement = (el) => {
  const doc = el?.type === "text" ? el.customData?.rich : null;
  if (!doc || doc.v !== 1 || !Array.isArray(doc.p) || plainOf(doc) !== (el.originalText ?? el.text)) {
    return null;
  }
  return doc.p
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
          if (style.length) text = `{${style.join(" ")}}${text}{/}`;
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
};
