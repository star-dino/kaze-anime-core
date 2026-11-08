import * as THREE from 'three';
import { celMaterial } from '../core/materials.js';
import { Rig, starPlate } from '../core/kit.js';
import { SoftBody } from '../core/organic.js';
import { createEyes } from '../core/face.js';
import { screenAll } from '../core/color.js';
import { onTwos, smooth, invLerp, noise1 } from '../core/util.js';
import { CUES, DINO } from './story.js';
import { terrain } from './world.js';

// 角色部门：星星恐龙。
// 造型方法（core/organic.js，学自 Sunshower 翠鸟）：
//   身体、脖子、头、口鼻、腮帮、腿脚、整条尾巴 = 一个 SoftBody（SDF 平滑并集）→ 一整张连续的皮，
//   没有零件接缝；按骨骼自动蒙皮，抬头、摇尾时皮肤平滑弯曲。
//   肚皮/下颌的奶油色、嘴线、鼻孔、腮红全部在着色器里按静止坐标“画”（celMaterial pattern），
//   颜色交界处没有描线，动起来也不游走。
//   眼睛 = core/face.js：画出来的虹膜和高光，眼神朝镜头；闭眼/笑眼/眯眼是贴在头皮上的笔画。
//   只有星形骨板和小手是独立零件（硬质的、需要大角度转动的部分）。
// 局部坐标：+Y 上，+Z 前（嘴的方向），+X 是它自己的左边。root 在两脚之间的地面上。

// 设定色（屏幕上要看到的颜色；screenAll 换算成管线输入色，见 core/color.js）
const PAL = screenAll({
  body: '#8ad66f', back: '#74c25e', belly: '#fff0c4', sole: '#5fae55', blush: '#ff9fb4',
  star: '#ffd447', starHi: '#fff1a8', ink: '#2a2236', mouthIn: '#8c2f45', tongue: '#ff8a9a',
  iris: '#2e2440', irisL: '#6f5a9a', pupil: '#100b18',
});

// ------------------------------------------------------------------ 设定（静止姿态，米）
const HIPS = [0, 1.05, 0];
const NECK = [0, 1.95, 0.42];
const HEAD = [0, 2.45, 0.62];
const THIGH = [0.5, 1.0, 0.05];
const ARM = [0.56, 1.72, 0.64];
const TAIL = [[0, 1.2, -0.7], [0, 1.0, -1.24], [0, 0.84, -1.72], [0, 0.74, -2.15], [0, 0.73, -2.52], [0, 0.82, -2.84]];
const TAIL_R = [0.56, 0.43, 0.32, 0.23, 0.15, 0.085];
const HEAD_C = [0, 3.02, 0.6];                 // 头颅中心（眼睛从这里找眼窝）

function shapeBody() {
  const b = new SoftBody({ k: 0.16 });
  b.ell('hips', [0, 1.28, -0.02], [0.84, 0.76, 0.94], { name: 'belly' });
  b.ell('hips', [0, 1.82, 0.3], [0.62, 0.56, 0.6], { name: 'chest', k: 0.22 });
  b.cone('neck', [0, 1.95, 0.42], [0, 2.4, 0.58], 0.5, 0.46, { k: 0.2 });
  b.ell('head', HEAD_C, [0.8, 0.7, 0.74], { name: 'cranium', k: 0.24 });
  b.ell('head', [0, 2.66, 1.08], [0.5, 0.32, 0.46], { name: 'snout', k: 0.22 });
  for (const s of [1, -1]) b.ell('head', [s * 0.4, 2.74, 0.88], [0.34, 0.28, 0.32], { k: 0.14 });   // 腮帮
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    b.ell('thigh' + L, [s * 0.52, 0.66, 0.06], [0.36, 0.5, 0.42], { k: 0.16 });
    b.ell('thigh' + L, [s * 0.54, 0.15, 0.22], [0.3, 0.16, 0.4], { k: 0.08, name: 'foot' + L });
  }
  for (let i = 0; i < 5; i++) b.cone('tail' + i, TAIL[i], TAIL[i + 1], TAIL_R[i], TAIL_R[i + 1], { k: i === 0 ? 0.24 : 0.03 });   // 相邻段半径在关节处相等：k 小 → 不鼓包
  return b;
}

