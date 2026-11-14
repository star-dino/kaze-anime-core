import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rig, cbox, hull, superPts, creased, solve2 } from '../../core/kit.js';
import { paintTexture, letter, seam, bolt } from '../../core/textures.js';
import { screen } from '../../core/color.js';
import { deg, clamp, smooth, invLerp, onTwos, onThrees, noise1, easeHeavy } from '../../core/util.js';
import { setLamp } from '../../core/look.js';
import { SPOT, CUES } from './cues.js';
import { cupAngle, cupOmega, wind, rain, wet } from './weather.js';
import { terrain } from './world.js';

// 角色部门：巨型测风机器人「凪」v4 —— 照用户给的设定图（nagi_v4_concept.png，不随仓库分发）建模（正面 + 侧面）。
// 建模单位 = 设定图上的像素（正面图中心 x = 392，脚底 y = 1040 → 本地 y = 1040 - 图上 y；侧面图身体中心 x = 985 → 本地 z = 985 - 图上 x）。
// 根节点整体缩放 K：1030 px ≈ 20 m。画面语言是 Sunshower / LEVIATHAN 的白装甲 + 深灰骨架、红色条带、手写编号、棱边磨损。
// 局部坐标：+Y 上，+Z 前，+X 是它自己的左边（= 正面图的右边）。
// 四肢骨骼（arm→elbow→hand、thigh→knee→ankle）均严格沿局部 -Y 下垂，兼容 solve2 两骨 IK 与大幅度动作；
// 侧裙甲（skirtL/R）、膝甲（kneePadL/R）、脚踝护甲（ankleGuardL/R）、肩甲（pauldronL/R）均有独立关节并随肢体自动联动让位。
//
// URL 参数（test 模式）：nagiAt=x,y,z、nagiYaw=度、pose=rest|walk|crouch|kneel|sit、expr=rest|open|focus|happy|dim|blink、louver=0..1、sil=1、weather=0

export const K = 20 / 1030;

// ------------------------------------------------------------------ 设定色（屏幕色，对照设定图）
const HEX = {
  white: '#edf1f8', whiteShade: '#9fa8c0',
  dark: '#575760', darkShade: '#383842',
  red: '#c55246', redShade: '#8a3939',
  brass: '#c89a56', brassShade: '#88663e',
  rust: '#8c4c32', primer: '#dfd4c4', primerShade: '#aba095',
  glass: '#2c3842', amber: '#ffb45a', paper: '#f2e8d8', ink: '#2b2930',
};
const P = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, screen(v)]));

// ------------------------------------------------------------------ 花纹
// 白装甲上的红色条带：支持水平条带及侧面后端向下折角（uBandKnee = [zKnee, slope, zMin]）
const BANDS = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  float bend = min(0.0, p.z - uBandKnee.x) * uBandKnee.y;
  float t = dot(p, uBandAx) - bend;
  float b = step(abs(t - uBands.x), uBands.y) + step(abs(t - uBands.z), uBands.w);
  b = clamp(b, 0.0, 1.0) * step(uBandSide, dot(n, uBandN)) * step(uBandKnee.z, p.z);
  gShade = b > 0.5 ? cRedShade : cBaseShade;
  return vec4(mix(cBase, cRed, b), 0.0);
}`;
// 镜头眼：琥珀色光球 + 黄铜环里的光圈表情（uExpr）+ 暴雨流水痕 + 雨后金色水珠
const LENS = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  vec3 c = cGlass;
  if(n.z < 0.4) return vec4(c, 0.0);
  vec2 q = p.xy / uLensR;
  float r = length(q), e = uExpr;
  float iris = 0.0, hi = 0.0;
  if(e < 0.5){ iris = step(r, 0.62) * step(q.y, 0.12); hi = step(length(q - vec2(-0.24, 0.24)), 0.13); }
  else if(e < 1.5){ iris = step(r, 0.7); hi = step(length(q - vec2(-0.26, 0.28)), 0.16); }
  else if(e < 2.5){ iris = step(r, 0.28); }
  else if(e < 3.5){ vec2 a = q - vec2(0.0, -0.3); iris = step(abs(length(a) - 0.46), 0.12) * step(-0.02, a.y); }
  else if(e < 4.5){ iris = step(r, 0.55) * 0.2; }
  else { iris = step(abs(q.y), 0.08) * step(abs(q.x), 0.6); }
  float k = clamp(iris, 0.0, 1.0);
  vec3 glow = mix(cAmber * 0.75, cAmber * (1.0 + 0.5 * uGlow), smoothstep(0.7, 0.1, r));
  c = mix(c, glow, k * uGlow + k * (1.0 - uGlow) * 0.15);
  c = mix(c, vec3(1.5), clamp(hi, 0.0, 1.0));
  float un = step(0.01, iris) + hi;
  // 暴雨时流过玻璃的水道（s17_close）
  if(uLensRain > 0.02 && r < 0.96){
    float tq = uLensT * 2.4;
    float riv = 0.0, rEdge = 0.0;
    for(int i = 0; i < 5; i++){
      float fi = float(i);
      float cx = -0.62 + fi * 0.31 + 0.06 * sin(q.y * 5.5 + fi * 2.1 + floor(tq) * 0.35);
      float w = 0.028 + 0.012 * sin(q.y * 11.0 - tq * (2.6 + fi * 0.3) + fi * 4.0);
      float d = abs(q.x - cx);
      float seg = step(0.18, fract(q.y * 0.55 - tq * (0.45 + 0.08 * fi) + fi * 0.37));
      riv = max(riv, step(d, w) * seg);
      rEdge = max(rEdge, step(w * 0.55, d) * step(d, w * 1.15) * seg);
    }
    vec3 wCol = mix(vec3(0.52, 0.60, 0.72), cAmber * 0.85, k * uGlow * 0.55);
    c = mix(c, c * 0.82 + wCol * 0.22, riv * uLensRain * 0.75);
    c = mix(c, vec3(0.86, 0.92, 1.02), rEdge * uLensRain * 0.68);
    un = max(un, (riv * 0.35 + rEdge * 0.85) * uLensRain);
  }
  // 雨停后挂在镜头上的金色水珠（s18_open）
  float beadOn = uLensWet * (1.0 - clamp(uLensRain * 4.0, 0.0, 1.0));
  if(beadOn > 0.02 && r < 0.95){
    const vec3 B[7] = vec3[7](
      vec3(-0.46,  0.30, 0.085), vec3( 0.48,  0.20, 0.072), vec3(-0.28, -0.44, 0.078),
      vec3( 0.35, -0.36, 0.062), vec3( 0.08,  0.55, 0.052), vec3(-0.60, -0.10, 0.056), vec3( 0.60, -0.12, 0.046)
    );
    for(int i = 0; i < 7; i++){
      vec2 dv = (q - B[i].xy) / B[i].z;
      dv.y *= 0.86;
      float dr = length(dv);
      if(dr < 1.0){
        float rimD = step(0.78, dr) * step(dv.y, 0.15);
        float warm = smoothstep(0.85, -0.55, dv.y) * 0.75;
        float gl = step(length(dv - vec2(-0.28, 0.34)), 0.27) + step(length(dv - vec2(0.22, -0.42)), 0.15) * 0.6;
        vec3 bc = mix(c * 0.72, vec3(1.06, 0.82, 0.44), warm * beadOn);
        bc = mix(bc, c * 0.45, rimD * 0.7);
        bc = mix(bc, vec3(1.42, 1.26, 0.90), clamp(gl, 0.0, 1.0) * beadOn);
        c = mix(c, bc, beadOn * 0.92);
        un = max(un, beadOn * 0.9);
      }
    }
  }
  return vec4(c, clamp(un, 0.0, 1.0));
}`;
// 胸口舷窗里的记录鼓：纸面 + 格线 + 墨线（uRec：0 平线 → 1 锯齿），鼓面随 uRoll 转
const DRUM = /* glsl */ `
vec4 pattern(vec3 p, vec3 n){
  float ang = atan(p.z, p.x);
  float a = ang + uRoll;
  float x = a * 3.0, y = p.y / uH;
  float wave = 0.04 * sin(x * 3.5) + 0.025 * cos(x * 9.0) + 0.015 * sin(x * 19.0);
  float gale = 0.30 * (abs(fract(x * 1.65) - 0.5) * 2.0 - 0.5) + 0.11 * sin(x * 13.0) + 0.06 * cos(x * 27.0);
  // 鼓面正面偏右（记录笔刚画过的一侧）率先变剧烈锯齿，左侧保留稍早前的较平笔迹
  float recent = clamp(uRec * (1.25 - 0.55 * clamp((1.57 - ang) * 0.7, 0.0, 1.0)), 0.0, 1.0);
  float trace = mix(wave, gale, recent);
  float line = step(abs(y - trace), 0.032);
  float grid = max(step(abs(fract(x * 2.0) - 0.5), 0.028), step(abs(fract(y * 7.0) - 0.5), 0.032)) * 0.45;
  float band = step(0.42, abs(y)) * 0.15;
  vec3 c = mix(cPaper, cPaper * vec3(0.84, 0.78, 0.72), max(grid, band));
  c = mix(c, cInk, line);
  gShade = c * 0.82;
  return vec4(c, line * 0.8);
}`;

// ------------------------------------------------------------------ 几何（折角阈值 ~12°，并写入 aEdge 供棱边磨损）
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const rblob = (rx, ry, rz, e = 3.2, n = 14, fn) => hull(superPts(rx, ry, rz, e, n, fn), 44, false);
const abox = (w, h, d, c = 8, o = {}) => cbox(w, h, d, c, { crease: 12, edge: true, ...o });
function drum(r0, r1, h, bevel = 3, seg = 40) {
  const pts = [], b = Math.min(bevel, h / 3, Math.min(r0, r1) / 2);
  pts.push(new THREE.Vector2(0, -h / 2));
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; pts.push(new THREE.Vector2(r0 - b + Math.sin(a) * b, -h / 2 + b - Math.cos(a) * b)); }
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; pts.push(new THREE.Vector2(r1 - b + Math.cos(a) * b, h / 2 - b + Math.sin(a) * b)); }
  pts.push(new THREE.Vector2(0, h / 2));
  return creased(new THREE.LatheGeometry(pts, seg), deg(40), false);
}
const drumX = (...a) => drum(...a).rotateZ(Math.PI / 2);
const drumZ = (...a) => drum(...a).rotateX(Math.PI / 2);
function plate(pts, c = 4, cr = 12) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length, cz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
  const out = [];
  for (const [x, y, z] of pts) {
    const d = V3(x - cx, y - cy, z - cz), L = d.length();
    out.push(V3(x, y, z).addScaledVector(d, -c / Math.max(L, 1e-3)));
    out.push(V3(x - Math.sign(x - cx) * c, y, z), V3(x, y - Math.sign(y - cy) * c, z), V3(x, y, z - Math.sign(z - cz) * c));
  }
  return hull(out, cr, true);
}
function prism(secs, c = 7, cr = 12) {
  const pts = [];
  const cut = (poly, y, inset) => {
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length, cz = poly.reduce((a, q) => a + q[1], 0) / poly.length;
    poly.forEach((v, i) => {
      for (const n of [poly[(i + 1) % poly.length], poly[(i + poly.length - 1) % poly.length]]) {
        const dx = n[0] - v[0], dz = n[1] - v[1], L = Math.hypot(dx, dz) || 1;
        let x = v[0] + dx / L * c, z = v[1] + dz / L * c;
        if (inset) { const ex = cx - x, ez = cz - z, E = Math.hypot(ex, ez) || 1; x += ex / E * c; z += ez / E * c; }
        pts.push(V3(x, y, z));
      }
    });
  };
  secs.forEach(([y, poly], i) => {
    if (i === 0) { cut(poly, y, true); cut(poly, y + c, false); }
    else if (i === secs.length - 1) { cut(poly, y - c, false); cut(poly, y, true); }
    else cut(poly, y, false);
  });
  return hull(pts, cr, true);
}
const cupGeo = (r) => new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2);

