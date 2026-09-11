import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { maskTidalCode } from "@management/cm-evaluate";

import "./active-orbits.css";

export const setActiveOrbitsEffect = StateEffect.define<number[]>();

// d-numbers (the N in `dN $`) that currently hold sounding patterns,
// as reported by the running Tidal Stream (see tmActiveDs in BootTidal.hs).
// Null means unknown (no successful query yet): consumers must treat that
// as "keep current behavior", never as "nothing sounds", or the bug starves
// on a session that predates the query helper.
export const activeOrbitsField = StateField.define<
  ReadonlySet<number> | null
>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setActiveOrbitsEffect)) return new Set(effect.value);
    }
    return value;
  },
});

// Fresh cycle-head pulse (performance.now() timestamp, null when idle).
// While set, active `dN` tokens flash rainbow for ~100ms.
export const flashActiveOrbitsEffect = StateEffect.define<number | null>();

export const flashActiveOrbitsField = StateField.define<number | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(flashActiveOrbitsEffect)) return effect.value;
    }
    return value;
  },
});

const activeTokenDecoration = Decoration.mark({
  class: "cm-active-orbit-token",
});

// Paragraph blocks, the same unit as evaluateBlock/silenceBlock: runs of
// non-blank lines. Returns the ranges of the `dN` tokens themselves whose
// number is active. The whole block is masked first so strings and
// comments (including multi-line ones) never match. Masking preserves
// positions ahead of a line-start match, so masked offsets map back onto
// the document directly.
export function activeDTokenRanges(
  doc: Text,
  active: ReadonlySet<number> | null
): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  if (active === null || active.size === 0) return ranges;
  let number = 1;
  while (number <= doc.lines) {
    if (!doc.line(number).text.trim()) {
      number += 1;
      continue;
    }
    let last = number;
    while (last < doc.lines && doc.line(last + 1).text.trim()) last += 1;
    const masked = maskTidalCode(
      doc.sliceString(doc.line(number).from, doc.line(last).to)
    ).split("\n");
    masked.forEach((maskedLine, offset) => {
      const match = maskedLine.match(/^(\s*)(d\d+)(?=\s*\$)/);
      if (match && active.has(Number(match[2].slice(1)))) {
        const tokenFrom = doc.line(number + offset).from + match[1].length;
        ranges.push({ from: tokenFrom, to: tokenFrom + match[2].length });
      }
    });
    number = last + 1;
  }
  return ranges;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (view.state.field(flashActiveOrbitsField) === null) {
    return builder.finish();
  }
  for (const range of activeDTokenRanges(
    view.state.doc,
    view.state.field(activeOrbitsField)
  )) {
    builder.add(range.from, range.to, activeTokenDecoration);
  }
  return builder.finish();
}

export const activeOrbitsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private active: ReadonlySet<number> | null;
    private flash: number | null;

    constructor(view: EditorView) {
      this.active = view.state.field(activeOrbitsField);
      this.flash = view.state.field(flashActiveOrbitsField);
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const active = update.state.field(activeOrbitsField);
      const flash = update.state.field(flashActiveOrbitsField);
      if (
        active !== this.active ||
        flash !== this.flash ||
        update.docChanged
      ) {
        this.active = active;
        this.flash = flash;
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations }
);

export function activeOrbitsHighlight() {
  return [activeOrbitsField, flashActiveOrbitsField, activeOrbitsPlugin];
}
