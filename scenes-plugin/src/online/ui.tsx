// Kurviq's own UI (online build only): Connect GitHub (scenes go to the
// private repository <account>/kurviq-scenes), the "MCP" button with the agent link and prompt, and the
// footer (built on Excalidraw, llms.txt).

import { WelcomeScreen } from "@excalidraw/excalidraw";
import { GithubIcon, ExternalLinkIcon } from "@excalidraw/excalidraw/components/icons";
import { useEffect, useState, useSyncExternalStore } from "react";

import { scenesController } from "../controller";

import {
  SCENES_REPO,
  checkConnection,
  chooseRepo,
  connectGitHub,
  connection,
  createScenesRepo,
  disconnectGitHub,
  findScenesRepo,
  isInstalledFor,
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

// setting up sync, as a dialog: Kurviq uses <account>/kurviq-scenes, or
// creates it; where it can't, the dialog says what to do on GitHub
type Setup =
  | null
  | { step: "working" }
  | { step: "install" }
  | { step: "access" }
  | { step: "create" }
  | { step: "error"; message: string }
  | { step: "done"; repo: RepoChoice; published: number };
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
const activateRepo = async (repo: RepoChoice) => {
  const current = connection.getState().repo;
  const switching = !!current && (current.owner !== repo.owner || current.name !== repo.name);
  chooseRepo(repo);
  // from now on new scenes go to GitHub with auto-sync
  scenesController.setNewScenesLocalOnly(false);
  if (switching) {
    await scenesController.resetGitHubState();
  }
  let published = 0;
  for (const name of localOnlyScenes()) {
    await scenesController.setLocalOnly(name, false).then(
      () => published++,
      () => {},
    );
  }
  scenesController.syncNow({ refresh: true });
  return published;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** use (or create) <account>/kurviq-scenes and sync with it */
const setUpSync = async () => {
  const login = connection.getState().user?.login;
  if (!login) {
    return;
  }
  setSetup({ step: "working" });
  try {
    let repo = await findScenesRepo(login);
    if (!repo) {
      if (!(await isInstalledFor(login))) {
        setSetup({ step: "install" });
        return;
      }
      const created = await createScenesRepo();
      if (created !== "created") {
        setSetup({ step: created === "exists" ? "access" : "create" });
        return;
      }
      // a new repository takes a moment to show up
      for (let attempt = 0; attempt < 10 && !repo; attempt++) {
        await sleep(1000);
        repo = await findScenesRepo(login);
      }
      if (!repo) {
        setSetup({ step: "access" });
        return;
      }
    }
    setSetup({ step: "done", repo, published: await activateRepo(repo) });
  } catch (error: any) {
    setSetup({ step: "error", message: error.message });
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
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  // back from GitHub without sync yet: set it up right away
  let showSetup = answer === "connected";
  let last = "";
  connection.subscribe(() => {
    const { user, repo } = connection.getState();
    if (showSetup && user !== undefined) {
      showSetup = false;
      if (user && !repo) {
        setUpSync();
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
const NEW_REPO_URL = `https://github.com/new?name=${SCENES_REPO}&visibility=private&description=Drawings+from+Kurviq`;

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
        that adds{" "}
        <a
          className="kq-welcome__features"
          href="/features"
          onClick={(event) => {
            event.preventDefault();
            openPublicScene("features");
          }}
        >
          what I always wanted
        </a>
        .
      </p>
      <p className="kq-welcome__storage">
        {user && repo
          ? "Your drawings are saved in this browser and synced with GitHub."
          : user
          ? "Your drawings are saved in this browser. Set up sync in the Scenes sidebar to keep them in your repository."
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
          Your scenes go to the private repository <code>{SCENES_REPO}</code> on your GitHub account.{" "}
          <button type="button" className="scenes-link" onClick={() => connectGitHub("login")}>
            Already set up? Sign in
          </button>
        </span>
      </section>
    );
  }
  if (!repo) {
    return (
      <section className="kq-card">
        <div className="kq-card__title">
          Connected as <strong>{user.login}</strong>, sync is not set up yet
        </div>
        <div className="kq-muted">
          Your scenes go to the private repository{" "}
          <code>
            {user.login}/{SCENES_REPO}
          </code>
          ; Kurviq creates it if it doesn't exist.
        </div>
        <div className="scenes-row">
          <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => setUpSync()}>
            Set up sync
          </button>
        </div>
        <button type="button" className="scenes-link kq-left" onClick={() => disconnectGitHub()}>
          Disconnect GitHub
        </button>
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

/** setting up sync (rendered next to the editor, see index.tsx) */
export const RepoSetupDialog = () => {
  const current = useSetup();
  const { user } = useConnection();
  const close = () => setSetup(null);

  useEffect(() => {
    if (!current) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    // back from GitHub's tab (repository created): try again
    const onFocus = () => current.step === "create" && setUpSync();
    window.addEventListener("keydown", onKey);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
    };
  }, [current]);

  if (!current || !user) {
    return null;
  }
  const target = `${user.login}/${SCENES_REPO}`;
  const later = (
    <button type="button" className="scenes-link kq-left" onClick={close}>
      Later (Scenes sidebar, top left)
    </button>
  );
  const body = (() => {
    switch (current.step) {
      case "working":
        return (
          <>
            <h2 id="kq-setup-title">Setting up sync…</h2>
            <p className="kq-muted">
              Connected as <strong>{user.login}</strong>. Preparing your repository <code>{target}</code>.
            </p>
          </>
        );
      case "done":
        return (
          <>
            <h2 id="kq-setup-title">Synced with GitHub ✓</h2>
            <p>
              Your scenes now sync with{" "}
              <a href={`https://github.com/${current.repo.owner}/${current.repo.name}`} target="_blank" rel="noopener noreferrer">
                {current.repo.owner}/{current.repo.name}
              </a>
              .
            </p>
            <p className="kq-muted">
              {current.published
                ? `${current.published} scene${current.published === 1 ? "" : "s"} from this browser ${
                    current.published === 1 ? "goes" : "go"
                  } there now. `
                : ""}
              Every change is saved there a few seconds after you stop drawing.
            </p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={close}>
                Start drawing
              </button>
            </div>
          </>
        );
      case "install":
        return (
          <>
            <h2 id="kq-setup-title">Allow Kurviq on your GitHub account</h2>
            <p className="kq-muted">
              Kurviq keeps your scenes in the private repository <code>{target}</code>. Allow the Kurviq app for your
              account <strong>{user.login}</strong> on GitHub; you're back here right after.
            </p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
                Continue on GitHub
              </button>
            </div>
            {later}
          </>
        );
      case "access":
        return (
          <>
            <h2 id="kq-setup-title">Give Kurviq access to {SCENES_REPO}</h2>
            <p className="kq-muted">
              <code>{target}</code> exists, but Kurviq can't use it yet. On GitHub, add it to the repositories of the
              Kurviq app.
            </p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => connectGitHub("install")}>
                Continue on GitHub
              </button>
              <button type="button" className="scenes-btn" onClick={() => setUpSync()}>
                Try again
              </button>
            </div>
            {later}
          </>
        );
      case "create":
        return (
          <>
            <h2 id="kq-setup-title">Create {SCENES_REPO} on GitHub</h2>
            <p className="kq-muted">
              GitHub opens with the repository filled in (private). Click "Create repository" there and come back: sync
              starts by itself.
            </p>
            <div className="scenes-row">
              <a className="scenes-btn scenes-btn--primary" href={NEW_REPO_URL} target="_blank" rel="noopener noreferrer">
                Create it on GitHub
              </a>
              <button type="button" className="scenes-btn" onClick={() => setUpSync()}>
                Try again
              </button>
            </div>
            {later}
          </>
        );
      case "error":
        return (
          <>
            <h2 id="kq-setup-title">Sync could not be set up</h2>
            <p className="scenes-error">{current.message}</p>
            <div className="scenes-row">
              <button type="button" className="scenes-btn scenes-btn--primary" onClick={() => setUpSync()}>
                Try again
              </button>
            </div>
            {later}
          </>
        );
    }
  })();
  return (
    <div className="kq-overlay">
      <div className="kq-dialog kq-dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="kq-setup-title">
        {body}
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
