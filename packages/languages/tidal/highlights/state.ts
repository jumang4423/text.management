import {
  Range,
  RangeValue,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";

import { HighlightEvent } from "../ghci";

export class MininotationString extends RangeValue {
  private static nextID = 0;

  private _id: number;

  get id() {
    return this._id;
  }

  constructor() {
    super();

    // Equivalent to non-inclusive decorations
    this.startSide = 5e8;
    this.endSide = -6e8;

    this._id = MininotationString.nextID;
    MininotationString.nextID += 1;
  }
}

export const replaceMininotationEffect = StateEffect.define<{
  from: number;
  to: number;
  mininotationStrings: Range<MininotationString>[];
}>();

export const mininotationStringField = StateField.define<
  RangeSet<MininotationString>
>({
  create: () => RangeSet.empty,
  update: (minis, tr) => {
    if (tr.docChanged) {
      tr.changes.iterChangedRanges((filterFrom, filterTo) => {
        minis = minis.update({
          filterFrom,
          filterTo,
          filter: (miniFrom, miniTo) =>
            filterTo <= miniFrom || miniTo <= filterFrom,
        });
      });
      minis = minis.map(tr.changes);
    }

    for (let effect of tr.effects) {
      if (effect.is(replaceMininotationEffect)) {
        let { from, to, mininotationStrings } = effect.value;

        minis = minis.update({
          filterFrom: from,
          filterTo: to,
          filter: () => false,
          add: mininotationStrings,
        });
      }
    }

    return minis;
  },
});

export type TimestampedHighlightEvent = HighlightEvent & { time: number };

export const highlightTickEffect = StateEffect.define<number>();

export const highlightAddEffect =
  StateEffect.define<TimestampedHighlightEvent[]>();

export interface HeatmapTrace {
  phase: number;
  lastHit: number;
  lastCycle: number;
  activity: number;
}

export interface HeatmapHit {
  miniID: number;
  from: number;
  to: number;
  traces: HeatmapTrace[];
}

export const heatmapHalfLifeMs = 1_000;
export const heatmapDecayMs = 5_000;
const heatmapPhaseSteps = 12;
const heatmapActivityHalfLifeCycles = 2;

export const heatmapAddEffect =
  StateEffect.define<TimestampedHighlightEvent[]>();

export const heatmapSetField = StateField.define<HeatmapHit[]>({
  create: () => [],
  update: (value, tr) => {
    for (let effect of tr.effects) {
      if (effect.is(highlightTickEffect)) {
        value = value
          .map((hit) => ({
            ...hit,
            traces: hit.traces.filter(
              (trace) => effect.value - trace.lastHit < heatmapDecayMs
            ),
          }))
          .filter((hit) => hit.traces.length > 0);
        continue;
      }

      if (!effect.is(heatmapAddEffect)) continue;

      const hits = new Map(
        value.map(
          (hit): [string, HeatmapHit] => [
            `${hit.miniID}:${hit.from}:${hit.to}`,
            hit,
          ]
        )
      );

      for (const event of effect.value) {
        const key = `${event.miniID}:${event.from}:${event.to}`;
        const previous = hits.get(key);
        const rawCycle = Number.isFinite(event.cycle) ? event.cycle : 0;
        const phase = ((rawCycle % 1) + 1) % 1;
        const phaseStep =
          Math.round(phase * heatmapPhaseSteps) % heatmapPhaseSteps;
        const snappedPhase = phaseStep / heatmapPhaseSteps;
        const traces = [...(previous?.traces ?? [])];
        const traceIndex = traces.findIndex(
          (trace) => trace.phase === snappedPhase
        );
        const previousTrace = traces[traceIndex];
        const elapsedCycles = previousTrace
          ? Math.max(0, rawCycle - previousTrace.lastCycle)
          : 0;
        const decayedActivity = previousTrace
          ? previousTrace.activity *
            Math.pow(0.5, elapsedCycles / heatmapActivityHalfLifeCycles)
          : 0;
        const trace: HeatmapTrace = {
          phase: snappedPhase,
          lastHit: event.time,
          lastCycle: rawCycle,
          activity: Math.min(8, decayedActivity + 1),
        };

        if (traceIndex === -1) traces.push(trace);
        else traces[traceIndex] = trace;

        hits.set(key, {
          miniID: event.miniID,
          from: event.from,
          to: event.to,
          traces,
        });
      }

      value = [...hits.values()];
    }

    return value;
  },
});

export const heatmapNowField = StateField.define<number>({
  create: () => 0,
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(highlightTickEffect)) value = effect.value;
    }
    return value;
  },
});

export const highlightSetField = StateField.define({
  create: () => [],
  update: (value: TimestampedHighlightEvent[], tr) => {
    for (let effect of tr.effects) {
      if (effect.is(highlightTickEffect)) {
        const remaining = value.filter((event) => {
          return event.time + event.duration >= effect.value;
        });
        if (remaining.length !== value.length) value = remaining;
      } else if (effect.is(highlightAddEffect)) {
        value = value.concat(effect.value);
      }
    }

    return value;
  },
});
