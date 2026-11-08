import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { screen } from '../../core/color.js';
import { Rng, smooth, clamp } from '../../core/util.js';

// 单朵大白花模型（对照 K1a / K5 的单朵大白花造型，替代原 K3 多朵攒球的海石竹）：
//   - 基生叶丛 + 3 片随花茎弯曲的宽茎生叶（K1a / K5 特征）
//   - 花头 = 5 片翠绿带红尖的花萼（calyx）+ 内外两层共 10 片宽大碗状白花瓣 + 中央暖金花盘与 18 根金黄花蕊（stamens）
//   - 花苞态（k = 0）：花萼半抱，10 片大花瓣向上合拢交叠成饱满的粉白水滴形大花苞
//   - 绽放态（k: 0 → 1）：花萼率先外翻托底，外层 5 瓣与内层 5 瓣依次弹性舒展成碗状大花，金黄花蕊向外散开
// 单位：米。描线 id 76–85（CONTRACT §8）。

export const ID = { rockA: 76, rockB: 77, soil: 78, leafA: 79, leafB: 80, bractA: 81, bractB: 82, petalA: 83, petalB: 84, stem: 85 };
export const HEX = {
  leafLit: '#9ab87a', leafDark: '#5b7e54', leafLitS: '#728d7c', leafDarkS: '#476252', leafBase: '#bcb178', leafBaseS: '#8d836f', leafInk: '#394838',
  stem: '#8ca874', stemS: '#617a64',
  sepal: '#84a468', sepalTip: '#cfa89e', sepalBase: '#698754', sepalS: '#5a745c', sepalTipS: '#9d797e', sepalInk: '#3f4c3d',
  petal: '#fefdfb', petalBlush: '#f6e2e6', petalLav: '#eceaf6', petalS: '#e2dff0',
  heart: '#fae278', heartS: '#d6b05c', anther: '#f5b82e', antherS: '#c98826', filament: '#fbe88c', petalInk: '#786e88',
};
const C3 = (h) => screen(h);

// ---------------------------------------------------------------- 网格工具
// fn(u, v) → [x, y, z]，u ∈ [0,1] 沿长度，v ∈ [-1,1] 横向；uv = (u, (v+1)/2)
export function gridGeo(nu, nv, fn) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const u = i / nu, v = -1 + (2 * j) / nv;
    pos.push(...fn(u, v)); uv.push(u, (v + 1) / 2);
  }
  const W = nv + 1;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- 材质
const LEAF_PAT = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  float side = vUv.y + 0.06 * sin(vUv.x * 17.0 + uLeafSeed) * (1.0 - vUv.x);
  float dk = step(side, 0.5);
  vec3 c = mix(cLeafLit, cLeafDark, dk);
  gShade = mix(cLeafLitS, cLeafDarkS, dk);
  float base = 1.0 - step(0.11 + 0.05 * sin(vUv.y * 11.0 + uLeafSeed), vUv.x);
  c = mix(c, cLeafBase, base); gShade = mix(gShade, cLeafBaseS, base);
  return vec4(c, 0.0);
}`;

const SEPAL_PAT = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  float u = vUv.x, e = abs(vUv.y - 0.5) * 2.0;
  vec3 c = mix(cSepalBase, cSepal, smoothstep(0.0, 0.45, u));
  gShade = cSepalS;
  float tip = smoothstep(0.62, 0.92, u + 0.08 * e);
  c = mix(c, cSepalTip, tip * 0.75);
  gShade = mix(gShade, cSepalTipS, tip * 0.65);
  return vec4(c, 0.0);
}`;

