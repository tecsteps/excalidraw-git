# excalidraw-git: git-backed Excalidraw scenes for humans and agents

_Unofficial add-on, not affiliated with Excalidraw._

Local Excalidraw with **multiple scenes** that are saved to a GitHub repo
(`SCENES_GIT_REPO`, default <https://github.com/tecsteps/excalidrawscenes>),
usable by humans (sidebar in the app) and agents (MCP tools).

Upstream code is kept **untouched** and is not part of this repo: `npm run setup`
clones it at the tested commits pinned in `scripts/setup.mjs`.

| folder | what |
|---|---|
| `excalidraw/` | upstream clone of excalidraw/excalidraw, **not modified** |
| `excalidraw-mcp/` | upstream clone of excalidraw/excalidraw-mcp, **not modified** |
| `scenes-plugin/` | the UI/logic, injected into `excalidraw-app` at build time by `scenes-plugin/vite.config.mts` (uses public `<Excalidraw/>` extension points only: `renderTopLeftUI` + a custom `<Sidebar/>`) |
| `scenes-server/` | tiny local Node server: commits & pushes `scenes/<name>.excalidraw` to the scenes repo with your local git credentials (via a transport clone in `scenes-server/.repo`); relays agent commands to the open app. **Stateless**, see below |
| `scenes-mcp/` | MCP server = excalidraw-mcp's tools + scene tools |

## Install with an agent

Paste this prompt into any coding agent (Claude Code, Codex, Cursor, …). It
installs everything end to end and checks that it works. Replace
`<SCENES_REPO_URL>` with the GitHub repo your scenes should be saved to, or
leave it in and the agent will ask you.

````text
Install excalidraw-git (https://github.com/tecsteps/excalidraw-git) on this
machine end to end, and verify that it works. Work step by step, run the
commands yourself, and fix problems as you go. Ask me only when you need a
decision or something only I can do (such as logging in).

Scenes repo: <SCENES_REPO_URL>
(If this is still a placeholder, ask me for it. It must be a GitHub repo I can
push to; an empty repo is fine.)

1. Prerequisites. Check and install what is missing, or tell me if you can't:
   - git, Node.js 18 or newer, yarn (classic) and pnpm
     (`corepack enable` provides both on recent Node versions)
   - GitHub access for git: `gh auth status` should be logged in, or git
     push over HTTPS/SSH must work. Check with
     `git ls-remote <SCENES_REPO_URL>`.
   - Google Chrome or Chromium (used to render scene images when no
     browser tab is open). If it is not in the default location, note its
     path for CHROME_PATH.

2. Get the code. Unless I said otherwise, clone into ~/excalidraw-git:
   git clone https://github.com/tecsteps/excalidraw-git.git ~/excalidraw-git
   If the folder already exists, `git pull` instead.

3. Configure. `cp .env.example .env` (keep an existing .env, only add missing
   settings). Set SCENES_GIT_REPO=<SCENES_REPO_URL>. Leave the ports as they
   are unless 3001 or 3101 is taken.
   For SCENES_APP_URL:
   - If Laravel Herd is installed (`which herd`): run `npm run setup:domain`
     and keep SCENES_APP_URL=http://draw.test
   - Otherwise set SCENES_APP_URL=http://localhost:3001

4. Install: `npm run setup`. It clones excalidraw and excalidraw-mcp at
   pinned commits and builds them; this takes several minutes. Do not modify
   the excalidraw/ or excalidraw-mcp/ folders.

5. Start: run `npm start` in the background, keep it running, and write its
   output to a log file. Wait until both are up:
   - `curl -s localhost:3101/api/scenes` returns JSON with a "scenes" list
   - `curl -s -o /dev/null -w "%{http_code}" localhost:3001` returns 200
     (the first start of the app can take a minute)

6. Register the MCP server under the name "excalidraw", for all projects,
   using the absolute path of scenes-mcp/server.mjs:
   - Claude Code: `claude mcp add excalidraw --scope user -- node <abs path>/scenes-mcp/server.mjs`
   - Codex: add [mcp_servers.excalidraw] with command "node" and that path
     as args to ~/.codex/config.toml
   - Other clients: add it to their MCP JSON config
     ({"mcpServers":{"excalidraw":{"command":"node","args":["<abs path>"]}}})
   For Claude Code also install the skill:
   `mkdir -p ~/.claude/skills && ln -sfn <abs path>/scenes-mcp/skill/excalidraw-scenes ~/.claude/skills/excalidraw-scenes`

7. Verify the MCP server end to end. You may not see the new tools in this
   session yet, so talk to it directly over stdio: start
   `node <abs path>/scenes-mcp/server.mjs`, send the JSON-RPC messages
   initialize, notifications/initialized and tools/list (one JSON object per
   line), and check that the tools include list_scenes, save_scene,
   view_scene and delete_scene. Then call, through the same connection:
   a. list_scenes {}                        → no error
   b. save_scene {"name": "zz-install-check", "elements":
      "[{\"type\":\"rectangle\",\"id\":\"r1\",\"x\":0,\"y\":0,\"width\":200,\"height\":80,\"label\":{\"text\":\"It works\"}}]"}
                                            → commits the scene to the scenes repo
   c. view_scene {"name": "zz-install-check"} → returns a PNG image
   d. delete_scene {"name": "zz-install-check"} → removes it again
   Confirm with `git ls-remote <SCENES_REPO_URL>` or the GitHub page that
   commits arrived.

8. Report back:
   - the app URL (http://draw.test or http://localhost:3001), which I should
     open in my browser
   - which agent clients you registered the MCP server with, and that I have
     to restart running agent sessions to get the tools
   - the result of every check in step 7, and anything you had to fix
   - how to start it later: `npm start` in the install folder
````

## Setup & run

```bash
git clone https://github.com/tecsteps/excalidraw-git.git && cd excalidraw-git
cp .env.example .env   # set SCENES_GIT_REPO to your scenes repo
npm run setup     # clone (if missing) + install + build upstream repos, link node_modules
npm start         # scenes server (:3101) + app (http://draw.test)
```

Config lives in `.env` (template: `.env.example`, `.env.local` overrides): `SCENES_GIT_REPO`,
`SCENES_GIT_BRANCH`, `SCENES_SERVER_PORT`, `SCENES_SERVER_URL`,
`SCENES_APP_URL`.

**Hostname `draw.test`:** the app runs on port 3001. Laravel Herd's nginx
forwards http://draw.test to it, live reload included. This is set up once with
`npm run setup:domain` (`herd proxy draw http://localhost:3001`) and undone with
`herd unproxy draw`. Without Herd, use http://draw.localhost:3001, which
works with no setup, and set `SCENES_APP_URL` to match. Browsers keep separate
storage per hostname, so local scenes on http://localhost:3001 don't show up
on draw.test. Everything pushed to GitHub does.

## Using it

The pill next to the menu (top-left) shows the current scene; a dot means
uncommitted changes. Click it to open the **Scenes** sidebar:

- **Save**: commit & push the current scene (asks for a name the first time)
- **Save as…**: commit under a new name and continue there
- **New**: new empty scene
- click a scene to switch; **Sync now** checks GitHub right away
- **Rename · Duplicate · Delete**: under the current scene, or via the **⋯**
  menu of any scene in the list. Rename and delete happen on GitHub too (one
  commit each; a rename is a git rename, history is kept; deleted scenes stay
  in the git history). Offline they apply locally right away and reach
  GitHub when it's back. Duplicate copies the scene incl. changes that aren't
  pushed yet; auto-sync pushes the copy. Delete only removes the version on
  GitHub you have seen: if someone changed it there meanwhile, it is kept.
  A scene deleted on another machine disappears here too, unless you changed
  it locally (then it's kept and pushed again).
- **Discard local changes**: reload the scene from the repo

Scenes have URLs: `http://draw.test/<scene name>`. Agent drawings
appear live in the scene `agent-live` (see README-AGENTS.md). The
"Try Excalidraw+" banner is hidden via `scenes-plugin/src/scenes.scss`.

### Sync with GitHub

The browser is the source of truth and works offline (train!): scenes live in
localStorage/IndexedDB, GitHub is a sync target. Each scene tracks the GitHub
version it is based on, which gives a visible status:
✓ synced · ↑ not pushed · ↓ newer on GitHub · ⇅ changed on both sides · ! conflict · ○ only local.

- **Auto-sync** (default on; per-scene override "always / manual only"):
  pushes after 30s without edits and when you leave the tab; pulls scenes
  without local changes; checks GitHub every 60s; downloads all scenes so
  they're available offline.
- **Both sides changed:** an element-level three-way merge (Excalidraw
  elements have ids + versions). Different elements merge automatically. The
  same element changed on both sides becomes a **conflict**, and you choose
  *Keep mine* (overwrite GitHub), *Take GitHub's*, or *Keep both* (yours
  becomes a copy).
- **Offline:** everything keeps working. The sidebar shows "GitHub not
  reachable, working locally · N scenes waiting to sync", and syncing
  resumes when the connection is back.
- Pushes are safe: the server rejects a push whose base version isn't the
  current one on GitHub (no silent overwrites), and the app merges instead.
- Everything that happens is listed in the sidebar's **Activity** log.

Editing works as usual in localStorage. Switching away stashes the scene
(incl. images) in IndexedDB, so uncommitted work in several scenes is kept.
When opening a scene without local changes, the repo version is loaded.

### Where data lives (stateless servers)

Scene data lives in exactly two places: **your browser** (localStorage +
IndexedDB) and **the GitHub repo**. Neither the scenes server nor the MCP
server stores anything:

- `scenes-server/.repo` is only a transport clone: it is reset to GitHub's
  state before every commit and after a failed push, so it never holds
  anything GitHub doesn't have. Delete it any time; it is re-cloned.
- Agent data (`create_view` checkpoints, the baselines used to report user
  changes) is kept by the app in the browser's IndexedDB. Without an open
  tab, the hidden headless renderer holds checkpoints in a throwaway profile
  that is deleted when it stops.
- In memory there are only live connections (which tabs are open, which
  scene each shows, pending agent commands) and the last GitHub reachability
  check. All of it is rebuilt after a restart.

## Agents (MCP)

👉 **Step-by-step guide for coding agents: [README-AGENTS.md](README-AGENTS.md)**

`.mcp.json` registers the server for Claude Code in this folder
(`node scenes-mcp/server.mjs`, stdio). Tools:

| tool | |
|---|---|
| `read_me`, `create_view` | upstream excalidraw-mcp drawing tools (create_view returns a `checkpointId`) |
| `list_scenes` | scenes in the repo + what the app has open |
| `get_scene` | elements of a scene + a `checkpointId` to edit it via `create_view` + `restoreCheckpoint` |
| `save_scene` | commit & push a drawing (`checkpointId` or `elements`), `open=true` switches the app to it |
| `open_scene` | switch the open app to a scene (`create=true` for a new empty one) |
| `rename_scene` / `clone_scene` / `delete_scene` | rename, duplicate or delete a scene, in the app and on GitHub (directly on GitHub if no app is open) |
| `app_status` | open scene, dirty flag, local-only scenes |
| `save_open_scene` | commit the scene open in the app, incl. the user's manual edits |

Typical flow: `read_me` → `create_view` → `save_scene(name, checkpointId, open: true)`.

Elements in the short create_view format (`label`, `startBinding`, …) are
converted by the open browser tab with real font metrics (same conversion as
the excalidraw-mcp widget, plus arrow bindings); without an open tab a Node
fallback estimates text sizes. If the app has the scene open without local
changes, it reloads automatically after an agent commits; with local changes
the user gets a notice instead. With several tabs, agent commands go to the
most recently focused one.

## Updating upstream

```bash
(cd excalidraw && git fetch && git checkout origin/master && yarn install)
(cd excalidraw-mcp && git fetch && git checkout origin/main && pnpm install && pnpm run build)
```

Once it works, put the new commit hashes into `scripts/setup.mjs` and commit.

If upstream changes `excalidraw-app/App.tsx` so the injection anchors
(`renderTopRightUI={`, `<AppSidebar />`) disappear, the dev server fails with
a clear `[excalidraw-scenes]` error; adjust `scenes-plugin/vite.config.mts`.
`npm run typecheck` checks the plugin against the current upstream types.

## License

MIT, see [LICENSE](LICENSE). Excalidraw and excalidraw-mcp are separate
projects under their own licenses.
