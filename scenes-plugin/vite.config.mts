// Wraps the upstream excalidraw-app Vite config and injects the scenes plugin
// at build time — the excalidraw checkout itself stays untouched.
//
// Must be run with cwd = excalidraw/excalidraw-app (upstream config resolves
// its env dir relative to cwd), e.g.:
//   cd excalidraw/excalidraw-app && npx vite --config ../../scenes-plugin/vite.config.mts

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VitePWA } from "vite-plugin-pwa";

import upstreamConfig from "../excalidraw/excalidraw-app/vite.config.mts";

import { thirdPartyNotices } from "../online/licenses.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
const EXCALIDRAW_ROOT = path.resolve(WORKSPACE, "excalidraw");
const PLUGIN_ENTRY = path.resolve(HERE, "src/index.tsx");
const ONLINE_DIR = path.resolve(WORKSPACE, "online");

const readEnv = () => {
  const env: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    const full = path.join(WORKSPACE, file);
    if (!existsSync(full)) {
      continue;
    }
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (match) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
  return { ...env, ...process.env } as Record<string, string>;
};

/**
 * Hooks the scenes UI into excalidraw-app/App.tsx using public <Excalidraw/>
 * extension points only:
 *  - `renderTopLeftUI` prop  -> <ScenesTopLeftUI/>
 *  - child <Sidebar/>         -> <ScenesSidebar/>
 * Fails loudly if upstream changes so the anchors no longer match.
 */
const injectScenesPlugin = () => ({
  name: "excalidraw-scenes-inject",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.replace(/\\/g, "/").endsWith("/excalidraw-app/App.tsx")) {
      return null;
    }
    const fail = (what: string) => {
      throw new Error(
        `[excalidraw-scenes] could not inject into App.tsx: ${what}. ` +
          `Upstream probably changed — update scenes-plugin/vite.config.mts.`,
      );
    };
    if (/\brenderTopLeftUI=/.test(code)) {
      fail("App.tsx already uses renderTopLeftUI");
    }
    const topRight = /(\n\s*)renderTopRightUI=\{/;
    if (!topRight.test(code)) {
      fail("anchor `renderTopRightUI={` not found");
    }
    const sidebar = /<AppSidebar\s*\/>/;
    if (!sidebar.test(code)) {
      fail("anchor `<AppSidebar />` not found");
    }
    // upstream copies the canvas another tab saved last into this tab when
    // it gets focus — with scenes, that is another scene's drawing (which
    // auto-sync would then push under this tab's scene name). Each tab keeps
    // its own scene; changes reach other tabs through the sync.
    const tabSync = "if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {";
    if (!code.includes(tabSync)) {
      fail("anchor for the cross-tab canvas sync not found");
    }
    return {
      code:
        `import { ScenesTopLeftUI, ScenesSidebar } from ${JSON.stringify(
          PLUGIN_ENTRY,
        )};\n` +
        code
          .replace(
            topRight,
            "$1renderTopLeftUI={(isMobile) => <ScenesTopLeftUI isMobile={isMobile} />}$1renderTopRightUI={",
          )
          .replace(sidebar, (match) => `${match}\n<ScenesSidebar />`)
          .replace(tabSync, "if (false /* excalidraw-scenes: tabs keep their own scene */) {"),
      map: null,
    };
  },
});

const TEXT_PADDING_ENTRY = path.resolve(HERE, "src/textPadding.tsx");

/**
 * Text padding per shape (`customData.textPadding`, default 5px): Excalidraw
 * lays out a shape's text with a fixed BOUND_TEXT_PADDING. These patches make
 * the layout (wrap width, position, auto-grow, the text editor) read the
 * shape's own value, and add a slider below Opacity in the properties panel.
 */
