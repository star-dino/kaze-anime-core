import * as THREE from 'three';

// 有机建模层：一整张连续的皮（无接缝、无描线），按 SDF 自动蒙皮。
// 来源：Sunshower 翠鸟（kf3d-plumage.js / kf3d-geo.js，MIT）—— 头 + 身体是 SDF 平滑并集的“同一团肉”，
// 每个顶点记住静止位置 aRest（花纹从它读，动起来不游走），每帧在身体/头部变换之间蒙皮。
// 这里把它泛化成引擎能力：
//   - 原作只有两块（头、身体），用“从颈部内一点打射线”采样表面 —— 只适用于星形的团块；
//     这里用 Surface Nets 网格化任意 SDF（长尾巴、四肢都行），顶点再用牛顿步投影回精确表面，
//     法线取 SDF 梯度 → 赛璐璐明暗交界线圆滑，没有面片感。
//   - 原作的“头部权重”（离头近还是离身体近）泛化为任意多骨骼：每个图元挂在一根骨头上，
//     顶点对每根骨头的权重由“到这根骨头的图元的距离”与最近距离之差决定 → 平滑并集处自然过渡。
//
// 用法（坐标都在角色根节点的静止空间，单位米）：
//   const body = new SoftBody({ k: 0.12 });
//   body.ell('hips', [0, 1.3, 0], [0.8, 0.8, 0.95]);           // 椭球（可选 rot: [x,y,z] 度）
//   body.cone('tail0', [0, 1.2, -0.7], [0, 1, -1.2], 0.5, 0.4);  // 圆锥台（两端圆头）
//   body.box('head', [0, 2, 0.5], [0.3, 0.25, 0.35], 0.12);      // 圆角长方体（半尺寸含圆角；可选 rot、taper）
//   body.shadeProxy('head', [0, 2, 0.5], { r: [0.3, 0.26, 0.4], k: 0.85 });   // 明暗法线代理（见下）
//   const skin = body.build(material, { cell: 0.03 });           // → { mesh, bind(rig.j), update() }
//   skin.bind(rig.j);   // 角色在静止姿态时调用一次
//   每帧：改关节 → root.updateMatrixWorld(true) → skin.update()
//
// 融合半径（k）的规矩：k 是“两块肉之间填多少肉”。k 超过相连图元中较小者特征半径的 ~25%，
// 小零件就会被大零件“吃掉”，整只角色化成一团橡皮泥（潮平渡口的狐狸）。build() 会检查：
// 超过 30% 时 console.warn（npm run check 能看到），指出是哪两个图元。
// 特征半径：椭球 = 最短半轴；圆锥台 = 较小端半径；圆角盒 = 最短半尺寸。
//
// 明暗法线代理（shadeProxy）：日式三渲二的标准做法 —— 头部按“一个光滑的椭球”受光，
// 眼窝、鼻梁、腮帮这些小起伏不切出乱扭的阴影线。build() 时给每个顶点算一个 aShadeN：
//   aShadeN = normalize(mix(真实法线, 代理椭球外法线, k × 该顶点对代理骨骼的蒙皮权重))
// 它和法线一起蒙皮（代理中心跟着骨骼动；脖子处随权重平滑过渡）。材质用 celMaterial({ rest: true, shadeNormal: true })。
// 描线仍用真实法线/深度，不受影响。

const V = THREE.Vector3;

// ------------------------------------------------------------------ SDF 图元（JS；GLSL 孪生见 SoftBody.glsl）
export const smin = (a, b, k) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
// 椭球的近似距离（iq），在表面附近足够准
export function sdEll(x, y, z, a, b, c) {
  const k0 = Math.hypot(x / a, y / b, z / c), k1 = Math.hypot(x / (a * a), y / (b * b), z / (c * c));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c);
}
// 圆锥台（两端是球，iq 的精确 round cone）
export function sdRoundCone(px, py, pz, a, b, r1, r2) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const qx = px - a[0], qy = py - a[1], qz = pz - a[2];
  const y = qx * bx + qy * by + qz * bz, z = y - l2;
  const wx = qx * l2 - bx * y, wy = qy * l2 - by * y, wz = qz * l2 - bz * y;
  const x2 = wx * wx + wy * wy + wz * wz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// 圆角长方体（iq）：half = 外形半尺寸（含圆角），r = 圆角半径
