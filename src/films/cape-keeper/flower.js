import * as THREE from 'three';
import { SpringChain } from '../../core/secondary.js';
import { onTwos, onThrees, smooth, invLerp, clamp, noise1 } from '../../core/util.js';
import { CUES, SPOT } from './cues.js';
import { windAtFlower, rain, wet, WIND_DIR, FIRST_DROPS } from './weather.js';
import { makeMats, makePlant, poseStem, setBloom } from './flower_model.js';
import { groundSampler, makeCrack, makePuddle } from './flower_rock.js';

// 花部门（flower）：
//   凪右脚外侧岩缝口的手掌尺度单朵大白花 + 两块灰岩 + 缝底泥土苔藓 + 映出天色与凪倒影的水洼。
//   建模见 flower_model.js，岩缝与水洼见 flower_rock.js。
//
// 时间线（全部是 t 和 CUES 的纯函数）：
//   < straighten (19.2s)   花茎被早先海风吹歪；18.55–19.20s 凪食指指尖慢速轻推扶正，松开后柔弹定住
//   28.5–47.2s             随起风草浪摇摆，45.8s 强阵风压弯花茎
//   47.36–51.92s           FIRST_DROPS 初雨一滴滴慢落：打中花苞时花头轻沉颤动，落进浅洼激起第一批涟漪
//   guard 之后 (57.2s+)    凪宽大右前臂悬停成檐，檐下风静雨歇，花苞安稳守护在暖琥珀微光里
//   lastDrop (88.2s)       雨后单侧斜阳下，最后一滴金色水珠落入水洼荡开同心涟漪
//   bloom (88.8–92.6s)     3.8 秒从容舒展绽放：翠绿花萼外翻 → 双层十片宽白花瓣层层张开 → 黄金花蕊散开

const C = CUES;
const WD = new THREE.Vector2(WIND_DIR[0], WIND_DIR[1]).normalize();
const W3 = [0.24, 0.34, 0.42];

