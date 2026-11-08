import * as THREE from 'three';
import { GlowBatch, GLOW } from '../core/fx.js';
import { hash, hr, drawing } from '../core/util.js';
import { CUES } from './story.js';

// 特效部门骨架：每帧 begin → push → end；随机只用 hash(i, 原画张数)。
export function createFx(ctx) {
  const glows = new GlowBatch(200);
  ctx.overlay.add(glows.mesh);
  const p = new THREE.Vector3();
  return {
    update(st) {
      glows.begin();
      const a = st.t - CUES.sparkle;
      if (a >= 0 && ctx.hero?.rig) {
        const head = ctx.hero.rig.at('head');           // 读别的部门的锚点，不写死坐标
        const dn = drawing(st.t, 8);                     // 一拍三：每张原画重掷
        for (let i = 0; i < 12; i++) {
          if (hash(i, dn, 1) < 0.4) continue;
          p.set(head.x + hr(i, 0, 2, -0.6, 0.6), head.y + hr(i, 0, 3, 0.1, 0.8), head.z + hr(i, 0, 4, -0.6, 0.6));
          glows.push(p, { kind: GLOW.kira, px: hr(i, dn, 5, 10, 22), color: [1, 0.92, 0.6], power: Math.max(0, 1.3 - a), mode: 1 });
        }
      }
      glows.end();
    },
  };
}