const textPadding = () => ({
  name: "excalidraw-scenes-text-padding",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const file = id.replace(/\\/g, "/").split("?")[0];
    const patch = (name: string, steps: Array<[string | RegExp, string, number?]>) => {
      let next = code;
      for (const [from, to, count = 1] of steps) {
        const found =
          typeof from === "string" ? next.split(from).length - 1 : (next.match(new RegExp(from.source, "g")) || []).length;
        if (found !== count) {
          throw new Error(
            `[excalidraw-scenes] text padding: ${name} changed upstream (expected ${count}× ${String(from).slice(0, 60)}, found ${found}). Update scenes-plugin/vite.config.mts.`,
          );
        }
        next = typeof from === "string" ? next.split(from).join(to) : next.replace(new RegExp(from.source, "g"), to);
      }
      return { code: next, map: null };
    };
    const resize = /computeContainerDimensionForBoundText\(\s*([\w.]+),\s*container\.type,\s*\)/;
    if (file.endsWith("/packages/element/src/textElement.ts")) {
      const firstExport = code.indexOf("\nexport const ");
      code =
        code.slice(0, firstExport) +
        "\nconst __textPadding = (container: any): number =>\n  typeof container?.customData?.textPadding === \"number\" ? container.customData.textPadding : BOUND_TEXT_PADDING;\n" +
        code.slice(firstExport);
      // the max text width / height of a shape, and its text position
      const maxWidth = code.slice(code.indexOf("export const getBoundTextMaxWidth"), code.indexOf("export const getBoundTextMaxHeight"));
      const maxHeightStart = code.indexOf("export const getBoundTextMaxHeight");
      const maxHeightEnd = code.indexOf("\n};", maxHeightStart);
      const maxHeight = code.slice(maxHeightStart, maxHeightEnd);
      if (!maxWidth || !maxHeight) {
        throw new Error("[excalidraw-scenes] text padding: getBoundTextMaxWidth/Height not found upstream");
      }
      code = code
        .replace(maxWidth, maxWidth.split("BOUND_TEXT_PADDING * 2").join("__textPadding(container) * 2").replace(": BOUND_TEXT_PADDING) *", ": __textPadding(container)) *"))
        .replace(maxHeight, maxHeight.split("BOUND_TEXT_PADDING * 2").join("__textPadding(container) * 2"));
      return patch("textElement.ts", [
        ["    : BOUND_TEXT_PADDING;\n  let offsetX = padding;", "    : __textPadding(container);\n  let offsetX = padding;"],
        [
          "  containerType: ExtractSetType<typeof VALID_CONTAINER_TYPES>,\n) => {\n  dimension = Math.ceil(dimension);\n  const padding = BOUND_TEXT_PADDING * 2;",
          "  containerType: ExtractSetType<typeof VALID_CONTAINER_TYPES>,\n  container?: any,\n) => {\n  dimension = Math.ceil(dimension);\n  const padding = __textPadding(container) * 2;",
        ],
        [resize, "computeContainerDimensionForBoundText($1, container.type, container)", 3],
      ]);
    }
    if (file.endsWith("/packages/excalidraw/wysiwyg/textWysiwyg.tsx")) {
      return patch("textWysiwyg.tsx", [[resize, "computeContainerDimensionForBoundText($1, container.type, container)", 2]]);
    }
    if (file.endsWith("/packages/excalidraw/components/Actions.tsx")) {
      const control = (indent: string) =>
        `${indent}<TextPaddingControl appState={appState} elementsMap={elementsMap as any} />`;
      return patch("Actions.tsx", [
        [
          '      {predicates.opacity && renderAction("changeOpacity")}\n\n      {predicates.layers',
          `      {predicates.opacity && renderAction("changeOpacity")}\n${control("      ")}\n\n      {predicates.layers`,
        ],
        [
          '              {predicates.opacity && renderAction("changeOpacity")}\n            </div>',
          `              {predicates.opacity && renderAction("changeOpacity")}\n${control("              ")}\n            </div>`,
        ],
        [/^/, `import { TextPaddingControl } from ${JSON.stringify(TEXT_PADDING_ENTRY)};\n`],
      ]);
    }
    return null;
  },
});

const RICH_LAYOUT_ENTRY = path.resolve(HERE, "src/richText/layout.ts");
const RICH_EDITOR_ENTRY = path.resolve(HERE, "src/richText/editor.ts");

/**
 * Formatted text (`customData.rich`, see src/richText): Excalidraw measures,
 * wraps and draws text as one font and size. These patches hand formatted
 * texts to src/richText/layout.ts instead (measuring and wrapping, the
 * canvas, SVG export), and give the text editor a contenteditable with a
 * formatting toolbar instead of its textarea (src/richText/editor.ts).
 */
