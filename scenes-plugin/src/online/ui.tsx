// Kurviq's own UI (online build only): Connect GitHub + repo choice in the
// Scenes sidebar, the "MCP" button with the agent link and prompt, and the
// footer (built on Excalidraw, llms.txt).

import { WelcomeScreen } from "@excalidraw/excalidraw";
import { GithubIcon, ExternalLinkIcon } from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState, useSyncExternalStore } from "react";

import { scenesController } from "../controller";

import {
  checkConnection,
  chooseRepo,
  connectGitHub,
  connection,
  disconnectGitHub,
  listRepos,
} from "./github";
import { pairing } from "./pairing";

import type { RepoChoice } from "./github";

import lilitaLatin from "@excalidraw/excalidraw/fonts/Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2";

import { openPublicScene } from "../router";

import "./online.scss";

const useConnection = () => useSyncExternalStore(connection.subscribe, connection.getState);
const usePairingKey = () => useSyncExternalStore(pairing.subscribe, pairing.getKey);

// -----------------------------------------------------------------------------
// start: is this browser connected? (and the answer of a GitHub redirect)
// -----------------------------------------------------------------------------

let notice: string | null = null;
let started = false;
/** the answer of a GitHub redirect, read before anything can rewrite the URL */
const githubAnswer = new URLSearchParams(window.location.search).get("github");

/** the installation GitHub just made or changed (its repositories were picked there) */
const githubInstallation = Number(new URLSearchParams(window.location.search).get("installation")) || undefined;

// the end of "Connect GitHub", as a dialog: sync is on (one repository was
// picked on GitHub), or pick one (several, or none known)
type Setup = null | { step: "pick"; only?: number } | { step: "done"; repo: RepoChoice; published: number };
let setup: Setup = null;
const setupListeners = new Set<() => void>();
const setSetup = (next: Setup) => {
  setup = next;
  setupListeners.forEach((listener) => listener());
};
const useSetup = () =>
  useSyncExternalStore(
    (listener) => {
      setupListeners.add(listener);
      return () => {
        setupListeners.delete(listener);
      };
    },
    () => setup,
  );

const localOnlyScenes = () =>
  scenesController
    .getState()
    .list.filter((item) => item.name !== null && item.localOnly)
    .map((item) => item.name!);

/** sync with this repository from now on; returns how many local-only scenes went along */
const activateRepo = async (repo: RepoChoice, { publishExisting }: { publishExisting: boolean }) => {
  const current = connection.getState().repo;
  const switching = !!current && (current.owner !== repo.owner || current.name !== repo.name);
  chooseRepo(repo);
  // from now on new scenes go to GitHub with auto-sync
  scenesController.setNewScenesLocalOnly(false);
  if (switching) {
    await scenesController.resetGitHubState();
  }
  let published = 0;
  if (publishExisting) {
    for (const name of localOnlyScenes()) {
      await scenesController.setLocalOnly(name, false).then(
        () => published++,
        () => {},
      );
    }
  }
  scenesController.syncNow({ refresh: true });
  return published;
};

/** back from GitHub: finish the setup */
const finishConnect = async (repo: RepoChoice | undefined) => {
  // repositories picked on GitHub just now; without an installation (plain
  // sign-in) only when there is no repository yet
  if (repo && !githubInstallation) {
    return;
  }
  try {
    const repos = await listRepos({ only: githubInstallation });
    const same = repos.length === 1 && repo && repos[0].owner === repo.owner && repos[0].name === repo.name;
    if (repos.length === 1 && !same) {
      const published = await activateRepo(repos[0], { publishExisting: true });
      setSetup({ step: "done", repo: repos[0], published });
    } else if (!same) {
      setSetup({ step: "pick", only: repos.length ? githubInstallation : undefined });
    }
  } catch {
    setSetup({ step: "pick" });
  }
};

