# CodeMirror 6 Code Evaluation

```
npm install @management/cm-evaluate
```

This package should be used with the stable release of the CodeMirror 6 packages (version 6.x.x). Using this with the beta versions of CodeMirror 6 will cause errors.

## Basic Usage

```javascript
import { EditorView, basicSetup } from "codemirror";
import { evaluation } from "@management/cm-evaluate";

// Define a function that handles evaluated code
function myEval({ evaluation: { code } }) {
  eval(code);
}

// Then, pass that into a codemirror instance
let view = new EditorView({
  extensions: [evaluation(myEval), basicSetup],
  parent: document.body,
});
```

By default, this creates three keyboard shortcuts:

- **Shift+Enter**: Send `dn $ silence` for the current blank-line-delimited block, without editing its text. Does nothing on blank lines or if the block has no unique `dn $` target. Strings and comments are ignored.
- **Ctrl+Enter (Cmd+Enter on Mac)**: Evaluate the current block of lines separated by blank lines
- **Ctrl+. (Cmd+. on Mac)**: Stop all patterns with `hush`
