import { ElectronAPI } from "../preload";

import { Text } from "@codemirror/state";
import { basicSetup } from "@core/extensions/basicSetup";
import { oneDark } from "@core/extensions/theme/theme";
import { tidal } from "@management/lang-tidal/editor";

import { Config } from "@core/state";
import { settings } from "@core/extensions/settings/editor";
import type {
  Evaluation as ConsoleEvaluation,
  Log,
} from "@core/api";

import { LayoutView } from "@core/extensions/layout";
import { console as electronConsole } from "@core/extensions/console";
// import { peer } from "@core/extensions/peer";
import { toolbarConstructor } from "@core/extensions/toolbar";
import { ColorScheme } from "@core/extensions/theme/colors";
import { dampedSpringKeyframes } from "@core/animation/spring";

import { fileSync } from "./file";
import { EditorTabView } from "@core/extensions/layout/tabs/editor";
import { AboutTabView } from "@core/extensions/layout/tabs/about";
import { SampleFileBrowser } from "./browser";

import {
  evaluationWithHighlights,
  highlighter,
} from "@management/lang-tidal/highlights";
import { EditorView, keymap } from "@codemirror/view";
import {
  Evaluation as EditorEvaluation,
  evaluation,
} from "@management/cm-evaluate";

import "./error-recoil.css";

const errorRecoilDuration = 820;

interface EvaluationTarget {
  view: EditorView;
  sentCode: string;
  span?: { from: number; to: number };
  createdAt: number;
  recoiled: boolean;
}

let latestEvaluation: EvaluationTarget | null = null;
const evaluationTargets: EvaluationTarget[] = [];
let lastFallbackRecoil = -Infinity;
const recoilAnimations = new WeakMap<HTMLElement, Animation>();
const activeRecoilAnimations = new Set<Animation>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  for (const animation of activeRecoilAnimations) animation.cancel();
});

function currentEditorView() {
  const editor = document.querySelector<HTMLElement>(
    ".editor-main .tab-content .cm-editor"
  );
  return editor ? EditorView.findFromDOM(editor) : null;
}

function normalizedGhciInput(code: string) {
  const trimmed = code.trim();
  const block = trimmed.match(/^:\{\r?\n([\s\S]*)\r?\n:\}$/);
  return (block?.[1] ?? trimmed).trim();
}

function queueEvaluation(code: string) {
  const view = currentEditorView();
  if (!view) return;

  const now = performance.now();
  const target: EvaluationTarget = {
    view,
    sentCode: normalizedGhciInput(code),
    createdAt: now,
    recoiled: false,
  };

  latestEvaluation = target;
  evaluationTargets.push(target);

  while (
    evaluationTargets.length > 24 ||
    now - evaluationTargets[0].createdAt > 30_000
  ) {
    evaluationTargets.shift();
  }
}

function rememberEvaluation(evaluated: EditorEvaluation) {
  const view = currentEditorView();
  if (!view) return;

  if (latestEvaluation?.view === view) {
    latestEvaluation.span = evaluated.span;
  } else {
    const target: EvaluationTarget = {
      view,
      sentCode: normalizedGhciInput(evaluated.code),
      span: evaluated.span,
      createdAt: performance.now(),
      recoiled: false,
    };
    latestEvaluation = target;
    evaluationTargets.push(target);
  }
}

function sendEvaluation(request: { code: string }) {
  queueEvaluation(request.code);
  api.evaluate(request);
}

function currentBlock(view: EditorView) {
  const { doc, selection } = view.state;
  const activeLine = doc.lineAt(selection.main.head);
  if (activeLine.text.trim().length === 0) {
    return { from: activeLine.from, to: activeLine.to };
  }

  let fromLine = activeLine.number;
  let toLine = fromLine;

  while (fromLine > 1 && doc.line(fromLine - 1).text.trim().length > 0) {
    fromLine -= 1;
  }
  while (toLine < doc.lines && doc.line(toLine + 1).text.trim().length > 0) {
    toLine += 1;
  }

  return { from: doc.line(fromLine).from, to: doc.line(toLine).to };
}

function lineElementsForSpan(
  view: EditorView,
  { from, to }: { from: number; to: number }
) {
  const doc = view.state.doc;
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const firstLine = doc.lineAt(safeFrom).number;
  const lastLine = doc.lineAt(Math.max(safeFrom, safeTo - 1)).number;

  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].filter(
    (line) => {
      try {
        const lineNumber = doc.lineAt(view.posAtDOM(line, 0)).number;
        return lineNumber >= firstLine && lineNumber <= lastLine;
      } catch {
        return false;
      }
    }
  );
}

