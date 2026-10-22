// Kurviq (online): the scenes server's job, done in the browser with the
// GitHub REST API — list, load, commit, rename and delete scenes in the repo
// the user connected, with the same rules (a push must be based on the
// version GitHub has, agent commits carry a trailer).
//
// The browser never sees a long-lived GitHub credential: the Worker keeps
// the refresh token in an encrypted httpOnly cookie and hands out the
// short-lived access token (8 h) on request (see online/worker/auth.ts).

import type { ApiError, RemoteInfo, RemoteScene } from "../api";

const API = "https://api.github.com";
const SCENES_DIR = "scenes";
const EXTENSION = ".excalidraw";
const AGENT_TRAILER = "Scenes-Source: agent";

// -----------------------------------------------------------------------------
// connection: who is connected (cookie, via the Worker) and which repo syncs
// -----------------------------------------------------------------------------

export type GitHubUser = { login: string; avatarUrl: string | null };
export type RepoChoice = { owner: string; name: string; branch: string; private: boolean };

export type ConnectionState = {
  /** null = not checked yet */
  user: GitHubUser | null | undefined;
  repo: RepoChoice | null;
  /** last token / API problem, if any */
  error: string | null;
};

const REPO_KEY = "kurviq-github-repo";

const loadRepo = (): RepoChoice | null => {
  try {
    const value = JSON.parse(localStorage.getItem(REPO_KEY) || "null");
    return value?.owner && value?.name && value?.branch ? value : null;
  } catch {
    return null;
  }
};

let state: ConnectionState = { user: undefined, repo: loadRepo(), error: null };
const listeners = new Set<() => void>();

const setConnection = (patch: Partial<ConnectionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const connection = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: () => state,
  /** connected and a repo is chosen: scenes sync */
  isActive: () => !!state.user && !!state.repo,
};

let token: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string | null> | null = null;

const requestToken = async (): Promise<string | null> => {
  const ask = (retry = false) =>
    fetch("/auth/token", {
      method: "POST",
      credentials: "same-origin",
      headers: retry ? { "X-Kurviq-Retry": "1" } : {},
    });
  let res: Response;
  try {
    res = await ask();
    if (res.status === 409) {
      // another tab refreshed the token at the same moment: its new cookie
      // is ours too, ask again
      await new Promise((resolve) => setTimeout(resolve, 800));
      res = await ask(true);
    }
  } catch {
    throw offlineError("Kurviq server not reachable");
  }
  if (!res.ok) {
    throw offlineError(`Kurviq server error (${res.status})`);
  }
  const body = await res.json();
  if (body.connected === false) {
    token = null;
    setConnection({ user: null });
    return null;
  }
  token = { value: body.token, expiresAt: Date.parse(body.expiresAt) };
  if (state.user?.login !== body.user?.login) {
    setConnection({ user: body.user, error: null });
  }
  return token.value;
};

/** the current access token, refreshed when it is about to expire */
export const getToken = async (): Promise<string | null> => {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) {
    return token.value;
  }
  // one request at a time, also across this browser's tabs (the refresh
  // token rotates: two refreshes at once would invalidate each other)
  tokenRequest ??= (
    navigator.locks
      ? (navigator.locks.request("kurviq-github-token", requestToken) as unknown as Promise<string | null>)
      : requestToken()
  ).finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
};

/** find out whether this browser is connected (on start) */
export const checkConnection = async () => {
  try {
    await getToken();
  } catch (error: any) {
    setConnection({ error: error.message });
  }
  return state;
};

/** sign in with GitHub (full page redirect, back to this page afterwards) */
export const connectGitHub = (mode: "login" | "install" = "login") => {
  const back = window.location.pathname + window.location.search;
  window.location.href = `/auth/${mode}?return=${encodeURIComponent(back)}`;
};

export const disconnectGitHub = async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  token = null;
  listing = null;
  setConnection({ user: null });
};

