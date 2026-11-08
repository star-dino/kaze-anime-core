import * as THREE from 'three';
import { ConvexGeometry } from '../../vendor/addons/ConvexGeometry.js';
import { toCreasedNormals } from '../../vendor/addons/BufferGeometryUtils.js';
import { deg } from './util.js';
import { celMaterial } from './materials.js';

// 建模工具箱（改编自 Sunshower robot.js / LEVIATHAN archer-geo.js，MIT）。
// 思路：不用任何外部模型文件，所有角色都由“点集 → 凸包”拼出来：
//   cbox      带倒角/收分的盒子（装甲板）
//   superPts  超椭球点集（e=2 椭球，越大越方）→ 头盔、肩甲、肚子
//   hull      任意点集的凸包 + 折角法线（硬边保持锐利，曲面保持光滑）
// 零件按关节挂在 Group 树上，每个零件一个不同的描线 id → 描线自动落在零件接缝。

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// three 的 crease 哈希在 0.01 精度截断：小零件放大 30 倍再算法线（LEVIATHAN 踩过的坑）
// 顺带写入顶点属性 aEdge（棱边/倒角 = 1，平滑曲面与平板中心 = 0）：供 celMaterial({ weather:{ edge:true } }) 做棱边磨损。
// fan = true 时将大平板沿外边界向中心点扇形剖分，使 vEdge 从板边 1 平滑过渡到板心 0（默认 false 保持旧片顶点完全不变）。
function addEdgeAttr(g, creaseRad, fan = false) {
  const pos = g.attributes.position, norm = g.attributes.normal;
  const nTri = (pos.count / 3) | 0;
  if (!nTri) return g;
  const cDot = Math.cos(Math.min(creaseRad, 0.42));
  const vKey = (i) => `${Math.round(pos.getX(i) * 100)},${Math.round(pos.getY(i) * 100)},${Math.round(pos.getZ(i) * 100)}`;
  const vNorms = new Map();
  const tris = [];
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n0 = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    p0.fromBufferAttribute(pos, i0); p1.fromBufferAttribute(pos, i1); p2.fromBufferAttribute(pos, i2);
    e1.subVectors(p1, p0); e2.subVectors(p2, p0);
    const cross = new THREE.Vector3().crossVectors(e1, e2);
    const area = 0.5 * cross.length();
    const fn = area > 1e-8 ? cross.clone().multiplyScalar(1 / (2 * area)) : new THREE.Vector3(0, 1, 0);
    const keys = [vKey(i0), vKey(i1), vKey(i2)];
    for (const k of keys) {
      let arr = vNorms.get(k);
      if (!arr) { arr = []; vNorms.set(k, arr); }
      if (!arr.some((q) => q.dot(fn) > 0.9995)) arr.push(fn);
    }
    let isFlat = true;
    for (const idx of [i0, i1, i2]) {
      n0.fromBufferAttribute(norm, idx);
      if (n0.dot(fn) < cDot - 0.02) isFlat = false;
    }
    tris.push({ id: t, i0, i1, i2, keys, fn, area, isFlat });
  }
  const isCrease = new Map();
  for (const [k, arr] of vNorms.entries()) {
    let cr = false;
    for (let i = 0; i < arr.length && !cr; i++) {
      for (let j = i + 1; j < arr.length; j++) if (arr[i].dot(arr[j]) < cDot) { cr = true; break; }
    }
    isCrease.set(k, cr ? 1 : 0);
  }
  const edgeMap = new Map();
  for (const tr of tris) {
    if (!tr.isFlat) continue;
    for (let s = 0; s < 3; s++) {
      const ka = tr.keys[s], kb = tr.keys[(s + 1) % 3];
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      let list = edgeMap.get(ek);
      if (!list) { list = []; edgeMap.set(ek, list); }
      list.push(tr);
    }
  }
  const facets = [];
  const visited = new Set();
  for (const tr of tris) {
    if (!tr.isFlat || visited.has(tr.id)) continue;
    const F = { tris: [], area: 0 };
    const q = [tr];
    visited.add(tr.id);
    while (q.length) {
      const cur = q.pop();
      F.tris.push(cur); F.area += cur.area;
      for (let s = 0; s < 3; s++) {
        const ka = cur.keys[s], kb = cur.keys[(s + 1) % 3];
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        for (const nb of edgeMap.get(ek) || []) {
          if (!visited.has(nb.id) && cur.fn.dot(nb.fn) >= cDot && tr.fn.dot(nb.fn) >= cDot - 0.03) {
            visited.add(nb.id);
            q.push(nb);
          }
        }
      }
    }
    facets.push(F);
  }
  let maxArea = 0, maxW = 0;
  for (const F of facets) {
    const edgeSet = new Set();
    for (const tr of F.tris) {
      for (let s = 0; s < 3; s++) {
        const ka = tr.keys[s], kb = tr.keys[(s + 1) % 3];
        const rev = `${kb}|${ka}`;
        if (edgeSet.has(rev)) edgeSet.delete(rev); else edgeSet.add(`${ka}|${kb}`);
      }
    }
    let perim = 0;
    for (const tr of F.tris) {
      const idxs = [tr.i0, tr.i1, tr.i2];
      for (let s = 0; s < 3; s++) {
        if (edgeSet.has(`${tr.keys[s]}|${tr.keys[(s + 1) % 3]}`)) {
          p0.fromBufferAttribute(pos, idxs[s]); p1.fromBufferAttribute(pos, idxs[(s + 1) % 3]);
          perim += p0.distanceTo(p1);
        }
      }
    }
    F.w = perim > 1e-5 ? (2 * F.area) / perim : 0;
    F.boundEdges = edgeSet;
    if (F.area > maxArea) maxArea = F.area;
    if (F.w > maxW) maxW = F.w;
  }
  for (const F of facets) {
    F.isMain = F.area > 0.035 * maxArea && F.w > 0.22 * maxW;
    for (const tr of F.tris) tr.facet = F;
  }
  if (!fan) {
    const edgeArr = new Float32Array(pos.count);
    for (const tr of tris) {
      const main = tr.facet?.isMain;
      edgeArr[tr.i0] = main ? 0 : (isCrease.get(tr.keys[0]) ?? 0);
      edgeArr[tr.i1] = main ? 0 : (isCrease.get(tr.keys[1]) ?? 0);
      edgeArr[tr.i2] = main ? 0 : (isCrease.get(tr.keys[2]) ?? 0);
    }
    g.setAttribute('aEdge', new THREE.BufferAttribute(edgeArr, 1));
    return g;
  }
  const outPos = [], outNorm = [], outEdge = [];
  const pushV = (px, py, pz, nx, ny, nz, ed) => { outPos.push(px, py, pz); outNorm.push(nx, ny, nz); outEdge.push(ed); };
  const doneFacets = new Set();
  for (const tr of tris) {
    const F = tr.facet;
    if (F && F.isMain) {
      if (doneFacets.has(F)) continue;
      doneFacets.add(F);
      let cx = 0, cy = 0, cz = 0, wSum = 0;
      const nx = norm.getX(tr.i0), ny = norm.getY(tr.i0), nz = norm.getZ(tr.i0);
      for (const ft of F.tris) {
        const mx = (pos.getX(ft.i0) + pos.getX(ft.i1) + pos.getX(ft.i2)) / 3;
        const my = (pos.getY(ft.i0) + pos.getY(ft.i1) + pos.getY(ft.i2)) / 3;
        const mz = (pos.getZ(ft.i0) + pos.getZ(ft.i1) + pos.getZ(ft.i2)) / 3;
        cx += mx * ft.area; cy += my * ft.area; cz += mz * ft.area; wSum += ft.area;
      }
      if (wSum > 1e-8) { cx /= wSum; cy /= wSum; cz /= wSum; }
      const rk = 0.82; // 外圈 18% 为棱边磨损过渡带，平板内圈 82% 完全置 0
      for (const ft of F.tris) {
        const idxs = [ft.i0, ft.i1, ft.i2];
        for (let s = 0; s < 3; s++) {
          const ka = ft.keys[s], kb = ft.keys[(s + 1) % 3];
          if (!F.boundEdges.has(`${ka}|${kb}`)) continue;
          const ia = idxs[s], ib = idxs[(s + 1) % 3];
          const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
          const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
          const iax = cx + (ax - cx) * rk, iay = cy + (ay - cy) * rk, iaz = cz + (az - cz) * rk;
          const ibx = cx + (bx - cx) * rk, iby = cy + (by - cy) * rk, ibz = cz + (bz - cz) * rk;
          const ea = isCrease.get(ka) ?? 1, eb = isCrease.get(kb) ?? 1;
          pushV(ax, ay, az, nx, ny, nz, ea);
          pushV(bx, by, bz, nx, ny, nz, eb);
          pushV(ibx, iby, ibz, nx, ny, nz, 0);
          pushV(ax, ay, az, nx, ny, nz, ea);
          pushV(ibx, iby, ibz, nx, ny, nz, 0);
          pushV(iax, iay, iaz, nx, ny, nz, 0);
          pushV(iax, iay, iaz, nx, ny, nz, 0);
          pushV(ibx, iby, ibz, nx, ny, nz, 0);
          pushV(cx, cy, cz, nx, ny, nz, 0);
        }
      }
    } else {
      for (let s = 0, idxs = [tr.i0, tr.i1, tr.i2]; s < 3; s++) {
        const idx = idxs[s];
        pushV(pos.getX(idx), pos.getY(idx), pos.getZ(idx), norm.getX(idx), norm.getY(idx), norm.getZ(idx), isCrease.get(tr.keys[s]) ?? 0);
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNorm, 3));
  out.setAttribute('aEdge', new THREE.Float32BufferAttribute(outEdge, 1));
  return out;
}

