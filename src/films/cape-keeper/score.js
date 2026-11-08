// 《海岬的测风人》配乐与音效（100 秒 / 15 镜：悠然海岬 + 破晓盛放交响高潮）
// 纯 JS 逐采样确定性合成：
//   - 前半场保持悠然温润的海岸呼吸感（零高频金属“叮叮”声）；
//   - 第三幕伸臂挡雨加入温暖大提琴/圆号守护低音；
//   - 71.2–74.4 s 黑场彻底静默蓄力；
//   - 第四幕随斜阳与收臂层层推进，在 88.8 s 白花盛放处爆发温暖宽广的弦乐+圆号+木管八度齐奏与竖琴流动琶音高潮。
import { SR, TAU, mtof, nm, put, SVF, Noise, pad, sing, celloHorn, warmHarp, warmTimpani, airSwell, softDrop } from '../../audio/dsp.js';
// 温暖声部 sing / celloHorn / warmHarp / warmTimpani / airSwell / softDrop 已下沉到 src/audio/dsp.js（C7）。
import { Rng, clamp, smooth, invLerp } from '../../core/util.js';
import { wind, rain, FIRST_DROPS } from './weather.js';


export function buildScore(C, dur, music, sfx) {
  const report = [];
  const cue = (t, label) => report.push([+t.toFixed(3), label]);
  let seed = 300;
  const S = () => ++seed;
  const end = dur - 0.3;

  // 黑场转场静音包络：71.2 → 73.1 s 平滑归于寂静，73.1 → 74.4 s 彻底留白静默，74.4 → 76.2 s 随晨光缓缓苏醒
  const silenceEnv = (t) => {
    if (t >= C.blackOut[0] && t <= C.blackIn[1]) {
      if (t < C.blackOut[1]) return 1 - smooth(invLerp(C.blackOut[0], C.blackOut[1] - 0.1, t));
      if (t < C.blackIn[0] + 0.4) return 0;
      return smooth(invLerp(C.blackIn[0] + 0.4, C.blackIn[1], t));
    }
    return 1;
  };

  // s10_under_eave（60.0 – 67.5 s）：在宽大右前臂屋檐下，外部风雨高频稍敛、更显小角落温暖静谧
  const eaveMuffle = (t) => 1 - 0.52 * smooth(invLerp(59.8, 60.8, t)) * (1 - smooth(invLerp(67.0, 67.8, t)));

  // ================================================================
  // 1. 音乐轨（Music Bus）：从悠然海岸 → 风雨守护 → 黑场静默 → 破晓盛放交响高潮
  // ================================================================
  const chords = [
    // 第一幕（0 – 28s）：轻柔克制的夏日海岬与慢动作扶花（留出充足动态余量给第四幕高潮）
    [0.5,  8.6,  ['F2', 'C3', 'A3', 'C4', 'E4'],               0.36, 1050],
    [8.6,  15.2, ['Bb2', 'F3', 'A3', 'D4', 'F4'],              0.38, 1100],
    [15.2, 22.5, ['F2', 'C3', 'A3', 'C4', 'G4'],               0.40, 1150],
    [22.5, 28.2, ['C2', 'G2', 'E3', 'G3', 'C4', 'E4'],         0.38, 1080],

    // 第二幕（28.2 – 52.0s）：起风、风杯急转、初雨慢落（柔和自然小调，低音渐沉）
    [28.2, 35.5, ['D2', 'A2', 'F3', 'A3', 'C4'],               0.38, 1000],
    [35.5, 43.0, ['Bb1', 'F2', 'D3', 'A3', 'C4'],              0.38, 940],
    [43.0, 52.2, ['G1', 'D2', 'Bb2', 'F3', 'A3'],              0.40, 900],

    // 第三幕（52.2 – 71.8s）：沉稳伸臂成檐、暴雨中的温暖守护（第一波小高潮，随后归于黑场寂静）
    [52.2, 60.0, ['D2', 'A2', 'D3', 'F3', 'A3', 'C4'],         0.48, 1120],
    [60.0, 67.5, ['Bb1', 'F2', 'Bb2', 'D3', 'F3', 'A3', 'D4'], 0.52, 1180],
    [67.5, 72.2, ['C2', 'G2', 'Bb2', 'E3', 'G3'],              0.40, 760],

    // 第四幕（74.8 – 99.7s）：破晓亮回 → 收臂见光层层推进 → 88.8s 白花盛放全片大高潮 → 温柔余韵
    [74.8, 81.2, ['Bb2', 'F3', 'A3', 'C4', 'D4'],              0.44, 1250],
    [81.2, 85.2, ['F2', 'C3', 'A3', 'C4', 'E4', 'G4'],         0.56, 1650],
    [85.2, 88.8, ['C2', 'G2', 'E3', 'G3', 'Bb3', 'C4', 'E4'],  0.66, 2050], // 属和弦蓄势推向盛放
    [88.8, 92.2, ['Bb1', 'F2', 'D3', 'F3', 'A3', 'D4', 'F4'],  0.84, 2750], // ★ 88.8s 盛放高潮第一波（Bbmaj9 宽广爆发）
    [92.2, 95.2, ['C2', 'G2', 'E3', 'G3', 'C4', 'E4', 'G4'],   0.80, 2600], // ★ 盛放高潮延续（辉煌展开）
    [95.2, end,  ['F1', 'C2', 'F2', 'A3', 'C4', 'F4', 'G4'],   0.56, 1380], // 温柔满足的日落尾声收束
  ];

  for (const [t0, t1, notes, vel, cut] of chords) {
    const isClimax = t0 >= 88.5 && t0 < 95.0;
    notes.forEach((n, i) => {
      const sig = pad(n, Math.max(0.3, Math.min(t1, end) - t0), i === 0 ? vel * 1.18 : vel * 0.72, {
        seed: S(),
        cut: i === 0 ? Math.min(820, cut) : cut,
        att: isClimax ? 0.55 : t0 >= 74 ? 1.4 : 1.3,
        rel: t1 >= 71 && t1 <= 73 ? 0.70 : 1.9,
      });
      put(music, t0, sig, { pan: (i - (notes.length - 1) / 2) * 0.18, send: isClimax ? 0.58 : 0.46 });
    });
    cue(t0, `chord ${notes[0]}..${notes[notes.length - 1]}`);
  }

  const flute = (t, n, hold = 2.4, v = 0.20, p = 0.12, bright = 1.0, att = 0.30) =>
    put(music, t, sing(n, hold, v, { seed: S(), bright, att }), { pan: p, send: 0.50 });
  const horn = (t, n, hold = 2.8, v = 0.26, p = -0.14, bright = 1.0, att = 0.38) =>
    put(music, t, celloHorn(n, hold, v, { seed: S(), bright, att }), { pan: p, send: 0.52 });
  const harp = (t, n, d = 2.2, v = 0.18, p = 0.0) =>
    put(music, t, warmHarp(n, d, v, S()), { pan: p, send: 0.54 });

  // ---- 第一幕：悠然轻柔的开场呼吸旋律（克制、宁静）
  [
    [2.4,  'C4', 2.4, 0.15],
    [5.2,  'F4', 2.6, 0.17],
    [C.wake + 0.4, 'G4', 2.2, 0.18],
    [C.wake + 3.0, 'A4', 2.8, 0.19],
    [C.reach[0] + 1.0, 'F4', 2.4, 0.16],
  ].forEach(([t, n, d, v]) => flute(t, n, d, v, 0.12, 0.9));

  // 19.2 s 指尖将花轻轻扶正：温柔的中音长音回应 + 大提琴轻柔托底
  flute(C.straighten, 'A4', 2.6, 0.20, 0.10, 0.95);
  horn(C.straighten + 0.1, 'F3', 3.4, 0.18, -0.12, 0.85);
  flute(C.straighten + 2.8, 'G4', 2.4, 0.17, 0.08, 0.9);
  cue(C.straighten, 'straighten flower warm breath motif');

  // 23.4 s fondly 低头端详小花
  flute(C.fondly + 0.6, 'F4', 3.0, 0.19, -0.08, 0.9);
  cue(C.fondly, 'fondly warm response');

  // ---- 第二幕：起风时的低音大提琴暗流呼吸
  flute(C.notice + 0.8, 'E4', 2.4, 0.15, -0.12, 0.85);
  horn(35.8, 'Bb2', 4.5, 0.20, -0.16, 0.85);
  horn(43.2, 'G2',  5.0, 0.22, -0.16, 0.90);

  // ---- 第三幕：伸臂成檐与屋檐下的坚定温暖守护（52.6 – 68.5 s 第一波抒情峰）
  horn(C.guard[0] + 0.4, 'D3', 4.2, 0.28, -0.15, 1.05);
  horn(57.2,             'A3', 3.2, 0.30, -0.10, 1.10);
  // 60.0 – 67.5 s 屋檐下：大提琴与木管交织的温暖守护旋律
  horn(60.2,  'Bb2', 6.8, 0.32, -0.18, 1.10);
  flute(60.6, 'F4',  2.6, 0.22,  0.14, 1.05);
  flute(63.4, 'Bb4', 2.4, 0.24,  0.12, 1.10);
  flute(66.0, 'A4',  2.6, 0.20,  0.10, 0.95);
  horn(67.6,  'G3',  3.2, 0.22, -0.12, 0.85);

  // ---- 第四幕：破晓亮回 → 收臂蓄势 → 88.8 s 白花盛放交响高潮
  // (a) 75.2 – 81.2 s：黑场静默后，左侧单侧斜阳初现，温暖竖琴轻拨与晨光木管苏醒
  ['Bb3', 'F4', 'A4', 'C5', 'D5'].forEach((n, i) => {
    harp(75.2 + i * 0.55, n, 2.6, 0.16 + i * 0.01, -0.25 + i * 0.10);
  });
  flute(76.2, 'F4', 2.4, 0.22, -0.14, 1.05);
  flute(78.8, 'G4', 2.4, 0.24, -0.10, 1.10);
  cue(C.shafts[0], 'single-sided dawn shafts awakening');

  // (b) 81.2 – 88.2 s：缓缓收回右前臂（s13_retract），阳光直射花苞，大提琴与圆号层层攀升蓄力
  horn(81.2,  'F3',  3.8, 0.32, -0.18, 1.15, 0.32);
  flute(81.6, 'A4',  2.2, 0.28,  0.12, 1.15, 0.26);
  flute(83.8, 'C5',  2.0, 0.32,  0.14, 1.22, 0.24);
  horn(83.8,  'A3',  2.2, 0.34, -0.14, 1.20, 0.28);

  // 85.2 – 88.5 s：高潮前最后的属和弦爬升（C7sus4 -> C7）+ 气声渐强推进
  horn(85.2,  'G3',  3.2, 0.38, -0.16, 1.30, 0.25);
  horn(85.2,  'C3',  3.2, 0.36,  0.16, 1.25, 0.25);
  flute(85.4, 'D5',  1.5, 0.35,  0.10, 1.30, 0.22);
  flute(86.9, 'E5',  1.6, 0.38,  0.08, 1.35, 0.20);
  ['C4', 'E4', 'G4', 'Bb4', 'C5', 'E5'].forEach((n, i) => {
    harp(85.4 + i * 0.42, n, 2.2, 0.20 + i * 0.015, -0.30 + i * 0.12);
  });
  put(music, 85.4, airSwell(3.6, 0.88, 0.28, S()), { pan: 0.0, send: 0.55 });

  // (c) ★ 88.8 – 95.2 s：白花从容盛放 — 全片情感大高潮（八度歌唱旋律 + 圆号大提琴齐奏 + 竖琴流淌 + 温暖定音鼓托底）
  put(music, C.bloom[0] - 0.04, warmTimpani('Bb1', 3.0, 0.42, S()), { pan: -0.05, send: 0.48 });
  put(music, C.bloom[0] + 3.4,  warmTimpani('C2',  2.8, 0.38, S()), { pan:  0.05, send: 0.48 });
  put(music, 95.2,              warmTimpani('F1',  3.4, 0.32, S()), { pan:  0.00, send: 0.50 });

  // 高潮主旋律（高八度明亮木管/独奏弦乐 + 低八度温暖大提琴/圆号深情齐奏）
  const climaxMelody = [
    [C.bloom[0],        'F5', 'F4', 1.65, 0.44],
    [C.bloom[0] + 1.55, 'E5', 'E4', 0.85, 0.38],
    [C.bloom[0] + 2.35, 'D5', 'D4', 1.15, 0.42],
    [C.bloom[0] + 3.40, 'G5', 'G4', 1.55, 0.46], // 92.2 s 情绪最高峰（G5 辉煌延展）
    [C.bloom[0] + 4.85, 'F5', 'F4', 0.95, 0.40],
    [C.bloom[0] + 5.75, 'E5', 'E4', 0.90, 0.36],
  ];
  climaxMelody.forEach(([t, nHigh, nLow, d, v]) => {
    flute(t, nHigh, d, v, 0.12, 1.45, 0.18);
    horn(t,  nLow,  d + 0.2, v * 0.95, -0.14, 1.40, 0.20);
  });

  // 高潮中声部圆号饱满和声支撑
  horn(C.bloom[0],       'Bb2', 3.3, 0.42, -0.24, 1.35, 0.22);
  horn(C.bloom[0],       'D4',  3.3, 0.34,  0.22, 1.30, 0.22);
  horn(C.bloom[0] + 3.4, 'C3',  3.0, 0.40, -0.22, 1.35, 0.22);
  horn(C.bloom[0] + 3.4, 'E4',  3.0, 0.34,  0.22, 1.30, 0.22);

  // 高潮背后的温暖竖琴琶音浪潮（不抢旋律、提供宽广流动感）
  const climaxHarp1 = ['Bb2', 'F3', 'Bb3', 'D4', 'F4', 'A4', 'D5', 'A4', 'F4', 'D4'];
  climaxHarp1.forEach((n, i) => {
    harp(C.bloom[0] + i * 0.33, n, 2.4, 0.24, -0.36 + (i % 5) * 0.18);
  });
  const climaxHarp2 = ['C3', 'G3', 'C4', 'E4', 'G4', 'C5', 'E5', 'C5', 'G4'];
  climaxHarp2.forEach((n, i) => {
    harp(C.bloom[0] + 3.4 + i * 0.33, n, 2.4, 0.23, 0.36 - (i % 5) * 0.18);
  });
  cue(C.bloom[0], 'full orchestral bloom climax (strings + horn + flute + harp)');

  // (d) 95.2 – 99.5 s：高潮落定后的温柔日落余韵（C.smile）
  flute(95.2, 'C5', 2.0, 0.30,  0.08, 1.15, 0.28);
  horn(95.2,  'C4', 2.4, 0.28, -0.10, 1.10, 0.30);
  flute(97.0, 'A4', 2.5, 0.22,  0.04, 0.95, 0.35);
  horn(95.2,  'F2', 4.2, 0.30,  0.00, 0.95, 0.35);
  ['F3', 'C4', 'F4', 'G4', 'A4'].forEach((n, i) => {
    harp(95.3 + i * 0.38, n, 2.8, 0.17, -0.20 + i * 0.10);
  });

  // ================================================================
  // 2. 环境与天气连续音效（SFX Bus）：海浪、风声 W(t)、温润雨幕 R(t)
  // ================================================================
  {
    const len = Math.ceil(dur * SR);
    const sigL = new Float32Array(len);
    const nzSea = new Noise(S()), svfSea = new SVF(480, 0.65);
    const nzWind = new Noise(S()), svfWind = new SVF(380, 1.6);
    const nzRain = new Noise(S()), svfRain = new SVF(1650, 0.70);
    const nzPatter = new Noise(S()), svfPatter = new SVF(460, 1.2);

    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const sil = silenceEnv(t);
      if (sil <= 1e-4) continue;
      const muf = eaveMuffle(t);

      // (a) 崖下海浪声（慢速呼吸起伏，高潮段稍微让路给交响乐）
      const swell = 0.5 + 0.5 * Math.sin(TAU * 0.10 * t) * Math.sin(TAU * 0.06 * t + 0.8);
      const climaxDip = 1 - 0.35 * smooth(invLerp(87.5, 89.2, t)) * (1 - smooth(invLerp(94.8, 96.8, t)));
      const seaLevel = (t < 52 ? 0.20 : t < 73.5 ? 0.11 : 0.20 * smooth(invLerp(74.8, 77.5, t))) * climaxDip;
      if ((i & 31) === 0) svfSea.set((320 + 360 * swell) * muf, 0.65);
      const seaSmp = svfSea.run(nzSea.pink()) * (0.35 + 0.65 * swell) * seaLevel;

      // (b) 随风力曲线平滑起伏的海风
      const w = wind(t);
      if ((i & 31) === 0) svfWind.set((200 + 780 * w * w) * muf, 1.3 + 1.5 * w);
      svfWind.run(nzWind.pink());
      const windSmp = (svfWind.bp * 0.72 + svfWind.lp * 0.28) * Math.pow(w, 1.35) * 0.34;

      // (c) 雨声与前臂屋檐下的温润低频雨打声（无任何金属高频敲击）
      const r = rain(t);
      let rainSmp = 0;
      if (r > 1e-3) {
        if ((i & 31) === 0) {
          svfRain.set((620 + 1750 * muf) * (0.85 + 0.15 * r), 0.70);
          svfPatter.set(360 + 220 * muf, 1.1);
        }
        const wht = nzRain.white();
        const canopy = svfPatter.run(nzPatter.pink()) * 0.30;
        rainSmp = ((svfRain.run(wht) * 0.70 + svfRain.bp * 0.30) * (0.28 * muf + 0.12) + canopy) * r;
      }

      sigL[i] = (seaSmp + windSmp + rainSmp) * sil;
    }
    put(sfx, 0, sigL, { pan: 0.0, send: 0.24 });
    cue(0, 'continuous sea + wind + warm rain');
  }

  // ================================================================
  // 3. 关键动作与自然拟音（全部采用柔和低频/噪声拟音，零金属敲击）
  // ================================================================

  // C.wake (8.6s)：凪光圈亮起暖机低鸣
  {
    const len = Math.ceil(2.4 * SR), s = new Float32Array(len);
    let ph1 = 0, ph2 = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const f1 = 66 + 36 * smooth(t / 1.6), f2 = f1 * 1.5;
      ph1 += TAU * f1 / SR; ph2 += TAU * f2 / SR;
      const env = smooth(t / 0.35) * Math.exp(-Math.max(0, t - 0.6) * 1.3);
      s[i] = (Math.sin(ph1) * 0.75 + Math.sin(ph2) * 0.25) * env * 0.22;
    }
    put(sfx, C.wake - 0.1, s, { pan: 0.05, send: 0.32 });
    cue(C.wake, 'nagi wake hum');
  }

  // C.reach [14.8, 19.2] & C.straighten (19.2s)：沉稳液压抬臂 + 指尖轻触花茎的微弱叶片摩挲声
  const addArmServo = (t0, d, fStart, fEnd, gain = 0.16) => {
    const len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(280, 2.0);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR, u = t / d;
      const f = fStart + (fEnd - fStart) * smooth(u);
      ph += TAU * f / SR;
      svf.set(220 + 150 * Math.sin(Math.PI * u), 2.0);
      const env = Math.sin(Math.PI * u);
      s[i] = (Math.sin(ph) * 0.55 + svf.run(nz.pink()) * 0.45) * env * gain;
    }
    put(sfx, t0, s, { pan: 0.20, send: 0.22 });
  };
  addArmServo(C.reach[0], 3.8, 80, 108, 0.14);
  {
    const d = 0.28, len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(620, 1.4);
    for (let i = 0; i < len; i++) {
      const t = i / SR, u = t / d;
      svf.set(520 + 260 * Math.sin(Math.PI * u), 1.4);
      s[i] = svf.run(nz.pink()) * Math.sin(Math.PI * u) * 0.12;
    }
    put(sfx, C.straighten, s, { pan: 0.20, send: 0.20 });
  }
  addArmServo(C.retractReach[0], 3.8, 104, 76, 0.11);

  // s06_cups_gale (35.0 – 41.0s)：三杯风速计高速旋转的柔和旋风呼啸
  {
    const d = 6.0, len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(460, 2.8);
    for (let i = 0; i < len; i++) {
      const t = i / SR, u = t / d;
      const spinMod = 0.5 + 0.5 * Math.sin(TAU * (4.8 + 6.8 * u) * t);
      svf.set(380 + 560 * u + 180 * spinMod, 2.6);
      svf.run(nz.pink());
      const env = smooth(u / 0.18) * (1 - smooth((u - 0.82) / 0.18));
      s[i] = svf.bp * (0.45 + 0.55 * spinMod) * env * 0.28;
    }
    put(sfx, C.cupsGale[0], s, { pan: 0.08, send: 0.24 });
    cue(C.cupsGale[0], 'anemometer high-speed wind spin');
  }

  // s07_needle (41.2 – 44.8s)：胸口记录鼓笔尖画纸的柔和沙沙声
  {
    const d = 3.6, len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(2200, 3.0);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const scratch = Math.abs(Math.sin(TAU * 9.5 * t + 1.5 * Math.sin(TAU * 3.5 * t)));
      svf.set(1800 + 1400 * scratch, 2.8);
      svf.run(nz.pink());
      const env = smooth(t / 0.25) * (1 - smooth((t - 3.1) / 0.5));
      s[i] = svf.bp * Math.pow(scratch, 2.0) * env * 0.20;
    }
    put(sfx, C.recWild[0], s, { pan: 0.0, send: 0.12 });
    cue(C.recWild[0], 'barograph needle scratching');
  }

  // s08_first_drops (47.36 – 51.92s)：稀疏初雨落在岩石、花瓣与水洼的自然轻拍声（无音高）
  {
    FIRST_DROPS.forEach(([tHit, kind], idx) => {
      put(sfx, tHit, softDrop(kind, kind === 'puddle' ? 0.15 : 0.11, S()), {
        pan: 0.12 + (idx % 3 - 1) * 0.10,
        send: 0.28,
      });
    });
    cue(C.firstDrops[0], `synchronized first raindrops (${FIRST_DROPS.length} drops)`);
  }

  // s09_shelter [52.6, 57.2]：沉稳伸出宽大右前臂成檐 + 低频液压落锁闷响
  addArmServo(C.guard[0], 4.4, 74, 100, 0.18);
  {
    const d = 0.26, len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(200, 1.2);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      ph += TAU * (88 * Math.exp(-t * 10) + 46) / SR;
      s[i] = (Math.sin(ph) * 0.75 + svf.run(nz.pink()) * 0.25) * Math.exp(-t * 14) * smooth(t / 0.008) * 0.20;
    }
    put(sfx, C.guard[1] - 0.08, s, { pan: 0.20, send: 0.18 });
  }
  cue(C.guard[0], 'forearm eave extension & lock');

  // C.flash1 (63.2s，远雷延迟 1.3s -> 64.5s)
  {
    const tThunder = C.flash1 + 1.3, d = 3.8, len = Math.ceil(d * SR), s = new Float32Array(len), nz = new Noise(S()), svf = new SVF(165, 0.8);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const rumble = 0.55 + 0.45 * Math.sin(TAU * 2.6 * t + Math.sin(TAU * 1.2 * t));
      const f = 40 + 55 * Math.exp(-t * 2.0);
      ph += TAU * f / SR;
      svf.set((130 + 340 * Math.exp(-t * 1.3)) * rumble, 0.85);
      const sub = Math.sin(ph) * Math.exp(-t * 1.1) * 0.52;
      const crack = svf.run(nz.pink()) * Math.exp(-t * 0.8) * 0.70;
      s[i] = (sub + crack) * smooth(t / 0.06) * 0.48;
    }
    put(sfx, tThunder, s, { pan: -0.28, send: 0.42 });
    cue(tThunder, 'distant thunder roll');
  }

  // s13_retract [81.6, 86.0]：雨后缓缓收回右前臂
  addArmServo(C.rise[0], 4.2, 90, 118, 0.13);
  cue(C.rise[0], 'forearm gently retracts in sunlight');

  // C.lastDrop (88.2s)：高潮引爆点前最后一滴金珠落入水洼（温润水珠 + 柔和竖琴泛音共鸣引出 88.8s 盛放）
  put(sfx, C.lastDrop, softDrop('puddle', 0.24, S()), { pan: 0.16, send: 0.42 });
  harp(C.lastDrop + 0.02, 'F4', 2.4, 0.22, 0.14);
  harp(C.lastDrop + 0.10, 'C5', 2.4, 0.20, 0.20);
  cue(C.lastDrop, 'last golden droplet lands in puddle (climax trigger)');

  const duck = (t) => {
    const sil = silenceEnv(t);
    const stormDip = 1 - 0.26 * smooth(invLerp(56.5, 58.5, t)) * (1 - smooth(invLerp(68.5, 70.5, t)));
    // 在 88.2s 最后一滴水落下瞬间微收 0.35s 呼吸口，让 88.8s 盛放高潮更具爆发力
    const preClimaxBreath = 1 - 0.28 * smooth(invLerp(87.9, 88.25, t)) * (1 - smooth(invLerp(88.55, 88.85, t)));
    // 第四幕高潮段整体推高音乐总线增益（+22%）
    const climaxBoost = 1 + 0.22 * smooth(invLerp(84.5, 88.8, t)) * (1 - 0.65 * smooth(invLerp(95.0, 98.0, t)));
    return sil * stormDip * preClimaxBreath * climaxBoost;
  };

  return { report, duck };
}
