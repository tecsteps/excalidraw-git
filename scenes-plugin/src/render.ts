// Renders a scene (or part of it) to PNG with Excalidraw's own exporter, so
// agents can look at scenes without any browser automation.

import {
  exportToBlob,
  elementsOverlappingBBox,
  getCommonBounds,
  getNonDeletedElements,
  restoreElements,
} from "@excalidraw/excalidraw";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export type RenderCommand = {
  type: "render";
  /** scene to render; omitted = the scene open in this tab (incl. unsaved edits) */
  scene?: { elements: any[]; files?: BinaryFiles; appState?: any };
  /** focus on these elements (plus everything overlapping their area) */
  elementIds?: string[];
  /** focus on a scene-coordinate region */
  region?: { x: number; y: number; width: number; height: number };
  /** margin around elementIds (scene px), default 80 */
  padding?: number;
  /** longest side of the PNG in px, default 1500 */
  maxSize?: number;
};

type Bounds = [number, number, number, number];

const round = (n: number) => Math.round(n);
const boundsToRect = ([x1, y1, x2, y2]: Bounds) => ({
  x: round(x1),
  y: round(y1),
  width: round(x2 - x1),
  height: round(y2 - y1),
});

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

/** containers bring their labels, labels bring their containers */
const withBoundText = <T extends ExcalidrawElement>(
  picked: readonly T[],
  all: readonly T[],
) => {
  const ids = new Set(picked.map((el) => el.id));
  for (const el of all) {
    const containerId = (el as any).containerId;
    if (containerId && ids.has(containerId)) {
      ids.add(el.id);
    }
    if (ids.has(el.id) && containerId) {
      ids.add(containerId);
    }
  }
  return all.filter((el) => ids.has(el.id));
};

export const renderScene = async (
  command: RenderCommand,
  open: () => {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
    background: string;
  },
  convert: (elements: any[]) => Promise<any[]>,
) => {
  await document.fonts.load("20px Excalifont").catch(() => {});

  let elements: readonly ExcalidrawElement[];
  let files: BinaryFiles;
  let background: string;
  if (command.scene) {
    const raw = command.scene.elements || [];
    const needsConversion = raw.some(
      (el: any) => el?.label !== undefined || el?.version === undefined,
    );
    elements = needsConversion
      ? await convert(raw)
      : restoreElements(raw, null, { repairBindings: true });
    files = command.scene.files || {};
    background = command.scene.appState?.viewBackgroundColor || "#ffffff";
  } else {
    ({ elements, files, background } = open());
  }
  const visible: readonly NonDeletedExcalidrawElement[] =
    getNonDeletedElements(elements);
  elements = visible;
  if (!elements.length) {
    throw new Error("The scene is empty");
  }

  const sceneBounds = getCommonBounds(elements) as Bounds;
  let focus: Bounds | null = null;
  if (command.elementIds?.length) {
    const wanted = new Set(command.elementIds);
    const picked = withBoundText(
      elements.filter((el) => wanted.has(el.id)),
      elements,
    );
    if (!picked.length) {
      throw new Error("None of the given elementIds exist in the scene");
    }
    const pad = command.padding ?? 80;
    const [x1, y1, x2, y2] = getCommonBounds(picked) as Bounds;
    focus = [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
  } else if (command.region) {
    const { x, y, width, height } = command.region;
    focus = [x, y, x + width, y + height];
  }

  const shown = focus
    ? withBoundText(
        elementsOverlappingBBox({
          elements: visible,
          bounds: focus,
          type: "overlap",
        }),
        visible,
      )
    : visible;
  if (!shown.length) {
    throw new Error("Nothing is drawn in that region");
  }

  const maxSize = Math.min(4000, Math.max(200, command.maxSize ?? 1500));
  let scale = 1;
  const blob = await exportToBlob({
    elements: shown,
    files,
    appState: {
      exportBackground: true,
      viewBackgroundColor: background,
      exportWithDarkMode: false,
    },
    exportPadding: 20,
    mimeType: "image/png",
    getDimensions: (width: number, height: number) => {
      // never upscale more than 2x, never exceed maxSize
      scale = Math.min(2, maxSize / Math.max(width, height));
      return { width: width * scale, height: height * scale, scale };
    },
  });

  return {
    png: await blobToBase64(blob),
    scale: Math.round(scale * 1000) / 1000,
    renderedBounds: boundsToRect(getCommonBounds(shown) as Bounds),
    sceneBounds: boundsToRect(sceneBounds),
    elementsRendered: shown.length,
    elementsTotal: elements.length,
  };
};
