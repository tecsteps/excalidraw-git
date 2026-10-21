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
 * Talks to the scenes server (../scenes-server) over HTTP. By default
 * (SCENES_AGENT_MODE=detached) the agent works in its own headless
 * Excalidraw tab that the scenes server starts: reads/edits/renders happen
 * there and edits are committed to GitHub; the user's browser only syncs
 * (it is asked to push a scene before the agent reads it). In live mode the
 * agent works in the user's open tab instead.
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
import { readEditFile, resolveImages } from "./media.mjs";

/** get_scene returns an overview instead of all elements above this size */
const SUMMARY_THRESHOLD = 150;
/** element data returned for a region / elementIds selection at most */
const MAX_SELECTED = 150;
/** changed elements reported in detail per kind (the rest: ids only) */
const MAX_CHANGE_DETAILS = 25;

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

const APP_HINT = (readEnv().SCENES_APP_URL || "http://localhost:3001").replace(/\/$/, "");
/**
 * detached (default): the agent works in its own headless Excalidraw against
 * GitHub; the user's browser only syncs. live: the agent edits the user's
 * open canvas directly (co-working in the same tab).
 */
const MODE = readEnv().SCENES_AGENT_MODE === "live" ? "live" : "detached";
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
    await agentCommand({ type: "checkpoint-save", id, data });
  },
  async load(id) {
    checkCheckpointId(id);
    return (await agentCommand({ type: "checkpoint-load", id })).data ?? null;
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

/** the agent's own work (render, convert, drafts): its headless tab in detached mode */
const agentCommand = (command) =>
  appCommand(MODE === "detached" ? { ...command, agentSide: true } : command);

/** ask the user's tabs to push their unpushed changes of a scene (sync only) */
const flushUser = async (name) => {
  try {
    return await callJson("/api/app/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    return null;
  }
};

const sceneUrl = (name) => `/api/scenes/${encodeURIComponent(name)}`;

/** a scene on GitHub plus its blob sha (null if it doesn't exist) */
const loadSceneWithSha = async (name) => {
  const res = await fetch(`${SERVER_URL}${sceneUrl(name)}`).catch(() => {
    throw new Error(`Scenes server not reachable at ${SERVER_URL}. Start it with \`npm run start\` in ${WORKSPACE}.`);
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return { file: await res.json(), sha: res.headers.get("x-scene-sha") };
};

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

/**
 * Local-only scenes exist only in the user's browser (never on GitHub): the
 * flush answer says so, and they are then read and edited through the
 * user's app.
 */
const isLocalOnly = (flushed) => (flushed?.results || []).some((r) => r && r.localOnly);

const LOCAL_NOTE =
  "Local-only scene: it exists only in the user's browser and is never synced to GitHub (the user decides if it ever is). You read and edit it through their app, which must be open.";

const loadLocalScene = (name, since) =>
  appCommand({ type: "local-read", name, targetScene: name, ...(since ? { since } : {}) });

/** a scene's content: from the user's browser if it is local-only, else from GitHub */
const loadAnyScene = async (name) => {
  const flushed = await flushUser(name);
  if (isLocalOnly(flushed)) {
    return { local: true, file: (await loadLocalScene(name)).file };
  }
  return { local: false, file: await loadSceneFile(name) };
};

const notFound = (name) =>
  new Error(
    `Scene "${name}" not found on GitHub. list_scenes shows what exists. (Local-only scenes live in the user's browser: they are only reachable while the app is open.)`,
  );

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
    const result = await agentCommand({ type: "convert", elements });
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

const TEXTS_OFFSET = z
  .number()
  .optional()
  .describe("Overview: the labels are paged (100 per call); pass the offset the previous answer names to get the next ones");

/** element data for a region / elementIds selection, capped */
const selection = (elements, { region, elementIds }) => {
  const picked = elementIds?.length ? byIds(elements, elementIds) : inRegion(elements, region);
  return {
    selected: picked.length,
    bounds: toRect(commonBounds(picked)),
    elements: compact(picked.slice(0, MAX_SELECTED)),
    ...(picked.length > MAX_SELECTED
      ? { more: `${picked.length - MAX_SELECTED} more elements in this selection: use a smaller region or elementIds` }
      : {}),
  };
};

/**
 * add / update / delete of an edit, from the arguments and/or a JSON file;
 * image elements (src / svg / icon) become image elements + files
 */
const editInput = async ({ add, update, delete: remove, file }) => {
  const fromFile = file ? await readEditFile(file) : {};
  let addElements = [];
  for (const source of [add, fromFile.add]) {
    if (!source) {
      continue;
    }
    const parsed = typeof source === "string" ? JSON.parse(source) : source;
    if (!Array.isArray(parsed)) {
      throw new Error("add must be a JSON array");
    }
    addElements.push(...parsed);
  }
  addElements = addElements.filter((el) => !PSEUDO_TYPES.has(el.type));
  const { elements, files } = await resolveImages(addElements);
  const updates = [...(update || []), ...(fromFile.update || [])];
  const deletes = [...(remove || []), ...(fromFile.delete || [])];
  if (!elements.length && !updates.length && !deletes.length) {
    throw new Error("Nothing to do: pass add, update and/or delete (or a file with them)");
  }
  return { add: elements, update: updates, delete: deletes, files };
};

const EDIT_FILE = z
  .string()
  .optional()
  .describe('Absolute path of a JSON file with { "add": [...], "update": [...], "delete": [...] } (or just an array = add). Use it for big edits instead of pasting JSON.');

const IMAGES_HELP = `Images and icons: add { "type": "image", "id": "...", "x": 0, "y": 0, "width": 48, plus ONE of "src" (absolute file path, http(s) URL or data URL of a png/jpg/gif/webp/svg), "svg" (inline SVG markup) or "icon" ("lucide:<name>", e.g. "lucide:database", or "simple-icons:<slug>", e.g. "simple-icons:github"; "color" tints it) }. width or height alone keeps the aspect ratio.
Labels: label { text, strokeColor, fontSize, fontFamily, textAlign, verticalAlign } — the text is dark (#1e1e1e) unless you set strokeColor; the label's id is "<shape id>-label"; a shape grows so that no word of its label is broken.`;

const registerSceneTools = (server) => {
  server.registerTool(
    "list_scenes",
    {
      description:
        "List the scenes in the git-backed scene repo (pulls first), the user's local-only scenes (only in their browser, never synced; listed while the app is open), plus which scene is currently open in the user's Excalidraw app and whether it has uncommitted changes.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { scenes } = await callJson("/api/scenes?refresh");
      const app = await callJson("/api/app/state");
      const status = app.connected ? await appCommand({ type: "status" }).catch(() => null) : null;
      const localOnly = (status?.scenes || [])
        .filter((line) => / local-only /.test(line))
        .map((line) => line.slice(0, line.indexOf(": local-only")));
      return text({
        scenes,
        ...(localOnly.length ? { localOnlyScenes: localOnly, localOnlyNote: LOCAL_NOTE } : {}),
        app,
      });
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
        textsOffset: TEXTS_OFFSET,
        region: REGION.optional(),
        elementIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ name, summary, region, elementIds, textsOffset }) => {
      const { file, local } = await loadAnyScene(name);
      if (!file) {
        throw notFound(name);
      }
      const elements = (file.elements || []).filter((el) => !el.isDeleted);
      const checkpointId = newCheckpointId();
      await store.save(checkpointId, { elements });
      const base = { name, checkpointId, elementCount: elements.length, ...(local ? { localOnly: LOCAL_NOTE } : {}) };

      if (elementIds?.length || region) {
        return text({ ...base, ...selection(elements, { region, elementIds }) });
      }
      if (summary ?? elements.length > SUMMARY_THRESHOLD) {
        return text({
          ...base,
          note: "Overview only. Use region/elementIds for element data, view_scene to see it.",
          ...summarize(elements, { textsOffset }),
        });
      }
      return text({ ...base, sceneBounds: toRect(commonBounds(elements)), elements: compact(elements) });
    }),
  );

  // ---------------------------------------------------------------------------
  // co-working on the scene open in the user's app
  // ---------------------------------------------------------------------------

  /** element data for a (possibly huge) scene, honoring summary/region/elementIds */
  const sceneView = (elements, { summary, region, elementIds, textsOffset }, defaultSummary) => {
    if (elementIds?.length || region) {
      return selection(elements, { region, elementIds });
    }
    if (summary ?? defaultSummary) {
      return summarize(elements, { textsOffset });
    }
    return { sceneBounds: toRect(commonBounds(elements)), elements: compact(elements) };
  };

  /** render via the app (or the hidden renderer) → MCP image content */
  const renderImage = async (command, { userTab = false } = {}) => {
    const { png, ...meta } = await (userTab ? appCommand : agentCommand)({ type: "render", ...command });
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

  /** how the open scene syncs — so agents leave pushing to the app */
  const syncNote = ({ scene, syncStatus, autoSync }) => {
    if (scene === null) {
      return "Untitled scene, not on GitHub. Only save it (save_open_scene with a name) if the user asks.";
    }
    if (syncStatus === "conflict") {
      return `CONFLICT: the user's version and GitHub's both changed the same elements. Nothing syncs until it is resolved — get_conflict("${scene}") shows the clashes, resolve_conflict settles them.`;
    }
    return autoSync
      ? `status: ${syncStatus}. Auto-sync is on: the app pushes changes (yours and the user's) to GitHub by itself about 30 s after the last edit. Don't push yourself.`
      : `status: ${syncStatus}. Auto-sync is OFF for this scene: the user decides when it goes to GitHub. Don't push unless the user asks.`;
  };

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
        ...(added.length ? { added: compact(added.slice(0, MAX_CHANGE_DETAILS)) } : {}),
        ...(modified.length
          ? {
              modified: modified.slice(0, MAX_CHANGE_DETAILS).map(({ element, changedFields }) => ({
                changedFields,
                ...compact([element])[0],
              })),
            }
          : {}),
        ...(deleted.length ? { deleted: deleted.slice(0, MAX_CHANGE_DETAILS) } : {}),
        ...(added.length > MAX_CHANGE_DETAILS || modified.length > MAX_CHANGE_DETAILS || deleted.length > MAX_CHANGE_DETAILS
          ? {
              moreChanges: {
                note: `Details for the first ${MAX_CHANGE_DETAILS} per kind; the rest by id (read them with elementIds).`,
                addedIds: added.slice(MAX_CHANGE_DETAILS).map((el) => el.id),
                modifiedIds: modified.slice(MAX_CHANGE_DETAILS).map(({ element }) => element.id),
                deletedIds: deleted.slice(MAX_CHANGE_DETAILS).map((el) => el.id),
              },
            }
          : {}),
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

  if (MODE === "live") {
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
          textsOffset: TEXTS_OFFSET,
          region: REGION.optional(),
          elementIds: z.array(z.string()).optional(),
          since: z.string().optional().describe("Advanced: diff against this revision instead of the stored baseline"),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ scene, since, view, changesOnly, summary, region, elementIds, textsOffset }) => {
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
          sync: syncNote(open),
          elementCount: elements.length,
          userChanges: changes.firstLook
            ? "First time an agent reads this scene — no earlier baseline to compare with. From now on, changes by the user will be reported."
            : changes.report,
          revision,
          ...(changesOnly ? {} : sceneView(elements, { summary, region, elementIds, textsOffset }, elements.length > SUMMARY_THRESHOLD)),
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
        description: `Edit the scene open in the user's app, live and in place — merged with the user's own work (never overwrites their other changes) and undoable by the user as one step (Cmd/Ctrl+Z). This is THE way to co-work on a drawing with the user, and to change any existing scene. It does not push to GitHub and you don't need to: the app's auto-sync pushes about 30 s after the last edit (save_open_scene only when the user asks to push now).
  Safety net: before applying, it checks whether the USER changed the scene since an agent last read/edited it. If so, your edit is still applied, but the result starts with a WARNING listing the user's changes (plus an image of them) — look at them and adjust if your edit conflicts with what the user did. Calling read_open_scene first avoids surprises.
  - add: JSON array string of new elements in create_view format (labels, startBinding/endBinding — arrows may bind to existing elements). Use new unique ids.
  - update: [{ "id": "...", ...props }] partial updates of existing elements, e.g. move (x, y), resize, recolor, change "text" of a text element (labels are text elements with containerId).
  - delete: ids to remove (a container's label goes with it).
  - To label an EXISTING shape, add a text element with "containerId": "<shape id>" (it gets centered in the shape).
  Big edits: put them in a JSON file and pass file (absolute path).
${IMAGES_HELP}
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
          file: EDIT_FILE,
          view: z.boolean().optional().describe("Return an IMAGE of the edited area (default true)"),
        },
      },
      tool(async ({ add, update, delete: remove, file, expectScene, view = true }) => {
        const edit = await editInput({ add, update, delete: remove, file });

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
          ...(edit.add.length ? { add: edit.add } : {}),
          ...(edit.update.length ? { update: edit.update } : {}),
          ...(edit.delete.length ? { delete: edit.delete } : {}),
          ...(Object.keys(edit.files).length ? { files: edit.files } : {}),
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
  }

  // ---------------------------------------------------------------------------
  // detached mode: the agent works in its own headless Excalidraw on the
  // GitHub version; the user's app picks its commits up within seconds
  // ---------------------------------------------------------------------------

  /** a specific version (blob sha) of a scene */
  const loadVersion = async (name, sha) => JSON.parse(await call(`${sceneUrl(name)}?sha=${encodeURIComponent(sha)}`));

  /** user's sync state for this scene, after the flush — so the agent knows what it sees */
  const userSyncNote = (flushed) => {
    const results = (flushed?.results || []).filter((r) => r && !r.error);
    if (!flushed || !flushed.tabs) {
      return "The user's app is not open: you see the GitHub version.";
    }
    if (results.some((r) => r.status === "conflict")) {
      return "The user's app has a merge CONFLICT on this scene: their newest edits are not on GitHub until it is resolved (get_conflict / resolve_conflict, or the user in the sidebar).";
    }
    if (results.some((r) => r.autoSync === false && ["ahead", "local", "diverged"].includes(r.status))) {
      return "Auto-sync is OFF for this scene in the user's app and they have unpushed changes, which you don't see. The user decides when to push.";
    }
    return "Up to date: the user's app pushed its changes of this scene before this read.";
  };

  /** what the user (or anyone else) changed since `since` or the agent's last commit */
  const changesSince = async (name, current, since) => {
    let base = null;
    let label;
    if (since) {
      base = await loadVersion(name, since).catch(() => null);
      if (!base) {
        throw new Error(`Revision "${since}" of "${name}" not found — call without since/basedOn`);
      }
      label = `since revision ${since.slice(0, 7)}`;
    } else {
      const { version } = await callJson(`${sceneUrl(name)}/agent-version`);
      if (version) {
        base = await loadVersion(name, version.sha).catch(() => null);
        label = `since an agent last edited this scene (${version.at})`;
      }
    }
    if (!base) {
      return { count: 0, changedIds: [], report: null, firstLook: true };
    }
    return {
      ...describeChanges((base.elements || []).filter((el) => !el.isDeleted), current, `by the user (or others) ${label}`),
      firstLook: false,
    };
  };

  /** image of some elements of a scene version */
  const imageOf = async (file, elementIds, caption) => {
    if (!elementIds.length) {
      return [];
    }
    try {
      const { image, meta } = await renderImage({
        scene: { elements: file.elements || [], files: file.files || {}, appState: file.appState || {} },
        elementIds,
        maxSize: 1200,
      });
      return [image, { type: "text", text: `Image above: ${caption} (${meta.elementsRendered} elements, bounds ${JSON.stringify(meta.renderedBounds)}).` }];
    } catch (error) {
      return [{ type: "text", text: `(could not render image: ${error.message})` }];
    }
  };

  /** a local-only scene from the user's browser, shaped like a GitHub version */
  const localVersion = async (name, since) => {
    const { file, revision, base } = await loadLocalScene(name, since);
    return {
      file,
      sha: revision,
      changes: (elements) =>
        base
          ? { ...describeChanges((base.elements || []).filter((el) => !el.isDeleted), elements, `by the user ${base.label}`), firstLook: false }
          : { count: 0, changedIds: [], report: null, firstLook: true },
    };
  };

  function registerDetachedTools() {
    server.registerTool(
      "read_scene",
      {
        description: `Read a scene and find out what the USER changed since an agent last edited it. You work on your own copy (a headless Excalidraw), never in the user's browser: before reading, the user's app is asked to push its unpushed changes of this scene, so you see their latest work.
userChanges lists what changed (added / modified with changedFields / deleted) since the last agent edit of this scene (found in the git history), or since revision=<since> if you pass one. The result has a "revision": pass it as basedOn to edit_scene, or as since to the next read_scene, to get exactly what changed in between. view=true adds an IMAGE of the user's changes (or of the scene).
Scene data: summary=true (default above ${SUMMARY_THRESHOLD} elements) gives an overview (bounds, counts, frames, all text labels with positions); region / elementIds give element data for a part; otherwise all elements. changesOnly=true skips the scene data.`,
        inputSchema: {
          name: SCENE_NAME,
          view: z.boolean().optional().describe("Also return an IMAGE: of the user's changes, or of the scene"),
          changesOnly: z.boolean().optional().describe("Only report the user's changes, no scene data"),
          summary: z.boolean().optional(),
          textsOffset: TEXTS_OFFSET,
          region: REGION.optional(),
          elementIds: z.array(z.string()).optional(),
          since: z.string().optional().describe("A revision returned earlier: report changes since then"),
        },
        annotations: { readOnlyHint: true },
      },
      tool(async ({ name, view, changesOnly, summary, region, elementIds, since, textsOffset }) => {
        const flushed = await flushUser(name);
        const local = isLocalOnly(flushed);
        const current = local ? await localVersion(name, since) : await loadSceneWithSha(name);
        if (!current) {
          throw notFound(name);
        }
        const elements = (current.file.elements || []).filter((el) => !el.isDeleted);
        const changes = local ? current.changes(elements) : await changesSince(name, elements, since);
        const result = text({
          scene: name,
          revision: current.sha,
          sync: local ? LOCAL_NOTE : userSyncNote(flushed),
          elementCount: elements.length,
          userChanges: changes.firstLook
            ? "No earlier agent edit of this scene found — everything is new to you. From your first edit on, the user's changes are reported."
            : changes.report,
          ...(changesOnly ? {} : sceneView(elements, { summary, region, elementIds, textsOffset }, elements.length > SUMMARY_THRESHOLD)),
        });
        if (view) {
          if (changes.changedIds.length) {
            result.content.push(...(await imageOf(current.file, changes.changedIds, "what the user changed")));
          } else if (elements.length) {
            try {
              const { image, meta } = await renderImage({
                scene: { elements: current.file.elements || [], files: current.file.files || {}, appState: current.file.appState || {} },
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
      "edit_scene",
      {
        description: `Edit a scene: applied in your own headless Excalidraw to the newest version and committed to GitHub right away (one commit per edit). The user's app picks it up within seconds and merges it with whatever they are doing: their other changes are never overwritten, and their view is not touched. This is the ONLY way to change an existing scene: never push, sync, write .excalidraw files or call the scenes server's HTTP API yourself (direct writes are refused).
Safety net: the user's app first pushes its unpushed changes of this scene. If the user changed the scene since basedOn (the revision from your last read_scene / edit_scene; default: the last agent edit), your edit is still applied, but the result starts with a WARNING listing their changes (plus an image) — check them and adjust your edit if it clashes.
- add: JSON array string of new elements in create_view format (labels, startBinding/endBinding — arrows may bind to existing elements). Use new unique ids.
- update: [{ "id": "...", ...props }] partial updates of existing elements, e.g. move (x, y), resize, recolor, change "text" of a text element (labels are text elements with containerId).
- delete: ids to remove (a container's label goes with it).
- To label an EXISTING shape, add a text element with "containerId": "<shape id>" (it gets centered in the shape).
Big edits: put them in a JSON file and pass file (absolute path).
${IMAGES_HELP}
Returns an IMAGE of the edited area (view=false to skip) and the new revision.`,
        inputSchema: {
          name: SCENE_NAME,
          add: z.string().optional().describe("JSON array string of new elements (create_view format)"),
          update: z
            .array(z.object({ id: z.string() }).passthrough())
            .optional()
            .describe("Partial updates: [{ id, ...props }]"),
          delete: z.array(z.string()).optional(),
          file: EDIT_FILE,
          basedOn: z.string().optional().describe("The revision your edit is based on (from read_scene / edit_scene)"),
          view: z.boolean().optional().describe("Return an IMAGE of the edited area (default true)"),
        },
      },
      tool(async ({ name, add, update, delete: remove, file, basedOn, view = true }) => {
        const edit = await editInput({ add, update, delete: remove, file });

        // what did the user do since the agent's version?
        const local = isLocalOnly(await flushUser(name));
        const before = local ? await localVersion(name, basedOn) : await loadSceneWithSha(name);
        if (!before) {
          throw new Error(`Scene "${name}" not found on GitHub. Create new scenes with create_view + save_scene.`);
        }
        const beforeElements = (before.file.elements || []).filter((el) => !el.isDeleted);
        const changes = local ? before.changes(beforeElements) : await changesSince(name, beforeElements, basedOn);

        // local-only scenes are edited in the user's app (their only copy)
        const edited = await (local ? appCommand : agentCommand)({
          type: local ? "local-edit" : "scene-edit",
          ...(local ? { targetScene: name } : {}),
          name,
          ...(edit.add.length ? { add: edit.add } : {}),
          ...(edit.update.length ? { update: edit.update } : {}),
          ...(edit.delete.length ? { delete: edit.delete } : {}),
          ...(Object.keys(edit.files).length ? { files: edit.files } : {}),
        });
        const after = {
          elements: edited.elements,
          files: { ...(before.file.files || {}), ...edit.files },
          appState: before.file.appState || {},
        };

        const warning = changes.firstLook
          ? basedOn
            ? null
            : "You edited without reading this scene first. Call read_scene before editing next time."
          : changes.count
          ? `WARNING: the user changed this scene since your version (${changes.report.summary}). Your edit was applied on top of their changes — check them below and fix your edit if it clashes.`
          : null;

        const result = text({
          ...(warning ? { warning } : {}),
          ...(changes.count ? { userChanges: changes.report } : {}),
          scene: name,
          addedIds: edited.addedIds,
          updated: edited.updated,
          deleted: edited.deleted,
          ...(edited.missingIds ? { missingIds: edited.missingIds } : {}),
          revision: local ? edited.revision : edited.sha,
          ...(local
            ? { note: `${LOCAL_NOTE} Your edit is in their app now; nothing else to do.` }
            : { commit: edited.commit, note: "Committed to GitHub. The user's app merges it within seconds; nothing else to do." }),
        });
        if (view) {
          result.content.push(...(await imageOf(after, [...edited.addedIds, ...edited.updated], "the edited area")));
          if (changes.count) {
            const userIds = changes.changedIds.filter((id) => edited.elements.some((el) => el.id === id));
            if (userIds.length) {
              result.content.push({ type: "text", text: "Next image: what the USER changed." });
              result.content.push(...(await imageOf(after, userIds, "the user's changes")));
            }
          }
        }
        return result;
      }),
    );
  }

  if (MODE === "detached") {
    registerDetachedTools();
  }

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
        const { file, local } = await loadAnyScene(name);
        if (!file) {
          throw notFound(name);
        }
        scene = { elements: file.elements || [], files: file.files || {}, appState: file.appState || {} };
        source = `scene "${name}" (${local ? "local only, from the user's browser" : "repo"})`;
      } else {
        if (MODE === "detached") {
          throw new Error("Pass name (or checkpointId). app_status tells you which scene the user has open.");
        }
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
      description: `Save a NEW drawing as a scene: writes scenes/<name>.excalidraw, commits and pushes it to GitHub.
Provide EITHER checkpointId (from create_view: draw with create_view, then save its checkpoint) OR elements (same JSON format as create_view, incl. restoreCheckpoint/delete). open=true switches the user's app to it${MODE === "detached" ? " (only when the user asked to see it)" : ""}.
NOT for changing an existing scene: the user's app holds the newest version (possibly with unpushed edits) and syncs it to GitHub by itself (auto-sync), so writing to GitHub directly races with it and causes conflicts. To change an existing scene: ${MODE === "detached" ? "read_scene + edit_scene" : "open_scene(name) if it isn't open, then read_open_scene + edit_open_scene; the app pushes"}. save_scene refuses existing scenes unless replace=true: for when the user explicitly wants the whole scene replaced by a new drawing, or when the app isn't open in any browser (the app merges it on its next sync).
${IMAGES_HELP}
${MODE === "live" ? 'Note: while you draw, every create_view call is mirrored live into the user\'s app (scene "agent-live"), so the user can watch.' : ""}`,
      inputSchema: {
        name: SCENE_NAME,
        checkpointId: z.string().optional().describe("Checkpoint id returned by create_view / get_scene"),
        elements: z.string().optional().describe("JSON array string of elements (create_view format)"),
        elementsFile: z.string().optional().describe("Absolute path of a JSON file with the elements array (instead of elements)"),
        open: z.boolean().optional().describe("Switch the user's Excalidraw app to this scene after saving"),
        replace: z
          .boolean()
          .optional()
          .describe("Overwrite an EXISTING scene with this drawing. Only when the user explicitly asked to replace the whole scene"),
        local: z
          .boolean()
          .optional()
          .describe("Keep it only in the user's browser: a local-only scene, never synced to GitHub (needs the app open). Only when the user asks for a local / private / not-synced scene"),
      },
    },
    tool(async ({ name, checkpointId, elements, elementsFile, open, replace, local }) => {
      if (elementsFile) {
        elements = JSON.stringify((await readEditFile(elementsFile)).add || []);
      }
      if (!checkpointId && !elements) {
        throw new Error("Provide checkpointId, elements or elementsFile");
      }
      if (isLocalOnly(await flushUser(name)) && !local) {
        throw new Error(
          `"${name}" exists as a local-only scene in the user's browser. Change it with read_scene + edit_scene; replace it with save_scene(local: true, replace: true) only if the user wants the whole scene replaced.`,
        );
      }
      const current = local ? null : await loadSceneWithSha(name);
      if (current && !replace) {
        throw new Error(
          `Scene "${name}" already exists. Don't overwrite it: ${MODE === "detached" ? `change it with read_scene("${name}") + edit_scene("${name}", …), which merges with the user's work.` : `the user's app syncs it by itself. To change it, open_scene("${name}") (if it isn't open), read_open_scene, then edit_open_scene; the app pushes the result.`} Only if the user explicitly wants the whole scene replaced by your drawing, or the app is not open at all (app_status: connected false; it then merges your version on its next sync), call save_scene again with replace: true.`,
        );
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
      const withImages = await resolveImages(await resolveElements(input));
      const { elements: sceneElements, convertedBy } = await toSceneElements(withImages.elements);

      const existing = current?.file ?? null;
      const fileIds = new Set(sceneElements.map((el) => el.fileId).filter(Boolean));
      const files = Object.fromEntries(
        Object.entries({ ...(existing?.files || {}), ...withImages.files }).filter(([id]) => fileIds.has(id)),
      );
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "excalidraw-scenes-mcp",
        elements: sceneElements,
        // the name ties the content to this scene (the server rejects mismatches)
        appState: { ...(existing?.appState || { viewBackgroundColor: "#ffffff", gridSize: 20 }), name },
        files,
      };
      if (local) {
        // the user's app keeps it (their browser is its only home)
        const saved = await appCommand({ type: "local-save", name, json: JSON.stringify(scene), replace: !!replace, open: !!open });
        const savedCheckpointId = newCheckpointId();
        await store.save(savedCheckpointId, { elements: sceneElements });
        return text({
          ...saved,
          elementCount: sceneElements.length,
          convertedBy,
          checkpointId: savedCheckpointId,
          note: LOCAL_NOTE,
        });
      }
      const result = await callJson(sceneUrl(name), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp",
          // only replace the version we just looked at
          "X-Base-Sha": current?.sha || "none",
        },
        body: JSON.stringify(scene, null, 2),
      });
      let app = null;
      if (open) {
        app = await appCommand({ type: "open", name });
        if (MODE === "live") {
          // the agent knows this content — later user edits are reported relative to it
          await appCommand({ type: "read", targetScene: name, storeBaseline: "save" }).catch(() => null);
        }
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
        ...(MODE === "detached" ? { revision: result.sha } : {}),
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
    MODE === "detached"
      ? "Done on GitHub. The user's app follows within seconds (their unpushed changes were pushed first)."
      : "The app is not open in a browser, so this was done on GitHub directly — the app picks it up on its next sync.";

  server.registerTool(
    "rename_scene",
    {
      description: `Rename a scene on GitHub (one commit, history kept); the user's app follows (its local copy incl. unpushed changes moves along, the URL follows if it is open). Fails if newName exists.`,
      inputSchema: { name: SCENE_NAME, newName: SCENE_NAME },
    },
    tool(async ({ name, newName }) => {
      if (MODE === "live" && (await appConnected())) {
        return text(await appCommand({ type: "rename", name, to: newName }));
      }
      // the user's unpushed changes go along
      if (isLocalOnly(await flushUser(name))) {
        return text({ ...(await appCommand({ type: "rename", name, to: newName })), note: LOCAL_NOTE });
      }
      const result = await callJson(`${sceneUrl(name)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp" },
        body: JSON.stringify({ to: newName }),
      });
      return text({ renamed: name, to: newName, commit: result.commit, note: viaGitHubNote });
    }),
  );

  server.registerTool(
    "delete_scene",
    {
      description: `Delete a scene on GitHub (one commit; it stays in the git history); the user's app follows. Only delete when the user asked for it, and name the scene exactly.`,
      inputSchema: { name: SCENE_NAME },
      annotations: { destructiveHint: true },
    },
    tool(async ({ name }) => {
      if (MODE === "live" && (await appConnected())) {
        return text(await appCommand({ type: "delete", name }));
      }
      if (isLocalOnly(await flushUser(name))) {
        return text({ ...(await appCommand({ type: "delete", name })), note: "Deleted in the user's browser (it was local only, so there is no other copy)." });
      }
      const result = await callJson(sceneUrl(name), {
        method: "DELETE",
        headers: { "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp" },
      });
      return text({ deleted: name, commit: result.commit, note: viaGitHubNote });
    }),
  );

  server.registerTool(
    "clone_scene",
    {
      description: `Duplicate a scene under a new name (incl. the user's latest changes). open=true switches the user's app to the copy — only when the user asked to continue in the copy.`,
      inputSchema: {
        name: SCENE_NAME,
        newName: SCENE_NAME,
        open: z.boolean().optional().describe("Switch the user's app to the copy (default false)"),
      },
    },
    tool(async ({ name, newName, open }) => {
      if (MODE === "live" && (await appConnected())) {
        return text(await appCommand({ type: "clone", name, to: newName, open: !!open }));
      }
      if (isLocalOnly(await flushUser(name))) {
        return text({ ...(await appCommand({ type: "clone", name, to: newName, open: !!open })), note: "The copy is local only too." });
      }
      const file = await loadSceneFile(name);
      if (!file) {
        throw notFound(name);
      }
      const result = await callJson(sceneUrl(newName), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Scenes-Source": "agent", "X-Scenes-Client": "mcp", "X-Base-Sha": "none" },
        body: JSON.stringify({ ...file, appState: { ...(file.appState || {}), name: newName } }, null, 2),
      });
      const app = open ? await appCommand({ type: "open", name: newName }).catch((error) => ({ error: error.message })) : null;
      return text({ cloned: name, to: newName, commit: result.commit, note: viaGitHubNote, ...(app ? { app } : {}) });
    }),
  );

  server.registerTool(
    "open_scene",
    {
      description:
        MODE === "detached"
          ? "Switch the USER's Excalidraw app (their browser) to a scene. You don't need this for your own work (read_scene / edit_scene work on any scene): only use it when the user asks you to show them a scene. create=true creates a new empty scene there."
          : "Switch the user's Excalidraw app (open in the browser) to a scene. Unsaved changes of the previous scene are kept locally in the browser. Set create=true to create a new empty scene with that name instead.",
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
        "Which scene is open in the user's Excalidraw app, whether it has unpushed changes, and every scene the app knows about with its sync status: synced, ahead (not pushed yet), behind (newer on GitHub), diverged, conflict (needs get_conflict / resolve_conflict), local (not on GitHub). The app syncs by itself (auto-sync); scenes marked \"auto-sync off\" are pushed only when the user decides.",
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
    "set_local_only",
    {
      description:
        "Make a scene local-only (kept only in the user's browser, never pushed to or pulled from GitHub; a copy already on GitHub stays there unchanged) or sync it with GitHub again (localOnly=false: the app pushes it, or merges it with the GitHub copy). Only when the user asks. Needs the app open.",
      inputSchema: { name: SCENE_NAME, localOnly: z.boolean() },
    },
    tool(async ({ name, localOnly }) => {
      if (!(await appConnected())) {
        throw new Error(`Local-only scenes live in the user's app (browser), which is not open. Ask the user to open ${APP_HINT}.`);
      }
      return text(await appCommand({ type: "local-only", name, on: localOnly }));
    }),
  );

  if (MODE === "live") {
    server.registerTool(
      "save_open_scene",
      {
        description:
          "Push the scene open in the user's app to GitHub right now, including the user's edits. Usually NOT needed: with auto-sync on (the default) the app pushes by itself about 30 s after the last edit and pulls GitHub changes every 60 s. Use it only when the user asks to save/commit/push now, or to give an untitled scene a name. If auto-sync is off for the scene, the user wants to decide when it goes to GitHub: only push when they ask.",
        inputSchema: { name: SCENE_NAME.optional() },
      },
      tool(async ({ name }) => text(await appCommand({ type: "save", ...(name ? { name } : {}) }))),
    );
  }

  // ---------------------------------------------------------------------------
  // merge conflicts: the user's version and GitHub's changed the same elements
  // ---------------------------------------------------------------------------

  const requireApp = async () => {
    if (!(await appConnected())) {
      throw new Error(`Conflicts live in the user's app (browser), which is not open. Ask the user to open ${APP_HINT}.`);
    }
  };

  /** a clashing element side by side, compact */
  const clashView = (clash) => {
    const side = (el) => (el ? compact([el])[0] : "deleted");
    return {
      id: clash.id,
      type: (clash.mine || clash.theirs || clash.base)?.type,
      label: (clash.mine || clash.theirs || clash.base)?.text,
      mineChanged: clash.mineChanged,
      githubChanged: clash.theirsChanged,
      base: clash.base ? compact([clash.base])[0] : "(unknown or not in base)",
      mine: side(clash.mine),
      github: side(clash.theirs),
    };
  };

  server.registerTool(
    "get_conflict",
    {
      description: `Show a merge conflict of a scene (status "conflict" in app_status / read_open_scene): elements that the user's local version AND GitHub's version both changed differently since their common version. Everything else was merged automatically. Per clashing element you get base / mine (the user's local version) / github, and which fields each side changed. view=true adds two images of the clashing area: the user's version and GitHub's. Then settle it with resolve_conflict.`,
      inputSchema: {
        name: SCENE_NAME,
        view: z.boolean().optional().describe("Also return images of the clashing area: mine and GitHub's version"),
        limit: z.number().optional().describe("Max clashes with full details (default 40); the rest are listed by id"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ name, view, limit = 40 }) => {
      await requireApp();
      const info = await appCommand({ type: "conflict-info", name });
      const result = text({
        scene: info.scene,
        clashes: info.clashes.length,
        autoMerged: info.autoMerged,
        ...(info.baseKnown ? {} : { note: "The common base version is unknown, so every difference counts as a clash." }),
        details: info.clashes.slice(0, limit).map(clashView),
        ...(info.clashes.length > limit ? { moreIds: info.clashes.slice(limit).map((c) => c.id) } : {}),
        next: 'resolve_conflict(name, resolution: "merge", choices: {id: "mine" | "github"}, otherwise: "mine" | "github") keeps the auto-merged changes of both sides and decides each clashing element. Other resolutions: "mine" (overwrite GitHub with the user\'s whole version), "github" (discard the user\'s local changes), "both" (GitHub\'s version, user\'s kept as a copy). Ask the user when the right choice is not obvious.',
      });
      if (view && info.clashes.length) {
        const ids = info.clashes.map((c) => c.id);
        for (const side of ["mine", "theirs"]) {
          const sideIds = ids.filter((id) => info.clashes.find((c) => c.id === id)[side]);
          if (!sideIds.length) {
            result.content.push({ type: "text", text: `(${side === "mine" ? "mine" : "GitHub's"}: all clashing elements are deleted there)` });
            continue;
          }
          try {
            const { image, meta } = await renderImage({ conflict: { name, side }, elementIds: sideIds, maxSize: 1200 }, { userTab: true });
            result.content.push(image, {
              type: "text",
              text: `Image above: ${side === "mine" ? "the USER's version (mine)" : "GITHUB's version"} of the clashing area (bounds ${JSON.stringify(meta.renderedBounds)}).`,
            });
          } catch (error) {
            result.content.push({ type: "text", text: `(could not render ${side}: ${error.message})` });
          }
        }
      }
      return result;
    }),
  );

  const SIDE = z.enum(["mine", "github"]);
  const toSide = (choice) => (choice === "github" ? "theirs" : choice);

  server.registerTool(
    "resolve_conflict",
    {
      description: `Resolve a merge conflict of a scene (see get_conflict) and push the result to GitHub.
- resolution "merge" (recommended): keeps every change that only one side made, and decides each clashing element: choices = {"<element id>": "mine" | "github"}, otherwise = the side for all clashes not in choices. Every clash needs a decision. "mine" = the user's local version of that element, "github" = the version on GitHub; a side where the element is deleted removes it.
- "mine": the user's whole local version overwrites GitHub (GitHub's other changes are lost).
- "github": take GitHub's version, discard the user's local changes.
- "both": take GitHub's version and keep the user's version as a copy scene.
Afterwards, fix details with read_open_scene / edit_open_scene if needed. Ask the user when it is unclear which version they want; never silently discard their work.`,
      inputSchema: {
        name: SCENE_NAME,
        resolution: z.enum(["merge", "mine", "github", "both"]),
        choices: z.record(z.string(), SIDE).optional().describe('For "merge": element id -> "mine" | "github"'),
        otherwise: SIDE.optional().describe('For "merge": side for clashes not listed in choices'),
      },
      annotations: { destructiveHint: true },
    },
    tool(async ({ name, resolution, choices, otherwise }) => {
      await requireApp();
      const result = await appCommand({
        type: "conflict-resolve",
        name,
        resolution: resolution === "github" ? "theirs" : resolution,
        ...(choices ? { choices: Object.fromEntries(Object.entries(choices).map(([id, c]) => [id, toSide(c)])) } : {}),
        ...(otherwise ? { otherwise: toSide(otherwise) } : {}),
      });
      if (result.resolved === false) {
        return text({
          ...result,
          note: "GitHub changed again meanwhile and the newest version clashes too. Call get_conflict again.",
        });
      }
      return text(result);
    }),
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
    if (MODE === "live" && process.env.SCENES_LIVE_PREVIEW !== "false") {
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
