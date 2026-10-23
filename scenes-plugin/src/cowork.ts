// Co-working on the scene open in the editor: the agent reads the live canvas
// (incl. the user's unsaved edits) and applies edits that merge with whatever
// the user is doing — one undoable step per agent edit.

import {
  CaptureUpdateAction,
  newElementWith,
  Fonts,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import {
  Scene,
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  hashString,
  refreshTextDimensions,
  updateBoundElements,
} from "@excalidraw/element";

import { registerSceneFonts, withFonts } from "./fonts";
import { scenesApi } from "./api";
import { applyMarkdownUpdate } from "./richText/agent";
import { placeOnSlides, syncTemplate } from "./slides";
import { scenesController, withSceneName } from "./controller";
import { getAgentBaseline, getCheckpoint, setAgentBaseline, setCheckpoint } from "./storage";

import type { ApiError } from "./api";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * Agent baselines (what the canvas looked like when an agent last read /
 * edited a scene) are kept here in the browser (IndexedDB), per scene — the
 * MCP server and the scenes server keep nothing.
 */
type BaselineOptions = {
  /** return the stored baseline of this scene (`agentBaseline`) */
  withBaseline?: boolean;
  /** afterwards store the current canvas as the new baseline (e.g. "read") */
  storeBaseline?: string;
  /** also keep the current canvas as a checkpoint with this id */
  revision?: string;
  /** the scene the agent means (routing) — nothing is stored for another scene */
  targetScene?: string | null;
};

export type ReadCommand = { type: "read" } & BaselineOptions;

/** detached mode: the agent edits its own copy of a scene and commits it */
export type SceneEditCommand = {
  type: "scene-edit";
  name: string;
  /** image files of added image elements */
  files?: BinaryFiles;
  add?: any[];
  update?: Array<{ id: string; [key: string]: unknown }>;
  delete?: string[];
};

export type EditCommand = {
  type: "edit";
  /** refuse to edit if the user switched to another scene meanwhile */
  expectScene?: string | null;
  /** new elements, create_view format (labels, startBinding, …) */
  add?: any[];
  /** partial updates: { id, ...props } */
  update?: Array<{ id: string; [key: string]: unknown }>;
  /** ids to delete (labels of deleted containers go too) */
  delete?: string[];
  /** image files of added image elements */
  files?: BinaryFiles;
} & BaselineOptions;

const requireApi = () => {
  const api = scenesController.getApi();
  if (!api) {
    throw new Error("Editor not ready");
  }
  return api;
};

const sceneInfo = () => {
  const { current, dirty } = scenesController.getState();
  return {
    scene: current,
    dirty,
    autoSync: scenesController.autoSyncFor(current),
    syncStatus: scenesController.statusOf(current),
  };
};

const handleBaseline = async (
  scene: string | null,
  elements: readonly ExcalidrawElement[],
  { withBaseline, storeBaseline, revision, targetScene }: BaselineOptions,
) => {
  if (targetScene !== undefined && targetScene !== scene) {
    return {}; // the agent meant another scene — it gets an error, store nothing
  }
  const previous = withBaseline ? (await getAgentBaseline(scene)) ?? null : undefined;
  if (revision) {
    await setCheckpoint(revision, { elements: [...elements] });
  }
  if (storeBaseline) {
    await setAgentBaseline(scene, {
      at: new Date().toISOString(),
      action: storeBaseline,
      elements: [...elements],
    });
  }
  return previous === undefined ? {} : { agentBaseline: previous };
};

export const readOpenScene = async (command: ReadCommand = { type: "read" }) => {
  const api = requireApi();
  const info = sceneInfo();
  const elements = api.getSceneElements();
  return {
    ...info,
    elements,
    viewBackgroundColor: api.getAppState().viewBackgroundColor,
    ...(await handleBaseline(info.scene, elements, command)),
  };
};

/**
 * After an edit: labels are wrapped to their shape (which grows if the text
 * needs it) and centered in it again; arrows bound to moved or resized
 * shapes follow them — what the editor does when a user does the same.
 */
const layoutAfterEdit = (
  input: ExcalidrawElement[],
  textChanged: Set<string>,
  reshaped: Set<string>,
) => {
  if (!textChanged.size && !reshaped.size) {
    return input;
  }
  // own copies: the arrow update below mutates elements in place
  const scene = new Scene(input.map((el) => ({ ...el }) as ExcalidrawElement), { skipValidation: true });
  const map = scene.getNonDeletedElementsMap();
  const changedShapes = new Set(reshaped);
  for (const el of scene.getNonDeletedElements()) {
    const containerId = (el as any).containerId;
    const container = containerId && (map.get(containerId) as any);
    if (el.type !== "text" || !container || container.type === "arrow") {
      continue;
    }
    if (!textChanged.has(el.id) && !reshaped.has(container.id) && !reshaped.has(el.id)) {
      continue;
    }
    let text: any = { ...el, ...(refreshTextDimensions(el as any, container, map) || {}) };
    if (text.height > getBoundTextMaxHeight(container, text)) {
      scene.mutateElement(container, {
        height: (computeContainerDimensionForBoundText as any)(text.height, container.type, container),
      });
      changedShapes.add(container.id);
    }
    text = { ...text, ...computeBoundTextPosition(container, text, map), frameId: container.frameId ?? null };
    scene.mutateElement(el as any, {
      x: text.x,
      y: text.y,
      width: text.width,
      height: text.height,
      text: text.text,
      frameId: text.frameId,
    });
  }
  const moved = [...changedShapes].map((id) => map.get(id)).filter(Boolean) as any[];
  for (const el of moved) {
    if (el.type !== "text" && el.type !== "arrow" && el.type !== "line") {
      updateBoundElements(el, scene, { simultaneouslyUpdated: moved });
    }
  }
  return [...scene.getElementsIncludingDeleted()] as ExcalidrawElement[];
};

/** a deck's slides get their template copies (header, footer, page numbers) */
export const withTemplate = (elements: ExcalidrawElement[], deck: string) =>
  syncTemplate(elements, deck)?.elements ?? elements;

/** fields an agent must not set directly */
const PROTECTED = new Set(["id", "type", "version", "versionNonce", "isDeleted", "index"]);

/**
 * Apply an agent's add / update / delete to a list of elements (incl. deleted
 * ones) — used for the user's open canvas (live mode) and for the agent's own
 * headless copy (detached mode).
 */
const applyEdits = async (
  input: readonly ExcalidrawElement[],
  command: Pick<EditCommand, "add" | "update" | "delete">,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  let elements: ExcalidrawElement[] = [...input];
  const byId = () => new Map(elements.map((el) => [el.id, el]));
  const missing: string[] = [];

  // deletions (containers take their labels along)
  if (command.delete?.length) {
    const ids = new Set(command.delete);
    for (const el of elements) {
      if ((el as any).containerId && ids.has((el as any).containerId)) {
        ids.add(el.id);
      }
    }
    const present = byId();
    command.delete.forEach((id) => !present.has(id) && missing.push(id));
    elements = elements.map((el) =>
      ids.has(el.id) && !el.isDeleted ? newElementWith(el, { isDeleted: true }) : el,
    );
  }

  // partial updates
  const textUpdated = new Set<string>();
  /** elements whose geometry changed: their labels and arrows follow */
  const reshaped = new Set<string>();
  /** labels for shapes that have none yet (update with `label`) */
  const newLabels: any[] = [];
  if (command.update?.length) {
    const present = byId();
    const patches = new Map<string, Record<string, unknown>>();
    // { id, slide: 3, x, y }: coordinates on slide 3
    const updates = placeOnSlides(command.update, elements);
    const labelOf = (id: string) =>
      elements.find((el) => !el.isDeleted && el.type === "text" && (el as any).containerId === id);
    for (const { id, ...props } of updates) {
      const el = present.get(id);
      if (!el || el.isDeleted) {
        missing.push(id);
        continue;
      }
      const { label: rawLabel, ...rest } = applyMarkdownUpdate(el, props as Record<string, any>);
      const label = rawLabel && typeof rawLabel === "object" ? applyMarkdownUpdate(labelOf(id) ?? {}, rawLabel) : rawLabel;
      const patch: Record<string, unknown> = { ...(patches.get(id) || {}) };
      for (const [key, value] of Object.entries(rest)) {
        if (!PROTECTED.has(key)) {
          patch[key] = value;
        }
      }
      if (label !== undefined && el.type !== "text") {
        // { label: { text, fontSize, … } } on a shape edits (or creates) its label
        const spec = typeof label === "string" ? { text: label } : { ...label };
        delete spec.id;
        const existing = labelOf(id);
        if (existing) {
          patches.set(existing.id, { ...(patches.get(existing.id) || {}), ...spec });
          if (typeof spec.text === "string") {
            patches.get(existing.id)!.originalText = spec.text;
            textUpdated.add(existing.id);
          } else {
            reshaped.add(id);
          }
        } else if (typeof spec.text === "string") {
          newLabels.push({ type: "text", id: `${id}-label`, containerId: id, ...spec });
        }
      }
      if (el.type === "text" && typeof patch.text === "string") {
        patch.originalText = patch.text;
        textUpdated.add(el.id);
      }
      if (["x", "y", "width", "height", "angle", "points"].some((key) => key in patch)) {
        reshaped.add(id);
      }
      patches.set(id, patch);
    }
    // a moved frame takes its content along (like dragging it in the editor)
    for (const [id, patch] of [...patches]) {
      const frame = present.get(id)!;
      if ((frame.type !== "frame" && frame.type !== "magicframe") || !("x" in patch || "y" in patch)) {
        continue;
      }
      const dx = Number(patch.x ?? frame.x) - frame.x;
      const dy = Number(patch.y ?? frame.y) - frame.y;
      for (const child of elements) {
        const own = patches.get(child.id) || {};
        const moves = child.frameId === id && !child.isDeleted && !("x" in own) && !("y" in own);
        if (moves && (dx || dy)) {
          patches.set(child.id, { ...(patches.get(child.id) || {}), x: child.x + dx, y: child.y + dy });
          reshaped.add(child.id);
        }
      }
    }
    elements = elements.map((el) => {
      const patch = patches.get(el.id);
      return patch ? newElementWith(el, patch as any) : el;
    });
    // re-measure edited text, with its font loaded (else a fallback font is
    // measured and the text is cut off in the user's browser)
    if (textUpdated.size) {
      await Fonts.loadElementsFonts(elements.filter((el) => textUpdated.has(el.id))).catch(() => []);
      const refreshed = new Map(
        restoreElements(
          elements.filter((el) => textUpdated.has(el.id)),
          elements,
          { refreshDimensions: true },
        ).map((el) => [el.id, el]),
      );
      elements = elements.map((el) => refreshed.get(el.id) ?? el);
    }
  }

  // additions: converted together with the existing elements, so arrows can
  // bind to shapes that are already on the canvas
  let addedIds: string[] = [];
  const toAdd = [...(command.add || []), ...newLabels];
  if (toAdd.length) {
    const existingIds = new Set(elements.map((el) => el.id));
    const clash = toAdd.filter((el) => existingIds.has(el?.id));
    if (clash.length) {
      throw new Error(
        `Element ids already exist: ${clash.map((el) => el.id).join(", ")} — use update for existing elements or pick new ids`,
      );
    }
    const live = elements.filter((el) => !el.isDeleted);
    const merged = await convert([...live, ...toAdd]);
    addedIds = merged.filter((el) => !existingIds.has(el.id)).map((el) => el.id);
    const mergedById = new Map(merged.map((el) => [el.id, el]));

    // labels added as text with containerId (not via a shape's `label`): center
    // them in the shape and register them on it (convert only does this for `label`)
    for (const id of addedIds) {
      const label = mergedById.get(id);
      const container = label?.containerId && mergedById.get(label.containerId);
      const raw = toAdd.find((el) => el?.id === id);
      if (!label || label.type !== "text" || !container || raw?.type !== "text") {
        continue;
      }
      mergedById.set(id, {
        ...label,
        // the converter defaults to left / top; labels are centered unless asked otherwise
        textAlign: raw.textAlign ?? "center",
        verticalAlign: raw.verticalAlign ?? "middle",
        // a label lives on its shape's slide
        frameId: container.frameId ?? null,
      });
      textUpdated.add(id);
      if (!container.boundElements?.some((b: any) => b.id === id)) {
        mergedById.set(container.id, {
          ...container,
          boundElements: [...(container.boundElements || []), { type: "text", id }],
        });
      }
    }
    elements = [
      ...elements.filter((el) => el.isDeleted),
      ...merged,
    ].map((el) => mergedById.get(el.id) ?? el);
  }

  elements = layoutAfterEdit(elements, textUpdated, reshaped);

  return {
    elements,
    addedIds,
    updated: (command.update || []).map((u) => u.id).filter((id) => !missing.includes(id)),
    deleted: (command.delete || []).filter((id) => !missing.includes(id)),
    ...(missing.length ? { missingIds: missing } : {}),
  };
};

export const editOpenScene = async (
  command: EditCommand,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  const api = requireApi();
  const { scene } = sceneInfo();
  if (command.expectScene !== undefined && command.expectScene !== scene) {
    throw new Error(
      `The user switched scenes: the app now shows ${
        scene === null ? "Untitled" : `"${scene}"`
      }, not "${command.expectScene}". Read the open scene again.`,
    );
  }

  if (command.files && Object.keys(command.files).length) {
    api.addFiles(Object.values(command.files));
  }
  const { elements, ...edit } = await applyEdits(
    api.getSceneElementsIncludingDeleted(),
    command,
    convert,
  );

  api.updateScene({
    elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY, // user can undo agent edits
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = requireApi().getSceneElements();
  return {
    ...sceneInfo(),
    ...(await handleBaseline(scene, after, command)),
    ...edit,
    elements: after,
  };
};

/**
 * Detached mode, in the agent's headless tab: apply the edit to the newest
 * version on GitHub and commit it (the user's app merges it within seconds).
 * If GitHub moved on meanwhile, the edit is simply applied again on top.
 */
export const editSceneOnGitHub = async (
  command: SceneEditCommand,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  for (let attempt = 1; ; attempt++) {
    const latest = await scenesApi.load(command.name);
    const data = JSON.parse(latest.json);
    await registerSceneFonts(data);
    const edit = await applyEdits(
      restoreElements(data.elements || [], null, { repairBindings: true }),
      command,
      convert,
    );
    const elements = withTemplate(edit.elements, command.name).filter((el) => !el.isDeleted);
    const json = withSceneName(
      withFonts(
        serializeAsJSON(elements, data.appState || {}, { ...(data.files || {}), ...(command.files || {}) }, "local"),
        elements,
      ),
      command.name, // ties the content to this scene
    );
    try {
      const saved = await scenesApi.save(command.name, json, latest.sha, "agent");
      return { ...edit, elements, sha: saved.sha, commit: saved.commit, changed: saved.changed };
    } catch (error) {
      if ((error as ApiError).status !== 409 || attempt >= 3) {
        throw error;
      }
    }
  }
};

// -----------------------------------------------------------------------------
// local-only scenes: they exist only in the user's browser (never on GitHub),
// so the agent reads and edits them through the user's tab. Revisions and the
// agent's last version are kept here too.
// -----------------------------------------------------------------------------

export type LocalSceneCommand =
  | { type: "local-read"; name: string; since?: string }
  | ({ type: "local-edit"; name: string } & Pick<EditCommand, "add" | "update" | "delete" | "files">)
  | { type: "local-save"; name: string; json: string; replace?: boolean; open?: boolean };

const revisionKey = (name: string, revision: string) => `local:${name}:${revision}`;

/** a revision id for this content, remembered so `since` can refer to it */
const rememberRevision = async (name: string, elements: readonly unknown[], json: string) => {
  const revision = `local-${(hashString(json) >>> 0).toString(36)}`;
  await setCheckpoint(revisionKey(name, revision), { elements: [...elements] });
  return revision;
};

const parseScene = (json: string) => {
  const data = JSON.parse(json);
  return {
    elements: (data.elements || []).filter((el: any) => !el.isDeleted),
    files: data.files || {},
    appState: data.appState || {},
  };
};

export const readLocalScene = async ({ name, since }: { name: string; since?: string }) => {
  const json = await scenesController.localOnlyJson(name);
  const file = parseScene(json);
  const revision = await rememberRevision(name, file.elements, json);
  let base: { elements: unknown[]; label: string } | null = null;
  if (since) {
    const stored = (await getCheckpoint(revisionKey(name, since))) as { elements: unknown[] } | null;
    if (!stored) {
      throw new Error(`Revision "${since}" of "${name}" not found — call without since/basedOn`);
    }
    base = { elements: stored.elements, label: `since revision ${since}` };
  } else {
    const last = await getAgentBaseline(name);
    if (last) {
      base = { elements: last.elements, label: `since an agent last edited this scene (${last.at})` };
    }
  }
  return { file, revision, base };
};

export const editLocalScene = async (
  command: Extract<LocalSceneCommand, { type: "local-edit" }>,
  convert: (elements: any[]) => Promise<any[]>,
) => {
  const data = JSON.parse(await scenesController.localOnlyJson(command.name));
  await registerSceneFonts(data);
  const edit = await applyEdits(
    restoreElements(data.elements || [], null, { repairBindings: true }),
    command,
    convert,
  );
  const elements = withTemplate(edit.elements, command.name).filter((el) => !el.isDeleted);
  const files = { ...(data.files || {}), ...(command.files || {}) };
  const json = withSceneName(withFonts(serializeAsJSON(elements, data.appState || {}, files, "local"), elements), command.name);
  await scenesController.writeLocalOnly(command.name, json);
  await setAgentBaseline(command.name, { at: new Date().toISOString(), action: "edit", elements });
  return {
    ...edit,
    elements,
    files,
    appState: data.appState || {},
    revision: await rememberRevision(command.name, elements, json),
  };
};

export const saveLocalScene = async ({ name, json, replace, open }: Extract<LocalSceneCommand, { type: "local-save" }>) => {
  await scenesController.createLocalOnly(name, json, { replace: !!replace });
  const file = parseScene(json);
  await setAgentBaseline(name, { at: new Date().toISOString(), action: "save", elements: file.elements });
  if (open) {
    await scenesController.open(name);
  }
  return { saved: name, localOnly: true, revision: await rememberRevision(name, file.elements, json) };
};
