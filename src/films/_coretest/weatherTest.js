import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { cbox } from '../../core/kit.js';
import { GLASS_GLSL } from '../../core/glsl.js';
import { FleckBatch, FLECK, emitStream, dustBurst } from '../../core/fx.js';
import { WaterStrokeBatch, eaveCurtain, rainSplashes, fallingDrop } from '../../core/rain.js';
import { integral } from '../../core/secondary.js';
import { screen } from '../../core/color.js';
import { smooth, invLerp, onThrees, clamp } from '../../core/util.js';
import { terrain } from '../../story/world.js';
import { SURF_AT } from './surfaceTest.js';

// 第二批下沉能力的最小示例（W2 / W5 / W6 / W7 / W8 / W10 / W11 / K3 / K5）：
//   镜头 'gale'（24–28 s）：大风草地 —— FleckBatch 草屑 + 花瓣顺风飞过（emitStream），石头上每 0.8 s 被沙打出一团尘（dustBurst）；
//                           地面云影随风扫过（look.cloudShadow，偏移 = 风的积分 integral）；纸张质感 + 加重暗角 / 颗粒（look.paper / vignette / grain）
//   镜头 'wetGlass'（28–32 s）：雨檐 —— 木板檐口挂水帘（eaveCurtain）、地面雨点溅落（rainSplashes）、一滴大雨滴落地（fallingDrop）；
//                           右边玻璃板：前 2 s 流水道、之后静止水珠（GLASS_GLSL）；左边三片逆光花瓣（celMaterial transmit）；
//                           中间三个盒子描线粗细 1 / 0.55 / 2.5（celMaterial inkWeight，K3）
export const GALE_SHOT = [24, 28], WET_SHOT = [28, 32];
export const GALE_AT = [-8, -2], WET_AT = [-17.5, -2.5];
const inShot = (t, [a, b]) => t >= a && t < b;
// 云影偏移 = 风速的积分（W7）：风一变，云影平滑加减速，不会跳
export const galeWind = (t) => 0.55 + 0.35 * smooth(invLerp(24, 26, t));
export const cloudOffset = integral((t) => 6 * galeWind(t), { t0: 20, t1: 34 });

