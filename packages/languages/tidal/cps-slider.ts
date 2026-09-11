import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { evaluate, maskTidalCode } from "@management/cm-evaluate";

import "./cps-slider.css";

export const cpsMin = 0.3;
export const cpsMax = 3.0;
export const cpsStep = 0.01;
const cpsDebounceMs = 25;

export interface CpsSliderMatch {
  from: number;
  to: number;
  value: number;
}

const cpsPattern = /\bsetcps\s+\(?(\d+(?:\.\d+)?)/g;

export function formatCps(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// One Tidal cycle is one bar of four beats.
export function formatBpm(value: number): string {
  return String(Math.round(value * 240));
}

// The numeric arguments of `setcps` in Tidal code. Strings and comments
// never match: positions refer to the original source.
export function findCpsSliders(source: string): CpsSliderMatch[] {
  const masked = maskTidalCode(source);
  const matches: CpsSliderMatch[] = [];
  for (const match of masked.matchAll(cpsPattern)) {
    if (match.index === undefined) continue;
    const raw = match[1];
    const from = match.index + match[0].length - raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    matches.push({
      from,
      to: from + raw.length,
      value: Math.min(cpsMax, Math.max(cpsMin, value)),
    });
  }
  return matches;
}

class CpsSliderWidget extends WidgetType {
  constructor(
    readonly match: CpsSliderMatch,
    readonly onInput: (value: number) => void,
    readonly onCommit: (match: CpsSliderMatch, value: number) => void
  ) {
    super();
  }

  eq(other: CpsSliderWidget): boolean {
    return (
      other instanceof CpsSliderWidget &&
      other.match.from === this.match.from &&
      other.match.to === this.match.to &&
      other.match.value === this.match.value
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "tm-cps-slider";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(cpsMin);
    input.max = String(cpsMax);
    input.step = String(cpsStep);
    input.value = String(this.match.value);
    input.setAttribute("aria-label", "Tempo (cycles per second)");
    const bpm = document.createElement("span");
    bpm.className = "tm-cps-slider-bpm";
    bpm.textContent = formatBpm(this.match.value);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      bpm.textContent = formatBpm(value);
      this.onInput(value);
    });
    input.addEventListener("change", () => {
      this.onCommit(this.match, Number(input.value));
    });
    wrap.append(input, bpm);
    return wrap;
  }
}

// Replaces `setcps` numbers with sliders. Dragging evaluates debounced;
// releasing writes the value back so the document stays in sync.
export function cpsSlider() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private pendingValue: number | null = null;

      constructor(private view: EditorView) {
        this.decorations = this.build(view.state);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = this.build(update.state);
        }
      }

      destroy() {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
      }

      private build(state: EditorState): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        for (const match of findCpsSliders(state.doc.toString())) {
          builder.add(
            match.from,
            match.to,
            Decoration.replace({
              widget: new CpsSliderWidget(
                match,
                (value) => this.queueEvaluate(value),
                (found, value) => this.commitValue(found, value)
              ),
            })
          );
        }
        return builder.finish();
      }

      private queueEvaluate(value: number) {
        this.pendingValue = value;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pendingValue === null) return;
          const code = `setcps ${formatCps(this.pendingValue)}`;
          this.pendingValue = null;
          try {
            if (this.view.dom.isConnected) {
              this.view.dispatch(evaluate(this.view.state, code));
            }
          } catch {
            // The view is gone; drop the evaluation.
          }
        }, cpsDebounceMs);
      }

      private commitValue(match: CpsSliderMatch, value: number) {
        try {
          const current = this.view.state.doc.sliceString(
            match.from,
            match.to
          );
          if (!/^\d+(?:\.\d+)?$/.test(current)) return;
          this.view.dispatch({
            changes: {
              from: match.from,
              to: match.to,
              insert: formatCps(value),
            },
          });
        } catch {
          // The document moved on; leave it alone.
        }
      }
    },
    { decorations: (value) => value.decorations }
  );
}