// 皮肤花纹（静止空间）：肚皮 + 喉咙 + 下颌一条奶油色，嘴线是“上颌薄荷绿 / 下颌奶油色”的分界，
// 张嘴时在嘴线下面挖出口腔；腮红、鼻孔是贴花；脚底深一档。
const SKIN_GLSL = /* glsl */ `
float mouthY(float x){ return 2.665 + 0.55 * x * x; }
vec4 pattern(vec3 p, vec3 n){
  vec3 col = cBody;
  // 背脊一条深一档的薄荷绿（从后脑勺到尾尖），侧面看把体积“分面”
  float dors = step(0.62, n.y + 0.35 * step(p.z, 0.2)) * step(abs(p.x), 0.3 + 0.1 * step(p.z, -0.5)) * step(p.y, 3.1) * step(0.85, p.y);
  col = mix(col, cBack, dors);
  // 正面奶油色：宽度随高度变化（肚皮宽 → 喉咙窄）
  float y = p.y;
  float w = y < 1.55 ? 0.6 * sqrt(max(0.0, 1.0 - pow((y - 1.4) / 0.78, 2.0))) : mix(0.5, 0.3, smoothstep(1.55, 2.4, y));
  float front = step(0.18, n.z) * step(abs(p.x), w) * step(0.66, y) * step(y, 2.5);
  // 下颌：嘴线以下、口鼻前半
  float jaw = step(y, mouthY(p.x)) * step(0.62, p.z) * step(2.2, y) * step(-0.55, n.y + 0.4 * n.z);
  col = mix(col, cBelly, max(front, jaw));
  // 脚底
  col = mix(col, cSole, step(n.y, -0.55) * step(y, 0.22));
  float unlit = 0.0;
  // 嘴：嘴线 + 张嘴（口腔 + 舌头），只在口鼻正面
  float onSnout = step(0.95, p.z) * step(0.1, n.z);
  float ax = abs(p.x);
  float m = mouthY(p.x);
  float open = uMouth * 0.15 * max(0.0, 1.0 - pow(ax / 0.29, 2.0));
  float inMouth = step(m - open, y) * step(y, m) * step(ax, 0.29) * step(0.005, open) * onSnout;
  float tongue = inMouth * step(y, m - open * 0.55) * step(ax, 0.17);
  col = mix(col, mix(cMouthIn, cTongue, tongue), inMouth);
  unlit = max(unlit, inMouth * 0.6);
  float line = step(abs(y - m), 0.014 + 0.004 * uMouth) * step(ax, 0.34) * onSnout;
  line = max(line, step(abs(y - (m - open)), 0.012) * step(ax, 0.29) * onSnout * step(0.005, open));
  col = mix(col, cInk, line); unlit = max(unlit, line * 0.8);
  // 鼻孔、腮红（贴花：以表面上的点为中心的小球与皮肤相交 → 椭圆）
  float nose = max(step(length(p - uNoseL), 0.026), step(length(p - uNoseR), 0.026));
  col = mix(col, cInk, nose); unlit = max(unlit, nose * 0.8);
  float blush = max(step(length((p - uBlushL) * vec3(1.0, 1.35, 1.0)), 0.12), step(length((p - uBlushR) * vec3(1.0, 1.35, 1.0)), 0.12));
  col = mix(col, cBlush, blush); unlit = max(unlit, blush * 0.55);
  return vec4(col, unlit);
}`;

// 星形骨板：内圈一颗亮一档的小星（2D 五角星 SDF，iq）
const STAR_GLSL = /* glsl */ `
float sdStar5(vec2 p, float r, float rf){
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
vec4 pattern(vec3 p, vec3 n){
  float side = step(0.6, abs(n.x));
  float inner = step(sdStar5(vec2(p.z, p.y) / uStarR, 0.5, 0.45), 0.0) * side;
  return vec4(mix(cStar, cStarHi, inner), 0.0);
}`;