export function creased(g, a, fan = false) { g.scale(30, 30, 30); const r = toCreasedNormals(g, a); r.scale(1 / 30, 1 / 30, 1 / 30); return addEdgeAttr(r, a, fan); }
export function hull(points, crease = 34, fan = false) { return creased(new ConvexGeometry(points), deg(crease), fan); }

export function cbox(w, h, d, c = 0.08, o = {}) {
  const wt = o.wt ?? w, dt = o.dt ?? d, zt = o.zt ?? 0, zb = o.zb ?? 0;
  const pts = [];
  for (const [y, ww, dd, zz] of [[-h / 2, w, d, zb], [h / 2, wt, dt, zt]]) {
    const ys = Math.sign(y);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * ww / 2, z = sz * dd / 2 + zz;
      pts.push(v(x - sx * c, y, z - sz * c), v(x, y - ys * c, z - sz * c), v(x - sx * c, y - ys * c, z));
    }
  }
  return hull(pts, o.crease ?? 34, o.edge ?? false);
}

// 带倒角与孔洞的 2D 轮廓挤出（轮廓在 XY 平面，沿 Z 挤出并居中；移植自 LEVIATHAN archer-geo.js）
//   holes: [{ x, y, r }] 圆孔，或 [[[x,y], ...]] 多边形孔
export function extrude(pts, depth, bevel = 0.02, holes = [], crease = 30, edge = false) {
  const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) {
    const pth = new THREE.Path();
    if (h.r) pth.absarc(h.x ?? 0, h.y ?? 0, h.r, 0, Math.PI * 2, true);
    else pth.setFromPoints(h.map((p) => new THREE.Vector2(p[0], p[1])));
    sh.holes.push(pth);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 16 });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('uv');
  return creased(g, deg(crease), edge);
}

