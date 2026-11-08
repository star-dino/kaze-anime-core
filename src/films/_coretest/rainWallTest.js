import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rig, cbox } from '../../core/kit.js';
import { RainCurtain, RainField, WaterStrokeBatch, armorMist, rainSplashes } from '../../core/rain.js';
import { GlowBatch } from '../../core/fx.js';
import { screen } from '../../core/color.js';
import { smooth, invLerp, onTwos, onThrees, clamp } from '../../core/util.js';
import { terrain } from '../../story/world.js';

// 远方雨墙 + 盔甲雨雾的最小示例（W9 / W8）：
//   镜头 'rainWall'（36–40 s）：岬角东侧崖边站着一个赛璐璐替身（盒子 / 胶囊拼的 Rig，id 97–99），面朝外海。
//     一堵雨墙（RainCurtain）从外海推过来：清晰的云底团块下沿、雨帘、脚下白浪线、雨下的暗色海面带；
//     dist 从 900 m 推到 0（3.5 s），按 RainCurtain.nearRain(dist) 交接给近处雨丝 RainField（起初就有一点先头小雨）。
//     雨砸在替身的头顶 / 肩甲 / 前臂顶上弹起白水刺 + 薄雾（armorMist），脚边地面溅落（rainSplashes）。
//   STORY=_coretest node tools/snap.mjs --sheet rainwall s:rainWall@0.1 s:rainWall@0.5 s:rainWall@0.8 s:rainWall@0.97
export const RAINWALL_SHOT = [36, 40];
export const RAINWALL_AT = [18, -3];
const inShot = (t, [a, b]) => t >= a && t < b;
// 雨墙前沿离替身的距离（米）：3.5 s 推到眼前，之后停在 0（雨已在头顶）
export const wallDist = (t) => 900 * Math.pow(1 - clamp((t - RAINWALL_SHOT[0]) / 3.5), 1.1);
// 本地雨量：先头小雨 0.1 + 雨墙交接
export const localRain = (t) => 0.1 + 0.9 * RainCurtain.nearRain(wallDist(t));
// 暴雨调色板（look.presetWeights: { storm: 1 }；at = 2 在 k 轴 0..1 之外，不影响其他镜头的 k 插值）
export const STORM_PRESET = { at: 2,
  sunColor: '#d0d6e0', sunStrength: 0.45, skyTint: '#a4adbc', shadeTint: '#6c7488', deepTint: '#4c546a', bounce: '#7c8898',
  sky: { zenith: '#2c3340', mid: '#444d5c', warm: '#7e8894', cool: '#5c6878', cloudLit: '#56606e', cloudMid: '#4c5664', cloudShade: '#424a58' },
  fog: { warm: '#9ca6b2', cool: '#7e8a9a', density: 0.0022, mist: 0.28, mistHeight: 6 },
  water: { deep: '#2a3c4e', shallow: '#425866', foam: '#dae2ea', skyRefl: '#7c8898' },
  grade: { lift: '#151920', gain: '#f6f8fa', sat: 0.94 } };

