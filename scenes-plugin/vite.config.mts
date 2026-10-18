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
          .replace(sidebar, (match) => `${match}\n<ScenesSidebar />`),
      map: null,
    };
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
    plugins: [injectScenesPlugin(), sceneUrls(), ...(config.plugins || [])],
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