const richText = () => ({
  name: "excalidraw-scenes-rich-text",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const file = id.replace(/\\/g, "/").split("?")[0];
    const patch = (name: string, entry: string, imports: string[], steps: Array<[string | RegExp, string, number?]>) => {
      let next = code;
      for (const [from, to, count = 1] of steps) {
        const found =
          typeof from === "string" ? next.split(from).length - 1 : (next.match(new RegExp(from.source, "g")) || []).length;
        if (found !== count) {
          throw new Error(
            `[excalidraw-scenes] rich text: ${name} changed upstream (expected ${count}× ${String(from).slice(0, 80)}, found ${found}). Update scenes-plugin/vite.config.mts.`,
          );
        }
        next = typeof from === "string" ? next.split(from).join(to) : next.replace(new RegExp(from.source, "g"), to);
      }
      const head = imports.length ? `import { ${imports.join(", ")} } from ${JSON.stringify(entry)};\n` : "";
      return { code: head + next, map: null };
    };
    const MEASURE = ["richMeasure as __richMeasure", "richWrap as __richWrap"];

    if (file.endsWith("/packages/element/src/renderElement.ts")) {
      return patch("renderElement.ts", RICH_LAYOUT_ENTRY, ["drawRich as __richDraw"], [
        [
          "      if (isTextElement(element)) {\n        const rtl = isRTL(element.text);",
          "      if (\n        isTextElement(element) &&\n        __richDraw(element as any, context, renderConfig.theme === THEME.DARK)\n      ) {\n        // formatted text: drawn by the scenes plugin\n      } else if (isTextElement(element)) {\n        const rtl = isRTL(element.text);",
        ],
      ]);
    }
    if (file.endsWith("/packages/excalidraw/renderer/staticSvgScene.ts")) {
      return patch("staticSvgScene.ts", RICH_LAYOUT_ENTRY, ["svgRich as __richSvg"], [
        [
          '        for (let i = 0; i < lines.length; i++) {\n          const text = svgRoot.ownerDocument.createElementNS(SVG_NS, "text");',
          '        const __isRich = __richSvg(element as any, node, svgRoot.ownerDocument, renderConfig.theme === THEME.DARK);\n        for (let i = 0; !__isRich && i < lines.length; i++) {\n          const text = svgRoot.ownerDocument.createElementNS(SVG_NS, "text");',
        ],
      ]);
    }
    if (file.endsWith("/packages/element/src/newElement.ts")) {
      return patch("newElement.ts", RICH_LAYOUT_ENTRY, MEASURE, [
        [
          "    if (measureText(text, font, textElement.lineHeight).width > maxWidth) {\n      const wrappedText = wrapText(text, font, maxWidth);",
          "    if (\n      (__richMeasure(textElement as any, text) ?? measureText(text, font, textElement.lineHeight)).width > maxWidth\n    ) {\n      const wrappedText = __richWrap(textElement as any, text, maxWidth) ?? wrapText(text, font, maxWidth);",
        ],
        [
          "    text = wrapText(\n      text,\n      getFontString(textElement),\n      container\n        ? getBoundTextMaxWidth(container, textElement)\n        : textElement.width,\n    );",
          "    const __maxWidth = container\n      ? getBoundTextMaxWidth(container, textElement)\n      : textElement.width;\n    text =\n      __richWrap(textElement as any, text, __maxWidth) ??\n      wrapText(text, getFontString(textElement), __maxWidth);",
        ],
        [
          "  let { width: nextWidth, height: nextHeight } = measureText(\n    nextText,",
          "  let { width: nextWidth, height: nextHeight } = __richMeasure(element as any, nextText) ?? measureText(\n    nextText,",
        ],
        // the size before the change: the element's own
        [
          "    const prevMetrics = measureText(\n      element.text,",
          "    const prevMetrics = (element.customData?.rich ? { width: element.width, height: element.height } : null) ?? measureText(\n      element.text,",
        ],
      ]);
    }
    if (file.endsWith("/packages/element/src/textElement.ts")) {
      return patch("textElement.ts", RICH_LAYOUT_ENTRY, MEASURE, [
        [
          "    boundTextUpdates.text = wrapText(\n      textElement.originalText,",
          "    boundTextUpdates.text = __richWrap(textElement as any, textElement.originalText, maxWidth) ?? wrapText(\n      textElement.originalText,",
        ],
        [
          "  const metrics = measureText(\n    boundTextUpdates.text,",
          "  const metrics = __richMeasure(textElement as any, boundTextUpdates.text) ?? measureText(\n    boundTextUpdates.text,",
        ],
        [
          "        text = wrapText(\n          textElement.originalText,",
          "        text = __richWrap(textElement as any, textElement.originalText, maxWidth) ?? wrapText(\n          textElement.originalText,",
        ],
        [
          "      const metrics = measureText(\n        text,\n        getFontString(textElement),",
          "      const metrics = __richMeasure(textElement as any, text) ?? measureText(\n        text,\n        getFontString(textElement),",
        ],
      ]);
    }
    if (file.endsWith("/packages/element/src/resizeElements.ts")) {
      return patch("resizeElements.ts", RICH_LAYOUT_ENTRY, MEASURE, [
        [
          "    const text = wrapText(\n      element.originalText,\n      getFontString(element),\n      Math.abs(newWidth),\n    );\n    const metrics = measureText(\n      text,",
          "    const text = __richWrap(element as any, element.originalText, Math.abs(newWidth)) ?? wrapText(\n      element.originalText,\n      getFontString(element),\n      Math.abs(newWidth),\n    );\n    const metrics = __richMeasure(element as any, text) ?? measureText(\n      text,",
        ],
      ]);
    }
    if (file.endsWith("/packages/excalidraw/actions/actionTextAutoResize.ts")) {
      return patch("actionTextAutoResize.ts", RICH_LAYOUT_ENTRY, MEASURE, [
        [
          "    const metrics = measureText(\n      target.originalText,",
          "    const metrics = __richMeasure(target as any, target.originalText) ?? measureText(\n      target.originalText,",
        ],
      ]);
    }
    if (file.endsWith("/packages/element/src/stickyNote.ts")) {
      return patch("stickyNote.ts", RICH_LAYOUT_ENTRY, ["richFit as __richFit"], [
        [
          "    const text = wrapText(originalText, font, maxWidth);\n    return { text, fontSize, ...measureText(text, font, lineHeight) };",
          "    const __rich = __richFit(textElement as any, originalText, maxWidth, fontSize);\n    if (__rich) {\n      return { fontSize, ...__rich };\n    }\n    const text = wrapText(originalText, font, maxWidth);\n    return { text, fontSize, ...measureText(text, font, lineHeight) };",
        ],
      ]);
    }
    // duplicating `1. foo` gives `2. foo`: not for formatted text, whose
    // numbers come from its list (the copy is copied as it is)
    if (file.endsWith("/packages/element/src/listMarker.ts")) {
      return patch("listMarker.ts", RICH_LAYOUT_ENTRY, [], [
        [
          "    const marker = text && getListItemMarker(text.originalText);",
          "    const marker =\n      text && !(text as any).customData?.rich && getListItemMarker(text.originalText);",
        ],
      ]);
    }
    if (file.endsWith("/packages/excalidraw/wysiwyg/textWysiwyg.tsx")) {
      return patch("textWysiwyg.tsx", RICH_EDITOR_ENTRY, ["createRichEditable as __createRichEditable"], [
        [
          '  const editable = ownerDocument.createElement("textarea");',
          "  const editable = __createRichEditable(\n    ownerDocument,\n    element,\n    app,\n    getViewportCoords,\n  ) as unknown as HTMLTextAreaElement;",
        ],
        // a click into the text puts the caret where the browser lays it out
        [
          "  const getCaretIndexFromInitialSceneCoords = () => {",
          "  (editable as any).__initialPoint =\n    initialCaretSceneCoords && !initialSelection\n      ? getViewportCoords(initialCaretSceneCoords.x, initialCaretSceneCoords.y)\n      : null;\n  const getCaretIndexFromInitialSceneCoords = () => {",
        ],
        [
          "      if (target instanceof ownerWindow.HTMLTextAreaElement) {",
          '      if (\n        target instanceof ownerWindow.HTMLElement &&\n        target.closest(".excalidraw-wysiwyg")\n      ) {',
        ],
      ]);
    }
    if (file.endsWith("/packages/excalidraw/components/App.wheel.ts")) {
      return patch("App.wheel.ts", RICH_EDITOR_ENTRY, [], [
        [
          "      event.target instanceof ownerWindow.HTMLTextAreaElement ||",
          '      event.target instanceof ownerWindow.HTMLTextAreaElement ||\n      (event.target instanceof ownerWindow.HTMLElement &&\n        !!event.target.closest(".excalidraw-wysiwyg")) ||',
        ],
      ]);
    }
    return null;
  },
});

