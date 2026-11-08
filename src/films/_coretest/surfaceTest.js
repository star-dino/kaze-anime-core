import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rig, cbox } from '../../core/kit.js';
import { foliage } from '../../core/foliage.js';
import { paintTexture, letter, bolt, seam } from '../../core/textures.js';
import { screen } from '../../core/color.js';
import { terrain } from '../../story/world.js';

// K1 / K2 / K4 的最小示例（镜头 'surface'）：三件“巨人零件”并排，从海上看过去。
//   左：圆筒  —— weather 四项全开（底漆斑、掉漆、锈、污渍）+ det 投影贴花（红色条带 + 编号，包在弯曲的筒面上）
//   中：圆角盒 —— weather + rig.decal 平面贴花（手写编号、铆钉、刻线）
//   右：转动的盒子 —— 顶上挂一圈苔藓团 / 草 / 小花（foliage 挂在关节下，noShadow），随时间转 360°
// 验收：花纹粘在零件上不游走；贴花边缘不出描线；苔藓跟着盒子转、始终朝镜头。
export const SURF_AT = [-12, 1.0];

const C = { lav: '#a3a2c0', lavShade: '#7c7f9c', teal: '#86b7a6', tealShade: '#5e8c86', red: '#c84a30', ink: '#2e3640' };
const WEATHER = { weather: { patch: 0.6, chip: 0.35, rust: 0.5, stain: 0.5, scale: 1.1 }, primer: '#efcf9f', primerShade: '#c9a77e', rust: '#7a3b2c', metal: '#4a4552' };
const paint = (id, seed, extra = {}) => celMaterial({ id, color: screen(C.lav), shadeBase: C.lav, shade: C.lavShade, ink: C.ink, gloss: 0.2, wear: 0, receiveShadow: true,
  ...WEATHER, weather: { ...WEATHER.weather, seed }, ...extra });

export function createSurfaceTest(ctx) {
  const y0 = terrain(SURF_AT[0], SURF_AT[1]);
  const rig = new Rig((o) => paint(o.id, o.seed ?? 0), 80, 10);
  rig.root.position.set(SURF_AT[0], y0, SURF_AT[1]);
  rig.root.rotation.y = Math.PI;                       // 正面朝 -Z（大海、镜头）

  // 左：圆筒 + 投影贴花（红条带 + “07”）
  const stripe = paintTexture(512, 512, (g, rng) => {
    g.fillStyle = screen(C.red); g.fillRect(0, 70, 512, 60);
    letter(g, '07', 150, 220, 200, rng, { color: screen('#2e3640'), width: 26 });
  }, { seed: 5 });
  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.4, 48);
  const cyl = new THREE.Mesh(cylGeo, paint(81, 0.0, { det: [{ tex: stripe, axis: 2, sign: 1, rect: [0, 0.2, 1.0, 1.0] }] }));
  cyl.position.set(1.4, 0.7, 0);
  rig.root.add(cyl);

  // 中：圆角盒 + 平面贴花
  rig.joint('mid', rig.root, [0, 0, 0]);
  const box = rig.part(cbox(1.1, 1.2, 0.9, 0.08), { id: 82, seed: 3.3 }, 'mid', [0, 0.6, 0]);
  const plate = paintTexture(512, 256, (g, rng) => {
    g.fillStyle = screen('#e8e2d0'); g.beginPath(); g.roundRect(10, 10, 492, 236, 26); g.fill();
    seam(g, () => { g.roundRect(10, 10, 492, 236, 26); }, 6, { ink: screen(C.ink) });
    letter(g, 'NO 07', 70, 70, 120, rng, { color: screen(C.ink), width: 13 });
    for (const [x, y] of [[40, 40], [472, 40], [40, 216], [472, 216]]) bolt(g, x, y, 14);
  }, { seed: 9 });
  rig.decal(plate, box, 'mid', 0.6, 0.3, [0, 0.82, 0.451], [0, 0, 0], { shade: '#b8b0a0', shadeBase: '#ffffff', ink: C.ink });

  // 右：会转的盒子 + 顶上的苔藓
  rig.joint('turn', rig.root, [-1.4, 0, 0]);
  rig.part(cbox(0.9, 0.9, 0.9, 0.07), { id: 83, seed: 7.7 }, 'turn', [0, 0.45, 0]);
  const moss = foliage([
    { p: [0.2, 0.86, 0.2], s: 0.75, k: 'moss' }, { p: [-0.25, 0.86, -0.1], s: 0.65, k: 'moss', f: 1 },
    { p: [0.05, 0.88, -0.3], s: 0.5, k: 'grass' }, { p: [-0.1, 0.86, 0.3], s: 0.42, k: 'flowers' },
    { p: [0.42, 0.7, 0.0], s: 0.36, sy: 1.4, k: 'vines' },
  ], { deep: '#3f6d48', shade: '#5e8a4c', mid: '#8fb257', light: '#cfd36a', blossom: '#fbf8f0', blossom2: '#d8c8f0', noShadow: true });
  rig.j.turn.add(moss);

  ctx.scene.add(rig.root);
  ctx.shadowRoots.push(rig.root);
  return {
    update(st) {
      rig.j.turn.rotation.y = st.shot === 'surface' ? (st.lt / st.dur) * Math.PI * 2 : 0;
    },
  };
}