// ------------------------------------------------------------------ 材质（开启 shadeVolume + sunTint + 棱边磨损）
function makeMats(Q) {
  const sil = Q?.get('sil') === '1', noW = Q?.get('weather') === '0';
  const cache = new Map();
  const U = {
    uExpr: { value: 0 }, uGlow: { value: 1 }, uRec: { value: 0 }, uRoll: { value: 0 },
    uWet: { value: 0 }, uRain: { value: 0 }, uLensT: { value: 0 },
  };
  const W = (seed, k = 1) => noW ? {} : {
    weather: { chip: 0.22 * k, rust: 0.16 * k, stain: 0, patch: 0, scale: 0.015, seed, edge: true },
    primer: HEX.primer, primerShade: HEX.primerShade, rust: HEX.rust, metal: HEX.rust,
  };
  const S = (c, sunTint = 0.22) => ({ color: P[c], shadeBase: HEX[c], shade: HEX[c + 'Shade'], shadeVolume: true, sunTint });
  const wetOpt = noW ? {} : { wet: U.uWet, wetRain: U.uRain, wetScale: 0.016 };
  const base = { ink: HEX.ink, wear: 0, gloss: 0.38, receiveShadow: true };
  const kinds = {
    white: (o) => ({ ...S('white', 0.22), ...W(o.seed ?? o.id), ...wetOpt, ...(o.shadeProxy ? { shadeProxy: o.shadeProxy, receiveShadow: false } : {}) }),
    band: (o) => ({ ...S('white', 0.22), ...W(o.seed ?? o.id), ...wetOpt, pattern: BANDS,
      colors: { cBase: P.white, cBaseShade: P.whiteShade, cRed: P.red, cRedShade: P.redShade },
      uniforms: {
        uBandAx: new THREE.Vector3(...(o.ax ?? [0, 1, 0])),
        uBands: new THREE.Vector4(...(o.bands ?? [0, 10, 9999, 0])),
        uBandN: new THREE.Vector3(...(o.bn ?? [0, 0, 1])),
        uBandSide: o.bside ?? -2,
        uBandKnee: new THREE.Vector3(...(o.knee ?? [9999, 0, -9999])),
      } }),
    dark: (o) => ({ ...S('dark', 0.3), ...W(o.seed ?? o.id, 0.2), ...wetOpt, gloss: 0.28 }),
    red: (o) => ({ ...S('red', 0.3), ...W(o.seed ?? o.id, 0.4), ...wetOpt, gloss: 0.35 }),
    brass: () => ({ ...S('brass', 0.35), ...wetOpt, gloss: 1.0 }),
    glass: () => ({ color: P.glass, shadeBase: HEX.glass, shade: '#1e262e', shadeVolume: true, sunTint: 0.25, gloss: 1.4 }),
    lens: (o) => ({ color: P.glass, shadeBase: HEX.glass, shade: '#1e262e', shadeVolume: true, sunTint: 0.25, gloss: 1.2, pattern: LENS,
      colors: { cGlass: P.glass, cAmber: P.amber },
      uniforms: { uExpr: U.uExpr, uGlow: U.uGlow, uLensR: o.r, uLensWet: U.uWet, uLensRain: U.uRain, uLensT: U.uLensT } }),
    drum: (o) => ({ color: P.paper, shadeBase: HEX.paper, shade: '#c8b9a8', shadeVolume: true, sunTint: 0.25, gloss: 0.1, pattern: DRUM,
      colors: { cPaper: P.paper, cInk: P.ink }, uniforms: { uH: o.h, uRec: U.uRec, uRoll: U.uRoll } }),
  };
  return {
    U,
    mat(o) {
      const key = JSON.stringify(o);
      if (cache.has(key)) return cache.get(key);
      const m = sil ? celMaterial({ id: o.id, color: '#000000', emissive: '#0a0708', emis: 1, wear: 0, gloss: 0 })
        : celMaterial({ ...base, id: o.id, ...(kinds[o.k] ?? kinds.white)(o), ...(o.det ? { det: o.det } : {}) });
      cache.set(key, m);
      return m;
    },
  };
}

