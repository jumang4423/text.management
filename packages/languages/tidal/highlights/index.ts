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
  hoveredMininotationEffect,
  hoveredMininotationField,
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
import { sampleEmojiDecorations } from "./sample-emojis";
import {
  reactionIntensity,
  springDirection,
  textReactionMotion,
  tidalReducedMotion,
} from "./reaction";

export const tidalHushEventName = "text-management:tidal-hush";
const highlightVisualLeadMs = 20;

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
      const time = fromNTPTime(highlight.onset) - highlightVisualLeadMs;
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

    let hoveredMiniID: number | null = null;
    let hoveredEmojiHit: EmojiHit | null = null;
    const setHoveredMini = (miniID: number | null) => {
      if (hoveredMiniID === miniID) return;
      hoveredMiniID = miniID;
      view.dispatch({ effects: hoveredMininotationEffect.of(miniID) });
    };
    const pointerMove = (event: PointerEvent) => {
      if (
        hoveredEmojiHit !== null &&
        pointInsideEmojiHit(event.clientX, event.clientY, hoveredEmojiHit)
      ) {
        setHoveredMini(hoveredEmojiHit.miniID);
        return;
      }
      hoveredEmojiHit = emojiHitAtPoint(
        view,
        event.clientX,
        event.clientY
      );
      if (hoveredEmojiHit !== null) {
        setHoveredMini(hoveredEmojiHit.miniID);
        return;
      }

      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".cm-line")) {
        setHoveredMini(null);
        return;
      }

      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      setHoveredMini(
        position === null ? null : mininotationAtPosition(view.state, position)
      );
    };
    const pointerLeave = () => {
      hoveredEmojiHit = null;
      setHoveredMini(null);
    };
    view.dom.addEventListener("pointermove", pointerMove);
    view.dom.addEventListener("pointerleave", pointerLeave);

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
        view.dom.removeEventListener("pointermove", pointerMove);
        view.dom.removeEventListener("pointerleave", pointerLeave);
        cancelAnimationFrame(animationFrame);
      },
    };
  });

  return [
    highlighterPlugin,
    highlightSetField,
    heatmapSetField,
    heatmapNowField,
    hoveredMininotationField,
    Prec.lowest(heatmapDecorations),
    Prec.high(bracketBodyDecorations),
    Prec.highest(highlightDecorations),
    Prec.lowest(sampleEmojiDecorations),
  ];
}