export function sdRoundBox(x, y, z, hx, hy, hz, r) {
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

const f5 = (x) => (Math.abs(x) < 1e-7 ? '0.0' : x.toFixed(5));
const rotInv = (rot) => {
  if (!rot) return null;
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot.map((d) => (d * Math.PI) / 180)));
  return new THREE.Matrix3().setFromMatrix4(m).invert().elements;      // 列主序
};

// ------------------------------------------------------------------ SoftBody：图元 + 平滑并集
export class SoftBody {
  constructor(o = {}) {
    this.k = o.k ?? 0.1;          // 默认融合半径（米）：越大接缝越圆润
    this.prims = [];
    this.proxies = [];
  }
  // 椭球。o: { k, name, rot:[x,y,z] 度（XYZ 欧拉，绕中心旋转） }
  ell(bone, c, r, o = {}) {
    this.prims.push({ type: 'ell', bone, c, r, inv: rotInv(o.rot), k: o.k ?? this.k, name: o.name, ctr: c, R: Math.max(...r), cr: Math.min(...r) });
    return this;
  }
  // 圆锥台：a → b，半径 ra → rb
  cone(bone, a, b, ra, rb, o = {}) {
    const ctr = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const half = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
    this.prims.push({ type: 'cone', bone, a, b, ra, rb, k: o.k ?? this.k, name: o.name, ctr, R: half + Math.max(ra, rb), cr: Math.min(ra, rb) });
    return this;
  }
  // 圆角长方体：c 中心，half = [hx, hy, hz] 外形半尺寸（含圆角），r 圆角半径（≤ 最短半尺寸）。
  // o: { k, name, rot:[x,y,z] 度, taper:[tx, ty] }
  //   taper：沿局部 +Z 收分 —— 前端（+Z）的 x / y 半尺寸乘 (1 - tx) / (1 - ty)，后端不变。方头 → 稍窄的钝鼻子，一块图元做完
  box(bone, c, half, r, o = {}) {
    const rr = Math.min(r, ...half);
    const tp = o.taper ?? [0, 0];
    this.prims.push({ type: 'box', bone, c, half, rr, tp, inv: rotInv(o.rot), k: o.k ?? this.k, name: o.name, ctr: c, R: Math.hypot(...half), cr: Math.min(...half) * (1 - Math.max(tp[0], tp[1])) });
    return this;
  }
  // 明暗法线代理：挂在 bone 上的椭球（中心 c，半轴 r，可选 rot），k = 代理强度 0..1。
  // o: { r: 数 | [rx,ry,rz], k, rot }。见文件头。
  shadeProxy(bone, c, o = {}) {
    const r = Array.isArray(o.r) ? o.r : [o.r ?? 1, o.r ?? 1, o.r ?? 1];
    this.proxies.push({ bone, c, r, k: o.k ?? 0.85, inv: rotInv(o.rot) });
    return this;
  }
  _d(p, x, y, z) {
    if (p.type === 'cone') return sdRoundCone(x, y, z, p.a, p.b, p.ra, p.rb);
    let dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2];
    if (p.inv) {
      const e = p.inv;
      const lx = e[0] * dx + e[3] * dy + e[6] * dz, ly = e[1] * dx + e[4] * dy + e[7] * dz, lz = e[2] * dx + e[5] * dy + e[8] * dz;
      dx = lx; dy = ly; dz = lz;
    }
    if (p.type === 'box') {
      // 收分：按 z 位置缩放 x/y（距离再乘最小缩放，保持 Lipschitz ≤ 1 左右，牛顿投影照样收敛）
      const u = Math.min(1, Math.max(0, (dz / p.half[2]) * 0.5 + 0.5));
      const sx = 1 - p.tp[0] * u, sy = 1 - p.tp[1] * u;
      return sdRoundBox(dx / sx, dy / sy, dz, p.half[0], p.half[1], p.half[2], p.rr) * Math.min(sx, sy);
    }
    return sdEll(dx, dy, dz, p.r[0], p.r[1], p.r[2]);
  }
  _touch(a, b, n = 12) {
    const lo = [0, 1, 2].map((i) => Math.max(a.ctr[i] - a.R, b.ctr[i] - b.R) - a.k);
    const hi = [0, 1, 2].map((i) => Math.min(a.ctr[i] + a.R, b.ctr[i] + b.R) + a.k);
    if (lo.some((x, i) => x > hi[i])) return false;
    const st = hi.map((x, i) => (x - lo[i]) / (n - 1));
    const tol = a.k + 0.87 * Math.max(...st);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const x = lo[0] + i * st[0], y = lo[1] + j * st[1], z = lo[2] + k * st[2];
      if (this._d(a, x, y, z) < tol && this._d(b, x, y, z) < tol) return true;
    }
    return false;
  }
  // 融合半径检查：图元 i 的 k（它和前面所有图元的并集做 smin）对每个“可能相连”的前序图元 j 比较特征半径
  checkBlend(limit = 0.3) {
    const out = [];
    const nm = (p, i) => p.name ?? `${p.type}#${i}(${p.bone})`;
    for (let i = 1; i < this.prims.length; i++) {
      const pi = this.prims[i];
      if (pi.k <= 0) continue;
      for (let j = 0; j < i; j++) {
        const pj = this.prims[j];
        // 先用包围球粗筛，再在两者包围盒的交集里采样：存在一点离两个表面都在 k 以内 → 两块肉在这里被融合
        if (this._d(pi, ...pj.ctr) - pj.R > pi.k) continue;
        if (!this._touch(pi, pj)) continue;
        const cr = Math.min(pi.cr, pj.cr);
        if (pi.k > limit * cr) out.push(`${nm(pi, i)} ↔ ${nm(pj, j)}: k=${pi.k.toFixed(3)} > ${Math.round(limit * 100)}% of ${cr.toFixed(3)} (= ${(limit * cr).toFixed(3)})`);
      }
    }
    return out;
  }
  // 整体距离（按添加顺序依次平滑并集）。远处的图元用包围球下界跳过 → 网格化快很多
  sd(x, y, z) {
    let d = 1e9;
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      if (i > 0) {
        const lb = Math.hypot(x - p.ctr[0], y - p.ctr[1], z - p.ctr[2]) - p.R * 1.05;
        if (lb > d + p.k) continue;           // smin 在 |a-b| > k 时等于 min，而 d_i ≥ lb
      }
      const di = this._d(p, x, y, z);
      d = i === 0 ? di : smin(d, di, p.k);
    }
    return d;
  }
  // 某个名字的图元自己的距离（花纹/表情放置用）
  sdNamed(name, x, y, z) {
    const p = this.prims.find((q) => q.name === name);
    if (!p) throw new Error(`SoftBody: no primitive named '${name}'`);
    return this._d(p, x, y, z);
  }
  normal(p, out = new V()) {
    const e = 1e-3;
    return out.set(
      this.sd(p.x + e, p.y, p.z) - this.sd(p.x - e, p.y, p.z),
      this.sd(p.x, p.y + e, p.z) - this.sd(p.x, p.y - e, p.z),
      this.sd(p.x, p.y, p.z + e) - this.sd(p.x, p.y, p.z - e),
    ).normalize();
  }
  // 把点投影到表面（牛顿步）
  project(p, out = new V(), iters = 6) {
    out.copy(p);
    const n = new V();
    for (let i = 0; i < iters; i++) {
      const d = this.sd(out.x, out.y, out.z);
      if (Math.abs(d) < 1e-6) break;
      this.normal(out, n);
      out.addScaledVector(n, -d);
    }
    return out;
  }
  // 从 from 沿 dir 打射线，返回第一次穿出表面的点（from 必须在体内）
  raySurface(from, dir, out = new V(), maxT = 10) {
    const d = new V().copy(dir).normalize();
    let t0 = 0, t1 = -1;
    const step = 0.01;
    for (let t = step; t < maxT; t += step) {
      if (this.sd(from.x + d.x * t, from.y + d.y * t, from.z + d.z * t) > 0) { t1 = t; break; }
      t0 = t;
    }
    if (t1 < 0) throw new Error('SoftBody.raySurface: ray never leaves the body (is `from` inside?)');
    for (let k = 0; k < 30; k++) {
      const tm = (t0 + t1) / 2;
      if (this.sd(from.x + d.x * tm, from.y + d.y * tm, from.z + d.z * tm) > 0) t1 = tm; else t0 = tm;
    }
    return out.copy(from).addScaledVector(d, (t0 + t1) / 2);
  }
  // 每个具名图元的 GLSL 距离函数：float sd_<name>(vec3 p)。花纹着色器可以用它们判断“这块皮属于哪里”
  glsl() {
    let s = /* glsl */ `
float sdEllG(vec3 p, vec3 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
float sdRoundConeG(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a; float l2 = dot(ba, ba), rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1.0 / l2;
  vec3 pa = p - a; float y = dot(pa, ba), z = y - l2;
  vec3 w = pa * l2 - ba * y; float x2 = dot(w, w), y2 = y * y * l2, z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if(sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if(sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdRoundBoxT(vec3 p, vec3 b, float r, vec2 tp){
  float u = clamp(p.z / b.z * 0.5 + 0.5, 0.0, 1.0);
  vec2 s = 1.0 - tp * u;
  p.xy /= s;
  vec3 q = abs(p) - b + r;
  return (length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r) * min(s.x, s.y);
}
`;
    for (const p of this.prims) {
      if (!p.name) continue;
      if (p.type === 'cone') {
        s += `float sd_${p.name}(vec3 p){ return sdRoundConeG(p, vec3(${p.a.map(f5)}), vec3(${p.b.map(f5)}), ${f5(p.ra)}, ${f5(p.rb)}); }\n`;
      } else {
        const q = `p - vec3(${p.c.map(f5)})`;
        const e = p.inv;
        const rot = e ? `mat3(${Array.from(e).map(f5).join(', ')}) * (${q})` : `(${q})`;
        if (p.type === 'box') {
          s += `float sd_${p.name}(vec3 p){ return sdRoundBoxT(${rot}, vec3(${p.half.map(f5)}), ${f5(p.rr)}, vec2(${p.tp.map(f5)})); }\n`;
        } else s += `float sd_${p.name}(vec3 p){ return sdEllG(${rot}, vec3(${p.r.map(f5)})); }\n`;
      }
    }
    return s;
  }

  // ---------------------------------------------------------------- 网格化 + 蒙皮
  // o: { cell 网格边长（米）, blend 骨骼权重过渡宽度（米）, margin }
  build(material, o = {}) {
    for (const w of this.checkBlend(o.blendLimit ?? 0.3)) console.warn(`[SoftBody${o.name ? ' ' + o.name : ''}] blend radius too large: ${w}`);
    const geo = this.geometry(o);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;            // 顶点每帧在 CPU 上移动，包围球不可靠
    return new Skin(mesh, geo.userData.bones, geo.userData.skin);
  }

  geometry(o = {}) {
    const h = o.cell ?? 0.03, blend = o.blend ?? Math.max(this.k * 1.6, 0.08), margin = o.margin ?? 2.5 * h;
    // 包围盒
    const lo = new V(Infinity, Infinity, Infinity), hi = new V(-Infinity, -Infinity, -Infinity);
    for (const p of this.prims) {
      for (let i = 0; i < 3; i++) {
        lo.setComponent(i, Math.min(lo.getComponent(i), p.ctr[i] - p.R));
        hi.setComponent(i, Math.max(hi.getComponent(i), p.ctr[i] + p.R));
      }
    }
    lo.subScalar(margin); hi.addScalar(margin);
    const nx = Math.ceil((hi.x - lo.x) / h) + 1, ny = Math.ceil((hi.y - lo.y) / h) + 1, nz = Math.ceil((hi.z - lo.z) / h) + 1;
    const G = (i, j, k) => i + nx * (j + ny * k);
    const val = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      val[G(i, j, k)] = this.sd(lo.x + i * h, lo.y + j * h, lo.z + k * h);
    }
    // Surface Nets：每个跨越表面的格子放一个顶点（12 条边交点的平均）
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const C = (i, j, k) => i + cx * (j + cy * k);
    const cellV = new Int32Array(cx * cy * cz).fill(-1);
    const P = [];
    const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cv = new Float32Array(8);
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { const q = CORNER[c]; cv[c] = val[G(i + q[0], j + q[1], k + q[2])]; if (cv[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of EDGES) {
        const va = cv[a], vb = cv[b];
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb), A = CORNER[a], B = CORNER[b];
        sx += A[0] + (B[0] - A[0]) * t; sy += A[1] + (B[1] - A[1]) * t; sz += A[2] + (B[2] - A[2]) * t; n++;
      }
      cellV[C(i, j, k)] = P.length / 3;
      P.push(lo.x + (i + sx / n) * h, lo.y + (j + sy / n) * h, lo.z + (k + sz / n) * h);
    }
    // 面：每条跨越表面的网格边 → 周围 4 个格子的顶点组成四边形
    const I = [];
    const quad = (a, b, c, d) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; I.push(a, b, c, a, c, d); };
    for (let k = 1; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 0; i < cx; i++) {      // x 向边
      const v0 = val[G(i, j, k)], v1 = val[G(i + 1, j, k)];
      if ((v0 < 0) !== (v1 < 0)) quad(cellV[C(i, j - 1, k - 1)], cellV[C(i, j, k - 1)], cellV[C(i, j, k)], cellV[C(i, j - 1, k)]);
    }
    for (let k = 1; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 1; i < cx; i++) {      // y 向边
      const v0 = val[G(i, j, k)], v1 = val[G(i, j + 1, k)];
      if ((v0 < 0) !== (v1 < 0)) quad(cellV[C(i - 1, j, k - 1)], cellV[C(i, j, k - 1)], cellV[C(i, j, k)], cellV[C(i - 1, j, k)]);
    }
    for (let k = 0; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 1; i < cx; i++) {      // z 向边
      const v0 = val[G(i, j, k)], v1 = val[G(i, j, k + 1)];
      if ((v0 < 0) !== (v1 < 0)) quad(cellV[C(i - 1, j - 1, k)], cellV[C(i, j - 1, k)], cellV[C(i, j, k)], cellV[C(i - 1, j, k)]);
    }
    // 顶点投影回精确表面（限制步长，薄处不穿过对面），法线 = SDF 梯度
    const nv = P.length / 3;
    const pos = new Float32Array(P), nrm = new Float32Array(nv * 3);
    const p = new V(), g = new V();
    for (let v = 0; v < nv; v++) {
      p.fromArray(pos, v * 3);
      for (let it = 0; it < 3; it++) {
        const d = this.sd(p.x, p.y, p.z);
        this.normal(p, g);
        p.addScaledVector(g, -Math.max(-0.5 * h, Math.min(0.5 * h, d)));
      }
      this.normal(p, g);
      p.toArray(pos, v * 3); g.toArray(nrm, v * 3);
    }
    // 三角形绕序与法线一致（赛璐璐着色器在背面翻转法线，所以绕序必须对）
    const q0 = new V(), q1 = new V(), q2 = new V();
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      q0.fromArray(pos, a * 3); q1.fromArray(pos, b * 3); q2.fromArray(pos, c * 3);
      q1.sub(q0); q2.sub(q0); q1.cross(q2);
      const dn = q1.x * (nrm[a * 3] + nrm[b * 3] + nrm[c * 3]) + q1.y * (nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1]) + q1.z * (nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2]);
      if (dn < 0) { I[t + 1] = c; I[t + 2] = b; }
    }
    // 骨骼权重：对每根骨头取它名下图元的最近距离 d_b，w_b = smooth(1 - (d_b - d_min) / blend)，取前 4 个归一化
    const bones = [...new Set(this.prims.map((q) => q.bone))];
    const bi = new Map(bones.map((b, i) => [b, i]));
    const skinIdx = new Uint8Array(nv * 4), skinW = new Float32Array(nv * 4);
    const db = new Float32Array(bones.length);
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      db.fill(1e9);
      for (const q of this.prims) { const b = bi.get(q.bone); db[b] = Math.min(db[b], this._d(q, x, y, z)); }
      let dmin = 1e9; for (let b = 0; b < bones.length; b++) dmin = Math.min(dmin, db[b]);
      const cand = [];
      for (let b = 0; b < bones.length; b++) {
        let w = 1 - (db[b] - dmin) / blend;
        if (w <= 0) continue;
        w = w * w * (3 - 2 * w);
        cand.push([b, w]);
      }
      cand.sort((A, B) => B[1] - A[1] || A[0] - B[0]);       // 确定性：同权重按骨骼序号
      let sum = 0; for (let i = 0; i < Math.min(4, cand.length); i++) sum += cand[i][1];
      for (let i = 0; i < 4; i++) {
        const c = cand[i];
        skinIdx[v * 4 + i] = c ? c[0] : 0;
        skinW[v * 4 + i] = c ? c[1] / sum : 0;
      }
    }
    // 明暗法线代理 → aShadeN（静止空间）。权重 = k × 该顶点对代理骨骼的蒙皮权重
    let shadeN = null;
    if (this.proxies.length) {
      shadeN = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        let sx = 0, sy = 0, sz = 0, ws = 0;
        for (const P of this.proxies) {
          const b = bi.get(P.bone);
          let wb = 0;
          for (let i = 0; i < 4; i++) if (skinIdx[v * 4 + i] === b) wb += skinW[v * 4 + i];
          const w = wb * P.k;
          if (w <= 0) continue;
          let dx = x - P.c[0], dy = y - P.c[1], dz = z - P.c[2];
          const e = P.inv;
          if (e) { const lx = e[0] * dx + e[3] * dy + e[6] * dz, ly = e[1] * dx + e[4] * dy + e[7] * dz, lz = e[2] * dx + e[5] * dy + e[8] * dz; dx = lx; dy = ly; dz = lz; }
          // 椭球外法线（局部）= p / r²，再转回静止空间（inv 是正交阵 → 转置即逆）
          let gx = dx / (P.r[0] * P.r[0]), gy = dy / (P.r[1] * P.r[1]), gz = dz / (P.r[2] * P.r[2]);
          if (e) { const wx = e[0] * gx + e[1] * gy + e[2] * gz, wy = e[3] * gx + e[4] * gy + e[5] * gz, wz = e[6] * gx + e[7] * gy + e[8] * gz; gx = wx; gy = wy; gz = wz; }
          const gl = Math.hypot(gx, gy, gz) || 1;
          sx += (gx / gl) * w; sy += (gy / gl) * w; sz += (gz / gl) * w; ws += w;
        }
        const keep = Math.max(0, 1 - ws), norm = ws > 1 ? 1 / ws : 1;
        const nx = nrm[v * 3] * keep + sx * norm, ny = nrm[v * 3 + 1] * keep + sy * norm, nz = nrm[v * 3 + 2] * keep + sz * norm;
        const l = Math.hypot(nx, ny, nz) || 1;
        shadeN[v * 3] = nx / l; shadeN[v * 3 + 1] = ny / l; shadeN[v * 3 + 2] = nz / l;
      }
    }
    const geo = new THREE.BufferGeometry();
    const posA = new THREE.BufferAttribute(pos.slice(), 3); posA.setUsage(THREE.DynamicDrawUsage);
    const nrmA = new THREE.BufferAttribute(nrm.slice(), 3); nrmA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posA);
    geo.setAttribute('normal', nrmA);
    geo.setAttribute('aRest', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRestN', new THREE.BufferAttribute(nrm, 3));
    if (shadeN) {
      const sA = new THREE.BufferAttribute(shadeN.slice(), 3); sA.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aShadeN', sA);
      geo.userData.restShadeN = shadeN;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    geo.userData.bones = bones;
    geo.userData.skin = { idx: skinIdx, w: skinW };
    geo.userData.stats = { verts: nv, tris: I.length / 3, grid: [nx, ny, nz] };
    return geo;
  }
}