export const startOnline = () => {
  if (started) {
    return;
  }
  started = true;
  // keep the scenes even under storage pressure (Safari, full disks)
  navigator.storage?.persist?.().catch(() => {});

  const params = new URLSearchParams(window.location.search);
  const answer = githubAnswer;
  if (answer) {
    notice =
      answer === "connected"
        ? null
        : answer === "cancelled"
        ? "GitHub connection cancelled."
        : "GitHub connection failed — please try again.";
    params.delete("github");
    params.delete("installation");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  // back from GitHub without a repository yet: show the next step right away
  let showSetup = answer === "connected";
  let last = "";
  connection.subscribe(() => {
    const { user, repo } = connection.getState();
    if (showSetup && user !== undefined) {
      showSetup = false;
      if (user) {
        finishConnect(repo);
      }
    }
    const key = JSON.stringify([user?.login ?? null, repo]);
    if (key !== last) {
      last = key;
      scenesController.syncNow({ refresh: true });
    }
  });
  checkConnection();
};

// -----------------------------------------------------------------------------
// sidebar: GitHub
// -----------------------------------------------------------------------------

const repoUrl = (repo: RepoChoice) => `https://github.com/${repo.owner}/${repo.name}`;

/** GitHub's "new repository" form, filled in (opens in a new tab) */
const NEW_REPO_URL = "https://github.com/new?name=kurviq-scenes&visibility=private&description=My+Kurviq+scenes";

/** GitHub's installation can't create a repository: that comes first, in a new tab */
const NewRepoHint = () => (
  <span className="kq-muted kq-left">
    Want a new one?{" "}
    <a href={NEW_REPO_URL} target="_blank" rel="noopener noreferrer">
      Create it on GitHub
    </a>{" "}
    first (private is fine), then choose it.
  </span>
);

/**
 * @param onDone shows "Cancel" and is called after "Activate sync" too
 * @param onActivated called after "Activate sync"
 */
const RepoPicker = ({
  onDone,
  onActivated,
  only,
}: {
  onDone?: () => void;
  onActivated?: () => void;
  /** just the repositories of this installation */
  only?: number;
}) => {
  const { repo: current } = useConnection();
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [publishExisting, setPublishExisting] = useState(true);

  useEffect(() => {
    let known = "";
    const load = () =>
      listRepos({ only })
        .then((found) => {
          const names = found.map((r) => `${r.owner}/${r.name}`);
          setRepos(found);
          setError(null);
          // a repository that just appeared (created / given access in another tab) is the one to pick
          const added = known ? names.find((name) => !known.split("\n").includes(name)) : undefined;
          known = names.join("\n");
          setPicked((picked) => {
            if (added) {
              return added;
            }
            if (picked && names.includes(picked)) {
              return picked;
            }
            const keep = current && names.find((name) => name === `${current.owner}/${current.name}`);
            return keep ?? names[0] ?? "";
          });
        })
        .catch((err) => setError(err.message));
    load();
    // back from GitHub's tab (new repository, access given): look again
    const onFocus = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const localOnly = localOnlyScenes();

  const activate = async () => {
    const repo = repos?.find((r) => `${r.owner}/${r.name}` === picked);
    if (!repo) {
      return;
    }
    await activateRepo(repo, { publishExisting });
    onDone?.();
    onActivated?.();
  };

  if (error) {
    return <div className="scenes-error">{error}</div>;
  }
  if (!repos) {
    return <div className="kq-muted">Loading your repositories…</div>;
  }
  if (!repos.length) {
    return (
      <div className="kq-stack">
        <div className="kq-muted">
          Kurviq has no access to a repository yet. On GitHub you pick the account or organization and the repository;
          Kurviq only sees what you pick, and syncs as soon as you're back.
        </div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
            Choose a repository on GitHub
          </button>
        </div>
        <NewRepoHint />
      </div>
    );
  }
  return (
    <div className="kq-stack">
      <label className="kq-field">
        <span>Repository</span>
        <select value={picked} onChange={(event) => setPicked(event.target.value)}>
          {repos.map((repo) => (
            <option key={`${repo.owner}/${repo.name}`} value={`${repo.owner}/${repo.name}`}>
              {repo.owner}/{repo.name}
              {repo.private ? " (private)" : ""}
            </option>
          ))}
        </select>
      </label>
      {localOnly.length > 0 && (
        <label className="kq-check">
          <input type="checkbox" checked={publishExisting} onChange={(event) => setPublishExisting(event.target.checked)} />
          <span>
            Also sync my {localOnly.length} existing scene{localOnly.length === 1 ? "" : "s"}
          </span>
        </label>
      )}
      <div className="scenes-row">
        <button type="button" className="scenes-btn scenes-btn--primary" disabled={!picked} onClick={activate}>
          Activate sync
        </button>
        {onDone && (
          <button type="button" className="scenes-btn" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      <button type="button" className="scenes-link kq-left" onClick={() => connectGitHub("install")}>
        Another repository? Give Kurviq access on GitHub…
      </button>
      <NewRepoHint />
    </div>
  );
};

/** in the scene dropdown: offer GitHub while it is not connected */
export const ConnectGitHubOffer = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <div className="kq-switcher-github">
      <span className="kq-muted">Scenes are saved in this browser only.</span>
      <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
        <span className="kq-icon">{GithubIcon}</span> Connect GitHub
      </button>
    </div>
  );
};

const LinkedInIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="currentColor">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
  </svg>
);

/** the welcome screen's text (injected by ../../vite.config.mts instead of upstream's) */
// the wordmark's font: Lilita One, which Excalidraw ships for the canvas
try {
  document.fonts.add(new FontFace("Kurviq Wordmark", `url(${lilitaLatin})`, { display: "block" }));
} catch {}

/** Kurviq's wordmark like Excalidraw's: the icon stands in for the "K" */
export const KurviqLogo = () => (
  <span className="kq-logo" role="img" aria-label="Kurviq">
    <svg className="kq-logo__icon" viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#6965db" />
      <path d="M20 15c-1 11-1 23 0 34" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
      <path
        d="M45 15C34 22 27 28 21.5 32.5 31 37 39 42 46 49.5"
        fill="none"
        stroke="#e0dfff"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <span className="kq-logo__text" aria-hidden>
      URVIQ
    </span>
  </span>
);

/** on the welcome screen (injected by ../../vite.config.mts), instead of upstream's storage warning */
export const WelcomeHeading = () => {
  const { user, repo } = useConnection();
  return (
    <div className="kq-welcome">
      <p>
        Kurviq is an extension of the excellent{" "}
        <a href="https://excalidraw.com" target="_blank" rel="noopener noreferrer">
          Excalidraw
        </a>{" "}
        that adds what I always wanted:{" "}
        <a
          href="/features"
          onClick={(event) => {
            event.preventDefault();
            openPublicScene("features");
          }}
        >
          kurviq.com/features
        </a>
      </p>
      <p className="kq-welcome__storage">
        {user && repo
          ? "Your drawings are saved in this browser and synced with GitHub."
          : user
          ? "Your drawings are saved in this browser. Choose a repository in the Scenes sidebar to sync them."
          : "Your drawings are saved in this browser. Connect GitHub to keep them safe in your repository."}
      </p>
      <a
        className="kq-welcome__signature"
        href="https://www.linkedin.com/in/fabian-wesner/"
        target="_blank"
        rel="noopener noreferrer"
        title="Fabian Wesner on LinkedIn"
      >
        – Fabian {LinkedInIcon}
      </a>
    </div>
  );
};

/** on the welcome screen (injected by ../../vite.config.mts), while GitHub is not connected */
export const WelcomeConnectGitHub = () => {
  const { user } = useConnection();
  if (user !== null) {
    return null;
  }
  return (
    <WelcomeScreen.Center.MenuItem onSelect={() => connectGitHub("install")} icon={GithubIcon} shortcut={null}>
      Connect GitHub to sync
    </WelcomeScreen.Center.MenuItem>
  );
};

/** top of the Scenes sidebar: the GitHub connection of this browser */
export const GitHubPanel = () => {
  const { user, repo, error } = useConnection();
  const [changing, setChanging] = useState(false);

  if (user === undefined) {
    return <section className="kq-card kq-muted">Checking GitHub connection…</section>;
  }
  if (!user) {
    return (
      <section className="kq-card">
        {notice && <div className="kq-notice">{notice}</div>}
        <div className="kq-card__title">Your scenes are saved in this browser</div>
        <div className="kq-muted">
          No account needed. Connect GitHub to sync them with a repository: on all your devices, with other people
          who use the same repository, and with your coding agents.
        </div>
        {error && <div className="scenes-error">{error}</div>}
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
            <span className="kq-icon">{GithubIcon}</span> Connect GitHub
          </button>
        </div>
        <span className="kq-muted kq-left">
          You pick the account and repository on GitHub, then sync starts.{" "}
          <button type="button" className="scenes-link" onClick={() => connectGitHub("login")}>
            Already set up? Sign in
          </button>
        </span>
        <NewRepoHint />
      </section>
    );
  }
  if (!repo || changing) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">
          Connected as <strong>{user.login}</strong>. One more step: which repository should your scenes sync with?
        </div>
        <div className="kq-muted">
          Scenes are stored as <code>scenes/&lt;name&gt;.excalidraw</code>. Everyone who picks the same repository
          shares its scenes; changes are merged.
        </div>
        <RepoPicker onDone={repo ? () => setChanging(false) : undefined} />
        {!repo && (
          <button type="button" className="scenes-link kq-left" onClick={() => disconnectGitHub()}>
            Disconnect GitHub
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="kq-card kq-card--repo">
      <a className="scenes-repo" href={repoUrl(repo)} target="_blank" rel="noopener noreferrer" title={`Open ${repoUrl(repo)}`}>
        <span className="scenes-repo__logo">{GithubIcon}</span>
        <span className="scenes-repo__text">
          <span className="scenes-repo__caption">
            Synced with GitHub
            <span className="scenes-repo__branch">{repo.branch}</span>
          </span>
          <span className="scenes-repo__name">
            <span className="scenes-repo__owner">{repo.owner}/</span>
            <wbr />
            {repo.name}
          </span>
        </span>
        <span className="scenes-repo__external">{ExternalLinkIcon}</span>
      </a>
      <div className="kq-repo-actions">
        <span className="kq-muted">as {user.login}</span>
        <button type="button" className="scenes-link" onClick={() => setChanging(true)}>
          Change repository
        </button>
        <button
          type="button"
          className="scenes-link scenes-link--danger"
          onClick={() => {
            if (
              window.confirm(
                "Disconnect GitHub in this browser? Your scenes stay here; changes are synced again once you reconnect.",
              )
            ) {
              disconnectGitHub();
            }
          }}
        >
          Disconnect
        </button>
      </div>
    </section>
  );
};

/** the end of "Connect GitHub" (rendered next to the editor, see index.tsx) */
export const RepoSetupDialog = () => {
  const current = useSetup();
  const { user, repo } = useConnection();
  const close = () => setSetup(null);

  useEffect(() => {
    if (!current) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current || !user) {
    return null;
  }
  if (current.step === "done") {
    return (
      <div className="kq-overlay">
        <div className="kq-dialog kq-dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="kq-setup-title">
          <h2 id="kq-setup-title">Synced with GitHub ✓</h2>
          <p>
            Your scenes now sync with{" "}
            <a href={repoUrl(current.repo)} target="_blank" rel="noopener noreferrer">
              {current.repo.owner}/{current.repo.name}
            </a>
            , as <strong>{user.login}</strong>.
          </p>
          <p className="kq-muted">
            {current.published
              ? `${current.published} scene${current.published === 1 ? "" : "s"} from this browser ${
                  current.published === 1 ? "goes" : "go"
                } there now. `
              : ""}
            Every change is saved there a few seconds after you stop drawing. Repository and connection: Scenes sidebar
            (click the scene name, top left).
          </p>
          <div className="scenes-row">
            <button type="button" className="scenes-btn scenes-btn--primary" onClick={close}>
              Start drawing
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (repo) {
    return null;
  }
  return (
    <div className="kq-overlay">
      <div className="kq-dialog kq-dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="kq-setup-title">
        <div className="kq-dialog__head">
          <h2 id="kq-setup-title">Connected as {user.login}. One more step</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <p>Which GitHub repository should your scenes sync with?</p>
        <RepoPicker only={current.only} onActivated={close} />
        <button type="button" className="scenes-link kq-left" onClick={close}>
          Later (it's in the Scenes sidebar, top left)
        </button>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// MCP: the agent link of this browser
// -----------------------------------------------------------------------------

const agentPrompt = (url: string) => `Connect to my Kurviq whiteboard as a remote MCP server (Streamable HTTP, no auth):

${url}

- Claude Code: claude mcp add --transport http kurviq ${url}
- Codex: add to ~/.codex/config.toml: [mcp_servers.kurviq] url = "${url}"
- Claude Desktop / claude.ai: Settings → Connectors → Add custom connector → this URL
- Other clients: add a remote MCP server with this URL

Then read ${window.location.origin}/llms.txt to learn how to work with my drawings. The tools work while my Kurviq tab is open. Keep this link private: it gives access to my Kurviq.`;

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="scenes-btn scenes-btn--primary"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
};

const McpDialog = ({ onClose }: { onClose: () => void }) => {
  const key = usePairingKey() ?? pairing.ensureKey();
  const url = pairing.mcpUrl(key)!;
  const prompt = agentPrompt(url);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="kq-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="kq-dialog" role="dialog" aria-modal="true" aria-labelledby="kq-mcp-title">
        <div className="kq-dialog__head">
          <h2 id="kq-mcp-title">Let an AI agent draw with you</h2>
          <button type="button" className="kq-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="kq-muted">
          Give this prompt to your agent (Claude Code, Codex, Cursor, Claude…). It connects the agent to Kurviq in{" "}
          <strong>this browser</strong>: it can read, draw and edit your scenes while a Kurviq tab is open here, and
          its edits are merged with yours.
        </p>
        <textarea className="kq-prompt" readOnly value={prompt} rows={9} onFocus={(event) => event.target.select()} />
        <div className="scenes-row">
          <CopyButton text={prompt} label="Copy prompt" />
          <CopyButton text={url} label="Copy MCP link only" />
        </div>
        <p className="kq-muted kq-small">
          Anyone with this link can use your Kurviq while it is open. Lost control of it?{" "}
          <button
            type="button"
            className="scenes-link"
            onClick={() => window.confirm("Make a new link? Agents with the old link lose access.") && pairing.reset()}
          >
            Make a new link
          </button>{" "}
          ·{" "}
          <button
            type="button"
            className="scenes-link scenes-link--danger"
            onClick={() => {
              if (window.confirm("Turn agent access off? The link stops working.")) {
                pairing.remove();
                onClose();
              }
            }}
          >
            Turn agent access off
          </button>
        </p>
        <p className="kq-muted kq-small">
          How agents work with Kurviq:{" "}
          <a href="/llms.txt" target="_blank" rel="noopener">
            llms.txt
          </a>
        </p>
      </div>
    </div>
  );
};

/** top left, next to "Slides" */
export const McpButton = () => {
  const [open, setOpen] = useState(false);
  const key = usePairingKey();
  return (
    <>
      <button
        type="button"
        className="scenes-pill scenes-slides-btn"
        title="Connect an AI agent (MCP) to Kurviq"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
          <path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0V7zM10 15v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        MCP
        {key && <span className="kq-dot" title="Agent access is on in this browser" />}
      </button>
      {open && <McpDialog onClose={() => setOpen(false)} />}
    </>
  );
};

// -----------------------------------------------------------------------------
// footer
// -----------------------------------------------------------------------------

/** bottom right of the canvas (injected by ../../vite.config.mts) */
export const KurviqLegalLinks = () => (
  <span className="kq-legal">
    <a href="/imprint" target="_blank" rel="noopener">
      Imprint
    </a>
    <a href="/privacy" target="_blank" rel="noopener">
      Privacy
    </a>
  </span>
);

export const KurviqFooter = () => (
  <footer className="kq-footer">
    <strong>Kurviq</strong> · built on{" "}
    <a href="https://github.com/excalidraw/excalidraw" target="_blank" rel="noopener noreferrer">
      Excalidraw
    </a>{" "}
    (unofficial, not affiliated) ·{" "}
    <a href="/llms.txt" target="_blank" rel="noopener">
      for AI agents
    </a>{" "}
    ·{" "}
    <a href="https://github.com/tecsteps/kurviq" target="_blank" rel="noopener noreferrer">
      source (MIT)
    </a>{" "}
    ·{" "}
    <a href="/third-party-licenses.txt" target="_blank" rel="noopener">
      licenses
    </a>{" "}
    ·{" "}
    <a href="/imprint" target="_blank" rel="noopener">
      imprint
    </a>{" "}
    ·{" "}
    <a href="/privacy" target="_blank" rel="noopener">
      privacy
    </a>
  </footer>
);
