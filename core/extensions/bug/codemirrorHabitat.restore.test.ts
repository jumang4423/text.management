/**
 * @jest-environment jsdom
 */
import { EditorState, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { evaluationEffect } from "@management/cm-evaluate";

import { CodeMirrorHabitat, bugHabitatExtension } from "./codemirrorHabitat";
import type { EdibleCode } from "./types";

const docText = 'd1 $ s "bd" # room 0.8';

function setup(active: ReadonlySet<number> | null) {
  const seen: StateEffect<unknown>[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc: docText,
      extensions: [
        bugHabitatExtension,
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            seen.push(...transaction.effects);
          }
        }),
      ],
    }),
    parent: document.body,
  });
  const stage = document.createElement("div");
  const habitat = new CodeMirrorHabitat(
    view,
    stage,
    active === null ? {} : { getActiveOrbits: () => active }
  );
  return { view, habitat, seen };
}

function roomEdible(): EdibleCode {
  return {
    id: "e1",
    from: 12,
    to: 22,
    text: "# room 0.8",
    kind: "modifier",
    nutrition: 1,
    heat: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
  };
}

function evaluationSpans(seen: StateEffect<unknown>[]) {
  return seen
    .filter((effect) => effect.is(evaluationEffect))
    .map(
      (effect) =>
        (effect.value as { span?: { from: number; to: number } }).span
    );
}

describe("poop restore evaluation gate", () => {
  test("restore on a sounding block inserts and evaluates it", () => {
    const { view, habitat, seen } = setup(new Set([1]));
    const matter = habitat.eat(roomEdible());
    expect(matter).not.toBeNull();
    expect(view.state.doc.toString()).toBe('d1 $ s "bd" ');
    seen.length = 0;

    expect(habitat.restore(matter!)).toBe(true);

    expect(view.state.doc.toString()).toContain(matter!.mutatedText);
    const spans = evaluationSpans(seen);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe(0);
    expect(
      view.state.doc.sliceString(spans[0]!.from, spans[0]!.to)
    ).toContain('d1 $');
    view.destroy();
  });

  test("restore on a silent block inserts without evaluating", () => {
    const { view, habitat, seen } = setup(new Set([2]));
    const matter = habitat.eat(roomEdible());
    expect(matter).not.toBeNull();
    seen.length = 0;

    expect(habitat.restore(matter!)).toBe(true);

    expect(view.state.doc.toString()).toContain(matter!.mutatedText);
    expect(evaluationSpans(seen)).toHaveLength(0);
    view.destroy();
  });

  test("restore with unknown active state inserts without evaluating", () => {
    const { view, habitat, seen } = setup(null);
    const matter = habitat.eat(roomEdible());
    expect(matter).not.toBeNull();
    seen.length = 0;

    expect(habitat.restore(matter!)).toBe(true);

    expect(view.state.doc.toString()).toContain(matter!.mutatedText);
    expect(evaluationSpans(seen)).toHaveLength(0);
    view.destroy();
  });
});
