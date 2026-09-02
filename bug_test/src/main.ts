import { basicSetup } from "codemirror";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CodeMirrorHabitat } from "./adapters/codemirrorHabitat";
import { BugWorld, type BugWorldMetrics } from "./bug/world";
import { demoCode } from "./demoCode";
import "./style.css";

interface TidalState {
  inString: boolean;
}

const tidalParser: StreamParser<TidalState> = {
  startState: () => ({ inString: false }),
  token(stream, state) {
    if (stream.sol() && stream.match(/\s*--.*/)) return "comment";
    if (stream.match(/--.*/)) return "comment";
    if (stream.match(/"/)) {
      state.inString = !state.inString;
      return "string";
    }
    if (state.inString) {
      stream.next();
      while (!stream.eol() && stream.peek() !== '"') stream.next();
      return "string";
    }
    if (stream.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/)) return "number";
    if (stream.match(/(?:^|\s)(?:d\d+|hush|silence|sound|slow|fast|every|jux|rev)\b/)) {
      return "keyword";
    }
    if (stream.match(/[$#~*<>\[\](),]/)) return "operator";
    if (stream.match(/[A-Za-z][\w']*/)) return "variableName";
    stream.next();
    return null;
  },
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("#app is missing");

app.innerHTML = `
  <header class="app-header">
    <div class="title-lockup">
      <span class="status-dot" aria-hidden="true"></span>
      <div>
        <strong>bug_test</strong>
        <span>living code habitat</span>
      </div>
    </div>
    <p>rest → roam → rest · hungry = eat · nearby pointer = flee</p>
  </header>
  <main class="workspace">
    <section class="habitat-shell" aria-label="Code habitat">
      <div class="tab-strip">
        <span>1</span>
        <strong>260901-bug.tidal</strong>
        <span class="live-label">● organism alive</span>
      </div>
      <div class="habitat-stage" id="habitat-stage">
        <div id="editor"></div>
        <canvas id="bug-layer" aria-hidden="true"></canvas>
      </div>
      <footer class="status-bar">
        <span id="status-behaviour">HATCHING</span>
        <span id="status-target">no scent target</span>
        <span>click a dropping to undo matter</span>
      </footer>
    </section>
    <aside class="lab-panel">
      <div class="panel-heading">
        <span>FIELD NOTES</span>
        <span>HUNGER ONLY</span>
      </div>
      <div class="vitals" id="vitals"></div>
      <div class="controls">
        <button id="starve" type="button"><span>01</span> MAKE HUNGRY</button>
        <button id="undo" type="button"><span>02</span> UNDO BITE</button>
        <button id="reset" type="button"><span>03</span> NEW EGG</button>
      </div>
      <div class="biology-note">
        <strong>SIMPLE LIFE LOOP</strong>
        <p>Rest for 2–8 seconds, walk to one random visible point, then rest again. Hunger redirects the bug to code; a nearby pointer interrupts everything and makes it flee.</p>
      </div>
    </aside>
  </main>
`;

const stage = requiredElement<HTMLElement>("#habitat-stage");
const canvas = requiredElement<HTMLCanvasElement>("#bug-layer");
let habitat: CodeMirrorHabitat;

const editor = new EditorView({
  state: EditorState.create({
    doc: demoCode,
    extensions: [
      basicSetup,
      StreamLanguage.define(tidalParser),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) habitat?.invalidateDocument();
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          background: "#deddda",
          color: "#151515",
          fontSize: "18px",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: '"Courier New", ui-monospace, monospace',
          lineHeight: "1.42",
        },
        ".cm-content": {
          minHeight: "100%",
          padding: "20px 24px 180px",
          caretColor: "#008000",
        },
        ".cm-line": {
          width: "fit-content",
          minWidth: "20ch",
          background: "rgba(255,255,255,0.68)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.68)",
        },
        ".cm-gutters": {
          background: "#e9e8e5",
          borderRight: "1px solid rgba(0,0,0,0.08)",
          color: "#888b86",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          background: "rgba(212,243,87,0.12)",
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          background: "rgba(0,128,0,0.18) !important",
        },
        ".cm-cursor": { borderLeftColor: "#008000", borderLeftWidth: "2px" },
      }),
    ],
  }),
  parent: requiredElement<HTMLElement>("#editor"),
});

habitat = new CodeMirrorHabitat(editor, stage);
const world = new BugWorld(habitat, canvas);
world.onMetrics = updateMetrics;
world.start();

stage.addEventListener("pointermove", (event) => {
  const rect = stage.getBoundingClientRect();
  world.pointerMove({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.timeStamp);
});
stage.addEventListener("pointerleave", () => world.pointerLeave());
stage.addEventListener(
  "pointerdown",
  (event) => {
    const rect = stage.getBoundingClientRect();
    const stagePoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    world.pointerMove(stagePoint, event.timeStamp);
    const handled = world.pointerDown(stagePoint);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  { capture: true }
);

requiredElement<HTMLButtonElement>("#starve").addEventListener("click", () => world.starve());
requiredElement<HTMLButtonElement>("#undo").addEventListener("click", () => habitat.undoLastBite());
requiredElement<HTMLButtonElement>("#reset").addEventListener("click", () => world.reset());

function updateMetrics(metrics: BugWorldMetrics) {
  requiredElement("#vitals").innerHTML = `
    <div class="vital-row">
      <span>HUNGER</span>
      <div><i style="width:${Math.round(metrics.hunger * 100)}%;background:#ff8c00"></i></div>
      <output>${metrics.hunger.toFixed(2)}</output>
    </div>`;
  requiredElement("#status-behaviour").textContent = metrics.behaviour.toUpperCase();
  requiredElement("#status-target").textContent = metrics.target
    ? `smells: ${metrics.target}`
    : `${metrics.foodCount} edible code units`;
}

function requiredElement<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} is missing`);
  return element;
}

window.addEventListener("beforeunload", () => {
  world.destroy();
  habitat.destroy();
  editor.destroy();
});