/**
 * Scene URLs (`/<scene name>`): serve the app for any page path, so the dev
 * server doesn't 404 on names containing dots etc.
 */
const sceneUrls = () => ({
  name: "excalidraw-scenes-urls",
  configureServer(server: any) {
    server.middlewares.use((req: any, _res: any, next: () => void) => {
      const [pathname, query] = (req.url || "/").split("?");
      if (
        req.method === "GET" &&
        req.headers.accept?.includes("text/html") &&
        /^\/[^/]+$/.test(pathname) &&
        !/\.html?$/.test(pathname)
      ) {
        req.url = `/${query ? `?${query}` : ""}`;
      }
      next();
    });
  },
});

/**
 * Kurviq (SCENES_TARGET=online): the same app as a public website. Excalidraw
 * services that would send drawings elsewhere are switched off (live
 * collaboration, analytics), the page carries Kurviq's name and icon, and the
 * service worker leaves the Worker's routes (/auth, /mcp, /live) alone.
 */
const SITE = "https://kurviq.com";
const KURVIQ_TITLE = "Kurviq – free whiteboard with GitHub sync and AI agents";
const KURVIQ_DESCRIPTION =
  "Kurviq is a free online whiteboard built on Excalidraw: hand-drawn diagrams, scenes, slides and formatted text. No account – your drawings stay in your browser. Optionally sync them with a GitHub repository and let AI agents draw with you via MCP.";