const PETAL_PAT = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  // 单朵大花瓣：根部暖金黄晕染，花瓣主体清透奶白，带极细纵向手绘瓣脉；
  // 未开花苞态（uBloom → 0）时瓣尖与外背带柔和粉晕，盛开后（uBloom → 1）舒展成纯净发光的白花瓣
  float u = vUv.x;
  float v = vUv.y - 0.5;
  float e = abs(v) * 2.0;
  vec3 c = cPetal;
  gShade = cPetalS;
  // 纵向浅瓣脉（3 条柔和凹脉）
  float vein = smoothstep(0.06, 0.0, abs(abs(v) - 0.16) - 0.012) + 0.7 * smoothstep(0.05, 0.0, abs(v) - 0.01);
  vein *= smoothstep(0.15, 0.35, u) * (1.0 - smoothstep(0.72, 0.92, u));
  c = mix(c, cPetalLav, vein * 0.28 + uRingLav * 0.18);
  // 花苞期瓣尖柔和粉晕（随盛开 uBloom 渐隐为少许温润边晕）
  float tipBlush = smoothstep(0.52, 0.92, u + 0.12 * e) * mix(0.85, 0.18, uBloom);
  c = mix(c, cPetalBlush, tipBlush);
  gShade = mix(gShade, cPetalS * vec3(0.98, 0.92, 0.95), tipBlush);
  // 花瓣基部金色花心晕染（K1a / K5 中心暖黄光感）
  float throat = 1.0 - smoothstep(0.08, 0.30 - 0.06 * e, u);
  c = mix(c, cHeart, throat * 0.88);
  gShade = mix(gShade, cHeartS, throat * 0.82);
  // 薄瓣透光感（a 通道给 celMaterial 做 unlit 提亮，使暴雨屋檐下与逆光下都温润可读）
  return vec4(c, 0.44 + 0.12 * throat);
}`;

export function makeMats(o = {}) {
  const shared = { wear: 0, gloss: 0, ...(o.extra ?? {}) };
  // uBrown 保留原字段名供外部与确定性逻辑复用，此处存开花度 uBloom ∈ [0,1]
  const uBrown = { value: 0 };
  const leafCols = {
    cLeafLit: C3(HEX.leafLit), cLeafDark: C3(HEX.leafDark),
    cLeafLitS: C3(HEX.leafLitS), cLeafDarkS: C3(HEX.leafDarkS),
    cLeafBase: C3(HEX.leafBase), cLeafBaseS: C3(HEX.leafBaseS),
  };
  const leaf = [ID.leafA, ID.leafB].map((id, i) => celMaterial({
    ...shared, id, sunTint: 0.48, color: C3(HEX.leafLit), shade: HEX.leafDarkS,
    ink: HEX.leafInk, pattern: LEAF_PAT, colors: leafCols, uniforms: { uLeafSeed: i * 3.7 },
  }));
  const stem = celMaterial({ ...shared, id: ID.stem, sunTint: 0.48, color: C3(HEX.stem), shade: HEX.stemS, ink: HEX.leafInk });
  const sepalCols = {
    cSepal: C3(HEX.sepal), cSepalTip: C3(HEX.sepalTip), cSepalBase: C3(HEX.sepalBase),
    cSepalS: C3(HEX.sepalS), cSepalTipS: C3(HEX.sepalTipS),
  };
  const bract = [ID.bractA, ID.bractB].map((id) => celMaterial({
    ...shared, id, sunTint: 0.38, color: C3(HEX.sepal), shade: HEX.sepalS,
    ink: HEX.sepalInk, pattern: SEPAL_PAT, colors: sepalCols,
  }));
  const petalCols = {
    cPetal: C3(HEX.petal), cPetalBlush: C3(HEX.petalBlush), cPetalLav: C3(HEX.petalLav),
    cPetalS: C3(HEX.petalS), cHeart: C3(HEX.heart), cHeartS: C3(HEX.heartS),
  };
  const petal = [];
  for (const lav of [0.0, 0.35]) {
    for (const id of [ID.petalA, ID.petalB]) {
      petal.push(celMaterial({
        ...shared, id, color: C3(HEX.petal), shade: HEX.petalS, shadeFollow: 0.18,
        ink: HEX.petalInk, pattern: PETAL_PAT, colors: petalCols,
        uniforms: { uRingLav: lav, uBloom: uBrown }, sunTint: 0.35, rim: 0.38,
      }));
    }
  }
  // 中央花盘与花蕊材质（带柔和自发光感，在檐下暗部也温暖醒目）
  const core = celMaterial({
    ...shared, id: ID.bractB, sunTint: 0.35, color: C3(HEX.anther), shade: HEX.antherS, ink: HEX.petalInk,
    pattern: `vec4 pattern(vec3 p, vec3 n){ return vec4(mix(cHeart, cAnther, smoothstep(-0.2, 0.6, n.y)), 0.48); }`,
    colors: { cHeart: C3(HEX.heart), cAnther: C3(HEX.anther) },
  });
  const stamenMat = celMaterial({
    ...shared, id: ID.bractA, sunTint: 0.35, color: C3(HEX.filament), shade: HEX.heartS, ink: HEX.petalInk,
    pattern: `vec4 pattern(vec3 p, vec3 n){ float tip = step(0.68, vUv.y); gShade = mix(cFilS, cAnthS, tip); return vec4(mix(cFil, cAnth, tip), 0.52); }`,
    colors: { cFil: C3(HEX.filament), cFilS: C3(HEX.heartS), cAnth: C3(HEX.anther), cAnthS: C3(HEX.antherS) },
  });
  const budCore = celMaterial({
    ...shared, id: ID.petalA, sunTint: 0.32, color: C3(HEX.petalBlush), shade: HEX.petalS, ink: HEX.petalInk,
    pattern: `vec4 pattern(vec3 p, vec3 n){ float u = clamp(p.y * 0.5 + 0.5, 0.0, 1.0); return vec4(mix(cP, cB, u), 0.38); }`,
    colors: { cP: C3(HEX.petal), cB: C3(HEX.petalBlush) },
  });
  return { leaf, stem, bract, petal, core, stamenMat, budCore, uBrown };
}

// ---------------------------------------------------------------- 叶片与花萼几何
function leafGeo(L, w0, th0, th1, fold, twist, broad = 1.0) {
  const N = 14;
  const P = [[0, 0]], TH = [];
  for (let i = 0; i <= N; i++) TH.push(th0 + (th1 - th0) * Math.pow(i / N, 1.65));
  for (let i = 1; i <= N; i++) {
    const a = (TH[i] + TH[i - 1]) / 2, [x, y] = P[i - 1];
    P.push([x + Math.sin(a) * L / N, y + Math.cos(a) * L / N]);
  }
  const hw = (u) => w0 * broad * (u < 0.22
    ? 0.55 + 0.45 * Math.sin((u / 0.22) * Math.PI / 2)
    : Math.pow(Math.sin(((1 - u) / 0.78) * Math.PI / 2), 0.75));
  return gridGeo(N, 2, (u, v) => {
    const i = Math.round(u * N), [x, y] = P[i], th = TH[i];
    const ax = -Math.cos(th), ay = Math.sin(th);
    const tw = twist * u, w = hw(u) * v;
    const lift = fold * Math.abs(v) * hw(u);
    const cz = Math.cos(tw), sz = Math.sin(tw);
    return [x + ax * (lift + w * sz), y + ay * (lift + w * sz), w * cz];
  });
}

// 翠绿花萼片：沿 +X 伸出，带自然内弧，花苞期托住花苞下半部，开花时外翻
function sepalGeo(L, W) {
  return gridGeo(8, 4, (u, v) => {
    const profile = Math.sin(Math.pow(u, 0.72) * Math.PI);
    const z = v * W * profile;
    const x = u * L;
    const cup = 0.22 * L * Math.sin(u * Math.PI) + 0.035 * L * (1 - v * v) * u;
    return [x, cup, z];
  });
}

// ---------------------------------------------------------------- 单朵大花瓣几何
// 沿 +X 伸展（法线朝 +Y），根部在原点：绕 Z 轴旋转控制合拢（花苞）与盛开（碗状）
// 采用宽圆勺状轮廓（u → 1 时保持宽幅圆弧瓣尖 + 浅心形缺口，避免尖角三角形），纵向带柔美碗状弧度
function bigPetalGeo(L, W, cupDepth, notch, rng) {
  const tw = rng.range(-0.10, 0.10);
  return gridGeo(12, 10, (u, v) => {
    // 宽度从基部窄柄展开，到 u = 0.72 达最大宽度，至瓣尖保持饱满宽幅圆弧
    const rise = Math.pow(Math.sin(Math.min(u / 0.72, 1) * Math.PI / 2), 1.08);
    const tipTaper = u > 0.72 ? 1 - 0.14 * Math.pow((u - 0.72) / 0.28, 1.4) : 1;
    const hw = W * (0.12 + 0.88 * rise * tipTaper);
    const z = v * hw;
    // 瓣尖圆弧（中心前伸、两侧圆润回落）+ 中央浅缺口（K5 / K1a 宽瓣花特征）
    const roundArc = 0.74 + 0.26 * Math.sqrt(Math.max(0, 1 - v * v * 0.86));
    const tipNotch = notch * Math.max(0, 1 - Math.abs(v + tw * 0.2) / 0.26);
    const tipX = L * (roundArc - tipNotch);
    const x = u * tipX;
    const xn = clamp(x / L, 0, 1);
    // 纵向碗状内兜（合拢时围成圆润花苞，盛开时成舒展浅碗）+ 横向勺状微凹与中脉折痕
    const archY = cupDepth * L * Math.sin(Math.pow(xn, 0.85) * Math.PI * 0.88);
    const dishY = 0.14 * W * (v * v) * Math.sin(xn * Math.PI * 0.9);
    const pleatY = -0.022 * W * (1 - Math.abs(v)) * u;
    return [x, archY + dishY + pleatY, z];
  });
}

// 花蕊几何（细花丝 + 顶端饱满花药小槌）
function stamenGeo(L, rFil, rAnth) {
  return gridGeo(8, 6, (u, v) => {
    const th = (v + 1) * Math.PI;
    const isAnth = u > 0.72;
    const au = isAnth ? (u - 0.72) / 0.28 : 0;
    const rad = isAnth ? rFil + (rAnth - rFil) * Math.sin(au * Math.PI) : rFil * (1 - 0.2 * u);
    const x = u * L;
    const y = 0.10 * L * u * u + rad * Math.cos(th);
    const z = rad * Math.sin(th);
    return [x, y, z];
  });
}

// ---------------------------------------------------------------- 整株组装
export function makePlant(M, o = {}) {
  const rng = new Rng(o.seed ?? 7);
  const root = new THREE.Group();
  const meshes = [];
  const add = (parent, geo, mat) => { const m = new THREE.Mesh(geo, mat); parent.add(m); meshes.push(m); return m; };

  // ---- 1. 基生叶：16 片草本植物叶片
  const leaves = [];
  const NL = o.leaves ?? 16;
  for (let i = 0; i < NL; i++) {
    const inner = i < NL * 0.38, low = i >= NL * 0.80;
    const az = i * 2.39996 + rng.range(-0.28, 0.28);
    const L = low ? rng.range(0.08, 0.13) : inner ? rng.range(0.18, 0.25) : rng.range(0.14, 0.22);
    const w0 = rng.range(0.012, 0.017) * (low ? 0.85 : inner ? 1.05 : 0.95);
    const th0 = inner ? rng.range(0.12, 0.36) : low ? rng.range(0.68, 1.05) : rng.range(0.36, 0.74);
    const th1 = th0 + (inner ? rng.range(0.45, 0.98) : rng.range(0.82, 1.42));
    const pivot = new THREE.Group();
    pivot.rotation.y = az;
    pivot.position.set(Math.cos(az) * 0.004, 0, -Math.sin(az) * 0.004);
    const sway = new THREE.Group(); pivot.add(sway);
    add(sway, leafGeo(L, w0, th0, th1, rng.range(0.14, 0.30), rng.range(-0.26, 0.26), 1.15), M.leaf[i % 2]);
    root.add(pivot);
    leaves.push({ sway, ph: rng.range(0, 10), k: inner ? 0.6 : 1 });
  }

  // ---- 2. 茎生叶：2 片对生/互生宽叶（朝左右两侧横向舒展弯垂，还原 K1a / K5 茎生叶剪影）
  const stemLeaves = [];
  const stemLeafSpecs = [
    { s: 0.28, az: 0.15, L: 0.165, w: 0.020, th0: 0.95, th1: 1.62 },
    { s: 0.46, az: 3.25, L: 0.145, w: 0.018, th0: 0.90, th1: 1.56 },
  ];
  stemLeafSpecs.forEach((sp, idx) => {
    const holder = new THREE.Group();
    const pv = new THREE.Group(); pv.rotation.y = sp.az + rng.range(-0.10, 0.10); holder.add(pv);
    const sway = new THREE.Group(); pv.add(sway);
    add(sway, leafGeo(sp.L, sp.w, sp.th0, sp.th1, 0.16, rng.range(-0.12, 0.12), 1.25), M.leaf[idx % 2]);
    root.add(holder);
    leaves.push({ sway, ph: rng.range(0, 10), k: 0.75 });
    stemLeaves.push({ holder, s: sp.s });
  });

  // ---- 3. 花茎：每帧按弯曲重建的圆管
  const NS = 16, NR = 6;
  const stemLen = o.stemLen ?? 0.33;
  const sg = new THREE.BufferGeometry();
  const nV = (NS + 1) * NR;
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
  sg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
  sg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nV * 2), 2));
  const sidx = [];
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = i * NR + j, b = i * NR + (j + 1) % NR, c = a + NR, d = b + NR;
    sidx.push(a, b, c, b, d, c);
  }
  sg.setIndex(sidx);
  const stem = add(root, sg, M.stem);
  stem.frustumCulled = false;
  const curve = { k1: rng.range(0.06, 0.11), dir: rng.range(0, 6.28) };

  // ---- 4. 单朵大花头（head 带 bloomNod 子节点，盛开时花冠自然向镜头/斜上方微倾 24°，正侧面都能看到饱满的碗状花瓣与黄金花心）
  const head = new THREE.Group(); root.add(head);
  const crown = new THREE.Group(); head.add(crown);
  const H = 0.095, R = 0.044, GR = 0.086;

  // (a) 5 片翠绿花萼（calyx sepals）：托在花托底部
  const sepals = [];
  const sepG = sepalGeo(0.050, 0.017);
  for (let i = 0; i < 5; i++) {
    const az = (i / 5) * Math.PI * 2 + rng.range(-0.06, 0.06);
    const pv = new THREE.Group(); pv.rotation.y = az; crown.add(pv);
    const hinge = new THREE.Group();
    hinge.position.set(0.008, 0.002, 0);
    pv.add(hinge);
    add(hinge, sepG, M.bract[i % 2]);
    sepals.push({ hinge, open0: 1.04 + rng.range(-0.04, 0.04), open1: 0.08 + rng.range(-0.05, 0.05) });
  }

  // (b) 花苞内芯（k < 0.45 时填满合拢的花瓣内部，防止任何角度看进空洞；开花时平滑缩入花心）
  const budCore = add(crown, new THREE.SphereGeometry(1, 14, 12), M.budCore);
  budCore.scale.set(0.028, 0.042, 0.028);
  budCore.position.y = 0.042;

  // (c) 中央金色花托圆丘 + 20 根修长金黄花蕊
  const globe = new THREE.Group(); globe.position.y = 0.012; crown.add(globe);
  const core = add(globe, new THREE.SphereGeometry(1, 14, 10), M.core);
  core.scale.set(0.024, 0.018, 0.024);
  core.position.y = 0.008;

  const stamens = [];
  const stGeo = stamenGeo(0.048, 0.0018, 0.0048);
  const N_STAM = 20;
  for (let i = 0; i < N_STAM; i++) {
    const inner = i >= 12;
    const az = (inner ? (i - 12) / 8 : i / 12) * Math.PI * 2 + (inner ? 0.22 : 0) + rng.range(-0.07, 0.07);
    const pv = new THREE.Group(); pv.rotation.y = az; globe.add(pv);
    const hinge = new THREE.Group();
    hinge.position.set(inner ? 0.007 : 0.012, 0.008, 0);
    pv.add(hinge);
    add(hinge, stGeo, M.stamenMat);
    stamens.push({
      hinge,
      angClosed: 1.38,
      angOpen: inner ? rng.range(0.95, 1.12) : rng.range(0.68, 0.86),
      delay: inner ? 0.20 : 0.12,
    });
  }

  // (d) 双层共 10 片宽大圆润花瓣（外圈 5 大瓣 + 内圈 5 交错瓣，照 K5 / K1a 的宽瓣大白花造型）
  const mainPetals = [];
  const outerGeo = [0, 1].map(() => bigPetalGeo(0.095, 0.038, 0.22, 0.042, rng));
  const innerGeo = [0, 1].map(() => bigPetalGeo(0.084, 0.034, 0.20, 0.036, rng));
  const rings = [
    { n: 5, ring: 0, rad: 0.010, y: 0.006, ph: 0.0, closedZ: 1.25, openZ: 0.26, twist0: 0.14, geos: outerGeo, lav: 0 },
    { n: 5, ring: 1, rad: 0.008, y: 0.011, ph: Math.PI / 5, closedZ: 1.32, openZ: 0.48, twist0: -0.14, geos: innerGeo, lav: 1 },
  ];
  rings.forEach((rg) => {
    for (let k = 0; k < rg.n; k++) {
      const az = rg.ph + (k / rg.n) * Math.PI * 2 + rng.range(-0.04, 0.04);
      const pv = new THREE.Group(); pv.rotation.y = az; crown.add(pv);
      const hinge = new THREE.Group();
      hinge.position.set(rg.rad, rg.y, 0);
      pv.add(hinge);
      const matIdx = rg.lav * 2 + ((k + rg.ring) % 2);
      add(hinge, rg.geos[k % 2], M.petal[matIdx]);
      mainPetals.push({
        hinge,
        ring: rg.ring,
        closedZ: rg.closedZ + rng.range(-0.025, 0.025),
        openZ: rg.openZ + rng.range(-0.035, 0.035),
        twist0: rg.twist0,
        s0: 0.04 + rg.ring * 0.15 + rng.range(-0.02, 0.02),
        sz0: 0.78,
      });
    }
  });

  const plant = {
    root, meshes, leaves, stemLeaves, stem, sg, NS, NR, stemLen, curve,
    head, crown, nod: o.nod ?? [0.40, -0.14], sepals, budCore, globe, core, stamens, mainPetals,
    H, R, GR, uBrown: M.uBrown,
  };
  setBloom(plant, 0);
  return plant;
}

// ---------------------------------------------------------------- 姿态与盛开动画
const _T = new THREE.Vector3(), _N = new THREE.Vector3(), _B = new THREE.Vector3(), _P = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// tilt(s) → [ax, az]：茎上 s 处的倾斜（弧度，水平分量）。按弯曲重建茎的网格，同步茎生叶与顶端花头
export function poseStem(f, tilt) {
  const { NS, NR, stemLen, sg, stemLeaves } = f;
  const pos = sg.attributes.position.array, nor = sg.attributes.normal.array;
  _P.set(0, 0, 0); _N.set(1, 0, 0);
  const ds = stemLen / NS;
  const pts = [new THREE.Vector3(0, 0, 0)];
  const tans = [new THREE.Vector3(0, 1, 0)];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const [ax, az] = tilt(s);
    const a = Math.hypot(ax, az);
    if (a > 1e-6) _T.set(Math.sin(a) * ax / a, Math.cos(a), Math.sin(a) * az / a); else _T.set(0, 1, 0);
    if (i > 0) {
      _P.addScaledVector(_T, ds);
      pts.push(_P.clone());
      tans.push(_T.clone());
    } else {
      tans[0].copy(_T);
    }
    _N.addScaledVector(_T, -_N.dot(_T)).normalize();
    _B.crossVectors(_T, _N);
    const rad = 0.0046 * (1 - 0.22 * s);
    for (let j = 0; j < NR; j++) {
      const th = (j / NR) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      const k = (i * NR + j) * 3;
      const nx = _N.x * c + _B.x * sn, ny = _N.y * c + _B.y * sn, nz = _N.z * c + _B.z * sn;
      pos[k] = _P.x + nx * rad; pos[k + 1] = _P.y + ny * rad; pos[k + 2] = _P.z + nz * rad;
      nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
    }
  }
  sg.attributes.position.needsUpdate = true;
  sg.attributes.normal.needsUpdate = true;
  sg.computeBoundingSphere();

  // 茎生叶跟随花茎弯曲
  if (stemLeaves) {
    for (const sl of stemLeaves) {
      const fi = sl.s * NS, i0 = Math.min(NS - 1, Math.floor(fi)), u = fi - i0;
      sl.holder.position.lerpVectors(pts[i0], pts[i0 + 1], u);
      const tan = tans[i0].clone().lerp(tans[i0 + 1], u).normalize();
      sl.holder.quaternion.setFromUnitVectors(UP, tan);
    }
  }

  f.head.position.copy(_P);
  f.head.quaternion.setFromUnitVectors(UP, _T);
}

const backOut = (x, s = 1.35) => { x = clamp(x); const y = x - 1; return 1 + (s + 1) * y * y * y + s * y * y; };

// 开花程度 k ∈ [0,1]：
//   k = 0：饱满粉白水滴形大花苞（花萼半抱，10 片大花瓣合拢交叠）
//   k → 1：花萼外翻 → 外圈 5 大瓣与内圈 5 瓣依次弹性舒展成碗状大白花 → 中央黄金花蕊群向外散开
export function setBloom(f, k) {
  k = clamp(k, 0, 1);
  f.uBrown.value = smooth(k);

  // 1. 翠绿花萼外翻
  const ks = smooth(clamp(k / 0.45));
  for (const s of f.sepals) {
    s.hinge.rotation.z = s.open0 + (s.open1 - s.open0) * ks;
  }

  // 2. 花苞内芯随花瓣张开缩入花心
  const kc = smooth(clamp((k - 0.06) / 0.42));
  f.budCore.visible = kc < 0.96;
  const sc = 1 - 0.72 * kc;
  f.budCore.scale.set(0.028 * sc, 0.042 * (1 - 0.65 * kc), 0.028 * sc);
  f.budCore.position.y = 0.042 * (1 - 0.55 * kc);

  // 2b. 盛开时花冠朝镜头方向微倾（地面主花朝 +Z，肩缝花朝 -Z，让两个机位都能直视碗状花心与金色花蕊）
  if (f.crown) {
    const kn = smooth(clamp((k - 0.05) / 0.65));
    f.crown.rotation.set(f.nod[0] * kn, 0, f.nod[1] * kn);
  }

  // 3. 内外两层共 10 片大花瓣舒展绽放（花苞期横向收窄成紧致水滴形，绽放时横向舒展成宽圆大花瓣）
  for (const p of f.mainPetals) {
    const x = clamp((k - p.s0) / 0.62);
    const e = backOut(x, 1.28);
    const es = smooth(x);
    p.hinge.rotation.z = p.closedZ + (p.openZ - p.closedZ) * e;
    p.hinge.rotation.x = p.twist0 * (1 - es);
    const sx = p.sz0 + (1 - p.sz0) * es;
    const sz = 0.56 + 0.44 * es;
    p.hinge.scale.set(sx, 1, sz);
  }

  // 4. 中央暖金花盘与 20 根花蕊随花瓣打开向外绽出
  const kg = smooth(clamp((k - 0.12) / 0.65));
  f.globe.visible = k > 0.08;
  f.core.scale.set(0.024 * (0.6 + 0.4 * kg), 0.018 * (0.6 + 0.4 * kg), 0.024 * (0.6 + 0.4 * kg));
  for (const st of f.stamens) {
    const xs = clamp((k - st.delay) / 0.58);
    const es = backOut(xs, 1.15);
    st.hinge.rotation.z = st.angClosed + (st.angOpen - st.angClosed) * es;
    st.hinge.scale.setScalar(0.55 + 0.45 * smooth(xs));
  }
}
