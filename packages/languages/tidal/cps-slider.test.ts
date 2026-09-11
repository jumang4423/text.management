/**
 * @jest-environment jsdom
 */
import { EditorState, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { evaluationEffect } from "@management/cm-evaluate";

import { cpsSlider, findCpsSliders } from "./cps-slider";

describe("findCpsSliders", () => {
  test("finds a setcps number", () => {
    expect(findCpsSliders("setcps 0.62")).toEqual([
      { from: 7, to: 11, value: 0.62 },
    ]);
  });

  test("clamps outside the range", () => {
    expect(findCpsSliders("setcps 0.1")[0].value).toBe(0.3);
    expect(findCpsSliders("setcps 9")[0].value).toBe(3.0);
  });

  test("finds numbers inside parens and several matches", () => {
    expect(findCpsSliders("setcps (1.2)\nsetcps 2")).toEqual([
      { from: 8, to: 11, value: 1.2 },
      { from: 20, to: 21, value: 2 },
    ]);
  });

  test("ignores comments, strings and lookalikes", () => {
    expect(findCpsSliders('-- setcps 1\n"xsetcps 1"\nsetcpsx 1')).toEqual([]);
  });
});

describe("cps slider widget", () => {
  function setup() {
    const seen: StateEffect<unknown>[] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: 'setcps 0.62\nd1 $ s "bd"',
        extensions: [
          cpsSlider(),
          EditorView.updateListener.of((update) => {
            for (const transaction of update.transactions) {
              seen.push(...transaction.effects);
            }
          }),
        ],
      }),
      parent: document.body,
    });
    const input = view.dom.querySelector<HTMLInputElement>(
      ".tm-cps-slider input"
    );
    return { view, seen, input };
  }

  function evaluationCodes(seen: StateEffect<unknown>[]) {
    return seen
      .filter((effect) => effect.is(evaluationEffect))
      .map((effect) => (effect.value as { code: string }).code);
  }

  test("replaces the number with a ranged slider", () => {
    const { view, input } = setup();
    expect(input).not.toBeNull();
    expect(input!.min).toBe("0.3");
    expect(input!.max).toBe("3");
    expect(input!.value).toBe("0.62");
    expect(
      view.dom.querySelector(".tm-cps-slider-bpm")!.textContent
    ).toBe("149");
    view.destroy();
  });

  test("debounces input into an evaluation", () => {
    jest.useFakeTimers();
    try {
      const { view, seen, input } = setup();
      input!.value = "1.5";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.value = "1.6";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(evaluationCodes(seen)).toEqual([]);
      jest.advanceTimersByTime(30);
      expect(evaluationCodes(seen)).toEqual(["setcps 1.6"]);
      view.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  test("release writes the value back to the document", () => {
    const { view, input } = setup();
    input!.value = "1.5";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe('setcps 1.5\nd1 $ s "bd"');
    const rebuilt = view.dom.querySelector<HTMLInputElement>(
      ".tm-cps-slider input"
    );
    expect(rebuilt!.value).toBe("1.5");
    expect(
      view.dom.querySelector(".tm-cps-slider-bpm")!.textContent
    ).toBe("360");
    view.destroy();
  });
});
