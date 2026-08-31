export interface DampedSpringOptions {
  stiffness: number;
  damping: number;
}

export interface DampedSpringSample {
  displacement: number;
  velocity: number;
  energy: number;
}

export const restingSpring: DampedSpringSample = {
  displacement: 0,
  velocity: 0,
  energy: 0,
};

// Unit step response for the same spring model. Unlike the impulse helper
// below, this starts at 0 and settles at 1, so it can drive transitions while
// retaining the same overshoot frequency and damping as reaction animations.
export function dampedSpringStep(
  elapsedMs: number,
  { stiffness, damping }: DampedSpringOptions
) {
  const elapsed = Math.max(0, elapsedMs) / 1_000;
  const halfDamping = damping / 2;
  const dampedFrequencySquared = stiffness - halfDamping * halfDamping;

  if (dampedFrequencySquared > 0.000001) {
    const frequency = Math.sqrt(dampedFrequencySquared);
    const envelope = Math.exp(-halfDamping * elapsed);
    return (
      1 -
      envelope *
        (Math.cos(frequency * elapsed) +
          (halfDamping / frequency) * Math.sin(frequency * elapsed))
    );
  }

  if (Math.abs(dampedFrequencySquared) <= 0.000001) {
    const envelope = Math.exp(-halfDamping * elapsed);
    return 1 - envelope * (1 + halfDamping * elapsed);
  }

  const root = Math.sqrt(-dampedFrequencySquared);
  const firstRate = -halfDamping + root;
  const secondRate = -halfDamping - root;
  const displacement =
    (-secondRate * Math.exp(firstRate * elapsed) +
      firstRate * Math.exp(secondRate * elapsed)) /
    (firstRate - secondRate);
  return 1 - displacement;
}

// Unit-mass, underdamped spring kicked from rest. Displacement is normalized so
// the first overshoot reaches 1, while velocity is normalized to 1 at impact.
// Keeping both values lets callers tie squash/stretch to speed instead of
// running unrelated easing curves for position and shape.
export function dampedSpringImpulse(
  elapsedMs: number,
  { stiffness, damping }: DampedSpringOptions
): DampedSpringSample {
  const elapsed = Math.max(0, elapsedMs) / 1_000;
  const halfDamping = damping / 2;
  const dampedFrequencySquared = stiffness - halfDamping * halfDamping;

  if (dampedFrequencySquared <= 0) {
    const rate = Math.max(0.001, halfDamping);
    const peakTime = 1 / rate;
    const peak = peakTime * Math.exp(-rate * peakTime);
    const envelope = Math.exp(-rate * elapsed);
    return {
      displacement: (elapsed * envelope) / peak,
      velocity: envelope * (1 - rate * elapsed),
      energy: envelope,
    };
  }

  const frequency = Math.sqrt(dampedFrequencySquared);
  const peakTime = Math.atan2(frequency, halfDamping) / frequency;
  const peak =
    Math.exp(-halfDamping * peakTime) * Math.sin(frequency * peakTime);
  const envelope = Math.exp(-halfDamping * elapsed);
  const phase = frequency * elapsed;
  return {
    displacement: (envelope * Math.sin(phase)) / peak,
    velocity:
      (envelope *
        (frequency * Math.cos(phase) - halfDamping * Math.sin(phase))) /
      frequency,
    energy: envelope,
  };
}

export function dampedSpringKeyframes(
  durationMs: number,
  options: DampedSpringOptions,
  render: (
    sample: DampedSpringSample,
    progress: number,
    elapsedMs: number
  ) => Keyframe,
  frameCount = 48
): Keyframe[] {
  const lastFrame = Math.max(12, frameCount);
  return Array.from({ length: lastFrame + 1 }, (_, index) => {
    const progress = index / lastFrame;
    const elapsedMs = progress * durationMs;
    const sample =
      index === lastFrame
        ? restingSpring
        : dampedSpringImpulse(elapsedMs, options);
    return {
      ...render(sample, progress, elapsedMs),
      offset: progress,
    };
  });
}
