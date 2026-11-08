---
name: anime-core-audio
description: >-
  Procedural soundtrack composition and natural foley synthesis in pure JavaScript (48 kHz).
  Activate this skill whenever creating or modifying score.js, dsp.js, or soundtrack.js,
  or when fixing harsh audio, rain/water sound effects, or musical climax arcs.
---

# anime-core Procedural Audio & Symphonic Score Guide

All audio in `anime-core` is synthesized deterministically sample-by-sample in pure JavaScript (`48 kHz` stereo) so every render of `soundtrack.wav` is bit-identical. Follow these rules to achieve a warm, cinematic anime soundtrack and natural foley.

## 1. Anti-Fatigue Rule: Never Abuse `ping()` / `CELESTA` / `GLOCK`

The minimal modal synthesizer `ping()` in `src/audio/dsp.js` uses a 64-sample (`1.3 ms`) hard linear attack and undamped high-frequency sine partials (`GLOCK` ratios `1 : 2.756 : 5.404 : 8.933`).
- **DO NOT** use `ping()` / `METAL_TAP` to simulate rain hitting metal or ground (random high-MIDI sine pings at 10–25 hits/sec sound like a hammer frantically striking out-of-tune wind chimes in the ear-fatiguing `3–10 kHz` band).
- **DO NOT** play raindrops (`FIRST_DROPS`) as a musical scale on `MARIMBA` / `DROPLET` (turns natural nature foley into a robotic music-box scale).
- **DO NOT** write full-length melodies exclusively in `C5–C7` with `CELESTA` + `GLOCK` double-pings.
- If you genuinely need a struck / bell tone, soften it: `ping(note, vel, partials, dur, seed, { attackMs: 10, maxHz: 2600, lpCut: 2400, lpDecay: 0.25 })` (cosine attack, drop partials above `maxHz`, low-pass that darkens after the strike). Without the 6th argument `ping()` is bit-identical to the old version.

## 2. Warm Symphonic Voices (Pure-JS Synthesis Recipes)

Use these warm, expressive voices — standard exports of `src/audio/dsp.js` (`import { sing, celloHorn, warmHarp, warmTimpani, airSwell, softDrop } from '../../audio/dsp.js'`); full usage in `src/films/cape-keeper/score.js`:

1. **Lyrical Woodwind / Ocarina Lead (`sing(note, hold, vel, opts)`)**:
   - **Register**: `C4–G5`.
   - **Envelope**: Slow cosine fade-in (`0.18–0.36 s` — zero percussive click!), mid-note arch swell, exponential release.
   - **Timbre**: Fundamental + soft 2nd/3rd harmonics (`0.76, 0.18, 0.06`) + delayed `4.6 Hz` vibrato + subtle band-passed pink-noise breath (`0.03`), routed through an `SVF` low-pass (`1050–1700 Hz`) that opens with the phrase arch.
2. **Warm Cello & French Horn Ensemble (`celloHorn(note, hold, vel, opts)`)**:
   - **Register**: `F2–E4` (counter-melody, protective storm swells, and octave doubling under the climax lead).
   - **Timbre**: 3 slightly detuned (`[-5, 0, +5] cents`) PolyBLEP sawtooth waves (`55%`) + pure fundamental sine (`45%`) for warm chest resonance, filtered through an `SVF` low-pass whose cutoff swells dynamically with the phrase arch (`f0 * 2.0 → f0 * 4.8`).
3. **Soft Finger-Pad Harp / Nylon Pluck (`warmHarp(note, dur, vel, seed)`)**:
   - **Timbre**: Integer harmonic series (`[1, 1.0], [2, 0.34], [3, 0.10], [4, 0.03]`) with **partials above `2600 Hz` strictly omitted**, shaped by a **14 ms (`672 samples`) cosine finger-pad soft attack** and an exponentially darkening `SVF` low-pass filter. Provides lush arpeggio motion during dawn and climax sections with zero metallic clink.
4. **Felt Timpani & Air Swell (`warmTimpani` & `airSwell`)**:
   - `airSwell`: Band-passed pink noise sweeping `420 → 1770 Hz` over `3.2–3.6 s` to build pre-climax tension.
   - `warmTimpani`: `Bb1 / C2 / F1` (`43–65 Hz`) with a `28 ms` felt-mallet attack and low-passed body resonance to anchor climax downbeats.

## 3. Natural Non-Pitched Foley Recipes

- **Rain on Canopy / Armor**: Layer a continuous low-mid pink-noise patter (`SVF` around `360–580 Hz`) under the main rain curtain, and apply a smooth low-pass muffle envelope (`eaveMuffle`) when the camera moves under the shelter.
- **Individual Water Drops (`softDrop(kind, vel, seed)`)**: Combine a `4 ms` attack / fast-decay (`exp(-t * 38)`) low-passed pink-noise pat (`540–820 Hz`) with a tiny, ultra-short (`55 ms`) low-frequency micro-bubble (`240 → 330 Hz` sine at `0.18` weight). Sounds like real water hitting rock or a puddle without any pitched ring.

## 4. Multi-Act Dynamic Arc (`~11 dB` Contrast)

To make a climax truly land, design clear dynamic headroom across acts (verified with `ffmpeg -af volumedetect`):
1. **Act 1 (Serene Opening)**: Keep pad velocities (`0.36–0.40`) and low-pass cutoffs (`1050–1150 Hz`) intimate (`mean_volume ≈ -26 dB`).
2. **Act 3 (Protective Storm Swell)**: Introduce `celloHorn` counter-melody (`mean_volume ≈ -21.5 dB`), followed by **complete silence (`silenceEnv = 0`)** during the blackout transition (`~2–3 s`).
3. **Act 4 (Pre-Climax Build → Full Bloom Climax)**:
   - Build gradually from dawn awakening (`Bbmaj9`) through a dominant `C7sus4` climb + `airSwell`;
   - Insert a brief `0.35 s` breath dip (`preClimaxBreath`) on the trigger cue (`C.lastDrop`);
   - Unleash the **Full Climax (`mean_volume ≈ -15.3 dB`, `max_volume = -1.5 dB`)**: `warmTimpani` downbeat + 7-voice wide stereo pad (`cut: 2750 Hz`) + octave-doubled `sing` (high lead) & `celloHorn` (low lead) + stereo `warmHarp` arpeggio waves, before resolving gently into the sunset coda.

## 5. Cross-Platform Deterministic Convolution Reverb (`reverb: 'js'`)

- For legacy films (`star`, `cape-keeper`), `soundtrack.js` defaults to `reverb: 'webaudio'` (`OfflineAudioContext` + `ConvolverNode`) to preserve historical SHA1 baselines.
- For all new films, set `audio: { reverb: 'js' }` on the story object (or pass `?reverb=js` / `node tools/render-audio.mjs --reverb js`). This runs `makeIRData()` + `convolveStereo()` in `src/audio/dsp.js` (pure-JS float64 radix-2 FFT overlap-add convolution, `PSNR ≈ 124 dB` vs WebAudio), guaranteeing bit-identical WAV output across any OS, CPU architecture, or browser build without even needing `OfflineAudioContext` for offline rendering.