// ------------------------------------------------------------------ 造型（px 单位；四肢骨骼沿局部 -Y 轴正交化，消除运动偏摆）
function build(M) {
  const rig = new Rig((o) => M.mat(o), 1, 75);
  const part = (geo, o, parent, pos, rot, sc) => rig.part(geo, o, parent, pos, rot, sc);
  const J = (n, p, pos) => rig.joint(n, p, pos);
  const ink = P.ink;
  const panel = (seed, inner) => paintTexture(512, 512, (g) => {
    if (inner === 0) seam(g, () => { g.moveTo(76, 136); g.lineTo(356, 136); g.lineTo(396, 96); }, 3.5, { ink });
    if (inner === 1) seam(g, () => { g.moveTo(72, 196); g.lineTo(440, 196); }, 3.5, { ink });
    if (inner === 2) seam(g, () => { g.moveTo(256, 56); g.lineTo(256, 456); g.moveTo(76, 326); g.lineTo(256, 326); }, 3.5, { ink });
    if (inner === 3) {
      seam(g, () => {
        g.moveTo(84, 146); g.lineTo(428, 146);
        g.moveTo(70, 392); g.lineTo(442, 392);
        g.roundRect(310, 196, 82, 114, 6);
      }, 3.5, { ink });
      bolt(g, 368, 434, 9, { lit: P.white, dark: P.whiteShade, mid: P.white, ink });
    }
    for (const [x, y] of [[96, 92], [416, 92], [82, 424], [430, 424]]) bolt(g, x, y, 5, { lit: P.white, dark: P.whiteShade, mid: P.white, ink });
  }, { seed, rough: 0.9, erode: 0.04 });
  const PAN = [panel(31, 0), panel(32, 1), panel(33, 2), panel(34, 3)];
  const dF = (t, w, h, cx = 0, cy = 0) => ({ tex: PAN[t], axis: 2, sign: 1, rect: [cx, cy, w, h] });
  const dS = (t, s, w, h, cz = 0, cy = 0) => ({ tex: PAN[t], axis: 0, sign: s, rect: [cz * -s, cy, w, h] });
  const num = paintTexture(256, 256, (g, rng) => letter(g, '07', 22, 40, 170, rng, { color: P.red, width: 30, slant: 0.04, squash: 0.9 }), { seed: 7, rough: 1.2 });
  const glassTex = paintTexture(256, 256, (g) => {
    g.save();
    g.beginPath(); g.arc(128, 128, 114, 0, Math.PI * 2); g.clip();
    g.fillStyle = 'rgba(246,252,255,1)';
    g.save();
    g.translate(164, 62); g.rotate(0.48);
    g.beginPath(); g.ellipse(0, 0, 18, 11, 0, 0, Math.PI * 2); g.fill();
    g.restore();
    g.beginPath(); g.arc(190, 84, 6.5, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(128, 128, 110, -Math.PI * 0.88, -Math.PI * 0.48);
    g.arc(128, 128, 102, -Math.PI * 0.48, -Math.PI * 0.88, true); g.closePath(); g.fill();
    g.restore();
  }, { seed: 19, rough: 0.25, erode: 0.0 });

  // 躯干主关节（绝对位置，px）
  J('hips', rig.root, [0, 640, 0]);
  J('waist', 'hips', [0, 60, 0]);              // y 700
  J('chest', 'waist', [0, 70, 0]);             // y 770

  // ---- 腰、骨盆（深灰机械骨架 + 两侧肋部斜块 + 裆部横向连往大腿的髋轴）
  part(drum(112, 126, 92, 8), { k: 'dark', seed: 1 }, 'waist', [0, 0, -10]);
  part(abox(210, 64, 152, 10), { k: 'dark', seed: 2 }, 'hips', [0, 0, -10]);
  for (const y of [-22, 6, 34]) part(new THREE.TorusGeometry(118, 6.5, 8, 40).rotateX(Math.PI / 2), { k: 'dark', seed: 3 }, 'waist', [0, y, -10]);
  for (const s of [1, -1]) {
    // 胸甲 V 字下方的深灰斜肋甲（切片 1/2 中胸腰交界两侧分明的深灰块）
    part(plate([
      [s * 62, 62, 92], [s * 154, 72, 68], [s * 62, 62, -38], [s * 154, 72, -38],
      [s * 54, 6, 80], [s * 126, 12, 58], [s * 54, 6, -38], [s * 126, 12, -38],
    ], 5), { k: 'dark', seed: 4 + s }, 'waist', [0, 0, 0]);
    // 裆部两侧横向连往大腿根部的深灰髋轴鼓（切片 2“裆部从两侧连接腿部”）
    part(drumX(46, 48, 84, 5), { k: 'dark', seed: 6 + s }, 'hips', [s * 64, -74, 12]);
  }
  part(abox(64, 52, 116, 8), { k: 'dark', seed: 8 }, 'hips', [0, -128, 6]);                             // 裆底深灰托座

  // ---- 中央裆甲：上段倒梯形顶块 + 左右胯桥 + 下段立体折面窄盾（正前方大腿通道完全敞开，侧面明显前凸）
  part(plate([
    [-64, 18, 118], [64, 18, 118], [-64, 18, 64], [64, 18, 64],
    [-76, -8, 124], [76, -8, 124], [-76, -8, 62], [76, -8, 62],
    [-48, -32, 128], [48, -32, 128], [-48, -32, 72], [48, -32, 72],
  ], 5), { k: 'white', seed: 9 }, 'hips', [0, 0, 0]);
  for (const s of [1, -1]) {
    part(abox(15, 7, 12, 2), { k: 'dark', seed: 10 }, 'hips', [s * 30, 3, 120]);
    // 裆部顶块向左右延伸搭接侧裙甲的顶部横桥甲
    part(plate([
      [s * 62, 14, 112], [s * 104, 10, 96], [s * 62, 14, 58], [s * 104, 10, 48],
      [s * 68, -18, 116], [s * 112, -16, 98], [s * 68, -18, 62], [s * 112, -16, 50],
    ], 4), { k: 'white', seed: 12 + s }, 'hips', [0, 0, 0]);
  }
  // 下段立体六面折棱裆盾（中间高棱 z=130，向下收窄到 z=98，侧面突出于腰腹前方）
  const crotchSecs = [
    [-152, [[-18, 96], [0, 104], [18, 96], [16, 58], [-16, 58]]],
    [-116, [[-34, 114], [0, 124], [34, 114], [28, 64], [-28, 64]]],
    [-28,  [[-48, 118], [0, 130], [48, 118], [40, 68], [-40, 68]]],
  ];
  part(prism(crotchSecs, 5, 12), { k: 'white', seed: 11, det: [dF(0, 66, 106, 0, -90)] }, 'hips', [0, 0, 0]);

  // ---- 侧裙甲：挂在独立合页关节 skirtL/R [s*108, 4, 32] 上，一体折面环抱大腿外前侧（内沿斜向外撇露出深灰大腿）
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    J('skirt' + L, 'hips', [s * 108, 4, 32]);
    // 上段腰带折块
    part(plate([
      [s * -18, 12, 74], [s * 36, 4, 36], [s * 48, 2, -96], [s * -18, 12, 24],
      [s * -10, -20, 80], [s * 46, -22, 40], [s * 56, -22, -96], [s * -10, -20, 28],
    ], 4), { k: 'white', seed: 13 + s }, 'skirt' + L, [0, 0, 0]);
    // 一体折面主侧裙甲（前斜折面 + 外侧翼面同属一个凸包，无竖向碎缝，正面呈倒 V 外撇梯形）
    part(plate([
      [s * -8, -18, 82],  [s * 44, -18, 42],  [s * 58, -18, -102], [s * -8, -18, 42],
      [s * 26, -148, 64], [s * 74, -136, 22], [s * 78, -128, -96], [s * 26, -148, 24],
    ], 5.5), {
      k: 'white', seed: 14 + s,
      det: [dF(0, 56, 114, s * 32, -82), dS(1, s, 120, 110, -32, -74)],
    }, 'skirt' + L, [0, 0, 0]);
    part(abox(16, 108, 116, 4), { k: 'dark', seed: 18 }, 'skirt' + L, [s * 42, -72, -38]);
  }

  // ---- 胸甲：1) 中央八角舷窗座甲 2) 左右上胸斜甲 3) 左右下胸红带斜甲（下沿内收露出肋部）4) 左右肩锁凸台
  const cMid = [
    [-90, 156, 134], [90, 156, 134], [-104, 112, 162], [104, 112, 162],
    [-104, -12, 162], [104, -12, 162], [-62, -62, 144], [62, -62, 144],
    [-84, 156, -54], [84, 156, -54], [-96, 96, -62], [96, 96, -62],
    [-86, -16, -54], [86, -16, -54], [-54, -62, -44], [54, -62, -44],
  ];
  part(plate(cMid, 10), { k: 'white', seed: 16, det: [dF(1, 160, 180, 0, 50)] }, 'chest', [0, 0, 0]);
  for (const s of [1, -1]) {
    part(plate([
      [s * 66, 178, 88], [s * 132, 174, 76], [s * 66, 178, -32], [s * 132, 174, -32],
      [s * 62, 148, 122], [s * 144, 148, 104], [s * 62, 148, -46], [s * 144, 148, -46],
    ], 5), { k: 'white', seed: 17 + s }, 'chest', [0, 0, 0]);
    const upPec = [
      [s * 90, 152, 138], [s * 168, 144, 92], [s * 90, 152, -56], [s * 168, 144, -56],
      [s * 100, 44, 156], [s * 182, 42, 102], [s * 100, 44, -62], [s * 182, 42, -62],
    ];
    const pecDet = s > 0 ? [
      { tex: num, axis: 2, sign: 1, rect: [130, 96, 58, 58] },
    ] : [dF(0, 74, 86, s * 136, 96)];
    part(plate(upPec, 7), { k: 'white', seed: 19 + s, det: pecDet }, 'chest', [0, 0, 0]);
    if (s < 0) part(abox(22, 10, 6, 1.5), { k: 'dark', seed: 21 }, 'chest', [s * 134, 122, 118], [0, s * 28, 0]);
    const loPec = [
      [s * 98, 44, 152], [s * 178, 42, 98], [s * 98, 44, -58], [s * 178, 42, -58],
      [s * 60, -56, 136], [s * 134, -36, 82], [s * 60, -56, -44], [s * 134, -36, -44],
    ];
    part(plate(loPec, 7), {
      k: 'band', ax: [-s * 0.32, 0.95, 0], bands: [2, 16, 9999, 0], bn: [s * 0.45, 0, 0.89], bside: -0.2,
      seed: 22 + s, det: [dF(0, 72, 80, s * 120, -2)],
    }, 'chest', [0, 0, 0]);
  }
  part(abox(128, 34, 146, 7), { k: 'dark', seed: 24 }, 'chest', [0, 158, 14]);
  part(abox(264, 186, 108, 12), { k: 'white', seed: 25, det: [dS(2, 1, 96, 160, 112, 70), dS(2, -1, 96, 160, 112, 70)] }, 'chest', [0, 72, -112]);
  part(abox(190, 48, 42, 6), { k: 'dark', seed: 26 }, 'chest', [0, 12, -156]);

  // ---- 舷窗：白护圈 + 黄铜框 + 记录鼓 + 导杆/记录笔 + 弧面玻璃反光（id: 150）
  J('port', 'chest', [0, 38, 162]);
  part(drumZ(84, 88, 16, 4), { k: 'white', seed: 27 }, 'port', [0, 0, -4]);
  part(new THREE.TorusGeometry(74, 7.5, 14, 56), { k: 'brass' }, 'port', [0, 0, 4]);
  part(drumZ(76, 78, 12, 3), { k: 'dark', seed: 28 }, 'port', [0, 0, -10]);
  part(new THREE.CylinderGeometry(45, 45, 72, 40), { k: 'drum', h: 72 }, 'port', [0, 2, -2]);
  for (const sx of [-48, 0, 48]) part(new THREE.CylinderGeometry(3.2, 3.2, 118, 10), { k: 'brass' }, 'port', [sx, 0, sx === 0 ? 44 : 8]);
  part(new THREE.CylinderGeometry(2.4, 2.4, 96, 8).rotateZ(Math.PI / 2), { k: 'dark' }, 'port', [0, 14, 44]);
  rig.penNib = part(abox(10, 16, 10, 2), { k: 'brass' }, 'port', [0, 6, 45]);
  const dome = new THREE.PlaneGeometry(132, 132, 16, 16);
  const dp = dome.attributes.position;
  for (let i = 0; i < dp.count; i++) {
    const x = dp.getX(i) / 66, y = dp.getY(i) / 66, r2 = Math.min(1, x * x + y * y);
    dp.setZ(i, 16 + 22 * (1 - r2));
  }
  dome.computeVertexNormals();
  const glass = new THREE.Mesh(dome, celMaterial({
    id: 150, color: '#f4fbff', pattern: 'vec4 pattern(vec3 p, vec3 n){ return vec4(uColor, 0.92); }',
    map: glassTex, mapCut: true, wear: 0, gloss: 0, receiveShadow: false,
  }));
  rig.j.port.add(glass);
  rig.anchor('chest', 'port', [0, 0, 42]);

  // ---- 头：圆顶（shadeProxy）+ 薄型上翘耳翼 + 琥珀镜头眼 + 三杯风速计
  // 抬高并前移颈部基座（[0, 184, 56]），保持低头看花或仰拍时镜头眼视线通透
  J('neck', 'chest', [0, 184, 56]);
  part(drum(34, 42, 44, 4), { k: 'dark', seed: 29 }, 'neck', [0, -10, -4]);
  J('head', 'neck', [0, 12, 0]);
  rig.j.head.scale.setScalar(1.18);
  part(rblob(48, 38, 50, 2.6), { k: 'white', seed: 30, shadeProxy: { center: [0, 34, 0], r: [54, 44, 56], k: 0.72 } }, 'head', [0, 34, 0]);
  part(rblob(32, 14, 34, 3), { k: 'dark', seed: 31 }, 'head', [0, 6, -4]);
  for (const s of [1, -1]) {
    part(abox(12, 16, 18, 2), { k: 'dark', seed: 32 }, 'head', [s * 42, 30, -2]);
    part(plate([
      [s * 36, 44, 11], [s * 74, 64, 6], [s * 36, 22, 11], [s * 68, 38, 5],
      [s * 36, 44, -9], [s * 72, 62, -11], [s * 36, 22, -9], [s * 66, 36, -11],
    ], 2.2), { k: 'white', seed: 33 + s }, 'head', [0, 0, 0]);
    part(drumZ(4.5, 5, 6, 1, 12), { k: 'dark', seed: 35 }, 'head', [s * 34, 26, 38]);
  }
  J('lens', 'head', [0, 30, 40]);
  part(drumZ(27, 29, 16, 3), { k: 'brass' }, 'lens', [0, 0, 2]);
  part(drumZ(21, 21, 6, 1.5), { k: 'lens', r: 21 }, 'lens', [0, 0, 9]);
  rig.anchor('lens', 'lens', [0, 0, 14]);
  rig.anchor('head', 'head', [0, 32, 0]);
  J('mast', 'head', [0, 64, -4]);
  part(drum(10, 14, 10, 2, 20), { k: 'brass' }, 'mast', [0, 2, 0]);
  part(drum(6, 8, 10, 1.5, 16), { k: 'brass' }, 'mast', [0, 10, 0]);
  part(drum(4, 5, 18, 1, 12), { k: 'brass' }, 'mast', [0, 20, 0]);
  J('cups', 'mast', [0, 28, 0]);
  part(drum(7.5, 7.5, 9, 2, 14), { k: 'brass' }, 'cups');
  rig.cupArms = [];
  for (let i = 0; i < 3; i++) {
    const j = J('cupArm' + i, 'cups', [0, 0, 0]);
    j.rotation.y = (i * Math.PI * 2) / 3 + 0.3;
    part(new THREE.CylinderGeometry(1.8, 1.8, 44, 8).rotateZ(Math.PI / 2), { k: 'brass' }, j, [22, 0, 0]);
    part(cupGeo(13.5), { k: 'brass' }, j, [48, 0, 4]);
    rig.cupArms.push(j);
  }
  // 三只真实黄铜风杯预积分高速飞转 + fx.js 空气风丝
  rig.anchor('cups', 'cups', [0, 0, 0]);

  // ---- 肩甲 + 正交化手臂链（arm → elbow [0,-168,0] → hand [0,-212,0]，完全兼容 solve2 与单轴屈伸）
  rig.louvers = { L: [], R: [] };
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    J('shoulder' + L, 'chest', [s * 185, 95, -40]);
    part(drumX(40, 40, 74, 6), { k: 'dark', seed: 36 }, 'shoulder' + L, [s * 10, 0, 0]);
    J('pauldron' + L, 'shoulder' + L, [s * 55, -25, 0]);
    part(abox(208, 180, 168, 18, { wt: 176, dt: 152 }), {
      k: 'band', ax: [0, 1, 0], bands: [-58, 14, 9999, 0], seed: 38 + s,
      det: [dF(1, 150, 146, 0, 0), dS(1, s, 130, 146, 0, 0)],
    }, 'pauldron' + L, [0, 0, 0]);
    for (const side of [-1, 1]) {
      part(plate([
        [side * 64, 72, 78], [side * 76, 72, 78], [side * 64, 72, 62], [side * 76, 72, 62],
        [side * 74, -26, 85], [side * 88, -26, 85], [side * 74, -26, 66], [side * 88, -26, 66],
      ], 2.5), { k: 'white', seed: 41 + side + s * 3 }, 'pauldron' + L, [0, 0, 0]);
    }
    part(abox(108, 36, 124, 9, { wt: 96, dt: 112 }), { k: 'white', seed: 44 + s }, 'pauldron' + L, [-s * 34, 102, -8]);
    part(drum(16, 18, 12, 3, 18), { k: 'brass' }, 'pauldron' + L, [s * 46, 92, 0]);
    part(abox(152, 102, 10, 3, { wt: 132 }), { k: 'dark', seed: 46 }, 'pauldron' + L, [0, 24, 73]);
    for (let i = 0; i < 6; i++) {
      const jl = J('pLouver' + L + i, 'pauldron' + L, [0, 65 - i * 16, 80]);
      part(abox(132 + i * 3.5, 13.5, 8, 1.5), { k: 'white', seed: 48 + i + s * 7 }, jl);
      rig.louvers[L].push(jl);
    }
    part(abox(10, 102, 124, 3, { dt: 110 }), { k: 'dark', seed: 55 }, 'pauldron' + L, [s * 92, 24, -6]);
    for (let i = 0; i < 6; i++) {
      const jl = J('pLouverS' + L + i, 'pauldron' + L, [s * 97, 65 - i * 16, -6]);
      part(abox(8, 13.5, 108 + i * 2.5, 1.5), { k: 'white', seed: 62 + i + s * 7 }, jl);
      rig.louvers[L].push(jl);
    }

    // 上臂：沿 -Y 垂直下垂，在 restPose 中用 rotation.z 外展
    J('arm' + L, 'shoulder' + L, [s * 54, -42, 4]);
    part(abox(80, 152, 86, 12, { wt: 86, dt: 90 }), { k: 'dark', seed: 70 + s }, 'arm' + L, [0, -82, 0]);
    J('elbow' + L, 'arm' + L, [0, -168, 0]);
    part(drumX(36, 36, 104, 6), { k: 'dark', seed: 72 }, 'elbow' + L, [0, 0, 0]);
    for (const e of [1, -1]) part(drumX(24, 26, 12, 2.5), { k: 'dark', seed: 73 }, 'elbow' + L, [e * 54, 0, 0]);

    // 前臂：外/内两片桶形护臂 + 贴合外侧肘轴的护耳（修复切片 3 侧面护耳前飘问题）
    const faOuter = [
      [-108, [[-2, 78], [s * 54, 76], [s * 76, 44], [s * 76, -46], [s * 50, -76], [-2, -76]]],
      [-65,  [[-2, 92], [s * 64, 90], [s * 88, 52], [s * 88, -54], [s * 58, -88], [-2, -88]]],
      [40,   [[-2, 86], [s * 58, 84], [s * 80, 46], [s * 80, -48], [s * 52, -80], [-2, -80]]],
      [94,   [[-2, 72], [s * 48, 70], [s * 66, 38], [s * 66, -40], [s * 42, -68], [-2, -68]]],
    ].map(([y, p]) => [y, s > 0 ? p.slice().reverse() : p]);
    const faInner = [
      [-108, [[2, 76], [-s * 46, 74], [-s * 66, 42], [-s * 66, -44], [-s * 44, -74], [2, -74]]],
      [-65,  [[2, 88], [-s * 52, 86], [-s * 74, 48], [-s * 74, -50], [-s * 48, -84], [2, -84]]],
      [40,   [[2, 82], [-s * 48, 80], [-s * 68, 42], [-s * 68, -44], [-s * 44, -78], [2, -78]]],
      [94,   [[2, 68], [-s * 38, 66], [-s * 56, 34], [-s * 56, -38], [-s * 36, -64], [2, -64]]],
    ].map(([y, p]) => [y, s < 0 ? p.slice().reverse() : p]);
    part(prism(faOuter, 7), {
      k: 'band', ax: [0, 1, 0], bands: [-52, 16, 9999, 0], seed: 74 + s,
      det: [dS(1, s, 136, 172, 0, -6)],
    }, 'elbow' + L, [0, -104, 0]);
    part(prism(faInner, 7), {
      k: 'band', ax: [0, 1, 0], bands: [-52, 16, 9999, 0], seed: 76 + s,
    }, 'elbow' + L, [0, -104, 0]);
    // 肘部外侧护耳（准确包覆在 x = s*52..76, z = -38..36 的外侧肘关节面上）
    part(plate([
      [s * 48, 22, 34], [s * 70, 18, 28], [s * 48, 22, -34], [s * 70, 18, -28],
      [s * 52, -22, 48], [s * 78, -22, 40], [s * 52, -22, -48], [s * 78, -22, -40],
    ], 3.5), { k: 'white', seed: 78 + s }, 'elbow' + L, [0, 0, 0]);
    part(abox(8, 36, 24, 2), { k: 'dark', seed: 79 }, 'elbow' + L, [s * 82, -64, -22]);
    part(drum(52, 58, 22, 4), { k: 'dark', seed: 80 }, 'elbow' + L, [0, -208, 0]);

    // 手部：挂在 [0, -212, 0]，白色手背盖板贴合外侧，四指与拇指收拢成自然半握拳
    J('hand' + L, 'elbow' + L, [0, -212, 0]);
    part(abox(64, 62, 92, 8), { k: 'dark', seed: 81 }, 'hand' + L, [0, -26, 0]);
    part(plate([
      [s * 22, 4, 44], [s * 46, 2, 40], [s * 22, 4, -42], [s * 46, 2, -38],
      [s * 20, -54, 42], [s * 44, -52, 38], [s * 20, -54, -40], [s * 44, -52, -36],
    ], 4), { k: 'white', seed: 82 + s }, 'hand' + L, [0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      const fz = 32 - i * 21.5;
      const f1 = J('finger' + L + i, 'hand' + L, [s * 24, -52, fz]);
      f1.rotation.z = deg(-s * 18);
      part(abox(20, 30, 19, 4), { k: 'dark', seed: 84 + i }, f1, [0, -13, 0]);
      const f2 = J('fingerB' + L + i, f1, [0, -26, 0]);
      f2.rotation.z = deg(-s * 44);
      part(abox(19, 26, 18, 3.5), { k: 'dark', seed: 88 + i }, f2, [0, -11, 0]);
      const f3 = J('fingerC' + L + i, f2, [0, -22, 0]);
      f3.rotation.z = deg(-s * 48);
      part(abox(17, 22, 16, 3.5), { k: 'dark', seed: 92 + i }, f3, [0, -9, 0]);
    }
    const th1 = J('thumb' + L, 'hand' + L, [-s * 18, -24, 44]);
    th1.rotation.set(deg(22), deg(s * 20), deg(s * 26));
    part(abox(22, 32, 22, 4), { k: 'dark', seed: 96 }, th1, [0, -13, 0]);
    const th2 = J('thumbB' + L, th1, [0, -26, 0]);
    th2.rotation.z = deg(s * 38);
    part(abox(19, 26, 19, 3.5), { k: 'dark', seed: 97 }, th2, [0, -11, 0]);
    rig.anchor('hand' + L, 'hand' + L, [0, -76, 0]);
  }
  rig.anchor('shoulderL', 'pauldronL', [0, 110, 0]);
  // 护花锚点：宽大右前臂与手掌掌心朝下悬停在花正上方成屋檐，eaveR0 → eaveR1 沿前臂与手掌外侧下缘连成 ~2.6 m 排水檐线
  rig.anchor('shoulderR', 'pauldronR', [0, 110, 0]);
  rig.anchor('eaveR0', 'elbowR', [34, -38, -74]);             // 右前臂护甲外下缘 · 肘端（陆地侧）
  rig.anchor('eaveR1', 'handR', [22, -104, -40]);             // 右手掌外下缘 · 指端（朝海侧）
  rig.anchor('eaveCenter', 'elbowR', [48, -148, 0]);          // 前臂护檐正下腹中心（小花正上方约 2.85 m）
  rig.anchor('fingerR', 'fingerCR0', [0, -21, 0]);            // 右手食指指尖（s03 慢动作扶花）

  // ---- 腿部链（thigh → knee [0,-200,0] → ankle [0,-355,0]，沿 -Y 轴垂直对齐，A 字站姿由 restPose 旋转给出）
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    J('thigh' + L, 'hips', [s * 112, -12, 0]);
    part(new THREE.SphereGeometry(54, 24, 14), { k: 'dark', seed: 100 }, 'thigh' + L, [0, 0, 0]);
    // 分明的大腿深灰装甲壳：拆分为内/外两片（正面中央竖棱自然出结构线），外高内低，下端包覆膝轴护耳（切片 2 & 3）
    const thIn = [
      [-184, [[0, 62], [-s * 48, 44], [-s * 48, -54], [0, -56]]],
      [-92,  [[0, 72], [-s * 56, 50], [-s * 56, -60], [0, -62]]],
      [-16,  [[0, 64], [-s * 48, 44], [-s * 48, -54], [0, -56]]],
    ].map(([y, p]) => [y, s > 0 ? p.slice().reverse() : p]);
    const thOut = [
      [-184, [[0, 62], [s * 52, 44], [s * 52, -54], [0, -56]]],
      [-92,  [[0, 72], [s * 64, 50], [s * 64, -60], [0, -62]]],
      [-4,   [[0, 66], [s * 68, 46], [s * 68, -56], [0, -58]]],
    ].map(([y, p]) => [y, s < 0 ? p.slice().reverse() : p]);
    part(prism(thIn, 4.5, 12), { k: 'dark', seed: 101 + s }, 'thigh' + L, [0, 0, 0]);
    part(prism(thOut, 4.5, 12), { k: 'dark', seed: 103 + s }, 'thigh' + L, [0, 0, 0]);
    for (const side of [-1, 1]) {
      part(plate([
        [side * 42, -162, 46], [side * 58, -162, 46], [side * 42, -162, -46], [side * 58, -162, -46],
        [side * 40, -206, 38], [side * 56, -206, 38], [side * 40, -206, -38], [side * 56, -206, -38],
      ], 4), { k: 'dark', seed: 102 + side }, 'thigh' + L, [0, 0, 0]);
    }

    J('knee' + L, 'thigh' + L, [0, -200, 0]);
    part(drumX(54, 54, 122, 6), { k: 'dark', seed: 103 }, 'knee' + L, [0, 0, -4]);
    for (const e of [1, -1]) part(drumX(32, 36, 16, 3), { k: 'dark', seed: 104 }, 'knee' + L, [e * 66, 0, -4]);

    // 小腿局部坐标换算：以膝关节中心（原图 x=156, y=430）为局部原点，使小腿正交对齐 -Y 轴
    const Lk3 = (x, y, z) => [s * (x - 156), y - 430, z];

    // 1) 单体无缝内/外侧小腿主壳：前下沿平齐高收于 y=156..150（围出宽阔倒梯形拱门缺口），侧翼直落 y=66（侧面完全无缝）
    const ptsShinIn = [
      Lk3(160, 404, 74), Lk3(114, 402, 68), Lk3(66, 390, 24), Lk3(66, 358, -74), Lk3(158, 358, -92),
      Lk3(158, 156, 98), Lk3(100, 150, 92), Lk3(52, 70, 26),  Lk3(54, 70, -136), Lk3(158, 84, -144),
    ];
    const ptsShinOut = [
      Lk3(160, 404, 74), Lk3(206, 402, 68), Lk3(236, 392, 34), Lk3(246, 382, -12), Lk3(240, 358, -78), Lk3(222, 358, -96), Lk3(158, 358, -96),
      Lk3(158, 156, 98), Lk3(220, 150, 91), Lk3(276, 74, 40),  Lk3(296, 66, -14),  Lk3(294, 66, -124), Lk3(270, 66, -146), Lk3(158, 84, -146),
    ];
    part(plate(ptsShinIn, 5, 12), {
      k: 'white', seed: 106 + s, det: [dF(1, 86, 210, s * (108 - 156), 265 - 430)],
    }, 'knee' + L, [0, 0, 0]);
    part(plate(ptsShinOut, 5, 12), {
      k: 'band', ax: [0, 1, 0], bands: [172 - 430, 19, 9999, 0],
      bn: [s, 0, 0.35], bside: 0.2, knee: [-28, 0.48, -116], seed: 108 + s,
      det: [dS(3, s, 195, 260, -26, 245 - 430)],
    }, 'knee' + L, [0, 0, 0]);

    // 拱门缺口内部的深灰踝部内衬机械腔与圆柱轴（正/侧面可见深灰内衬）
    part(abox(108, 84, 126, 8), { k: 'dark', seed: 109 }, 'knee' + L, [s * (160 - 156), 118 - 430, -6]);
    part(drumX(38, 38, 116, 5), { k: 'dark', seed: 110 }, 'knee' + L, [s * (160 - 156), 88 - 430, -14]);

    // 2) 独立膝甲（挂在 kneePadL/R 上，紧贴膝前斜面，带上下深灰台阶衬块，侧面清晰露出后方深灰圆膝轴）
    J('kneePad' + L, 'knee' + L, [s * (162 - 156), 0, 0]);
    part(abox(56, 20, 34, 4), { k: 'dark', seed: 112 }, 'kneePad' + L, [0, 22, 76]);
    part(abox(84, 22, 36, 4), { k: 'dark', seed: 112 }, 'kneePad' + L, [0, -110, 92]);
    part(plate([
      [-50, 20, 96],  [50, 20, 92],  [-50, 20, 56],  [50, 20, 56],
      [-56, -108, 118], [56, -108, 112], [-56, -108, 74], [56, -108, 74],
    ], 7, 12), { k: 'white', seed: 110 + s, det: [dF(0, 88, 108, 0, -46)] }, 'kneePad' + L, [0, 0, 0]);

    // 3) 内侧散热栅：嵌入内侧下垂护翼斜面（z=-10，完全贴合在内侧壁面内，3/4 视角与动作中不悬空）
    const ventG = J('shinVent' + L, 'knee' + L, [s * (57 - 156), 138 - 430, -10]);
    ventG.rotation.z = deg(s * 3.5);
    part(abox(12, 108, 54, 3), { k: 'dark', seed: 113 }, ventG, [0, 0, 0]);
    for (let i = 0; i < 6; i++) {
      part(abox(10, 7.5, 46, 1.5), { k: 'dark', seed: 114 + i }, ventG, [-s * 2.5, -38 + i * 15, 0]);
    }

    // ---- 踝关节与脚掌（ankle 在 [0, -355, 0]，脚踝白甲挂在独立半角关节 ankleGuardL/R 上嵌在拱门缺口内）
    J('ankle' + L, 'knee' + L, [0, -355, 0]);
    const La = (x) => s * (x - 188);
    J('ankleGuard' + L, 'ankle' + L, [La(162), 68, 86]);
    // 脚踝护板顶面深灰斜盖 + 正面带侧倒角的单块立体梯形白甲（正/侧面均与切片 4 吻合）
    part(plate([
      [-40, 16, 26], [40, 16, 26], [-40, 16, -28], [40, 16, -28],
      [-46, -6, 46], [46, -6, 46], [-46, -6, -18], [46, -6, -18],
    ], 4, 12), { k: 'dark', seed: 119 }, 'ankleGuard' + L, [0, 0, 0]);
    part(plate([
      [-42, -4, 48],  [42, -4, 48],  [-48, -6, 12],  [48, -6, 12],
      [-54, -62, 86], [54, -62, 86], [-60, -62, 28], [60, -62, 28],
    ], 5.5, 12), { k: 'white', seed: 120 + s, det: [dF(0, 82, 52, 0, -34)] }, 'ankleGuard' + L, [0, 0, 0]);

    // 深灰大脚：中央趾块 + 内外两侧斜翼踏板
    const footMid = (x0, x1, zf, zb) => [[La(x0), zf], [La(x1), zf], [La(x1), zb], [La(x0), zb]];
    part(prism([
      [0 - 75,  footMid(124, 284, 172, -158)],
      [30 - 75, footMid(126, 282, 170, -156)],
      [90 - 75, footMid(138, 268, 122, -124)],
    ].map(([y, p]) => [y, s < 0 ? p.slice().reverse() : p]), 7, 12), { k: 'dark', seed: 126 + s }, 'ankle' + L, [0, 0, 0]);
    for (const [fx0, fx1, tx0, tx1, sd] of [[58, 126, 92, 140, 1], [282, 360, 266, 330, 2]]) {
      part(prism([
        [0 - 75,  footMid(fx0, fx1, 152, -158)],
        [28 - 75, footMid(fx0 + 2, fx1 - 2, 150, -156)],
        [88 - 75, footMid(tx0, tx1, 114, -124)],
      ].map(([y, p]) => [y, s < 0 ? p.slice().reverse() : p]), 7, 12), { k: 'dark', seed: 128 + sd + s }, 'ankle' + L, [0, 0, 0]);
    }
  }
  rig.anchor('back', 'chest', [0, 70, -175]);
  rig.anchor('footR', 'ankleR', [-21, -75, 7]);               // 右脚掌中心贴地点
  rig.anchor('toeR', 'ankleR', [-21, -70, 172]);              // 右脚尖（贴地）
  return rig;
}

