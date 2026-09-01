export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TAU = Math.PI * 2;

export function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

export function lerpVec(from: Vec2, to: Vec2, amount: number): Vec2 {
  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
  };
}

export function add(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x + right.x, y: left.y + right.y };
}

export function subtract(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x - right.x, y: left.y - right.y };
}

export function scale(vector: Vec2, amount: number): Vec2 {
  return { x: vector.x * amount, y: vector.y * amount };
}

export function magnitude(vector: Vec2) {
  return Math.hypot(vector.x, vector.y);
}

export function distance(left: Vec2, right: Vec2) {
  return magnitude(subtract(left, right));
}

export function normalize(vector: Vec2, fallback: Vec2 = { x: 1, y: 0 }): Vec2 {
  const length = magnitude(vector);
  return length > 0.00001 ? scale(vector, 1 / length) : { ...fallback };
}

export function perpendicular(vector: Vec2): Vec2 {
  return { x: -vector.y, y: vector.x };
}

export function centerOf(rect: Rect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function smoothstep(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

export function exponentialApproach(rate: number, deltaSeconds: number) {
  return 1 - Math.exp(-rate * deltaSeconds);
}

export function wrapAngle(angle: number) {
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

export function approachAngle(
  current: number,
  target: number,
  amount: number
) {
  return current + wrapAngle(target - current) * clamp(amount);
}

export function pointInsideRect(point: Vec2, rect: Rect, padding = 0) {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

export class Random {
  private state: number;

  constructor(seed = 0x51f15e) {
    this.state = seed >>> 0;
  }

  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  between(minimum: number, maximum: number) {
    return lerp(minimum, maximum, this.next());
  }

  signed() {
    return this.next() * 2 - 1;
  }

  pick<T>(items: readonly T[]) {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }
}