// 超椭球上的点；fn 可以移动每个点（偏移、用平面切平）后再求凸包
export function superPts(rx, ry, rz, e, n, fn) {
  const pts = [], p = 2 / e;
  const f = (c) => Math.sign(c) * Math.pow(Math.abs(c), p);
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    for (let k = 0; k < n * 2; k++) {
      const b = -Math.PI + (Math.PI * k) / n;
      const q = v(rx * f(Math.cos(a)) * f(Math.cos(b)), ry * f(Math.sin(a)), rz * f(Math.cos(a)) * f(Math.sin(b)));
      if (fn) fn(q);
      pts.push(q);
    }
  }
  return pts;
}
export const blob = (rx, ry, rz, e = 2.2, n = 14, fn) => hull(superPts(rx, ry, rz, e, n, fn), 50);

// 锥形尖刺（背鳍、角、爪）：底面多边形 + 顶点
export function spike(r, h, sides = 5, lean = 0) {
  const pts = [v(lean, h, 0)];
  for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; pts.push(v(Math.cos(a) * r, 0, Math.sin(a) * r * 0.55)); }
  return hull(pts, 30);
}

// 圆角星形骨板（背鳍、头饰、徽记）：五角星轮廓，尖角和内角都倒圆，挤出带倒角的厚片。
// 板面在局部 YZ 平面（侧面看是完整的星），沿 X 方向有厚度；原点在星的中心，+Y 是“上面那个尖”。
//   R 外半径  r 内半径（≈0.45R 胖星，≈0.38R 尖星）  depth 厚度  round 圆角大小（× R）
export function starPlate(R, r, depth, o = {}) {
  const n = o.points ?? 5, round = (o.round ?? 0.16) * R, bevel = o.bevel ?? depth * 0.35;
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / n, rr = i % 2 ? r : R;
    pts.push(new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr));
  }
  const shape = new THREE.Shape();
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const P = pts[i], A = pts[(i - 1 + m) % m], B = pts[(i + 1) % m];
    const rc = i % 2 ? round * 0.6 : round;
    const da = A.clone().sub(P), db = B.clone().sub(P);
    const ka = Math.min(rc / da.length(), 0.45), kb = Math.min(rc / db.length(), 0.45);
    const p0 = P.clone().addScaledVector(da, ka), p1 = P.clone().addScaledVector(db, kb);
    if (i === 0) shape.moveTo(p0.x, p0.y); else shape.lineTo(p0.x, p0.y);
    shape.quadraticCurveTo(P.x, P.y, p1.x, p1.y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * bevel, 1e-3), curveSegments: 6,
    bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 3,
  });
  g.translate(0, 0, -Math.max(depth - 2 * bevel, 1e-3) / 2);
  g.rotateY(Math.PI / 2);              // 星面 → YZ 平面
  g.deleteAttribute('uv');
  const out = creased(g, deg(o.crease ?? 40));
  out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  return out;
}

