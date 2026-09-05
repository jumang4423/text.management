import { EditorView, KeyBinding } from "@codemirror/view";

import { evaluate } from "./evaluate";

export const evaluationKeymap: KeyBinding[] = [
  { key: "Shift-Enter", run: silenceBlock },
  { key: "Mod-Enter", run: evaluateBlock },
  { key: "Mod-.", run: hush },
];

export function silenceBlock({ state, dispatch }: EditorView) {
  const { doc, selection } = state;
  const line = doc.lineAt(selection.main.head);
  if (!line.text.trim()) return true;
  let first = line.number;
  let last = line.number;
  while (first > 1 && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && doc.line(last + 1).text.trim()) last++;
  const source = doc.sliceString(doc.line(first).from, doc.line(last).to);

  // Ignore strings and comments, including nested Haskell block comments.
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

  const channels = new Set(Array.from(code.matchAll(/^\s*d(\d+)\s*\$/gm), (match) => match[1]));
  // Ambiguous blocks must not accidentally silence another part.
  if (channels.size === 1) {
    dispatch(evaluate(state, `d${[...channels][0]} $ silence`));
  }
  return true;
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
