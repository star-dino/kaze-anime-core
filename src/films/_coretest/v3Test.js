import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rig, cbox } from '../../core/kit.js';
import { cloudTower, skyDome } from '../../core/clouds.js';
import { MotionArcBatch } from '../../core/fx.js';
import { screen } from '../../core/color.js';
import { Rng, smooth, invLerp, heavyAct, onTwos } from '../../core/util.js';
import { terrain } from '../../story/world.js';

// v3 下沉能力的最小示例（C1 / C2 / C3 / C4 / C5）：
//   镜头 'stormSky'（16–20 s）：core/clouds.js 的 skyDome —— 积云塔 → uOvercast 阴云 → 雨后一侧云开 + 侧光光幕；
//                               同时开 look.shaftStyle = 'slanted'（屏幕光束按天穹写入的云遮光率从云隙漏下）
//   镜头 'motionArc'（20–24 s）：三杯风速计按预积分角度加速，MotionArcBatch 残影随角速度淡入；
//                               旁边一条重型机械臂用 heavyAct（预备 + 液压落位）放下，故意压进躯干 → probe --collide 能查出来；
//                               调色用 presetWeights 在 day / gold 之间混合，最后 0.8 s 用 fadeSoft 柔边淡白
//   STORY=_coretest node tools/snap.mjs --sheet v3 s:stormSky@0.2 s:stormSky@0.45 s:stormSky@0.8 s:motionArc@0.15 s:motionArc@0.6 s:motionArc@0.97
//   STORY=_coretest node tools/probe.mjs --dept v3Test --collide --t 20.5,22.6
export const ROTOR_AT = [-17.5, 1.0];
export const SKY_SHOT = [16, 20], ARC_SHOT = [20, 24];

const inShot = (t, [a, b]) => t >= a && t < b;
// 角速度 ω(lt) = 34 · min(lt / 2.4, 1) rad/s 的闭式积分（不累加 → 乱序渲染安全）
const rotorOmega = (lt) => 34 * Math.min(lt / 2.4, 1);
const rotorAngle = (lt) => (lt < 2.4 ? 34 * lt * lt / 4.8 : 34 * 1.2 + 34 * (lt - 2.4));

