import * as THREE from 'three';
import { celMaterial, base, mat } from '../../core/materials.js';
import { COMMON, MRT_OUT, VERT_STD } from '../../core/glsl.js';
import { hull, superPts } from '../../core/kit.js';
import { screen } from '../../core/color.js';
import { Rng } from '../../core/util.js';
import { terrain } from './world.js';
import { ID } from './flower_model.js';

// 岩缝小景（K3）：两块灰岩夹一道缝，缝里是土和苔藓，花从缝口长出来；岩石埋进地里。
// 外加花旁的小水洼（雨后才有，映天色，lastDrop 一圈涟漪）。

// ---------------------------------------------------------------- 地面高度
// 草地部门的地形网格是 2.5 m 一格的三角面，和 terrain(x, z) 解析式最多差几厘米 —— 对 0.4 m 的小花来说就是“漂”或“陷”。
// 所以直接取场景里那张地形网格（最大的那块高面数网格），把花附近的三角形抠出来，按真实渲染的面插值高度。
// 找不到就退回 terrain()。
export function groundSampler(scene, cx, cz, half = 6) {
  let best = null;
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const p = o.geometry?.attributes?.position;
    if (!p || p.count < 20000) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb.max.x - bb.min.x < 300 || bb.max.z - bb.min.z < 300) return;
    if (!best || p.count > best.geometry.attributes.position.count) best = o;
  });
  if (!best) return (x, z) => terrain(x, z);
  best.updateMatrixWorld(true);
  const pos = best.geometry.attributes.position, idx = best.geometry.index;
  const M = best.matrixWorld;
  const tris = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const nT = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < nT; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    if (Math.max(a.x, b.x, c.x) < cx - half - 10 || Math.min(a.x, b.x, c.x) > cx + half + 10) continue;   // 粗筛（局部坐标）
    a.applyMatrix4(M); b.applyMatrix4(M); c.applyMatrix4(M);
    if (Math.max(a.x, b.x, c.x) < cx - half || Math.min(a.x, b.x, c.x) > cx + half) continue;
    if (Math.max(a.z, b.z, c.z) < cz - half || Math.min(a.z, b.z, c.z) > cz + half) continue;
    tris.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
  }
  return (x, z) => {
    for (const T of tris) {
      const [x0, y0, z0, x1, y1, z1, x2, y2, z2] = T;
      const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(d) < 1e-9) continue;
      const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
      const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 >= -1e-6 && l1 >= -1e-6 && l2 >= -1e-6) return l0 * y0 + l1 * y1 + l2 * y2;
    }
    return terrain(x, z);
  };
}

