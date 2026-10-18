// Element-level three-way merge of scene versions.
//
// Excalidraw elements have stable ids and bump `version`/`versionNonce` on
// every change, so for each element we can tell who changed it since the
// common base version:
//   only mine changed   -> mine        only theirs changed -> theirs
//   both, same result   -> either      both, different     -> CLASH (mine kept
//                                                             provisionally)
// A missing element counts as deleted.

import { syncInvalidIndices } from "@excalidraw/element";

type El = { id: string; version: number; versionNonce: number; index?: string | null; [key: string]: any };

const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "index"]);

const live = (elements: readonly El[] | undefined) =>
  new Map((elements || []).filter((el) => !el.isDeleted).map((el) => [el.id, el]));

const changed = (base: El | undefined, other: El | undefined) =>
  !base !== !other ||
  (!!base && !!other && (base.version !== other.version || base.versionNonce !== other.versionNonce));

const sameContent = (a: El | undefined, b: El | undefined) => {
  if (!a || !b) {
    return !a && !b;
  }
  const strip = (el: El) =>
    JSON.stringify(Object.keys(el).sort().filter((key) => !VOLATILE.has(key)).map((key) => [key, el[key]]));
  return strip(a) === strip(b);
};

export type MergeResult = {
  elements: El[];
  /** element ids changed differently on both sides */
  clashes: string[];
  /** counts, for the activity log */
  fromMine: number;
  fromTheirs: number;
};

export const mergeElements = (
  base: readonly El[] | undefined,
  mine: readonly El[],
  theirs: readonly El[],
): MergeResult => {
  const [b, m, t] = [live(base), live(mine), live(theirs)];
  const ids = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  const result: El[] = [];
  const clashes: string[] = [];
  let fromMine = 0;
  let fromTheirs = 0;

  for (const id of ids) {
    const [be, me, te] = [b.get(id), m.get(id), t.get(id)];
    const mineChanged = changed(be, me);
    const theirsChanged = changed(be, te);
    let pick: El | undefined;
    if (!mineChanged) {
      pick = te;
      theirsChanged && fromTheirs++;
    } else if (!theirsChanged) {
      pick = me;
      fromMine++;
    } else if (sameContent(me, te)) {
      pick = me;
    } else {
      pick = me ?? te; // keep mine provisionally (a deleted-vs-edited clash keeps the edit)
      clashes.push(id);
    }
    if (pick) {
      result.push(pick);
    }
  }

  // z-order: fractional indices are ASCII-ordered strings
  result.sort((x, y) => ((x.index ?? "") < (y.index ?? "") ? -1 : (x.index ?? "") > (y.index ?? "") ? 1 : 0));
  syncInvalidIndices(result as any);
  return { elements: result, clashes, fromMine, fromTheirs };
};
