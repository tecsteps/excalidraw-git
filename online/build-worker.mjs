// Bundles the Kurviq Worker (worker/index.ts) into build/worker.js. Our own
// bundling (instead of wrangler's) so node:fs/promises can be replaced by a
// shim: the upstream excalidraw-mcp tools read their widget from a file.
//
// Dependencies (MCP SDK, zod) come from the excalidraw-mcp checkout, like for
// the local MCP server (scenes-mcp/node_modules links there).
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { thirdPartyNotices } from "./licenses.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [path.join(HERE, "worker/index.ts")],
  outfile: path.join(HERE, "build/worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  nodePaths: [path.resolve(HERE, "../excalidraw-mcp/node_modules")],
  alias: {
    "node:fs/promises": path.join(HERE, "worker/shims/fs-promises.js"),
  },
  // provided by the Workers runtime (nodejs_compat)
  external: ["cloudflare:workers", "node:*"],
  // the upstream tools locate their files with these (no file system here)
  define: {
    "import.meta.filename": JSON.stringify("/bundle/server.js"),
    "import.meta.dirname": JSON.stringify("/bundle"),
  },
  loader: { ".md": "text", ".txt": "text", ".html": "text" },
  minify: process.env.KURVIQ_DEBUG !== "1",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

// MIT notices of what the Worker bundles, published next to the app's
const notices = thirdPartyNotices({
  title: "Kurviq server (Cloudflare Worker, remote MCP): third-party licenses",
  files: Object.keys(result.metafile.inputs).map((file) => path.resolve(process.cwd(), file)),
});
mkdirSync(path.join(HERE, "dist/app"), { recursive: true });
writeFileSync(path.join(HERE, "dist/app/third-party-licenses-server.txt"), notices);