// ---------------------------------------------------------------- 岩石材质（K3：灰白、硬边色块的绘画笔触、苔藓斑、湿了变深）
const ROCK_PAT = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  vec3 q = p * uRockScale + uRockSeed;
  vec3 c = cRock; gShade = cRockS;
  // 大块深一档的色块（硬边，岛屿形状）
  float f1 = fbm3(q * 2.2 + vec3(fbm3(q * 1.3)) * 0.8);
  float dk = step(0.56, f1);
  c = mix(c, cRock2, dk); gShade = mix(gShade, cRock2S, dk);
  // 薰衣草色的冷色块（K3 岩面上一块块偏紫的笔触）
  float lv = step(0.6, fbm3(q * 1.7 + 31.0)) * (1.0 - dk);
  c = mix(c, cRockL, lv); gShade = mix(gShade, cRock2S, lv);
  // 亮一档的刷痕（受光面上横向拉长的笔触）
  float f2 = fbm3(vec3(q.x * 5.0, q.y * 1.6, q.z * 5.0) + 3.0);
  float lt = step(0.6, f2) * (1.0 - dk);
  c = mix(c, cRock3, lt);
  // 细裂纹：fbm 的等值线
  float f3 = fbm3(q * 3.1 + 9.0);
  float crack = (1.0 - step(0.006, abs(f3 - 0.5))) * step(0.52, fbm3(q * 1.1 + 20.0));
  c = mix(c, cCrack, crack * 0.85); gShade = mix(gShade, cCrack * 0.8, crack * 0.85);
  // 苔藓：朝上的面 + 靠近缝的一侧（局部 -X）更多，硬边斑块，里面再分两档
  float up = n.y + 0.35 * (fbm3(q * 4.0 + 5.0) - 0.5) * 2.0 - 0.3 * p.x / uRockW;
  float mf = fbm3(q * 9.0 + 17.0) + 0.25 * (fbm3(q * 2.0 + 4.0) - 0.5);
  float moss = step(0.5, up) * step(0.6 - 0.08 * uMossK, mf);
  float mossHi = step(0.6, fbm3(q * 11.0 + 2.0));
  vec3 mc = mix(cMoss, cMoss2, mossHi);
  c = mix(c, mc, moss); gShade = mix(gShade, cMossS, moss);
  // 湿：深一档、偏冷
  c *= mix(vec3(1.0), vec3(0.66, 0.66, 0.74), uWet);
  gShade *= mix(vec3(1.0), vec3(0.72, 0.72, 0.8), uWet);
  return vec4(c, 0.0);
}`;
const SOIL_PAT = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  vec3 q = p * 9.0 + uRockSeed;
  vec3 c = cSoil; gShade = cSoilS;
  float m = max(step(0.47, fbm3(q * 1.6)) * step(0.1, n.y), uMossAll);
  float hi = step(0.62, fbm3(q * 4.0 + 3.0));
  c = mix(c, mix(cMoss, cMoss2, hi), m); gShade = mix(gShade, cMossS, m);
  c *= mix(vec3(1.0), vec3(0.7, 0.7, 0.76), uWet);
  gShade *= mix(vec3(1.0), vec3(0.75, 0.75, 0.82), uWet);
  return vec4(c, 0.0);
}`;
export function rockMats(uWet) {
  const S = screen;
  const cols = {
    cRock: S('#cdcacb'), cRockS: S('#9e9cb0'), cRock2: S('#b6b3b8'), cRock2S: S('#8b89a2'), cRock3: S('#dedbd8'), cRockL: S('#bdbac8'),
    cCrack: S('#7b7380'), cMoss: S('#8f9a4e'), cMoss2: S('#aab35f'), cMossS: S('#5f6b4c'),
  };
  const mk = (id, seed, w, mossK) => celMaterial({
    id, color: cols.cRock, shade: '#9d9aae', ink: '#5d5664', wear: 0, gloss: 0, sunTint: 0.22, pattern: ROCK_PAT, colors: cols,
    uniforms: { uRockSeed: new THREE.Vector3(seed, seed * 1.7, seed * 2.3), uRockScale: 2.2, uRockW: w, uMossK: mossK, uWet },
  });
  const soil = celMaterial({
    id: ID.soil, sunTint: 0.4, color: S('#6f5e52'), shade: '#4e4658', ink: '#3f3540', wear: 0, gloss: 0, pattern: SOIL_PAT,
    colors: { cSoil: S('#6f5e52'), cSoilS: S('#4e4658'), cMoss: S('#86964a'), cMoss2: S('#a7b35c'), cMossS: S('#56664a') },
    uniforms: { uRockSeed: new THREE.Vector3(3, 5, 7), uWet, uMossAll: 0 },
  });
  const moss = celMaterial({
    id: ID.soil, sunTint: 0.4, color: S('#86964a'), shade: '#56664a', wear: 0, gloss: 0, pattern: SOIL_PAT,
    colors: { cSoil: S('#6f5e52'), cSoilS: S('#4e4658'), cMoss: S('#86964a'), cMoss2: S('#a7b35c'), cMossS: S('#56664a') },
    uniforms: { uRockSeed: new THREE.Vector3(1, 2, 3), uWet, uMossAll: 1 },
  });
  return { A: mk(ID.rockA, 1.3, 0.45, 1), B: mk(ID.rockB, 6.1, 0.4, 0.6), soil, moss };
}

