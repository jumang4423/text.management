/**
 * @jest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CodeMirrorHabitat, bugHabitatExtension } from "./codemirrorHabitat";

describe("food rect fallback", () => {
  test("estimates a rect when fragments are missing", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'd1 $ s "bd" # room 0.8',
        extensions: [bugHabitatExtension],
      }),
      parent: document.body,
    });
    // jsdom has no layout: fragments are always missing. Stub the caret
    // lookup to prove the fallback path produces a sane rect instead of
    // dropping the food.
    view.coordsAtPos = () => ({ left: 10, top: 20, right: 30, bottom: 36 });
    const stage = document.createElement("div");
    const habitat = new CodeMirrorHabitat(view, stage);
    const snapshot = habitat.snapshot(performance.now());
    const room = snapshot.edibles.find((food) => food.text === "# room 0.8");
    expect(room).toBeDefined();
    expect(room!.rect.x).toBe(10);
    expect(room!.rect.y).toBe(20);
    expect(room!.rect.width).toBeGreaterThan(0);
    expect(room!.rect.height).toBe(16);
    view.destroy();
  });

  test("still skips food with no caret to anchor on", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'd1 $ s "bd" # room 0.8',
        extensions: [bugHabitatExtension],
      }),
      parent: document.body,
    });
    view.coordsAtPos = () => null;
    const stage = document.createElement("div");
    const habitat = new CodeMirrorHabitat(view, stage);
    const snapshot = habitat.snapshot(performance.now());
    expect(snapshot.edibles).toEqual([]);
    view.destroy();
  });
});
