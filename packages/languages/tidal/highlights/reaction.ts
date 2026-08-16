import { dampedSpringImpulse, restingSpring } from "@core/animation/spring";

import {
  highlightReactionDurationMs,
  TimestampedHighlightEvent,
} from "./state";

const textSpring = { stiffness: 1050, damping: 16.5 };
const characterStaggerMs = 4;

export const tidalReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
);

export function springDirection({
  miniID,
  from,
  to,
  cycle,
}: Pick<TimestampedHighlightEvent, "miniID" | "from" | "to" | "cycle">) {
  // Stable for one musical event, but changes unpredictably between hits.
  let hash = Math.imul(miniID + 1, 73_856_093);
  hash ^= Math.imul(from + 1, 19_349_663);
  hash ^= Math.imul(to + 1, 83_492_791);
  hash ^= Math.imul(Math.round(cycle * 1_024) + 1, 1_597_334_677);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2_246_822_519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3_266_489_917);
  hash ^= hash >>> 16;
  return hash & 1 ? 1 : -1;
}

export function reactionIntensity(surprise: number) {
  return Math.pow(Math.min(1, Math.max(0, surprise)), 1.1);
}

export function textReactionMotion(
  highlight: TimestampedHighlightEvent,
  now: number,
  characterIndex: number,
  scaleRange = 1
) {
  const age = Math.max(0, now - highlight.time);
  if (age >= highlightReactionDurationMs) {
    return { transform: "none", textShadow: "none" };
  }

  const springAge = age - Math.min(12, characterIndex) * characterStaggerMs;
  const spring =
    springAge < 0
      ? restingSpring
      : dampedSpringImpulse(springAge, textSpring);
  const intensity = reactionIntensity(highlight.surprise);
  const direction = springDirection(highlight);
  const displacement = spring.displacement * intensity;
  const speed = Math.min(1.2, Math.abs(spring.velocity)) * intensity;
  const horizontal = displacement * direction * 4.2;
  const verticalTravel =
    displacement >= 0 ? displacement * 9 : displacement * 3.8;
  const vertical = -verticalTravel + speed * 1.8;
  const rotation = displacement * direction * 4;
  const scaleX = Math.max(
    0.16,
    1 + (speed * 0.24 - displacement * 0.06) * scaleRange
  );
  const scaleY = Math.max(
    0.16,
    1 + (-speed * 0.32 + displacement * 0.11) * scaleRange
  );
  const shadow = spring.energy * intensity * 2.4;

  return {
    transform: `translate(${horizontal.toFixed(3)}px, ${vertical.toFixed(3)}px) rotate(${rotation.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`,
    textShadow: `${(-direction * shadow).toFixed(3)}px 0 GREEN, ${(direction * shadow).toFixed(3)}px 0 #D4F357`,
  };
}