export const chooseRepo = (repo: RepoChoice | null) => {
  try {
    if (repo) {
      localStorage.setItem(REPO_KEY, JSON.stringify(repo));
    } else {
      localStorage.removeItem(REPO_KEY);
    }
  } catch {}
  listing = null;
  setConnection({ repo });
};

// -----------------------------------------------------------------------------
// REST helper
// -----------------------------------------------------------------------------

const offlineError = (message: string) =>
  Object.assign(new Error(message), { status: 0, offline: true }) as ApiError;

const httpError = (status: number, message: string, extra: Partial<ApiError> = {}) =>
  Object.assign(new Error(message), { status, ...extra }) as ApiError;

export const notConnectedError = () =>
  Object.assign(new Error("GitHub is not connected"), {
    status: 0,
    offline: true,
    notConnected: true,
  }) as ApiError;

type GhResponse = { status: number; data: any; etag: string | null };

const gh = async (
  path: string,
  { method = "GET", body, etag }: { method?: string; body?: unknown; etag?: string | null } = {},
): Promise<GhResponse> => {
  for (let attempt = 0; ; attempt++) {
    const value = await getToken();
    if (!value) {
      throw notConnectedError();
    }
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${value}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw offlineError("GitHub not reachable");
    }
    if (res.status === 401 && attempt === 0) {
      token = null; // revoked or expired early: get a fresh one once
      continue;
    }
    const text = res.status === 304 || res.status === 204 ? "" : await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401) {
      setConnection({ user: null });
      throw notConnectedError();
    }
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw Object.assign(offlineError("GitHub rate limit reached, retrying later"), { status: 503 });
    }
    if (res.status >= 500) {
      throw Object.assign(offlineError(`GitHub error ${res.status}`), { status: 503 });
    }
    return { status: res.status, data, etag: res.headers.get("etag") };
  }
};

const fail = (res: GhResponse, what: string): never => {
  const detail = typeof res.data?.message === "string" ? `: ${res.data.message}` : "";
  throw httpError(res.status, `${what} (GitHub ${res.status}${detail})`);
};

// -----------------------------------------------------------------------------
// encoding
// -----------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (base64: string) => {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** the git blob sha of some content (to know without a request whether it changed) */
const blobSha = async (bytes: Uint8Array) => {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

// -----------------------------------------------------------------------------
// scenes in the repo
// -----------------------------------------------------------------------------

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,99}$/u;

const requireRepo = () => {
  if (!state.repo) {
    throw notConnectedError();
  }
  return state.repo;
};

const repoPath = (repo: RepoChoice) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

const scenePath = (name: string) => {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw httpError(400, `Invalid scene name: ${name}`);
  }
  return `${SCENES_DIR}/${name}${EXTENSION}`;
};

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

type Listing = {
  repoKey: string;
  head: string | null;
  etag: string | null;
  blobs: Map<string, string>;
  dates: Map<string, string>;
  fetchedAt: number;
};

let listing: Listing | null = null;
const remote: RemoteInfo = { online: null, lastFetchAt: null, lastError: null };

const repoKey = (repo: RepoChoice) => `${repo.owner}/${repo.name}#${repo.branch}`;

/** last commit date of each scene, in one GraphQL request */
const commitDates = async (repo: RepoChoice, head: string, names: string[]) => {
  const dates = new Map<string, string>();
  for (let i = 0; i < names.length; i += 80) {
    const chunk = names.slice(i, i + 80);
    const fields = chunk
      .map((name, j) => `f${j}: history(first: 1, path: ${JSON.stringify(scenePath(name))}) { nodes { committedDate } }`)
      .join("\n");
    const query = `query { repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { object(oid: ${JSON.stringify(head)}) { ... on Commit { ${fields} } } } }`;
    const res = await gh("/graphql", { method: "POST", body: { query } });
    const commit = res.data?.data?.repository?.object;
    if (res.status !== 200 || !commit) {
      return dates;
    }
    chunk.forEach((name, j) => {
      const date = commit[`f${j}`]?.nodes?.[0]?.committedDate;
      if (date) {
        dates.set(name, date);
      }
    });
  }
  return dates;
};

