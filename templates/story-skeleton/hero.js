import { celMaterial } from '../core/materials.js';
import { Rig, blob, spike } from '../core/kit.js';
import { onTwos, smooth, invLerp } from '../core/util.js';
import { CUES, HERO } from './story.js';
import { terrain } from './world.js';

// 角色部门骨架：一个由超椭球拼成的小角色，带锚点、一拍二的转头表演。
export function createHero(ctx) {
  const rig = new Rig(celMaterial, 1, 40);            // 描线 id 1..40 循环
  rig.joint('body', rig.root, [0, 0.55, 0]);
  rig.part(blob(0.45, 0.55, 0.42), { color: '#f2a65a', wear: 0.1 }, 'body', [0, 0, 0]);
  rig.joint('head', 'body', [0, 0.6, 0.05]);
  rig.part(blob(0.36, 0.32, 0.34), { color: '#f2a65a', wear: 0.05 }, 'head', [0, 0.2, 0]);
  for (const s of [-1, 1]) {
    rig.part(blob(0.06, 0.08, 0.05), { color: '#2a2236', wear: 0, gloss: 0 }, 'head', [s * 0.14, 0.26, 0.3]);
    rig.part(spike(0.08, 0.22, 4), { color: '#ffd447' }, 'head', [s * 0.18, 0.48, 0], [0, 0, -s * 20]);
  }
  rig.anchor('head', 'head', [0, 0.25, 0.2]);          // TODO：发布你的锚点并写进 CONTRACT

  const root = rig.root;
  root.rotation.y = Math.PI;                            // 面朝 -Z
  root.position.set(HERO[0], terrain(HERO[0], HERO[1]), HERO[1]);
  ctx.scene.add(root);
  ctx.shadowRoots.push(root);

  return {
    rig,
    update(st) {
      const ta = onTwos(st.t);                          // 角色一拍二
      const k = smooth(invLerp(CUES.turn[0], CUES.turn[1], ta));
      rig.rot('head', [-10 * k, 35 * k, 0]);            // TODO：你的表演
      root.updateMatrixWorld(true);
    },
  };
}
