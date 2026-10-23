// The "Slides" sidebar: the deck of the open scene (frames as slides),
// per-slide settings, reveal steps, and the deck's template + style.

import { CaptureUpdateAction, FONT_FAMILY, Sidebar, newElementWith } from "@excalidraw/excalidraw";
import { useEffect, useState, useSyncExternalStore } from "react";
import clsx from "clsx";

import { scenesController } from "./controller";
import { deck } from "./deck";
import { customFonts } from "./fonts";
import { pickSlides, printInBrowser, printToPdf, slidesHtml } from "./pdfExport";
import { IS_ONLINE } from "./api";
import { PresentationLink } from "./online/ui";
import { presenter } from "./present";
import { slideSorter } from "./slideSorter";
import {
  addSlide,
  applyTheme,
  createTemplate,
  deleteSlides,
  duplicateSlides,
  getTemplate,
  getTheme,
  patchSlideData,
  setSlideOrder,
  slideData,
  withSlideData,
} from "./slides";

import type { DeckTheme } from "./slides";

import "./slides.scss";

export const SLIDES_SIDEBAR_NAME = "slides";

const useDeck = () => useSyncExternalStore(deck.subscribe, deck.getState);

const api = () => {
  const value = deck.getApi();
  if (!value) {
    throw new Error("Editor not ready");
  }
  return value;
};