// 一块“圆中带棱”的岩石：方一点的超椭球 + 噪声起伏 + 几刀平切（朝缝的一面切成陡面）→ 凸包，折角 > 36° 出棱线
function rockGeo(rx, ry, rz, rng, innerCut) {
  const bumps = [0, 1, 2, 3, 4].map(() => [rng.range(-1, 1), rng.range(-0.3, 1), rng.range(-1, 1), rng.range(0.04, 0.1)]);
  const cuts = [0, 1, 2, 3, 4, 5].map(() => { const a = rng.range(0, 6.28), e = rng.range(0.22, 0.82); return [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), rng.range(0.75, 0.87)]; });
  const pts = superPts(rx, ry, rz, 2.5, 13, (q) => {
    const nx = q.x / rx, ny = q.y / ry, nz = q.z / rz;
    let k = 1 + rng.range(-0.03, 0.03);
    for (const [bx, by, bz, h] of bumps) { const d = (nx - bx) ** 2 + (ny - by) ** 2 + (nz - bz) ** 2; k += h * Math.exp(-d * 3); }
    q.multiplyScalar(k);
    for (const [cx, cy, cz, o] of cuts) {          // 平切：超出平面的点压回平面
      const d = (q.x / rx) * cx + (q.y / ry) * cy + (q.z / rz) * cz;
      if (d > o) { const s = (d - o); q.x -= s * cx * rx; q.y -= s * cy * ry; q.z -= s * cz * rz; }
    }
    if (q.y > ry * 0.76) q.y = ry * 0.76 + (q.y - ry * 0.76) * 0.32;          // 顶面略平
    if (innerCut && q.x < -rx * innerCut(q.y / ry)) q.x = -rx * innerCut(q.y / ry);   // 朝缝的陡面（上宽下窄的 V 形缝）
  });
  const g = hull(pts, 28);
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

// 岩缝小景：rock = 岩缝中心，flower = 缝口（花）。gy = 地面高度函数。返回 { group, soilY(x,z), mats }
export function makeCrack(F, Rk, gy, uWet) {
  const group = new THREE.Group();
  const M = rockMats(uWet);
  const rng = new Rng(23);
  let dx = F[0] - Rk[0], dz = F[1] - Rk[1];
  let dl = Math.hypot(dx, dz);
  if (dl < 0.15) { dx = 0; dz = -1; dl = 1; }
  dx /= dl; dz /= dl;
  const px = -dz, pz = dx;                                   // 缝的横向
  // 缝从岩缝中心后方一直通到花的前方（配合手掌尺度的海石竹放大岩块与缝宽）
  const back = Math.max(0.95, dl + 0.38), front = 0.30;
  const a0 = [F[0] - dx * back, F[1] - dz * back], a1 = [F[0] + dx * front, F[1] + dz * front];
  const mid = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2], Lc = back + front;
  const gap = 0.17;                                          // 缝底宽（单侧），容纳放大后的基生叶丛
  const rocks = [
    { side: 1, rx: 0.62, ry: 0.56, rz: Math.max(0.84, Lc * 0.58), mat: M.A, along: -0.05, hTop: 0.46 },
    { side: -1, rx: 0.54, ry: 0.48, rz: Math.max(0.74, Lc * 0.52), mat: M.B, along: -0.14, hTop: 0.36 },
  ];
  const meshes = [];
  for (const r of rocks) {
    const g = rockGeo(r.rx, r.ry, r.rz, rng, (yn) => 0.9 - 0.18 * Math.max(0, yn));   // 内侧面：越往上越往外退
    // 岩石中心离缝线 = 内侧面的退让量 + 缝宽
    const off = r.rx * 0.9 + gap;
    const cx = mid[0] + px * off * r.side + dx * r.along, cz = mid[1] + pz * off * r.side + dz * r.along;
    // 埋进地里：中心放在脚印内最低地面以下一点，露出 hTop
    let gmin = Infinity;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      for (const k of [0.5, 1]) gmin = Math.min(gmin, gy(cx + Math.cos(a) * r.rx * k, cz + Math.sin(a) * r.rz * k));
    }
    const m = new THREE.Mesh(g, r.mat);
    // 局部 x 指向远离缝的一侧，局部 z 沿缝
    const X = new THREE.Vector3(px * r.side, 0, pz * r.side), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3().crossVectors(X, Y);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    m.position.set(cx, gmin + r.hTop - r.ry * 0.82, cz);
    group.add(m); meshes.push(m);
  }
  // 缝里的土 + 苔藓：沿缝的一条低土埂
  const soilTop = gy(F[0], F[1]) + 0.14;
  const sg = hull(superPts(0.28, 0.22, Lc * 0.46, 2.2, 10, (q) => q.multiplyScalar(rng.range(0.92, 1.08))), 50);
  sg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sg.attributes.position.count * 2), 2));
  const soil = new THREE.Mesh(sg, M.soil);
  soil.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(px, 0, pz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(px, 0, pz).cross(new THREE.Vector3(0, 1, 0))));
  soil.position.set(mid[0] - dx * 0.04, soilTop - 0.20, mid[1] - dz * 0.04);
  group.add(soil);
  // 花脚下的苔藓垫和小石子
  for (let i = 0; i < 9; i++) {
    const t = rng.range(-0.35, 1), s = rng.sign() * rng.range(0.06, 0.26);
    const x = F[0] - dx * t * 0.55 + px * s, z = F[1] - dz * t * 0.55 + pz * s;
    const r = rng.range(0.055, 0.12);
    const mg = hull(superPts(r * 1.3, r * 0.5, r, 2.2, 6, (q) => q.multiplyScalar(rng.range(0.85, 1.12))), 50);
    mg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mg.attributes.position.count * 2), 2));
    const mm = new THREE.Mesh(mg, M.moss);
    mm.position.set(x, Math.max(gy(x, z), soilTop - 0.03) + r * 0.1, z);
    mm.rotation.y = rng.range(0, 6.28);
    group.add(mm);
  }
  for (let i = 0; i < 6; i++) {
    const a = rng.range(0, 6.28), d = rng.range(0.28, 0.62);
    const x = F[0] + Math.cos(a) * d + dx * 0.18, z = F[1] + Math.sin(a) * d + dz * 0.18;
    const r = rng.range(0.028, 0.065);
    const pg = hull(superPts(r * 1.2, r * 0.7, r, 2.4, 5, (q) => q.multiplyScalar(rng.range(0.85, 1.1))), 40);
    pg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pg.attributes.position.count * 2), 2));
    const pm = new THREE.Mesh(pg, M.B);
    pm.position.set(x, gy(x, z) + r * 0.25, z);
    group.add(pm);
  }
  return { group, soilTop, dir: [dx, dz], mats: M, rocks: meshes };
}