export function createWeatherTest(ctx) {
  const { scene, overlay, engine } = ctx;
  const flecks = new FleckBatch(1500), water = new WaterStrokeBatch(engine.S, 12000);
  overlay.add(flecks.mesh, water.mesh);

  // ---- 雨檐场景（只在 wetGlass 镜头显示）
  const grp = new THREE.Group(); grp.visible = false; scene.add(grp);
  const gy = terrain(WET_AT[0], WET_AT[1]);
  grp.position.set(WET_AT[0], gy, WET_AT[1]);
  const cel = (id, hex, shade, extra = {}) => celMaterial({ id, color: screen(hex), shadeBase: hex, shade, ink: '#2e3640', gloss: 0.3, receiveShadow: true, ...extra });
  const plank = new THREE.Mesh(cbox(2.6, 0.12, 1.0, 0.03), cel(62, '#a87c56', '#6e5040'));
  plank.position.set(0, 2.3, 0.2); grp.add(plank);
  for (const x of [-1.15, 1.15]) { const post = new THREE.Mesh(cbox(0.1, 2.3, 0.1, 0.02), cel(63, '#7a5a44', '#4e3a30')); post.position.set(x, 1.15, 0.6); grp.add(post); }
  // K3：三个同色盒子，描线粗细 1 / 0.55 / 2.5（每个 id 一档）
  [[64, 1], [65, 0.55], [66, 2.5]].forEach(([id, w], i) => {
    const m = new THREE.Mesh(cbox(0.42, 0.42, 0.42, 0.04), cel(id, '#e8ecf4', '#9aa2bc', { inkWeight: w }));
    m.position.set(-0.55 + i * 0.55, 0.21, -0.2); m.rotation.y = 0.5; grp.add(m);
  });
  // W11：玻璃板（帧 + 玻璃面），玻璃 pattern 用 GLASS_GLSL
  const uRainK = { value: 0 }, uWetK = { value: 0 };
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.1), celMaterial({
    id: 67, color: screen('#3a4a5a'), shade: '#26323e', shadeBase: '#3a4a5a', gloss: 0.6, ink: '#2e3640',
    colors: { cGlass: screen('#3a4a5a') }, uniforms: { uRainK, uWetK },
    pattern: GLASS_GLSL + `vec4 pattern(vec3 p, vec3 n){ float un; vec3 c = glassWater(cGlass, p.xy / 0.5, uDrawTime, uRainK, uWetK, vec3(0.86, 0.92, 1.02), un); return vec4(c, un); }`,
  }));
  glass.position.set(1.65, 0.9, -0.1); glass.rotation.y = -0.35; grp.add(glass);
  // W6：三片逆光花瓣（薄椭圆片），左边那片不开 transmit 作对照
  const petalGeo = new THREE.CircleGeometry(0.16, 24); petalGeo.scale(0.6, 1, 1);
  [0, 0.7, 0.7].forEach((tr, i) => {
    const m = new THREE.Mesh(petalGeo, cel([61, 68, 69][i], '#f4ecf0', '#c0b0c8', { transmit: tr, transmitColor: '#ffe2a6' }));
    m.material.side = THREE.DoubleSide;
    m.position.set(-1.7 + i * 0.28, 0.75 + 0.08 * i, -0.3); m.rotation.set(0.15, 0.25 - i * 0.2, 0.3 * (i - 1)); grp.add(m);
  });

  const ROCK = [SURF_AT[0], terrain(SURF_AT[0], SURF_AT[1]) + 1.25, SURF_AT[1]];          // 沙打在 surfaceTest 的盒子顶上
  return {
    flecks, water, grp,
    update(st) {
      const t = st.t, gale = inShot(t, GALE_SHOT), wet = inShot(t, WET_SHOT);
      grp.visible = wet;
      flecks.begin(); water.begin();
      if (gale) {
        const W = galeWind(t), dir = [0.95, 0.05, 0.3];   // 和 look.wind 同向
        // 镜头前方约 4 m 处横穿画面（从画面右侧的上风处出生）
        const origin = [GALE_AT[0] - 7.5, terrain(GALE_AT[0], GALE_AT[1]) + 1.5, GALE_AT[1] + 1.8];
        const ground = (x, z) => terrain(x, z);
        emitStream(flecks, t, { seed: 11, from: 22, origin, size: [2, 1.6, 5], dir, speed: 9 * W, rate: 70, life: 2.2, kind: FLECK.strip,
          len: 0.16, wid: 0.03, colors: [[0.46, 0.62, 0.24], [0.66, 0.72, 0.34], [0.78, 0.7, 0.42]], wobble: 0.35, gravity: 1.5, ground });
        emitStream(flecks, t, { seed: 23, from: 22, origin, size: [2, 1.8, 5], dir, speed: 6.5 * W, rate: 18, life: 2.8, kind: FLECK.petal,
          len: 0.09, wid: 0.06, colors: [[0.98, 0.86, 0.9], [1.0, 0.96, 0.94]], wobble: 0.5 });
        for (let k = 0; k < 5; k++) dustBurst(flecks, ROCK, t, 24.2 + k * 0.8, { seed: 40 + k, n: 9, radius: 0.7, color: [0.84, 0.78, 0.64] });
      }
      if (wet) {
        const lt = t - WET_SHOT[0], t3 = onThrees(t);
        const kR = 1 - smooth(invLerp(1.6, 2.4, lt));                      // 前 2 s 下雨，之后雨停只剩水珠
        uRainK.value = kR; uWetK.value = 1;
        grp.updateMatrixWorld(true);
        const a = new THREE.Vector3(-1.3, 2.24, 0.7).applyMatrix4(grp.matrixWorld), b = new THREE.Vector3(1.3, 2.24, 0.7).applyMatrix4(grp.matrixWorld);
        const ground = (x, z) => terrain(x, z);
        eaveCurtain(water, a, b, t3, { n: 26, k: kR, wind: [0.15, 0.1], ground });
        rainSplashes(water, t3, { center: [WET_AT[0], WET_AT[1] - 1.4], radius: 2.6, ground, amount: kR, rate: 7 });
        const dp = [WET_AT[0] + 0.35, ground(WET_AT[0] + 0.35, WET_AT[1] - 0.9) + 0.01, WET_AT[1] - 0.9];
        fallingDrop(water, dp, t, WET_SHOT[0] + 3.1, { height: 2.2, dur: 0.3, color: [0.95, 0.97, 1.0], crown: { color: [0.95, 0.97, 1.0], radius: 0.22 } });
      }
      flecks.end(); water.end();
    },
  };
}
