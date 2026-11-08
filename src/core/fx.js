import * as THREE from 'three';
import { hash } from './util.js';
import { OCCLUDE } from './materials.js';
import { glowMaterial, lineMaterial, motionArcMaterial } from './materials.js';

// 无状态特效工具（思路来自 LEVIATHAN fx-energy-core.js / fx-splash-core.js，MIT）。
// 每帧：begin() 清空 → 根据 t 重新 push 全部粒子/线条 → end() 上传。
// 没有任何“上一帧的状态”，所以第 500 帧可以在第 3 帧之前渲染。

// ---------------------------------------------------------- 发光精灵批次（instanced，overlay）
export const GLOW = { soft: 0, kira: 1, ring: 2 };
export class GlowBatch {
  constructor(max = 512) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aK = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aM = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    for (const a of [this.aPos, this.aC, this.aK, this.aM]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iC', this.aC); g.setAttribute('iK', this.aK); g.setAttribute('iM', this.aM);
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, glowMaterial());
    this.mesh.frustumCulled = false;
    this.n = 0;
  }
  begin() { this.n = 0; }
  // o: { kind, m (半径/米), px (半径/输出像素), color [r,g,b], power, rot, mode (遮挡模式 0/1/2), bias (米) }
  push(p, o) {
    if (this.n >= this.max || (o.power ?? 1) <= 0) return;
    const i = this.n++, c = o.color ?? [0.5, 0.85, 1];
    this.aPos.array.set([p.x, p.y, p.z], i * 3);
    this.aC.array.set([c[0], c[1], c[2], o.power ?? 1], i * 4);
    this.aK.array.set([o.kind ?? 0, o.m ?? 0, o.px ?? 0, o.rot ?? 0], i * 4);
    this.aM.array.set([o.mode ?? 0, o.bias ?? 1], i * 2);
  }
  end() {
    this.geo.instanceCount = this.n;
    for (const a of [this.aPos, this.aC, this.aK, this.aM]) a.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

// ---------------------------------------------------------- 屏幕空间线条批次（overlay）
export class LineBatch {
  constructor(maxVerts = 20000) {
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    const mk = (n) => { const a = new THREE.BufferAttribute(new Float32Array(maxVerts * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aPrev = mk(3); this.aNext = mk(3); this.aA = mk(4); this.aC = mk(4); this.aR = mk(1);
    g.setAttribute('position', this.aPos); g.setAttribute('aPrev', this.aPrev); g.setAttribute('aNext', this.aNext);
    g.setAttribute('aA', this.aA); g.setAttribute('aC', this.aC); g.setAttribute('aR', this.aR);
    this.idx = new THREE.BufferAttribute(new Uint32Array(maxVerts * 3), 1);
    this.idx.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, lineMaterial());
    this.mesh.frustumCulled = false;
    this.nv = 0; this.ni = 0;
  }
  begin() { this.nv = 0; this.ni = 0; }
  // pts: Vector3[]; o: { px 宽度(输出像素), width(s) 沿线宽度函数, color [r,g,b], power, alpha(s),
  //                      mode (遮挡模式), rim (深色外缘 0..1：亮背景上必须开) }
  push(pts, o = {}) {
    const n = pts.length;
    if (n < 2 || this.nv + n * 2 > this.max) return;
    const px = o.px ?? 3, col = o.color ?? [0.3, 0.75, 1], pw = o.power ?? 1, mode = o.mode ?? 0, rim = o.rim ?? 0;
    const base = this.nv;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1), p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const wk = o.width ? o.width(s) : 1, al = o.alpha ? o.alpha(s) : 1;
      for (let sd = 0; sd < 2; sd++) {
        const k = this.nv++;
        this.aPos.array.set([p.x, p.y, p.z], k * 3);
        this.aPrev.array.set([a.x, a.y, a.z], k * 3);
        this.aNext.array.set([b.x, b.y, b.z], k * 3);
        this.aA.array.set([sd ? 1 : -1, s, px * wk, mode], k * 4);
        this.aC.array.set([col[0], col[1], col[2], pw * al], k * 4);
        this.aR.array[k] = rim;
      }
      if (i < n - 1) {
        const q = base + i * 2, ia = this.idx.array, k = this.ni;
        ia[k] = q; ia[k + 1] = q + 1; ia[k + 2] = q + 2; ia[k + 3] = q + 1; ia[k + 4] = q + 3; ia[k + 5] = q + 2;
        this.ni += 6;
      }
    }
  }
  end() {
    this.geo.setDrawRange(0, this.ni);
    for (const a of [this.aPos, this.aPrev, this.aNext, this.aA, this.aC, this.aR, this.idx]) a.needsUpdate = true;
    this.mesh.visible = this.ni > 0;
  }
}

// ---------------------------------------------------------- 闪电路径
// 中点位移：长直段 + 锐利折角，位移方向限定在屏幕平面（R 右、U 上），保证在画面上“读得出”锯齿。
// seed 用“原画张数”（drawing(t, 8)）→ 一拍三换形，像手绘闪电一样“闪”，而不是噪声那样“沸腾”。
export function boltPts(a, b, seed, R, U, rough = 0.24, levels = 5) {
  let pts = [a.clone(), b.clone()];
  let amp = a.distanceTo(b) * rough;
  for (let l = 0; l < levels; l++) {
    const nx = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const m = new THREE.Vector3().lerpVectors(p, q, 0.3 + 0.4 * hash(seed, l * 31 + 1, i));
      m.addScaledVector(R, (hash(seed, l * 31 + 2, i) - 0.5) * 2 * amp).addScaledVector(U, (hash(seed, l * 31 + 3, i) - 0.5) * 2 * amp);
      nx.push(m, q);
    }
    pts = nx;
    amp *= 0.5;
  }
  return pts;
}