// ---------------------------------------------------------------- 水洼
// 贴地的一片不规则水面（id 101：不描线）。颜色 = 反射方向上的天色（读天穹的 uniform），掠射时更亮；
// 太阳在反射方向上时一道硬边金色高光；外圈一圈湿泥边。涟漪：rings 里每个 (x, z, t0, 强度)，一拍三。
const PUDDLE_FS = /* glsl */ `
${COMMON}
${MRT_OUT}
uniform vec3 uZen, uMidC, uHor, uMud;
uniform vec4 uNagiRefl;
uniform float uFill, uFxT, uRain;
uniform vec4 uRip[4];
varying vec3 vWorld, vNormalW, vNormalV;
varying float vDepth;
varying vec2 vUv;
void main(){
  if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
  if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
  float r = vUv.x;                         // 0 中心 → 1 外缘
  if(r > uFill) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  vec2 g = vec2(0.0);
  float ringK = 0.0;
  for(int i = 0; i < 4; i++){
    vec4 R = uRip[i];
    float age = uFxT - R.z;
    if(R.w <= 0.0 || age < 0.0 || age > 2.2) continue;
    vec2 d = vWorld.xz - R.xy; float L = length(d) + 1e-4;
    float rad = 0.04 + age * 0.32;
    float env = R.w * exp(-age * 1.6);
    float w = exp(-pow((L - rad) / 0.018, 2.0));
    float w2 = exp(-pow((L - rad * 0.6) / 0.014, 2.0)) * 0.6;
    g += d / L * (w - w2) * env * 2.0;
    ringK = max(ringK, step(0.45, (w + w2) * env));
  }
  // 雨点：每 0.125 s 一批随机小圈（暴雨里水洼在跳）
  if(uRain > 0.01){
    vec2 cell = floor(vWorld.xz / 0.12);
    float ph = floor(uFxT * 8.0);
    for(int k = 0; k < 4; k++){
      vec2 c = cell + vec2(float(k / 2), float(k - k / 2 * 2)) - 0.5;
      vec2 h = hash22(c + ph * 1.31);
      if(h.x > uRain * 0.7) continue;
      vec2 ctr = (c + h) * 0.12;
      float L = length(vWorld.xz - ctr);
      float rad = 0.01 + fract(uFxT * 8.0) * 0.05;
      ringK = max(ringK, step(abs(L - rad), 0.004));
    }
  }
  vec3 N = normalize(vec3(-g.x * 0.6, 1.0, -g.y * 0.6));
  vec3 Rf = reflect(-V, N);
  float el = Rf.y;
  // 天色分三档（赛璐璐式色阶，不是平滑渐变）
  vec3 sky = mix(uHor, uMidC, step(0.18, el));
  sky = mix(sky, uZen, step(0.55, el));
  // 倒映凪（K5“水洼映着凪”）：反射射线投向凪躯干/肩甲椭球时映出暖白与红条带倒影
  if(uNagiRefl.w > 0.01 && Rf.y > 0.02){
    vec3 oc = vWorld - uNagiRefl.xyz;
    vec3 sc = vec3(1.0 / 5.4, 1.0 / 6.2, 1.0 / 4.8);
    vec3 ro = oc * sc, rd = Rf * sc;
    float a2 = dot(rd, rd), b2 = dot(ro, rd), c2 = dot(ro, ro) - 1.0;
    float disc = b2 * b2 - a2 * c2;
    if(disc > 0.0 && -b2 > 0.0){
      vec3 hitP = vWorld + Rf * ((-b2 - sqrt(disc)) / a2);
      float bandR = step(abs((hitP.y - (uNagiRefl.y - 1.2))), 0.45);
      vec3 nCol = mix(mix(vec3(0.58, 0.62, 0.74), uSunColor * 0.92, 0.45 * uSunStrength), vec3(0.68, 0.28, 0.24), bandR);
      sky = mix(sky, nCol, 0.82 * uNagiRefl.w);
    }
  }
  float fres = 0.50 + 0.50 * pow(1.0 - max(V.y, 0.0), 1.8);
  vec3 c = mix(uMud, sky * (1.04 + 0.16 * uSunStrength * (1.0 - uRain)), fres);
  float sg = dot(Rf, uSunDir);
  c = mix(c, uSunColor * 1.38, step(0.965, sg) * uSunStrength * (1.0 - uRain));
  c = mix(c, c * 1.22 + uSunColor * 0.08 * uSunStrength, ringK);
  // 湿泥边
  float edge = step(uFill - 0.11, r);
  c = mix(c, uMud * 0.9, edge);
  writeOut(c, 1.0, normalize(vNormalV), vDepth, 101.0);
}`;
const PUDDLE_VS = /* glsl */ `
${VERT_STD}
void main(){ stdVertex(position, normal); }`;

