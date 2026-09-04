import type { EditorView } from "@codemirror/view";

import { CodeMirrorHabitat } from "./codemirrorHabitat";
import { BugWorld } from "./world";
import type { Vec2 } from "./math";
import type { PoopSoundKind, RhythmPulse } from "./types";

import "./style.css";

export { bugHabitatExtension } from "./codemirrorHabitat";
export {
  TIDAL_FOOD_BLACKLIST,
  isTidalFoodBlacklisted,
  type TidalFoodBlacklist,
} from "./foodBlacklist";

type BugVisibilityListener = (visible: boolean) => void;

let bugVisible = true;
const bugVisibilityListeners = new Set<BugVisibilityListener>();

export function isLivingCodeBugVisible() {
  return bugVisible;
}

export function setLivingCodeBugVisible(visible: boolean) {
  if (bugVisible === visible) return;
  bugVisible = visible;
  for (const listener of bugVisibilityListeners) listener(visible);
}

export function onLivingCodeBugVisibilityChange(
  listener: BugVisibilityListener
) {
  bugVisibilityListeners.add(listener);
  return () => bugVisibilityListeners.delete(listener);
}

export class LivingCodeBug {
  private readonly canvas = document.createElement("canvas");
  private habitat: CodeMirrorHabitat | null = null;
  private world: BugWorld | null = null;
  private mounted = false;
  private enabled = true;

  constructor(
    private readonly view: EditorView,
    private readonly stage: HTMLElement,
    private readonly options: {
      onPoopSound?: (kind: PoopSoundKind) => void;
    } = {}
  ) {
    this.stage.classList.add("cm-bug-habitat");
    this.canvas.className = "cm-bug-layer";
    this.canvas.setAttribute("aria-hidden", "true");
    this.stage.appendChild(this.canvas);

    this.stage.addEventListener("pointermove", this.pointerMove);
    this.stage.addEventListener("pointerleave", this.pointerLeave);
    this.stage.addEventListener("pointerdown", this.pointerDown, {
      capture: true,
    });
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    if (!this.habitat || !this.world) {
      this.habitat = new CodeMirrorHabitat(this.view, this.stage);
      this.world = new BugWorld(this.habitat, this.canvas);
      this.world.onPoopSound = this.options.onPoopSound ?? null;
    } else {
      this.habitat.refreshViewport();
    }
    this.canvas.hidden = !this.enabled;
    if (this.enabled) this.world.start();
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.canvas.hidden = !enabled;
    if (!enabled) {
      this.world?.pointerLeave();
      this.world?.pause();
    } else if (this.mounted) {
      this.habitat?.refreshViewport();
      this.world?.start();
    }
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    this.world?.pointerLeave();
    this.world?.pause();
  }

  invalidateDocument() {
    this.habitat?.invalidateDocument();
  }

  rhythmPulse(pulse: RhythmPulse) {
    if (this.mounted && this.enabled) this.world?.rhythmPulse(pulse);
  }

  clearRhythm() {
    this.world?.clearRhythm();
  }

  destroy() {
    this.unmount();
    this.stage.removeEventListener("pointermove", this.pointerMove);
    this.stage.removeEventListener("pointerleave", this.pointerLeave);
    this.stage.removeEventListener("pointerdown", this.pointerDown, true);
    this.world?.destroy();
    this.habitat?.destroy();
    this.world = null;
    this.habitat = null;
    this.canvas.remove();
    this.stage.classList.remove("cm-bug-habitat");
  }

  private stagePoint(event: PointerEvent): Vec2 {
    const rect = this.stage.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private readonly pointerMove = (event: PointerEvent) => {
    if (!this.enabled) return;
    this.world?.pointerMove(this.stagePoint(event), event.timeStamp);
  };

  private readonly pointerLeave = () => {
    this.world?.pointerLeave();
  };

  private readonly pointerDown = (event: PointerEvent) => {
    if (!this.enabled || !this.world || event.button !== 0) return;
    const point = this.stagePoint(event);
    this.world.pointerMove(point, event.timeStamp);
    if (!this.world.pointerDown(point)) return;
    event.preventDefault();
    event.stopPropagation();
  };
}