// ---------------------------------------------------------- 水面涟漪槽位（写进水面 pass 的 uRip/uRipB/uRipC）
// 最多 24 个同时存在（MAX_RIP）。超出的会被丢弃 —— 按重要性先 push 主要的涟漪。
// glow：{ color:'#hex' | [r,g,b], power } —— 发光涟漪（生物荧光、魔法），power 1 左右正常亮、>1 进泛光
const _gc = new THREE.Color();
export class Ripples {
  constructor(waterUniforms) { this.U = waterUniforms; this.n = 0; this.max = waterUniforms.uRip.value.length; }
  begin() {
    this.n = 0;
    for (const r of this.U.uRip.value) r.set(0, 0, 0, 0);
    if (this.U.uRipC) for (const r of this.U.uRipC.value) r.set(0, 0, 0, 0);
    if (this.U.uRipN) this.U.uRipN.value = 0;
  }
  // x, z, 起始时间(要和 uFxTime 同一时基，即一拍三), 振幅, 速度, 环宽, 衰减, 泡沫, 发光
  push(x, z, t0, amp = 0.25, speed = 2, width = 0.4, decay = 0.5, foam = 1, glow = null) {
    if (this.n >= this.max) return false;
    const i = this.n++;
    this.U.uRip.value[i].set(x, z, t0, amp);
    this.U.uRipB.value[i].set(speed, width, decay, foam);
    if (glow && this.U.uRipC) {
      const c = Array.isArray(glow.color) ? glow.color : (_gc.set(glow.color ?? '#7ff0e0'), [_gc.r, _gc.g, _gc.b]);
      this.U.uRipC.value[i].set(c[0], c[1], c[2], glow.power ?? 1);
    }
    if (this.U.uRipN) this.U.uRipN.value = this.n;
    return true;
  }
  end() {}
}

