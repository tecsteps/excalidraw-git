---
name: excalidraw-scenes
description: Draw, co-edit, look at and save diagrams in the user's local Excalidraw (git-backed scenes, MCP server "excalidraw"). Use whenever the user asks to draw or change a diagram/sketch/scene in Excalidraw, wants to co-work on a drawing, asks what is on their canvas, or mentions Excalidraw scenes.
---

# Excalidraw scenes: how to work with the user's drawings

The user runs a local Excalidraw app (http://draw.test) with **scenes**
(named drawings, URL `http://draw.test/<scene>`) synced to a GitHub repo.
The MCP server `excalidraw` gives you tools for it. The user is often
**looking at the app while you work** and edits by hand in between.

## Golden rules

1. **The open canvas is the truth while co-working.** It contains the user's
   unsaved manual edits. Read it with `read_open_scene`; never assume it still
   looks like what you drew last time.
2. **Always `read_open_scene` before you edit.** It reports what the user
   changed since an agent last looked (`userChanges`), automatically: the
   app stores a per-scene baseline (in the browser) after every
   `read_open_scene` / `edit_open_scene`. You don't need to remember revision
   ids, it works across conversations.
3. **Edit with `edit_open_scene`**, not by re-creating the scene. It merges
   into the live canvas (the user's other work is untouched) and the user can
   undo your step with Cmd/Ctrl+Z.
4. **Look at the result.** `edit_open_scene` returns an image of what you
   changed. Use `view_scene` whenever you need to see something; it returns a
   real PNG.
5. If `edit_open_scene` answers with a **WARNING**, the user changed the scene
   since you last looked. Your edit was applied anyway: check the user's
   changes (listed + image) and fix your edit if it clashes with them.
6. **Stick to your scene.** The user may have several tabs/scenes. Once you
   know which scene you work on, pass it along: `read_open_scene(scene: "X")`
   and `edit_open_scene(expectScene: "X", …)` reach the tab showing X, even
   if the user is looking at another tab. If X isn't open anywhere you get an
   error; ask the user or `open_scene("X")`. Never edit a different scene
   than the one the user asked for.

## Co-working loop

```
read_open_scene(view: true)                    → scene name, what's there, what the user changed (+ image)
edit_open_scene(expectScene: "X", add / update / delete) → your change + image of it
… user edits by hand, asks for more …
read_open_scene(scene: "X", view: true)        → userChanges: exactly what they did
edit_open_scene(expectScene: "X", …)           → next change
```

`userChanges` lists `added`, `modified` (with `changedFields`, e.g. `["x","y"]`
= moved, `["text"]` = relabeled, `["backgroundColor"]` = recolored) and
`deleted` elements. "First time an agent reads this scene" means there is no
baseline yet, so everything is new to you.

## Editing elements (`edit_open_scene`)

- `add`: JSON array string, same format as `create_view` (call `read_me` once
  for the format): shapes with `label: { text }`, arrows with
  `startBinding` / `endBinding: { elementId, fixedPoint }`; arrows may bind
  to existing shapes. Use new unique ids.
- `update`: `[{ "id": "...", ...props }]`: move (`x`, `y`), resize, recolor,
  change `text` of a text element (a shape's label is a text element with
  `containerId` = the shape id).
- `delete`: ids (a shape's label goes with it).
- Label an existing shape: add `{ "type": "text", "id": "...", "text": "...",
  "containerId": "<shape id>" }`; it is centered automatically.

## Seeing scenes (they can be huge)

- `view_scene()`: the open scene incl. unsaved edits; `view_scene(name)`: a
  scene from GitHub; `view_scene(checkpointId)`: a `create_view` draft.
- Zoom: `elementIds: [...]` (those elements + padding + whatever overlaps) or
  `region: {x, y, width, height}`; `maxSize` caps the image size.
- Big scenes: `read_open_scene(summary: true)` / `get_scene(name, summary: true)`
  give an overview (bounds, counts, frames, every text label with position)
  to find the right region first.

## Scenes, saving and sync

- `list_scenes` / `app_status`: scenes, which one is open, sync status per
  scene: synced · ahead (not pushed) · behind (newer on GitHub) · diverged ·
  conflict · local.
- `open_scene(name)` switches the user's app (the previous scene is kept
  locally); `open_scene(name, create: true)` makes a new one.
- `rename_scene(name, newName)`, `clone_scene(name, newName, open?)`,
  `delete_scene(name)`: done in the user's app (local copy, unpushed changes,
  URL and change tracking move along) and on GitHub in one commit. Offline,
  GitHub follows later. `clone_scene` keeps the user on their scene unless
  `open: true`. **Only delete when the user asked for exactly that scene**
  (it stays in the git history, but is gone from the app).
- Edits in the app are pushed to GitHub by the app's auto-sync (after 30 s
  idle). `save_open_scene()` pushes the open scene now (incl. user edits).
- New drawing without touching the open canvas: `read_me` → `create_view`
  (mirrored live into the user's app as scene "agent-live") →
  `view_scene(checkpointId)` → `save_scene(name, checkpointId, open: true)`.
- `get_scene` / `save_scene` work on the **GitHub** version. If the user has
  that scene open with unpushed changes, the app merges per element (and asks
  the user only if the same element was changed on both sides). Prefer
  `read_open_scene` / `edit_open_scene` for the scene the user has open.

## Where things are stored

Nothing is stored by the servers: scenes live in the user's browser
(localStorage / IndexedDB) and in the GitHub repo. Your `create_view`
checkpoints and the change-tracking baselines are also kept by the app in the
browser, so drawing needs the app open in a browser (or the hidden headless
renderer the scenes server starts on demand when no tab is open; its
checkpoints are gone when it stops).

## Troubleshooting

- "app is not open in a browser": ask the user to open http://draw.test
  (needed for open/read/edit of the open scene; `view_scene(name)` and
  `get_scene` / `save_scene` work without it).
- "Scenes server not reachable": the user runs `npm start` in
  the project folder (excalidraw-git).
- "The user switched scenes": read again, then edit.