function build(ctx) {
  const rig = new Rig(celMaterial, 1, 60);
  const sub = (a, b) => a.map((x, i) => x - b[i]);
  // ---- 骨骼（静止姿态）
  rig.joint('hips', rig.root, HIPS);
  rig.joint('neck', 'hips', sub(NECK, HIPS));
  rig.joint('head', 'neck', sub(HEAD, NECK));
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    rig.joint('thigh' + L, 'hips', sub([s * THIGH[0], THIGH[1], THIGH[2]], HIPS));
    rig.joint('arm' + L, 'hips', sub([s * ARM[0], ARM[1], ARM[2]], HIPS));
  }
  let parent = 'hips', prev = HIPS;
  for (let i = 0; i < 5; i++) { rig.joint('tail' + i, parent, sub(TAIL[i], prev)); parent = 'tail' + i; prev = TAIL[i]; }
  rig.root.updateMatrixWorld(true);

  // ---- 皮
  const body = shapeBody();
  const P = (x, y, z) => body.project(new THREE.Vector3(x, y, z));
  const U = {
    uMouth: { value: 0 },
    uNoseL: P(0.13, 2.84, 1.54), uNoseR: P(-0.13, 2.84, 1.54),
    uBlushL: P(0.64, 2.72, 1.04), uBlushR: P(-0.64, 2.72, 1.04),
  };
  const skinMat = celMaterial({
    name: 'dinoSkin', id: 90, gloss: 0.12, wear: 0.06, rest: true, pattern: body.glsl() + SKIN_GLSL,
    colors: { cBody: PAL.body, cBack: PAL.back, cBelly: PAL.belly, cSole: PAL.sole, cBlush: PAL.blush, cInk: PAL.ink, cMouthIn: PAL.mouthIn, cTongue: PAL.tongue },
    uniforms: U,
  });
  const skin = body.build(skinMat, { cell: ctx.params?.get('cell') ? parseFloat(ctx.params.get('cell')) : 0.03, blend: 0.22 });
  skin.mesh.name = 'dinoSkin';
  rig.root.add(skin.mesh);
  skin.bind(rig.j, rig.root);

  // ---- 小手：一个小 SoftBody（静态，挂在肩关节上）
  const armMat = celMaterial({ name: 'dinoArm', color: PAL.body, id: 90, gloss: 0.12, wear: 0.06 });
  const armGeo = new SoftBody({ k: 0.07 })
    .cone('a', [0, 0, 0], [0, -0.3, 0.12], 0.14, 0.12)
    .ell('a', [0, -0.35, 0.15], [0.13, 0.12, 0.14])
    .geometry({ cell: 0.02 });
  for (const L of ['L', 'R']) { const m = new THREE.Mesh(armGeo, armMat); m.name = 'arm' + L; rig.j['arm' + L].add(m); }

  // ---- 星形骨板：沿背脊打射线找皮面，星的下半截埋进皮里
  const plates = [
    ['head', [0, 3.05, 0.5], [0, 1, -0.3], 0.23],
    ['hips', [0, 1.7, 0.2], [0, 1, -0.55], 0.27],
    ['hips', [0, 1.4, -0.1], [0, 1, -0.75], 0.31],
    ['tail0', [0, 1.15, -0.85], [0, 1, -0.25], 0.25],
    ['tail1', [0, 0.95, -1.45], [0, 1, -0.05], 0.19],
    ['tail2', [0, 0.8, -1.92], [0, 1, 0.05], 0.14],
    ['tail3', [0, 0.74, -2.3], [0, 1, 0.1], 0.1],
  ];
  const v = new THREE.Vector3();
  for (const [bone, from, dir, R] of plates) {
    const hit = body.raySurface(new THREE.Vector3(...from), new THREE.Vector3(...dir));
    const n = body.normal(hit);
    const c = hit.clone().addScaledVector(n, R * 0.42);
    const mat = celMaterial({ name: 'dinoStar', id: 93, gloss: 1.3, wear: 0.03, pattern: STAR_GLSL, colors: { cStar: PAL.star, cStarHi: PAL.starHi }, uniforms: { uStarR: { value: R } } });
    const m = new THREE.Mesh(starPlate(R, R * 0.46, R * 0.32), mat);
    m.name = 'star';
    const j = rig.j[bone];
    m.position.copy(j.worldToLocal(v.copy(c)));
    m.rotation.x = Math.atan2(n.z, n.y);           // 星的上尖顺着皮面法线
    j.add(m);
  }

  // ---- 眼睛
  const face = createEyes({
    body, joint: rig.j.head, root: rig.root, center: HEAD_C,
    dirs: [[0.36, 0.24, 0.9], [-0.36, 0.24, 0.9]], radius: 0.2, oval: [0.84, 1.22, 0.56], sink: 0.5,
    palette: { iris: PAL.iris, irisL: PAL.irisL, pupil: PAL.pupil, ink: PAL.ink },
  });

  // 锚点：特效/镜头/音频只读这些
  rig.anchor('head', 'head', sub([0, 3.0, 0.9], HEAD));
  rig.anchor('mouth', 'head', sub([0, 2.66, 1.44], HEAD));
  rig.anchor('tailTip', 'tail4', sub(TAIL[5], TAIL[4]));
  rig.anchor('chest', 'hips', sub([0, 1.7, 0.8], HIPS));
  return { rig, skin, face, U };
}

