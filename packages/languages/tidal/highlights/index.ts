import {
  EditorState,
  StateEffect,
  Range,
  Extension,
  RangeSetBuilder,
  Prec,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";

import {
  evaluation,
  evaluationEffect,
  evaluationKeymap,
} from "@management/cm-evaluate";

import {
  MininotationString,
  mininotationStringField,
  replaceMininotationEffect,
  TimestampedHighlightEvent,
  highlightTickEffect,
  highlightAddEffect,
  highlightSetField,
  heatmapAddEffect,
  heatmapHalfLifeMs,
  heatmapNowField,
  heatmapSetField,
} from "./state";

export function evaluationWithHighlights(
  action: (evaluation: { code: string }) => void
): Extension {
  const handler = EditorState.transactionExtender.of((tr) => {
    // New effects to be added
    let effects = [];

    for (let effect of tr.effects) {
      if (effect.is(evaluationEffect)) {
        if (effect.value.span !== undefined) {
          let { from, to } = effect.value.span;
          let { newCode, mininotationStrings } = wrapMininotation(
            effect.value.code,
            from
          );

          action({ code: newCode });

          effects.push(
            replaceMininotationEffect.of({ from, to, mininotationStrings })
          );
        } else {
          action(effect.value);
        }
      }
    }

    return effects.length > 0 ? { effects } : null;
  });

  return [
    keymap.of(evaluationKeymap),
    evaluation(),
    handler,
    mininotationStringField,
  ];
}

function wrapMininotation(code: string, from: number) {
  let mininotationStrings: Range<MininotationString>[] = [];

  let newCode = "";

  let parts = code.split(/("(?:(?!(?:\\|")).|\\.)*")/);

  while (parts.length > 0) {
    let string: string;
    [string, ...parts] = parts;

    if (string.match(/^".*"$/)) {
      let miniString = new MininotationString();
      newCode += `(deltaContext 0 ${miniString.id} ${string})`;
      mininotationStrings.push(miniString.range(from, from + string.length));
    } else {
      newCode += string;
    }

    from += string.length;
  }

  return { newCode, mininotationStrings };
}

import { ElectronAPI } from "@core/api";
import { fromNTPTime } from "@core/osc/utils";

export function highlighter(api: typeof ElectronAPI): Extension {
  const highlighterPlugin = ViewPlugin.define((view) => {
    let pendingHighlights: TimestampedHighlightEvent[] = [];

    let offTidalHighlight = api.onTidalHighlight((highlight) => {
      // TODO: Filter out duplicate highlights
      pendingHighlights.push({
        ...highlight,
        time: fromNTPTime(highlight.onset),
      });
    });

    const update = (time: number) => {
      let effects: StateEffect<any>[] = [];

      effects.push(highlightTickEffect.of(time));

      let toAdd: TimestampedHighlightEvent[] = [];
      let stillPending: TimestampedHighlightEvent[] = [];

      // Partition the pending events based on whether they're ready
      for (let event of pendingHighlights) {
        if (event.time > time) {
          stillPending.push(event);
        } else {
          if (event.time + event.duration >= time) {
            toAdd.push(event);
          }
          // Any events that were just dispatched and have already ended
          // are discarded
        }
      }

      if (toAdd.length) {
        effects.push(highlightAddEffect.of(toAdd));
        effects.push(heatmapAddEffect.of(toAdd));
      }

      pendingHighlights = stillPending;

      if (effects.length) {
        view.dispatch({ effects });
      }

      animationFrame = requestAnimationFrame(update);
    };

    let animationFrame = requestAnimationFrame(update);

    return {
      destroy: () => {
        offTidalHighlight();
        cancelAnimationFrame(animationFrame);
      },
    };
  });

  return [
    highlighterPlugin,
    highlightSetField,
    heatmapSetField,
    heatmapNowField,
    Prec.lowest(heatmapDecorations),
    Prec.highest(highlightDecorations),
  ];
}

const activeHighlightStyle =
  "box-shadow: inset 0 -0.14em 0 var(--color-livecode-active-event-background); color: var(--color-foreground)";
