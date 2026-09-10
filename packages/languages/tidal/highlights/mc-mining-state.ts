import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";

import {
  highlightAddEffect,
  highlightClearEffect,
  mininotationStringField,
  replaceMininotationEffect,
} from "./state";
import type { TimestampedHighlightEvent } from "./state";

export interface McMiningState {
  hits: number;
  hitAt: number;
  breakAt: number;
}

export function mcMiningKey(miniID: number, from: number, to: number) {
  return `${miniID}:${from}:${to}`;
}

interface McTokenRange {
  from: number;
  to: number;
  key: string;
}

type McTokenIndex = ReadonlyMap<number, readonly McTokenRange[]>;

// Keep the range cache in the immutable field value, rather than in a mutable
// module cache. Unrelated edits can move a mini string without resetting its
// damage: keys and ranges are relative to its persistent mini ID.
class McMiningMap extends Map<string, McMiningState> {
  constructor(
    readonly tokenIndex: McTokenIndex,
    entries?: Iterable<readonly [string, McMiningState]>
  ) {
    super(entries);
  }
}

const sampleNameCharacter = /[A-Za-z0-9_-]/;
const onsetToleranceMs = 0.001;

function tokenIndexFor(
  state: EditorState,
  previous: McTokenIndex = new Map()
): McTokenIndex {
  const next = new Map<number, readonly McTokenRange[]>();
  const cursor = state.field(mininotationStringField).iter();

  while (cursor.value !== null) {
    const miniID = cursor.value.id;
    const cached = previous.get(miniID);

    if (cached !== undefined) {
      next.set(miniID, cached);
    } else {
      const text = state.doc.sliceString(cursor.from, cursor.to);
      const tokens: McTokenRange[] = [];

      for (const match of text.matchAll(/mc/gi)) {
        if (match.index === undefined) continue;
        const from = match.index;
        const nameEnd = from + match[0].length;
        const before = text[from - 1];
        const after = text[nameEnd];

        // Match the sample-image decorations' bank-name and numeric suffix
        // rules, including negative indices, without matching e.g. "mcp".
        if (
          (before !== undefined && sampleNameCharacter.test(before)) ||
          (after !== undefined && sampleNameCharacter.test(after))
        ) {
          continue;
        }

        const suffix = text.slice(nameEnd).match(/^:-?\d+/)?.[0] ?? "";
        const to = nameEnd + suffix.length;
        tokens.push({ from, to, key: mcMiningKey(miniID, from, to) });
      }

      // Cache even an empty result, so non-mc mini strings are not re-scanned.
      next.set(miniID, tokens);
    }

    cursor.next();
  }

  if (
    next.size === previous.size &&
    [...next].every(([miniID, tokens]) => previous.get(miniID) === tokens)
  ) {
    return previous;
  }

  return next;
}

export const mcMiningField = StateField.define<Map<string, McMiningState>>({
  create: (state) => new McMiningMap(tokenIndexFor(state)),
  update: (value, tr) => {
    const previous = value as McMiningMap;
    const minisChanged =
      tr.docChanged ||
      tr.effects.some((effect) => effect.is(replaceMininotationEffect));
    const tokenIndex = minisChanged
      ? tokenIndexFor(tr.state)
      : previous.tokenIndex;
    let result = value;

    const set = (key: string, mining: McMiningState) => {
      if (result === value) result = new Map(value);
      result.set(key, mining);
    };

    if (tokenIndex !== previous.tokenIndex) {
      const validKeys = new Set(
        [...tokenIndex.values()].flatMap((tokens) =>
          tokens.map((token) => token.key)
        )
      );

      for (const key of result.keys()) {
        if (validKeys.has(key)) continue;
        if (result === value) result = new Map(value);
        result.delete(key);
      }
    }

    const events: TimestampedHighlightEvent[] = [];

    for (const effect of tr.effects) {
      if (effect.is(highlightClearEffect)) {
        if (result.size > 0) result = new Map();
        events.length = 0;
      } else if (effect.is(highlightAddEffect)) {
        events.push(...effect.value);
      }
    }

    // Process every onset in a frame, including rapid repeats that the general
    // highlighter intentionally collapses down to its latest source event.
    events.sort((left, right) => left.time - right.time);

    for (const event of events) {
      if (!Number.isFinite(event.time)) continue;
      const tokens = tokenIndex.get(event.miniID);
      if (tokens === undefined) continue;

      for (const token of tokens) {
        if (event.from >= token.to || event.to <= token.from) continue;
        const mining = result.get(token.key);

        // Multiple Tidal contexts (or simultaneous voices) can overlap one
        // image at the same onset. Count it once, even across transactions.
        // Older, late-arriving contexts must not rewind the visual state.
        if (
          mining !== undefined &&
          event.time <= mining.hitAt + onsetToleranceMs
        ) {
          continue;
        }

        const broken = (mining?.hits ?? 0) + 1 >= 3;
        set(token.key, {
          hits: broken ? 0 : (mining?.hits ?? 0) + 1,
          hitAt: event.time,
          // A new hit immediately brings back a block that was collapsing.
          breakAt: broken ? event.time : -Infinity,
        });
      }
    }

    return result === value && tokenIndex === previous.tokenIndex
      ? value
      : new McMiningMap(tokenIndex, result);
  },
});
