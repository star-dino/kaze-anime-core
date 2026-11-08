import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rig } from '../../core/kit.js';
import { SoftBody } from '../../core/organic.js';
import { screenAll } from '../../core/color.js';
import { terrain } from '../../story/world.js';

// R1 / R2 的最小示例：两只“方头 + 椭球身体”的测试角色并排站着。
//   左（A）：旧做法 —— 默认 celMaterial（亮色 × 薰衣草暗部、反弹光、第三色），真实法线受光。
//   右（B）：新做法（从海上看过去的左右） —— 头用圆角盒（R2，收分做鼻子），头/身各一个明暗代理（R1 shadeProxy），
//           单层阴影色 shade、描线色 ink、wear 0。
// 验收：正面 / 四分之三 / 侧面三张图里 B 的脸上只有下巴下面一块阴影；太阳从 30° 转到 150°，阴影形状平滑变化。
export const PROXY_AT = [-12, -6.4];     // 两只角色的中点（x, z），站在崖边、面朝 -Z（大海）

const PAL = screenAll({ body: '#b5814f', chin: '#d8b48a', chinShade: '#a8826a', nose: '#3a2a22' });

const SKIN = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  vec3 c = cBody;
  // 下巴/喉咙一块弧形浅色（有形状的色块，不是横平竖直的色带）
  float chin = step(p.y, 0.29 + 0.2 * (p.z - 0.2)) * step(0.14, p.z) * step(abs(p.x), 0.085);
  c = mix(c, cChin, chin);
  if(chin > 0.5) gShade = cChinShade;                  // 浅色块显式给暗部色（不给就按 shade/color 的比例，会偏紫）
  // 鼻头
  float nose = step(0.405, p.z) * step(0.365, p.y);
  c = mix(c, cNose, nose);
  if(nose > 0.5) gShade = cNose * 0.7;
  return vec4(c, 0.0);
}`;

function makeOne(ctx, x, modern) {
  const rig = new Rig(celMaterial, 1, 60);
  rig.joint('hips', rig.root, [0, 0.2, 0]);
  rig.joint('head', 'hips', [0, 0.14, 0.18]);
  rig.root.updateMatrixWorld(true);
  const b = new SoftBody({ k: 0.03 });
  b.ell('hips', [0, 0.22, -0.02], [0.17, 0.16, 0.27], { name: 'torso' });
  b.ell('hips', [0, 0.3, 0.13], [0.12, 0.12, 0.12], { k: 0.03, name: 'neck' });       // 脖子：让头和身体之间是两块大肉相融
  b.box('head', [0, 0.36, 0.28], [0.11, 0.1, 0.14], 0.06, { k: 0.02, taper: [0.25, 0.2], rot: [8, 0, 0], name: 'head' });
  for (const s of [1, -1]) {
    b.ell('head', [s * 0.07, 0.465, 0.2], [0.025, 0.03, 0.022], { k: 0.005 });           // 小耳朵
    b.cone('hips', [s * 0.09, 0.14, 0.12], [s * 0.09, 0.0, 0.13], 0.045, 0.04, { k: 0.012 });
    b.cone('hips', [s * 0.1, 0.14, -0.16], [s * 0.1, 0.0, -0.16], 0.05, 0.042, { k: 0.012 });
  }
  if (modern) {
    b.shadeProxy('head', [0, 0.35, 0.25], { r: [0.12, 0.12, 0.17], k: 0.9 });
    b.shadeProxy('hips', [0, 0.2, -0.02], { r: [0.19, 0.18, 0.29], k: 0.7 });
  }
  const mat = celMaterial({
    name: modern ? 'proxyB' : 'proxyA', id: modern ? 21 : 20, rest: true, gloss: modern ? 0.05 : 1, wear: modern ? 0 : 0.6,
    pattern: SKIN, colors: { cBody: PAL.body, cChin: PAL.chin, cChinShade: PAL.chinShade, cNose: PAL.nose },
    ...(modern ? { shadeNormal: true, color: '#b5814f', shade: '#7d5a52', ink: '#3a2a22' } : {}),
  });
  const skin = b.build(mat, { cell: 0.012, name: modern ? 'proxyB' : 'proxyA' });
  rig.root.add(skin.mesh);
  skin.bind(rig.j, rig.root);
  const y = terrain(x, PROXY_AT[1]);
  rig.root.position.set(x, y, PROXY_AT[1]);
  rig.root.rotation.y = Math.PI;
  ctx.scene.add(rig.root);
  ctx.shadowRoots.push(rig.root);
  return { rig, skin };
}

export function createProxyTest(ctx) {
  const A = makeOne(ctx, PROXY_AT[0] + 0.35, false);     // 从海上看：左边是 A（旧），右边是 B（新）
  const B = makeOne(ctx, PROXY_AT[0] - 0.35, true);
  return {
    update(st) {
      // 头轻轻点一下（测试代理中心是否跟着骨骼走）
      const nod = st.shot === 'proxy' ? Math.sin(st.lt * 1.6) * 10 : 0;
      for (const C of [A, B]) {
        C.rig.rot('head', [nod, nod * 0.6, 0]);
        C.rig.root.updateMatrixWorld(true);
        C.skin.update();
      }
    },
  };
}
