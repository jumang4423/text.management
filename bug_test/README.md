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
- `src/bug/brain.ts` — one hunger value plus an explicit rest/roam/eat/flee state machine.
- `src/bug/world.ts` — chewing, digestion, droppings, pointer proximity and the fixed-step loop.
- `src/bug/renderer.ts` — Canvas2D rendering only.
- `src/assets/bug-face.png` — transparent user-supplied face art, bundled by Vite.
- `src/adapters/codemirrorHabitat.ts` — the only CodeMirror-specific habitat/editing code.
- `src/main.ts` — demo shell and controls only.

The simulation uses document coordinates. Scrolling moves the camera rather than recomputing the creature. The adapter turns code ranges into food and owns reversible editor transactions, so the core can be ported to `text.management` without importing the demo UI.

## Locomotion test rig

The current test has a five-segment body: one transparent-PNG head and four white torso discs at 1.3 times the original torso radius, each with its own left/right limb pair. Each three-link limb is roughly 1.5 times longer than the earlier rig, increasing reach and stride without speeding up its articulation. The bounded-turn route stays in the controller, but its direction arrow, route line and food-pursuit line are hidden. Landing targets remain fixed in world space but their `+` debug glyphs are hidden. Four alternating diagonal hands reach and plant while the other four support the body. The next group is released only after the active group's pull completes, so the alternation is event-driven rather than periodic.

The torso has no gait oscillator. Every appendage owns three limited rotational joints with angular velocity, spring stiffness and damping. Planted-hand reactions choose the route, while their varying force is normalised to one shared cruise magnitude. That keeps the body speed constant across reach, touchdown and pull instead of visibly surging once per step. The current demo cruise uses a `0.42` scale and maximum turn rate is `2 rad/s`. Each step gets small seeded variations in reach angle, stride, lift and joint rate; the four-hand support invariant remains deterministic.

Hands remain white in both contact and airborne states. There is no colour change or separate centre-dot contact marker. Their radius and circular silhouette are unchanged; only a tiny seeded contour distortion is applied.

At least one complete four-hand support group remains planted, so the body cannot enter the old free-floating state. Non-neighbouring torso discs have self-collision, each body joint has a maximum bend, and every limb target is clamped to a fixed forward/outward/radial workspace. The renderer is intentionally reduced to black lines, white joint discs and a faceless grey head until the contact mechanics are accepted.

The body records the head's actual travelled path. After the ordinary distance solver runs, each of the four rear discs is guided toward a progressively older point on that path and blended with a straight-chain target. This ordering makes the curve survive constraint solving: the front follows first, the tail follows last, and the five discs retain a shallow arc without collapsing into each other.

Autonomous behaviour is a literal life loop: rest for a seeded random 2–8 seconds, choose one random point inside the currently visible editor viewport, walk there, then rest again. Hunger is the only displayed/internal drive; at `0.78` it interrupts that loop and selects the nearest edible code unit. A pointer closer than 180 px has highest priority and triggers a fast panic run that continues until the animal is 460 px away, after which it starts a fresh rest. Pointer presence outside that danger zone does not alter the autonomous loop.

A stance hand obeys a strict world-space contact invariant: its rendered endpoint is exactly its touchdown anchor while anatomically reachable. The next step is requested early, foot staggering is bounded to the available reach time, and search fallback lands sooner. In the narrow emergency band from 78% to 90% reach, forward drive eases continuously to zero while another hand lands. Once enough support exists, the most overloaded hand releases and takes a new step. No body coordinate is snapped backward and the three links never grow like rubber.

Organic deformation is separate from locomotion. Respiration uses an asymmetric inhale/exhale cycle with a slight head-to-tail phase delay. Touchdown and support load drive an under-damped chain of five coupled tissue springs: local impact briefly shortens and widens a disc, then propagates into its neighbours and settles. Rear discs are progressively softer and less damped, giving the tail a delayed spring response. This changes torso rest length and apparent volume only within narrow bounds; it never offsets a planted hand or adds a hidden translation oscillator.