/**
 * The scenes on GitHub (name -> blob sha). Cheap when nothing changed: the
 * branch head is asked with its ETag (a 304 doesn't count against the rate
 * limit) and the listing is only fetched again when the head moved.
 */
const fetchListing = async (force = false): Promise<Listing> => {
  const repo = requireRepo();
  const key = repoKey(repo);
  if (listing && listing.repoKey === key && !force && Date.now() - listing.fetchedAt < 5_000) {
    return listing;
  }
  const previous = listing?.repoKey === key ? listing : null;
  try {
    const ref = await gh(`${repoPath(repo)}/git/ref/heads/${encodePath(repo.branch)}`, { etag: previous?.etag });
    let head: string | null = null;
    if (ref.status === 304 && previous) {
      listing = { ...previous, fetchedAt: Date.now() };
      return markOnline(listing);
    } else if (ref.status === 200) {
      head = ref.data.object.sha;
    } else if (ref.status === 404 || ref.status === 409) {
      // empty repo, or the branch doesn't exist yet: the first push creates it
      const repoInfo = await gh(repoPath(repo));
      if (repoInfo.status !== 200) {
        fail(repoInfo, `Repository ${repo.owner}/${repo.name} not accessible`);
      }
      head = null;
    } else {
      fail(ref, `Branch ${repo.branch} of ${repo.owner}/${repo.name} not readable`);
    }
    const blobs = new Map<string, string>();
    if (head) {
      const dir = await gh(`${repoPath(repo)}/contents/${SCENES_DIR}?ref=${head}`);
      if (dir.status === 200 && Array.isArray(dir.data)) {
        for (const entry of dir.data) {
          if (entry.type === "file" && entry.name.endsWith(EXTENSION)) {
            const name = entry.name.slice(0, -EXTENSION.length);
            if (NAME_RE.test(name)) {
              blobs.set(name, entry.sha);
            }
          }
        }
      } else if (dir.status !== 404) {
        fail(dir, "Scenes folder not readable");
      }
    }
    let dates = previous?.dates ?? new Map<string, string>();
    if (head && head !== previous?.head && blobs.size) {
      dates = await commitDates(repo, head, [...blobs.keys()]).catch(() => dates);
    }
    listing = { repoKey: key, head, etag: ref.status === 200 ? ref.etag : null, blobs, dates, fetchedAt: Date.now() };
    return markOnline(listing);
  } catch (error: any) {
    if (error.offline && !error.notConnected) {
      remote.online = false;
      remote.lastError = error.message;
    }
    throw error;
  }
};

const markOnline = (value: Listing) => {
  remote.online = true;
  remote.lastFetchAt = new Date().toISOString();
  remote.lastError = null;
  return value;
};

const checkBase = (name: string, current: string | undefined, baseSha: string | undefined) => {
  if (baseSha !== undefined && (current || "none") !== baseSha) {
    throw httpError(409, `"${name}" was changed on GitHub in the meantime`, { remoteSha: current || null });
  }
};

const isAgent = (source?: string) => typeof source === "string" && source.startsWith("agent");

const commitMessage = (text: string, source?: string) =>
  isAgent(source) ? `Agent: ${text[0].toLowerCase()}${text.slice(1)}\n\n${AGENT_TRAILER}` : text;

const readBlob = async (name: string, sha: string) => {
  const repo = requireRepo();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw httpError(400, "Invalid sha");
  }
  const res = await gh(`${repoPath(repo)}/git/blobs/${sha}`);
  if (res.status !== 200) {
    throw httpError(404, `Version ${sha} of scene "${name}" not found`);
  }
  return new TextDecoder().decode(fromBase64(res.data.content));
};

