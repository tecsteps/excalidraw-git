// Slide sorter: all slides of the deck as a grid, like a light table. Drag
// slides (one or a selection) to any position, duplicate or delete them
// anywhere in the deck. Every change is one undoable step on the canvas.
//
// Keys: click / ⌘-click / ⇧-click select, ⌘A all, ←/→ move the focus,
// ⌥←/⌥→ move the selection, ⌘D duplicate, ⌫ delete, ↵ open, Esc close.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import clsx from "clsx";

import { deck } from "./deck";
import { deleteSlides, duplicateSlides, moveSlides } from "./slides";

// -----------------------------------------------------------------------------
// open / close (a tiny store, so the sidebar can open the overlay)
// -----------------------------------------------------------------------------

let open = false;
const listeners = new Set<() => void>();
const setOpen = (value: boolean) => {
  open = value;
  listeners.forEach((listener) => listener());
};

export const slideSorter = {
  open: () => setOpen(true),
  close: () => setOpen(false),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isOpen: () => open,
};

const useDeck = () => useSyncExternalStore(deck.subscribe, deck.getState);

const api = () => {
  const value = deck.getApi();
  if (!value) {
    throw new Error("Editor not ready");
  }
  return value;
};

/** camera on a slide (after closing the sorter) */
const showSlide = (id: string) => {
  const frame = api().getSceneElements().find((el) => el.id === id);
  if (frame) {
    api().setViewport({ target: frame, fit: "contain", animation: { duration: 400 }, offsets: { ui: true } });
    deck.setActive(id);
  }
};

