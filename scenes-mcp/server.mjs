#!/usr/bin/env node
/**
 * Kurviq's MCP server (stdio), for the local install: the tools of
 * ./tools.mjs against the scenes server on this machine (../scenes-server).
 *
 * By default (SCENES_AGENT_MODE=detached) the agent works in its own headless
 * Excalidraw tab that the scenes server starts: reads/edits/renders happen
 * there and edits are committed to GitHub; the user's browser only syncs
 * (it is asked to push a scene before the agent reads it). In live mode the
 * agent works in the user's open tab instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "../excalidraw-mcp/dist/server.js";

import { createScenesMcp } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");

const readEnv = () => {
  const env = {};
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
  return { ...env, ...process.env };
};

const env = readEnv();
const SERVER_URL = (env.SCENES_SERVER_URL || "http://localhost:3101").replace(/\/$/, "");

const server = createScenesMcp({
  serverFetch: (pathname, init) => fetch(`${SERVER_URL}${pathname}`, init),
  unreachable: `Scenes server not reachable at ${SERVER_URL}. Start it with \`npm run start\` in ${WORKSPACE}.`,
  /**
   * detached (default): the agent works in its own headless Excalidraw against
   * GitHub; the user's browser only syncs. live: the agent edits the user's
   * open canvas directly (co-working in the same tab).
   */
  mode: env.SCENES_AGENT_MODE === "live" ? "live" : "detached",
  appHint: (env.SCENES_APP_URL || "http://localhost:3001").replace(/\/$/, ""),
  skill: readFileSync(path.join(HERE, "skill", "excalidraw-scenes", "SKILL.md"), "utf8"),
  registerUpstream: (mcp, store) => registerTools(mcp, path.join(WORKSPACE, "excalidraw-mcp", "dist"), store),
  livePreview: process.env.SCENES_LIVE_PREVIEW !== "false",
  savePdf: async (name, pdf, file) => {
    const target = path.resolve(file || path.join(process.cwd(), `${name}.pdf`));
    await writeFile(target, pdf);
    return { file: target };
  },
});

await server.connect(new StdioServerTransport());
