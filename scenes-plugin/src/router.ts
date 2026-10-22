// Scene URLs: http://draw.test/<scene name> opens that scene (creating it
// locally if it doesn't exist yet) and the URL follows the current scene.
// Public scenes (kurviq.com/features) open in a viewer above the editor
// instead; see publicScene.tsx.

import { scenesController } from "./controller";
import { isPublicScene, publicScene } from "./publicScene";

const sceneFromPath = (): string | null => {
  const raw = window.location.pathname.replace(/^\/+|\/+$/g, "");
  if (!raw) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

const pathFor = (name: string | null) =>
  name === null ? "/" : `/${encodeURIComponent(name)}`;

const navigateTo = (name: string) =>
  scenesController.openOrCreate(name).catch((error) => {
    console.error(`[scenes] could not open "${name}" from URL`, error);
  });

/** open a public scene from a link in the app (e.g. the welcome screen) */
export const openPublicScene = (name: string) => {
  if (window.location.pathname !== pathFor(name)) {
    window.history.pushState(null, "", pathFor(name));
  }
  publicScene.show(name);
};

/**
 * Until 22 Oct 2026 a visit to /features put a local-only copy "features"
 * into the visitor's scenes. It goes again if the visitor didn't change it.
 */
const removeOldPublicCopies = async () => {
  const KEY = "kurviq-public-scenes";
  let seeded: Record<string, { content: string }> = {};
  try {
    seeded = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {}
  for (const [name, { content }] of Object.entries(seeded)) {
    if (!scenesController.isLocalOnly(name)) {
      continue;
    }
    const json = await scenesController.localOnlyJson(name);
    const elements = (JSON.parse(json).elements ?? [])
      .filter((el: any) => !el.isDeleted)
      .map((el: any) => [el.id, Math.round(el.x), Math.round(el.y), Math.round(el.width), Math.round(el.height), el.text ?? ""]);
    let h = 2166136261;
    const text = JSON.stringify(elements);
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    if ((h >>> 0).toString(36) === content) {
      await scenesController.remove(name);
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {}
};

let connected = false;

export const connectRouter = async () => {
  if (connected) {
    return;
  }
  connected = true;

  const syncUrl = (mode: "push" | "replace") => {
    const { current, busy } = scenesController.getState();
    if (busy === "loading" || publicScene.shown()) {
      return;
    }
    const path = pathFor(current);
    if (window.location.pathname !== path) {
      const url = `${path}${window.location.search}${window.location.hash}`;
      if (mode === "push") {
        window.history.pushState(null, "", url);
      } else {
        window.history.replaceState(null, "", url);
      }
    }
  };

  const target = sceneFromPath();
  if (isPublicScene(target)) {
    publicScene.show(target); // right away, the editor loads underneath
  }

  await scenesController.ready;
  await removeOldPublicCopies().catch((error) => console.error("[scenes] removing old public copies", error));

  if (target !== null && !isPublicScene(target)) {
    await navigateTo(target);
  }
  syncUrl("replace");

  // viewer closed: the URL goes back to the current scene
  publicScene.subscribe(() => syncUrl("replace"));

  let lastCurrent = scenesController.getState().current;
  scenesController.subscribe(() => {
    const { current, busy } = scenesController.getState();
    if (busy === "loading" || current === lastCurrent) {
      return;
    }
    lastCurrent = current;
    syncUrl("push");
  });

  window.addEventListener("popstate", () => {
    const name = sceneFromPath();
    if (isPublicScene(name)) {
      publicScene.show(name);
      return;
    }
    if (publicScene.shown()) {
      publicScene.close();
    }
    if (name !== null && name !== scenesController.getState().current) {
      navigateTo(name);
    }
  });
};