// ---------------------------------------------------------- 高速旋转虚影（C3，overlay）
// 风杯、螺旋桨、风扇、车轮转快了以后，动画里画的是“几道半透明的弧形残影”，不是实心圆盘。
// 主渲染 MRT 是不透明硬裁切 + 描线 + 双面赛璐璐光照，在里面做半透明盘会变成实心几何体并触发描线。
// 所以放在 overlay：不进笔触、不描线、预乘 alpha 混合，读 uSceneData 做软遮挡（mode 同 GlowBatch：0/1/2）。
//   const arcs = new MotionArcBatch(64); overlay.add(arcs.mesh);
//   每帧：arcs.begin(); arcs.blur({ center, axis, rInner, rOuter, angle, omega, blades: 3, color, alpha }); arcs.end();
// 全部由 (center, axis, angle, omega) 决定 —— 角度请用预积分的 angle(t)（例如 weather.js 的 cupAngle），不要累加。
const _ax = new THREE.Vector3(), _u0 = new THREE.Vector3(), _v0 = new THREE.Vector3(), _c0 = new THREE.Vector3();
const v3 = (p, out) => (p.isVector3 ? out.copy(p) : out.set(p[0], p[1], p[2]));
export class MotionArcBatch {
  constructor(maxArcs = 64, maxSeg = 48) {
    this.maxV = maxArcs * (maxSeg + 1) * 2; this.maxSeg = maxSeg;
    const g = new THREE.BufferGeometry();
    const mk = (n) => { const a = new THREE.BufferAttribute(new Float32Array(this.maxV * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aUV = mk(2); this.aC = mk(4); this.aM = mk(4);
    g.setAttribute('position', this.aPos); g.setAttribute('aUV', this.aUV); g.setAttribute('aC', this.aC); g.setAttribute('aM', this.aM);
    this.idx = new THREE.BufferAttribute(new Uint32Array(maxArcs * maxSeg * 6), 1);
    this.idx.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, motionArcMaterial());
    this.mesh.frustumCulled = false;
    this.nv = 0; this.ni = 0;
  }
  begin() { this.nv = 0; this.ni = 0; }
  // 一道弧形残影：o = { center, axis (转轴), ref? (角度 0 的方向，默认取与转轴垂直的水平方向), rInner, rOuter (m),
  //   angle (头部角，弧度), sweep (尾巴拖多长，弧度；正 = 尾巴在 angle 的负方向), color [r,g,b], alpha,
  //   streaks (径向条纹数，0 = 平滑), mode (遮挡模式 0/1/2), bias (m) }
  push(o) {
    const sweep = o.sweep ?? 1, n = Math.min(this.maxSeg, Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 24))));
    if ((o.alpha ?? 1) <= 0.002 || this.nv + (n + 1) * 2 > this.maxV) return;
    v3(o.axis ?? [0, 1, 0], _ax).normalize();
    if (o.ref) v3(o.ref, _u0); else { _u0.set(0, 1, 0).cross(_ax); if (_u0.lengthSq() < 1e-6) _u0.set(1, 0, 0); }
    _u0.addScaledVector(_ax, -_u0.dot(_ax)).normalize();
    _v0.crossVectors(_ax, _u0);
    v3(o.center, _c0);
    const r0 = o.rInner ?? 0, r1 = o.rOuter ?? 1, a0 = o.angle ?? 0, col = o.color ?? [1, 1, 1];
    const base = this.nv, P = this.aPos.array;
    for (let i = 0; i <= n; i++) {
      const u = i / n, th = a0 - sweep * (1 - u), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 2; k++) {
        const r = k ? r1 : r0, j = this.nv++;
        P[j * 3] = _c0.x + r * (c * _u0.x + s * _v0.x);
        P[j * 3 + 1] = _c0.y + r * (c * _u0.y + s * _v0.y);
        P[j * 3 + 2] = _c0.z + r * (c * _u0.z + s * _v0.z);
        this.aUV.array.set([u, k], j * 2);
        this.aC.array.set([col[0], col[1], col[2], o.alpha ?? 1], j * 4);
        this.aM.array.set([o.mode ?? 0, o.bias ?? 0.1, o.streaks ?? 0, 0], j * 4);
      }
      if (i < n) {
        const q = base + i * 2, ia = this.idx.array, k = this.ni;
        ia[k] = q; ia[k + 1] = q + 1; ia[k + 2] = q + 2; ia[k + 3] = q + 1; ia[k + 4] = q + 3; ia[k + 5] = q + 2;
        this.ni += 6;
      }
    }
  }
  // 便捷：按角速度自动出残影。blades 片叶 / 杯各拖一道弧；|omega| 在 [omegaLo, omegaHi] rad/s 之间淡入
  // （低速时 = 0，交给真实零件；高速时弧长 = |omega| × shutter，最长到叶间距的 85%）
  blur(o) {
    const w = o.omega ?? 0, aw = Math.abs(w);
    const k = smoothstepJS(o.omegaLo ?? 6, o.omegaHi ?? 18, aw);
    if (k <= 0) return;
    const blades = o.blades ?? 3, gap = (Math.PI * 2) / blades;
    const sweep = Math.min(aw * (o.shutter ?? 0.06), gap * 0.85) * Math.sign(w || 1);
    for (let b = 0; b < blades; b++) this.push({ ...o, angle: (o.angle ?? 0) + b * gap, sweep, alpha: (o.alpha ?? 0.45) * k });
  }
  end() {
    this.geo.setDrawRange(0, this.ni);
    for (const a of [this.aPos, this.aUV, this.aC, this.aM, this.idx]) a.needsUpdate = true;
    this.mesh.visible = this.ni > 0;
  }
}
const smoothstepJS = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------- 风中飞散物（W2，overlay）
// 草屑、沙粒、花瓣、土块：每个粒子 = 一小块赛璐璐色块（细长条 / 小点 / 小椭圆花瓣），带一圈深色描线边 + 一档高光，
// 沿运动方向拉长；姿态（翻转、朝向）一拍三换。不发光、不写实 —— 和角色的画法一致。
//   const flecks = new FleckBatch(2048); overlay.add(flecks.mesh)
//   每帧：flecks.begin(); emitStream(flecks, t, {...}); dustBurst(flecks, p, t, t0, {...}); flecks.end();
export const FLECK = { strip: 0, dot: 1, petal: 2 };
function fleckMaterial() {
  const u = { uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uInk: { value: new THREE.Color('#2a2236') } };
  const vs = /* glsl */ `
    attribute vec3 iPos;
    attribute vec3 iDir;    // 运动方向（世界，已归一化）
    attribute vec4 iS;      // 长(m), 宽(m), kind, 翻转 0..1（花瓣“翻面”时变窄）
    attribute vec4 iC;      // rgb, alpha
    attribute vec2 iM;      // 遮挡模式, 偏差(m)
    uniform vec2 uRes;
    varying vec2 vP; varying vec4 vC; varying vec4 vS; varying float vDepth; varying vec2 vM;
    void main(){
      vec4 mv = viewMatrix * vec4(iPos, 1.0);
      vec2 d = (viewMatrix * vec4(iDir, 0.0)).xy;
      d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
      vec2 nrm = vec2(-d.y, d.x);
      float pxPerM = projectionMatrix[1][1] * 0.5 * uRes.y / max(-mv.z, 0.1);
      float len = max(iS.x, 2.2 / pxPerM), wid = max(iS.y * mix(1.0, 0.35, iS.w), 1.3 / pxPerM);   // 至少 2 × 1.3 像素：远处也是“一笔”
      mv.xy += d * position.x * len + nrm * position.y * wid;
      vP = position.xy * 2.0; vC = iC; vS = iS; vDepth = -mv.z; vM = iM;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    uniform vec3 uInk;
    varying vec2 vP; varying vec4 vC; varying vec4 vS; varying float vDepth; varying vec2 vM;
    out vec4 o;
    ${OCCLUDE}
    void main(){
      if(occluded(vM.x, vDepth, vM.y, gl_FragCoord.xy, uRes)) discard;
      float k = vS.z, r;
      if(k < 0.5) r = max(abs(vP.x), abs(vP.y) / max(1.0 - pow(abs(vP.x), 3.0), 0.05));     // 细长条：两头收尖
      else if(k < 1.5) r = length(vP);                                                      // 小点
      else r = length(vec2(vP.x, vP.y * (1.0 + 0.35 * vP.x)));                             // 花瓣：一头圆一头尖
      float fw = max(fwidth(r), 1e-3);
      float a = 1.0 - smoothstep(1.0 - fw, 1.0, r);
      if(a < 0.02) discard;
      float rim = smoothstep(0.8 - fw, 0.8, r);                                            // 外圈一道细描线色
      float hi = step(0.25, vP.y) * (1.0 - rim) * step(0.5, fract(vS.w * 3.0 + 0.25));     // 一档高光（随翻转时有时无）
      vec3 c = mix(vC.rgb, mix(vC.rgb, vec3(1.0), 0.35), hi);
      c = mix(c, mix(uInk, vC.rgb * 0.4, 0.3), rim * 0.85);
      a *= vC.a;
      o = vec4(c * a, a);
    }
  `;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vs, fragmentShader: fs,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
}
export class FleckBatch {
  constructor(max = 2048) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aDir = mk(3); this.aS = mk(4); this.aC = mk(4); this.aM = mk(2);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iDir', this.aDir); g.setAttribute('iS', this.aS); g.setAttribute('iC', this.aC); g.setAttribute('iM', this.aM);
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, fleckMaterial());
    this.mesh.frustumCulled = false;
    this.n = 0;
  }
  begin() { this.n = 0; }
  // p, dir: [x,y,z]；o = { len, wid (m), kind (FLECK.*), flip 0..1, color [r,g,b], alpha, mode, bias }
  push(p, dir, o = {}) {
    if (this.n >= this.max || (o.alpha ?? 1) <= 0.01) return;
    const i = this.n++, c = o.color ?? [0.55, 0.62, 0.3];
    this.aPos.array.set([p[0], p[1], p[2]], i * 3);
    this.aDir.array.set([dir[0], dir[1], dir[2]], i * 3);
    this.aS.array.set([o.len ?? 0.08, o.wid ?? 0.02, o.kind ?? 0, o.flip ?? 0], i * 4);
    this.aC.array.set([c[0], c[1], c[2], o.alpha ?? 1], i * 4);
    this.aM.array.set([o.mode ?? 0, o.bias ?? 0.1], i * 2);
  }
  end() {
    this.geo.instanceCount = this.n;
    for (const a of [this.aPos, this.aDir, this.aS, this.aC, this.aM]) a.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

// 闭式发射器：粒子 i 在 i / rate 秒出生于盒子里的种子位置，沿 dir 以 speed 飞（+ 正弦扰动 + 可选重力 / 落地弹一次），
// 活 life 秒（首尾淡入淡出）。位置只由 (seed, i, t) 决定 —— 不累积状态，乱序渲染安全。
//   o = { seed, origin:[x,y,z], size:[sx,sy,sz]（出生盒，以 origin 为中心）, dir:[x,y,z], speed (m/s), rate (个/s), life (s),
//         kind, len, wid, colors:[[r,g,b], …], wobble (m), gravity (m/s², 正 = 往下), ground:(x,z)=>y, alpha, mode, bias, from (起始时刻) }
export function emitStream(batch, t, o = {}) {
  const rate = o.rate ?? 40, life = o.life ?? 1.6, seed = o.seed ?? 1, sp = o.speed ?? 8, t0 = o.from ?? 0;
  const [ox, oy, oz] = o.origin ?? [0, 0, 0], [sx, sy, sz] = o.size ?? [4, 2, 4];
  let [dx, dy, dz] = o.dir ?? [1, 0, 0]; const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
  const cols = o.colors ?? [[0.55, 0.64, 0.3], [0.72, 0.7, 0.42]], g = o.gravity ?? 0, wob = o.wobble ?? 0.25;
  const i1 = Math.floor((t - t0) * rate), i0 = Math.max(0, Math.floor((t - t0 - life) * rate));
  const draw = Math.floor(t * 8 + 1e-6);
  for (let i = i0; i <= i1; i++) {
    const age = t - t0 - i / rate; if (age < 0 || age > life) continue;
    const h0 = hash(seed, i, 1), h1 = hash(seed, i, 2), h2 = hash(seed, i, 3), h3 = hash(seed, i, 4);
    const v = sp * (0.7 + 0.6 * h3);
    let x = ox + (h0 - 0.5) * sx + dx * v * age, y = oy + (h1 - 0.5) * sy + dy * v * age - 0.5 * g * age * age, z = oz + (h2 - 0.5) * sz + dz * v * age;
    const w = Math.sin(age * (3 + 4 * h0) + h1 * 6.28) * wob;
    x += -dz * w; z += dx * w; y += Math.cos(age * (2.3 + 3 * h2) + h0 * 6.28) * wob * 0.6;
    let vy = dy * v - g * age;
    if (o.ground) { const gy = o.ground(x, z) + 0.02; if (y < gy) { y = gy + (gy - y) * 0.35; vy = -vy * 0.35; } }
    const fade = Math.min(1, age / 0.15, (life - age) / 0.3);
    batch.push([x, y, z], [dx * v, vy, dz * v], {
      kind: o.kind ?? FLECK.strip, len: (o.len ?? 0.09) * (0.7 + 0.6 * h1), wid: (o.wid ?? 0.022) * (0.75 + 0.5 * h2),
      flip: hash(seed, i, draw), color: cols[Math.floor(h3 * cols.length) % cols.length], alpha: (o.alpha ?? 1) * fade, mode: o.mode ?? 0, bias: o.bias ?? 0.1,
    });
  }
}

// 撞上东西散开的小尘团 / 水雾团：p 处、t0 时刻 n 个小点向外散开，life 秒淡出（沙打在背上、土块落地）
export function dustBurst(batch, p, t, t0, o = {}) {
  const age = t - t0, life = o.life ?? 0.3; if (age < 0 || age > life) return;
  const n = o.n ?? 8, R = o.radius ?? 0.5, seed = o.seed ?? 5, q = age / life, col = o.color ?? [0.78, 0.72, 0.6];
  for (let i = 0; i < n; i++) {
    const a = hash(seed, i, 1) * Math.PI * 2, e = (hash(seed, i, 2) - 0.3) * 1.2, r = R * (0.4 + 0.6 * hash(seed, i, 3)) * (1 - (1 - q) * (1 - q));
    const d = [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
    batch.push([p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r], d, {
      kind: FLECK.dot, len: (o.size ?? 0.05) * (1 + q), wid: (o.size ?? 0.05) * (1 + q), color: col, alpha: (o.alpha ?? 0.9) * (1 - q), mode: o.mode ?? 0, bias: o.bias ?? 0.15,
    });
  }
}
