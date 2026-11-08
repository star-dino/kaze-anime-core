import { smooth, invLerp, easeInOut, mix3 } from '../../core/util.js';

// 《海岬的测风人》（岬の風守）100 秒 / 15 镜。
// 故事与分镜见 storyboard.md。

export { CUES, SPOT } from './cues.js';
import { CUES, SPOT } from './cues.js';
import { terrain } from './world.js';

export { PRESETS, lookAt } from './palette.js';
import { PRESETS, lookAt } from './palette.js';
import { buildScore } from './score.js';

// ---------------------------------------------------------------- 镜头表（15 镜 / 100.0 s）
const N = SPOT.seat, F = SPOT.flower;
const gN = terrain(...N), gF = terrain(...F);
const gy = gN;
const f3 = (dx, dy, dz) => [F[0] + dx, gF + dy, F[1] + dz];
const pan = (a, b, e = easeInOut) => (lt, d) => mix3(a, b, e(lt / d));
const still = (pos, look, fov) => () => ({ pos, look, fov });
const move = (p0, p1, look, fov) => (lt, d) => ({ pos: pan(p0, p1)(lt, d), look, fov });
const move2 = (p0, p1, l0, l1, fov) => (lt, d) => ({ pos: pan(p0, p1)(lt, d), look: pan(l0, l1)(lt, d), fov });
const L = (key) => (lt, d, t) => lookAt(t, key ? { key } : {});
const KEY_FRONT = [0.32, 0.58, -1];   // 正面看脸/舷窗时适度补亮面朝大海（−Z）的前装甲与黄铜镜圈

// 全片严格遵守 +X 右侧机位轴线，石台高坐姿 + 右手侧放腾空视线走廊 + 右前臂悬空成檐确保 15 镜零穿模、零视线遮挡
const shots = [
  // ---- 第一幕：夏日海岬、醒来与慢动作扶花（0.0 – 28.0 s）
  ['s01_cape',        7.0, move([108, 46, -196], [86, 39, -158], [N[0] + 1, gN + 7.5, N[1] + 4], 34), L()],
  ['s02_wake',        7.0, move([N[0] + 17.5, gN + 6.8, N[1] - 20.5], [N[0] + 15.8, gN + 6.4, N[1] - 18.8], [N[0] + 2.8, gN + 8.2, N[1] - 4.8], 32), L(KEY_FRONT)],
  ['s03_reach',       8.5, move2([F[0] + 7.4, gF + 2.9, F[1] - 8.2], [F[0] + 5.8, gF + 2.3, F[1] - 6.6], [F[0] - 1.8, gF + 3.1, F[1] + 0.6], [F[0] - 0.9, gF + 2.2, F[1] + 0.2], 36), L(KEY_FRONT)],
  ['s04_fondly',      5.5, move([8.6, 30.6, -15.6], [8.0, 31.0, -14.8], [3.3, 34.8, -6.1], 33), L(KEY_FRONT)],

  // ---- 第二幕：起风、头顶风杯急转、花摇与初雨慢落（28.0 – 52.0 s，不切海面乌云墙，直接聚焦风与花）
  ['s05_wind_grass',  7.0, move([N[0] + 25, gN + 3.6, N[1] + 36], [N[0] + 22, gN + 3.4, N[1] + 31], [N[0] + 1, gN + 7.2, N[1] - 10], 36), L()],
  ['s06_cups_gale',   6.0, move([8.8, 34.8, -11.6], [8.0, 35.1, -10.8], [2.6, 37.3, -5.1], 30), L(KEY_FRONT)],
  ['s07_needle',      4.0, still([N[0] + 0.4, gN + 8.8, N[1] - 13.5], [N[0], gN + 8.6, N[1] - 7.2], 16.5), L(KEY_FRONT), { anchor: 'chest', offset: [-0.38, 0.22, 6.4] }],
  ['s08_first_drops', 7.0, move(f3(2.35, 1.42, -2.55), f3(2.05, 1.28, -2.25), f3(-0.06, 0.80, 0.04), 35), L()],

  // ---- 第三幕：伸臂成檐、暴雨守护与黑场转场（52.0 – 74.0 s）
  ['s09_shelter',     8.0, move([F[0] + 13.5, gF + 4.8, F[1] - 11.5], [F[0] + 11.8, gF + 4.2, F[1] - 10.2], [N[0] + 4.2, gF + 5.6, N[1] - 4.2], 36), L(KEY_FRONT)],
  ['s10_under_eave',  7.5, move(f3(-1.58, 0.88, 3.05), f3(-1.38, 0.84, 2.75), f3(0.35, 2.58, -1.45), 50), L()],
  ['s11_endure_fade', 6.5, move([9.6, 34.4, -12.4], [9.0, 34.6, -11.6], [4.65, 35.45, -6.4], 25), L(KEY_FRONT)],

  // ---- 第四幕：黑场渐亮、单侧斜阳、收臂与水洼盛放（74.0 – 100.0 s）
  ['s12_dawn_side',   7.0, move([N[0] + 19.5, gN + 5.2, N[1] + 24.5], [N[0] + 17.8, gN + 4.9, N[1] + 22.0], [N[0] - 16.0, gN + 8.5, -95], 42), L()],
  ['s13_retract',     6.0, move([F[0] + 10.8, gF + 4.2, F[1] - 11.2], [F[0] + 11.6, gF + 4.5, F[1] - 12.0], [N[0] + 3.6, gF + 5.8, N[1] - 4.5], 35), L()],
  ['s14_drop_bloom',  7.0, move(f3(1.75, 1.88, 3.45), f3(1.58, 1.76, 3.20), f3(0.06, 0.92, -0.28), 34), L()],
  ['s15_sunset_hold', 6.0, move([N[0] + 21.5, gN + 5.8, N[1] + 25.5], [N[0] + 23.2, gN + 6.2, N[1] + 27.5], [N[0] + 2.5, gN + 7.9, -65], 42), L()],
];

