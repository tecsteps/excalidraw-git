// Kurviq: the agent pairing of this browser. A random key, made here and
// kept in localStorage, is the agent's MCP address (https://kurviq.com/mcp/<key>).
// Agents reach this browser's open Kurviq tabs through it — no account, no
// login. Whoever has the link can use Kurviq like you while a tab is open,
// so it can be replaced with a new one at any time.

const KEY = "kurviq-agent-key";
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

// another tab made or replaced the key
window.addEventListener("storage", (event) => {
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
  mcpUrl: (value = key) => (value ? `${window.location.origin}/mcp/${value}` : null),
  liveUrl: (tab: string) =>
    key ? `${window.location.origin.replace(/^http/, "ws")}/live/${key}?tab=${encodeURIComponent(tab)}` : null,
};