interface EmojiHit {
  miniID: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function emojiHitAtPoint(
  view: EditorView,
  x: number,
  y: number
): EmojiHit | null {
  const tokens = view.dom.querySelectorAll<HTMLElement>(
    ".cm-sample-emoji-token"
  );

  for (const token of tokens) {
    const miniID = Number(token.dataset.miniId);
    if (!Number.isFinite(miniID)) continue;

    const tokenRect = token.getBoundingClientRect();
    const emojiStyle = getComputedStyle(token, "::before");
    const emojiSize = Number.parseFloat(emojiStyle.fontSize);
    const nameWidth = Number.parseFloat(emojiStyle.width);
    if (!Number.isFinite(emojiSize) || !Number.isFinite(nameWidth)) continue;

    const centerX = tokenRect.left + nameWidth / 2;
    const centerY = tokenRect.top + tokenRect.height / 2;
    const padding = emojiSize * 0.08;
    const hit: EmojiHit = {
      miniID,
      left: centerX - emojiSize / 2 - padding,
      right: centerX + emojiSize / 2 + padding,
      top: centerY - emojiSize / 2 - padding,
      bottom: centerY + emojiSize / 2 + padding,
    };
    if (pointInsideEmojiHit(x, y, hit)) return hit;
  }

  return null;
}

function pointInsideEmojiHit(x: number, y: number, hit: EmojiHit) {
  return x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom;
}

function mininotationAtPosition(state: EditorState, position: number) {
  let miniID: number | null = null;
  state.field(mininotationStringField).between(
    Math.max(0, position - 1),
    Math.min(state.doc.length, position + 1),
    (from, to, mini) => {
      if (from <= position && position < to) miniID = mini.id;
    }
  );
  return miniID;
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
  "box-shadow: inset 0 -0.14em 0 var(--color-livecode-active-event-background)";
const startleDurationMs = highlightReactionDurationMs;

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

  const { transform, textShadow } = textReactionMotion(
    highlight,
    now,
    characterIndex
  );
  const eventStyle =
    age <= highlight.duration
      ? activeHighlightStyle
      : "";
  return Decoration.mark({
    attributes: {
      class: "cm-livecode-active-event",
      style: `${eventStyle}; transform: ${transform}; text-shadow: ${textShadow}`,
    },
  });
}

const highlightDecorations = EditorView.decorations.compute(
  [
    mininotationStringField,
    highlightSetField,
    heatmapNowField,
    hoveredMininotationField,
    "selection",
  ],
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
      let { from, to, value: miniString } = mininotationCursor;
      const animationPaused = mininotationAnimationPaused(
        state,
        from,
        to,
        miniString.id
      );

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
            !animationPaused &&
            age < startleDurationMs &&
            !/\s/.test(character) &&
            !/[~.\[\],*\/|!_@?:%<>(){}]/.test(character);

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
  kind: "square" | "angle" | "paren" | "curly";
}

type MiniSyntaxKind =
  | `${BracketPair["kind"]}-open`
  | `${BracketPair["kind"]}-close`
  | "rest"
  | "group"
  | "slow"
  | "choice"
  | "replicate"
  | "elongate-step"
  | "elongate-count"
  | "degrade"
  | "ratio";

interface MiniSyntaxMark {
  from: number;
  kind: MiniSyntaxKind;
  age: number;
  surprise: number;
  direction: number;
  delay: number;
}

const miniSyntaxDurationMs = 320;
const bracketPropagationDelayMs = 7;
const miniSyntaxAmplitude = 0.3;

const miniSyntaxSprings: Record<
  "tight" | "wide" | "heavy" | "wild",
  { stiffness: number; damping: number }
> = {
  tight: { stiffness: 1600, damping: 26 },
  wide: { stiffness: 1100, damping: 22 },
  heavy: { stiffness: 850, damping: 25 },
  wild: { stiffness: 2000, damping: 28 },
};

const miniSymbolKinds: Record<string, MiniSyntaxKind> = {
  "~": "rest",
  ".": "group",
  "/": "slow",
  "|": "choice",
  "!": "replicate",
  _: "elongate-step",
  "@": "elongate-count",
  "?": "degrade",
  "%": "ratio",
};

const miniSyntaxColor: Record<MiniSyntaxKind, string> = {
  "square-open": "GREEN",
  "square-close": "GREEN",
  "angle-open": "#D4F357",
  "angle-close": "#D4F357",
  "paren-open": "#FFA020",
  "paren-close": "#FFA020",
  "curly-open": "#6ED4E3",
  "curly-close": "#6ED4E3",
  rest: "#BEC5BD",
  group: "#94A1FF",
  slow: "#94A1FF",
  choice: "GREEN",
  replicate: "#D4F357",
  "elongate-step": "#6ED4E3",
  "elongate-count": "#6ED4E3",
  degrade: "#FFA020",
  ratio: "#94A1FF",
};

const bracketBodyDecorations = EditorView.decorations.compute(
  [
    mininotationStringField,
    highlightSetField,
    heatmapNowField,
    hoveredMininotationField,
    "selection",
  ],
  (state) => {
    const decorations: Range<Decoration>[] = [];
    if (tidalReducedMotion.matches) return Decoration.set(decorations, true);

    const marks = new Map<string, MiniSyntaxMark>();
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
      if (mininotationAnimationPaused(state, from, to, miniString.id)) {
        mininotationCursor.next();
        continue;
      }
      const miniText = state.doc.sliceString(from, to);
      const pairs = findBracketPairs(miniText);
      const symbols = findMiniSymbols(miniText);

      for (const highlight of currentHighlights.filter(
        ({ miniID }) => miniID === miniString.id
      )) {
        const age = Math.max(0, now - highlight.time);
        if (age >= miniSyntaxDurationMs) continue;

        const relevantPairs = pairs
          .filter(
            (pair) =>
              (pair.open < highlight.from && pair.close >= highlight.to) ||
              (pair.kind === "paren" &&
                pair.open >= highlight.to &&
                pair.open - highlight.to <= 1)
          )
          .sort(
            (left, right) =>
              left.close - left.open - (right.close - right.open)
          )
          .slice(0, 4);

        relevantPairs.forEach((pair, depth) => {
          const surprise = Math.max(0.45, highlight.surprise / (depth + 1));
          for (const [side, position] of [
            ["open", pair.open],
            ["close", pair.close],
          ] as const) {
            const absolute = from + position;
            const kind = `${pair.kind}-${side}` as MiniSyntaxKind;
            const key = `${absolute}:${kind}`;
            const previous = marks.get(key);
            if (
              !previous ||
              previous.surprise < surprise ||
              (previous.surprise === surprise && previous.age > age)
            ) {
              marks.set(key, {
                from: absolute,
                kind,
                age,
                surprise,
                direction: side === "open" ? -1 : 1,
                delay: bracketPropagationDelayMs + depth * 5,
              });
            }
          }
        });

        const eventCenter = (highlight.from + highlight.to) / 2;
        for (const symbol of symbols) {
          const absolute = from + symbol.position;
          const key = `${absolute}:${symbol.kind}`;
          const previous = marks.get(key);
          const distance = Math.abs(symbol.position - eventCenter);
          const delay = Math.min(24, distance * 1.5);
          const surprise = Math.max(0.55, highlight.surprise);

          if (
            !previous ||
            previous.surprise < surprise ||
            (previous.surprise === surprise && previous.age > age)
          ) {
            marks.set(key, {
              from: absolute,
              kind: symbol.kind,
              age,
              surprise,
              direction: springDirection(highlight),
              delay,
            });
          }
        }
      }

      mininotationCursor.next();
    }

    for (const mark of marks.values()) {
      const springAge = mark.age - mark.delay;
      const springOptions = springOptionsForMiniSyntax(mark.kind);
      const spring =
        springAge < 0
          ? restingSpring
          : dampedSpringImpulse(springAge, springOptions);
      const intensity = 0.65 + reactionIntensity(mark.surprise) * 0.85;
      const displacement = spring.displacement * intensity;
      const speed = Math.min(1.35, Math.abs(spring.velocity)) * intensity;
      const { transform, shadow } = miniSyntaxMotion(
        mark.kind,
        displacement * miniSyntaxAmplitude,
        speed * miniSyntaxAmplitude,
        spring.energy * intensity * miniSyntaxAmplitude,
        mark.direction
      );
      const color = miniSyntaxColor[mark.kind];
      const decoration = Decoration.mark({
        attributes: {
          class: `cm-livecode-mini-symbol cm-livecode-mini-${mark.kind}`,
          style: `transform: ${transform}; text-shadow: ${(-mark.direction * shadow).toFixed(3)}px 0 ${color}, ${(mark.direction * shadow * 0.55).toFixed(3)}px 0 GREEN`,
        },
      });
      decorations.push(decoration.range(mark.from, mark.from + 1));
    }

    return Decoration.set(decorations, true);
  }
);