// ------------------------------------------------------------------ 骨骼树 + 零件
// 用法：const rig = new Rig(materialFactory)；rig.joint('neck', parent, [x,y,z])；rig.part(geo, opts, joint, pos, rot)
export class Rig {
  constructor(makeMaterial, idStart = 1, idCount = 60) {
    this.makeMaterial = makeMaterial;
    this.root = new THREE.Group();
    this.j = { root: this.root };
    this.meshes = [];
    this.anchors = {};
    this._id = 0; this.idStart = idStart; this.idCount = idCount;
  }
  nextId() { return this.idStart + (this._id++ % this.idCount); }   // 相邻零件 id 不同 → 接缝处出线
  joint(name, parent, pos = [0, 0, 0]) {
    const g = new THREE.Group(); g.name = name; g.position.set(...pos);
    (typeof parent === 'string' ? this.j[parent] : parent).add(g);
    this.j[name] = g;
    return g;
  }
  part(geo, opts, parent, pos = [0, 0, 0], rot = [0, 0, 0], scale) {
    const m = new THREE.Mesh(geo, this.makeMaterial({ id: opts.id ?? this.nextId(), ...opts }));
    m.position.set(...pos);
    m.rotation.set(deg(rot[0]), deg(rot[1]), deg(rot[2]));
    if (scale) m.scale.set(...scale);
    (typeof parent === 'string' ? this.j[parent] : parent).add(m);
    this.meshes.push(m);
    return m;
  }
  // 平面贴花（K2，Sunshower Robot.decal）：一块贴图平面贴在零件表面，和宿主同一个描线 id（贴花边缘不出线），
  // a < 0.5 的地方挖空；polygonOffset 防止和宿主表面闪烁。extra 透传给 celMaterial（shade、weather……）。
  //   rig.decal(paintTexture(...), hostMesh, 'chest', 0.4, 0.2, [0, 0.1, 0.251], [0, 0, 0])
  decal(tex, host, parent, w, h, pos, rot = [0, 0, 0], extra = {}) {
    const hu = host.material.uniforms;
    const m = celMaterial({ id: hu.uId.value, map: tex, mapCut: true, color: '#ffffff', ...extra });
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.position.set(...pos);
    mesh.rotation.set(deg(rot[0]), deg(rot[1]), deg(rot[2]));
    (typeof parent === 'string' ? this.j[parent] : parent).add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }
  // 锚点：其他部门（特效、镜头、音效声像）只读锚点，永远不要硬编码坐标
  anchor(name, parent, pos) {
    const o = new THREE.Object3D(); o.position.set(...pos);
    (typeof parent === 'string' ? this.j[parent] : parent).add(o);
    this.anchors[name] = o;
  }
  at(name, out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.anchors[name].matrixWorld); }
  // 关节欧拉角（度）
  rot(name, r) { this.j[name].rotation.set(deg(r[0]), deg(r[1]), deg(r[2])); }

  // ---- 简化碰撞体 + 自穿插体检（C4）：厚重分块机甲低坐 / 折腰时，胸甲、裙甲、大腿最容易互相穿模。
  // 建模时给关键零件挂球 / 胶囊（坐标在该关节的局部空间，单位与零件相同），表演写完后在探针里体检：
  //   rig.addCollider('thighR', 'thighR', { type: 'capsule', r: 60, a: [0, 0, 0], b: [0, -300, 0] })
  //   rig.addCollider('chest', 'chest', { r: 120, a: [0, 40, 10] })            // 球 = a 处半径 r
  //   rig.checkSelfCollision({ minDepth: 0.02 }) → [{ a: 'chest', b: 'thighR', depth: 0.31 }]（世界单位 m，最深的在前）
  // 默认跳过：同一关节、或互为父子关节的两个碰撞体（关节处本来就贴在一起）；o.ignore = [['skirtL', 'thighL'], …] 额外跳过。
  // 碰撞体不参与渲染，只是数据；不调用就零开销。
  addCollider(name, joint, o = {}) {
    const j = typeof joint === 'string' ? this.j[joint] : joint;
    (this.colliders ??= []).push({ name, joint: j, r: o.r ?? 1, a: new THREE.Vector3(...(o.a ?? [0, 0, 0])), b: new THREE.Vector3(...(o.b ?? o.a ?? [0, 0, 0])) });
    return this;
  }
  // 世界空间的胶囊（球 = 两端重合）
  colliderWorld(c) {
    c.joint.updateWorldMatrix(true, false);
    const m = c.joint.matrixWorld;
    return { a: c.a.clone().applyMatrix4(m), b: c.b.clone().applyMatrix4(m), r: c.r * m.getMaxScaleOnAxis() };
  }
  checkSelfCollision({ minDepth = 0, ignore = [] } = {}) {
    const cs = this.colliders ?? [], out = [];
    const skip = new Set(ignore.map(([x, y]) => [x, y].sort().join('|')));
    const W = cs.map((c) => this.colliderWorld(c));
    for (let i = 0; i < cs.length; i++) for (let k = i + 1; k < cs.length; k++) {
      const A = cs[i], B = cs[k];
      if (A.joint === B.joint || A.joint.parent === B.joint || B.joint.parent === A.joint) continue;
      if (skip.has([A.name, B.name].sort().join('|'))) continue;
      const depth = W[i].r + W[k].r - segSegDist(W[i].a, W[i].b, W[k].a, W[k].b);
      if (depth > minDepth) out.push({ a: A.name, b: B.name, depth: +depth.toFixed(3) });
    }
    return out.sort((x, y) => y.depth - x.depth);
  }
}