export function createV3Test(ctx) {
  const { scene, overlay, camera } = ctx;

  // ---- C2 天穹（只在 stormSky 镜头显示；其余镜头用示例片自己的 skyMaterial）
  const rng = new Rng(4242);
  const towers = [];
  const mound = (f) => 1 - 0.58 * f * f * (0.7 + 0.3 * f);
  for (const o of [
    { az: -78, base: -3, w: 40, h: 19, r: 5.2, haze: 0.12 }, { az: 8, base: -3, w: 44, h: 21, r: 5.6, haze: 0.1 },
    { az: 58, base: -3, w: 36, h: 17, r: 4.8, haze: 0.14 }, { az: -30, base: 12, w: 9, h: 3.8, r: 2.5, cut: 12.7, haze: 0.08 },
    { az: 30, base: 14, w: 8, h: 3.4, r: 2.2, cut: 14.6, haze: 0.08 },
  ]) towers.push(cloudTower(rng, { prof: mound, ...o }));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 56, 28), skyDome({ towers }, { rays: { az: -44, el: 12 }, remnant: { az0: -8, az1: 42 } }));
  dome.frustumCulled = false; dome.renderOrder = -1; dome.visible = false;
  scene.add(dome);
  const U = dome.material.uniforms;
  const SKY = { zenith: '#2a62c8', mid: '#6aa8e6', warm: '#ffe2b8', cool: '#c6dcf0', lit: '#fffaf0', cmid: '#eee6ee', shade: '#a6a8d0' };
  for (const [k, v] of [['uZenith', SKY.zenith], ['uMid', SKY.mid], ['uHorizonWarm', SKY.warm], ['uHorizonCool', SKY.cool],
    ['uCloudLit', SKY.lit], ['uCloudMid', SKY.cmid], ['uCloudShade', SKY.shade]]) U[k].value.set(screen(v));

  // ---- C3 三杯风速计 + C4 重型机械臂（Rig 碰撞体）
  const mat = (id, hex, shade) => celMaterial({ id, color: screen(hex), shadeBase: hex, shade, ink: '#2e3640', gloss: 0.3, receiveShadow: true });
  const y0 = terrain(ROTOR_AT[0], ROTOR_AT[1]);
  const rig = new Rig((o) => mat(o.id, o.hex ?? '#e8ecf4', o.shade ?? '#9aa2bc'), 70, 9);   // id 70–78：描线色按 id 全局查表，别和示例恐龙（90、93）或 surfaceTest（80–89）撞号
  rig.root.position.set(ROTOR_AT[0], y0, ROTOR_AT[1]);
  rig.root.visible = false;
  scene.add(rig.root);
  ctx.shadowRoots.push(rig.root);
  rig.joint('mast', rig.root, [0, 0, 0]);
  rig.part(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 12), {}, 'mast', [0, 1.1, 0]);
  rig.joint('rotor', 'mast', [0, 2.25, 0]);
  rig.part(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 16), { hex: '#c89a56', shade: '#88663e' }, 'rotor', [0, 0, 0]);
  const cupGeo = new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    rig.joint(`arm${i}`, 'rotor', [0, 0, 0]).rotation.y = a;
    rig.part(new THREE.CylinderGeometry(0.018, 0.018, 0.6, 6), { hex: '#575760', shade: '#383842' }, `arm${i}`, [0.3, 0, 0], [0, 0, 90]);
    rig.part(cupGeo, { hex: '#c55246', shade: '#8a3939' }, `arm${i}`, [0.62, 0, 0], [0, 0, 90]);
  }
  rig.anchor('rotor', 'rotor', [0, 0, 0]);
  // 机械臂：躯干盒 + 肩关节 + 上臂（胶囊碰撞体）。放下到位时上臂末端压进躯干约 0.1 m → checkSelfCollision 报 arm × torso
  rig.joint('torso', rig.root, [1.6, 0, 0]);
  rig.part(cbox(0.9, 1.6, 0.7, 0.08), { hex: '#edf1f8', shade: '#9fa8c0' }, 'torso', [0, 0.8, 0]);
  // 肩关节挂在 root 上（不是 torso 的子关节：父子关节之间默认不查穿插）
  rig.joint('shoulder', rig.root, [1.6 + 0.62, 1.45, 0]);
  rig.part(cbox(0.26, 1.2, 0.26, 0.05), { hex: '#575760', shade: '#383842' }, 'shoulder', [0, -0.6, 0]);
  rig.addCollider('torso', 'torso', { type: 'capsule', r: 0.36, a: [0, 0.35, 0], b: [0, 1.25, 0] });
  rig.addCollider('arm', 'shoulder', { type: 'capsule', r: 0.14, a: [0, -0.15, 0], b: [0, -1.1, 0] });
  rig.addCollider('mast', 'mast', { type: 'capsule', r: 0.08, a: [0, 0.2, 0], b: [0, 2.2, 0] });

  const arcs = new MotionArcBatch(16);
  overlay.add(arcs.mesh);
  const _c = new THREE.Vector3(), _ax = new THREE.Vector3();

  return {
    rig, dome, arcs,
    update(st) {
      const t = st.t;
      const sky = inShot(t, SKY_SHOT), arc = inShot(t, ARC_SHOT);
      dome.visible = sky;
      if (ctx.sky) ctx.sky.visible = !sky;
      rig.root.visible = arc;
      arcs.begin();
      if (sky) {
        dome.position.copy(camera.position);
        const lt = t - SKY_SHOT[0];
        const after = lt >= 2.0 ? 1 : 0;
        U.uOvercast.value = after ? 0 : smooth(invLerp(0.2, 1.8, lt)) * 0.85;
        U.uAfterRain.value = after;
        U.uSideRays.value = after * 0.35 * smooth(invLerp(2.0, 3.2, lt));   // 天穹自带侧光压低，便于看清屏幕斜光束（C1）
        U.uCloudShift.value.set(lt * 0.05, lt * 0.02);
        U.uCloudDrift.value = lt * 0.4;
      }
      if (arc) {
        const lt = onTwos(t - ARC_SHOT[0]);
        rig.j.rotor.rotation.y = rotorAngle(t - ARC_SHOT[0]);
        // 机械臂 0.4 → 2.8 s 从平举放下（预备上抬 6%，到位后液压过冲 8%）；末端故意压进躯干一点
        const k = heavyAct(lt, [0.4, 2.8], { prep: 0.06, damp: 0.08 });
        rig.j.shoulder.rotation.z = THREE.MathUtils.degToRad(100 - 112 * k);
        rig.root.updateMatrixWorld(true);
        rig.at('rotor', _c); _ax.set(0, 1, 0);
        arcs.blur({ center: _c, axis: _ax, rInner: 0.42, rOuter: 0.8, angle: rig.j.rotor.rotation.y, omega: -rotorOmega(t - ARC_SHOT[0]),
          blades: 3, color: [0.96, 0.97, 1.0], alpha: 0.6, streaks: 2, mode: 0, bias: 0.2, omegaLo: 8, omegaHi: 24 });
      }
      arcs.end();
    },
  };
}