function cursorInsideRange(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(
    ({ head }) => head >= from && head < to
  );
}

function mininotationAnimationPaused(
  state: EditorState,
  from: number,
  to: number,
  miniID: number
) {
  return (
    cursorInsideRange(state, from, to) ||
    state.field(hoveredMininotationField) === miniID
  );
}

function springOptionsForMiniSyntax(kind: MiniSyntaxKind) {
  if (kind === "degrade" || kind === "choice") {
    return miniSyntaxSprings.wild;
  }
  if (
    kind === "slow" ||
    kind === "elongate-step" ||
    kind === "elongate-count" ||
    kind.startsWith("angle-")
  ) {
    return miniSyntaxSprings.wide;
  }
  if (kind === "rest" || kind.startsWith("curly-")) {
    return miniSyntaxSprings.heavy;
  }
  return miniSyntaxSprings.tight;
}

function miniSyntaxMotion(
  kind: MiniSyntaxKind,
  displacement: number,
  speed: number,
  energy: number,
  direction: number
) {
  const signed = displacement * direction;
  const absolute = Math.abs(displacement);
  const format = (value: number) => value.toFixed(3);
  const scale = (value: number) => Math.max(0.18, value).toFixed(4);
  let transform = "none";

  switch (kind) {
    case "rest":
      transform = `translateY(${format(absolute * 12 + speed * 2)}px) rotate(${format(signed * 8)}deg) scale(${scale(1 + speed * 0.5)}, ${scale(1 - speed * 0.48)})`;
      break;
    case "group":
      transform = `translateY(${format(-absolute * 15)}px) rotate(${format(signed * 95)}deg) scale(${scale(1 + speed * 0.85)})`;
      break;
    case "slow":
      transform = `translateX(${format(signed * 13)}px) rotate(${format(-signed * 22)}deg) scale(${scale(1 + absolute * 1.25)}, ${scale(1 - speed * 0.24)})`;
      break;
    case "choice":
      transform = `translateX(${format(signed * 14)}px) rotate(${format(signed * 125)}deg) scale(${scale(1 + speed * 0.9)}, ${scale(1 - speed * 0.32)})`;
      break;
    case "replicate":
      transform = `translate(${format(signed * 11)}px, ${format(-absolute * 7)}px) rotate(${format(signed * 35)}deg) scale(${scale(1 + speed * 1.1)})`;
      break;
    case "elongate-step":
      transform = `translateX(${format(signed * 11)}px) scale(${scale(1 + absolute * 2.2)}, ${scale(1 - speed * 0.28)})`;
      break;
    case "elongate-count":
      transform = `translateX(${format(signed * 12)}px) rotate(${format(signed * 75)}deg) scale(${scale(1 + absolute * 1.55)}, ${scale(1 + speed * 0.45)})`;
      break;
    case "degrade":
      transform = `translate(${format(signed * 8)}px, ${format(-absolute * 13)}px) rotate(${format(signed * 330)}deg) scale(${scale(1 + speed * 0.9)}, ${scale(1 - speed * 0.35)})`;
      break;
    case "ratio":
      transform = `translateY(${format(-absolute * 8)}px) rotate(${format(signed * 120)}deg) scale(${scale(1 - speed * 0.35)}, ${scale(1 + speed * 1.2)})`;
      break;
    case "angle-open":
    case "angle-close":
      transform = `translateX(${format(signed * 12)}px) translateY(${format(-absolute * 4)}px) rotate(${format(signed * 10)}deg) scale(${scale(1 + speed * 0.4)}, ${scale(1 + speed * 0.62)})`;
      break;
    case "paren-open":
    case "paren-close":
      transform = `translate(${format(signed * 7)}px, ${format(-absolute * 6)}px) rotate(${format(signed * 70)}deg) scale(${scale(1 + speed * 0.3)}, ${scale(1 + speed * 0.55)})`;
      break;
    case "curly-open":
    case "curly-close":
      transform = `translate(${format(signed * 9)}px, ${format(displacement * 6)}px) rotate(${format(signed * 40)}deg) scale(${scale(1 + speed * 0.45)}, ${scale(1 - speed * 0.18)})`;
      break;
    case "square-open":
    case "square-close":
      transform = `translateX(${format(signed * 7)}px) rotate(${format(signed * 16)}deg) scale(${scale(1 - speed * 0.1)}, ${scale(1 + speed * 0.38)})`;
      break;
  }

  return { transform, shadow: energy * (kind === "replicate" ? 8 : 4.2) };
}