function playErrorRecoil(view: EditorView, span?: { from: number; to: number }) {
  const targets = lineElementsForSpan(view, span ?? currentBlock(view));
  const elements = targets.length > 0 ? targets : [view.contentDOM];

  for (const element of elements) {
    recoilAnimations.get(element)?.cancel();
    element.classList.remove("cm-error-recoil-active");
  }

  for (const element of elements) {
    const duration = reducedMotion.matches ? 320 : errorRecoilDuration;
    const keyframes = reducedMotion.matches
      ? [
          { backgroundColor: "transparent", textShadow: "none" },
          {
            backgroundColor: "rgb(255 160 32 / 42%)",
            textShadow: "2px 0 rgb(255 160 32 / 65%)",
            offset: 0.24,
          },
          { backgroundColor: "transparent", textShadow: "none" },
        ]
      : dampedSpringKeyframes(
          duration,
          { stiffness: 340, damping: 7.6 },
          ({ displacement, velocity, energy }) => {
            const speed = Math.min(1.2, Math.abs(velocity));
            const horizontal = -displacement * 14;
            const skew = displacement * 3.2;
            const scaleX =
              1 - speed * 0.1 + Math.abs(displacement) * 0.045;
            const scaleY =
              1 + speed * 0.12 - Math.abs(displacement) * 0.02;
            const wash = Math.min(
              0.46,
              energy * (0.12 + speed * 0.18 + Math.abs(displacement) * 0.22)
            );
            const shadow = displacement * 5.5;
            return {
              transform: `translateX(${horizontal.toFixed(3)}px) skewX(${skew.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`,
              backgroundColor: `rgb(255 160 32 / ${wash.toFixed(3)})`,
              textShadow: `${shadow.toFixed(3)}px 0 rgb(255 160 32 / ${(energy * 0.72).toFixed(3)})`,
            };
          }
        );

    element.classList.add("cm-error-recoil-active");
    const animation = element.animate(keyframes, {
      duration,
      easing: "linear",
    });
    recoilAnimations.set(element, animation);
    activeRecoilAnimations.add(animation);

    const clear = () => {
      activeRecoilAnimations.delete(animation);
      if (recoilAnimations.get(element) !== animation) return;
      recoilAnimations.delete(element);
      element.classList.remove("cm-error-recoil-active");
    };
    animation.addEventListener("finish", clear, { once: true });
    animation.addEventListener("cancel", clear, { once: true });
  }
}

function recoilOnError(message: ConsoleEvaluation | Log) {
  const isEvaluation = "success" in message;
  const isError = isEvaluation ? !message.success : message.level === "error";
  if (!isError) return;

  let evaluationTarget: EvaluationTarget | null = null;
  if (isEvaluation) {
    const input = normalizedGhciInput(message.input);
    for (let index = evaluationTargets.length - 1; index >= 0; index -= 1) {
      if (evaluationTargets[index].sentCode === input) {
        evaluationTarget = evaluationTargets[index];
        break;
      }
    }
    evaluationTarget ??= latestEvaluation;
  }

  if (evaluationTarget) {
    if (evaluationTarget.recoiled) return;
    evaluationTarget.recoiled = true;
    const view = evaluationTarget.view.dom.isConnected
      ? evaluationTarget.view
      : currentEditorView();
    if (view) {
      playErrorRecoil(
        view,
        view === evaluationTarget.view ? evaluationTarget.span : undefined
      );
    }
    return;
  }

  // Startup/runtime errors do not carry an evaluation span. Give the active
  // block a single reaction, with a short guard against duplicate log chunks.
  const now = performance.now();
  if (now - lastFallbackRecoil < errorRecoilDuration) return;
  lastFallbackRecoil = now;

  const view = currentEditorView();
  if (view) playErrorRecoil(view);
}

window.addEventListener("load", () => {
  const parent = document.body.appendChild(document.createElement("section"));
  parent.id = "editor";
  new Editor(parent);
});

const { api } = window as Window &
  typeof globalThis & {
    api: typeof ElectronAPI;
  };

const configuration = new Config();
api.onSettingsData((data) => {
  configuration.update(data);
});

// Color scheme extension
const colorScheme = new ColorScheme(configuration);

const background: string | null = null;

export class Editor {
  constructor(parent: HTMLElement) {
    const workspace = parent.appendChild(document.createElement("div"));
    workspace.className = "editor-workspace";
    new SampleFileBrowser(workspace, api);
    const editorMain = workspace.appendChild(document.createElement("main"));
    editorMain.className = "editor-main";
    let layout = new LayoutView(editorMain, api.setCurrent, api.newTab);

    if (background) {
      let canvas = parent.appendChild(document.createElement("iframe"));
      canvas.src = background;
      canvas.classList.add("background");
    }

    // Keep track of Tidal state
    let tidalVersion: string | undefined;

    // Append Tidal UI Panels
    let tidalConsole = electronConsole();
    layout.panelArea.appendChild(tidalConsole.dom);

    let toolbar = toolbarConstructor(api, configuration, tidalVersion);
    layout.panelArea.appendChild(toolbar.dom);

    api.onTidalVersion((version) => {
      tidalVersion = version;
    });

    api.onToggleConsole(() => {
      tidalConsole.toggleVisibility();
    });

    api.onConsoleMessage((message) => {
      tidalConsole.update(message);
      recoilOnError(message);
    });

    api.onOpen(({ id, path }) => {
      // TODO: This is a hacky heuristic
      let languageMode = path?.endsWith("settings.json") ? settings() : tidal();

      let offContent = api.onContent(id, ({ doc: docJSON, version, saved }) => {
        let doc = Text.of(docJSON);

        layout.dispatch({
          changes: [
            {
              view: new EditorTabView(layout, id, api, {
                doc,
                extensions: [
                  oneDark,
                  evaluationWithHighlights(sendEvaluation),
                  highlighter(api),
                  evaluation((evaluated) => {
                    tidalConsole.toggleVisibility(false);
                    rememberEvaluation(evaluated);
                  }),
                  languageMode,
                  basicSetup,
                  fileSync(
                    id,
                    { path, saved, version, thisVersion: version },
                    api
                  ),
                  // peer(version),
                ],
              }),
            },
          ],
        });

        offContent();
      });
    });

    api.onClose(({ id }) => {
      layout.dispatch({ changes: [id] });
    });

    api.onSetCurrent(({ id }) => {
      layout.dispatch({ current: id });
    });

    api.onShowAbout((appVersion) => {
      layout.dispatch({
        changes: [
          {
            view: new AboutTabView(layout, appVersion),
          },
        ],
      });
    });
  }
}
