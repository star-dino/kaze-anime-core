---
name: anime-core-director
description: >-
  Directing, modeling, sky/lighting design, and visual QA workflow for anime-core films.
  Activate this skill whenever creating or modifying a film in src/films/, designing characters
  or mecha poses, building skies/clouds/weather, or reviewing rendered contact sheets.
---

# anime-core Director & Visual Production Guide

Follow these proven production rules (distilled from *Star Shard* and the 100s film *The Cape Wind-Keeper*) to avoid common visual artifacts, clipping, and composition failures.

## 1. Heavy Mecha Modeling & Staging Rules (`kit.js` & `nagi.js`)

1. **Panel Edge Weathering (`aEdge`)**:
   - Large flat or slightly twisted trapezoid armor panels must have `aEdge = 0` across their interior 82% (connected-component clustering across non-creased edges `fn1·fn2 >= cos(crease)`). Paint chips and rust (`weather.edge: true`) must only appear along sharp structural creases, never as random speckles across flat shin/forearm plates.
2. **Elevated Seat / Perch to Prevent Self-Collision & Sightline Blocking**:
   - Never seat a thick, blocky mecha directly on flat ground (`hy` too low): raised knees will collide with the chest/skirt armor and block the camera or the mecha's own lens (`@lens`) from seeing foreground subjects on the ground.
   - Seat the mecha on a **2.0–2.5 m elevated rock ledge/plinth** so the thighs slope naturally downward (`> 3 m` torso-to-thigh clearance).
   - Rest the idle hand on the outer ledge rather than on top of the knee to keep the `@lens ↔ subject` sightline corridor 100% clear.
3. **Forearm Eave Over Deep Waist Bends**:
   - When a giant robot shelters a small ground object, extend the **forearm and palm horizontally (`~2.5–3.0 m` above the subject) as a cantilevered roof** instead of bending the entire upper torso deeply over its knees.
4. **Heavy Mechanical Timing (`easeHeavy`)**:
   - Giant mecha limb raises, extensions, and retractions require **4.0–4.6 seconds** per move using `easeHeavy` / `heavyAct(t, [t0, t1], { prep, damp })` from `core/util.js` (5th-order ease + optional anticipation and hydraulic settle), evaluated on twos (`onTwos(t)`). Never use 1-second snappy transitions.

## 2. Sky Dome, Storm Clouds & Sun Shafts (`sky_storm.js` & `palette.js`)

1. **No Flat Billboard Cloud Quads (`CloudBank`) or Horizon Cutoffs (`StormVeil`)**:
   - Camera-facing billboard circles produce obvious paper-disc edges and Z-sorting pops in mid/close shots; flat storm planes create a harsh black horizontal line across the sea.
   - Always render clouds inside the **unified 360° `skyDome` shader** (`core/clouds.js`: `skyDome({ towers: [cloudTower(rng, {...})] }, { rays, remnant, uniforms })`; `CloudBank` has been deleted) combining:
     - High-altitude warped FBM cirrus wisps;
     - Polynomial `smooth-union` billow cumulus towers (with `fwidth` anti-aliasing, 3-step cel shading, and inter-puff crease darkening);
     - Continuous gouache overcast transitions (`uOvercast`) that blend smoothly into horizon fog.
2. **Pre-Integrated Cloud & Anemometer Phase**:
   - Never compute moving phase as `t * speed(t)`. Pre-integrate `rate(t)` at fixed `DT = 1/240s` steps at module load and interpolate so speed changes never cause clouds, grass waves, or spinning cups to jump or reverse.
3. **Single-Sided Slanted Sunbeams Over 360° Pinwheel Shafts**:
   - When the sun is inside or near the viewport, never use the default `shaftStyle: 'radial'` (its polar-angle `vnoise(ang * 30 / 80)` creates a cheap 360° wagon-wheel artifact). Use look `shaftStyle: 'slanted'` (low-frequency parallel beams, downstream only, modulated by the sky dome's cloud occlusion) or the dome's own `uSideRays`.
   - Instead, render **2–3 wide, soft, single-sided diagonal sunbeams (`uSideRays`)** in the sky shader along a slanted sky-dome coordinate (`diag = (az - sunAz) * cos + (el - sunEl) * sin`).
4. **High-Speed Spinning Props**:
   - Never use opaque `celMaterial({ mapCut: true })` to draw motion-blur discs in the main MRT pass (they render as solid 3D pipes with outlines). Keep the real 3D cups/blades spinning at pre-integrated angles and add semi-transparent motion arcs with `MotionArcBatch.blur({ center, axis, rInner, rOuter, angle, omega, blades })` from `core/fx.js` (overlay, premultiplied alpha, fades in with angular speed) and/or airflow streaks via `LineBatch`.
5. **Weather Toolkit (all opt-in, all pure functions of `t`)**:
   - Anything whose speed changes over time (cup angle, grass-wave phase, cloud-shadow offset) → `integral(rate, { t0, t1 })` from `core/secondary.js`; wind-driven springs → `windDrive(wind, k, { seed })`.
   - Wind debris (grass bits, sand, petals) → `FleckBatch` + `emitStream` / `dustBurst` (`core/fx.js`). Moving cloud shadows → look `cloudShadow`. Paper / grain / vignette → look `paper`, `grain`, `vignette`.
   - Rain on things → `WaterStrokeBatch` + `eaveCurtain` / `rainSplashes` / `fallingDrop` / `splashCrown` / `armorMist` (`core/rain.js`); approaching storm wall → `RainCurtain` + `RainCurtain.nearRain(dist)` smooth handoff to `RainField`; rain rings on sea & puddles → look `rainRings: { amount, scale }` (explicit opt-in, separate from `look.rain`); wet-ground sky-reflecting puddles → `paintMaterial({ puddles: true })` / `meadowGround(size, fn, { puddles: true })` + look `puddles: { amount, scale }`; wet armor → `celMaterial({ wet, wetRain })`; rain on glass → `GLASS_GLSL` `glassWater()` in a pattern; backlit petals → `celMaterial({ transmit })`; thinner panel lines → `celMaterial({ inkWeight })`.
   - Ink color / weight are a **global table keyed by material id**: never reuse an id across departments with different `ink` / `inkWeight`.

## 3. Narrative Pacing & Mandatory Visual QA Loop

1. **Pre-Storm Build-Up & Blackout Transitions**:
   - Build weather organically: breeze on grass → anemometer accelerating → barograph needle scratching → gust bending the flower → sparse large `FIRST_DROPS` pattering into a puddle → shelter extension → full downpour.
   - For major time/weather jumps (storm night to sunny dawn), use a **smooth fade-to-black (`~2.0s`) + silent black hold (`~1.0s`) + slow fade-in (`~2.4s`)** rather than an abrupt hard cut.
2. **Mandatory Multimodal Inspection**:
   - Run `node tools/check.mjs` and `node tools/probe.mjs` to verify anchor positions and sightlines. For heavy mecha, add `rig.addCollider(...)` to chest / skirts / thighs / knees and run the automatic inspection: `node tools/probe.mjs --dept <dept> --check-cam @lens,flower.head --check-sight @lens>flower.head --collide` (checks first / mid / last frame of every shot, reports the occluding part, exit code 1 on issues).
   - Render a contact sheet (`node tools/snap.mjs --scale 1 --sheet review ...`) and **visually inspect the generated `.jpg` with `read_file`** before running full video renders.
