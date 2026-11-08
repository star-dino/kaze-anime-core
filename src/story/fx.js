import * as THREE from 'three';
import { GlowBatch, LineBatch, Ripples, boltPts, GLOW } from '../core/fx.js';
import { hash, hr, onTwos, onThrees, drawing, easeIn, clamp } from '../core/util.js';
import { CUES, IMPACT, STAR_FROM } from './story.js';

// 特效部门。每帧从零重建（begin → push → end），全部是 t 的闭式函数：
//   流星：头部十字星 + 渐细的拖尾（一拍二）
//   入水：闪光、扩散光环、闪电（一拍三换形）、抛物线水滴（闭式解）、水面涟漪、余晖闪点

const V = THREE.Vector3;
const I = new V(...IMPACT), S0 = new V(...STAR_FROM);
const G = 9.8;

function starAt(u, out) {          // 流星轨迹（略带弧度）
  out.lerpVectors(S0, I, u);
  out.y += 30 * u * (1 - u);
  return out;
}

export function createFx(ctx) {
  const { overlay, engine, camera } = ctx;
  const glows = new GlowBatch(800);
  const lines = new LineBatch(40000);
  const rip = new Ripples(engine.mWater.uniforms);
  lines.mesh.renderOrder = 1; glows.mesh.renderOrder = 2;
  overlay.add(lines.mesh, glows.mesh);
  const R = new V(), U = new V(), tmp = new V(), A = new V(), B = new V();

  return {
    update(st) {
      const t = st.t, c = CUES;
      glows.begin(); lines.begin(); rip.begin();
      camera.updateMatrixWorld();
      R.setFromMatrixColumn(camera.matrixWorld, 0);       // 相机右
      U.setFromMatrixColumn(camera.matrixWorld, 1);       // 相机上

      // ---------------------------------------------------- 流星（一拍二）
      const tq = onTwos(t);
      if (tq >= c.streak && tq < c.impact) {
        const u = easeIn((tq - c.streak) / (c.impact - c.streak), 1.7);
        const u0 = Math.max(0, u - 0.5);
        const pts = [];
        for (let i = 0; i <= 28; i++) pts.push(starAt(u0 + (u - u0) * (i / 28), new V()));
        lines.push(pts, { px: 13, color: [1.0, 0.62, 0.22], power: 1.1, width: (s) => 0.12 + 0.88 * s, alpha: (s) => Math.pow(s, 1.6), rim: 0.85 });
        lines.push(pts, { px: 3.5, color: [0.55, 0.9, 1.0], power: 1.2, width: (s) => 0.2 + 0.8 * s, alpha: (s) => s });
        const head = starAt(u, tmp);
        glows.push(head, { kind: GLOW.kira, px: 46 + 10 * hash(drawing(t, 12), 1), color: [1, 0.92, 0.6], power: 1.5, rot: 0.2 });
        glows.push(head, { kind: GLOW.soft, px: 90, color: [1, 0.8, 0.45], power: 0.7 });
      }

      // ---------------------------------------------------- 入水
      const a = t - c.impact;
      if (a >= 0) {
        const aq = onThrees(t) - onThrees(c.impact);       // 特效一拍三
        // 闪光与光环
        // 水面附近的特效用 mode 1：只被角色挡住（海床不在水面之上，不能拿它做遮挡）
        glows.push(tmp.copy(I).setY(3), { kind: GLOW.soft, m: 9 + 26 * aq, color: [0.75, 0.92, 1], power: 1.7 * Math.exp(-aq * 4.0), mode: 1 });
        glows.push(tmp.copy(I).setY(0.5), { kind: GLOW.ring, m: 5 + 38 * aq, color: [0.6, 0.9, 1], power: 1.4 * Math.exp(-aq * 1.6), mode: 1 });
        glows.push(tmp.copy(I).setY(2), { kind: GLOW.kira, px: 160 * Math.exp(-aq * 2.5), color: [1, 0.97, 0.85], power: 1.6 * Math.exp(-aq * 2.0), mode: 1 });
        // 闪电：每张原画（8 fps）重新生成形状；同一张原画内形状不变
        if (aq < 1.6) {
          const dn = drawing(t, 8), life = 1 - aq / 1.6;
          for (let i = 0; i < 6; i++) {
            const ang = hash(dn, i, 1) * Math.PI * 2;
            const len = hr(dn, i, 2, 14, 34);
            A.copy(I).setY(hr(dn, i, 3, 0.5, 4));
            B.set(I.x + Math.cos(ang) * len, hr(dn, i, 4, 4, 26), I.z + Math.sin(ang) * len * 0.5);
            const pts = boltPts(A, B, dn * 13 + i, R, U, 0.22, 4);
            lines.push(pts, { px: 2.5 + 4 * life, color: [0.3, 0.72, 1], power: 1.5 * life, mode: 1, rim: 0.7 });
          }
        }
        // 水滴：抛物线闭式解 p = p0 + v·a + ½g·a²，水面以下就不画了
        for (let i = 0; i < 70; i++) {
          const az = hash(i, 7, 1) * Math.PI * 2, el = 0.9 + 0.6 * hash(i, 7, 2);
          const sp = hr(i, 7, 3, 9, 26), born = hash(i, 7, 4) * 0.15;
          const ta = aq - born;
          if (ta <= 0) continue;
          const vx = Math.cos(az) * Math.cos(el) * sp, vy = Math.sin(el) * sp, vz = Math.sin(az) * Math.cos(el) * sp * 0.6;
          const y = vy * ta - 0.5 * G * ta * ta;
          if (y < 0) continue;
          tmp.set(I.x + vx * ta, y, I.z + vz * ta);
          glows.push(tmp, { kind: GLOW.soft, px: hr(i, 7, 5, 3, 7), color: [0.85, 0.95, 1], power: 0.9, mode: 1 });
        }
        // 涟漪（时间基 = 水面的 uFxTime，也是一拍三）
        const t0 = onThrees(c.impact);
        rip.push(I.x, I.z, t0, 0.9, 10, 2.4, 0.3, 1);
        rip.push(I.x, I.z, t0 + 0.25, 0.6, 5.5, 1.6, 0.35, 1);
        rip.push(I.x, I.z, t0 + 0.5, 0.4, 2.8, 1.1, 0.4, 0.8);
        // 余晖：海面上一闪一闪的十字星（每张原画重掷一次是否点亮）
        if (aq > 0.3 && aq < 3.4) {
          const dn = drawing(t, 8);
          for (let i = 0; i < 26; i++) {
            if (hash(i, dn, 9) < 0.55) continue;
            const rr = hr(i, 0, 10, 4, 40), ang = hash(i, 0, 11) * Math.PI * 2;
            tmp.set(I.x + Math.cos(ang) * rr, 0.3, I.z + Math.sin(ang) * rr * 0.6);
            glows.push(tmp, { kind: GLOW.kira, px: hr(i, dn, 12, 10, 22), color: [1, 0.95, 0.7], power: clamp(1.4 - aq * 0.35), mode: 1 });
          }
        }
      }
      glows.end(); lines.end(); rip.end();
    },
  };
}
