import * as THREE from 'three';
import { celMaterial } from './materials.js';
import { surf, sphereFn, stroke, basisZ } from './organic.js';
import { deg } from './util.js';

// 动画式的眼睛（来自原作 kf3d-model.js 的翠鸟眼睛 + kingfisher3d.js 的 aimEyes，MIT）：
//   - 眼球是一个半埋进头部表面的球，虹膜 / 瞳孔 / 两个高光全部在着色器里“画”出来（高光不受光、进泛光）；
//   - 眼球每帧转向镜头（限制在眼窝的一个锥角内）→ 任何机位都有高光点，“眼神”永远在；
//   - 闭眼 ‿、笑眼 ∩、眯眼 >< 是贴在头皮上的墨线笔画（stroke），不是 3D 眼皮 —— 动画眼睛的标准画法。
// 眼睛与笔画都挂在头部关节上（头部的皮在蒙皮里权重≈1，所以刚性跟随，不会错位）。
//
// createEyes(o)：
//   body     SoftBody（角色根节点静止空间），用来找头皮表面、把笔画贴上去
//   joint    眼睛挂在哪个关节（Object3D，例如 rig.j.head）；调用时角色须处于静止姿态
//   center   头部中心（静止空间），从这里沿 dirs 打射线找眼窝
//   dirs     每只眼睛的方向（静止空间），例如 [[0.45, 0.12, 0.88], [-0.45, 0.12, 0.88]]
//   radius   眼球半径；oval：眼球在眼窝坐标系（x 横, y 竖, z 出）里的缩放，竖长的椭圆更“动画”
//   sink     眼球中心埋进表面的深度（× 半径）；cone 眼神可偏离眼窝法线的最大角度（度）
//   inward   每只眼睛“朝鼻梁”的横向（静止空间），决定 >< 的尖朝哪边；默认按 x 符号取 (-sign(x), 0, 0)
//   palette  { iris, irisL, pupil, hi, ink }；id 描线 id（与皮肤不同 → 眼睛自动有一圈轮廓）
//   strokeW  笔画粗细（米）
//   inkLine  （可选）眼睛这个 id 的描线色（屏幕色，见 celMaterial 的 ink）；不给就用引擎默认墨色
// 返回 { eyes, set(expr), aim(camera), exprs }   expr ∈ 'open' | 'closed' | 'happy' | 'squint'

const V = THREE.Vector3;

export const EYE_GLSL = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  vec3 d = normalize(p);
  if(d.z < 0.0) return vec4(cPupil, 0.0);
  vec2 q = d.xy;
  vec3 col = cIris;
  // 下半部一弯亮色（动画眼的“反光层”）
  col = mix(col, cIrisL, step(0.18, -q.y + 0.4 * q.x * q.x) * step(length(q), 0.7));
  // 瞳孔
  col = mix(col, cPupil, step(length((q - vec2(0.0, 0.04)) * vec2(1.0, 0.85)), 0.34));
  // 高光：一大一小，平涂、亮于 1 → 进泛光
  float h1 = step(length((q - vec2(0.2, 0.26)) * vec2(1.0, 1.1)), 0.2);
  float h2 = step(length(q - vec2(-0.22, -0.25)), 0.085);
  float h = max(h1, h2);
  return vec4(mix(col, cHi * 1.15, h), h);
}`;

export const INK_GLSL = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){ return vec4(cInk, 0.75); }`;