const EXPR = { rest: 0, open: 1, focus: 2, happy: 3, dim: 4, blink: 5 };

// 统一姿态与护甲随动解算：根据四肢关节角自动驱动侧裙甲、膝甲、脚踝甲、肩甲让位，杜绝穿模卡死
export function applyPose(rig, P = {}) {
  const mode = P.pose ?? 'rest';
  if (mode === 'keeper') { keeperPose(rig, P); setLouvers(rig, P); return; }
  rig.j.hips.position.set(0, 640, 0);
  rig.rot('hips', [0, 0, 0]);
  rig.rot('waist', [0, 0, 0]);
  rig.rot('chest', [0, 0, 0]);
  rig.rot('neck', [0, 0, 0]);
  rig.rot('head', [0, 0, 0]);

  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    // 默认设定图站姿：通过关节旋转摆出英雄 A 字外八站姿，上臂微后收、前臂微前倾使侧面清晰露出胯甲与膝甲
    let th = [0, 0, s * 8.2], kn = [0, 0, -s * 2.2], an = [0, 0, -s * 6.0];
    let ar = [6, 0, s * 13], el = [-8, 0, -s * 9], ha = [0, 0, -s * 3];

    if (mode === 'walk') {
      rig.j.hips.position.set(0, 608, 0);
      const f = s > 0 ? 1 : -1;
      th = [f * -26, 0, s * 5];
      kn = [s > 0 ? 22 : 38, 0, -s * 2];
      an = [-(th[0] + kn[0]) * 0.7, 0, -s * 3];
      ar = [f * 20, 0, s * 14];
      el = [-24, 0, -s * 8];
    } else if (mode === 'crouch') {
      rig.j.hips.position.set(0, 495, -24);
      rig.rot('waist', [12, 0, 0]);
      rig.rot('chest', [14, 0, 0]);
      rig.rot('head', [-20, 0, 0]);
      th = [-52, s * 6, s * 9];
      kn = [86, 0, -s * 2];
      an = [-34, 0, -s * 7];
      ar = [-24, 0, s * 20];
      el = [-40, 0, -s * 10];
    } else if (mode === 'kneel') {
      rig.j.hips.position.set(0, 412, -16);
      rig.rot('waist', [10, 0, 0]);
      rig.rot('chest', [12, -6, 0]);
      rig.rot('head', [-14, 6, 0]);
      if (s > 0) {
        th = [-74, 0, s * 7]; kn = [78, 0, -s * 2]; an = [-4, 0, -s * 5];
        ar = [-44, -10, s * 16]; el = [-36, 0, -s * 8];
      } else {
        th = [18, 0, s * 5]; kn = [88, 0, -s * 2]; an = [16, 0, -s * 3];
        ar = [-8, 0, s * 14]; el = [-22, 0, -s * 8];
      }
    } else if (mode === 'sitGround') {
      // 坐在地上：屁股着地、膝盖支起、小腿斜向下到脚；前臂搭在膝头（2026-11-06 侧视调出来的，见 snaps/poseB.jpg 的 G）
      rig.j.hips.position.set(0, 150, 0);
      rig.rot('chest', [6, 0, 0]);                  // 这个骨架 rotation.x 正 = 前倾（2026-11-06 用 tools/probe.mjs 量过）
      rig.rot('head', [P.headPitch ?? -10, P.headYaw ?? 0, 0]);
      th = [-120, 0, s * 9];
      kn = [65, 0, -s * 2];
      an = [-40, 0, -s * 4];
      ar = [-35, 0, s * 16];
      el = [-40, 0, -s * 8];
    } else if (mode === 'shield') {
      // 伏身护花：双膝着地、小腿平贴地面朝后，上身大幅前伏，双手撑在小花两侧，胸腹在小花上方当屋顶
      rig.j.hips.position.set(0, P.ov?.hy ?? 250, 0);
      rig.rot('waist', [P.ov?.wa ?? 30, 0, 0]);
      rig.rot('chest', [P.ov?.ch ?? 35, 0, 0]);
      rig.rot('head', [P.headPitch ?? -20, 0, 0]);
      th = [-20, 0, s * 8];
      kn = [110, 0, -s * 2];
      an = [-40, 0, 0];
      ar = [-58, 0, s * 25];
      el = [-14, 0, -s * 6];
    } else if (mode === 'sit') {
      rig.j.hips.position.set(0, 435, -32);
      rig.rot('waist', [8, 0, 0]);
      rig.rot('chest', [10, 0, 0]);
      rig.rot('head', [-12, 0, 0]);
      th = [-78, s * 7, s * 9];
      kn = [82, 0, -s * 2];
      an = [-4, 0, -s * 7];
      ar = [-18, 0, s * 15];
      el = [-38, 0, -s * 10];
    }

    // 调姿用：URL poseOv=th:-115,kn:48,an:67,ar:-26,el:-48,hy:150,ch:10,wa:6（只改 x 分量 / 髋高）
    const ov = P.ov ?? {};
    if (ov.th != null) th = [ov.th, th[1], th[2]];
    if (ov.kn != null) kn = [ov.kn, kn[1], kn[2]];
    if (ov.an != null) an = [ov.an, an[1], an[2]];
    if (ov.ar != null) ar = [ov.ar, ar[1], ar[2]];
    if (ov.el != null) el = [ov.el, el[1], el[2]];
    if (ov.hy != null) rig.j.hips.position.y = ov.hy;
    if (ov.ch != null) rig.rot('chest', [ov.ch, 0, 0]);
    if (ov.wa != null) rig.rot('waist', [ov.wa, 0, 0]);
    if (ov.hp != null) rig.rot('hips', [ov.hp, 0, 0]);
    rig.rot('thigh' + L, th);
    rig.rot('knee' + L, kn);
    rig.rot('ankle' + L, an);
    rig.rot('arm' + L, ar);
    rig.rot('elbow' + L, el);
    rig.rot('hand' + L, ha);

    // 护甲自动随动让位：
    // 1) 侧裙甲随大腿前抬外翻
    const lift = Math.max(0, -th[0]);
    rig.rot('skirt' + L, [-lift * 0.48, -s * 8, s * (lift * 0.35)]);
    // 2) 膝甲随膝关节半角联动
    rig.rot('kneePad' + L, [-kn[0] * 0.28, 0, 0]);
    // 3) 脚踝护板随踝关节半角联动（收进小腿下口拱门内）
    rig.rot('ankleGuard' + L, [-an[0] * 0.45, 0, 0]);
    // 4) 肩甲随上臂外展/前举联动让位
    const armLift = Math.max(0, -ar[0]) * 0.25 + Math.max(0, Math.abs(ar[2]) - 13) * 0.45;
    rig.rot('pauldron' + L, [ar[0] * 0.15, 0, -s * (6 - armLift)]);

  }
  setLouvers(rig, P);
}

