// Kurviq: the agent pairing of this browser. A random key, made here and
// kept in localStorage, ties agents to this browser's open Kurviq tabs.
// Agents add https://kurviq.com/mcp and sign in: the user allows each one on
// Kurviq's approval page, which reads this key (see online/worker/oauth.ts).
// A new key ("Sign out all agents") cuts every agent off. The old way, the key
// in the agent's URL (https://kurviq.com/mcp/<key>), works only while the
// user allows it here.

const KEY = "kurviq-agent-key";
/** the old link (key in the URL, no sign-in) is answered by this browser's tabs */
const LEGACY_KEY = "kurviq-agent-legacy-link";
const listeners = new Set<() => void>();

const makeKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

let key: string | null = read();

const write = (value: string | null) => {
  key = value;
  try {
    if (value) {
      localStorage.setItem(KEY, value);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {}
  listeners.forEach((listener) => listener());
};

let legacyLink = (() => {
  try {
    return localStorage.getItem(LEGACY_KEY) === "1";
  } catch {
    return false;
  }
})();

// another tab made or replaced the key (or changed the old-link setting)
window.addEventListener("storage", (event) => {
  if (event.key === LEGACY_KEY) {
    legacyLink = event.newValue === "1";
    listeners.forEach((listener) => listener());
  }
  if (event.key === KEY) {
    key = read();
    listeners.forEach((listener) => listener());
  }
});

export const pairing = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getKey: () => key,
  /** off (default): only signed-in agents are answered */
  legacyLink: () => legacyLink,
  setLegacyLink: (value: boolean) => {
    legacyLink = value;
    try {
      if (value) {
        localStorage.setItem(LEGACY_KEY, "1");
      } else {
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch {}
    listeners.forEach((listener) => listener());
  },
  /** the key, made on first use */
  ensureKey: () => {
    if (!key) {
      write(makeKey());
    }
    return key!;
  },
  /** a new link: agents with the old one lose access */
  reset: () => write(makeKey()),
  /** agents off: no key, tabs disconnect */
  remove: () => write(null),
  /** what agents add: they sign in there */
  mcpUrl: () => `${window.location.origin}/mcp`,
  /** the old link, with the key */
  legacyUrl: (value = key) => (value ? `${window.location.origin}/mcp/${value}` : null),
  liveUrl: (tab: string) =>
    key ? `${window.location.origin.replace(/^http/, "ws")}/live/${key}?tab=${encodeURIComponent(tab)}` : null,
};
