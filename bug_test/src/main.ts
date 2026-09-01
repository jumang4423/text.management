import { basicSetup } from "codemirror";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CodeMirrorHabitat } from "./adapters/codemirrorHabitat";
import { BugWorld, type BugWorldMetrics } from "./bug/world";
import type { CreatureMode } from "./bug/types";
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
    <p>slow pointer = curiosity · fast pointer = fear · click poop = restore</p>
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
        <span id="mode-label">NIBBLE</span>
      </div>
      <div class="vitals" id="vitals"></div>
      <div class="controls">
        <button id="starve" type="button"><span>01</span> MAKE HUNGRY</button>
        <button id="pulse" type="button"><span>02</span> SOUND PULSE</button>
        <button id="undo" type="button"><span>03</span> UNDO BITE</button>
        <button id="reset" type="button"><span>04</span> NEW EGG</button>
      </div>
      <fieldset>
        <legend>BEHAVIOUR</legend>
        <label>
          <input type="radio" name="mode" value="nibble" checked />
          <span>NIBBLE</span>
          edits safe food units
        </label>
        <label>
          <input type="radio" name="mode" value="pet" />
          <span>PET</span>
          chews visually only
        </label>
        <label>
          <input id="auto-pulse" type="checkbox" />
          <span>AUTO SOUND</span>
          emits habitat heat
        </label>
        <label>
          <input id="show-scent" type="checkbox" checked />
          <span>SHOW SCENT</span>
          debug target tether
        </label>
      </fieldset>
      <div class="biology-note">
        <strong>1 BUG · 4 × 2 RIG</strong>
        <p>One gait personality. The head records its route; four rear discs follow that path with increasing delay to form a visible shallow arc.</p>
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

window.addEventListener("pointermove", (event) => {
  const rect = stage.getBoundingClientRect();
  world.pointerMove({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.timeStamp);
});
stage.addEventListener(
  "pointerdown",
  (event) => {
    const rect = stage.getBoundingClientRect();
    const handled = world.pointerDown({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  { capture: true }
);

requiredElement<HTMLButtonElement>("#starve").addEventListener("click", () => world.starve());
requiredElement<HTMLButtonElement>("#pulse").addEventListener("click", () => world.soundPulse());
requiredElement<HTMLButtonElement>("#undo").addEventListener("click", () => habitat.undoLastBite());
requiredElement<HTMLButtonElement>("#reset").addEventListener("click", () => world.reset());
requiredElement<HTMLInputElement>("#auto-pulse").addEventListener("change", (event) => {
  world.autoPulse = (event.currentTarget as HTMLInputElement).checked;
});
requiredElement<HTMLInputElement>("#show-scent").addEventListener("change", (event) => {
  world.showScent = (event.currentTarget as HTMLInputElement).checked;
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    world.mode = input.value as CreatureMode;
    requiredElement("#mode-label").textContent = world.mode.toUpperCase();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    world.soundPulse();
  }
});

function updateMetrics(metrics: BugWorldMetrics) {
  const labels: Array<[string, number, string]> = [
    ["HUNGER", metrics.hunger, "#ff8c00"],
    ["ENERGY", metrics.energy, "#008000"],
    ["FEAR", metrics.fear, "#e13825"],
    ["CURIOSITY", metrics.curiosity, "#6ed4e3"],
    ["FATIGUE", metrics.fatigue, "#94a1ff"],
    ["GUT", metrics.gut, "#6b3c1d"],
  ];
  requiredElement("#vitals").innerHTML = labels
    .map(
      ([label, value, color]) => `
        <div class="vital-row">
          <span>${label}</span>
          <div><i style="width:${Math.round(value * 100)}%;background:${color}"></i></div>
          <output>${value.toFixed(2)}</output>
        </div>`
    )
    .join("");
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
