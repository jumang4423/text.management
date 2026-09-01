# bug_test

Portable Vite prototype for a living caterpillar inside a code editor.

The current configuration runs one creature. Its seed produces stable phenotype values for leg tempo, stride, lift, within-group foot order, stagger and turning curvature, with small per-step variation layered on top. `TEST_BUG_COUNT` in `src/bug/world.ts` can temporarily raise the population again for load testing.

## Run

```sh
npm install
npm run dev
```

## Architecture

- `src/bug/body.ts` — framework-independent soft body plus decentralized three-joint reflex legs.
- `src/bug/brain.ts` — continuous internal drives: hunger, energy, fear, curiosity, fatigue and gut.
- `src/bug/world.ts` — metabolism, chewing, digestion, droppings, sound/pointer stimuli and fixed-step loop.
- `src/bug/renderer.ts` — Canvas2D rendering only.
- `src/assets/bug-face.png` — transparent user-supplied face art, bundled by Vite.
- `src/adapters/codemirrorHabitat.ts` — the only CodeMirror-specific habitat/editing code.
- `src/main.ts` — demo shell and controls only.

The simulation uses document coordinates. Scrolling moves the camera rather than recomputing the creature. The adapter turns code ranges into food and owns reversible editor transactions, so the core can be ported to `text.management` without importing the demo UI.

## Locomotion test rig

The current test has a five-segment body: one transparent-PNG head and four white torso discs at 1.3 times the original torso radius, each with its own left/right limb pair. Each three-link limb is roughly 1.5 times longer than the earlier rig, increasing reach and stride without speeding up its articulation. The curved dashed arrow is the head's bounded-turn route. Landing targets remain fixed in world space but their `+` debug glyphs are hidden. Four alternating diagonal hands reach and plant while the other four support the body. The next group is released only after the active group's pull completes, so the alternation is event-driven rather than periodic.

The torso has no gait oscillator. Every appendage owns three limited rotational joints with angular velocity, spring stiffness and damping. Planted-hand reactions choose the route, while their varying force is normalised to one shared cruise magnitude. That keeps the body speed constant across reach, touchdown and pull instead of visibly surging once per step. The current demo cruise uses a `0.42` scale, maximum turn rate is `2 rad/s`, and the pointer follower stops inside a 72 px arrival radius (resuming outside 96 px). Each step gets small seeded variations in reach angle, stride, lift and joint rate; the four-hand support invariant remains deterministic.

Hands remain white in both contact and airborne states. There is no colour change or separate centre-dot contact marker.

At least one complete four-hand support group remains planted, so the body cannot enter the old free-floating state. Non-neighbouring torso discs have self-collision, each body joint has a maximum bend, and every limb target is clamped to a fixed forward/outward/radial workspace. The renderer is intentionally reduced to black lines, white joint discs and a faceless grey head until the contact mechanics are accepted.

The body records the head's actual travelled path. After the ordinary distance solver runs, each of the four rear discs is guided toward a progressively older point on that path and blended with a straight-chain target. This ordering makes the curve survive constraint solving: the front follows first, the tail follows last, and the five discs retain a shallow arc without collapsing into each other.

Entering the pointer arrival zone is a full pose hold. Heading, queued foot lifts, joint motors, elevation and gait timers stop together, so fixed world-space hands are not dragged toward a torso that keeps rotating. Leaving the hysteresis zone resumes the interrupted step from the held pose.

A stance hand obeys a strict world-space contact invariant: its rendered endpoint is exactly its touchdown anchor while anatomically reachable. The next step is requested early, foot staggering is bounded to the available reach time, and search fallback lands sooner. In the narrow emergency band from 78% to 90% reach, forward drive eases continuously to zero while another hand lands. Once enough support exists, the most overloaded hand releases and takes a new step. No body coordinate is snapped backward and the three links never grow like rubber.

Organic deformation is separate from locomotion. Respiration uses an asymmetric inhale/exhale cycle with a slight head-to-tail phase delay. Touchdown and support load drive an under-damped chain of five coupled tissue springs: local impact briefly shortens and widens a disc, then propagates into its neighbours and settles. This changes torso rest length and apparent volume only within narrow bounds; it never offsets a planted hand or adds a hidden translation oscillator.

Physics remains fixed-step, but the renderer snapshots every complete pose and interpolates torso positions, limb joints, radii and heading at display time. This removes the alternating held/moved frames seen on 120 Hz displays without changing gait speed. The interpolated creature is then drawn into a local one-third-resolution canvas, alpha/color hardened, and enlarged with nearest-neighbour sampling. Keeping that coarse raster local to the creature allows its jagged hand-drawn pixels to travel at subpixel world positions rather than quantising locomotion into whole-block jumps.

The transparent PNG is the complete head artwork rather than a decal over a generated oval. It is displayed at 1.3104 times the initial face scale, rotated 270 degrees relative to the body's heading, and placed 2 px toward the torso from the head node. Its white drawing rotates, breathes and passes through the same low-resolution hardening filter as the creature; no grey ellipse or synthetic outer ring is drawn behind it.

The implementation is deliberately isolated in `CaterpillarBody`: rendering consumes only the resulting joint points and contact state. That keeps the controller portable when this prototype moves into the Electron editor.

## Safety modes

- `PET`: the caterpillar chews visually but does not edit source.
- `NIBBLE`: it removes complete edible units (mini-notation tokens, numeric modifiers, comments). Every bite is one CodeMirror transaction and can be undone. Clicking a dropping restores the swallowed text near its original line/column.