export function createRainWallTest(ctx) {
  const { scene, overlay, camera, engine } = ctx;
  const wall = new RainCurtain({ height: 420, base: 0.42, depth: 90, color: '#808b9a', cloud: '#363d4a', foam: '#dde3ea', sea: 0.55 });
  const field = new RainField({ S: engine.S, color: '#d0dae6' });
  const water = new WaterStrokeBatch(engine.S, 8000);
  const glows = new GlowBatch(64);
  glows.mesh.renderOrder = 6;
  overlay.add(wall.mesh, field.mesh, water.mesh, glows.mesh);

  // ---- 赛璐璐替身：躯干 + 头 + 两个肩甲 + 举起挡雨的前臂（id 97–99 轮换）
  const mat = (o) => celMaterial({ id: o.id, color: screen(o.hex ?? '#e8ecf4'), shadeBase: o.hex ?? '#e8ecf4', shade: o.shade ?? '#9aa2bc', ink: '#2e3640', gloss: 0.35, receiveShadow: true });
  const rig = new Rig(mat, 97, 3);
  const y0 = terrain(RAINWALL_AT[0], RAINWALL_AT[1]);
  rig.root.position.set(RAINWALL_AT[0], y0, RAINWALL_AT[1]);
  rig.root.rotation.y = Math.PI - 0.35;          // 面朝雨墙来向（右前方外海）
  rig.root.visible = false;
  scene.add(rig.root);
  ctx.shadowRoots.push(rig.root);
  const DARK = { hex: '#575760', shade: '#383842' };
  rig.joint('hip', rig.root, [0, 0.95, 0]);
  rig.part(new THREE.CapsuleGeometry(0.13, 0.75, 4, 10), DARK, 'hip', [-0.17, -0.5, 0]);
  rig.part(new THREE.CapsuleGeometry(0.13, 0.75, 4, 10), DARK, 'hip', [0.17, -0.5, 0]);
  rig.joint('chest', 'hip', [0, 0.1, 0]);
  rig.part(cbox(0.66, 0.78, 0.4, 0.08), {}, 'chest', [0, 0.42, 0]);
  rig.joint('head', 'chest', [0, 0.86, 0]);
  rig.part(cbox(0.32, 0.34, 0.34, 0.07), { hex: '#c55246', shade: '#8a3939' }, 'head', [0, 0.17, 0]);
  rig.anchor('headTop', 'head', [0, 0.345, 0]); rig.anchor('headTopN', 'head', [0, 1.345, 0]);
  for (const sd of [-1, 1]) {
    const S = sd < 0 ? 'L' : 'R';
    rig.joint(`sh${S}`, 'chest', [sd * 0.44, 0.74, 0]);
    rig.part(cbox(0.36, 0.2, 0.42, 0.06), {}, `sh${S}`, [sd * 0.05, 0.04, 0], [0, 0, -sd * 12]);
    rig.anchor(`pad${S}`, `sh${S}`, [sd * 0.05, 0.145, 0]);
    rig.anchor(`pad${S}N`, `sh${S}`, [sd * 0.05 + Math.sin(sd * 12 * Math.PI / 180), 0.145 + Math.cos(12 * Math.PI / 180), 0]);
    rig.part(new THREE.CapsuleGeometry(0.09, 0.36, 4, 8), DARK, `sh${S}`, [0, -0.28, 0]);
    // 前臂：肘部向前抬起 → 前臂水平朝前，顶面朝上（盔甲雨雾的主要落点）
    rig.joint(`el${S}`, `sh${S}`, [0, -0.56, 0]);
    rig.part(cbox(0.2, 0.18, 0.56, 0.05), {}, `el${S}`, [0, 0, 0.26]);
    rig.anchor(`arm${S}0`, `el${S}`, [0, 0.09, 0.12]); rig.anchor(`arm${S}0N`, `el${S}`, [0, 1.09, 0.12]);
    rig.anchor(`arm${S}1`, `el${S}`, [0, 0.09, 0.42]); rig.anchor(`arm${S}1N`, `el${S}`, [0, 1.09, 0.42]);
  }
  const MIST = [['headTop', 0.16], ['padL', 0.18], ['padR', 0.18], ['armL0', 0.1], ['armL1', 0.1], ['armR0', 0.1], ['armR1', 0.1]];
  const pts = MIST.map(([, r]) => ({ p: new THREE.Vector3(), n: new THREE.Vector3(), r }));
  const _n = new THREE.Vector3();

  return {
    wall, field, water, glows, rig,
    update(st) {
      const t = st.t, on = inShot(t, RAINWALL_SHOT);
      rig.root.visible = on;
      water.begin(); glows.begin();
      if (!on) {
        wall.mesh.visible = false; field.mesh.visible = false;
        water.end(); glows.end();
        return;
      }
      const lt = onTwos(t - RAINWALL_SHOT[0]), t3 = onThrees(t);
      // 替身：微微喘息 + 雨墙逼近时把前臂抬高挡在脸前
      const guard = smooth(invLerp(1.6, 3.2, lt));
      rig.j.chest.rotation.x = 0.04 * Math.sin(lt * 2.2) - 0.08 * guard;
      rig.j.head.rotation.x = 0.12 * guard;
      for (const sd of [-1, 1]) {
        const S = sd < 0 ? 'L' : 'R';
        rig.j[`sh${S}`].rotation.set(-0.35 - 0.6 * guard, 0, sd * 0.12);
        rig.j[`el${S}`].rotation.set(0.35 - 0.2 * guard, -sd * 0.35 * guard, 0);
      }
      rig.root.updateMatrixWorld(true);

      const dist = wallDist(t), R = localRain(t);
      wall.update({ t: t3, amount: 1, origin: RAINWALL_AT, dir: [-0.36, 0.93], dist, lean: 25 });
      field.update({ camera, t: onTwos(t), amount: R });
      // 盔甲雨雾：锚点 + 法线（法线 = 法线锚点 − 锚点）
      MIST.forEach(([name], i) => {
        rig.at(name, pts[i].p); rig.at(name + 'N', _n);
        pts[i].n.subVectors(_n, pts[i].p);
      });
      armorMist(water, glows, pts, t, { amount: R, seed: 97, wind: [0.1, 0.25] });
      const ground = (x, z) => terrain(x, z);
      rainSplashes(water, t3, { center: [RAINWALL_AT[0] + 0.6, RAINWALL_AT[1] + 0.8], radius: 3.2, ground, amount: R, rate: 9, seed: 171 });
      water.end(); glows.end();
    },
  };
}
