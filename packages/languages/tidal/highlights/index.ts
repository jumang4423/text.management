import {
  EditorState,
  StateEffect,
  Range,
  Extension,
  Prec,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";

import { dampedSpringImpulse, restingSpring } from "@core/animation/spring";

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
  highlightClearEffect,
  highlightSetField,
  heatmapAddEffect,
  heatmapHalfLifeMs,
  highlightReactionDurationMs,
  heatmapNowField,
  heatmapSetField,
  heatmapSleepEffect,
} from "./state";

export const tidalHushEventName = "text-management:tidal-hush";

export function evaluationWithHighlights(
  action: (evaluation: { code: string }) => void
): Extension {
  const handler = EditorState.transactionExtender.of((tr) => {
    // New effects to be added
    let effects = [];

    for (let effect of tr.effects) {
      if (effect.is(evaluationEffect)) {
        if (isStandaloneHush(effect.value.code)) {
          queueMicrotask(() => {
            document.dispatchEvent(new Event(tidalHushEventName));
          });
        }

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

function isStandaloneHush(code: string) {
  return /(^|\n)[ \t]*hush[ \t]*(?:--[^\n]*)?(?=\n|$)/m.test(code);
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
    const habits = new Map<string, Habit>();
    const lastHighlightSignatures = new Map<string, string>();

    let offTidalHighlight = api.onTidalHighlight((highlight) => {
      const time = fromNTPTime(highlight.onset);
      const sourceKey = `${highlight.miniID}:${highlight.from}:${highlight.to}`;
      const signature = `${highlight.cycle}:${time.toFixed(3)}`;
      if (lastHighlightSignatures.get(sourceKey) === signature) return;
      lastHighlightSignatures.set(sourceKey, signature);
      pendingHighlights.push({
        ...highlight,
        time,
        surprise: updateHabit(habits, highlight, time),
      });
    });

    const hush = () => {
      pendingHighlights = [];
      habits.clear();
      lastHighlightSignatures.clear();
      view.dispatch({
        effects: [
          highlightClearEffect.of(undefined),
          heatmapSleepEffect.of(performance.now()),
        ],
      });
    };
    document.addEventListener(tidalHushEventName, hush);

    const update = (time: number) => {
      const hasVisualWork =
        pendingHighlights.length > 0 ||
        view.state.field(highlightSetField).length > 0 ||
        view.state.field(heatmapSetField).length > 0;
      if (!hasVisualWork) {
        animationFrame = requestAnimationFrame(update);
        return;
      }

      let effects: StateEffect<any>[] = [];

      effects.push(highlightTickEffect.of(time));

      let toAdd: TimestampedHighlightEvent[] = [];
      let stillPending: TimestampedHighlightEvent[] = [];

      // Partition the pending events based on whether they're ready
      for (let event of pendingHighlights) {
        if (event.time > time) {
          stillPending.push(event);
        } else {
          if (
            event.time +
              Math.max(event.duration, highlightReactionDurationMs) >=
            time
          ) {
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
        document.removeEventListener(tidalHushEventName, hush);
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
    Prec.high(bracketBodyDecorations),
    Prec.highest(highlightDecorations),
  ];
}

interface Habit {
  lastCycle: number;
  lastTime: number;
  expectedGap?: number;
  confidence: number;
}

function updateHabit(
  habits: Map<string, Habit>,
  event: { miniID: number; from: number; to: number; cycle: number },
  time: number
) {
  const cycle = Number.isFinite(event.cycle) ? event.cycle : 0;
  const phase = ((cycle % 1) + 1) % 1;
  const phaseStep = Math.round(phase * 12) % 12;
  const key = `${event.miniID}:${event.from}:${event.to}:${phaseStep}`;
  const previous = habits.get(key);

  if (!previous) {
    habits.set(key, { lastCycle: cycle, lastTime: time, confidence: 0 });
    return 1;
  }

  const gap = cycle - previous.lastCycle;
  const wokeFromSilence = time - previous.lastTime > 2_500 || gap <= 0 || gap > 4;
  let confidence = previous.confidence;
  let expectedGap = previous.expectedGap;
  let surprise = 1;

  if (wokeFromSilence) {
    confidence = 0;
    expectedGap = undefined;
  } else if (expectedGap === undefined) {
    confidence = 0.25;
    expectedGap = gap;
    surprise = 0.75;
  } else {
    const deviation = Math.abs(gap - expectedGap) / Math.max(0.05, expectedGap);
    if (deviation <= 0.22) {
      confidence = Math.min(0.88, confidence + 0.16);
      expectedGap = expectedGap * 0.72 + gap * 0.28;
      surprise = Math.max(0.18, 1 - confidence);
    } else {
      confidence *= 0.2;
      expectedGap = gap;
    }
  }

  habits.set(key, {
    lastCycle: cycle,
    lastTime: time,
    expectedGap,
    confidence,
  });
  return surprise;
}

const activeHighlightStyle =
  "box-shadow: inset 0 -0.14em 0 var(--color-livecode-active-event-background); color: var(--color-foreground)";
const startleDurationMs = highlightReactionDurationMs;
const textSpring = { stiffness: 420, damping: 8.4 };
const characterStaggerMs = 7;
const tidalReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
);

function springDirection({
  miniID,
  from,
  to,
  cycle,
}: Pick<TimestampedHighlightEvent, "miniID" | "from" | "to" | "cycle">
) {
  // Seed the side from the musical event: it changes between hits, but never
  // flickers while the same spring is being redrawn every animation frame.
  let hash = Math.imul(miniID + 1, 73_856_093);
  hash ^= Math.imul(from + 1, 19_349_663);
  hash ^= Math.imul(to + 1, 83_492_791);
  hash ^= Math.imul(Math.round(cycle * 1_024) + 1, 1_597_334_677);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2_246_822_519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3_266_489_917);
  hash ^= hash >>> 16;
  return hash & 1 ? 1 : -1;
}

function reactionIntensity(surprise: number) {
  return Math.pow(Math.min(1, Math.max(0, surprise)), 1.1);
}

const highlightDecoration = Decoration.mark({
  attributes: {
    style: activeHighlightStyle,
  },
});

function decorationForHighlight(
  highlight: TimestampedHighlightEvent,
  now: number,
  characterIndex: number
) {
  const age = Math.max(0, now - highlight.time);
  if (age >= startleDurationMs) return highlightDecoration;

  const springAge = age - Math.min(12, characterIndex) * characterStaggerMs;
  const spring =
    springAge < 0
      ? restingSpring
      : dampedSpringImpulse(springAge, textSpring);
  const intensity = reactionIntensity(highlight.surprise);
  const direction = springDirection(highlight);
  const displacement = spring.displacement * intensity;
  const speed = Math.min(1.2, Math.abs(spring.velocity)) * intensity;
  const horizontal = displacement * direction * 4.2;
  const verticalTravel =
    displacement >= 0 ? displacement * 9 : displacement * 3.8;
  const vertical = -verticalTravel + speed * 1.8;
  const rotation = displacement * direction * 4;
  const scaleX = 1 + speed * 0.24 - displacement * 0.06;
  const scaleY = 1 - speed * 0.32 + displacement * 0.11;
  const shadow = spring.energy * intensity * 2.4;
  const eventStyle =
    age <= highlight.duration
      ? activeHighlightStyle
      : "color: var(--color-foreground)";
  return Decoration.mark({
    attributes: {
      class: "cm-livecode-active-event",
      style: `${eventStyle}; transform: translate(${horizontal.toFixed(3)}px, ${vertical.toFixed(3)}px) rotate(${rotation.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}); text-shadow: ${(-direction * shadow).toFixed(3)}px 0 GREEN, ${(direction * shadow).toFixed(3)}px 0 #D4F357`,
    },
  });
}

const highlightDecorations = EditorView.decorations.compute(
  [mininotationStringField, highlightSetField, heatmapNowField],
  (state) => {
    const characterMarks = new Map<
      string,
      {
        from: number;
        to: number;
        decoration: Decoration;
        event: TimestampedHighlightEvent;
      }
    >();

    const addCharacterMark = (
      from: number,
      to: number,
      decoration: Decoration,
      event: TimestampedHighlightEvent
    ) => {
      const key = `${from}:${to}`;
      const previous = characterMarks.get(key);
      if (
        !previous ||
        event.time > previous.event.time ||
        (event.time === previous.event.time &&
          event.surprise > previous.event.surprise)
      ) {
        characterMarks.set(key, { from, to, decoration, event });
      }
    };

    const mininotationRanges = state.field(mininotationStringField);
    const currentHighlights = state.field(highlightSetField);
    const now = state.field(heatmapNowField);

    let mininotationCursor = mininotationRanges.iter();

    while (mininotationCursor.value !== null) {
      let { from, value: miniString } = mininotationCursor;

      const highlightsInMini = currentHighlights
        .filter(({ miniID }) => miniID === miniString.id)
        .sort((a, b) => a.from - b.from || a.to - b.to);

      for (const highlight of highlightsInMini) {
        const absoluteFrom = highlight.from + from;
        const absoluteTo = highlight.to + from;
        const age = Math.max(0, now - highlight.time);

        const text = state.doc.sliceString(absoluteFrom, absoluteTo);
        let offset = 0;
        let characterIndex = 0;
        for (const character of text) {
          const characterLength = character.length;
          const characterFrom = absoluteFrom + offset;
          const characterTo = characterFrom + characterLength;
          const isActive = age <= highlight.duration;
          const canMove =
            !tidalReducedMotion.matches &&
            age < startleDurationMs &&
            !/\s/.test(character);

          if (canMove) {
            addCharacterMark(
              characterFrom,
              characterTo,
              decorationForHighlight(highlight, now, characterIndex),
              highlight
            );
          } else if (isActive) {
            addCharacterMark(
              characterFrom,
              characterTo,
              highlightDecoration,
              highlight
            );
          }
          offset += characterLength;
          characterIndex += 1;
        }
      }

      mininotationCursor.next();
    }
    return Decoration.set(
      [...characterMarks.values()].map(({ from, to, decoration }) =>
        decoration.range(from, to)
      ),
      true
    );
  }
);

interface BracketPair {
  open: number;
  close: number;
  kind: "square" | "angle";
}

interface BracketBodyMark {
  from: number;
  kind: BracketPair["kind"];
  side: "open" | "close";
  age: number;
  surprise: number;
}

const bracketBodyDurationMs = highlightReactionDurationMs;
const bracketPropagationDelayMs = 24;
const bracketSpring = { stiffness: 320, damping: 7.4 };

const bracketBodyDecorations = EditorView.decorations.compute(
  [mininotationStringField, highlightSetField, heatmapNowField],
  (state) => {
    const decorations: Range<Decoration>[] = [];
    if (tidalReducedMotion.matches) return Decoration.set(decorations, true);

    const marks = new Map<string, BracketBodyMark>();
    const mininotationRanges = state.field(mininotationStringField);
    const currentHighlights = state.field(highlightSetField);
    const now = state.field(heatmapNowField);
    let mininotationCursor = mininotationRanges.iter();

    while (mininotationCursor.value !== null) {
      const {
        from,
        to,
        value: miniString,
      } = mininotationCursor;
      const pairs = findBracketPairs(state.doc.sliceString(from, to));

      for (const highlight of currentHighlights.filter(
        ({ miniID }) => miniID === miniString.id
      )) {
        const age = Math.max(0, now - highlight.time);
        if (age >= bracketBodyDurationMs) continue;

        const enclosing = pairs
          .filter(
            (pair) =>
              pair.open < highlight.from && pair.close >= highlight.to
          )
          .sort(
            (left, right) =>
              left.close - left.open - (right.close - right.open)
          )
          .slice(0, 2);

        enclosing.forEach((pair, depth) => {
          const surprise = highlight.surprise / (depth + 1);
          for (const [side, position] of [
            ["open", pair.open],
            ["close", pair.close],
          ] as const) {
            const absolute = from + position;
            const key = `${absolute}:${pair.kind}:${side}`;
            const previous = marks.get(key);
            if (
              !previous ||
              previous.surprise < surprise ||
              (previous.surprise === surprise && previous.age > age)
            ) {
              marks.set(key, {
                from: absolute,
                kind: pair.kind,
                side,
                age,
                surprise,
              });
            }
          }
        });
      }

      mininotationCursor.next();
    }

    for (const mark of marks.values()) {
      const direction = mark.side === "open" ? -1 : 1;
      const springAge = mark.age - bracketPropagationDelayMs;
      const spring =
        springAge < 0
          ? restingSpring
          : dampedSpringImpulse(springAge, bracketSpring);
      const intensity = reactionIntensity(mark.surprise);
      const displacement = spring.displacement * intensity * direction;
      const speed = Math.min(1.2, Math.abs(spring.velocity)) * intensity;
      const horizontal = displacement * 7;
      const rotation = displacement * 3.3;
      const scaleX = 1 - speed * 0.14;
      const scaleY = 1 + speed * 0.36;
      const shadow = spring.energy * intensity * 2;
      const decoration = Decoration.mark({
        attributes: {
          class: `cm-livecode-bracket cm-livecode-bracket-${mark.kind}`,
          style: `transform: translateX(${horizontal.toFixed(3)}px) rotate(${rotation.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}); text-shadow: ${(-direction * shadow).toFixed(3)}px 0 GREEN, ${(direction * shadow).toFixed(3)}px 0 #D4F357`,
        },
      });
      decorations.push(decoration.range(mark.from, mark.from + 1));
    }

    return Decoration.set(decorations, true);
  }
);

function findBracketPairs(text: string): BracketPair[] {
  const stack: { position: number; char: "[" | "<" }[] = [];
  const pairs: BracketPair[] = [];

  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    if (char === "[" || char === "<") {
      stack.push({ position, char });
      continue;
    }

    if (char !== "]" && char !== ">") continue;
    const opener = char === "]" ? "[" : "<";
    let openIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].char === opener) {
        openIndex = index;
        break;
      }
    }
    if (openIndex === -1) continue;
    const [open] = stack.splice(openIndex, 1);
    pairs.push({
      open: open.position,
      close: position,
      kind: opener === "[" ? "square" : "angle",
    });
  }

  return pairs;
}

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
          const sleepFade =
            trace.sleepAt === undefined
              ? 1
              : Math.min(1, Math.max(0, 1 - (now - trace.sleepAt) / 450));
          const density = Math.min(1, trace.activity / 4);
          const alpha = (0.2 + density * 0.6) * fade * sleepFade;
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
