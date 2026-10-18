#!/usr/bin/env node
/**
 * Excalidraw scenes MCP server (stdio).
 *
 * = the upstream excalidraw-mcp server (read_me, create_view, …) unchanged,
 *   plus tools to manage git-backed scenes of the local Excalidraw app
 *   (list/get/save/open/rename/delete/clone, co-working on the open scene, …).
 *
 * Stateless: drafts (create_view checkpoints) and agent baselines are kept by
 * the app in the browser; scenes live in the browser and on GitHub.
 *
 * Talks to the scenes server (../scenes-server) over HTTP. Commands that
 * touch the editor (open/convert/save open scene) are relayed by the scenes
 * server to the Excalidraw tab open in the browser.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../excalidraw-mcp/dist/server.js";

import { convertInNode, needsConversion } from "./convert.mjs";
import { byIds, commonBounds, diffElements, inRegion, summarize, toRect } from "./inspect.mjs";

/** get_scene returns an overview instead of all elements above this size */
const SUMMARY_THRESHOLD = 250;

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

const SERVER_URL = (readEnv().SCENES_SERVER_URL || "http://localhost:3101").replace(/\/$/, "");

// -----------------------------------------------------------------------------
// checkpoint store — create_view checkpoints (agent drafts) live in the
// browser (IndexedDB of the app, or of the throwaway headless renderer when
// no tab is open). This process and the scenes server keep no data at all.
// -----------------------------------------------------------------------------

const checkCheckpointId = (id) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error("Invalid checkpoint id");
  }
};

const store = {
  async save(id, data) {
    checkCheckpointId(id);
    await appCommand({ type: "checkpoint-save", id, data });
  },
  async load(id) {
    checkCheckpointId(id);
    return (await appCommand({ type: "checkpoint-load", id })).data ?? null;
  },
};

const newCheckpointId = () =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 18);

// -----------------------------------------------------------------------------
// scenes server client
// -----------------------------------------------------------------------------

