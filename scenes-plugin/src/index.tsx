// UI of the scenes plugin. Injected into excalidraw-app by ../vite.config.mts:
//  - <ScenesTopLeftUI/> via the `renderTopLeftUI` prop of <Excalidraw/>
//  - <ScenesSidebar/> as a child of <Excalidraw/> (custom <Sidebar/>)

import { Sidebar, useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  ExternalLinkIcon,
  GithubIcon,
  LoadIcon,
  PlusIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { SCENE_NAME_RE } from "./api";
import { IDLE_PUSH_MS, scenesController } from "./controller";
import { IS_RENDERER, connectLive } from "./live";
import { connectRouter } from "./router";
import { deck } from "./deck";
import { PresentationOverlay } from "./present";
import { SLIDES_SIDEBAR_NAME, SlidesSidebar } from "./slidesUI";

import type { Activity, SceneListItem, ScenesState, SyncStatus } from "./controller";

import "./scenes.scss";

export const SCENES_SIDEBAR_NAME = "scenes";

const UNTITLED_LABEL = "Untitled";

/** errors are surfaced through the controller state, nothing to do here */
const ignore = () => {};

const useScenes = () =>
  useSyncExternalStore(scenesController.subscribe, scenesController.getState);

// -----------------------------------------------------------------------------
// scene filter: sticky (localStorage), e.g. "Madsack" to show only that
// customer's scenes while sharing the screen — in the switcher, the sidebar
// list and the activity log. The open scene is always shown.
// -----------------------------------------------------------------------------

const FILTER_KEY = "excalidraw-scenes-filter";
const filterListeners = new Set<() => void>();
let sceneFilter = (() => {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
})();

const setSceneFilter = (value: string) => {
  sceneFilter = value;
  try {
    if (value) {
      localStorage.setItem(FILTER_KEY, value);
    } else {
      localStorage.removeItem(FILTER_KEY);
    }
  } catch {}
  filterListeners.forEach((listener) => listener());
};

const useSceneFilter = () =>
  useSyncExternalStore(
    (listener) => {
      filterListeners.add(listener);
      return () => filterListeners.delete(listener);
    },
    () => sceneFilter,
  );

const matchesFilter = (name: string | null, filter: string, current: string | null) => {
  const needle = filter.trim().toLowerCase();
  return !needle || name === current || (name ?? UNTITLED_LABEL).toLowerCase().includes(needle);
};

/** re-render periodically for "checked 20s ago" */
const useNow = (intervalMs = 5000) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

const useAttachController = () => {
  const api = useExcalidrawAPI();
  useEffect(() => {
    if (api) {
      scenesController.attach(api);
      connectLive();
      if (!IS_RENDERER) {
        deck.attach(api);
        connectRouter();
        scenesController.startSync();
      }
    }
  }, [api]);
  return api;
};

const ago = (iso: string | number | null, now: number) => {
  if (!iso) {
    return "never";
  }
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

const STATUS: Record<SyncStatus, { icon: string; label: string; tone: string }> = {
  synced: { icon: "✓", label: "Synced", tone: "ok" },
  ahead: { icon: "↑", label: "Not pushed", tone: "warn" },
  behind: { icon: "↓", label: "Newer on GitHub", tone: "info" },
  diverged: { icon: "⇅", label: "Changed on both sides", tone: "warn" },
  conflict: { icon: "!", label: "Conflict", tone: "danger" },
  local: { icon: "○", label: "Not on GitHub yet", tone: "muted" },
  "local-only": { icon: "⌂", label: "Local only", tone: "muted" },
  untitled: { icon: "○", label: "Not saved", tone: "muted" },
};

const isOffline = (state: ScenesState) =>
  state.sync.serverReachable === false || state.sync.githubOnline === false;

const StatusBadge = ({ status, compact }: { status: SyncStatus; compact?: boolean }) => {
  const info = STATUS[status];
  return (
    <span className={clsx("scenes-status", `scenes-status--${info.tone}`)} title={info.label}>
      <span className="scenes-status__icon">{info.icon}</span>
      {!compact && <span className="scenes-status__label">{info.label}</span>}
    </span>
  );
};

// -----------------------------------------------------------------------------
// top-left pill: current scene name + sync status, opens the sidebar
// -----------------------------------------------------------------------------

export const ScenesTopLeftUI = ({ isMobile }: { isMobile: boolean }) => {
  const api = useAttachController();
  const state = useScenes();
  const { current, busy, list } = state;
  const status = list.find((item) => item.name === current)?.status ?? "untitled";
  const offline = isOffline(state);
  const [open, setOpen] = useState(false);

  return (
    <div className="scenes-switcher">
      <button
        type="button"
        className={clsx("scenes-pill", { "scenes-pill--mobile": isMobile, "scenes-pill--open": open })}
        title={`${STATUS[status].label}${offline ? " · offline" : ""} — switch scene`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="scenes-pill__icon">{LoadIcon}</span>
        <span className="scenes-pill__name">{current ?? UNTITLED_LABEL}</span>
        {state.checking ? (
          <span className="scenes-pill__status" title="Local copy, read-only while GitHub is checked">checking…</span>
        ) : busy === "saving" || state.sync.running ? (
          <span className="scenes-pill__status">syncing…</span>
        ) : (
          status !== "synced" && <StatusBadge status={status} compact />
        )}
        {offline && <span className="scenes-pill__offline" title="Offline — working locally">offline</span>}
        <span className="scenes-pill__caret" aria-hidden>▾</span>
      </button>
      {!isMobile && (
        <button
          type="button"
          className="scenes-pill scenes-slides-btn"
          title="Slides: present this scene, edit the deck"
          onClick={() => api?.toggleSidebar({ name: SLIDES_SIDEBAR_NAME })}
        >
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
            <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10 13.5v3M6.5 16.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Slides
        </button>
      )}
      {open && (
        <SceneSwitcher
          onClose={() => setOpen(false)}
          onManage={() => {
            setOpen(false);
            api?.toggleSidebar({ name: SCENES_SIDEBAR_NAME, force: true });
          }}
        />
      )}
    </div>
  );
};

/**
 * Quick switch: the scenes as a dropdown under the pill. Type to filter,
 * arrows + Enter to pick, Esc to close; "Manage scenes…" opens the sidebar.
 */
const SceneSwitcher = ({ onClose, onManage }: { onClose: () => void; onManage: () => void }) => {
  const { current, list } = useScenes();
  const query = useSceneFilter();
  const [active, setActive] = useState(0);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-switcher")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const items = list.filter((item) => matchesFilter(item.name, query, current));
  // "create" only when the text matches no scene (a sticky filter such as a
  // customer name shouldn't offer itself as a new scene every time)
  const canCreate =
    !!needle &&
    SCENE_NAME_RE.test(query.trim()) &&
    !list.some((item) => (item.name ?? UNTITLED_LABEL).toLowerCase().includes(needle));
  const count = items.length + (canCreate ? 1 : 0);

  const choose = (index: number) => {
    onClose();
    if (index < items.length) {
      const { name } = items[index];
      if (name !== current) {
        scenesController.open(name).catch(ignore);
      }
    } else if (canCreate) {
      scenesController.openOrCreate(query.trim()).catch(ignore);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // keep Excalidraw's own shortcuts out of the way while typing here
    event.stopPropagation();
    if (event.key === "Escape") {
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (count ? (index + 1) % count : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (count ? (index - 1 + count) % count : 0));
    } else if (event.key === "Enter" && count) {
      event.preventDefault();
      choose(Math.min(active, count - 1));
    }
  };

  return (
    <div className="scenes-switcher__menu" role="listbox" onKeyDown={onKeyDown}>
      <div className="scenes-switcher__filter">
        <input
          autoFocus
          placeholder="Filter or create a scene…"
          value={query}
          onChange={(event) => {
            setSceneFilter(event.target.value);
            setActive(0);
          }}
        />
        {query && (
          <button
            type="button"
            className="scenes-switcher__clear"
            title="Clear the filter (show all scenes)"
            aria-label="Clear the filter"
            onClick={() => {
              setSceneFilter("");
              setActive(0);
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className="scenes-switcher__list">
        {items.map((item, index) => (
          <button
            type="button"
            role="option"
            aria-selected={item.name === current}
            key={item.name ?? "\u0000untitled"}
            className={clsx("scenes-switcher__item", {
              "scenes-switcher__item--current": item.name === current,
              "scenes-switcher__item--active": index === active,
            })}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(index)}
          >
            <span className="scenes-switcher__name">{item.name ?? UNTITLED_LABEL}</span>
            {item.status !== "synced" && <StatusBadge status={item.status} compact />}
          </button>
        ))}
        {canCreate && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            className={clsx("scenes-switcher__item", "scenes-switcher__item--create", {
              "scenes-switcher__item--active": active === items.length,
            })}
            onMouseEnter={() => setActive(items.length)}
            onClick={() => choose(items.length)}
          >
            + Create “{query.trim()}”
          </button>
        )}
        {!count && <div className="scenes-switcher__empty">No scene matches</div>}
      </div>
      <button type="button" className="scenes-switcher__manage" onClick={onManage}>
        Manage scenes…
      </button>
    </div>
  );
};

// -----------------------------------------------------------------------------
// sidebar
// -----------------------------------------------------------------------------

/** https://github.com/owner/repo from https / ssh remote URLs */
const repoInfo = (() => {
  const raw = (import.meta.env.VITE_APP_SCENES_GIT_REPO || "").trim();
  const match = raw.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    return null;
  }
  return {
    url: `https://github.com/${match[1]}/${match[2]}`,
    owner: match[1],
    name: match[2],
    branch: import.meta.env.VITE_APP_SCENES_GIT_BRANCH || "main",
  };
})();

const RepoLink = () =>
  repoInfo ? (
    <a
      className="scenes-repo"
      href={repoInfo.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${repoInfo.url} in a new tab`}
    >
      <span className="scenes-repo__logo">{GithubIcon}</span>
      <span className="scenes-repo__text">
        <span className="scenes-repo__caption">
          Synced with GitHub
          <span className="scenes-repo__branch">{repoInfo.branch}</span>
        </span>
        <span className="scenes-repo__name">
          <span className="scenes-repo__owner">{repoInfo.owner}/</span>
          <wbr />
          {repoInfo.name}
        </span>
      </span>
      <span className="scenes-repo__external">{ExternalLinkIcon}</span>
    </a>
  ) : null;

/** connection + auto-sync bar at the top of the sidebar */
const SyncBar = ({ state, now }: { state: ScenesState; now: number }) => {
  const { sync, autoSync } = state;
  const pending = scenesController.pendingCount();
  const deletes = scenesController.pendingDeletes();
  let tone = "ok";
  let text: string;
  if (sync.serverReachable === false) {
    tone = "danger";
    text = "Scenes server not running — working locally";
  } else if (sync.githubOnline === false) {
    tone = "danger";
    text = "GitHub not reachable — working locally";
  } else if (sync.githubOnline === null) {
    tone = "muted";
    text = "Connecting to GitHub…";
  } else {
    text = `GitHub · checked ${ago(sync.lastCheckedAt, now)}`;
  }

  return (
    <section className="scenes-syncbar">
      <div className="scenes-syncbar__row">
        <span className={clsx("scenes-syncbar__dot", `scenes-syncbar__dot--${tone}`)} />
        <span className="scenes-syncbar__text">{text}</span>
        <button
          type="button"
          className="scenes-link"
          disabled={sync.running}
          onClick={() => scenesController.syncNow({ refresh: true })}
        >
          {sync.running ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {pending > 0 && (
        <div className="scenes-syncbar__pending">
          {pending} scene{pending === 1 ? "" : "s"} with changes not on GitHub yet
          {isOffline(state) ? " — will sync when back online" : ""}
        </div>
      )}
      {deletes.length > 0 && (
        <div className="scenes-syncbar__pending">
          Deleted here, still on GitHub: {deletes.map((name) => `“${name}”`).join(", ")} — deleted there once
          reachable
        </div>
      )}
      <label className="scenes-switch">
        <input
          type="checkbox"
          checked={autoSync}
          onChange={(event) => scenesController.setGlobalAutoSync(event.target.checked)}
        />
        <span className="scenes-switch__track" />
        <span className="scenes-switch__label">
          Auto-sync
          <span className="scenes-switch__hint">
            {autoSync
              ? `push after ${IDLE_PUSH_MS / 1000}s idle, pull & merge automatically`
              : "only when you click Save / Sync now"}
          </span>
        </span>
      </label>
    </section>
  );
};

const currentStatusText = (
  status: SyncStatus,
  { autoSync, offline, empty }: { autoSync: boolean; offline: boolean; empty: boolean },
) => {
  switch (status) {
    case "synced":
      return "Same as on GitHub";
    case "ahead":
      return offline
        ? "Local changes — will be pushed when GitHub is reachable"
        : autoSync
        ? `Local changes — pushed automatically after ${IDLE_PUSH_MS / 1000}s without edits`
        : "Local changes — not pushed (auto-sync is off for this scene)";
    case "behind":
      return autoSync ? "Newer version on GitHub — updating…" : "A newer version is on GitHub";
    case "diverged":
      return autoSync
        ? "Changed here and on GitHub — merging…"
        : "Changed here and on GitHub — Save merges both";
    case "conflict":
      return "You and GitHub changed the same elements";
    case "local":
      return empty
        ? "New, empty scene — only in this browser"
        : autoSync
        ? "Only in this browser — pushed automatically after a short pause"
        : "Only in this browser — Save to put it on GitHub";
    case "local-only":
      return "Local only — stays in this browser, never synced to GitHub. Switch it to auto-sync below to put it on GitHub.";
    case "untitled":
      return empty ? "Empty — draw something, then save it" : "Not saved yet — give it a name";
  }
};

type NamePrompt =
  | null
  | { mode: "save" | "saveAs" | "new" }
  /** on an existing scene (from the current card or the list) */
  | { mode: "rename" | "duplicate"; scene: string };

const NameForm = ({
  prompt,
  initialValue,
  onSubmit,
  onCancel,
}: {
  prompt: Exclude<NamePrompt, null>;
  initialValue: string;
  onSubmit: (name: string, options: { localOnly: boolean }) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initialValue);
  const offersLocalOnly = prompt.mode === "new" || prompt.mode === "save";
  const [localOnly, setLocalOnly] = useState(false);
  const label = {
    save: "Name & save",
    saveAs: "Save as",
    new: "Create",
    rename: "Rename",
    duplicate: "Duplicate",
  }[prompt.mode];

  return (
    <form
      className="scenes-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) {
          onSubmit(value.trim(), { localOnly: offersLocalOnly && localOnly });
        }
      }}
    >
      <input
        autoFocus
        className="scenes-input"
        placeholder={prompt.mode === "duplicate" ? "Name of the copy" : prompt.mode === "rename" ? "New name" : "Scene name"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // keep editor shortcuts from firing while typing
          event.stopPropagation();
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
      {offersLocalOnly && (
        <label className="scenes-form__check" title="Kept only in this browser. You can sync it later (scene settings below).">
          <input type="checkbox" checked={localOnly} onChange={(event) => setLocalOnly(event.target.checked)} />
          Local only (not synced to GitHub)
        </label>
      )}
      <div className="scenes-row">
        <button type="submit" className="scenes-btn scenes-btn--primary">
          {label}
        </button>
        <button type="button" className="scenes-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const ConflictBox = ({ name, clashes }: { name: string; clashes: number }) => {
  const [copyName, setCopyName] = useState<string | null>(null);
  return (
    <div className="scenes-conflict">
      <div className="scenes-conflict__title">Conflict</div>
      <div className="scenes-conflict__text">
        You and GitHub both changed {clashes} element{clashes === 1 ? "" : "s"} of this scene.
        Nothing is lost until you choose:
      </div>
      <div className="scenes-conflict__actions">
        <button type="button" className="scenes-btn" onClick={() => scenesController.keepMine(name).catch(ignore)}>
          Keep mine
          <span className="scenes-btn__hint">overwrite GitHub</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => {
            if (window.confirm(`Discard your version of "${name}" and take the one from GitHub?`)) {
              scenesController.takeTheirs(name).catch(ignore);
            }
          }}
        >
          Take GitHub's
          <span className="scenes-btn__hint">discard mine</span>
        </button>
        <button
          type="button"
          className="scenes-btn"
          onClick={() => scenesController.keepBoth(name).then(setCopyName, ignore)}
        >
          Keep both
          <span className="scenes-btn__hint">mine as a copy</span>
        </button>
      </div>
      {copyName && <div className="scenes-conflict__text">Your version is now “{copyName}”.</div>}
    </div>
  );
};

const SceneAutoSync = ({ item, global }: { item: SceneListItem; global: boolean }) => {
  const name = item.name!;
  const override = scenesController.sceneAutoSyncOverride(name);
  const value = item.localOnly ? "local" : override === undefined ? "default" : override ? "on" : "off";
  return (
    <label className="scenes-scene-sync">
      This scene:
      <select
        value={value}
        onChange={async (event) => {
          const next = event.target.value;
          try {
            if (next === "local") {
              await scenesController.setLocalOnly(name, true);
              return;
            }
            scenesController.setSceneAutoSync(name, next === "default" ? undefined : next === "on");
            await scenesController.setLocalOnly(name, false);
          } catch (error: any) {
            window.alert(error.message);
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <option value="default">auto-sync {global ? "on" : "off"} (default)</option>
        <option value="on">always auto-sync</option>
        <option value="off">manual only</option>
        <option value="local">local only, never on GitHub</option>
      </select>
    </label>
  );
};

/** confirm text for deleting a scene — says exactly what will be lost */
const confirmDelete = (item: SceneListItem) => {
  const name = item.name!;
  const unpushed = item.dirty || ["ahead", "diverged", "conflict"].includes(item.status);
  const lines = [
    `Delete “${name}”?`,
    item.localOnly
      ? item.onGitHub
        ? "It is local only: it is deleted in this browser. The older copy on GitHub is not touched."
        : "It only exists in this browser — it will be gone."
      : item.onGitHub
      ? "It is deleted here and on GitHub (it stays in the repository's git history)."
      : "It only exists in this browser — it will be gone.",
    unpushed && !item.localOnly ? "Its changes that are not on GitHub yet are lost." : null,
  ];
  return window.confirm(lines.filter(Boolean).join("\n\n"));
};

const SceneMenu = ({
  item,
  onPrompt,
  onClose,
}: {
  item: SceneListItem;
  onPrompt: (prompt: NamePrompt) => void;
  onClose: () => void;
}) => {
  const name = item.name!;
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".scenes-menu")) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  return (
    <div className="scenes-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => onPrompt({ mode: "rename", scene: name })}>
        Rename…
      </button>
      <button type="button" role="menuitem" onClick={() => onPrompt({ mode: "duplicate", scene: name })}>
        Duplicate…
      </button>
      <button
        type="button"
        role="menuitem"
        className="scenes-menu__danger"
        onClick={() => {
          onClose();
          if (confirmDelete(item)) {
            scenesController.remove(name).catch(ignore);
          }
        }}
      >
        Delete
      </button>
    </div>
  );
};

const SceneRow = ({
  item,
  active,
  disabled,
  menuOpen,
  onMenu,
  prompt,
  onPrompt,
  onSubmitName,
}: {
  item: SceneListItem;
  active: boolean;
  disabled: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  prompt: NamePrompt;
  onPrompt: (prompt: NamePrompt) => void;
  onSubmitName: (name: string, options: { localOnly: boolean }) => void;
}) => {
  const rowPrompt =
    prompt && "scene" in prompt && prompt.scene === item.name && !active ? prompt : null;
  return (
    <li className="scenes-list__row">
      <div className={clsx("scenes-item", { "scenes-item--active": active })}>
        <button
          type="button"
          className="scenes-item__open"
          disabled={disabled}
          onClick={() => scenesController.open(item.name).catch(ignore)}
          title={[
            STATUS[item.status].label,
            item.pendingRename ? `still “${item.pendingRename}” on GitHub` : null,
            item.updatedAt ? `last change on GitHub: ${new Date(item.updatedAt).toLocaleString()}` : null,
            item.name !== null && !item.autoSync && !item.localOnly ? "manual sync" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="scenes-item__name">{item.name ?? <em>{UNTITLED_LABEL}</em>}</span>
          {item.name !== null && !item.autoSync && !item.localOnly && <span className="scenes-item__manual">manual</span>}
          <StatusBadge status={item.status} compact={item.status === "synced"} />
        </button>
        {item.name !== null && (
          <button
            type="button"
            className={clsx("scenes-item__more", { "scenes-item__more--open": menuOpen })}
            disabled={disabled}
            title="Rename, duplicate or delete"
            aria-label={`Actions for ${item.name}`}
            onClick={() => onMenu(!menuOpen)}
          >
            ⋯
          </button>
        )}
        {menuOpen && <SceneMenu item={item} onPrompt={onPrompt} onClose={() => onMenu(false)} />}
      </div>
      {rowPrompt && (
        <NameForm
          key={`${rowPrompt.mode}:${rowPrompt.scene}`}
          prompt={rowPrompt}
          initialValue={rowPrompt.mode === "duplicate" ? `${rowPrompt.scene} copy` : rowPrompt.scene}
          onSubmit={onSubmitName}
          onCancel={() => onPrompt(null)}
        />
      )}
    </li>
  );
};

const ActivityLog = ({ activity: all, now, hidden }: { activity: Activity[]; now: number; hidden: string[] }) => {
  const [open, setOpen] = useState(false);
  // entries naming a filtered-out scene are not shown
  const activity = all.filter((entry) => !hidden.some((name) => entry.text.includes(`"${name}"`)));
  if (!activity.length) {
    return null;
  }
  const shown = open ? activity.slice(0, 15) : activity.slice(0, 2);
  return (
    <section className="scenes-activity">
      <div className="scenes-list-header">
        <span>Activity</span>
        {activity.length > 2 && (
          <button type="button" className="scenes-link" onClick={() => setOpen(!open)}>
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      <ul>
        {shown.map((entry) => (
          <li key={`${entry.at}-${entry.text}`} className={`scenes-activity__item scenes-activity__item--${entry.kind}`}>
            <span className="scenes-activity__time">{ago(entry.at, now)}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const ScenesSidebar = () => {
  useAttachController();
  const state = useScenes();
  const { current, busy, error, list, remote, autoSync, conflict, activity } = state;
  const [prompt, setPrompt] = useState<NamePrompt>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const now = useNow();
  const filter = useSceneFilter();
  const shownList = list.filter((item) => matchesFilter(item.name, filter, current));
  const hiddenNames = list
    .filter((item) => item.name !== null && !matchesFilter(item.name, filter, current))
    .map((item) => item.name!);

  const isBusy = !!busy;
  const currentItem = list.find((item) => item.name === current);
  const status = currentItem?.status ?? "untitled";
  const sceneAutoSync = scenesController.autoSyncFor(current);
  const empty = !scenesController.getApi()?.getSceneElements().length;
  // rename / duplicate of the open scene happen in the card, others in the list
  const currentPrompt =
    prompt && (!("scene" in prompt) || prompt.scene === current) ? prompt : null;

  const submitName = async (name: string, { localOnly = false }: { localOnly?: boolean } = {}) => {
    if (!prompt) {
      return;
    }
    try {
      if (prompt.mode === "new") {
        await scenesController.create(name, { localOnly });
      } else if (prompt.mode === "rename") {
        await scenesController.rename(prompt.scene, name);
      } else if (prompt.mode === "duplicate") {
        await scenesController.clone(prompt.scene, name);
      } else {
        await scenesController.save(name, prompt.mode === "save" ? { localOnly } : {});
      }
      setPrompt(null);
    } catch {}
  };

  return (
    <>
    <Sidebar name={SCENES_SIDEBAR_NAME} className="scenes-sidebar">
      <Sidebar.Header>
        <div className="scenes-sidebar__title">Scenes</div>
      </Sidebar.Header>
      <div className="scenes-sidebar__body">
        <SyncBar state={state} now={now} />

        <section className="scenes-current">
          <div className="scenes-current__label">Current scene</div>
          <div className="scenes-current__name">
            {current ?? <em>{UNTITLED_LABEL}</em>}
            {current !== null && <StatusBadge status={status} />}
          </div>
          <div className="scenes-current__status">
            {busy === "saving"
              ? "Pushing to GitHub…"
              : busy === "loading"
              ? "Loading…"
              : currentItem?.pendingRename
              ? `Renamed here — on GitHub it is still “${currentItem.pendingRename}”, renamed there once reachable`
              : currentStatusText(status, { autoSync: sceneAutoSync, offline: isOffline(state), empty })}
          </div>

          {conflict && current !== null && <ConflictBox name={current} clashes={conflict.clashes.length} />}

          {currentPrompt ? (
            <NameForm
              key={currentPrompt.mode}
              prompt={currentPrompt}
              initialValue={
                currentPrompt.mode === "saveAs" || currentPrompt.mode === "duplicate"
                  ? `${current} copy`
                  : currentPrompt.mode === "rename"
                  ? current ?? ""
                  : ""
              }
              onSubmit={submitName}
              onCancel={() => setPrompt(null)}
            />
          ) : (
            <div className="scenes-row">
              <button
                type="button"
                className="scenes-btn scenes-btn--primary"
                disabled={isBusy || !!conflict || status === "local-only"}
                title={status === "local-only" ? "Local only: kept in this browser, not pushed" : "Push to GitHub now"}
                onClick={() =>
                  current === null ? setPrompt({ mode: "save" }) : scenesController.save().catch(ignore)
                }
              >
                {save} Save
              </button>
              {current !== null && (
                <button type="button" className="scenes-btn" disabled={isBusy} onClick={() => setPrompt({ mode: "saveAs" })}>
                  Save as…
                </button>
              )}
              <button type="button" className="scenes-btn" disabled={isBusy} onClick={() => setPrompt({ mode: "new" })}>
                {PlusIcon} New
              </button>
            </div>
          )}

          {current !== null && !currentPrompt && currentItem && (
            <div className="scenes-current__manage">
              <button type="button" className="scenes-link" disabled={isBusy} onClick={() => setPrompt({ mode: "rename", scene: current })}>
                Rename
              </button>
              <button type="button" className="scenes-link" disabled={isBusy} onClick={() => setPrompt({ mode: "duplicate", scene: current })}>
                Duplicate
              </button>
              <button
                type="button"
                className="scenes-link scenes-link--danger"
                disabled={isBusy}
                onClick={() => confirmDelete(currentItem) && scenesController.remove(current).catch(ignore)}
              >
                Delete
              </button>
            </div>
          )}

          {current !== null && !currentPrompt && (
            <div className="scenes-current__footer">
              {currentItem && <SceneAutoSync item={currentItem} global={autoSync} />}
              {(status === "behind" || status === "ahead" || status === "diverged") && currentItem?.onGitHub && (
                <button
                  type="button"
                  className="scenes-link"
                  disabled={isBusy}
                  onClick={() => {
                    if (
                      status === "behind" ||
                      window.confirm(`Discard your local changes to "${current}" and load the version from GitHub?`)
                    ) {
                      scenesController.discardLocal(current).catch(ignore);
                    }
                  }}
                >
                  {status === "behind" ? "Load newer version" : "Discard local changes"}
                </button>
              )}
            </div>
          )}
        </section>

        {error && <div className="scenes-error">{error}</div>}

        <section className="scenes-list-section">
          <div className="scenes-list-header">
            <span>{filter.trim() ? "Scenes" : "All scenes"}</span>
            {filter.trim() && (
              <span className="scenes-filter-chip" title="Set in the scene switcher (top left)">
                filter: {filter.trim()}
                <button type="button" aria-label="Clear the filter" title="Clear the filter" onClick={() => setSceneFilter("")}>
                  ×
                </button>
              </span>
            )}
          </div>
          {remote === null && list.length === 0 && <div className="scenes-empty">Loading…</div>}
          {list.length === 0 && remote !== null && <div className="scenes-empty">No scenes yet</div>}
          <ul className="scenes-list">
            {shownList.map((item) => (
              <SceneRow
                key={item.name ?? "\u0000untitled"}
                item={item}
                active={item.name === current}
                disabled={isBusy}
                menuOpen={menuFor !== null && menuFor === item.name}
                onMenu={(open) => setMenuFor(open ? item.name : null)}
                prompt={prompt}
                onPrompt={(next) => {
                  setMenuFor(null);
                  setPrompt(next);
                }}
                onSubmitName={submitName}
              />
            ))}
          </ul>
        </section>

        <ActivityLog activity={activity} now={now} hidden={hiddenNames} />

        <RepoLink />
      </div>
    </Sidebar>
    <SlidesSidebar />
    <PresentationOverlay />
    </>
  );
};
