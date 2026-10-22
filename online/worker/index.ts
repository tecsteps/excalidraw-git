// Kurviq (https://kurviq.com): the Cloudflare Worker.
//
//   /auth/*          Connect GitHub (./auth.ts) — stateless, encrypted cookie
//   /live/<key>      WebSocket of a Kurviq tab to its agent pairing (./pairing.ts)
//   /mcp/<key>       remote MCP for agents (scenes-mcp/tools.mjs), answered
//                    through the pairing's open Kurviq tab
//   /llms.txt        how agents use Kurviq
//   /api/public/…    public scenes, cached (./shared.ts)
//   /api/fonts/…     fonts from Google Fonts for "Add font", cached (./fonts.ts)
//   /@owner/scene    a shared scene: the app, titled for link previews (./shared.ts)
//   everything else  the app (static assets, built by `npm run build:online`)

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerTools } from "../../excalidraw-mcp/dist/server.js";
import { createScenesMcp } from "../../scenes-mcp/tools.mjs";

import llmsTxt from "../llms.txt";
import { handleAuth } from "./auth";
import { handleFonts } from "./fonts";
import { handlePublicApi, handleSharedPage } from "./shared";
import { kurviqSkill } from "./skill";

import type { AuthEnv } from "./auth";

export { Pairing } from "./pairing";

type Env = AuthEnv & {
  ASSETS: Fetcher;
  PAIRING: DurableObjectNamespace;
  /** canonical host (www and workers.dev redirect there), e.g. kurviq.com */
  CANONICAL_HOST?: string;
};

const KEY_RE = /^[A-Za-z0-9_-]{32}$/;

/** the pairing's Durable Object; named by a hash, so the key itself is never stored */
const pairingStub = async (env: Env, key: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kurviq-pairing:${key}`)));
  const name = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return env.PAIRING.get(env.PAIRING.idFromName(name));
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

const withCors = (response: Response) => {
  const next = new Response(response.body, response);
  Object.entries(CORS).forEach(([key, value]) => next.headers.set(key, value));
  return next;
};

/** tools that work without the user's tab (everything else runs there) */
const WITHOUT_TAB = new Set(["read_me"]);

/** JSON-RPC tool calls in a request (single or batch), if any */
const toolCalls = async (request: Request): Promise<Array<{ id: unknown; name: string }>> => {
  if (request.method !== "POST") {
    return [];
  }
  try {
    const body = await request.clone().json();
    return (Array.isArray(body) ? body : [body])
      .filter((message) => message?.method === "tools/call")
      .map((message) => ({ id: message.id, name: String(message.params?.name ?? "") }));
  } catch {
    return [];
  }
};

const handleMcp = async (request: Request, env: Env, key: string) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const app = new URL(request.url).origin;
  const stub = await pairingStub(env, key);
  const unreachable = `Kurviq could not reach the user's browser. Ask the user to open ${app} (in the browser this agent link was made in).`;
  // no tab behind this link: nothing runs (and nothing is fetched on its behalf)
  const calls = (await toolCalls(request)).filter((call) => !WITHOUT_TAB.has(call.name));
  if (calls.length) {
    const state = (await (await stub.fetch(new Request("https://pairing/api/app/state"))).json()) as { connected?: boolean };
    if (!state.connected) {
      const answers = calls.map((call) => ({
        jsonrpc: "2.0",
        id: call.id,
        result: { content: [{ type: "text", text: unreachable }], isError: true },
      }));
      return withCors(
        new Response(JSON.stringify(answers.length === 1 ? answers[0] : answers), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
  }
  const server = createScenesMcp({
    name: "Kurviq",
    mode: "detached",
    appHint: app,
    githubOptional: true,
    skill: kurviqSkill(app),
    unreachable,
    serverFetch: (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("X-Kurviq-App", app);
      return stub.fetch(new Request(`https://pairing${pathname}`, { ...init, headers }));
    },
    registerUpstream: (mcp: unknown, store: unknown) => registerTools(mcp as any, "/bundle", store as any),
    savePdf: async () => {
      throw new Error("PDF export is not available through the Kurviq MCP; the user exports PDFs in Kurviq (Slides sidebar → PDF).");
    },
  });
  // stateless: a new server per request, nothing kept between requests
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    server.close().catch(() => {});
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.hostname = env.CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    const auth = await handleAuth(request, env);
    if (auth) {
      return auth;
    }

    const live = url.pathname.match(/^\/live\/([^/]+)$/);
    if (live) {
      if (!KEY_RE.test(live[1])) {
        return new Response("Unknown agent link", { status: 404 });
      }
      // only Kurviq's own pages (browsers always send Origin with a WebSocket)
      if (request.headers.get("Origin") !== url.origin) {
        return new Response("Forbidden", { status: 403 });
      }
      const stub = await pairingStub(env, live[1]);
      return stub.fetch(new Request(`https://pairing/live${url.search}`, request));
    }

    const mcp = url.pathname.match(/^\/mcp(?:\/([^/]*))?\/?$/);
    if (mcp) {
      if (!mcp[1] || !KEY_RE.test(mcp[1])) {
        return withCors(
          new Response(
            JSON.stringify({
              error: `This is not a complete Kurviq agent link. Open ${url.origin}, click "MCP" (top left) and copy the link shown there: ${url.origin}/mcp/<your key>. See ${url.origin}/llms.txt`,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return handleMcp(request, env, mcp[1]);
    }

    if (url.pathname === "/llms.txt") {
      return new Response(String(llmsTxt).replaceAll("https://kurviq.com", url.origin), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }

    const fonts = await handleFonts(request, ctx);
    if (fonts) {
      return fonts;
    }
    const publicApi = handlePublicApi(request, ctx);
    if (publicApi) {
      return publicApi;
    }
    const page = await handleSharedPage(request, env.ASSETS, ctx);
    if (page) {
      return page;
    }
    // Excalidraw's font subsetting (SVG / PDF export) runs in a worker whose
    // Emscripten code builds functions with new Function: only that worker gets
    // 'unsafe-eval' (a thread of its own, it only ever sees font files); the
    // page keeps its strict policy
    if (/^\/assets\/subset-worker\.chunk-[\w-]+\.js$/.test(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data:",
      );
      return response;
    }
    return env.ASSETS.fetch(request);
  },
};