let _t = 0;
export const SHOTS = shots.map(([name, d, cam, look, aim]) => {
  const s = { name, start: _t, end: Math.round((_t + d) * 1000) / 1000, cam, look, aim };
  _t = s.end;
  return s;
});

export const story = {
  title: '海岬的测风人',
  fps: 24,
  duration: 100,
  width: 1920, height: 1040,
  cues: CUES,
  score: buildScore,
  shots: SHOTS,
  presets: PRESETS,
  shadowFix: true,
  look: { ...lookAt(0), shadow: { center: [SPOT.seat[0], gy + 8, SPOT.seat[1]], radius: 14, depth: 60 } },
  state(st) {
    const t = st.t, c = CUES;
    if (t < c.fadeInEnd) {
      st.fade = 1 - smooth(t / c.fadeInEnd);
      st.fadeColor = '#ffffff';
    } else if (t >= c.blackOut[0] && t <= c.blackIn[1]) {
      // 暴雨渐歇 → 黑场留白（73.2–74.0 s）→ 缓缓亮回雨后单侧斜阳
      if (t < c.blackOut[1]) st.fade = smooth(invLerp(c.blackOut[0], c.blackOut[1], t));
      else if (t <= c.blackIn[0]) st.fade = 1;
      else st.fade = 1 - smooth(invLerp(c.blackIn[0], c.blackIn[1], t));
      st.fadeColor = '#06080f';
    } else if (t > c.fadeOutStart) {
      st.fade = smooth(invLerp(c.fadeOutStart, 99.95, t)) * 0.95;
      st.fadeColor = '#fff6e6';
    }
  },
  departments: [
    { name: 'atmo', load: () => import('./sky.js'), factory: 'createSky' },
    { name: 'world', load: () => import('./world.js'), factory: 'createWorld' },
    { name: 'nagi', load: () => import('./nagi.js'), factory: 'createNagi' },
    { name: 'flower', load: () => import('./flower.js'), factory: 'createFlower' },
    { name: 'weather', load: () => import('./fx.js'), factory: 'createWeatherFx' },
  ],
};
export default story;
