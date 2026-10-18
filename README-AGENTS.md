# Using Excalidraw scenes with a coding agent

Coding agents (Claude Code, Codex, Cursor, …) can draw diagrams, save them as
scenes to the GitHub repo, and switch the scene you have open, all through
one MCP server: `scenes-mcp/server.mjs`. To install everything with an agent, use the
prompt in [README.md](README.md#install-with-an-agent).

```
agent ──MCP (stdio)──> scenes-mcp ──HTTP──> scenes-server ──git push──> GitHub (excalidrawscenes)
                                                 │
                                                 └──live channel──> Excalidraw tab in your browser
```

## 1. Start the app

```bash
cd /path/to/excalidraw-git
npm start            # scenes server on :3101 + app on http://draw.test
```

Keep **http://draw.test open in a browser tab**. Saving and reading scenes
works without it. You need the open tab for `open_scene`, `app_status` and
`save_open_scene`, and for the best text measurement when saving.

## 2. Connect your agent

The server is a stdio MCP server and works from any directory. Use the absolute
path: `/path/to/excalidraw-git/scenes-mcp/server.mjs`.

**Claude Code, in this folder:** nothing to do. `.mcp.json` registers it as
`excalidraw`. Approve it when Claude Code asks the first time.

**Claude Code, in every project:**

```bash
claude mcp add excalidraw --scope user -- node /path/to/excalidraw-git/scenes-mcp/server.mjs
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.excalidraw]
command = "node"
args = ["/path/to/excalidraw-git/scenes-mcp/server.mjs"]
```

**Cursor, Claude Desktop and other clients:** add this to their MCP JSON config:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-git/scenes-mcp/server.mjs"]
    }
  }
}
```

**Headless / scripted** (e.g. from CI or another agent):

```bash
claude -p "Draw our login flow and save it as scene 'Login Flow'" \
  --mcp-config /path/to/excalidraw-git/.mcp.json \
  --allowedTools "mcp__excalidraw__*"
```

## Watch the agent draw

Every `create_view` call is mirrored live into your open tab, in the scene
**agent-live** (http://draw.test/agent-live). Your tab switches there
automatically, and new elements appear one by one. Your previous scene is kept,
so switch back any time. When the agent calls `save_scene(…, open: true)`, the
app jumps to the saved scene. To turn mirroring off, start the MCP server with
`SCENES_LIVE_PREVIEW=false`.

Each `create_view` call shows up as soon as it completes. For a step-by-step
show, ask the agent to "build it in several create_view steps".

## Scene URLs

`http://draw.test/<scene name>` opens that scene, e.g. `/Madsack` or
`/Agent%20-%20House`. If the scene doesn't exist yet, an empty local scene with
that name is created, and it loads automatically once an agent commits it. The
URL follows whenever you switch scenes, and back/forward work.

## 3. Ask for things

The tools describe themselves, so plain requests work:

- "Draw the architecture of this repo and save it as scene **Backend Architecture**. Open it in my app."
- "What scene do I have open? Commit my changes to it."
- "Switch my Excalidraw to **Agent - House**."
- "Open the scene **Checkout Flow** and add a 'Fraud check' step between 'Cart valid?' and 'Charge card'."
- "List all scenes."
- "Create an empty scene called **Sprint 42 Retro** and switch to it."
- "Rename **Sprint 42 Retro** to **Sprint 42 – Retro**." · "Duplicate **Madsack** as **Madsack v2**." · "Delete the scene **agent-live**."

## Tools

| Tool | What it does |
|---|---|
| `read_me` | Element format cheat sheet: shapes, labels, arrows, colors. The agent calls it once before drawing. |
| `create_view` | Draws a diagram and returns a `checkpointId`. It's mirrored live into your tab (scene `agent-live`). |
| **`view_scene`** | **Returns an actual PNG image to the agent.** It can show a repo scene, a checkpoint, or (no arguments) the scene open in your app including unsaved edits. Optional `elementIds` / `region` zoom in, `maxSize` caps the size. |
| **`read_open_scene`** | Reads the scene open in your app *right now*, including your unsaved edits. It returns a `revision`. `since=<revision>` gives exactly what you added, changed or deleted, and `view=true` adds an image of those changes. |
| **`edit_open_scene`** | Adds, updates or deletes elements on your live canvas, merged with your work and undoable as one step. It returns an image of the edited area and a new `revision`. |
| `get_scene` | A scene as stored on GitHub, as data. `summary=true` (the default for big scenes) gives bounds, counts and all labels with positions. `region` / `elementIds` select a part. |
| `save_scene` | Commits and pushes a drawing (`checkpointId` or `elements`). `open: true` switches your app to it. |
| `open_scene` | Switches your app to a scene. `create: true` makes a new one. |
| `rename_scene` / `clone_scene` / `delete_scene` | Rename, duplicate or delete a scene, in your app (its local copy, unpushed changes, URL and change tracking move along) and on GitHub. Offline, GitHub follows later. With no app open they work on GitHub directly. `clone_scene` only switches your app to the copy with `open: true`. |
| `save_open_scene` | Pushes the scene open in your app now, including your edits. |
| `list_scenes` / `app_status` | Scenes on GitHub, and what your app has open with each scene's sync status. |