export function makePuddle(P, gy, rx = 0.76, rz = 0.50, yaw = 0.4) {
  const rng = new Rng(31);
  const NA = 48, NRg = 6;
  const amp = [0, 1, 2, 3].map(() => [rng.range(0.04, 0.12), rng.range(0, 6.28)]);
  const pos = [], uv = [], idx = [];
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  for (let j = 0; j <= NRg; j++) for (let i = 0; i < NA; i++) {
    const a = (i / NA) * Math.PI * 2, f = j / NRg;
    let k = 1;
    amp.forEach(([A, ph], n) => { k += A * Math.sin(a * (n + 2) + ph); });
    const lx = Math.cos(a) * rx * k * f, lz = Math.sin(a) * rz * k * f;
    const x = P[0] + lx * cy - lz * sy, z = P[1] + lx * sy + lz * cy;
    pos.push(x, gy(x, z) + 0.012, z);
    uv.push(f, i / NA);
  }
  for (let j = 0; j < NRg; j++) for (let i = 0; i < NA; i++) {
    const a = j * NA + i, b = j * NA + (i + 1) % NA, c = a + NA, d = b + NA;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const u = base({
    uZen: { value: new THREE.Color('#5c8fd0') }, uMidC: { value: new THREE.Color('#9cc0e6') }, uHor: { value: new THREE.Color('#f2efe6') },
    uMud: { value: new THREE.Color(screen('#5b5048')) }, uFill: { value: 1 }, uFxT: { value: 0 }, uRain: { value: 0 },
    uNagiRefl: { value: new THREE.Vector4(0, 0, 0, 0) },
    uRip: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
  });
  const m = mat(u, PUDDLE_VS, PUDDLE_FS);
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  const mesh = new THREE.Mesh(g, m);
  return { mesh, u, center: new THREE.Vector3(P[0], gy(P[0], P[1]) + 0.012, P[1]) };
}