export const githubScenes = {
  remoteInfo: (): RemoteInfo => ({ ...remote }),

  list: async (refresh = false): Promise<{ scenes: RemoteScene[]; remote: RemoteInfo }> => {
    if (state.user === undefined) {
      await checkConnection(); // first call: find out whether this browser is connected
    }
    if (!connection.isActive()) {
      throw notConnectedError();
    }
    try {
      const { blobs, dates } = await fetchListing(refresh);
      const scenes = [...blobs].map(([name, sha]) => ({ name, sha, updatedAt: dates.get(name) ?? null }));
      scenes.sort((a, b) => a.name.localeCompare(b.name));
      return { scenes, remote: { ...remote } };
    } catch (error: any) {
      if (error.offline && !error.notConnected) {
        return { scenes: listing ? [...listing.blobs].map(([name, sha]) => ({ name, sha, updatedAt: listing!.dates.get(name) ?? null })) : [], remote: { ...remote } };
      }
      throw error;
    }
  },

  /** latest version, or a specific one (blob sha) */
  load: async (name: string, sha?: string): Promise<{ json: string; sha: string }> => {
    scenePath(name);
    if (!sha) {
      sha = (await fetchListing(true)).blobs.get(name);
      if (!sha) {
        throw httpError(404, `Scene not found: ${name}`);
      }
    }
    return { json: await readBlob(name, sha), sha };
  },

  /**
   * Commit a scene. baseSha: undefined = overwrite, "none" = must be new,
   * <sha> = must be exactly that version on GitHub (else 409: merge first).
   */
  save: async (name: string, json: string, baseSha?: string, source?: string) => {
    const path = scenePath(name);
    let data: any;
    try {
      data = JSON.parse(json);
    } catch {
      throw httpError(400, "Scene content is not valid JSON");
    }
    const owner = data?.appState?.name;
    if (typeof owner === "string" && owner !== name) {
      throw httpError(422, `Refused: this content belongs to scene "${owner}", not "${name}". Nothing was written.`);
    }
    const repo = requireRepo();
    const bytes = new TextEncoder().encode(json);
    const sha = await blobSha(bytes);
    for (let attempt = 0; ; attempt++) {
      const current = (await fetchListing(true)).blobs.get(name);
      checkBase(name, current, baseSha);
      if (current === sha) {
        return { sha, commit: null, changed: false };
      }
      const res = await gh(`${repoPath(repo)}/contents/${encodePath(path)}`, {
        method: "PUT",
        body: {
          message: commitMessage(`${current ? "Update" : "Add"} scene: ${name}`, source),
          content: toBase64(bytes),
          branch: repo.branch,
          ...(current ? { sha: current } : {}),
        },
      });
      if (res.status === 200 || res.status === 201) {
        listing = null;
        return { sha: res.data.content.sha as string, commit: res.data.commit.sha as string, changed: true };
      }
      // someone pushed between our listing and the commit: look again
      if ((res.status === 409 || res.status === 422) && attempt < 2) {
        continue;
      }
      fail(res, `Push of "${name}" failed`);
    }
  },

  /** delete a scene; baseSha (optional): only if GitHub still has that version */
  remove: async (name: string, baseSha?: string | null) => {
    const path = scenePath(name);
    const repo = requireRepo();
    for (let attempt = 0; ; attempt++) {
      const current = (await fetchListing(true)).blobs.get(name);
      if (!current) {
        throw httpError(404, `Scene not found: ${name}`);
      }
      checkBase(name, current, baseSha ?? undefined);
      const res = await gh(`${repoPath(repo)}/contents/${encodePath(path)}`, {
        method: "DELETE",
        body: { message: `Delete scene: ${name}`, sha: current, branch: repo.branch },
      });
      if (res.status === 200) {
        listing = null;
        return { sha: null };
      }
      if ((res.status === 409 || res.status === 422) && attempt < 2) {
        continue;
      }
      fail(res, `Delete of "${name}" failed`);
    }
  },

  /** rename in one commit (git sees a rename; the blob sha stays) */
  rename: async (from: string, to: string): Promise<{ sha: string; commit: string | null }> => {
    const [fromPath, toPath] = [scenePath(from), scenePath(to)];
    if (from === to) {
      throw httpError(400, "New name is the same as the old one");
    }
    const repo = requireRepo();
    for (let attempt = 0; ; attempt++) {
      const { blobs, head } = await fetchListing(true);
      const sha = blobs.get(from);
      if (!sha || !head) {
        throw httpError(404, `Scene not found: ${from}`);
      }
      if (blobs.has(to)) {
        throw httpError(409, `A scene named "${to}" already exists on GitHub`, { exists: true });
      }
      const commit = await gh(`${repoPath(repo)}/git/commits/${head}`);
      if (commit.status !== 200) {
        fail(commit, "Rename failed");
      }
      const tree = await gh(`${repoPath(repo)}/git/trees`, {
        method: "POST",
        body: {
          base_tree: commit.data.tree.sha,
          tree: [
            { path: toPath, mode: "100644", type: "blob", sha },
            { path: fromPath, mode: "100644", type: "blob", sha: null },
          ],
        },
      });
      if (tree.status !== 201) {
        fail(tree, "Rename failed");
      }
      const next = await gh(`${repoPath(repo)}/git/commits`, {
        method: "POST",
        body: { message: `Rename scene: ${from} → ${to}`, tree: tree.data.sha, parents: [head] },
      });
      if (next.status !== 201) {
        fail(next, "Rename failed");
      }
      const ref = await gh(`${repoPath(repo)}/git/refs/heads/${encodePath(repo.branch)}`, {
        method: "PATCH",
        body: { sha: next.data.sha, force: false },
      });
      if (ref.status === 200) {
        listing = null;
        return { sha, commit: next.data.sha };
      }
      // the branch moved meanwhile (not a fast-forward): try again on top
      if (ref.status === 422 && attempt < 2) {
        continue;
      }
      fail(ref, "Rename failed");
    }
  },

  /** the version of a scene an agent committed last, from the git history */
  agentVersion: async (name: string) => {
    const path = scenePath(name);
    const repo = requireRepo();
    const res = await gh(
      `${repoPath(repo)}/commits?sha=${encodeURIComponent(repo.branch)}&path=${encodeURIComponent(path)}&per_page=100`,
    );
    if (res.status !== 200 || !Array.isArray(res.data)) {
      return null;
    }
    const hit = res.data.find((entry: any) =>
      String(entry.commit?.message || "")
        .split("\n")
        .some((line: string) => line.trim() === AGENT_TRAILER),
    );
    if (!hit) {
      return null;
    }
    const file = await gh(`${repoPath(repo)}/contents/${encodePath(path)}?ref=${hit.sha}`);
    if (file.status !== 200 || !file.data?.sha) {
      return null;
    }
    return { sha: file.data.sha as string, commit: hit.sha as string, at: hit.commit.committer?.date ?? null };
  },
};

// -----------------------------------------------------------------------------
// repos the user can pick (where the GitHub App is installed)
// -----------------------------------------------------------------------------

export const listRepos = async (): Promise<RepoChoice[]> => {
  const installations = await gh("/user/installations?per_page=100");
  if (installations.status !== 200) {
    fail(installations, "Could not list your GitHub App installations");
  }
  const repos: RepoChoice[] = [];
  for (const installation of installations.data.installations || []) {
    for (let page = 1; page <= 10; page++) {
      const res = await gh(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`);
      if (res.status !== 200) {
        break;
      }
      for (const repo of res.data.repositories || []) {
        if (repo.permissions?.push !== false) {
          repos.push({ owner: repo.owner.login, name: repo.name, branch: repo.default_branch || "main", private: !!repo.private });
        }
      }
      if ((res.data.repositories || []).length < 100) {
        break;
      }
    }
  }
  repos.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  return repos;
};
