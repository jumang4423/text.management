/**
 * @jest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { setChewingRanges } from "@core/extensions/bug/codemirrorHabitat";
import { bugHabitatExtension } from "@core/extensions/bug/codemirrorHabitat";

import { effectAbbrev } from "./effect-abbrev";

const docText = 'd1 $ s "bd" # gain 0.8\n\nd2 $ s "hh" # pan 0.5\n\n-- parked here';

function setup(selection?: { anchor: number }) {
  const view = new EditorView({
    state: EditorState.create({
      doc: docText,
      extensions: [effectAbbrev()],
      selection,
    }),
    parent: document.body,
  });
  return view;
}

describe("effect abbreviation plugin", () => {
  test("abbreviates away from the cursor", () => {
    // Cursor parked on the trailing line: both blocks abbreviate.
    const view = setup({ anchor: docText.length });
    const widgets = [
      ...view.dom.querySelectorAll(".cm-effect-abbrev"),
    ].map((element) => element.textContent);
    expect(widgets).toEqual(["#g", "#p"]);
    view.destroy();
  });

  test("cursor block keeps its source", () => {
    const view = setup({ anchor: 0 });
    const widgets = [
      ...view.dom.querySelectorAll(".cm-effect-abbrev"),
    ].map((element) => element.textContent);
    // First block (cursor): source. Second block: abbreviated.
    expect(widgets).toEqual(["#p"]);
    expect(view.state.doc.toString()).toBe(docText);
    view.destroy();
  });

  test("moving the cursor flips the abbreviation", () => {
    const view = setup({ anchor: 0 });
    expect(
      view.dom.querySelectorAll(".cm-effect-abbrev").length
    ).toBe(1);
    view.dispatch({ selection: { anchor: docText.length } });
    expect(
      [...view.dom.querySelectorAll(".cm-effect-abbrev")].map(
        (element) => element.textContent
      )
    ).toEqual(["#g", "#p"]);
    view.destroy();
  });
});

describe("chewing on abbreviated widgets", () => {
  const chewedDoc = 'd1 $ s "bd" # gain 0.8\n\n-- parked here';

  function chewingSetup() {
    const view = new EditorView({
      state: EditorState.create({
        doc: chewedDoc,
        extensions: [bugHabitatExtension, effectAbbrev()],
        selection: { anchor: chewedDoc.length },
      }),
      parent: document.body,
    });
    return view;
  }

  test("chewed abbreviation chomps", () => {
    const view = chewingSetup();
    expect(
      view.dom.querySelector(".cm-effect-abbrev-chewing")
    ).toBeNull();
    view.dispatch({ effects: setChewingRanges.of([{ from: 12, to: 22 }]) });
    const chomping = view.dom.querySelector(".cm-effect-abbrev-chewing");
    expect(chomping).not.toBeNull();
    expect(chomping!.textContent).toBe("#g");
    view.dispatch({ effects: setChewingRanges.of([]) });
    expect(
      view.dom.querySelector(".cm-effect-abbrev-chewing")
    ).toBeNull();
    expect(
      view.dom.querySelector(".cm-effect-abbrev")!.textContent
    ).toBe("#g");
    view.destroy();
  });
});
