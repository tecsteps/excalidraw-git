// Which build of Kurviq this tab runs. The Worker sends its own build with
// every agent command: a tab still running an older version (the service
// worker keeps it until a reload) refuses agent commands with a clear message
// and asks the user to reload, instead of half-working with old code.

export const BUILD: string = import.meta.env.VITE_APP_KURVIQ_BUILD || "";

let outdated = false;
const listeners = new Set<() => void>();

export const appVersion = {
  isOutdated: () => outdated,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** the server runs another build: true if this tab is outdated (and says so once) */
export const checkServerBuild = (serverBuild: unknown) => {
  if (!BUILD || typeof serverBuild !== "string" || !serverBuild || serverBuild === BUILD) {
    return false;
  }
  if (!outdated) {
    outdated = true;
    listeners.forEach((listener) => listener());
    // fetch the new version now, so a reload gets it
    navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => {});
  }
  return true;
};

export const OUTDATED_MESSAGE =
  "Kurviq in the user's browser is an older version than the server (it was updated). Ask the user to reload the Kurviq tab (the banner in Kurviq has a Reload button; their work is saved), then try again.";

/** reload into the new version (the service worker fetches it first) */
export const reloadApp = async () => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {}
  window.location.reload();
};
