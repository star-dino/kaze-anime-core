# AGENTS.md — anime-core Project Rules

`anime-core` is a pure-code procedural Japanese anime short-film engine built on Three.js (WebGL2), a 10-pass cel + painterly GLSL pipeline, pure-function timelines, and sample-by-sample procedural JS audio synthesis.

## 1. Directory & Ownership Boundaries

| Path | Purpose | Rule |
|---|---|---|
| `src/core/` | Story-agnostic engine (MRT, shaders, modeling, look, rain) | **Do not modify** when building a film; preserve pixel-exact baseline on `story/` (`star`) and `_coretest`. |
| `src/audio/` | Procedural DSP & offline soundtrack renderer | Keep existing `dsp.js` exports backward-compatible. |
| `src/story/` | 8s reference demo film (*星のかけら / Star Shard*) | Read-only reference; frame 151 SHA1 must stay `77d7bd9f9f92` under SwiftShader. |
| `src/films/<name>/` | Individual films (e.g., `cape-keeper`) | Place only film code (`*.js`) and public `storyboard.md` here. Never put render outputs or WIP logs in `src/`. |
| `docs/` | Public engine documentation (`01`–`11`) | Keep clean and public-ready (no machine-local paths or private logs). |
| `out/` & `dist/` | Rendered WAV/MP4/snaps and single-file HTML players | Ignored by git; 100% regenerable from `src/`. |

## 2. Seven Non-Negotiable Iron Laws

1. **Deterministic Pure-Function Time `f(t)`**: Never use `Math.random`, `Date.now`, or `performance.now` in `src/`. Never accumulate state across frames (`x += v`). Every frame must be a pure function of `t` (use `new Rng(seed)`, `hash()`, `core/secondary.js`, or pre-integrated lookup tables).
2. **Frame Stepping**: Pass character acting time through `onTwos(t)` (12 fps) and water/energy effects through `onThrees(t)` (8 fps).
3. **WYSIWYG Palette Conversion**: Always wrap character design hex colors with `screenAll({...})` (`core/color.js`) so post-grading output matches the intended hex color.
4. **MRT Material `id` Protocol**: `id = 0` for painterly background (Kuwahara brush, no ink outline); `id = 1..99` for cel-shaded characters (automatic ink outline at `id`/depth/normal discontinuities); `id >= 100` for un-outlined cel surfaces.
5. **Seamless Shot Continuity**: `shots[i].start === shots[i - 1].end`, and the final shot's `end === story.duration`. All timings must reference `CUES` rather than hardcoded timestamps.
6. **Hard-Surface Protagonists**: Use `kit.js` convex hulls/cboxes (`Rig`) for main mecha/prop characters. `SoftBody` (`organic.js`) is only for small side characters or distant creatures.
7. **Visual & Audio Self-Review Loop**: Never ship code changes blindly. After modifying geometry, animation, shaders, or audio, run the verification commands below and inspect contact sheets / audio dynamics.

## 3. Standard Toolchain Commands

```bash
# 1. Load & console warning/error check (must print ready: true and no errors)
STORY=<name> node tools/check.mjs 60

# 2. Anchor probe + automatic sightline / self-clipping inspection (every shot's first / mid / last frame)
STORY=<name> node tools/probe.mjs --dept <dept> --t 10,20,30
STORY=<name> node tools/probe.mjs --dept <dept> --check-cam @lens --check-sight @lens>flower.head --collide

# 3. Render review contact sheet -> out/<name>/snaps/
STORY=<name> node tools/snap.mjs --scale 1 --sheet review s:shot1@0.5 s:shot2@0.5

# 4. Verify pure-function determinism
STORY=<name> node tools/determinism.mjs 36 100 160

# 5. Render procedural soundtrack & full film (prefix GPU=1 for GPU preview / final renders; never for baseline hashes)
STORY=<name> node tools/render-audio.mjs --name <name>
STORY=<name> node tools/render.mjs --name <name>
node tools/build-player.mjs --video out/<name>/<name>.mp4 --out dist/<name>.html --title "<Title>"
```

## 4. Specialized Skills

When working on film direction, mecha/sky modeling, or procedural audio synthesis, load the workspace skills in `.agents/skills/`:
- **`anime-core-director`** (`.agents/skills/anime-core-director/SKILL.md`): Storyboard contracts, heavy-mecha anti-clipping & sightline rules, 360° painterly sky dome, and visual review workflow.
- **`anime-core-audio`** (`.agents/skills/anime-core-audio/SKILL.md`): Avoiding harsh metallic `ping` fatigue, synthesizing natural rain/water foley, and building multi-act orchestral climax arcs.
