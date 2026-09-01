import type { Rect, Vec2 } from "./math";

export type FoodKind = "mini" | "modifier" | "comment";
export type CreatureMode = "pet" | "nibble";
export type Behaviour =
  | "hatching"
  | "wandering"
  | "investigating"
  | "foraging"
  | "chewing"
  | "fleeing"
  | "sleeping";

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
  kind: FoodKind;
  nutrition: number;
  lineNumber: number;
  column: number;
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
  edibles: EdibleCode[];
}

export interface HabitatAdapter {
  snapshot(now: number): HabitatSnapshot;
  stageToWorld(point: Vec2): Vec2;
  eat(edible: EdibleCode): EatenMatter | null;
  restore(matter: EatenMatter): void;
  pulseRandom(now: number): { position: Vec2; strength: number } | null;
  undoLastBite(): void;
}

export interface PointerSense {
  position: Vec2;
  velocity: Vec2;
  speed: number;
  active: boolean;
}

export interface SoundStimulus {
  position: Vec2;
  strength: number;
  surprise: number;
  age: number;
}

export interface BodyControl {
  direction: Vec2;
  speed: number;
  gaitHz: number;
  wriggle: number;
  sleep: number;
  fear: number;
  gut: number;
}

export interface BrainSenses {
  now: number;
  deltaSeconds: number;
  head: Vec2;
  bounds: Rect;
  pointer: PointerSense;
  foods: EdibleCode[];
  stimulus: SoundStimulus | null;
  chewing: boolean;
}

export interface BrainDecision {
  behaviour: Behaviour;
  control: BodyControl;
  targetFoodId: string | null;
}

export interface CreatureVitals {
  behaviour: Behaviour;
  hunger: number;
  energy: number;
  fear: number;
  curiosity: number;
  fatigue: number;
  gut: number;
}
