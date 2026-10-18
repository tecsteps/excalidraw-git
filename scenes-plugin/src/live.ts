// Live channel to the scenes server: lets agents (via the scenes MCP server)
// drive the editor that is open in the browser — switch scenes, commit the
// open scene, convert MCP-style elements with real font metrics — and keeps
// the editor in sync when an agent commits a scene.

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  FONT_FAMILY,
  restoreElements,
} from "@excalidraw/excalidraw";
import { syncInvalidIndices } from "@excalidraw/element";

import { BASE_URL, TAB_ID, scenesApi } from "./api";
import { scenesController } from "./controller";
import { editOpenScene, readOpenScene } from "./cowork";
import { renderScene } from "./render";
import { getCheckpoint, setCheckpoint } from "./storage";

import type { EditCommand, ReadCommand } from "./cowork";

import type { RenderCommand } from "./render";

type Command =
  | { type: "status" }
  | { type: "open"; name: string }
  | { type: "create"; name: string }
  | { type: "save"; name?: string }
  | { type: "convert"; elements: any[] }
  | { type: "preview"; elements: any[] }
  | { type: "rename"; name: string; to: string }
  | { type: "delete"; name: string }
  | { type: "clone"; name: string; to: string; open?: boolean }
  | { type: "checkpoint-save"; id: string; data: unknown }
  | { type: "checkpoint-load"; id: string }
  | RenderCommand
  | ReadCommand
  | EditCommand;

/** hidden headless tab started by the scenes server, only renders/converts */
export const IS_RENDERER = new URLSearchParams(window.location.search).has(
  "scenes-renderer",
);

const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

/**
 * Same conversion the excalidraw-mcp widget applies to `create_view`
 * elements (labels -> bound text, hand-drawn font), so scenes look exactly
 * like what the agent drew.
 */
const convertMcpElements = async (elements: any[]) => {
  // text is measured during conversion — the hand-drawn font must be loaded,
  // otherwise widths are computed with a fallback font and text gets clipped
  await document.fonts.load("20px Excalifont").catch(() => {});
  const real = elements.filter((el) => el && !PSEUDO_TYPES.has(el.type));
  // elements that are already complete (e.g. from an existing scene) must not
  // be converted again — that would detach their bound text
  const needsConversion = (el: any) =>
    el.label !== undefined || el.version === undefined;
  const rawById = new Map(real.map((el) => [el.id, el]));

  const converted = convertToExcalidrawElements(
    real.filter(needsConversion).map((el) => {
      const next = el.type === "text" ? { fontFamily: FONT_FAMILY.Excalifont, ...el } : el;
      return el.label
        ? {
            ...next,
            label: {
              textAlign: "center",
              verticalAlign: "middle",
              fontFamily: FONT_FAMILY.Excalifont,
              ...el.label,
            },
          }
        : next;
    }),
    { regenerateIds: false },
  );

  // keep the original z-order; labels go right after their container
  const convertedById = new Map(converted.map((el: any) => [el.id, el]));
  const labelsOf = new Map<string, any[]>();
  for (const el of converted as any[]) {
    if (el.containerId && !rawById.has(el.id)) {
      labelsOf.set(el.containerId, [...(labelsOf.get(el.containerId) || []), el]);
    }
  }
  const result: any[] = [];
  for (const raw of real) {
    const el = convertedById.get(raw.id);
    if (el) {
      // new elements get fresh fractional indices fitting their position
      result.push({ ...el, index: null });
      result.push(
        ...(labelsOf.get(raw.id) || []).map((label) => ({ ...label, index: null })),
      );
    } else {
      result.push({ ...raw });
    }
  }

  // convertToExcalidrawElements only understands `start`/`end`; carry over the
  // `startBinding`/`endBinding` ({ elementId, fixedPoint }) used by excalidraw-mcp
  const byId = new Map(result.map((el) => [el.id, el]));
  for (const arrow of result) {
    const raw = rawById.get(arrow.id);
    if (!raw || !needsConversion(raw) || arrow.type !== "arrow") {
      continue;
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = raw[key];
      const target = binding?.elementId && byId.get(binding.elementId);
      if (!target) {
        continue;
      }
      arrow[key] = {
        elementId: target.id,
        fixedPoint: binding.fixedPoint ?? [0.5, 0.5],
        mode: binding.mode ?? "orbit",
      };
      if (!target.boundElements?.some((b: any) => b.id === arrow.id)) {
        target.boundElements = [
          ...(target.boundElements || []),
          { type: "arrow", id: arrow.id },
        ];
      }
    }
  }
  // normalize like the editor does on load (fractional indices, bindings, …)
  // so the committed file doesn't change again when the app saves it
  syncInvalidIndices(result);
  return restoreElements(result, null, { repairBindings: true });
};

// -----------------------------------------------------------------------------
// live preview: watch an agent draw (every create_view call is mirrored here)
// -----------------------------------------------------------------------------