const call = async (pathname, init = {}) => {
  let res;
  try {
    res = await fetch(`${SERVER_URL}${pathname}`, init);
  } catch {
    throw new Error(
      `Scenes server not reachable at ${SERVER_URL}. Start it with \`npm run start\` in ${WORKSPACE}.`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {}
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return text;
};

const callJson = async (pathname, init) => JSON.parse(await call(pathname, init));

const appCommand = (command) =>
  callJson("/api/app/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }).then((res) => res.result);

const sceneUrl = (name) => `/api/scenes/${encodeURIComponent(name)}`;

const loadSceneFile = async (name) => {
  try {
    return JSON.parse(await call(sceneUrl(name)));
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
};

// -----------------------------------------------------------------------------
// elements
// -----------------------------------------------------------------------------

const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

/** resolve create_view-style input (restoreCheckpoint / delete pseudo elements) */
const resolveElements = async (input) => {
  const restore = input.find((el) => el.type === "restoreCheckpoint");
  let base = [];
  if (restore?.id) {
    const checkpoint = await store.load(restore.id);
    if (!checkpoint) {
      throw new Error(`Checkpoint "${restore.id}" not found`);
    }
    base = checkpoint.elements;
  }
  const deleteIds = new Set();
  for (const el of input) {
    if (el.type === "delete") {
      for (const id of String(el.ids ?? el.id).split(",")) {
        deleteIds.add(id.trim());
      }
    }
  }
  return [...base, ...input].filter(
    (el) =>
      !PSEUDO_TYPES.has(el.type) &&
      !deleteIds.has(el.id) &&
      !deleteIds.has(el.containerId),
  );
};

const toSceneElements = async (elements) => {
  if (!elements.some(needsConversion)) {
    return { elements, convertedBy: "none" };
  }
  try {
    const result = await appCommand({ type: "convert", elements });
    return { elements: result.elements, convertedBy: "browser" };
  } catch (error) {
    if (error.status !== 409 && error.status !== 504) {
      throw error;
    }
    return { elements: convertInNode(elements), convertedBy: "node (estimated text sizes)" };
  }
};

/** compact form for the model: drop noise fields and defaults */
const compact = (elements) =>
  elements.map((el) => {
    const out = {};
    for (const [key, value] of Object.entries(el)) {
      if (
        ["seed", "version", "versionNonce", "updated", "isDeleted", "index", "lineHeight", "originalText", "autoResize", "baseline"].includes(key) ||
        value === null ||
        (Array.isArray(value) && value.length === 0) ||
        (key === "angle" && value === 0) ||
        (key === "opacity" && value === 100) ||
        (key === "locked" && value === false) ||
        (key === "strokeColor" && value === "#1e1e1e") ||
        (key === "backgroundColor" && value === "transparent") ||
        (key === "fillStyle" && value === "solid") ||
        (key === "strokeWidth" && value === 2) ||
        (key === "strokeStyle" && value === "solid") ||
        (key === "roughness" && value === 1)
      ) {
        continue;
      }
      out[key] = typeof value === "number" ? Math.round(value * 100) / 100 : value;
    }
    return out;
  });

// -----------------------------------------------------------------------------
// tools
// -----------------------------------------------------------------------------

const text = (value) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (error) {
    return { ...text(`Error: ${error.message}`), isError: true };
  }
};

const SCENE_NAME = z
  .string()
  .describe("Scene name: letters, numbers, spaces and _ . ( ) - (max 100 chars). Stored as scenes/<name>.excalidraw in the git repo.");

const registerSceneTools = (server) => {
  server.registerTool(
    "list_scenes",
    {
      description:
        "List the scenes in the git-backed scene repo (pulls first), plus which scene is currently open in the user's Excalidraw app and whether it has uncommitted changes.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { scenes } = await callJson("/api/scenes?refresh");
      const app = await callJson("/api/app/state");
      return text({ scenes, app });
    }),
  );

  const REGION = z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .describe("Scene-coordinate rectangle");

  server.registerTool(
    "get_scene",
    {
      description: `Read a scene as stored on GitHub (the user's browser may have newer, not yet pushed changes — list_scenes / app_status show the sync status; for the scene open in the app use read_open_scene). Scenes can be huge, so:
- summary=true (default for scenes with more than ${SUMMARY_THRESHOLD} elements): overview only — scene bounds, element counts, frames and all text labels with their positions. Use it to find the part you need.
- region or elementIds: only the elements in that area / those elements (+ their labels).
- otherwise all elements (compact).
Always returns a checkpointId of the FULL scene. To modify the scene, call create_view with [{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...new elements / {"type":"delete","ids":"..."}] and then save_scene with the checkpointId create_view returns. To LOOK at a scene, use view_scene.`,
      inputSchema: {
        name: SCENE_NAME,
        summary: z.boolean().optional().describe("Return an overview instead of elements"),
        region: REGION.optional(),
        elementIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ name, summary, region, elementIds }) => {
      const file = await loadSceneFile(name);
      if (!file) {
        throw new Error(`Scene "${name}" not found`);
      }
      const elements = (file.elements || []).filter((el) => !el.isDeleted);
      const checkpointId = newCheckpointId();
      await store.save(checkpointId, { elements });
      const base = { name, checkpointId, elementCount: elements.length };

      if (elementIds?.length || region) {
        const picked = elementIds?.length ? byIds(elements, elementIds) : inRegion(elements, region);
        return text({ ...base, selected: picked.length, bounds: toRect(commonBounds(picked)), elements: compact(picked) });
      }
      if (summary ?? elements.length > SUMMARY_THRESHOLD) {
        return text({
          ...base,
          note: "Overview only. Use region/elementIds for element data, view_scene to see it.",
          ...summarize(elements),
        });
      }
      return text({ ...base, sceneBounds: toRect(commonBounds(elements)), elements: compact(elements) });
    }),
  );

  // ---------------------------------------------------------------------------
  // co-working on the scene open in the user's app
  // ---------------------------------------------------------------------------

  /** element data for a (possibly huge) scene, honoring summary/region/elementIds */
  const sceneView = (elements, { summary, region, elementIds }, defaultSummary) => {
    if (elementIds?.length || region) {
      const picked = elementIds?.length ? byIds(elements, elementIds) : inRegion(elements, region);
      return { selected: picked.length, bounds: toRect(commonBounds(picked)), elements: compact(picked) };
    }
    if (summary ?? defaultSummary) {
      return summarize(elements);
    }
    return { sceneBounds: toRect(commonBounds(elements)), elements: compact(elements) };
  };

  /** render via the app (or the hidden renderer) → MCP image content */
  const renderImage = async (command) => {
    const { png, ...meta } = await appCommand({ type: "render", ...command });
    return { image: { type: "image", data: png, mimeType: "image/png" }, meta };
  };

  /** best-effort picture of some elements of the open scene */
  const imageOfOpen = async (elementIds, targetScene) => {
    if (!elementIds.length) {
      return [];
    }
    try {
      const { image, meta } = await renderImage({
        elementIds,
        maxSize: 1200,
        ...(targetScene !== undefined ? { targetScene } : {}),
      });
      return [image, { type: "text", text: `Image above: the affected area (${meta.elementsRendered} elements, bounds ${JSON.stringify(meta.renderedBounds)}).` }];
    } catch (error) {
      return [{ type: "text", text: `(could not render image: ${error.message})` }];
    }
  };


  const sceneLabel = (scene) => scene ?? "Untitled (not saved yet)";

  /** diff → compact report of what changed */
  const describeChanges = (before, after, sinceText) => {
    const { added, modified, deleted } = diffElements(before, after);
    const changedIds = [...added, ...modified.map((m) => m.element)].map((el) => el.id);
    const count = added.length + modified.length + deleted.length;
    return {
      count,
      changedIds,
      report: {
        summary: count
          ? `${added.length} added, ${modified.length} modified, ${deleted.length} deleted ${sinceText}`
          : `No changes ${sinceText}`,
        ...(added.length ? { added: compact(added) } : {}),
        ...(modified.length
          ? {
              modified: modified.map(({ element, changedFields }) => ({
                changedFields,
                ...compact([element])[0],
              })),
            }
          : {}),
        ...(deleted.length ? { deleted } : {}),
      },
    };
  };

  /**
   * User changes on the open scene since an agent last read/edited it. The
   * baseline is kept per scene by the app in the browser (IndexedDB) and comes
   * back with the read command (withBaseline).
   */
  const userChangesSinceAgent = (baseline, elements) => {
    if (!baseline) {
      return { count: 0, changedIds: [], report: null, firstLook: true };
    }
    const when = `since an agent last ${baseline.action === "edit" ? "edited" : baseline.action === "save" ? "saved" : "read"} this scene (${baseline.at})`;
    return {
      ...describeChanges(baseline.elements, elements, `by the user (or pulled from GitHub) ${when}`),
      firstLook: false,
    };
  };

  server.registerTool(
    "read_open_scene",
    {
      description: `Read the scene the user has open in the Excalidraw app RIGHT NOW, including their unsaved manual edits — and find out what the USER changed since an agent last looked.
Automatic change tracking: the app remembers (per scene, in the browser) what the canvas looked like after the last read_open_scene / edit_open_scene by any agent. Every call reports "userChanges" relative to that (added / modified with changedFields / deleted) and then moves the baseline to now. You don't need to remember anything — just call this before you edit, and it tells you what the user did in the meantime. With view=true you also get an IMAGE of the user's changes (or of the scene if nothing changed / first look).
Scene data: summary=true (default above ${SUMMARY_THRESHOLD} elements) gives an overview (bounds, counts, frames, all text labels with positions); region / elementIds give element data for a part; otherwise all elements. changesOnly=true skips the scene data.
since=<revision> (optional, advanced) diffs against a specific revision instead of the stored baseline.`,
      inputSchema: {
        scene: z
          .string()
          .optional()
          .describe("Read this scene, if it is open in one of the user's tabs (default: the tab the user used last). Pass it when you keep co-working on a scene."),
        view: z.boolean().optional().describe("Also return an IMAGE: of the user's changes, or of the scene"),
        changesOnly: z.boolean().optional().describe("Only report the user's changes, no scene data"),
        summary: z.boolean().optional(),
        region: REGION.optional(),
        elementIds: z.array(z.string()).optional(),
        since: z.string().optional().describe("Advanced: diff against this revision instead of the stored baseline"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ scene, since, view, changesOnly, summary, region, elementIds }) => {
      const revision = newCheckpointId();
      const open = await appCommand({
        type: "read",
        ...(scene ? { targetScene: scene } : {}),
        withBaseline: !since,
        storeBaseline: "read",
        revision,
      });
      if (scene && open.scene !== scene) {
        // (the app stored nothing for the other scene)
        throw new Error(
          `"${scene}" is not open in any tab — the user's app shows ${sceneLabel(open.scene)}. Ask the user, or open_scene("${scene}").`,
        );
      }
      const elements = open.elements;

      let changes;
      if (since) {
        const previous = await store.load(since);
        if (!previous) {
          throw new Error(`Revision "${since}" not found (expired?) — call without since`);
        }
        changes = { ...describeChanges(previous.elements, elements, `since revision ${since}`), firstLook: false };
      } else {
        changes = userChangesSinceAgent(open.agentBaseline, elements);
      }

      const result = text({
        scene: sceneLabel(open.scene),
        unsavedChanges: open.dirty,
        elementCount: elements.length,
        userChanges: changes.firstLook
          ? "First time an agent reads this scene — no earlier baseline to compare with. From now on, changes by the user will be reported."
          : changes.report,
        revision,
        ...(changesOnly ? {} : sceneView(elements, { summary, region, elementIds }, elements.length > SUMMARY_THRESHOLD)),
      });
      if (view) {
        if (changes.changedIds.length) {
          result.content.push(...(await imageOfOpen(changes.changedIds, open.scene)));
        } else if (elements.length) {
          try {
            const { image, meta } = await renderImage({
              targetScene: open.scene,
              ...(region ? { region } : {}),
              ...(elementIds?.length ? { elementIds } : {}),
            });
            result.content.push(image, {
              type: "text",
              text: `Image above: the scene (${meta.elementsRendered}/${meta.elementsTotal} elements, scale ${meta.scale}).`,
            });
          } catch (error) {
            result.content.push({ type: "text", text: `(could not render image: ${error.message})` });
          }
        }
      }
      return result;
    }),
  );

  server.registerTool(
    "edit_open_scene",
    {
      description: `Edit the scene open in the user's app, live and in place — merged with the user's own work (never overwrites their other changes) and undoable by the user as one step (Cmd/Ctrl+Z). This is THE way to co-work on a drawing with the user; it does not push to GitHub (auto-sync does that, or save_open_scene).
Safety net: before applying, it checks whether the USER changed the scene since an agent last read/edited it. If so, your edit is still applied, but the result starts with a WARNING listing the user's changes (plus an image of them) — look at them and adjust if your edit conflicts with what the user did. Calling read_open_scene first avoids surprises.
- add: JSON array string of new elements in create_view format (labels, startBinding/endBinding — arrows may bind to existing elements). Use new unique ids.
- update: [{ "id": "...", ...props }] partial updates of existing elements, e.g. move (x, y), resize, recolor, change "text" of a text element (labels are text elements with containerId).
- delete: ids to remove (a container's label goes with it).
- To label an EXISTING shape, add a text element with "containerId": "<shape id>" (it gets centered in the shape).
Returns an IMAGE of the edited area (view=false to skip). Nothing is applied if the user switched to another scene since your last read (or pass expectScene explicitly).`,
      inputSchema: {
        add: z.string().optional().describe("JSON array string of new elements (create_view format)"),
        update: z
          .array(z.object({ id: z.string() }).passthrough())
          .optional()
          .describe("Partial updates: [{ id, ...props }]"),
        delete: z.array(z.string()).optional(),
        expectScene: z
          .string()
          .optional()
          .describe("The scene you are co-working on (as returned by read_open_scene) — routes the edit to the tab showing it; nothing is applied if no tab shows it"),
        view: z.boolean().optional().describe("Return an IMAGE of the edited area (default true)"),
      },
    },
    tool(async ({ add, update, delete: remove, expectScene, view = true }) => {
      let addElements;
      if (add) {
        addElements = JSON.parse(add);
        if (!Array.isArray(addElements)) {
          throw new Error("add must be a JSON array");
        }
        addElements = addElements.filter((el) => !PSEUDO_TYPES.has(el.type));
      }
      if (!addElements?.length && !update?.length && !remove?.length) {
        throw new Error("Nothing to do: pass add, update and/or delete");
      }

      // what did the user do since an agent last looked?
      const before = await appCommand({
        type: "read",
        ...(expectScene !== undefined ? { targetScene: expectScene } : {}),
        withBaseline: true,
      });
      const changes = userChangesSinceAgent(before.agentBaseline, before.elements);
      const revision = newCheckpointId();

      const edited = await appCommand({
        type: "edit",
        targetScene: before.scene,
        expectScene: expectScene !== undefined ? expectScene : before.scene,
        ...(addElements?.length ? { add: addElements } : {}),
        ...(update?.length ? { update } : {}),
        ...(remove?.length ? { delete: remove } : {}),
        storeBaseline: "edit",
        revision,
      });
      const { elements, agentBaseline: _previous, ...info } = edited;

      const warning = changes.firstLook
        ? "You edited without reading this scene first (no earlier agent baseline). Call read_open_scene before editing next time."
        : changes.count
        ? `WARNING: the user changed this scene since an agent last looked (${changes.report.summary}). Your edit was applied and merged — check the user's changes below and fix your edit if it conflicts with them.`
        : null;

      const result = text({
        ...(warning ? { warning } : {}),
        ...(changes.count ? { userChanges: changes.report } : {}),
        scene: sceneLabel(info.scene),
        addedIds: info.addedIds,
        updated: info.updated,
        deleted: info.deleted,
        ...(info.missingIds ? { missingIds: info.missingIds } : {}),
        revision,
        note:
          info.scene === null
            ? "Live in the user's app. The scene is untitled — it reaches GitHub once it gets a name (save_open_scene with name)."
            : info.autoSync
            ? "Live in the user's app, not pushed yet — the app's auto-sync pushes it after 30s without edits (save_open_scene pushes now)."
            : "Live in the user's app. Auto-sync is OFF for this scene — it is only pushed when the user saves or you call save_open_scene.",
      });
      if (view) {
        result.content.push(...(await imageOfOpen([...info.addedIds, ...info.updated], info.scene)));
        if (changes.count) {
          const userIds = changes.changedIds.filter((id) => elements.some((el) => el.id === id));
          if (userIds.length) {
            result.content.push({ type: "text", text: "Next image: what the USER changed since an agent last looked." });
            result.content.push(...(await imageOfOpen(userIds, info.scene)));
          }
        }
      }
      return result;
    }),
  );

  server.registerTool(
    "view_scene",
    {
      description: `SEE a scene: returns an actual PNG image of it, rendered by Excalidraw itself (no browser automation needed — uses the open app tab or a hidden headless renderer).
Source (pick one): name = scene in the repo; checkpointId = a create_view/get_scene checkpoint (e.g. to check your drawing before saving); neither = the scene currently open in the user's app, including unsaved edits.
Focus (optional): elementIds = just those elements (+padding, + whatever overlaps that area) — ideal to check the part you worked on; region = a scene-coordinate rectangle. Without focus the whole scene is rendered; for huge scenes render an overview first (get_scene summary=true tells you where things are), then zoom in with region.
The result also reports renderedBounds/sceneBounds (scene coordinates) and the scale.`,
      inputSchema: {
        name: SCENE_NAME.optional(),
        checkpointId: z.string().optional(),
        elementIds: z.array(z.string()).optional(),
        region: REGION.optional(),
        padding: z.number().optional().describe("Margin around elementIds in scene px (default 80)"),
        maxSize: z.number().optional().describe("Longest side of the image in px (default 1500, max 4000)"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ name, checkpointId, elementIds, region, padding, maxSize }) => {
      let scene;
      let source;
      if (checkpointId) {
        const checkpoint = await store.load(checkpointId);
        if (!checkpoint) {
          throw new Error(`Checkpoint "${checkpointId}" not found`);
        }
        scene = { elements: checkpoint.elements.filter((el) => !PSEUDO_TYPES.has(el.type)) };
        source = `checkpoint ${checkpointId}`;
      } else if (name) {
        const file = await loadSceneFile(name);
        if (!file) {
          throw new Error(`Scene "${name}" not found`);
        }
        scene = { elements: file.elements || [], files: file.files || {}, appState: file.appState || {} };
        source = `scene "${name}" (repo)`;
      } else {
        const state = await callJson("/api/app/state");
        if (!state.connected) {
          throw new Error("No scene name given and the app is not open — pass name or checkpointId");
        }
        source = `open scene in the app: ${state.current === null ? "Untitled" : `"${state.current}"`}${state.dirty ? " (unsaved edits)" : ""}`;
      }
      const { image, meta } = await renderImage({
        ...(scene ? { scene } : {}),
        ...(elementIds?.length ? { elementIds } : {}),
        ...(region ? { region } : {}),
        ...(padding !== undefined ? { padding } : {}),
        ...(maxSize !== undefined ? { maxSize } : {}),
      });
      return {
        content: [image, { type: "text", text: JSON.stringify({ source, ...meta }, null, 2) }],
      };
    }),
  );

  server.registerTool(
    "save_scene",
    {
      description: `Save a drawing as a scene: writes scenes/<name>.excalidraw, commits and pushes it to the git repo. Creates the scene or overwrites it.
Provide EITHER checkpointId (from create_view or get_scene — the usual way: draw with create_view, then save its checkpoint) OR elements (same JSON format as create_view, incl. restoreCheckpoint/delete).
If the scene is open in the user's app without local changes, the app reloads it. Set open=true to also switch the app to this scene.
Note: while you draw, every create_view call is mirrored live into the user's app (scene "agent-live"), so the user can watch. Building a diagram in a few create_view steps (restoreCheckpoint + new elements) makes that nicer to watch.`,
      inputSchema: {
        name: SCENE_NAME,
        checkpointId: z.string().optional().describe("Checkpoint id returned by create_view / get_scene"),
        elements: z.string().optional().describe("JSON array string of elements (create_view format)"),
        open: z.boolean().optional().describe("Switch the user's Excalidraw app to this scene after saving"),
      },
    },
    tool(async ({ name, checkpointId, elements, open }) => {
      if (!checkpointId && !elements) {
        throw new Error("Provide checkpointId or elements");
      }
      let input = [];
      if (checkpointId) {
        input.push({ type: "restoreCheckpoint", id: checkpointId });
      }
      if (elements) {
        const parsed = JSON.parse(elements);
        if (!Array.isArray(parsed)) {
          throw new Error("elements must be a JSON array");
        }
        input = parsed.some((el) => el.type === "restoreCheckpoint") ? parsed : [...input, ...parsed];
      }
      const resolved = await resolveElements(input);
      const { elements: sceneElements, convertedBy } = await toSceneElements(resolved);

      const existing = await loadSceneFile(name);
      const fileIds = new Set(sceneElements.map((el) => el.fileId).filter(Boolean));
      const files = Object.fromEntries(
        Object.entries(existing?.files || {}).filter(([id]) => fileIds.has(id)),
      );
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "excalidraw-scenes-mcp",
        elements: sceneElements,
        appState: existing?.appState || { viewBackgroundColor: "#ffffff", gridSize: 20 },
        files,
      };
      const result = await callJson(sceneUrl(name), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent" },
        body: JSON.stringify(scene, null, 2),
      });
      let app = null;
      if (open) {
        app = await appCommand({ type: "open", name });
        // the agent knows this content — later user edits are reported relative to it
        await appCommand({ type: "read", targetScene: name, storeBaseline: "save" }).catch(() => null);
      }
      // checkpoint of the saved state, for further edits
      const savedCheckpointId = newCheckpointId();
      await store.save(savedCheckpointId, { elements: sceneElements });
      return text({
        saved: name,
        created: !existing,
        commit: result.commit,
        changed: result.changed,
        elementCount: sceneElements.length,
        convertedBy,
        checkpointId: savedCheckpointId,
        ...(app ? { app } : {}),
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // rename / delete / clone — through the app when it is open (keeps its
  // local copies, unpushed changes and agent baselines consistent and works
  // offline), else directly on GitHub
  // ---------------------------------------------------------------------------

  const appConnected = async () => (await callJson("/api/app/state")).connected;

  const viaGitHubNote =
    "The app is not open in a browser, so this was done on GitHub directly — the app picks it up on its next sync.";

  server.registerTool(
    "rename_scene",
    {
      description: `Rename a scene — in the user's app (its local copy incl. unpushed changes moves along, the URL follows if it is open) and on GitHub (one commit, history kept). Works offline: GitHub follows when reachable. Fails if newName exists.`,
      inputSchema: { name: SCENE_NAME, newName: SCENE_NAME },
    },
    tool(async ({ name, newName }) => {
      if (await appConnected()) {
        return text(await appCommand({ type: "rename", name, to: newName }));
      }
      const result = await callJson(`${sceneUrl(name)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent" },
        body: JSON.stringify({ to: newName }),
      });
      return text({ renamed: name, to: newName, commit: result.commit, note: viaGitHubNote });
    }),
  );

  server.registerTool(
    "delete_scene",
    {
      description: `Delete a scene — in the user's app (incl. its local changes; if it is open, the app switches to an empty untitled scene) and on GitHub (one commit; it stays in the git history). Only delete when the user asked for it, and name the scene exactly.`,
      inputSchema: { name: SCENE_NAME },
      annotations: { destructiveHint: true },
    },
    tool(async ({ name }) => {
      if (await appConnected()) {
        return text(await appCommand({ type: "delete", name }));
      }
      const result = await callJson(sceneUrl(name), {
        method: "DELETE",
        headers: { "X-Scenes-Source": "agent" },
      });
      return text({ deleted: name, commit: result.commit, note: viaGitHubNote });
    }),
  );

  server.registerTool(
    "clone_scene",
    {
      description: `Duplicate a scene under a new name (incl. the user's unpushed changes when the app is open). The copy is pushed by the app's auto-sync like any new scene. open=true switches the user's app to the copy — do that only when the user wants to continue in the copy.`,
      inputSchema: {
        name: SCENE_NAME,
        newName: SCENE_NAME,
        open: z.boolean().optional().describe("Switch the user's app to the copy (default false)"),
      },
    },
    tool(async ({ name, newName, open }) => {
      if (await appConnected()) {
        return text(await appCommand({ type: "clone", name, to: newName, open: !!open }));
      }
      const file = await loadSceneFile(name);
      if (!file) {
        throw new Error(`Scene "${name}" not found`);
      }
      const result = await callJson(sceneUrl(newName), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent", "X-Base-Sha": "none" },
        body: JSON.stringify({ ...file, appState: { ...(file.appState || {}), name: newName } }, null, 2),
      });
      return text({ cloned: name, to: newName, commit: result.commit, note: viaGitHubNote });
    }),
  );

  server.registerTool(
    "open_scene",
    {
      description:
        "Switch the user's Excalidraw app (open in the browser) to a scene. Unsaved changes of the previous scene are kept locally in the browser. Set create=true to create a new empty scene with that name instead.",
      inputSchema: {
        name: SCENE_NAME,
        create: z.boolean().optional().describe("Create a new empty, uncommitted scene"),
      },
    },
    tool(async ({ name, create }) =>
      text(await appCommand({ type: create ? "create" : "open", name })),
    ),
  );

  server.registerTool(
    "app_status",
    {
      description:
        "Which scene is open in the user's Excalidraw app, whether it has uncommitted changes, and the scenes the app knows about (incl. local-only ones).",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const state = await callJson("/api/app/state");
      if (!state.connected) {
        return text({ connected: false, message: "The Excalidraw app is not open in a browser." });
      }
      return text({ connected: true, ...(await appCommand({ type: "status" })) });
    }),
  );

  server.registerTool(
    "save_open_scene",
    {
      description:
        "Commit & push the scene currently open in the user's Excalidraw app, including the user's manual edits. Pass name to name an untitled scene or to save it under a new name.",
      inputSchema: { name: SCENE_NAME.optional() },
    },
    tool(async ({ name }) => text(await appCommand({ type: "save", ...(name ? { name } : {}) }))),
  );
};

/**
 * Store handed to the upstream tools: every create_view (and widget edit)
 * saves a checkpoint — mirror it into the open app so the user can watch the
 * agent draw. Fire-and-forget: never slows down or fails the drawing.
 */
const previewingStore = {
  load: store.load,
  async save(id, data) {
    await store.save(id, data);
    if (process.env.SCENES_LIVE_PREVIEW !== "false") {
      appCommand({ type: "preview", elements: data.elements }).catch(() => {});
    }
  },
};

/** the skill doubles as the server's instructions (shown to agents by MCP clients) */
const INSTRUCTIONS = readFileSync(
  path.join(HERE, "skill", "excalidraw-scenes", "SKILL.md"),
  "utf8",
).replace(/^---[\s\S]*?---\s*/, "");

const server = new McpServer(
  { name: "Excalidraw", version: "1.0.0" },
  { instructions: INSTRUCTIONS },
);
registerTools(server, path.join(WORKSPACE, "excalidraw-mcp", "dist"), previewingStore);
registerSceneTools(server);
await server.connect(new StdioServerTransport());