// 整场表演：t 的纯函数（一拍二），返回各关节角度和根的位移/缩放，以及表情
export function dinoPose(t) {
  const c = CUES;
  const ta = onTwos(t);
  // 抬头看星星 → 视线跟着星星落到海面
  const up = smooth(invLerp(c.lookUp[0], c.lookUp[1], ta));
  const follow = smooth(invLerp(c.streak, c.impact, ta));
  let pitch = 6 - 34 * up + 36 * follow;          // 负 = 抬头
  let yaw = -14 * up + 26 * follow;               // 星星从它右边（局部 -X）落向左前方
  pitch += noise1(ta * 0.5, 3) * 1.5;             // 呼吸感：极轻的漂移
  // 尾巴：平时慢摇，入水后兴奋地快摇
  const ex = smooth(invLerp(c.impact, c.impact + 0.8, ta));
  const wag = Math.sin(ta * (3 + 6 * ex)) * (6 + 16 * ex);
  // 跳跃：预备压扁 → 腾空拉长 → 落地压扁 → 回弹
  const jump = (j, h) => {
    const [a, b] = j;
    if (ta < a - 0.15 || ta > b + 0.2) return null;
    if (ta < a) return { y: 0, sq: 1 - 0.14 * smooth(invLerp(a - 0.15, a, ta)), arms: 0 };
    if (ta < b) { const u = (ta - a) / (b - a); return { y: 4 * h * u * (1 - u), sq: 1 + 0.1 * (1 - u) - 0.04 * u, arms: 1 }; }
    const u = (ta - b) / 0.2;
    return { y: 0, sq: 1 - 0.12 * Math.sin(u * Math.PI) * (1 - u * 0.5), arms: 1 - u };
  };
  const J = jump(c.jump, 0.75) ?? jump(c.hop2, 0.35) ?? { y: 0, sq: 1, arms: 0 };
  if (J.y > 0) pitch -= 10;
  // 表情（原画张：换张即切换，不插值）
  let expr = 'open';
  const at = (a, b) => ta >= a - 1e-6 && ta < b - 1e-6;
  if (at(1.5, 1.67) || at(c.impact + 0.25, c.impact + 0.42)) expr = 'closed';      // 眨眼
  if (at(c.jump[0] - 0.12, c.jump[1] + 0.15) || ta >= c.hop2[0] - 0.12) expr = 'happy';
  const mouth = Math.max(0.45 * smooth(invLerp(c.impact + 0.1, c.impact + 0.4, ta)), J.arms > 0 ? 1 : 0);
  return { pitch, yaw, wag, y: J.y, sq: J.sq, arms: J.arms, ex, expr, mouth };
}

export function createDino(ctx) {
  const { rig, skin, face, U } = build(ctx);
  const root = rig.root;
  root.name = 'dino';
  root.rotation.y = Math.PI;                       // 面朝 -Z（大海）
  const gy = terrain(DINO[0], DINO[1]);
  root.position.set(DINO[0], gy, DINO[1]);
  ctx.scene.add(root);
  ctx.shadowRoots.push(root);                      // 只有角色投影

  // 设定图/表情表用的覆盖：?pose=rest（静止姿态）&expr=happy&mouth=1
  const Q = ctx.params;
  const forceRest = Q?.get('pose') === 'rest';
  const forceExpr = Q?.get('expr');
  const forceMouth = Q?.get('mouth');

  return {
    rig, root, skin, face,
    update(st) {
      const p = forceRest ? { pitch: 0, yaw: 0, wag: 0, y: 0, sq: 1, arms: 0, ex: 0, expr: 'open', mouth: 0 } : dinoPose(st.t);
      root.position.y = gy + p.y;
      const sq = p.sq;
      root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
      rig.rot('neck', [p.pitch * 0.4, p.yaw * 0.4, 0]);
      rig.rot('head', [p.pitch * 0.6, p.yaw * 0.6, -p.yaw * 0.1]);
      for (let i = 0; i < 5; i++) rig.rot('tail' + i, [forceRest ? 0 : -4 + i * 2, p.wag * (0.5 + i * 0.25) * Math.cos(i * 0.5), 0]);
      for (const [s, L] of [[1, 'L'], [-1, 'R']]) rig.rot('arm' + L, [-20 - 110 * p.arms, 0, s * (10 + 40 * p.arms)]);
      rig.rot('thighL', [p.y > 0 ? -18 : 0, 0, 0]);
      rig.rot('thighR', [p.y > 0 ? -10 : 0, 0, 0]);
      root.updateMatrixWorld(true);
      skin.update();
      face.set(forceExpr ?? p.expr);
      U.uMouth.value = forceMouth != null ? parseFloat(forceMouth) : p.mouth;
      face.aim(ctx.camera);
      ctx.dinoHead = rig.at('head');               // 给特效/镜头读
    },
  };
}
