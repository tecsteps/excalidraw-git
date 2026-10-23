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

/** images an agent uploads: at most this big (the tab keeps them, the scene file carries them) */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** the image type, from the file's first bytes (agents often send no or a wrong Content-Type) */
const imageType = (bytes: Uint8Array): string | null => {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
};

/**
 * POST /mcp/<key>/upload with an image file as the body (curl --data-binary
 * @file.png): the image goes straight to the user's Kurviq tab (nothing is
 * stored here), which answers with its fileId. The agent then adds
 * { "type": "image", "fileId": "…" } to a scene. The image's bytes never
 * pass through the model.
 */
const handleUpload = async (request: Request, env: Env, key: string) => {
  const answer = (status: number, body: unknown) =>
    withCors(new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } }));
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (!KEY_RE.test(key)) {
    return answer(404, { error: "Unknown agent link" });
  }
  if (request.method !== "POST") {
    return answer(405, { error: "POST the image file as the request body: curl --data-binary @image.png <this URL>" });
  }
  if (Number(request.headers.get("Content-Length") || 0) > MAX_UPLOAD_BYTES) {
    return answer(413, { error: `At most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per image (use JPEG or WebP for photos)` });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    return answer(bytes.length ? 413 : 400, {
      error: bytes.length ? `At most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per image` : "Empty body: send the image file as the request body (curl --data-binary @image.png)",
    });
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const id = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const first = bytes.find((byte) => byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09);
  if (first === 0x7b || first === 0x5b) {
    return uploadPayload(request, env, key, id, bytes, answer);
  }
  const mimeType = imageType(bytes);
  if (!mimeType) {
    return answer(415, { error: "Not an image (PNG, JPEG, GIF, WebP or SVG) and not an edit (JSON)" });
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const stub = await pairingStub(env, key);
  const res = await stub.fetch(
    new Request("https://pairing/api/app/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kurviq-App": new URL(request.url).origin },
      body: JSON.stringify({ type: "upload", file: { id, mimeType, dataURL: `data:${mimeType};base64,${btoa(binary)}` } }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as { result?: { fileId: string; width: number; height: number }; error?: string };
  if (!res.ok || !body.result) {
    return answer(res.status >= 400 ? res.status : 502, {
      error: body.error || "The Kurviq tab did not take the image. Is Kurviq open in the browser this agent link was made in?",
    });
  }
  const { fileId, width, height } = body.result;
  return answer(200, {
    fileId,
    mimeType,
    width,
    height,
    use: `Add it with edit_scene (or save_scene): { "type": "image", "id": "<your id>", "x": 0, "y": 0, "width": ${Math.min(width, 1200)}, "fileId": "${fileId}" } (width or height alone keeps the aspect ratio).`,
  });
};

/** big edits an agent uploads instead of pasting them into a tool call */
const MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * POST /mcp/<key>/upload with a JSON body ({ "add": [...], "update": [...],
 * "delete": [...] } or an array of elements to add): kept by the user's tab
 * until edit_scene / save_scene names it as payloadId.
 */
const uploadPayload = async (
  request: Request,
  env: Env,
  key: string,
  id: string,
  bytes: Uint8Array,
  answer: (status: number, body: unknown) => Response,
) => {
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    return answer(413, { error: `An edit payload may be at most ${MAX_PAYLOAD_BYTES / 1_000_000} MB: split it into several edits` });
  }
  const stub = await pairingStub(env, key);
  const res = await stub.fetch(
    new Request("https://pairing/api/app/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kurviq-App": new URL(request.url).origin },
      body: JSON.stringify({ type: "upload-payload", payload: { id, json: new TextDecoder().decode(bytes) } }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown>; error?: string };
  if (!res.ok || !body.result) {
    return answer(res.status >= 400 ? res.status : 502, {
      error: body.error || "The Kurviq tab did not take the edit. Is Kurviq open in the browser this agent link was made in?",
    });
  }
  return answer(200, {
    ...body.result,
    use: `Apply it with edit_scene(name, payloadId: "${id}") (or save_scene(name, payloadId: "${id}") for a new scene); add basedOn, upsert, view etc. as usual.`,
  });
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
    // scenes full of images: read without their bytes (CPU budget), the tab fills them in for pictures
    leanReads: true,
    // no access to the agent's files here: images and big edits are uploaded
    localFiles: false,
    uploadUrl: `${app}/mcp/${key}/upload`,
    skill: kurviqSkill(app, `${app}/mcp/${key}/upload`),
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

    const upload = url.pathname.match(/^\/mcp\/([^/]+)\/upload\/?$/);
    if (upload) {
      return handleUpload(request, env, upload[1]);
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