const KURVIQ_META = `<!-- Primary Meta Tags -->
    <meta name="title" content="${KURVIQ_TITLE}" />
    <meta name="description" content="${KURVIQ_DESCRIPTION}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="application-name" content="Kurviq" />
    <meta name="apple-mobile-web-app-title" content="Kurviq" />
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:site_name" content="Kurviq" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:url" content="${SITE}/" />
    <meta property="og:title" content="${KURVIQ_TITLE}" />
    <meta property="og:description" content="${KURVIQ_DESCRIPTION}" />
    <meta property="og:image" content="${SITE}/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Kurviq: hand-drawn diagrams and slides, synced with GitHub, AI agents draw with you" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${KURVIQ_TITLE}" />
    <meta name="twitter:description" content="${KURVIQ_DESCRIPTION}" />
    <meta name="twitter:image" content="${SITE}/og-image.png" />
    <link rel="alternate" type="text/plain" title="Kurviq for AI agents" href="/llms.txt" />
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Kurviq",
      url: `${SITE}/`,
      description: KURVIQ_DESCRIPTION,
      applicationCategory: "DesignApplication",
      operatingSystem: "Any (web browser)",
      browserRequirements: "Requires JavaScript",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      image: `${SITE}/og-image.png`,
      featureList: [
        "Hand-drawn diagrams and sketches (Excalidraw)",
        "Named scenes with their own URLs",
        "Slides and presentations with templates and PDF export",
        "Formatted text: bold, lists, checklists, links",
        "Optional sync with a GitHub repository, shared by several people",
        "AI agents draw and edit with you (remote MCP server)",
        "No account; works offline",
      ],
      sameAs: ["https://github.com/tecsteps/kurviq"],
    })}</script>`;