/** camera on a frame, without locking anything */
const focusFrame = (id: string, select = true) => {
  const frame = api().getSceneElements().find((el) => el.id === id);
  if (!frame) {
    return;
  }
  api().setViewport({ target: frame, fit: "contain", animation: { duration: 400 }, offsets: { ui: true } });
  if (select) {
    api().updateScene({ appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  deck.setActive(id);
};

const FONTS: Array<[string, number]> = [
  ["Excalifont (hand-drawn)", FONT_FAMILY.Excalifont],
  ["Nunito", FONT_FAMILY.Nunito],
  ["Lilita One", FONT_FAMILY["Lilita One"]],
  ["Comic Shanns (code)", FONT_FAMILY["Comic Shanns"]],
  ["Liberation Sans", FONT_FAMILY["Liberation Sans"]],
  ["Assistant", FONT_FAMILY.Assistant],
  ["Virgil (classic)", FONT_FAMILY.Virgil],
];

/** change the deck theme: stored on the template; matching elements follow */
const setTheme = (patch: Partial<DeckTheme>) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const template = getTemplate(elements);
  if (!template) {
    return;
  }
  const from = getTheme(elements);
  const to = { ...from, ...patch };
  const themed = applyTheme(elements, from, to) ?? elements;
  api().updateScene({
    elements: themed.map((el) => (el.id === template.id ? withSlideData(el, { theme: to }) : el)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/** a slide back to the template: template elements restored, deck style applied */
const resetSlides = (ids: string[]) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const theme = getTheme(elements);
  const themed = applyTheme(elements, theme, theme, { force: new Set(ids) });
  if (themed) {
    api().updateScene({ elements: themed, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  deck.runTemplateSync({ reset: new Set(ids) });
};

type PdfChoice = "all" | "current" | "pick";

const exportPdf = async (spec: string, { includeSkipped }: { includeSkipped: boolean }, setBusy: (busy: string | null) => void) => {
  const elements = api().getSceneElementsIncludingDeleted();
  const name = scenesController.getState().current ?? "Untitled";
  const frames = pickSlides(elements, spec, { includeSkipped });
  setBusy(`Preparing ${frames.length} slide${frames.length === 1 ? "" : "s"}…`);
  const html = await slidesHtml(elements, api().getFiles(), frames, {
    deck: name,
    background: api().getAppState().viewBackgroundColor,
  });
  let blob: Blob;
  try {
    setBusy("Printing PDF…");
    blob = await printToPdf(html);
  } catch (error) {
    // scenes server without PDF support (or no Chrome): the browser prints it
    console.warn("PDF via scenes server failed, using the print dialog", error);
    setBusy(null);
    printInBrowser(html);
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const suffix = spec === "all" ? "" : frames.length === 1 ? ` - slide ${deck.getState().slides.findIndex((s) => s.id === frames[0].id) + 1}` : ` - slides ${spec.replace(/\s+/g, "")}`;
  link.download = `${name}${suffix}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  setBusy(null);
};

/** PDF of the whole deck, the current slide or picked slides */
const PdfPanel = ({ onClose }: { onClose: () => void }) => {
  const { slides, activeId } = useDeck();
  const current = slides.find((s) => s.id === activeId);
  const [choice, setChoice] = useState<PdfChoice>(current ? "current" : "all");
  const [pick, setPick] = useState("");
  const [includeSkipped, setIncludeSkipped] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = slides.filter((s) => includeSkipped || !s.skip).length;
  const spec = choice === "all" ? "all" : choice === "current" ? String((current?.index ?? 0) + 1) : pick;
  return (
    <section className="slides-details slides-pdf">
      <div className="slides-section__title">Export PDF</div>
      <label className="slides-check">
        <input type="radio" checked={choice === "all"} onChange={() => setChoice("all")} />
        Whole deck ({shown} slide{shown === 1 ? "" : "s"})
      </label>
      <label className={clsx("slides-check", { "slides-check--off": !current })}>
        <input type="radio" disabled={!current} checked={choice === "current"} onChange={() => setChoice("current")} />
        {current ? `This slide (${current.index + 1}: ${current.title})` : "This slide (select one first)"}
      </label>
      <label className="slides-check">
        <input type="radio" checked={choice === "pick"} onChange={() => setChoice("pick")} />
        Slides
        <input
          className="slides-input slides-pdf__pick"
          placeholder="e.g. 1, 3-5"
          value={pick}
          onFocus={() => setChoice("pick")}
          onChange={(event) => setPick(event.target.value)}
        />
      </label>
      {choice === "all" && slides.some((s) => s.skip) && (
        <label className="slides-check">
          <input type="checkbox" checked={includeSkipped} onChange={(event) => setIncludeSkipped(event.target.checked)} />
          Include skipped slides
        </label>
      )}
      <div className="slides-row">
        <button
          type="button"
          className="slides-btn slides-btn--primary"
          disabled={!!busy || (choice === "pick" && !pick.trim())}
          onClick={() => {
            setError(null);
            exportPdf(spec, { includeSkipped }, setBusy)
              .then(onClose)
              .catch((err) => {
                setBusy(null);
                setError(err.message);
              });
          }}
        >
          {busy ?? "Download PDF"}
        </button>
        <button type="button" className="slides-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <p className="slides-hint slides-hint--error">{error}</p>}
      <p className="slides-hint">Text stays text: selectable and searchable in the PDF.</p>
    </section>
  );
};

// -----------------------------------------------------------------------------

const SlideList = () => {
  const { slides, thumbs, activeId } = useDeck();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      return;
    }
    const ids = slides.map((s) => s.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId) + (slides.findIndex((s) => s.id === dragId) < slides.findIndex((s) => s.id === targetId) ? 1 : 0), 0, dragId);
    setSlideOrder(api(), ids);
  };

  return (
    <ol className="slides-list">
      {slides.map((slide) => (
        <li
          key={slide.id}
          draggable
          onDragStart={(event) => {
            setDragId(slide.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOverId(slide.id);
          }}
          onDragLeave={() => setOverId(null)}
          onDrop={(event) => {
            event.preventDefault();
            drop(slide.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          className={clsx("slides-card", {
            "slides-card--active": slide.id === activeId,
            "slides-card--skip": slide.skip,
            "slides-card--over": overId === slide.id && dragId !== slide.id,
            "slides-card--drag": dragId === slide.id,
          })}
        >
          <span className="slides-card__actions">
            <button
              type="button"
              title="Duplicate this slide"
              aria-label={`Duplicate slide ${slide.index + 1}`}
              onClick={() => {
                const [copy] = duplicateSlides(api(), [slide.id]);
                if (copy) {
                  setTimeout(() => focusFrame(copy), 50);
                }
              }}
            >
              ⧉
            </button>
            <button
              type="button"
              title="Delete this slide (undo with ⌘Z)"
              aria-label={`Delete slide ${slide.index + 1}`}
              onClick={() => window.confirm(`Delete slide ${slide.index + 1} “${slide.title}” with everything on it?`) && deleteSlides(api(), [slide.id])}
            >
              ×
            </button>
          </span>
          <button type="button" className="slides-card__open" onClick={() => focusFrame(slide.id)} title="Show this slide">
            <span className="slides-card__num">{slide.index + 1}</span>
            <span className="slides-card__thumb">{thumbs[slide.id] ? <img src={thumbs[slide.id]} alt="" /> : null}</span>
            <span className="slides-card__meta">
              <span className="slides-card__title">{slide.title}</span>
              <span className="slides-card__badges">
                {slide.skip && <span>skipped</span>}
                {!slide.template && <span>no template</span>}
                {slide.steps > 0 && <span>{slide.steps} step{slide.steps === 1 ? "" : "s"}</span>}
                {slide.notes && <span>notes</span>}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
};

const SlideDetails = ({ id }: { id: string }) => {
  const { slides } = useDeck();
  const slide = slides.find((s) => s.id === id);
  const [title, setTitle] = useState(slide?.title ?? "");
  const [notes, setNotes] = useState(slide?.notes ?? "");
  useEffect(() => {
    setTitle(slide?.title ?? "");
    setNotes(slide?.notes ?? "");
  }, [id, slide?.title, slide?.notes]);
  if (!slide) {
    return null;
  }
  const saveTitle = () => {
    if (title.trim() && title.trim() !== slide.title) {
      const elements = api().getSceneElementsIncludingDeleted();
      api().updateScene({
        elements: elements.map((el) => (el.id === id ? newElementWith(el as any, { name: title.trim() } as any) : el)),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  };
  const saveNotes = () => {
    if (notes !== slide.notes) {
      patchSlideData(api(), new Map([[id, { notes: notes || undefined }]]));
    }
  };
  return (
    <section className="slides-details">
      <div className="slides-section__title">Slide {slide.index + 1}</div>
      <input
        className="slides-input"
        value={title}
        aria-label="Slide title"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      <textarea
        className="slides-input slides-notes"
        placeholder="Speaker notes (presenter view)"
        value={notes}
        rows={3}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={saveNotes}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <label className="slides-check">
        <input type="checkbox" checked={slide.skip} onChange={(event) => patchSlideData(api(), new Map([[id, { skip: event.target.checked || undefined }]]))} />
        Skip when presenting (backup slide)
      </label>
      <label className="slides-check">
        <input
          type="checkbox"
          checked={slide.template}
          onChange={(event) => patchSlideData(api(), new Map([[id, { template: event.target.checked ? undefined : false }]]))}
        />
        Show template (header, footer, logo…)
      </label>
      <div className="slides-row">
        <button type="button" className="slides-btn" onClick={() => presenter.start(id)}>
          ▶ From here
        </button>
        <button type="button" className="slides-btn" onClick={() => addSlide(api(), id)}>
          + After
        </button>
        <button
          type="button"
          className="slides-btn"
          title="Template elements back as in the template, deck fonts and colors on all elements of this slide"
          onClick={() => resetSlides([id])}
        >
          Reset to template
        </button>
      </div>
    </section>
  );
};

const StepPicker = () => {
  const { selection } = useDeck();
  if (!selection.length) {
    return null;
  }
  const elements = api().getSceneElements();
  const chosen = elements.filter((el) => selection.includes(el.id));
  if (!chosen.some((el) => el.frameId)) {
    return null;
  }
  const steps = new Set(chosen.map((el) => slideData(el).step ?? 0));
  const value = steps.size === 1 ? [...steps][0] : -1;
  const setStep = (step: number) => {
    // groups and bound labels go along
    const groups = new Set(chosen.flatMap((el) => el.groupIds));
    const ids = new Set(
      elements
        .filter((el) => selection.includes(el.id) || el.groupIds.some((g) => groups.has(g)) || ((el as any).containerId && selection.includes((el as any).containerId)))
        .map((el) => el.id),
    );
    patchSlideData(api(), new Map([...ids].map((id) => [id, { step: step || undefined }])));
  };
  return (
    <section className="slides-details">
      <div className="slides-section__title">Selection appears</div>
      <div className="slides-steps">
        {[0, 1, 2, 3, 4, 5, 6].map((step) => (
          <button key={step} type="button" className={clsx("slides-chip", { "slides-chip--on": value === step })} onClick={() => setStep(step)}>
            {step === 0 ? "Always" : `Click ${step}`}
          </button>
        ))}
      </div>
    </section>
  );
};

const ThemeForm = () => {
  const { theme, templateId } = useDeck();
  // fonts the user added are deck fonts too (a hook: before any early return)
  useSyncExternalStore(customFonts.subscribe, customFonts.version);
  if (!templateId) {
    return (
      <section className="slides-details">
        <div className="slides-section__title">Template &amp; style</div>
        <p className="slides-hint">
          One template frame for the whole deck: put header, footer, logo or a background in it, and they appear on every slide.
          It also holds the deck's fonts and colors.
        </p>
        <button type="button" className="slides-btn slides-btn--primary" onClick={() => focusFrame(createTemplate(api()), false)}>
          Create template
        </button>
      </section>
    );
  }
  const select = <K extends keyof DeckTheme>(key: K, options: Array<[string, DeckTheme[K]]>) => (
    <select
      className="slides-input"
      value={String(theme[key])}
      onChange={(event) => {
        const option = options.find(([, value]) => String(value) === event.target.value);
        if (option) {
          setTheme({ [key]: option[1] } as Partial<DeckTheme>);
        }
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {options.map(([label, value]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );
  const color = (key: "textColor" | "strokeColor", label: string) => (
    <label className="slides-field">
      <span>{label}</span>
      <input type="color" value={theme[key]} onChange={(event) => setTheme({ [key]: event.target.value })} />
    </label>
  );
  return (
    <section className="slides-details">
      <div className="slides-section__title">Template &amp; style</div>
      <div className="slides-row">
        <button type="button" className="slides-btn" onClick={() => focusFrame(templateId, false)}>
          Edit template
        </button>
        <button
          type="button"
          className="slides-btn"
          title="Deck fonts and colors on every slide, template elements restored everywhere"
          onClick={() => {
            if (window.confirm("Apply the deck style to every slide? Fonts and colors you changed on single slides are reset.")) {
              resetSlides(deck.getState().slides.map((s) => s.id));
            }
          }}
        >
          Reset all slides
        </button>
      </div>
      <p className="slides-hint">
        Template text can use <code>{"{page}"}</code> <code>{"{total}"}</code> <code>{"{title}"}</code> <code>{"{deck}"}</code>{" "}
        <code>{"{date}"}</code>. Template elements are locked on slides; unlock one to change it on that slide only.
      </p>
      <label className="slides-field">
        <span>Font</span>
        {select("fontFamily", [...FONTS, ...customFonts.list().map((font): [string, number] => [font.family, font.id])])}
      </label>
      <div className="slides-grid">
        <label className="slides-field">
          <span>Title size</span>
          {select("titleSize", [["48", 48], ["56", 56], ["64", 64], ["72", 72], ["96", 96], ["120", 120]])}
        </label>
        <label className="slides-field">
          <span>Text size</span>
          {select("bodySize", [["20", 20], ["24", 24], ["28", 28], ["32", 32], ["36", 36], ["44", 44]])}
        </label>
        {color("textColor", "Text color")}
        {color("strokeColor", "Line color")}
        <label className="slides-field">
          <span>Sloppiness</span>
          {select("roughness", [["Architect", 0], ["Artist", 1], ["Cartoonist", 2]])}
        </label>
        <label className="slides-field">
          <span>Stroke</span>
          {select("strokeWidth", [["Thin", 1], ["Bold", 2], ["Extra bold", 4]])}
        </label>
        <label className="slides-field">
          <span>Fill</span>
          {select("fillStyle", [["Solid", "solid"], ["Hachure", "hachure"], ["Cross-hatch", "cross-hatch"], ["Zigzag", "zigzag"]])}
        </label>
        <label className="slides-field">
          <span>Transition</span>
          {select("transition", [["Glide", "glide"], ["Cut", "cut"]])}
        </label>
      </div>
      <p className="slides-hint">New elements use this style. Elements that still have the deck's values follow changes; what you styled by hand stays.</p>
    </section>
  );
};

export const SlidesSidebar = () => {
  const { slides, activeId } = useDeck();
  const [pdfOpen, setPdfOpen] = useState(false);
  const active = slides.find((s) => s.id === activeId) ? activeId : null;
  return (
    <Sidebar name={SLIDES_SIDEBAR_NAME} className="slides-sidebar">
      <Sidebar.Header>
        <div className="scenes-sidebar__title">Slides</div>
      </Sidebar.Header>
      <div className="slides-body">
        <div className="slides-row">
          <button
            type="button"
            className="slides-btn slides-btn--primary"
            disabled={!slides.some((s) => !s.skip)}
            onClick={() => presenter.start(active ?? undefined)}
            title="Present (Esc ends)"
          >
            ▶ Present
          </button>
          {IS_ONLINE && <PresentationLink />}
          <button
            type="button"
            className="slides-btn"
            onClick={() => {
              const id = addSlide(api(), active ?? undefined);
              setTimeout(() => focusFrame(id), 50);
            }}
          >
            + Slide
          </button>
          <button
            type="button"
            className="slides-btn"
            disabled={slides.length < 1}
            onClick={() => slideSorter.open()}
            title="All slides as a grid: drag to reorder, duplicate, delete"
          >
            Sort
          </button>
          <button
            type="button"
            className="slides-btn"
            disabled={!slides.length}
            aria-pressed={pdfOpen}
            onClick={() => setPdfOpen(!pdfOpen)}
          >
            PDF
          </button>
        </div>
        {pdfOpen && <PdfPanel onClose={() => setPdfOpen(false)} />}
        {!slides.length ? (
          <p className="slides-hint">
            Every frame on the canvas is a slide. Add one with “+ Slide”, or draw frames with the frame tool (F). Drag slides here to reorder them, or open “Sort” for all slides at once.
          </p>
        ) : (
          <SlideList />
        )}
        <StepPicker />
        {active && <SlideDetails id={active} />}
        <ThemeForm />
      </div>
    </Sidebar>
  );
};
