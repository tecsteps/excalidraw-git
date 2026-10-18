// Scene URLs: http://draw.test/<scene name> opens that scene (creating it
// locally if it doesn't exist yet) and the URL follows the current scene.

import { scenesController } from "./controller";

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