// 百叶：lv 1 = 全开，0 = 全关；从上到下逐片关（第 i 片在 (1-lv)·6 越过 i 时关上）
function setLouvers(rig, P) {
  const lv = P.louver ?? 1;
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    const side = L === 'L' ? (P.louverL ?? lv) : (P.louverR ?? lv);
    rig.louvers[L].forEach((j, i) => {
      const row = i % 6, open = 1 - clamp((1 - side) * 6 - row, 0, 1);
      if (i < 6) j.rotation.x = deg(-38 * open);
      else j.rotation.z = deg(s * 38 * open);
    });
  }
}

// ================================================================== 坐姿与护花 IK 解算
// 坐姿和护花都用 IK 摆：脚掌、拳头、屁股贴着 world.terrain，姿势怎么变都不漂、不穿地。
// 座位坐标系（米）：r = 凪的右手方向（世界 +X），f = 朝海方向（世界 −Z），h = 离那一点地面的高度。
const C = CUES;
export const SEAT_YAW = 180;
const V3n = () => new THREE.Vector3();
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _qh = new THREE.Quaternion();
const _qI = new THREE.Quaternion(), _qHalf = new THREE.Quaternion(), _qLoc = new THREE.Quaternion();
const _m4 = new THREE.Matrix4(), _eu = new THREE.Euler();
const _bx = V3n(), _by = V3n(), _bz = V3n();
const _A = V3n(), _D = V3n(), _H = V3n(), _N = V3n(), _O = V3n(), _P = V3n(), _T = V3n(), _U = V3n();
const _c0 = V3n(), _c1 = V3n(), _d0 = V3n(), _d1 = V3n(), _z0 = V3n(), _z1 = V3n(), _off = V3n(), _hp = V3n(), _lk = V3n(), _lt = V3n();

