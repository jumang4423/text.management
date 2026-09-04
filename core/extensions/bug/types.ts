import type { Rect, Vec2 } from "./math";

export type FoodKind = "modifier" | "function";
export type CreatureMode = "pet" | "nibble";
export type Behaviour =
  | "hatching"
  | "resting"
  | "wandering"
  | "foraging"
  | "chewing"
  | "toileting"
  | "fleeing";

export type PoopSoundKind = "wiggle" | "release";

export interface EdibleCode {
  id: string;
  from: number;
  to: number;
  text: string;
  kind: FoodKind;
  nutrition: number;
  heat: number;
  rect: Rect;
}

export interface EatenMatter {
  id: string;
  text: string;
  mutatedText: string;
  kind: FoodKind;
  nutrition: number;
}

export interface HabitatSnapshot {
  worldWidth: number;
  worldHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  canvasOffsetX: number;
  canvasOffsetY: number;
  activeLineRect: Rect | null;
  edibles: EdibleCode[];
}

export interface HabitatAdapter {
  snapshot(now: number): HabitatSnapshot;
  syncCamera(snapshot: HabitatSnapshot): void;
  stageToWorld(point: Vec2): Vec2;
  setChewing(edibles: readonly EdibleCode[]): void;
  eat(edible: EdibleCode): EatenMatter | null;
  restore(matter: EatenMatter): boolean;
  pulseRandom(now: number): { position: Vec2; strength: number } | null;
  undoLastBite(): void;
}

export interface PointerSense {
  position: Vec2;
  velocity: Vec2;
  speed: number;
  active: boolean;
}

export interface BodyControl {
  direction: Vec2;
  speed: number;
  gaitHz: number;
  wriggle: number;
  sleep: number;
  fear: number;
  gut: number;
  chew: number;
  poop: number;
  /** Strength of the wide, anticipatory edge steering. Hard bounds remain on. */
  edgeAvoidance: number;
}

export interface BrainSenses {
  now: number;
  deltaSeconds: number;
  head: Vec2;
  bounds: Rect;
  pointer: PointerSense;
  foods: EdibleCode[];
  activeLineRect: Rect | null;
  chewing: boolean;
  toiletTarget: Vec2 | null;
}

export interface BrainDecision {
  behaviour: Behaviour;
  control: BodyControl;
  targetFoodId: string | null;
}

export interface CreatureVitals {
  behaviour: Behaviour;
  hunger: number;
}

export interface RhythmPulse {
  startedAt: number;
  intensity: number;
  direction: number;
}