function findMiniSymbols(text: string) {
  const symbols: { position: number; kind: MiniSyntaxKind }[] = [];

  for (let position = 1; position < text.length - 1; position += 1) {
    const char = text[position];
    const kind = miniSymbolKinds[char];
    if (!kind || text[position - 1] === "\\") continue;

    // A decimal point is a value, while a standalone dot is group shorthand.
    if (
      char === "." &&
      (/\d/.test(text[position - 1] ?? "") ||
        /\d/.test(text[position + 1] ?? ""))
    ) {
      continue;
    }

    symbols.push({ position, kind });
  }

  return symbols;
}

function findBracketPairs(text: string): BracketPair[] {
  const openers = {
    "[": { close: "]", kind: "square" },
    "<": { close: ">", kind: "angle" },
    "(": { close: ")", kind: "paren" },
    "{": { close: "}", kind: "curly" },
  } as const;
  type Opener = keyof typeof openers;
  const stack: { position: number; char: Opener }[] = [];
  const pairs: BracketPair[] = [];

  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    if (char in openers) {
      stack.push({ position, char: char as Opener });
      continue;
    }

    const opener = (Object.entries(openers) as [Opener, (typeof openers)[Opener]][]).find(
      ([, value]) => value.close === char
    )?.[0];
    if (!opener) continue;
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
      kind: openers[opener].kind,
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