export function seatXZ(r, f) {
  const a = deg(SEAT_YAW), [sx, sz] = SPOT.seat;
  return [sx - r * Math.cos(a) + f * Math.sin(a), sz + r * Math.sin(a) + f * Math.cos(a)];
}
export function seatRF(x, z) {
  const a = deg(SEAT_YAW), dx = x - SPOT.seat[0], dz = z - SPOT.seat[1];
  return [-dx * Math.cos(a) + dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)];
}
const seatPt = (out, r, f, h) => { const [x, z] = seatXZ(r, f); return out.set(x, terrain(x, z) + h, z); };
const seatVec = (out, r, f, h) => { const a = deg(SEAT_YAW); return out.set(-r * Math.cos(a) + f * Math.sin(a), h, r * Math.sin(a) + f * Math.cos(a)); };
// 世界朝向：骨头 -Y 沿 dir，+Z 尽量朝 hint
function basisQ(out, dir, hint) {
  _by.copy(dir).normalize().negate();
  _bz.copy(hint).addScaledVector(_by, -hint.dot(_by)).normalize();
  _bx.crossVectors(_by, _bz);
  return out.setFromRotationMatrix(_m4.makeBasis(_bx, _by, _bz));
}
function setWorldQ(j, qW) {
  j.parent.updateWorldMatrix(true, false);
  j.parent.getWorldQuaternion(_qp);
  j.quaternion.copy(_qp.invert().multiply(qW));
  j.updateWorldMatrix(false, true);
}
const eulerDeg = (j) => { _eu.setFromQuaternion(j.quaternion, 'XYZ'); return [_eu.x / deg(1), _eu.y / deg(1), _eu.z / deg(1)]; };

// 脚：foot = [r, f, lift, toeOut, pitch]（脚掌中心贴地点；lift 抬脚高度 m；toeOut 外撇°；pitch 脚尖上翘°）；pole = 膝盖朝向点 [r, f, h]
// 6 m 见方的大脚放在起伏的地上：脚掌下 9 个点最小二乘拟合一个平面（法线 + 中心高度），不漂也不深插
function footPlane(x, z, dx, dz) {
  let n = 0, sy = 0, sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0;
  for (const a of [-2.5, 0, 2.5]) for (const b of [-2.7, 0, 2.7]) {
    const px = x + a * dz + b * dx, pz = z - a * dx + b * dz, py = terrain(px, pz);
    const u = px - x, w = pz - z;
    n++; sy += py; sxx += u * u; szz += w * w; sxz += u * w; sxy += u * py; szy += w * py;
  }
  // 对称采样：sx = sz = 0
  const det = sxx * szz - sxz * sxz, bx = (sxy * szz - szy * sxz) / det, bz = (szy * sxx - sxy * sxz) / det;
  return [sy / n, bx, bz];
}
function legIK(rig, L, s, foot, pole) {
  const [r, f, lift, toe, pitch] = foot;
  const [x, z] = seatXZ(r, f);
  seatVec(_D, -s * Math.sin(deg(toe)), Math.cos(deg(toe)), 0);
  const [gy, bx, bz] = footPlane(x, z, _D.x, _D.z);
  _N.set(-bx, 1, -bz).normalize();
  _D.addScaledVector(_N, -_D.dot(_N)).normalize();
  const pr = deg(pitch);
  _U.copy(_N).multiplyScalar(Math.cos(pr)).addScaledVector(_D, -Math.sin(pr));
  _H.copy(_D).multiplyScalar(Math.cos(pr)).addScaledVector(_N, Math.sin(pr));
  _A.copy(_U).negate();
  basisQ(_qf, _A, _H);
  _O.set(s * 21, -75, 7).applyQuaternion(_qf).multiplyScalar(K);
  _T.set(x, gy + lift, z).sub(_O);
  seatPt(_P, ...pole);
  solve2(rig.j['thigh' + L], rig.j['knee' + L], rig.j['ankle' + L], _T, _P, -1);
  setWorldQ(rig.j['ankle' + L], _qf);
}
// 手：contact 世界点；dir/hint 世界向量；off = 接触点在手关节局部（px）；pole 世界点
function armIK(rig, L, contact, dir, hint, off, pole) {
  basisQ(_qh, dir, hint);
  _O.copy(off).applyQuaternion(_qh).multiplyScalar(K);
  _T.copy(contact).sub(_O);
  solve2(rig.j['arm' + L], rig.j['elbow' + L], rig.j['hand' + L], _T, pole, 1);
  setWorldQ(rig.j['hand' + L], _qh);
}
// 食指指尖在手关节局部的位置（px）
function tipLocal(rig, L, out) {
  out.set(0, -21, 0);
  for (const n of ['fingerC' + L + '0', 'fingerB' + L + '0', 'finger' + L + '0']) { const j = rig.j[n]; j.updateMatrix(); out.applyMatrix4(j.matrix); }
  return out;
}
// 头：朝世界方向 dir 看（脖子分 40%，头 60%）
function aimHead(rig, dir, pitchAdd, roll) {
  const neck = rig.j.neck, head = rig.j.head;
  neck.rotation.set(0, 0, 0); head.rotation.set(0, 0, 0);
  neck.parent.updateWorldMatrix(true, false);
  neck.parent.getWorldQuaternion(_qp);
  _D.copy(dir).applyQuaternion(_qp.invert());
  const yaw = clamp(Math.atan2(_D.x, _D.z), deg(-54), deg(54));
  const pitch = clamp(Math.atan2(-_D.y, Math.hypot(_D.x, _D.z)) + deg(pitchAdd), deg(-38), deg(24));
  neck.rotation.set(pitch * 0.4, yaw * 0.45, 0);
  head.rotation.set(pitch * 0.6, yaw * 0.55, deg(roll));
}
const KNEE_HAND = { L: [new THREE.Vector3(0, 30, 70)], R: [new THREE.Vector3(0, 30, 70)] };

