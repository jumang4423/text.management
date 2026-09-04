import { EditorState, EditorStateConfig } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { LayoutView, TabView } from "../view";
import {
  LayoutTransaction,
  TabState,
  focusCurrent,
  swapContents,
} from "../state";
import {
  getFileName,
  getFileID,
} from "../../../../app/desktop/src/renderer/file";

import { ElectronAPI } from "@core/api";
import type { PoopSoundKind } from "../../bug/types";
import {
  LivingCodeBug,
  bugHabitatExtension,
  isLivingCodeBugVisible,
  onLivingCodeBugVisibilityChange,
} from "../../bug";

export class EditorTabState extends TabState<EditorState> {
  static create(config?: EditorStateConfig, id?: string) {
    return new EditorTabState(EditorState.create(config), id);
  }

  swapContents(contents: EditorState) {
    return new EditorTabState(contents, this.id);
  }

  get name() {
    return getFileName(this.contents);
  }

  get fileID() {
    return getFileID(this.contents);
  }
}

export class EditorTabView extends TabView<EditorState> {
  private editor: EditorView;
  private bug: LivingCodeBug | null = null;
  private offTidalNow: (() => void) | null = null;
  private offBugVisibility: (() => void) | null = null;
  private lastRhythmQuarter: number | null = null;

  // TODO: ScrollTarget type isn't exported currently
  private scrollSnapshot: any | null = null;

  constructor(
    layout: LayoutView,
    id: string,
    private api: typeof ElectronAPI,
    config?: EditorStateConfig,
    bugEnabled = true,
    private hooks: {
      onPoopSound?: (kind: PoopSoundKind) => void;
    } = {}
  ) {
    const state = EditorTabState.create(
      bugEnabled
        ? {
            ...config,
            extensions: [config?.extensions ?? [], bugHabitatExtension],
          }
        : config,
      id
    );
    super(layout, state);

    // Set up dom...

    this.editor = new EditorView({
      state: this.state.contents,
      parent: this.dom,
      dispatch: (tr) => {
        this.layout.dispatch({
          effects: [swapContents.of({ id: this.state.id, contents: tr.state })],
        });
        this.editor.update([tr]);
        if (tr.docChanged) this.bug?.invalidateDocument();
      },
    });
    this.bug = bugEnabled
      ? new LivingCodeBug(this.editor, this.dom, {
          onPoopSound: this.hooks.onPoopSound,
        })
      : null;
    if (this.bug) {
      this.bug.setEnabled(isLivingCodeBugVisible());
      this.offBugVisibility = onLivingCodeBugVisibilityChange((visible) => {
        this.bug?.setEnabled(visible);
      });
    }
    if (this.bug && typeof this.api.onTidalNow === "function") {
      this.offTidalNow = this.api.onTidalNow(this.onTidalNow);
    }
  }

  private readonly onTidalNow = (cycle: number) => {
    if (!Number.isFinite(cycle)) return;
    const quarter = Math.floor(Math.max(0, cycle) * 4 + 1e-7);
    if (this.lastRhythmQuarter === null) {
      this.lastRhythmQuarter = quarter;
      return;
    }
    if (quarter < this.lastRhythmQuarter) {
      if (this.lastRhythmQuarter - quarter > 4) {
        this.lastRhythmQuarter = quarter;
        this.bug?.clearRhythm();
      }
      return;
    }
    if (quarter === this.lastRhythmQuarter) return;
    this.lastRhythmQuarter = quarter;
    this.bug?.rhythmPulse({
      startedAt: performance.now(),
      intensity: 1,
      direction: quarter % 2 === 0 ? 1 : -1,
    });
  };

  update(tr: LayoutTransaction) {
    super.update(tr);

    if (tr.state.current === this.state.id) {
      if (
        tr.startState.current !== this.state.id ||
        tr.effects.some((e) => e.is(focusCurrent))
      ) {
        this.editor.focus();
      }
    }
  }

  beforeUnmount() {
    this.scrollSnapshot = this.editor.scrollSnapshot();
    this.bug?.unmount();
  }

  afterMount() {
    if (this.scrollSnapshot !== null) {
      this.editor.update([
        this.editor.state.update({ effects: this.scrollSnapshot }),
      ]);
    }
    this.bug?.mount();
  }

  beforeClose() {
    this.api.requestClose(this.state.id);
    return false;
  }

  destroy() {
    this.offBugVisibility?.();
    this.offBugVisibility = null;
    this.offTidalNow?.();
    this.offTidalNow = null;
    this.bug?.destroy();
    this.bug = null;
    this.editor.destroy();
  }
}
