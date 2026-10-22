// Scene URLs: http://draw.test/<scene name> opens that scene (creating it
// locally if it doesn't exist yet) and the URL follows the current scene.

import { IS_ONLINE } from "./api";
import { scenesController } from "./controller";

// Public scenes: kurviq.com/<name> for everyone (online/scenes/<name>.excalidraw,
// served at /scenes/<name>.excalidraw). The first visit puts a local-only copy
// into the browser, which the visitor may change like any scene; a newer
// version replaces the copy as long as the visitor hasn't changed it.
const PUBLIC_SCENES = IS_ONLINE ? ["features"] : [];
const PUBLIC_KEY = "kurviq-public-scenes";

const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
};

/** what the visitor would notice: which elements, where, saying what */
const contentHash = (json: string) =>
  hash(
    JSON.stringify(
      (JSON.parse(json).elements ?? [])
        .filter((el: any) => !el.isDeleted)
        .map((el: any) => [el.id, Math.round(el.x), Math.round(el.y), Math.round(el.width), Math.round(el.height), el.text ?? ""]),
    ),
  );

const readSeeded = (): Record<string, { version: string; content: string }> => {
  try {
    return JSON.parse(localStorage.getItem(PUBLIC_KEY) || "{}");
  } catch {
    return {};
  }
};

const seedPublicScene = async (name: string) => {
  if (!PUBLIC_SCENES.includes(name)) {
    return;
  }
  const response = await fetch(`/scenes/${encodeURIComponent(name)}.excalidraw`, { cache: "no-cache" });
  if (!response.ok) {
    return;
  }
  const json = await response.text();
  const version = hash(json);
  const seeded = readSeeded();
  if (scenesController.isLocalOnly(name)) {
    const previous = seeded[name];
    if (
      !previous ||
      previous.version === version ||
      contentHash(await scenesController.localOnlyJson(name)) !== previous.content
    ) {
      return; // up to date, or changed by the visitor: theirs now
    }
  }
  try {
    await scenesController.createLocalOnly(name, json, { replace: true });
  } catch (error: any) {
    if (error.status === 409) {
      return; // the visitor has a synced scene of that name: theirs wins
    }
    throw error;
  }
  seeded[name] = { version, content: contentHash(await scenesController.localOnlyJson(name)) };
  try {
    localStorage.setItem(PUBLIC_KEY, JSON.stringify(seeded));
  } catch {}
};

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

const navigateTo = async (name: string) => {
  await seedPublicScene(name).catch((error) => console.error(`[scenes] public scene "${name}"`, error));
  await scenesController.openOrCreate(name).catch((error) => {
    console.error(`[scenes] could not open "${name}" from URL`, error);
  });
};

/** open a public scene from a link in the app (e.g. the welcome screen) */
export const openPublicScene = (name: string) => navigateTo(name);

let connected = false;

export const connectRouter = async () => {
  if (connected) {
    return;
  }
  connected = true;

  const syncUrl = (mode: "push" | "replace") => {
    const { current, busy } = scenesController.getState();
    if (busy === "loading") {
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

  await scenesController.ready;

  const target = sceneFromPath();
  if (target !== null) {
    await navigateTo(target);
  }
  syncUrl("replace");

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
    if (name !== null && name !== scenesController.getState().current) {
      navigateTo(name);
    }
  });
};
