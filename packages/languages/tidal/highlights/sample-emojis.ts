import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

import type { HeatmapHit, TimestampedHighlightEvent } from "./state";
import {
  heatmapHalfLifeMs,
  heatmapNowField,
  heatmapSetField,
  highlightSetField,
  hoveredMininotationField,
  mininotationStringField,
} from "./state";
import { textReactionMotion, tidalReducedMotion } from "./reaction";

const emojiForSample: Record<string, string> = {
  toys: "🧸",
  "808": "🥁",
  bin: "🗑️",
  perc: "🪘",
  bd: "💥",
  industrial: "🏭",
  newnotes: "🎶",
  tink: "✨",
  hmm: "🤔",
};

const sampleNameCharacter = /[A-Za-z0-9_-]/;
const emojiSizeMultiplier = 1.3;
const samplePattern = new RegExp(
  Object.keys(emojiForSample)
    .sort((left, right) => right.length - left.length)
    .join("|"),
  "g"
);
const cyclePalette = ["#008000", "#6ED4E3", "#94A1FF", "#D4F357", "#FFA020"];

function selectionTouchesRange(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((selection) =>
    selection.empty
      ? selection.head >= from && selection.head < to
      : selection.from < to && selection.to > from
  );
}

export const sampleEmojiDecorations = EditorView.decorations.compute(
  [
    mininotationStringField,
    highlightSetField,
    heatmapSetField,
    heatmapNowField,
    hoveredMininotationField,
    "selection",
  ],
  (state) => {
    const decorations: Range<Decoration>[] = [];
    const hoveredMiniID = state.field(hoveredMininotationField);
    const highlights = state.field(highlightSetField);
    const heatmapHits = state.field(heatmapSetField);
    const now = state.field(heatmapNowField);
    let miniCursor = state.field(mininotationStringField).iter();

    while (miniCursor.value !== null) {
      const { from, to, value: mini } = miniCursor;
      const revealSource =
        hoveredMiniID === mini.id || selectionTouchesRange(state, from, to);

      if (!revealSource) {
        const text = state.doc.sliceString(from, to);

        for (const match of text.matchAll(samplePattern)) {
          if (match.index === undefined) continue;
          const sample = match[0];
          const relativeFrom = match.index;
          const before = text[relativeFrom - 1];
          const after = text[relativeFrom + sample.length];

          if (
            (before !== undefined && sampleNameCharacter.test(before)) ||
            (after !== undefined && sampleNameCharacter.test(after))
          ) {
            continue;
          }

          const emoji = emojiForSample[sample];
          const suffix = text
            .slice(relativeFrom + sample.length)
            .match(/^:-?\d+/)?.[0] ?? "";
          const relativeTo = relativeFrom + sample.length + suffix.length;
          const nameWidth = (sample.length / (sample.length + suffix.length)) * 100;
          const highlight = latestHighlightForSample(
            highlights,
            mini.id,
            relativeFrom,
            relativeTo,
            now
          );
          const motion =
            highlight !== null && !tidalReducedMotion.matches
              ? textReactionMotion(highlight, now, 0)
              : { transform: "none", textShadow: "none" };
          const activeClass =
            motion.transform === "none" ? "" : " cm-sample-emoji-active";
          const playingClass =
            highlight !== null && now - highlight.time <= highlight.duration
              ? " cm-sample-emoji-playing"
              : "";
          const heatmap = heatmapBackgroundForSample(
            heatmapHits,
            mini.id,
            relativeFrom,
            relativeTo,
            now
          );
          const decoration = Decoration.mark({
            class: `cm-sample-emoji-token${activeClass}${playingClass}`,
            attributes: {
              "data-sample-emoji": emoji,
              "data-sample-suffix": suffix,
              "data-mini-id": mini.id.toString(),
              title: sample,
              style: `transform: ${motion.transform}; --sample-emoji-shadow: ${motion.textShadow}; --sample-emoji-heatmap: ${heatmap}; --sample-emoji-size: ${(sample.length * emojiSizeMultiplier).toFixed(2)}ch; --sample-emoji-name-width: ${nameWidth.toFixed(3)}%`,
            },
          });
          decorations.push(
            decoration.range(
              from + relativeFrom,
              from + relativeTo
            )
          );
        }
      }

      miniCursor.next();
    }

    return Decoration.set(decorations, true);
  }
);

function latestHighlightForSample(
  highlights: readonly TimestampedHighlightEvent[],
  miniID: number,
  from: number,
  to: number,
  now: number
) {
  let latest: TimestampedHighlightEvent | null = null;

  for (const highlight of highlights) {
    if (
      highlight.miniID !== miniID ||
      highlight.time > now ||
      highlight.from >= to ||
      highlight.to <= from
    ) {
      continue;
    }

    if (
      latest === null ||
      highlight.time > latest.time ||
      (highlight.time === latest.time && highlight.surprise > latest.surprise)
    ) {
      latest = highlight;
    }
  }

  return latest;
}

function heatmapBackgroundForSample(
  hits: readonly HeatmapHit[],
  miniID: number,
  from: number,
  to: number,
  now: number
) {
  const traces = hits
    .filter(
      (hit) => hit.miniID === miniID && hit.from < to && hit.to > from
    )
    .flatMap((hit) => hit.traces)
    .sort((left, right) => left.phase - right.phase);
  if (traces.length === 0) return "transparent";

  const stripeWidth = 100 / traces.length;
  const stops = traces.flatMap((trace, index) => {
    const age = Math.max(0, now - trace.lastHit);
    const fade = Math.pow(0.5, age / heatmapHalfLifeMs);
    const sleepFade =
      trace.sleepAt === undefined
        ? 1
        : Math.min(1, Math.max(0, 1 - (now - trace.sleepAt) / 450));
    const density = Math.min(1, trace.activity / 4);
    const alpha = (0.2 + density * 0.6) * fade * sleepFade;
    const color = heatmapColor(trace.phase, alpha);
    const start = (index * stripeWidth).toFixed(2);
    const end = ((index + 1) * stripeWidth).toFixed(2);
    return [`${color} ${start}%`, `${color} ${end}%`];
  });

  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function heatmapColor(phase: number, alpha: number) {
  const index = Math.round(phase * cyclePalette.length) % cyclePalette.length;
  const hex = cyclePalette[index];
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return `rgb(${red} ${green} ${blue} / ${alpha.toFixed(3)})`;
}