const startleDurationMs = 140;

const highlightDecoration = Decoration.mark({
  attributes: {
    style: activeHighlightStyle,
  },
});

function decorationForHighlight(
  highlight: TimestampedHighlightEvent,
  now: number
) {
  const age = Math.max(0, now - highlight.time);
  if (age >= startleDurationMs) return highlightDecoration;

  return Decoration.mark({
    attributes: {
      class: "cm-livecode-active-event",
      style: `${activeHighlightStyle}; animation-delay: -${age.toFixed(1)}ms`,
    },
  });
}

const highlightDecorations = EditorView.decorations.compute(
  [mininotationStringField, highlightSetField, heatmapNowField],
  (state) => {
    const setBuilder = new RangeSetBuilder<Decoration>();

    const mininotationRanges = state.field(mininotationStringField);
    const currentHighlights = state.field(highlightSetField);
    const now = state.field(heatmapNowField);

    let mininotationCursor = mininotationRanges.iter();

    while (mininotationCursor.value !== null) {
      let { from, value: miniString } = mininotationCursor;

      let highlightsInMini = currentHighlights
        .filter(({ miniID }) => miniID === miniString.id)
        .sort((a, b) => a.from - b.from);

      for (let highlight of highlightsInMini) {
        setBuilder.add(
          highlight.from + from,
          highlight.to + from,
          decorationForHighlight(highlight, now)
        );
      }

      mininotationCursor.next();
    }

    return setBuilder.finish();
  }
);

const heatmapDecorations = EditorView.decorations.compute(
  [mininotationStringField, heatmapSetField, heatmapNowField],
  (state) => {
    const decorations: Range<Decoration>[] = [];
    const mininotationRanges = state.field(mininotationStringField);
    const hits = state.field(heatmapSetField);
    const now = state.field(heatmapNowField);
    let mininotationCursor = mininotationRanges.iter();

    while (mininotationCursor.value !== null) {
      const { from, value: miniString } = mininotationCursor;

      for (const hit of hits.filter(({ miniID }) => miniID === miniString.id)) {
        const traces = [...hit.traces].sort((a, b) => a.phase - b.phase);
        const stripeWidth = 100 / traces.length;
        const gradientStops = traces.flatMap((trace, index) => {
          const age = Math.max(0, now - trace.lastHit);
          const fade = Math.pow(0.5, age / heatmapHalfLifeMs);
          const density = Math.min(1, trace.activity / 4);
          const alpha = (0.2 + density * 0.6) * fade;
          const color = cycleColor(trace.phase, alpha);
          const start = (index * stripeWidth).toFixed(2);
          const end = ((index + 1) * stripeWidth).toFixed(2);
          return [`${color} ${start}%`, `${color} ${end}%`];
        });
        const phaseSummary = traces
          .map((trace) => formatPhase(trace.phase))
          .join(", ");
        const decoration = Decoration.mark({
          attributes: {
            class: "cm-pattern-heatmap",
            style: `--heatmap-background: linear-gradient(90deg, ${gradientStops.join(", ")})`,
            title: `Cycle phase ${phaseSummary}`,
          },
        });
        decorations.push(decoration.range(hit.from + from, hit.to + from));
      }

      mininotationCursor.next();
    }

    return Decoration.set(decorations, true);
  }
);

const cyclePalette = [
  "#008000", // downbeat: CSS GREEN
  "#6ED4E3",
  "#94A1FF",
  "#D4F357",
  "#FFA020",
];

function cycleColor(phase: number, alpha: number) {
  const paletteIndex =
    Math.round(phase * cyclePalette.length) % cyclePalette.length;
  const hex = cyclePalette[paletteIndex];
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return `rgb(${red} ${green} ${blue} / ${alpha.toFixed(3)})`;
}

function formatPhase(phase: number) {
  const twelfths = Math.round(phase * 12);
  if (twelfths === 0) return "0";

  const divisor = [6, 4, 3, 2].find((value) => twelfths % value === 0) ?? 1;
  return `${twelfths / divisor}/${12 / divisor}`;
}
