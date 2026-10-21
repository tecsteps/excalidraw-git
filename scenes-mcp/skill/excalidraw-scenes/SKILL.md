---
name: excalidraw-scenes
description: Draw, co-edit, look at and save diagrams in the user's local Excalidraw (git-backed scenes, MCP server "excalidraw"). Use whenever the user asks to draw or change a diagram/sketch/scene in Excalidraw, wants to co-work on a drawing, asks what is on their canvas, or mentions Excalidraw scenes.
---

# Excalidraw scenes: how to work with the user's drawings

The user runs a local Excalidraw app (http://draw.test) with **scenes**
(named drawings, URL `http://draw.test/<scene>`) synced to a GitHub repo.
The MCP server `excalidraw` gives you tools for it. The user is often
**looking at the app while you work** and edits by hand in between.

**You have your own Excalidraw.** You never work in the user's browser: you
read and edit scenes in a hidden headless Excalidraw, and every edit is
committed to GitHub right away. The user's app picks your commits up within
seconds and merges them with what they are doing. Before you read or edit a
scene, the user's app pushes its unpushed changes of it, so you see their
latest work.

## Golden rules

1. **Always `read_scene` before you edit.** It reports what the user
   changed since an agent last edited the scene (`userChanges`), found in the
   git history, so it works across conversations and agents.
2. **Edit with `edit_scene`**, not by re-creating the scene. It changes only
   the elements you name; the user's other work is untouched. Pass the
   `revision` from your last `read_scene` / `edit_scene` as `basedOn`.
3. **Look at the result.** `edit_scene` returns an image of what you
   changed. Use `view_scene` whenever you need to see something; it returns a
   real PNG.
4. If `edit_scene` answers with a **WARNING**, the user changed the scene
   since your version. Your edit was applied on top anyway: check their
   changes (listed + image) and fix your edit if it clashes with them.
5. **Stick to the scene the user asked for.** If they say "this drawing",
   `app_status` tells you which scene they have open.
6. **Don't touch the user's view.** `open_scene` (and `open: true`) switches
   what the user sees: only when they ask you to show them something.
7. **Only these tools, never around them.** You never push, sync or write
   scene files yourself: `edit_scene` hands your change to your headless
   Excalidraw, which commits it; the user's app syncs their own work by
   itself (auto-sync). Never call the scenes server's HTTP API
   (localhost:3101) with curl or scripts, and never write `.excalidraw`
   files or git commits: direct writes are refused, and they would bypass
   merging and the user's unpushed work. If a tool can't do what you need,
   tell the user instead of working around it. Never overwrite an existing
   scene with `save_scene`. Conflicts: `get_conflict` / `resolve_conflict`.

## Co-working loop

```
read_scene("X", view: true)                    → what's there, what the user changed (+ image), revision r1
edit_scene("X", basedOn: r1, add / update / delete) → your change + image of it, revision r2
… user edits by hand, asks for more …
read_scene("X", since: r2, view: true)         → userChanges: exactly what they did since your edit (revision r3)
edit_scene("X", basedOn: r3, …)                → next change
```

`userChanges` lists `added`, `modified` (with `changedFields`, e.g. `["x","y"]`
= moved, `["text"]` = relabeled, `["backgroundColor"]` = recolored) and
`deleted` elements. "No earlier agent edit found" means everything is new to
you.

## Editing elements (`edit_scene`)

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
- Labels (`label: { text, strokeColor, fontSize, … }`) are dark (#1e1e1e)
  unless you set `strokeColor`, their id is `<shape id>-label`, and a shape
  grows so that no word of its label is broken.
- **Images and icons:** add `{ "type": "image", "id": "...", "x": 0, "y": 0,
  "width": 48 }` plus one of `"src"` (absolute file path, http(s) URL or data
  URL), `"svg"` (inline SVG markup) or `"icon"` (`"lucide:database"`,
  `"simple-icons:github"`, tinted with `"color"`). Works in `edit_scene` and
  `save_scene`; `create_view` drafts can't hold images.
- **ER diagrams:** arrows take crow's-foot heads: `startArrowhead` /
  `endArrowhead` = `cardinality_one`, `cardinality_many`,
  `cardinality_one_or_many`, `cardinality_exactly_one`,
  `cardinality_zero_or_one`, `cardinality_zero_or_many`. Tables are plain
  rectangles with a text label.
- **Big edits:** write `{ "add": [...], "update": [...], "delete": [...] }` to
  a JSON file and pass `file: "/abs/path.json"` (`save_scene`:
  `elementsFile`) instead of pasting it into the call.

## Seeing scenes (they can be huge)

- `view_scene(name)`: a scene, incl. the user's latest pushed edits;
  `view_scene(checkpointId)`: a `create_view` draft.
- Zoom: `elementIds: [...]` (those elements + padding + whatever overlaps) or
  `region: {x, y, width, height}`; `maxSize` caps the image size.
- Big scenes: `read_scene(name, summary: true)` / `get_scene(name, summary: true)`
  give an overview (bounds, counts, frames, text labels with positions, 100
  per page: `textsOffset` for more) to find the right region first.
  Selections return at most 150 elements; change reports give details for
  25 elements per kind and ids for the rest.

## New scenes and managing scenes

- New drawing: `read_me` → `create_view` → `view_scene(checkpointId)` →
  `save_scene(name, checkpointId)`. `save_scene` refuses existing scenes
  (change those with `edit_scene`); `replace: true` only when the user
  explicitly wants the whole scene replaced by a new drawing.
- `rename_scene(name, newName)`, `clone_scene(name, newName)`,
  `delete_scene(name)`: one commit on GitHub; the user's app follows (their
  unpushed changes are pushed first and move along). **Only delete when the
  user asked for exactly that scene** (it stays in the git history; a
  local-only scene has no other copy).
- `list_scenes` lists the scenes on GitHub. `app_status`: which scene the
  user has open, and each scene's sync status in their app: synced · ahead
  (not pushed) · behind (newer on GitHub) · diverged · conflict · local (not
  on GitHub) · "auto-sync off" (the user pushes when they decide; you don't
  see their unpushed changes of such a scene).

## Slides (presentations)

Every frame of a scene is a slide; the user presents with the "Slides" button
(fullscreen, laser, presenter view, PDF). Build decks with `save_scene` /
`edit_scene`:

- A slide: `{ "type": "frame", "id": "s1", "x": 100, "y": 100, "width": 1920,
  "height": 1080, "name": "Title", "children": [ids of its elements],
  "customData": { "slides": { "order": 0, "notes": "speaker notes" } } }`.
  Elements added later to a slide get `"frameId": "s1"`. Lay slides out in a
  row with a gap (e.g. 240) and keep everything inside its frame.
- `"skip": true` hides a slide while presenting; `"template": false` turns
  the template off for that slide (title slides).
- Click-by-click reveals: `"customData": { "slides": { "step": 1 } }` on
  elements (1, 2, 3 …; a shape's label follows its shape).
- Template: one frame with `"customData": { "slides": { "role": "template",
  "theme": { "fontFamily": 5, "titleSize": 72, "bodySize": 36, "textColor":
  "#1e1e1e", "strokeColor": "#1e1e1e", "roughness": 1, "strokeWidth": 2,
  "fillStyle": "solid", "transition": "glide" } } }`. Its elements (header,
  footer, logo, background) are copied onto every slide by the user's app;
  texts may use `{page}` `{total}` `{title}` `{deck}` `{date}`. Never edit
  the copies (ids `<element>~<slide>`); change the template instead.
- Use the theme's title / body sizes and font for text, so it follows when
  the user changes the deck style. Make slides visual: shapes, arrows,
  icons, sticky notes (`"type": "stickynote"` with `label`), crow's-foot ER
  diagrams, hand-drawn charts; not just bullet text.
- Text padding of a shape (distance of its label from the border):
  `"customData": { "textPadding": 20 }` (default 5).

## Local-only scenes

Some scenes are **local only**: they live only in the user's browser and are
never pushed to or pulled from GitHub (e.g. confidential customer work). The
user picks this per scene; `app_status` / `list_scenes` mark them.

- `read_scene`, `edit_scene`, `view_scene`, `get_scene`, rename, clone and
  delete work on them as usual, through the user's app, which must be open.
  They answer with a "Local-only scene" note; no GitHub commit happens.
- New local-only scene: `save_scene(name, …, local: true)`, only when the
  user asks for a local / private / not-synced scene.
- `set_local_only(name, localOnly)`: make a scene local only, or sync it
  with GitHub again. Only when the user asks.

## Merge conflicts

If the user's local version and GitHub's version changed the **same
elements** differently, the scene is in **conflict** in the user's app
(shown in its sidebar, in `app_status` and in `read_scene`'s `sync`). Their
newest edits of that scene don't reach GitHub until it is resolved. Changes
that only one side made are merged automatically.

1. `get_conflict(name, view: true)`: per clashing element the base,
   **mine** (the user's local version) and **github** version, which fields
   each side changed, plus images of both versions of the clashing area.
2. `resolve_conflict(name, resolution: "merge", choices: {id: "mine" |
   "github"}, otherwise: "mine" | "github")`: keeps both sides' other
   changes and decides each clash, then pushes. Alternatives: `"mine"`
   (user's whole version overwrites GitHub), `"github"` (discard the
   user's local changes), `"both"` (GitHub's version, user's kept as a
   copy scene).

When it's not obvious which version is right, show the user the
differences and ask. Never silently throw away the user's work.

## Where things are stored

Nothing is stored by the servers: scenes live in the user's browser
(localStorage / IndexedDB) and in the GitHub repo. Your edits are git
commits, marked as agent commits; that is how `userChanges` finds your last
version. Your `create_view` drafts live in your headless Excalidraw and are
gone when it stops.

## Live mode (only if your tools are `read_open_scene` / `edit_open_scene`)

The user can switch to live mode (`SCENES_AGENT_MODE=live`). Then you work
directly in their open browser tab: `read_open_scene(scene: "X")` instead of
`read_scene`, `edit_open_scene(expectScene: "X", …)` instead of
`edit_scene`. These act on the canvas the user sees (incl. their unsaved
edits, undoable with Cmd/Ctrl+Z), and the app's auto-sync pushes the
result. Don't push yourself; `save_open_scene` only when the user asks to
push now.

## Troubleshooting

- "Scenes server not reachable": the user runs `npm start` in the project
  folder (excalidraw-git).
- "No Chrome found": your headless Excalidraw needs Chrome or another
  Chromium browser (`CHROME_PATH` in `.env`).
