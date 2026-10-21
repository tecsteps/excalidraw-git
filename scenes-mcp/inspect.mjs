// Cheap, text-only views of (possibly huge) scenes: bounds, overview, region /
// element filters — so agents can find their way before rendering pixels.

/** axis-aligned bounds of an element (rotation ignored) */
export const elementBounds = (el) => {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p) => el.x + p[0]);
    const ys = el.points.map((p) => el.y + p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [el.x, el.y, el.x + (el.width || 0), el.y + (el.height || 0)];
};

export const commonBounds = (elements) => {
  if (!elements.length) {
    return null;
  }
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const el of elements) {
    const [a, b, c, d] = elementBounds(el);
    x1 = Math.min(x1, a);
    y1 = Math.min(y1, b);
    x2 = Math.max(x2, c);
    y2 = Math.max(y2, d);
  }
  return [x1, y1, x2, y2];
};

export const toRect = (bounds) =>
  bounds && {
    x: Math.round(bounds[0]),
    y: Math.round(bounds[1]),
    width: Math.round(bounds[2] - bounds[0]),
    height: Math.round(bounds[3] - bounds[1]),
  };

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** containers bring their labels, labels bring their containers */
export const withBoundText = (picked, all) => {
  const ids = new Set(picked.map((el) => el.id));
  for (const el of all) {
    if (el.containerId && ids.has(el.containerId)) {
      ids.add(el.id);
    }
    if (ids.has(el.id) && el.containerId) {
      ids.add(el.containerId);
    }
  }
  return all.filter((el) => ids.has(el.id));
};

export const inRegion = (elements, { x, y, width, height }) => {
  const region = [x, y, x + width, y + height];
  return withBoundText(
    elements.filter((el) => overlaps(elementBounds(el), region)),
    elements,
  );
};

export const byIds = (elements, ids) => {
  const wanted = new Set(ids);
  return withBoundText(
    elements.filter((el) => wanted.has(el.id)),
    elements,
  );
};

/** overview of a scene: where things are, without dumping every element.
 * Text labels are paged (textsOffset / textsLimit) so huge scenes stay small. */
export const summarize = (elements, { textsOffset = 0, textsLimit = 100 } = {}) => {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const countsByType = {};
  for (const el of elements) {
    countsByType[el.type] = (countsByType[el.type] || 0) + 1;
  }
  const frames = elements
    .filter((el) => el.type === "frame" || el.type === "magicframe")
    .map((el) => ({ id: el.id, name: el.name ?? null, ...toRect(elementBounds(el)) }));

  const texts = elements
    .filter((el) => el.type === "text" && el.text?.trim())
    .map((el) => {
      const container = el.containerId && byId.get(el.containerId);
      const rect = toRect(elementBounds(container || el));
      return {
        id: container ? container.id : el.id,
        ...(container ? { shape: container.type } : {}),
        text: el.text.replace(/\s+/g, " ").slice(0, 80),
        ...rect,
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return {
    elementCount: elements.length,
    sceneBounds: toRect(commonBounds(elements)),
    countsByType,
    ...(frames.length ? { frames } : {}),
    textCount: texts.length,
    texts: texts.slice(textsOffset, textsOffset + textsLimit),
    ...(texts.length > textsOffset + textsLimit
      ? { moreTexts: `${texts.length - textsOffset - textsLimit} more labels: call again with textsOffset=${textsOffset + textsLimit}, or narrow down with region` }
      : {}),
  };
};

const VOLATILE = new Set(["version", "versionNonce", "updated", "seed", "index"]);

/** null, missing and [] mean the same (the app and agents differ in which they write) */
const comparable = (value) =>
  value === null || value === undefined || (Array.isArray(value) && !value.length)
    ? null
    : JSON.stringify(value);

/**
 * What changed between two snapshots of a scene (non-deleted elements):
 * added / modified (with the changed fields) / deleted ids.
 */
export const diffElements = (before, after) => {
  const prev = new Map(before.map((el) => [el.id, el]));
  const next = new Map(after.map((el) => [el.id, el]));
  const added = [];
  const modified = [];
  for (const el of after) {
    const old = prev.get(el.id);
    if (!old) {
      added.push(el);
      continue;
    }
    if (old.version === el.version && old.versionNonce === el.versionNonce) {
      continue;
    }
    const changedFields = Object.keys({ ...old, ...el }).filter(
      (key) => !VOLATILE.has(key) && comparable(old[key]) !== comparable(el[key]),
    );
    if (changedFields.length) {
      modified.push({ element: el, changedFields });
    }
  }
  const deleted = before.filter((el) => !next.has(el.id)).map((el) => ({
    id: el.id,
    type: el.type,
    ...(el.text ? { text: el.text.slice(0, 80) } : {}),
  }));
  return { added, modified, deleted };
};
