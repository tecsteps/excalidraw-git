// Wraps the upstream excalidraw-app Vite config and injects the scenes plugin
// at build time — the excalidraw checkout itself stays untouched.
//
// Must be run with cwd = excalidraw/excalidraw-app (upstream config resolves
// its env dir relative to cwd), e.g.:
//   cd excalidraw/excalidraw-app && npx vite --config ../../scenes-plugin/vite.config.mts

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import upstreamConfig from "../excalidraw/excalidraw-app/vite.config.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
const EXCALIDRAW_ROOT = path.resolve(WORKSPACE, "excalidraw");
const PLUGIN_ENTRY = path.resolve(HERE, "src/index.tsx");

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

export default async (configEnv: { mode: string; command: string }) => {
  const config: any = await (typeof upstreamConfig === "function"
    ? (upstreamConfig as any)(configEnv)
    : upstreamConfig);
  const env = readEnv();

  return {
    ...config,
    plugins: [injectScenesPlugin(), textPadding(), richText(), sceneUrls(), ...(config.plugins || [])],
    define: {
      ...config.define,
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
