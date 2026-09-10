import { EditorView, KeyBinding } from "@codemirror/view";

import { evaluate } from "./evaluate";
import { showSilenceAnimation } from "./silence-animation";

export const evaluationKeymap: KeyBinding[] = [
  { key: "Shift-Enter", run: silenceBlock },
  { key: "Mod-Enter", run: evaluateBlock },
  { key: "Mod-.", run: hush },
];

export function silenceBlock(view: EditorView) {
  const { state, dispatch } = view;
  const { doc, selection } = state;
  const line = doc.lineAt(selection.main.head);
  if (!line.text.trim()) return true;
  let first = line.number;
  let last = line.number;
  while (first > 1 && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && doc.line(last + 1).text.trim()) last++;
  const source = doc.sliceString(doc.line(first).from, doc.line(last).to);

  const channels = dChannelsInBlock(source);
  // Ambiguous blocks must not accidentally silence another part.
  if (channels.size === 1) {
    dispatch(evaluate(state, `d${[...channels][0]} $ silence`));
    showSilenceAnimation(view, doc.line(first).from, doc.line(last).to);
  }
  return true;
}

// Channel numbers (the N in `dN $`) referenced by a block of Tidal code.
// Strings and comments, including nested Haskell block comments, are ignored.
export function dChannelsInBlock(source: string): Set<string> {
  return new Set(
    Array.from(
      maskTidalCode(source).matchAll(/^\s*d(\d+)\s*\$/gm),
      (match) => match[1]
    )
  );
}

// The block source with strings and comments (including nested Haskell
// block comments) blanked out. Newlines are preserved, so the result can
// be split back into lines aligned with the input.
export function maskTidalCode(source: string): string {
  let code = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (depth) {
      if (pair === "{-") { depth++; i++; code += "  "; }
      else if (pair === "-}") { depth--; i++; code += "  "; }
      else code += char === "\n" ? "\n" : " ";
    } else if (quoted) {
      code += char === "\n" ? "\n" : " ";
      if (char === "\\") { i++; code += source[i] === "\n" ? "\n" : " "; }
      else if (char === '"') quoted = false;
    } else if (pair === "{-") {
      depth = 1; i++; code += "  ";
    } else if (pair === "--") {
      while (i < source.length && source[i] !== "\n") { code += " "; i++; }
      if (i < source.length) code += "\n";
    } else if (char === '"') {
      quoted = true; code += " ";
    } else code += char;
  }
  return code;
}

export function evaluateLine({ state, dispatch }: EditorView) {
  const line = state.doc.lineAt(state.selection.main.from);
  dispatch(evaluate(state, line.from, line.to));
  return true;
}

export function evaluateBlock({ state, dispatch }: EditorView) {
  let { doc, selection } = state;
  let { text, number } = state.doc.lineAt(selection.main.from);

  if (text.trim().length === 0) return true;

  let fromL, toL;
  fromL = toL = number;

  while (fromL > 1 && doc.line(fromL - 1).text.trim().length > 0) {
    fromL -= 1;
  }
  while (toL < doc.lines && doc.line(toL + 1).text.trim().length > 0) {
    toL += 1;
  }

  let { from } = doc.line(fromL);
  let { to } = doc.line(toL);

  dispatch(evaluate(state, from, to));
  return true;
}

export function hush({ state, dispatch }: EditorView) {
  dispatch(evaluate(state, "hush"));
  return true;
}