export function createEyes(o) {
  const body = o.body, joint = o.joint;
  const R = o.radius ?? 0.1, sink = o.sink ?? 0.45, cone = o.cone ?? 38;
  const oval = o.oval ?? [0.9, 1.15, 0.7];
  const pal = { iris: '#3a2a3a', irisL: '#8a5a4a', pupil: '#120c18', hi: '#ffffff', ink: '#2a2236', ...(o.palette ?? {}) };
  const id = o.id ?? 92;
  const M = {
    eye: celMaterial({ name: 'eye', id, gloss: 2.4, wear: 0, pattern: EYE_GLSL, colors: { cIris: pal.iris, cIrisL: pal.irisL, cPupil: pal.pupil, cHi: pal.hi }, ...(o.inkLine ? { ink: o.inkLine } : {}) }),
    ink: celMaterial({ name: 'eyeInk', id, gloss: 0, wear: 0, pattern: INK_GLSL, colors: { cInk: pal.ink } }),
  };
  // 静止空间 → 关节局部
  joint.updateWorldMatrix(true, false);
  const root = o.root ?? findRoot(joint);
  root.updateMatrixWorld(true);
  const toJoint = new THREE.Matrix4().copy(joint.matrixWorld).invert().multiply(root.matrixWorld);
  const J = (p) => p.clone().applyMatrix4(toJoint);

  const center = new V(...o.center);
  const ballGeo = surf(sphereFn(R), 32, 24);
  const eyes = [];
  const w = o.strokeW ?? R * 0.16;
  for (const dv of o.dirs) {
    const dir = new V(...dv).normalize();
    const hit = body.raySurface(center, dir);
    const n = body.normal(hit);
    const side = dir.x >= 0 ? 1 : -1;
    // 眼窝坐标系：z = 表面法线，y = 尽量朝上，x = 横向
    const qRest = basisZ(n, new V(0, 1, 0));
    const c = hit.clone().addScaledVector(n, -R * sink);
    const pivot = new THREE.Group(); pivot.name = 'eye' + (side > 0 ? 'L' : 'R');
    pivot.position.copy(J(c));
    // 关节局部的朝向 = toJoint 的旋转 · 静止朝向
    const qJ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(toJoint));
    pivot.quaternion.copy(qJ.multiply(qRest));
    pivot.scale.set(...oval);
    joint.add(pivot);
    const ball = new THREE.Mesh(ballGeo, M.eye); ball.name = 'eyeball';
    pivot.add(ball);

    // ---- 笔画：在眼窝切平面里画，再投影回头皮（静止空间），最后变到关节局部
    const inward = o.inward ? new V(...o.inward[eyes.length]) : new V(-side, 0, 0);
    const t = inward.clone().addScaledVector(n, -inward.dot(n)).normalize();       // +t 朝鼻梁
    const up = new V().crossVectors(n, t); if (up.y < 0) up.negate();
    const rx = R * oval[0] * 1.05, ry = R * oval[1] * 1.0;
    const P = (a, b, lift = w * 0.8) => {
      const q = hit.clone().addScaledVector(t, a * rx).addScaledVector(up, b * ry);
      const s = body.project(q);
      return J(s.addScaledVector(body.normal(s), lift));
    };
    const grp = (name) => { const g = new THREE.Group(); g.name = name; g.visible = false; joint.add(g); return g; };
    const mk = (g, pts, r, so) => { const m = new THREE.Mesh(stroke(pts, r, so), M.ink); g.add(m); return m; };
    // 闭眼：一条下弯的弧 + 外眼角一根小睫毛
    const closed = grp('closed');
    mk(closed, [P(1.0, 0.0), P(0.5, -0.32), P(-0.15, -0.42), P(-0.75, -0.25), P(-1.05, 0.05)], w);
    mk(closed, [P(-0.85, -0.15), P(-1.1, -0.35), P(-1.35, -0.5)], w * 0.7, { segs: 8, taper: 0.45 });
    // 笑眼 ∩
    const happy = grp('happy');
    mk(happy, [P(1.0, -0.2), P(0.55, 0.28), P(-0.1, 0.45), P(-0.7, 0.25), P(-1.05, -0.15)], w * 1.05);
    // 眯眼 >：尖朝鼻梁
    const squint = grp('squint');
    mk(squint, [P(-0.95, 0.75), P(-0.2, 0.38), P(0.55, 0.02)], w, { segs: 12, taper: 0.35 });
    mk(squint, [P(0.55, -0.02), P(-0.2, -0.36), P(-0.95, -0.72)], w, { segs: 12, taper: 0.35 });
    eyes.push({ side, pivot, ball, closed, happy, squint, nrm: new V(0, 0, 1) });
  }

  let expr = 'open';
  function set(e) {
    expr = e;
    for (const E of eyes) {
      E.ball.visible = e === 'open';
      E.closed.visible = e === 'closed';
      E.happy.visible = e === 'happy';
      E.squint.visible = e === 'squint';
    }
  }
  set('open');

  // 眼神朝镜头：在眼窝局部坐标里求镜头方向，限制在锥角内
  const camL = new V(), dirE = new V(), tmp = new V(), xE = new V(), yE = new V(), mE = new THREE.Matrix4();
  const lim = Math.cos(deg(cone));
  function aim(camera, offset) {
    for (const E of eyes) {
      if (!E.ball.visible) continue;
      E.pivot.updateWorldMatrix(true, false);
      camL.copy(camera.position);
      E.pivot.worldToLocal(camL);
      dirE.copy(camL).normalize();
      if (offset) dirE.add(tmp.set(...offset)).normalize();     // 表演用：往某个方向“看”
      const c = dirE.z;
      if (c < lim) {
        tmp.copy(dirE).setZ(0);
        if (tmp.lengthSq() < 1e-8) dirE.set(0, 0, 1);
        else dirE.copy(tmp.normalize().multiplyScalar(Math.sqrt(1 - lim * lim))).setZ(lim);
      }
      xE.crossVectors(tmp.set(0, 1, 0), dirE).normalize();
      yE.crossVectors(dirE, xE);
      mE.makeBasis(xE, yE, dirE);
      E.ball.quaternion.setFromRotationMatrix(mE);
    }
  }
  return { eyes, set, aim, get expr() { return expr; }, M };
}

function findRoot(o) { while (o.parent && !o.parent.isScene) o = o.parent; return o; }