export const LIVE_SCENE = "agent-live";
let liveToken = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const showLive = async (elements: any[]) => {
  const token = ++liveToken;
  const isCurrent = () =>
    token === liveToken && scenesController.getState().current === LIVE_SCENE;

  const converted = await convertMcpElements(elements);
  if (scenesController.getState().current !== LIVE_SCENE) {
    await scenesController.openOrCreate(LIVE_SCENE);
  }
  const api = scenesController.getApi();
  if (!api || !isCurrent()) {
    return;
  }

  const camera = elements.find((el) => el?.type === "cameraUpdate");
  if (camera?.width && camera?.height) {
    api.setViewport({
      target: { x: camera.x, y: camera.y, width: camera.width, height: camera.height },
      fit: "contain",
      animation: true,
    });
  }

  const ids = new Set(converted.map((el: any) => el.id));
  const alreadyShown = new Set(
    api.getSceneElements().map((el) => el.id).filter((id) => ids.has(id)),
  );
  // bound labels appear together with their container
  const steps = converted.filter(
    (el: any) => !(el.containerId && ids.has(el.containerId)),
  );
  const pending = steps.filter((el: any) => !alreadyShown.has(el.id));
  const delay = Math.min(180, 4000 / Math.max(1, pending.length));

  const visible = new Set(alreadyShown);
  const render = () =>
    api.updateScene({
      elements: converted.filter(
        (el: any) =>
          visible.has(el.id) || (el.containerId && visible.has(el.containerId)),
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

  render(); // apply changes/deletions of existing elements right away
  for (const el of pending) {
    await sleep(delay);
    if (!isCurrent()) {
      return;
    }
    visible.add(el.id);
    render();
  }
  if (!camera && converted.length) {
    await sleep(50);
    api.setViewport({
      target: api.getSceneElements(),
      fit: "scale-down",
      animation: true,
    });
  }
};

const status = () => {
  const { current, dirty, list, sync, autoSync } = scenesController.getState();
  return {
    current,
    dirty,
    autoSync,
    github: sync.githubOnline === false ? "offline" : sync.githubOnline ? "online" : "unknown",
    lastCheckedAt: sync.lastCheckedAt,
    // "name: status" — synced / ahead (not pushed) / behind / diverged / conflict / local
    scenes: list
      .filter((item) => item.name !== null)
      .map(({ name, status, pendingRename }) =>
        `${name}: ${status}${pendingRename ? ` (rename on GitHub pending, still "${pendingRename}" there)` : ""}`,
      ),
  };
};

const runCommand = async (command: Command) => {
  switch (command.type) {
    case "status":
      return status();
    case "open":
      await scenesController.open(command.name);
      return status();
    case "create":
      await scenesController.create(command.name);
      return status();
    case "save":
      return { ...(await scenesController.save(command.name)), ...status() };
    case "preview":
      // answer right away, the animation runs on its own
      showLive(command.elements).catch((error) =>
        console.error("[scenes] live preview failed", error),
      );
      return { ok: true, scene: LIVE_SCENE };
    case "rename":
      await scenesController.rename(command.name, command.to);
      return { renamed: command.name, to: command.to, ...status() };
    case "delete":
      await scenesController.remove(command.name);
      return { deleted: command.name, ...status() };
    case "clone":
      await scenesController.clone(command.name, command.to, { open: !!command.open });
      return { cloned: command.name, to: command.to, ...status() };
    case "read":
      return readOpenScene(command);
    case "edit":
      return editOpenScene(command, convertMcpElements);
    case "checkpoint-save":
      await setCheckpoint(command.id, command.data);
      return { ok: true };
    case "checkpoint-load":
      return { data: await getCheckpoint(command.id) };
    case "render":
      return renderScene(
        command,
        () => {
          const api = scenesController.getApi();
          if (!api) {
            throw new Error("Editor not ready");
          }
          return {
            elements: api.getSceneElements(),
            files: api.getFiles(),
            background: api.getAppState().viewBackgroundColor,
          };
        },
        convertMcpElements,
      );
    case "convert":
      return { elements: await convertMcpElements(command.elements) };
    default:
      throw new Error(`Unknown command: ${(command as any).type}`);
  }
};

let source: EventSource | null = null;
let unsubscribe: (() => void) | null = null;
let focusedAt = document.hasFocus() ? Date.now() : 0;

const report = () => {
  const { current, dirty } = scenesController.getState();
  scenesApi.reportState({
    current,
    dirty,
    visible: document.visibilityState === "visible",
    focusedAt,
  });
};

const onFocus = () => {
  focusedAt = Date.now();
  report();
};

export const connectLive = () => {
  if (source) {
    return;
  }
  source = new EventSource(
    `${BASE_URL}/api/events?tab=${TAB_ID}${IS_RENDERER ? "&role=renderer" : ""}`,
  );
  source.onopen = report;
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", report);
  source.onmessage = async (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "command") {
      try {
        await scenesController.ready;
        const result = await runCommand(event.command);
        scenesApi.sendResult(event.id, { ok: true, result });
      } catch (error: any) {
        scenesApi.sendResult(event.id, { ok: false, error: error.message });
      }
    } else if (["scene-saved", "scene-renamed", "scene-deleted"].includes(event.type)) {
      if (IS_RENDERER || event.source === `app:${TAB_ID}`) {
        return;
      }
      // someone else pushed: check and sync (visible in the activity log)
      scenesController.syncNow();
    }
  };

  let last = "";
  unsubscribe = scenesController.subscribe(() => {
    const { current, dirty } = scenesController.getState();
    const key = JSON.stringify([current, dirty]);
    if (key !== last) {
      last = key;
      report();
    }
  });
};

export const disconnectLive = () => {
  source?.close();
  source = null;
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", report);
  unsubscribe?.();
  unsubscribe = null;
};