### Co-working (you and the agent on the same drawing)

1. The agent draws: `read_open_scene` → `edit_open_scene(add=…)` → checks the returned image.
2. You change things by hand: add, move, delete, relabel.
3. You ask for more. The agent calls `read_open_scene` again, and the answer **automatically contains `userChanges`**: what you added, modified (with `changedFields` such as `["x","y"]` = moved or `["text"]` = relabelled) and deleted since an agent last looked. With `view=true` it also gets a picture of your changes.

**How change detection works:** after every `read_open_scene` / `edit_open_scene`, your app stores a snapshot of the scene in the browser (IndexedDB, per scene; it moves along when the scene is renamed). Nothing is stored on the server side. The next read compares your live canvas against it. The agent doesn't have to remember anything, so this works across conversations, context compaction and different agents.

**Safety net:** if an agent calls `edit_open_scene` without reading first and you changed something meanwhile, the edit is still applied (merged, undoable), but the answer starts with a **WARNING** listing your changes plus an image of them, so the agent re-checks.

**Several tabs:** once the agent knows its scene, it passes `scene` / `expectScene`, and its reads and edits reach the tab showing that scene, even while you work in another tab. It never edits a different scene than the one it was asked to.

These rules are built into the MCP server's instructions (sent to every agent that connects) and into the Claude Code skill `excalidraw-scenes` (`scenes-mcp/skill/excalidraw-scenes/SKILL.md`, linked to `~/.claude/skills/`).

### Seeing scenes (huge ones too)

- `view_scene` returns a real image, rendered by Excalidraw itself. It uses your open tab. With no tab open, the scenes server starts a hidden headless Chrome automatically, so no Playwright or browser automation is needed.
- For big scenes: `get_scene(summary=true)` shows where things are, then `view_scene(region=…)` or `view_scene(elementIds=[…])` zooms in on the part that matters.
- After editing: `view_scene(elementIds=<the ids it touched>)` shows just its own work, plus whatever overlaps.

### Drawing something new (no open canvas needed)

`read_me` → `create_view(elements)` → `view_scene(checkpointId)` to check → `save_scene(name, checkpointId, open: true)`

## Sync with GitHub (what agents should know)

Your browser is the source of truth and works offline. Each scene shows its status:
✓ synced · ↑ not pushed · ↓ newer on GitHub · ⇅ changed on both sides (merged automatically) · ! conflict (you decide) · ○ only local.

- `save_scene` writes straight to GitHub. If you have local changes to that scene, your app merges per element. Different elements merge automatically; the same element changed on both sides becomes a conflict for you to resolve.
- `get_scene` reads the GitHub version. Your browser may be newer, so use `read_open_scene` for the open scene.

## Troubleshooting

| Message | Fix |
|---|---|
| `Scenes server not reachable at http://localhost:3101` | Run `npm start` (or `npm run start:server`). |
| `The Excalidraw app is not open in a browser` | Open http://draw.test. Only needed for open/status/save-open. |
| `convertedBy: "node (estimated text sizes)"` | No tab was open and the headless renderer couldn't start (no Chrome found?), so text widths are estimates. Open the scene in the app and *Save* once to fix them. |
| `view_scene` is slow the first time | With no tab open, the hidden headless renderer starts first (a few seconds). Set `CHROME_PATH` if Chrome isn't found. |
| `Checkpoint "…" not found` | Checkpoints are kept by the app in your browser (last 200), or by the headless renderer while no tab is open (gone when it stops). Call `get_scene` again for a fresh one. |
| Push fails | The server pushes with your git credentials (`gh auth status`). The repo is set by `SCENES_GIT_REPO` in `.env`. |

To check the tools without an agent:

```bash
curl -s localhost:3101/api/scenes          # list scenes
curl -s localhost:3101/api/app/state       # what the browser has open
```