Chewing temporarily stops locomotion and excites a faster asymmetric wave through those same tissue springs, with a phase offset for each torso disc. All five rendered body nodes also receive a head-to-tail delayed axial/sideways offset. Limb roots follow that offset with decreasing influence toward each hand, while planted hands remain visually fixed, so the complete body participates without sliding on the ground. The face uses the chew progress as a separate envelope for five exaggerated bites: roughly 0.62–1.38× uniform image scaling, additional directional squash, large forward/sideways bobs and rotation. It therefore moves much more strongly than the torso while still easing to rest when the bite finishes.

The CodeMirror adapter marks only the range currently inside the mouth. That range answers each bite with a coarse two-step squeeze and one-pixel shake; starting or stopping a bite is the only time an editor transaction is dispatched. All alphabet particles are intentionally absent during chewing, after eating and when restoring matter. A larger tail-less white cloud floats roughly 80–90 px away from the face for the duration of chewing, with only 🎵 centred inside. Pointer-triggered fleeing has highest visual priority and replaces its contents with 💢; the anger cloud remains for two seconds after danger clears. The complete cloud and native emoji are rendered together at one-third resolution, alpha-hardened, colour-quantised and enlarged without interpolation so both share the creature's blocky bit aesthetic.

When digestion finishes, the creature samples 36 visible toilet candidates and walks toward the candidate whose predicted tail position is farthest from existing droppings. It stops on arrival and performs a 1.15-second rear-end shimmy: the tail swings about 15 px, rear tissue compresses, rear leg roots follow, planted hands remain fixed, and the face cloud contains 💨. It then rechecks the real animated tail position; anything within 96 px causes a new toilet search instead of another poop in the same place. The native 💩 emoji emerges from the final torso segment and remains completely fixed. Hovering it opens a large bit-rendered fluffy cloud containing `POOP OF …` and the original code; clicking it restores that swallowed code. Hunger now rises at `0.032/s`, about twice the previous rate and almost six times the original prototype rate.

Food pursuit measures distance to the nearest point on the code rectangle rather than chasing the centre of a long token. It remains full-speed at distance but slows continuously inside the final 160 px, and direct pursuit temporarily bypasses the wide anticipatory edge buffer while retaining hard document bounds. A near-target progress watchdog ends any residual orbit after 1.25 seconds, so edge-adjacent code cannot produce an infinite one-sided turn.

Physics remains fixed-step, but the renderer snapshots every complete pose and interpolates torso positions, limb joints, radii and heading at display time. This removes the alternating held/moved frames seen on 120 Hz displays without changing gait speed. Rendering is ordered as far legs, near-leg attachments, torso, the remaining near-leg links and face. The torso therefore masks only the near hip and first-link overlap instead of letting the hip disc cut into its foreground. Torso, joint and hand circles retain their original dimensions while using small seeded outline distortions that never change between frames. The interpolated creature is then drawn into a local one-third-resolution canvas, alpha/color hardened, and enlarged with nearest-neighbour sampling. Keeping that coarse raster local to the creature allows its jagged hand-drawn pixels to travel at subpixel world positions rather than quantising locomotion into whole-block jumps.

The transparent PNG is the complete head artwork rather than a decal over a generated oval. It is displayed at 1.3104 times the initial face scale, rotated 270 degrees relative to the body's heading, and placed 2 px toward the torso from the head node. Its white drawing rotates, breathes and passes through the same low-resolution hardening filter as the creature; no grey ellipse or synthetic outer ring is drawn behind it.

The implementation is deliberately isolated in `CaterpillarBody`: rendering consumes only the resulting joint points and contact state. That keeps the controller portable when this prototype moves into the Electron editor.

## Safety modes

- `PET`: the caterpillar chews visually but does not edit source.
- `NIBBLE`: it removes complete edible units (mini-notation tokens, numeric modifiers, comments). Every bite is one CodeMirror transaction and can be undone. Clicking a dropping restores the swallowed text near its original line/column.