function keeperPose(rig, P) {
  const k = P.k;
  rig.root.updateMatrixWorld(true);
  rig.j.hips.position.set(0, k.hy, 0);
  rig.rot('hips', [k.fwd * 0.2, -k.tw * 0.2, k.lean * 0.2]);
  rig.rot('waist', [k.fwd * 0.4, -k.tw * 0.4, k.lean * 0.4]);
  rig.rot('chest', [k.fwd * 0.4, -k.tw * 0.4, k.lean * 0.4]);
  rig.rot('neck', [0, 0, 0]); rig.rot('head', [0, 0, 0]);
  // 手指：默认自然半握；s03 指尖扶花（pt）伸直食指；s09–s11 前臂成檐（flat）四指微展并拢成宽檐面
  const flat = k.flat ?? 0;
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    for (let i = 0; i < 4; i++) {
      const wPt = L === 'R' && i === 0 ? k.pt : L === 'R' ? k.pt * 0.25 : 0;
      const wFl = L === 'R' ? flat : 0;
      const a1 = (18 + (i ? 8 : -14) * wPt) * (1 - 0.72 * wFl);
      const a2 = (44 + (i ? 20 : -38) * wPt) * (1 - 0.76 * wFl);
      const a3 = (48 + (i ? 15 : -42) * wPt) * (1 - 0.80 * wFl);
      rig.j['finger' + L + i].rotation.set(0, 0, deg(-s * a1));
      rig.j['fingerB' + L + i].rotation.set(0, 0, deg(-s * a2));
      rig.j['fingerC' + L + i].rotation.set(0, 0, deg(-s * a3));
    }
  }
  rig.root.updateMatrixWorld(true);
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) legIK(rig, L, s, k['f' + L], k['k' + L]);
  rig.root.updateMatrixWorld(true);
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    // 搭在膝头：接触点 = 膝关节局部偏移；手朝前自然搭放
    const knee = rig.j['knee' + L];
    knee.localToWorld(_c1.copy(KNEE_HAND[L][0]));
    _c1.y += 0.35;
    seatVec(_d1, -s * 0.12, 0.78, -0.62).normalize();
    seatVec(_z1, 0, 0.62, 0.78).normalize();
    // 显式目标（扶花指尖 / 前臂悬停屋檐）
    const h = k['h' + L], d = k['h' + L + 'd'], zz = k['h' + L + 'z'];
    seatPt(_c0, ...h);
    seatVec(_d0, ...d).normalize();
    seatVec(_z0, ...zz).normalize();
    const w = k['h' + L + 'k'];
    _c0.lerp(_c1, w); _d0.lerp(_d1, w).normalize(); _z0.lerp(_z1, w).normalize();
    // 接触点：掌心（0,-56,0）↔ 食指指尖
    const o = L === 'R' ? k.hRo : 0;
    _off.set(0, -56, 0);
    if (o > 0) _off.lerp(tipLocal(rig, L, _lt), o);
    if (w > 0) _off.multiplyScalar(1 - w);
    seatPt(_P, ...k['e' + L]);
    armIK(rig, L, _c0, _d0, _z0, _off, _P);
  }
  // 护甲随动：侧裙甲、膝甲、踝甲、肩甲自动随肢体角度平滑让位，确保全片零穿模
  for (const [s, L] of [[1, 'L'], [-1, 'R']]) {
    const th = eulerDeg(rig.j['thigh' + L]), ar = eulerDeg(rig.j['arm' + L]);
    const kn = rig.j['knee' + L].rotation.x / deg(1);
    const lift = clamp(-th[0], 0, 120);
    rig.rot('skirt' + L, [-lift * 0.50, -s * 10, s * (lift * 0.38)]);
    rig.rot('kneePad' + L, [-clamp(kn, 0, 50) * 0.18, 0, 0]);
    const qA = rig.j['ankle' + L].quaternion, ag = rig.j['ankleGuard' + L];
    _qHalf.copy(_qI).slerp(qA, 0.52);
    _qLoc.copy(qA).invert().multiply(_qHalf);
    ag.quaternion.copy(_qLoc);
    ag.position.set(s * (162 - 188), 68, 86).applyQuaternion(_qLoc);
    const armLift = Math.min(20, Math.max(0, -ar[0]) * 0.26 + Math.max(0, Math.abs(ar[2]) - 12) * 0.48);
    const pe = k['p' + L] ?? [0, 0, 0];
    rig.rot('pauldron' + L, [ar[0] * 0.15 + pe[0], pe[1], -s * (6 - armLift) + pe[2]]);
  }
  rig.root.updateMatrixWorld(true);
  // 头部视线
  rig.j.head.getWorldPosition(_hp);
  _D.set(0, 0, 0);
  for (const [tg, w] of k.look) {
    if (w <= 0) continue;
    if (tg === 'flower') _lk.set(SPOT.flower[0], terrain(...SPOT.flower) + 0.9, SPOT.flower[1]);
    else seatPt(_lk, ...tg);
    _D.addScaledVector(_lk.sub(_hp).normalize(), w);
  }
  aimHead(rig, _D.normalize(), k.hp ?? 0, k.roll ?? 0);
}

// ---------------------------------------------------------------- 全片表演（100 s 慢节奏重机械动作，一拍二）
const FLW = seatRF(...SPOT.flower);
const mixPose = (a, b, u) => {
  const o = {};
  for (const key in a) {
    const x = a[key], y = b[key] ?? x;
    o[key] = Array.isArray(x) && typeof x[0] === 'number' ? x.map((v, i) => v + (y[i] - v) * u) : typeof x === 'number' ? x + (y - x) * u : (u < 0.5 ? x : y);
  }
  return o;
};
// easeHeavy（五次 smootherstep：重型机械起停柔缓沉稳）已下沉到 core/util.js（C4）
function poseTrack(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1, e] = keys[i], [t0, p0] = keys[i - 1];
    if (t <= t1) return mixPose(p0, p1, (e ?? easeHeavy)(clamp((t - t0) / (t1 - t0))));
  }
  return keys[keys.length - 1][1];
}

export const POSES = (() => {
  const [Fr, Ff] = FLW;   // Fr = 7.60 m, Ff = 3.60 m
  // 石台舒展高坐姿（hy = 278 px ≈ 5.40 m，骨盆底稳落于 2.42 m 崖顶卧石台）：
  // 右手自然扶靠在石台右外沿（不架在右膝顶上），右腿略内收，彻底腾空“镜头 @lens ↔ 岩缝小花”的双向视线走廊
  const SIT = {
    hy: 278, fwd: 5, lean: 0, tw: 0,
    fR: [3.85, 8.25, 0, 18, 0], kR: [3.5, 5.4, 5.7],
    fL: [-4.95, 8.10, 0, 23, 0], kL: [-4.5, 5.4, 6.2],
    hR: [6.85, 1.85, 2.95], hRk: 0, hRd: [0.14, 0.78, -0.61], hRz: [-0.94, 0.26, 0.21], hRo: 0, eR: [9.9, -3.1, 4.7],
    hL: [-6, 5, 3.0],  hLk: 1, hLd: [0, 0.8, -0.6],     hLz: [0, 0.6, 0.8],         eL: [-10.5, -2.5, 4.8],
    pt: 0, flat: 0, pR: [0, 0, 0], pL: [0, 0, 0],
  };
  const P = (base, o) => ({ ...base, ...o });

  // 第一幕 s03_reach（14.8–19.2 s）：4.4 秒从容抬臂 → 悬停对准 → 食指指尖轻推歪斜花茎扶正 → 停留端详 → 4.2 秒收回石台侧沿
  const tipD = [-0.14, 0.34, -0.93];
  const tipZ = [-0.85, 0.32, 0.42];
  const REACH_LIFT = P(SIT, { lean: 4, fwd: 6.5, tw: 2.5, hRk: 0, hRo: 0.5, pt: 0.6, hR: [Fr - 0.55, Ff - 0.85, 3.45], hRd: tipD, hRz: tipZ, eR: [11.0, -2.4, 5.1] });
  const REACH_HOVER = P(SIT, { lean: 8.5, fwd: 9.5, tw: 4.5, hRk: 0, hRo: 1, pt: 1, hR: [Fr + 0.32, Ff - 0.62, 1.92], hRd: tipD, hRz: tipZ, eR: [11.4, -2.0, 5.0] });
  const REACH_PRE = P(REACH_HOVER, { lean: 10, fwd: 10.5, hR: [Fr + 0.14, Ff - 0.44, 1.48] });
  const REACH_PUSH = P(REACH_PRE, { lean: 10.5, fwd: 11, hR: [Fr + 0.02, Ff - 0.16, 1.54] });
  const REACH_HOLD = P(REACH_PUSH, { hR: [Fr + 0.22, Ff - 0.22, 1.68] });

  // 第三幕 s09_shelter（52.6–57.2 s）：4.6 秒沉稳抬起宽大右前臂与手掌，近水平悬停在花正上方成宽阔护雨白甲屋檐
  const GUARD_LIFT = P(SIT, {
    lean: 6, fwd: 7, tw: 3, hRk: 0, flat: 0.55,
    hR: [Fr - 0.35, Ff + 0.45, 4.35], hRd: [0.04, 0.97, -0.22], hRz: [-0.98, 0.05, -0.16], eR: [11.4, -2.1, 5.3],
    pR: [-4, 0, -8],
  });
  const GUARD_EXT = P(SIT, {
    lean: 10, fwd: 9, tw: 5, hRk: 0, flat: 1,
    hR: [Fr + 0.12, Ff + 1.15, 3.92], hRd: [0.04, 0.99, -0.13], hRz: [-0.98, 0.04, -0.18], eR: [11.6, -1.8, 5.0],
    pR: [-6, 0, -12],
  });
  const GUARD = P(GUARD_EXT, {
    lean: 10.5, fwd: 9.5, tw: 5.2,
    hR: [Fr + 0.12, Ff + 1.12, 3.76],
  });

  // 第四幕 s13_retract（81.6–86.0 s）：4.4 秒缓缓抬高右前臂并收拢扶回石台侧沿，让单侧暖阳洒落小花与水洼
  const RETRACT_LIFT = P(GUARD_LIFT, {
    lean: 4.5, fwd: 6, tw: 2, hRk: 0, flat: 0.35,
    hR: [Fr - 0.4, Ff + 0.35, 4.55],
  });

  return { SIT, REACH_LIFT, REACH_HOVER, REACH_PRE, REACH_PUSH, REACH_HOLD, GUARD_LIFT, GUARD_EXT, GUARD, RETRACT_LIFT };
})();