const KURVIQ_ICONS = `<link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" type="image/svg+xml" href="/kurviq.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;

/**
 * What search engines (and visitors without JavaScript) see; the app replaces
 * it as soon as it starts.
 */
const KURVIQ_STATIC = `<div id="root"><main class="kq-static" style="max-width:40rem;margin:12vh auto;padding:0 1.5rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#555;line-height:1.55">
      <h1 style="color:#1f1d3a;font-size:2rem;margin:0 0 .5rem">Kurviq: hand-drawn diagrams, synced with GitHub</h1>
      <p>Kurviq is a free online whiteboard built on <a href="https://github.com/excalidraw/excalidraw">Excalidraw</a>. Sketch diagrams with a hand-drawn look, organise them as named scenes, present them as slides and write formatted text. No account needed: your drawings stay in your browser.</p>
      <h2 style="font-size:1.1rem;color:#1f1d3a">Sync with GitHub, together</h2>
      <p>Connect GitHub to keep your scenes in a repository of your choice, on all your devices. Several people can work in the same repository; changes are merged element by element.</p>
      <h2 style="font-size:1.1rem;color:#1f1d3a">AI agents draw with you</h2>
      <p>Give Claude, Codex, Cursor or any MCP client your personal Kurviq link and it reads, draws and edits your scenes while you work. Agents: see <a href="/llms.txt">llms.txt</a>.</p>
      <p><a href="https://github.com/tecsteps/kurviq">Open source (MIT)</a> · unofficial, not affiliated with Excalidraw · <a href="/third-party-licenses.txt">licenses</a> · <a href="/imprint">imprint</a> · <a href="/privacy">privacy</a></p>
    </main></div>`;

/** branded files written over upstream's (Excalidraw-branded) ones in the build */
const KURVIQ_FILES: Record<string, string> = {
  "favicon.ico": "favicon.ico",
  "favicon-16x16.png": "icon-16.png",
  "favicon-32x32.png": "icon-32.png",
  "apple-touch-icon.png": "icon-180.png",
  "android-chrome-192x192.png": "icon-192.png",
  "android-chrome-512x512.png": "icon-512.png",
  "maskable_icon_x192.png": "icon-maskable-512.png",
  "maskable_icon_x512.png": "icon-maskable-512.png",
  "og-image.png": "og-image.png",
  "kurviq.svg": "kurviq.svg",
};
/**
 * Upstream's build loads fonts from Excalidraw's CDN and warms up Google
 * Fonts: Kurviq serves its fonts itself, so visitors' browsers talk to
 * kurviq.com only (and to GitHub once they connect it).
 */
const EXCALIDRAW_CDN = "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/";
const selfHosted = (text: string) =>
  text
    .split(EXCALIDRAW_CDN)
    .join("/")
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*\/?>\s*/g, "");

/** upstream files that only make sense on excalidraw.com */
const UPSTREAM_ONLY = ["og-image-3.png", "favicon.svg", "screenshots"];

/** favicon.ico = PNG images in an ICO container */
const buildIco = (pngs: Buffer[]) => {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const size = png.readUInt32BE(16); // PNG IHDR width
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
};

/** runs after upstream's plugins have written their CDN links into index.html */
const kurviqSelfHosted = () => ({
  name: "kurviq-self-hosted",
  transformIndexHtml: { order: "post" as const, handler: (html: string) => selfHosted(html) },
});

const kurviqOnline = () => ({
  name: "kurviq-online",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const file = id.replace(/\\/g, "/").split("?")[0];
    const patch = (name: string, steps: Array<[string | RegExp, string]>) => {
      let next = code;
      for (const [from, to] of steps) {
        const found = typeof from === "string" ? next.includes(from) : from.test(next);
        if (!found) {
          throw new Error(`[excalidraw-scenes] kurviq: ${name} changed upstream (${String(from).slice(0, 60)}) — update scenes-plugin/vite.config.mts`);
        }
        next = next.replace(from, to);
      }
      return { code: next, map: null };
    };
    if (file.endsWith("/excalidraw-app/App.tsx")) {
      return patch("App.tsx", [
        // live collaboration and shareable links run on excalidraw.com's servers
        ["const isCollabDisabled = isRunningInIframe();", "const isCollabDisabled = true; // Kurviq: no live collaboration"],
        ["              onExportToBackend,\n", "              onExportToBackend: undefined,\n"],
        // Excalidraw+ promotions
        ["              renderCustomUI: excalidrawAPI\n", "              renderCustomUI: false\n"],
        [": [ExcalidrawPlusCommand, ExcalidrawPlusAppCommand]),", ": []),"],
      ]);
    }
    if (file.endsWith("/excalidraw-app/components/AppWelcomeScreen.tsx")) {
      return patch("AppWelcomeScreen.tsx", [
        ["<WelcomeScreen.Center.Logo />", '<WelcomeScreen.Center.Logo><span className="kq-welcome-logo">Kurviq</span></WelcomeScreen.Center.Logo>'],
        ["{!isExcalidrawPlusSignedUser && (", "{false && ("],
        ["<WelcomeScreen.Center.MenuItemHelp />", "<WelcomeScreen.Center.MenuItemHelp />\n          <WelcomeConnectGitHub />"],
        // Kurviq's own words instead of upstream's storage warning
        ["{headingContent}", "<WelcomeHeading />"],
        [/^/, `import { WelcomeConnectGitHub, WelcomeHeading } from ${JSON.stringify(path.resolve(HERE, "src/online/ui.tsx"))};\n`],
      ]);
    }
    if (file.endsWith("/excalidraw-app/components/AppMainMenu.tsx")) {
      return patch("AppMainMenu.tsx", [
        [/<MainMenu\.ItemLink\s+icon=\{ExcalLogo\}[\s\S]*?<\/MainMenu\.ItemLink>/, ""],
        [/<MainMenu\.ItemLink\s+icon=\{loginIcon\}[\s\S]*?<\/MainMenu\.ItemLink>/, ""],
      ]);
    }
    return null;
  },
  transformIndexHtml: {
    order: "pre" as const,
    handler(html: string) {
      const meta = /<!-- Primary Meta Tags -->[\s\S]*?<link rel="canonical"[^>]*\/>/;
      const analytics = /<!-- 100% privacy friendly analytics -->\s*<script>[\s\S]*?<\/script>/;
      const icons = /<link rel="apple-touch-icon"[^>]*\/>\s*<link rel="icon"[^>]*\/>\s*<link rel="icon"[^>]*\/>/;
      for (const [what, re] of [["meta tags", meta], ["analytics", analytics], ["icons", icons]] as const) {
        if (!re.test(html)) {
          throw new Error(`[excalidraw-scenes] kurviq: ${what} not found in index.html — update scenes-plugin/vite.config.mts`);
        }
      }
      if (!html.includes('<div id="root"></div>')) {
        throw new Error("[excalidraw-scenes] kurviq: #root not found in index.html — update scenes-plugin/vite.config.mts");
      }
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${KURVIQ_TITLE}</title>`)
        .replace(meta, KURVIQ_META)
        .replace(analytics, "")
        .replace(icons, KURVIQ_ICONS)
        .replace('<h1 class="visually-hidden">Excalidraw</h1>', '<h1 class="visually-hidden">Kurviq</h1>')
        .replace('<div id="root"></div>', KURVIQ_STATIC);
    },
  },
  generateBundle(this: any) {
    // MIT / OFL notices of everything in the bundle (minified code has no comments left)
    this.emitFile({
      type: "asset",
      fileName: "third-party-licenses.txt",
      source: thirdPartyNotices({
        title: "Kurviq app (kurviq.com): third-party licenses",
        files: [...this.getModuleIds()],
        fonts: true,
      }),
    });
    // imprint and privacy notice: plain pages around the app
    const layout = readFileSync(path.join(ONLINE_DIR, "pages/_layout.html"), "utf8");
    for (const [page, title, lang] of [["imprint", "Imprint / Impressum", "en"], ["privacy", "Privacy / Datenschutz", "en"]]) {
      this.emitFile({
        type: "asset",
        fileName: `${page}.html`,
        source: layout
          .replace("{{lang}}", lang)
          .replace("{{title}}", title)
          .replace("{{content}}", readFileSync(path.join(ONLINE_DIR, `pages/${page}.html`), "utf8")),
      });
    }
    this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /mcp/\nDisallow: /live/\n\nSitemap: ${SITE}/sitemap.xml\n` });
    this.emitFile({
      type: "asset",
      fileName: "sitemap.xml",
      source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`,
    });
  },
  // after upstream's public files were copied: Kurviq's icons and images instead
  closeBundle() {
    const out = path.join(ONLINE_DIR, "dist/app");
    if (!existsSync(out)) {
      return;
    }
    const brand = (file: string) => readFileSync(path.join(ONLINE_DIR, "brand", file));
    for (const [target, source] of Object.entries(KURVIQ_FILES)) {
      writeFileSync(
        path.join(out, target),
        target === "favicon.ico" ? buildIco(["icon-16.png", "icon-32.png", "icon-48.png"].map(brand)) : brand(source),
      );
    }
    for (const file of UPSTREAM_ONLY) {
      rmSync(path.join(out, file), { recursive: true, force: true });
    }
    // stylesheets (hashed file names, so the service worker's cache stays valid)
    for (const file of readdirSync(path.join(out, "assets"))) {
      if (file.endsWith(".css")) {
        const full = path.join(out, "assets", file);
        const css = readFileSync(full, "utf8");
        if (css.includes(EXCALIDRAW_CDN)) {
          writeFileSync(full, selfHosted(css));
        }
      }
    }
  },
});

