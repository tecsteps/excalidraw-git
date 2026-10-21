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
    plugins: [injectScenesPlugin(), textPadding(), sceneUrls(), ...(config.plugins || [])],
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