// 两条线段 p1p2、q1q2 的最近距离（Ericson, Real-Time Collision Detection 5.1.9）
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
export function segSegDist(p1, p2, q1, q2) {
  _d1.subVectors(p2, p1); _d2.subVectors(q2, q1); _r.subVectors(p1, q1);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(q1);
  if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s); _c2.copy(q1).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

// ------------------------------------------------------------------ 两骨 IK
// a/b/c 是三个关节（骨头沿各自 -Y 下垂），T 目标点、P 极向量点（肘/膝朝向），都在世界空间。
// bend = 1 下骨向局部 +Z 折（肘），-1 向 -Z 折（膝）。来自 LEVIATHAN archer.js。
const V = THREE.Vector3, Q = THREE.Quaternion, M4 = THREE.Matrix4;
const _S = new V();
export function solve2(a, b, c, T, P, bend = 1) {
  a.parent.updateWorldMatrix(true, false);
  const S = a.parent.localToWorld(_S.copy(a.position));
  const ks = a.parent.matrixWorld.getMaxScaleOnAxis() * a.scale.x;
  const L1 = b.position.length() * ks, L2 = c.position.length() * ks;
  const D = T.clone().sub(S);
  const d = Math.min(Math.max(D.length(), Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
  const dd = D.normalize();
  const h0 = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(L1 * L1 - h0 * h0, 0));
  const p = P.clone().sub(S);
  p.addScaledVector(dd, -p.dot(dd)).normalize();
  const E = S.clone().addScaledVector(dd, h0).addScaledVector(p, h);       // 肘/膝的位置
  const Tc = S.clone().addScaledVector(dd, d);
  const u = E.clone().sub(S).normalize();
  const f = Tc.clone().sub(E).normalize();
  const z = f.clone().addScaledVector(u, -f.dot(u));
  if (z.lengthSq() < 1e-6) z.copy(p);
  z.normalize().multiplyScalar(bend);
  const y = u.clone().negate();
  const x = new V().crossVectors(y, z);
  const qW = new Q().setFromRotationMatrix(new M4().makeBasis(x, y, z));
  const qP = a.parent.getWorldQuaternion(new Q());
  a.quaternion.copy(qP.invert().multiply(qW));
  b.rotation.set(-Math.acos(Math.min(1, Math.max(-1, u.dot(f)))) * bend, 0, 0);
  a.updateWorldMatrix(false, true);
}