const BODY = (() => {
  const S = POSES;
  const [rc0] = C.reach, st = C.straighten, [rr0, rr1] = C.retractReach;
  const [g0, g1] = C.guard, [rs0, rs1] = C.rise;
  return [
    [0, S.SIT],
    // 慢动作扶花（14.8 → 19.2 s 伸出拨正，19.2 → 22.6 s 温柔停驻，22.6 → 26.8 s 慢收回膝）
    [rc0, S.SIT],
    [rc0 + 1.6, S.REACH_LIFT],
    [rc0 + 3.1, S.REACH_HOVER],
    [st - 0.55, S.REACH_PRE],
    [st, S.REACH_PUSH],
    [st + 1.1, S.REACH_HOLD],
    [rr0, S.REACH_HOLD],
    [rr0 + 1.8, S.REACH_LIFT],
    [rr1, S.SIT],
    // 慢动作伸前臂成檐（52.6 → 57.2 s）
    [g0, S.SIT],
    [g0 + 1.7, S.GUARD_LIFT],
    [g1 - 1.1, S.GUARD_EXT],
    [g1, S.GUARD],
    // 雨后慢动作收臂回膝（81.6 → 86.0 s）
    [rs0, S.GUARD],
    [rs0 + 1.8, S.RETRACT_LIFT],
    [rs1, S.SIT],
  ];
})();

// 视线轨迹（全程平滑过渡，绝不突兀甩头）
const SEA_CALM = [-4, 420, 18];
const WINDWARD = [-14, 340, 65];
const SKY_CUPS = [4, 90, 165];
const SUN_SIDE = [-180, 210, 58];   // 左侧（-X 西海面）云开阳光处

const LOOK = [
  [0, SEA_CALM],
  [9.8, SEA_CALM], [11.6, 'flower'],
  [27.8, 'flower'], [29.8, WINDWARD],
  [34.6, WINDWARD], [36.4, SKY_CUPS],
  [41.5, SKY_CUPS], [43.8, 'flower'],
  [74.0, 'flower'],
  [77.0, 'flower'], [79.6, SUN_SIDE],
  [84.2, SUN_SIDE], [86.6, 'flower'],
  [100.0, 'flower'],
];

function lookAtT(t) {
  if (t <= LOOK[0][0]) return [[LOOK[0][1], 1]];
  for (let i = 1; i < LOOK.length; i++) {
    const [t1, b] = LOOK[i], [t0, a] = LOOK[i - 1];
    if (t <= t1) { const u = smooth((t - t0) / Math.max(1e-3, t1 - t0)); return [[a, 1 - u], [b, u]]; }
  }
  return [[LOOK[LOOK.length - 1][1], 1]];
}

export function perform(t) {
  const T = onTwos(t);
  const at = SPOT.seat, yaw = SEAT_YAW, pose = 'keeper';
  const k = { ...poseTrack(BODY, T) };
  k.look = lookAtT(T);

  // 头部细微情绪：醒前微垂；fondly 与结尾温柔歪头；暴雨守护时沉稳微低头（受 pitch 上限保护绝不挡眼）
  k.hp = 9 * (1 - smooth(invLerp(C.wake - 0.4, C.wake + 1.4, T)))
    - 6 * smooth(invLerp(C.fondly - 0.5, C.fondly + 0.6, T)) * (1 - smooth(invLerp(C.fondly + 2.2, C.fondly + 3.4, T)))
    + 4 * smooth(invLerp(C.endure[0], C.endure[1], T)) * (1 - smooth(invLerp(C.eyeOpen[0], C.rise[0], T)));
  k.roll = 7 * smooth(invLerp(C.fondly - 0.3, C.fondly + 0.6, T)) * (1 - smooth(invLerp(C.fondly + 2.0, C.fondly + 3.2, T)))
    + 6 * smooth(invLerp(C.smile - 0.4, C.smile + 0.8, T));

  // 暴雨承受感：狂风暴雨砸在前臂护甲上的极细微沉重震颤
  const hold = smooth(invLerp(C.guard[1], C.guard[1] + 0.8, T)) * (1 - smooth(invLerp(C.rise[0], C.rise[0] + 0.5, T)));
  const stormShake = hold * smooth(invLerp(C.rainHit - 0.4, C.rainHit + 1.2, T)) * (1 - smooth(invLerp(C.eyeClose[0], C.rainStop, T)));
  k.lean += stormShake * (0.22 * noise1(T * 1.2, 21) + 0.08 * noise1(T * 3.1, 22));
  k.fwd += stormShake * 0.16 * noise1(T * 1.5, 23);

  let expr = 'rest', glow = 1;
  if (T < C.wake) { expr = 'dim'; glow = 0.18; }
  else if (T < C.wake + 1.1) glow = 0.18 + 0.82 * smooth((T - C.wake) / 1.1);
  if (T >= C.fondly && T < C.fondly + 2.8) expr = 'happy';
  if (T >= C.notice && T < C.guard[0]) expr = 'focus';
  if (T >= C.gust && T < C.gust + 1.4) expr = 'open';
  if (T >= C.endure[0] && T < C.eyeClose[0]) glow = 1 - 0.35 * smooth(invLerp(C.endure[0], C.endure[1], T));
  if (T >= C.eyeClose[0] && T < C.eyeOpen[0]) {
    const uClose = smooth(invLerp(C.eyeClose[0], C.eyeClose[1], T));
    expr = uClose < 0.7 ? 'blink' : 'dim';
    glow = 0.65 * (1 - uClose);
  }
  if (T >= C.eyeOpen[0] && T < C.smile) {
    expr = 'open';
    glow = smooth(invLerp(C.eyeOpen[0], C.eyeOpen[1], T));
  }
  if (T >= C.smile) expr = 'happy';

  return { at, yaw, pose, k, expr, glow, louverL: 1, louverR: 1 };
}

export function createNagi(ctx) {
  const Q = ctx.params;
  const M = makeMats(Q);
  const rig = build(M);
  rig.root.scale.setScalar(K);
  rig.j.neck.rotation.order = rig.j.head.rotation.order = 'YXZ';
  const fixed = ['louver', 'pose', 'expr', 'nagiAt', 'nagiYaw'].some((k) => Q?.get(k) != null);
  const num3 = (s) => s.split(',').map(Number);
  ctx.scene.add(rig.root);
  ctx.shadowRoots.push(rig.root);
  const cups = rig.j.cups;
  const _c = new THREE.Vector3(), _a = new THREE.Vector3(), _o = new THREE.Vector3();
  const gFlw = terrain(...SPOT.flower);

  function place(at, yaw) {
    if (at.length === 3) rig.root.position.set(...at);
    else rig.root.position.set(at[0], terrain(at[0], at[1]), at[1]);
    rig.root.rotation.y = deg(yaw);
  }
  if (fixed) {
    const ov = Object.fromEntries((Q.get('poseOv') ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split(':'); return [k, parseFloat(v)]; }));
    applyPose(rig, { louver: Q.get('louver') != null ? parseFloat(Q.get('louver')) : 1, pose: Q.get('pose') ?? 'rest', ov });
    M.U.uExpr.value = EXPR[Q.get('expr') ?? 'rest'] ?? 0;
    M.U.uGlow.value = Q.get('expr') === 'dim' ? 0.15 : 1;
    place(Q.get('nagiAt') ? num3(Q.get('nagiAt')) : SPOT.seat, parseFloat(Q.get('nagiYaw') ?? '0'));
  }

  return {
    rig,
    update(st) {
      const t = st.t, T = onTwos(t);
      let glowNow = M.U.uGlow.value;
      if (!fixed) {
        const p = perform(t);
        place(p.at, p.yaw);
        applyPose(rig, p);
        M.U.uExpr.value = EXPR[p.expr] ?? 0;
        M.U.uGlow.value = p.glow;
        glowNow = p.glow;
      }
      // 湿润装甲、镜头水痕/雨后金珠与胸口记录鼓笔迹
      M.U.uWet.value = wet(t);
      M.U.uRain.value = rain(t);
      M.U.uLensT.value = onThrees(t);
      const roll = T * 0.40;
      const rec = clamp(smooth(invLerp(C.windRise[0], C.recWild[1], T)) * (0.42 + 0.58 * wind(T)), 0, 1) * (T < C.rainStop ? 1 : 0.05);
      M.U.uRoll.value = roll;
      M.U.uRec.value = rec;
      if (rig.penNib) {
        const xp = (Math.PI * 0.5 + roll) * 3.0;
        const wv = 0.04 * Math.sin(xp * 3.5) + 0.025 * Math.cos(xp * 9.0);
        const gl = 0.30 * (Math.abs(((xp * 1.65) % 1 + 1) % 1 - 0.5) * 2.0 - 0.5) + 0.11 * Math.sin(xp * 13.0);
        rig.penNib.position.y = 6 + (wv + (gl - wv) * rec) * 38;
      }
      // 三只真实黄铜风杯旋转：高速时逐帧更新转角保证 24fps 视觉飞转顺滑不倒转，微风时按二拍节奏
      if (cups) {
        const om = cupOmega(t);
        cups.rotation.y = cupAngle(om > 5.5 ? t : T);
      }
      rig.root.updateMatrixWorld(true);

      // 暴雨护花期间（s10_under_eave），凪的琥珀色镜头眼向下给前臂屋檐下的白花投一抹温暖柔光
      if (!fixed && t >= C.guard[1] - 0.5 && t < C.eyeClose[1]) {
        const kLamp = smooth(invLerp(C.rainHit - 0.6, C.rainHit + 1.0, t)) * glowNow;
        setLamp(0, { pos: [SPOT.flower[0] - 0.10, gFlw + 1.35, SPOT.flower[1] - 0.15], color: '#ffb862', radius: 2.6, intensity: 0.55 * kLamp });
      }

      // 部件锚点特写跟随（如 s07_needle 对准胸口舷窗）
      const aim = ctx.SHOTS[st.si]?.aim;
      if (aim && rig.anchors[aim.anchor] && ctx.params?.get('cam') == null) {
        rig.at(aim.anchor, _a);
        _o.set(...aim.offset).applyQuaternion(rig.root.quaternion);
        ctx.camera.position.copy(_a).add(_o);
        ctx.camera.lookAt(_a);
        ctx.camera.updateMatrixWorld();
      }
      rig.at('chest', _c);
      st.shadow = { center: [_c.x + 1.5, _c.y - 3, _c.z - 1.5], radius: 14, depth: 60 };
    },
  };
}