export function createFlower(ctx) {
  const { scene } = ctx;
  const F = SPOT.flower, Rk = SPOT.rock, Pd = SPOT.puddle;
  const gy = groundSampler(scene, F[0], F[1], 6.5);
  const uWet = { value: 0 };

  // ---- 岩缝
  const crack = makeCrack(F, Rk, gy, uWet);
  scene.add(crack.group);

  // ---- 主株（凪手掌尺度：整株高约 1.68 m，盛开花冠直径约 0.46 m）
  const M = makeMats();
  const S_MAIN = 4.25;
  const main = makePlant(M, { seed: 7 });
  main.root.scale.setScalar(S_MAIN);
  main.head.scale.setScalar(1.24);
  main.root.position.set(F[0], crack.soilTop - 0.03, F[1]);
  scene.add(main.root);
  const headPt = new THREE.Object3D(); headPt.position.y = 0.04; main.head.add(headPt);

  // 初雨打在花苞上的冲击（与 weather.js FIRST_DROPS 逐拍同步）
  const FLOWER_HITS = FIRST_DROPS.filter((d) => d[1] === 'flower').map((d) => d[0]);
  const hitAt = (t) => {
    let d = 0;
    for (const th of FLOWER_HITS) {
      if (th > t) break;
      if (t - th < 1.3) d += Math.exp(-(t - th) * 7.5);
    }
    return d;
  };

  // 初始歪斜角 → 18.55–19.20s 被指尖慢速轻推扶正
  const L0 = 0.68;
  const lean = (t) => {
    const s = C.straighten;
    if (t < s - 0.65) return L0;
    if (t < s) return L0 + (-0.06 - L0) * smooth((t - (s - 0.65)) / 0.65);
    return 0;
  };

  const drive = (t) => {
    const w = windAtFlower(t);
    const m = lean(t) + 1.02 * w * (0.84 + 0.30 * noise1(t * 1.25, 11)) + 0.06 * w * Math.sin(t * 9.5) + 0.34 * hitAt(t);
    const l = 0.26 * w * noise1(t * 0.85 + 5, 3);
    return [m, l];
  };
  const chain = new SpringChain(drive, 3, { freq: 2.8, zeta: 0.30, falloff: 0.85, t0: 0 });
  const tiltFrom = (a, f) => (s) => {
    let m = 0, l = 0;
    for (let i = 0; i < 3; i++) { const k = clamp(3 * s - i); m += a[i][0] * W3[i] * k; l += a[i][1] * W3[i] * k; }
    const ck = f.curve.k1 * s;
    return [WD.x * m - WD.y * l + Math.cos(f.curve.dir) * ck, WD.y * m + WD.x * l + Math.sin(f.curve.dir) * ck];
  };

  function poseLeaves(f, t, w, hit) {
    for (const l of f.leaves) {
      l.sway.rotation.z = -l.k * (0.10 * w * (1 + noise1(t * 2.0 + l.ph, 2)) + 0.06 * hit * Math.sin(l.ph * 3));
      l.sway.rotation.x = 0.06 * l.k * w * noise1(t * 1.6 + l.ph, 7);
    }
  }

  let lastT = NaN;
  function poseMain(T) {
    const t = onTwos(T);
    if (t === lastT) return;
    lastT = t;
    poseStem(main, tiltFrom(chain.at(t), main));
    poseLeaves(main, t, windAtFlower(t), hitAt(t));
    setBloom(main, invLerp(C.bloom[0], C.bloom[1], t));
    main.root.updateMatrixWorld(true);
  }

  // ---- 水洼（映出天光、单侧暖阳与凪的倒影）
  const pud = makePuddle(Pd, gy, 0.86, 0.56, 0.38);
  pud.mesh.visible = false;
  scene.add(pud.mesh);
  const pudAnchor = new THREE.Object3D(); pudAnchor.position.copy(pud.center); scene.add(pudAnchor);

  // 最后一滴落点：水洼中心偏花一侧
  const dropAt = new THREE.Vector3().lerpVectors(pud.center, new THREE.Vector3(F[0], pud.center.y, F[1]), 0.20);
  const PUDDLE_FIRST = FIRST_DROPS.filter((d) => d[1] === 'puddle');

  const _v = new THREE.Vector3();
  const api = {
    main, crack, puddleMesh: pud.mesh,
    rig: {
      anchors: { head: headPt, puddle: pudAnchor },
      j: {},
      at(name, out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.anchors[name].matrixWorld); },
    },
    head(out = new THREE.Vector3(), t) {
      if (t !== undefined) poseMain(t);
      headPt.updateMatrixWorld(true);
      return out.setFromMatrixPosition(headPt.matrixWorld);
    },
    puddle(out = new THREE.Vector3()) { return out.copy(dropAt); },
    puddleCenter(out = new THREE.Vector3()) { return out.copy(pud.center); },
    update(st) {
      const t = st.t;
      uWet.value = wet(t);
      const cam = ctx.camera.position;
      const dMain = cam.distanceTo(_v.set(F[0], crack.soilTop, F[1]));
      main.root.visible = dMain < 95;
      if (main.root.visible) poseMain(t);

      // 水洼积水过程：初雨（48.0–52.0s）先积起浅浅一层映天水洼，暴雨期（52.0–63.0s）蓄满，雨后保持盈满镜面
      const preFill = 0.42 * smooth(invLerp(C.firstDrops[0] + 0.6, C.firstDrops[1], t));
      const stormFill = 0.58 * smooth(invLerp(C.guard[0], C.rainHit + 5.0, t));
      const fill = clamp(preFill + stormFill, 0, 1);
      pud.mesh.visible = fill > 0.02 && dMain < 165;
      if (pud.mesh.visible) {
        const u = pud.u;
        u.uFill.value = 0.28 + 0.72 * fill;
        u.uFxT.value = onThrees(t);
        u.uRain.value = rain(t);

        // 动态设置水洼涟漪槽位：初雨期显示最近落入水洼的 4 滴初雨涟漪，雨后显示 lastDrop 双环涟漪
        const rips = u.uRip.value;
        if (t < C.rainStop) {
          let slot = 0;
          for (let i = PUDDLE_FIRST.length - 1; i >= 0 && slot < 4; i--) {
            const [td, , ou, ov] = PUDDLE_FIRST[i];
            if (td <= t + 0.05 && t - td < 2.4) {
              const rx = pud.center.x + (ou - 0.5) * 0.52;
              const rz = pud.center.z + (ov - 0.5) * 0.34;
              rips[slot++].set(rx, rz, td, 0.92);
            }
          }
          while (slot < 4) rips[slot++].set(0, 0, -99, 0);
        } else {
          rips[0].set(dropAt.x, dropAt.z, C.lastDrop, 1.0);
          rips[1].set(dropAt.x, dropAt.z, C.lastDrop + 0.48, 0.48);
          rips[2].set(0, 0, -99, 0);
          rips[3].set(0, 0, -99, 0);
        }

        const su = ctx.sky?.material?.uniforms;
        if (su?.uZenith) {
          u.uZen.value.copy(su.uZenith.value);
          u.uMidC.value.copy(su.uMid.value);
          u.uHor.value.copy(su.uHorizonWarm.value);
        }
        const rig = ctx.nagi?.rig;
        if (rig?.anchors?.chest) {
          rig.at('chest', _v);
          u.uNagiRefl.value.set(_v.x + 1.1, _v.y, _v.z, 1);
        }
      }
    },
  };
  return api;
}
