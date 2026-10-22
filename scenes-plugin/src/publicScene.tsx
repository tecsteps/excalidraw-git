// Public scenes (kurviq.com/features): decks everyone can look at, shown
// read-only above the editor, slide by slide. They are not added to the
// visitor's scenes; "Make a copy" does that on purpose.
//
// The files are online/scenes/<name>.excalidraw, served at /scenes/<name>.excalidraw.

import { restoreElements } from "@excalidraw/excalidraw";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { IS_ONLINE } from "./api";
import { scenesController } from "./controller";
import { getSlides, renderSlide } from "./slides";

export const PUBLIC_SCENES: Record<string, { title: string; copyName: string }> = IS_ONLINE
  ? { features: { title: "What Kurviq adds to Excalidraw", copyName: "Kurviq features" } }
  : {};

export const isPublicScene = (name: string | null): name is string => !!name && name in PUBLIC_SCENES;

// -----------------------------------------------------------------------------
// open / close (the router follows: URL /<name> while open)
// -----------------------------------------------------------------------------

let shown: string | null = null;
const listeners = new Set<() => void>();
const setShown = (name: string | null) => {
  shown = name;
  listeners.forEach((listener) => listener());
};

export const publicScene = {
  show: (name: string) => setShown(name),
  close: () => setShown(null),
  shown: () => shown,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const fetchScene = (name: string) =>
  fetch(`/scenes/${encodeURIComponent(name)}.excalidraw`).then((res) => {
    if (!res.ok) {
      throw new Error(`Could not load "${name}" (${res.status})`);
    }
    return res.text();
  });

/** a local-only copy in the visitor's scenes, opened */
const makeCopy = async (name: string, json: string) => {
  const base = PUBLIC_SCENES[name].copyName;
  for (let n = 1; n < 50; n++) {
    const copy = n === 1 ? base : `${base} ${n}`;
    try {
      await scenesController.createLocalOnly(copy, json);
    } catch (error: any) {
      if (error.status === 409) {
        continue;
      }
      throw error;
    }
    publicScene.close();
    await scenesController.open(copy);
    return;
  }
};

// -----------------------------------------------------------------------------
// the viewer
// -----------------------------------------------------------------------------

type Deck = { json: string; elements: any[]; files: BinaryFiles; slides: ReturnType<typeof getSlides> };

const Viewer = ({ name }: { name: string }) => {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [copying, setCopying] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pictures = useRef(new Map<number, HTMLCanvasElement>());

  useEffect(() => {
    fetchScene(name)
      .then((json) => {
        const data = JSON.parse(json);
        const elements = restoreElements(data.elements, null).filter((el) => !el.isDeleted);
        setDeck({ json, elements, files: data.files || {}, slides: getSlides(elements) });
      })
      .catch((err) => setError(err.message));
    root.current?.focus();
  }, [name]);

  // the current slide as a picture (cached)
  useEffect(() => {
    if (!deck?.slides[index]) {
      return;
    }
    let cancelled = false;
    const cached = pictures.current.get(index);
    const picture = cached
      ? Promise.resolve(cached)
      : renderSlide(deck.elements, deck.files, deck.slides[index], { width: 1920, background: "#ffffff" });
    picture.then((canvas) => {
      pictures.current.set(index, canvas);
      if (!cancelled && stage.current) {
        stage.current.replaceChildren(canvas);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deck, index]);

  const count = deck?.slides.length ?? 0;
  const go = (to: number) => setIndex(Math.max(0, Math.min(count - 1, to)));

  const onKeyDown = (event: React.KeyboardEvent) => {
    // the editor below must not see these keys
    event.stopPropagation();
    if (event.key === "Escape") {
      publicScene.close();
    } else if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      go(index + 1);
    } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === "Home") {
      go(0);
    } else if (event.key === "End") {
      go(count - 1);
    }
  };

  return (
    <div
      ref={root}
      className="public-scene"
      role="dialog"
      aria-modal="true"
      aria-label={PUBLIC_SCENES[name].title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="public-scene__bar">
        <strong className="public-scene__title">{PUBLIC_SCENES[name].title}</strong>
        <span className="public-scene__spacer" />
        <button
          type="button"
          className="slides-btn"
          disabled={!deck || copying}
          title="Add a copy to your scenes, to change or present it"
          onClick={() => {
            setCopying(true);
            makeCopy(name, deck!.json)
              .catch((err) => setError(err.message))
              .finally(() => setCopying(false));
          }}
        >
          {copying ? "Copying…" : "Make a copy"}
        </button>
        <button type="button" className="slides-btn slides-btn--primary" onClick={() => publicScene.close()} title="Esc">
          Back to my drawings
        </button>
      </div>
      {error && <p className="scenes-error public-scene__error">{error}</p>}
      <div className="public-scene__stage" onClick={() => go(index + 1)}>
        <div ref={stage} className="public-scene__slide" />
      </div>
      <div className="public-scene__nav">
        <button type="button" className="slides-btn" disabled={index === 0} onClick={() => go(index - 1)} aria-label="Previous slide">
          ‹
        </button>
        <span className="public-scene__count">{count ? `${index + 1} / ${count}` : "…"}</span>
        <button type="button" className="slides-btn" disabled={index >= count - 1} onClick={() => go(index + 1)} aria-label="Next slide">
          ›
        </button>
      </div>
    </div>
  );
};

/** rendered next to the editor (see index.tsx) */
export const PublicSceneOverlay = () => {
  const name = useSyncExternalStore(publicScene.subscribe, publicScene.shown);
  return isPublicScene(name) ? <Viewer key={name} name={name} /> : null;
};