const Sorter = () => {
  const { slides, thumbs } = useDeck();
  const [selected, setSelected] = useState<string[]>(() => (deck.getState().activeId ? [deck.getState().activeId!] : []));
  const [anchor, setAnchor] = useState<string | null>(selected[0] ?? null);
  const [dragging, setDragging] = useState<string[] | null>(null);
  /** drop position: before the slide at this index (slides.length = at the end) */
  const [dropAt, setDropAt] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const ids = slides.map((slide) => slide.id);
  const chosen = ids.filter((id) => selected.includes(id));

  useEffect(() => {
    root.current?.focus();
  }, []);
  // slides deleted elsewhere drop out of the selection
  useEffect(() => {
    if (selected.some((id) => !ids.includes(id))) {
      setSelected(selected.filter((id) => ids.includes(id)));
    }
  }, [ids.join(",")]);

  const select = (id: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    if (event.shiftKey && anchor && ids.includes(anchor)) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      setSelected(ids.slice(a, b + 1));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    } else {
      setSelected([id]);
    }
    setAnchor(id);
  };

  const duplicate = () => {
    if (chosen.length) {
      const created = duplicateSlides(api(), chosen);
      setSelected(created);
      setAnchor(created[0] ?? null);
    }
  };

  const remove = () => {
    if (!chosen.length) {
      return;
    }
    const label = chosen.length === 1 ? `slide ${ids.indexOf(chosen[0]) + 1}` : `${chosen.length} slides`;
    if (window.confirm(`Delete ${label} with everything on it? (Undo with ⌘Z in the editor)`)) {
      const next = ids.find((id, index) => !chosen.includes(id) && index > ids.indexOf(chosen[chosen.length - 1]));
      deleteSlides(api(), chosen);
      setSelected(next ? [next] : []);
      setAnchor(next ?? null);
    }
  };

  /** move the selection one step left (-1) or right (+1) */
  const nudge = (delta: number) => {
    if (!chosen.length) {
      return;
    }
    const rest = ids.filter((id) => !chosen.includes(id));
    const first = ids.indexOf(chosen[0]);
    // index in `rest` where the block starts now, then one step further
    const start = rest.filter((id) => ids.indexOf(id) < first).length;
    moveSlides(api(), chosen, Math.max(0, Math.min(rest.length, start + delta)));
  };

  const close = () => slideSorter.close();

  const onKeyDown = (event: KeyboardEvent) => {
    // the editor must not see these keys (⌫ would delete canvas elements)
    event.stopPropagation();
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(ids);
    } else if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicate();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      remove();
    } else if (event.key === "Enter" && chosen.length === 1) {
      event.preventDefault();
      close();
      showSlide(chosen[0]);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      if (event.altKey) {
        nudge(delta);
        return;
      }
      const from = chosen.length ? ids.indexOf(delta < 0 ? chosen[0] : chosen[chosen.length - 1]) : -1;
      const next = ids[Math.max(0, Math.min(ids.length - 1, from + delta))];
      if (next) {
        select(next, { metaKey: false, ctrlKey: false, shiftKey: event.shiftKey });
      }
    }
  };

  const onDragOver = (event: DragEvent, index: number) => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt(event.clientX < box.left + box.width / 2 ? index : index + 1);
  };

  const drop = () => {
    if (dragging && dropAt !== null) {
      // the drop index counts all slides; moveSlides counts the ones that stay
      const before = ids.slice(0, dropAt).filter((id) => !dragging.includes(id)).length;
      moveSlides(api(), dragging, before);
    }
    setDragging(null);
    setDropAt(null);
  };

  return (
    <div
      ref={root}
      className="slide-sorter"
      role="dialog"
      aria-modal="true"
      aria-label="Sort slides"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="slide-sorter__bar">
        <strong>Sort slides</strong>
        <span className="slide-sorter__hint">
          {chosen.length ? `${chosen.length} selected` : "Drag slides to reorder · click to select, ⇧/⌘ for more"}
        </span>
        <span className="slide-sorter__spacer" />
        <button type="button" className="slides-btn" disabled={!chosen.length} onClick={duplicate} title="Duplicate (⌘D)">
          Duplicate
        </button>
        <button type="button" className="slides-btn" disabled={!chosen.length} onClick={() => moveSlides(api(), chosen, 0)} title="Move to the start">
          ⇤ Start
        </button>
        <button
          type="button"
          className="slides-btn"
          disabled={!chosen.length}
          onClick={() => moveSlides(api(), chosen, ids.length)}
          title="Move to the end"
        >
          End ⇥
        </button>
        <button type="button" className="slides-btn slides-btn--danger" disabled={!chosen.length} onClick={remove} title="Delete (⌫)">
          Delete
        </button>
        <button type="button" className="slides-btn slides-btn--primary" onClick={close} title="Close (Esc)">
          Done
        </button>
      </div>
      {!slides.length ? (
        <p className="slide-sorter__empty">No slides yet: add one with “+ Slide” in the Slides sidebar.</p>
      ) : (
        <ol
          className="slide-sorter__grid"
          onDragOver={(event) => {
            // past the last card: drop at the end
            if (dragging && event.target === event.currentTarget) {
              event.preventDefault();
              setDropAt(ids.length);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            drop();
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelected([]);
            }
          }}
        >
          {slides.map((slide, index) => (
            <li
              key={slide.id}
              className={clsx("slide-sorter__card", {
                "slide-sorter__card--selected": selected.includes(slide.id),
                "slide-sorter__card--skip": slide.skip,
                "slide-sorter__card--dragging": dragging?.includes(slide.id),
                "slide-sorter__card--drop-before": dropAt === index,
                "slide-sorter__card--drop-after": dropAt === ids.length && index === ids.length - 1,
              })}
              draggable
              onDragStart={(event) => {
                const group = selected.includes(slide.id) ? chosen : [slide.id];
                if (!selected.includes(slide.id)) {
                  setSelected([slide.id]);
                  setAnchor(slide.id);
                }
                setDragging(group);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", group.join(","));
              }}
              onDragOver={(event) => onDragOver(event, index)}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
              onClick={(event) => select(slide.id, event)}
              onDoubleClick={() => {
                close();
                showSlide(slide.id);
              }}
              title={`${slide.title} — double-click to open`}
            >
              <span className="slide-sorter__thumb">{thumbs[slide.id] ? <img src={thumbs[slide.id]} alt="" draggable={false} /> : null}</span>
              <span className="slide-sorter__meta">
                <span className="slide-sorter__num">{index + 1}</span>
                <span className="slide-sorter__title">{slide.title}</span>
                {slide.skip && <span className="slide-sorter__badge">skipped</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

/** rendered next to the editor (see index.tsx); shows the sorter while it is open */
export const SlideSorterOverlay = () => {
  const isOpen = useSyncExternalStore(slideSorter.subscribe, slideSorter.isOpen);
  return isOpen ? <Sorter /> : null;
};
