// Element-level three-way merge of scene versions.
//
// Elements have stable ids, so for each element we compare its content on
// both sides with the common base version. Content, not `version`: the app
// and agents re-save elements with new version stamps (and add/omit empty
// fields) without changing them, which must not count as a change.
//   only mine changed   -> mine        only theirs changed -> theirs
//   both, same result   -> either      both, different     -> CLASH (mine kept
//                                                             provisionally)
// A missing element counts as deleted.

import { syncInvalidIndices } from "@excalidraw/element";

type El = { id: string; version: number; versionNonce: number; index?: string | null; [key: string]: any };

/** bump when the merge logic changes: conflicts found by older ones are re-checked */
export const MERGE_VERSION = 2;

const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "index"]);

export const live = (elements: readonly El[] | undefined) =>
  new Map((elements || []).filter((el) => !el.isDeleted).map((el) => [el.id, el]));

/** comparable content: no version stamps, no empty fields (null / [] / missing), rounded numbers */
const normalize = (value: any): any => {
  if (typeof value === "number") {
    return Math.round(value * 100) / 100;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      const field = value[key];
      const empty = field === null || field === undefined || (Array.isArray(field) && !field.length);
      if (!VOLATILE.has(key) && !empty) {
        out[key] = normalize(value[key]);
      }
    }
    return out;
  }
  return value;
};

const sameContent = (a: El | undefined, b: El | undefined) => {
  if (!a || !b) {
    return !a && !b;
  }
  if (a.version === b.version && a.versionNonce === b.versionNonce) {
    return true;
  }
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

const changed = (base: El | undefined, other: El | undefined) => !sameContent(base, other);

/** fields whose content differs between two versions of an element */
export const changedFields = (a: El, b: El) => {
  const [na, nb] = [normalize(a), normalize(b)];
  return [...new Set([...Object.keys(na), ...Object.keys(nb)])].filter(
    (key) => JSON.stringify(na[key]) !== JSON.stringify(nb[key]),
  );
};

/** how to settle clashing elements: take my version or GitHub's */
export type ClashChoice = "mine" | "theirs";

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
  /** decisions for clashing element ids (others stay clashes) */
  choices: Record<string, ClashChoice> = {},
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
    } else if (choices[id]) {
      pick = choices[id] === "mine" ? me : te; // undefined = deleted on that side
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

/**
 * Settle clashes without asking, like live collaboration does: per element
 * the newer edit wins (`updated` timestamp; on a tie GitHub's). An edit beats
 * a delete, so nobody's work silently disappears.
 */
export const newestWins = (
  mine: readonly El[],
  theirs: readonly El[],
  clashes: readonly string[],
): Record<string, ClashChoice> => {
  const [m, t] = [live(mine), live(theirs)];
  const choices: Record<string, ClashChoice> = {};
  for (const id of clashes) {
    const [me, te] = [m.get(id), t.get(id)];
    choices[id] = !me ? "theirs" : !te ? "mine" : ((me as any).updated ?? 0) > ((te as any).updated ?? 0) ? "mine" : "theirs";
  }
  return choices;
};