// ------------------------------------------------------------------ CPU 线性混合蒙皮
// mesh 挂在角色根节点下（网格坐标 = 根节点的静止空间）。bind() 在静止姿态时记录每根骨头的
// “根 → 骨”矩阵；update() 每帧算 M_b = (根⁻¹ · 骨的世界矩阵) · 静止⁻¹，按权重混合。
// 全部是当前关节角的纯函数 → 任意顺序渲染帧结果一致（确定性）。
export class Skin {
  constructor(mesh, boneNames, skin) {
    this.mesh = mesh;
    this.names = boneNames;
    this.idx = skin.idx; this.w = skin.w;
    this.restP = mesh.geometry.attributes.aRest.array;
    this.restN = mesh.geometry.attributes.aRestN.array;
    this.restS = mesh.geometry.userData.restShadeN ?? null;      // 明暗代理法线（有 shadeProxy 时）
    this.joints = null;
    this.restInv = boneNames.map(() => new THREE.Matrix4());
    this.M = boneNames.map(() => new Float32Array(16));
    this._rootInv = new THREE.Matrix4(); this._m = new THREE.Matrix4();
  }
  get stats() { return this.mesh.geometry.userData.stats; }
  // joints: { 名字: Object3D }（例如 Rig 的 rig.j）。调用时角色必须处在静止姿态
  bind(joints, root) {
    this.joints = this.names.map((n) => {
      if (!joints[n]) throw new Error(`Skin.bind: missing joint '${n}'`);
      return joints[n];
    });
    this.root = root ?? this.mesh.parent;
    this.root.updateMatrixWorld(true);
    this._rootInv.copy(this.root.matrixWorld).invert();
    this.joints.forEach((j, b) => this.restInv[b].multiplyMatrices(this._rootInv, j.matrixWorld).invert());
    return this;
  }
  update() {
    this._rootInv.copy(this.root.matrixWorld).invert();
    this.joints.forEach((j, b) => {
      this._m.multiplyMatrices(this._rootInv, j.matrixWorld).multiply(this.restInv[b]);
      this.M[b].set(this._m.elements);
    });
    const P = this.mesh.geometry.attributes.position, N = this.mesh.geometry.attributes.normal;
    const S = this.restS ? this.mesh.geometry.attributes.aShadeN : null;
    const sa = S ? S.array : null, rs = this.restS;
    const pa = P.array, na = N.array, rp = this.restP, rn = this.restN, idx = this.idx, w = this.w, M = this.M;
    const m = new Float32Array(12);
    const n = pa.length / 3;
    for (let v = 0; v < n; v++) {
      m.fill(0);
      for (let i = 0; i < 4; i++) {
        const wi = w[v * 4 + i];
        if (wi === 0) continue;
        const e = M[idx[v * 4 + i]];
        m[0] += e[0] * wi; m[1] += e[1] * wi; m[2] += e[2] * wi;
        m[3] += e[4] * wi; m[4] += e[5] * wi; m[5] += e[6] * wi;
        m[6] += e[8] * wi; m[7] += e[9] * wi; m[8] += e[10] * wi;
        m[9] += e[12] * wi; m[10] += e[13] * wi; m[11] += e[14] * wi;
      }
      const o = v * 3, x = rp[o], y = rp[o + 1], z = rp[o + 2];
      pa[o] = m[0] * x + m[3] * y + m[6] * z + m[9];
      pa[o + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
      pa[o + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
      const a = rn[o], b = rn[o + 1], c = rn[o + 2];
      const nx = m[0] * a + m[3] * b + m[6] * c, ny = m[1] * a + m[4] * b + m[7] * c, nz = m[2] * a + m[5] * b + m[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      na[o] = nx / l; na[o + 1] = ny / l; na[o + 2] = nz / l;
      if (sa) {
        const a2 = rs[o], b2 = rs[o + 1], c2 = rs[o + 2];
        const sx = m[0] * a2 + m[3] * b2 + m[6] * c2, sy = m[1] * a2 + m[4] * b2 + m[7] * c2, sz = m[2] * a2 + m[5] * b2 + m[8] * c2;
        const ls = Math.hypot(sx, sy, sz) || 1;
        sa[o] = sx / ls; sa[o + 1] = sy / ls; sa[o + 2] = sz / ls;
      }
    }
    P.needsUpdate = true; N.needsUpdate = true;
    if (S) S.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ 参数曲面（原作 kf3d-geo.js surf）
// fn(th, ph, out)：th ∈ [th0, th1]（0 = 第一个极点），ph ∈ [0, 2π)。法线由同一个函数差分得到 → 无缝、无面片。
// o: { th0, th1, xf: Matrix4, rest(th, ph) → [x,y,z]（写 aRest）, inside, center, orient }
export function surf(fn, nu = 40, nv = 28, o = {}) {
  const th0 = o.th0 ?? 0, th1 = o.th1 ?? Math.PI;
  const P = [], N = [], UV = [], R = [];
  const p = new V(), a = new V(), b = new V(), c = new V(), d = new V(), n = new V();
  const e = 1e-3;
  for (let j = 0; j <= nv; j++) {
    const th = th0 + ((th1 - th0) * j) / nv;
    for (let i = 0; i <= nu; i++) {
      const ph = (i / nu) * Math.PI * 2;
      fn(th, ph, p);
      const tc = Math.min(Math.max(th, 3 * e), Math.PI - 3 * e);
      fn(tc + e, ph, a); fn(tc - e, ph, b); a.sub(b);
      fn(tc, ph + e, c); fn(tc, ph - e, d); c.sub(d);
      n.crossVectors(c, a);
      if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
      n.normalize();
      P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); UV.push(i / nu, 1 - j / nv);
      if (o.rest) R.push(...o.rest(th, ph));
    }
  }
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(P), nrm = new Float32Array(N);
  if (o.xf) {
    const m = o.xf, nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < pos.length; i += 3) {
      p.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m); pos.set([p.x, p.y, p.z], i);
      n.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyMatrix3(nm).normalize(); nrm.set([n.x, n.y, n.z], i);
    }
  }
  // 法线朝外：与“从中心出发的方向”比较
  const cen = new V();
  for (let i = 0; i < pos.length; i += 3) cen.x += pos[i], cen.y += pos[i + 1], cen.z += pos[i + 2];
  cen.multiplyScalar(3 / pos.length);
  if (o.center) cen.copy(o.center);
  let s = 0;
  for (let i = 0; i < pos.length; i += 3) s += (pos[i] - cen.x) * nrm[i] + (pos[i + 1] - cen.y) * nrm[i + 1] + (pos[i + 2] - cen.z) * nrm[i + 2];
  if (o.orient) {
    const k = (o.orient.j * (nu + 1) + o.orient.i) * 3, dv = o.orient.dir;
    s = nrm[k] * dv.x + nrm[k + 1] * dv.y + nrm[k + 2] * dv.z;
  }
  if ((s < 0) !== !!o.inside) for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  const I = [];
  const q0 = new V(), q1 = new V(), q2 = new V(), fn3 = new V();
  const tri = (i0, i1, i2) => {
    q0.fromArray(pos, i0 * 3); q1.fromArray(pos, i1 * 3); q2.fromArray(pos, i2 * 3);
    fn3.subVectors(q1, q0).cross(q2.sub(q0));
    if (fn3.lengthSq() < 1e-24) return;
    const dn = fn3.x * (nrm[i0 * 3] + nrm[i1 * 3] + nrm[i2 * 3]) + fn3.y * (nrm[i0 * 3 + 1] + nrm[i1 * 3 + 1] + nrm[i2 * 3 + 1]) + fn3.z * (nrm[i0 * 3 + 2] + nrm[i1 * 3 + 2] + nrm[i2 * 3 + 2]);
    if (dn >= 0) I.push(i0, i1, i2); else I.push(i0, i2, i1);
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const v00 = j * (nu + 1) + i, v10 = v00 + 1, v01 = v00 + nu + 1, v11 = v01 + 1;
    tri(v00, v01, v10); tri(v10, v01, v11);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(UV), 2));
  if (o.rest) g.setAttribute('aRest', new THREE.Float32BufferAttribute(R, 3));
  g.setIndex(I);
  g.computeBoundingSphere();
  return g;
}

export const sphereFn = (r) => (th, ph, out) => out.set(Math.sin(th) * Math.cos(ph) * r, Math.sin(th) * Math.sin(ph) * r, Math.cos(th) * r);

// ------------------------------------------------------------------ 笔画（原作 kf3d-geo.js stroke）
// 沿 pts 的管子，两端收尖 —— 像一笔墨线。闭眼、笑眼、眯眼都是“画出来的”，不是 3D 眼皮。
export function stroke(pts, r0, o = {}) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  const segs = o.segs ?? 24, rad = o.rad ?? 8;
  const taper = o.taper ?? 0.3;
  const frames = curve.computeFrenetFrames(segs, false);
  const P = [], N = [], I = [];
  const p = new V(), n = new V();
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    curve.getPointAt(s, p);
    const k = Math.min(1, s / taper, (1 - s) / taper);
    const r = r0 * Math.pow(Math.max(k, 0), 0.55) * (o.prof ? o.prof(s) : 1);
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      P.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r); N.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = a + rad + 1;
    I.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((P.length / 3) * 2), 2));
  g.setIndex(I);
  const idx = g.index.array, pos = g.attributes.position.array, nr = g.attributes.normal.array;
  const q0 = new V(), q1 = new V(), q2 = new V();
  for (let t = 0; t < idx.length; t += 3) {
    q0.fromArray(pos, idx[t] * 3); q1.fromArray(pos, idx[t + 1] * 3); q2.fromArray(pos, idx[t + 2] * 3);
    const f = q1.sub(q0).cross(q2.sub(q0));
    const dn = f.x * nr[idx[t] * 3] + f.y * nr[idx[t] * 3 + 1] + f.z * nr[idx[t] * 3 + 2];
    if (dn < 0) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  g.computeBoundingSphere();
  return g;
}

// 让 obj 的局部 +Z 指向 z，+Y 尽量接近 yHint
const _m4 = new THREE.Matrix4(), _x = new V(), _y = new V(), _z = new V();
export function basisZ(z, yHint, out = new THREE.Quaternion()) {
  _z.copy(z).normalize();
  _y.copy(yHint).addScaledVector(_z, -yHint.dot(_z));
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
  _y.normalize();
  _x.crossVectors(_y, _z);
  _m4.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m4);
}