/** upstream's PWA setup, with Kurviq's name and the Worker's routes left to the network */
const kurviqPwa = () =>
  VitePWA({
    registerType: "autoUpdate",
    workbox: {
      navigateFallbackDenylist: [/^\/auth\//, /^\/mcp(\/|$)/, /^\/live\//, /^\/llms\.txt$/, /^\/(imprint|privacy)(\.html)?$/, /\.txt$/],
      globIgnores: ["fonts.css", "**/locales/**", "service-worker.js", "**/*.chunk-*.js", "**/CodeMirrorEditor-*.js"],
      runtimeCaching: [
        {
          urlPattern: new RegExp(".+.woff2"),
          handler: "CacheFirst",
          options: {
            cacheName: "fonts",
            expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 90 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        { urlPattern: new RegExp("fonts.css"), handler: "StaleWhileRevalidate", options: { cacheName: "fonts", expiration: { maxEntries: 50 } } },
        {
          urlPattern: new RegExp("locales/[^/]+.js"),
          handler: "CacheFirst",
          options: { cacheName: "locales", expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 } },
        },
        {
          urlPattern: new RegExp("(.chunk-.+|CodeMirrorEditor-.+)\\.js"),
          handler: "CacheFirst",
          options: { cacheName: "chunk", expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 90 } },
        },
      ],
      maximumFileSizeToCacheInBytes: 2.3 * 1024 ** 2,
    },
    manifest: {
      short_name: "Kurviq",
      name: "Kurviq",
      description: "Hand-drawn diagrams, scenes and slides, built on Excalidraw. Optionally synced with GitHub.",
      icons: [
        { src: "kurviq.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
        { src: "maskable_icon_x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      start_url: "/",
      id: "kurviq",
      display: "standalone",
      theme_color: "#121212",
      background_color: "#ffffff",
      file_handlers: [{ action: "/", accept: { "application/vnd.excalidraw+json": [".excalidraw"] } }],
      share_target: {
        action: "/web-share-target",
        method: "POST",
        enctype: "multipart/form-data",
        params: { files: [{ name: "file", accept: ["application/vnd.excalidraw+json", "application/json", ".excalidraw"] }] },
      },
    },
  });

export default async (configEnv: { mode: string; command: string }) => {
  const config: any = await (typeof upstreamConfig === "function"
    ? (upstreamConfig as any)(configEnv)
    : upstreamConfig);
  const env = readEnv();
  const online = env.SCENES_TARGET === "online";
  // online: upstream's PWA (Excalidraw's name) and sitemap (excalidraw.com) make way for Kurviq's
  const upstreamPlugins = ((config.plugins || []) as any[])
    .flat(Infinity)
    .filter((plugin: any) => !online || !/^vite-plugin-(pwa|sitemap)/.test(plugin?.name || ""));

  return {
    ...config,
    plugins: [
      injectScenesPlugin(),
      textPadding(),
      richText(),
      sceneUrls(),
      ...(online ? [kurviqOnline(), kurviqPwa()] : []),
      ...upstreamPlugins,
      ...(online ? [kurviqSelfHosted()] : []),
    ],
    ...(online
      ? {
          build: {
            ...config.build,
            outDir: path.join(ONLINE_DIR, "dist/app"),
            emptyOutDir: true,
            // no source maps on the public site
            sourcemap: false,
          },
        }
      : {}),
    define: {
      ...config.define,
      "import.meta.env.VITE_APP_SCENES_TARGET": JSON.stringify(online ? "online" : "local"),
      "import.meta.env.VITE_APP_SCENES_GIT_REPO": JSON.stringify(
        env.SCENES_GIT_REPO || "",
      ),
      "import.meta.env.VITE_APP_SCENES_GIT_BRANCH": JSON.stringify(
        env.SCENES_GIT_BRANCH || "main",
      ),
      "import.meta.env.VITE_APP_SCENES_SERVER_URL": JSON.stringify(
        env.SCENES_SERVER_URL || "http://localhost:3101",
      ),
    },
    resolve: {
      ...config.resolve,
      // our sources live outside the checkout and have no node_modules of
      // their own — resolve shared deps from the excalidraw checkout
      dedupe: [
        ...(config.resolve?.dedupe || []),
        "react",
        "react-dom",
        "clsx",
        "idb-keyval",
      ],
    },
    server: {
      ...config.server,
      fs: {
        ...config.server?.fs,
        allow: [...(config.server?.fs?.allow || []), EXCALIDRAW_ROOT, HERE],
      },
    },
  };
};
