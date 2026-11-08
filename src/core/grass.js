import * as THREE from 'three';
import { COMMON, MRT_OUT, VERT_STD, PUDDLE_GLSL } from './glsl.js';
import { base, mat } from './materials.js';
import { Rng } from './util.js';
import { screen } from './color.js';

// 草原（2026-11，《海岬的测风人》草地部门新建；老片不 import 这个文件，所以对老片零影响）。
// 参考：K4（大风里的长草台地）、K2（阳光下的崖顶草地 + 灰褐崖面）、K1b（暴雨里压倒的湿草）、K5（雨后湿草亮边）。
//
// 三层，和背景画师的分工一样：
//   近景  一根一根的 3D 叶片（GrassField，InstancedBufferGeometry，按 8 m 地块懒生成、按距离抽稀）+ 羽状草穗
//   中景  地面材质里沿风向拉长的笔触色块（meadowGround），交给 Kuwahara 出水粉笔触
//   远景  同一个地面材质：笔触尺度随像素足迹自动放大，最后读成平涂
// 风浪：look.wind（uWind = 方向、强度、行进距离）。叶片按“本地浪高”弯得更多、颜色翻成浅黄绿；地面在同一个浪场里画出亮带。
// 天气：uMeadow = (lod0, lod1, wet, rain)；雨里草变深变冷、被压平；雨后低太阳逆光时叶缘有湿亮边。
// 接触：uPress[8] = (x, z, 半径, 强度)：巨人坐处 / 脚 / 手把草压平（世界坐标，部门每帧在渲染前填）。
//
// 一切都是 uniform + 确定性地块的函数：地块内容只由 (地块号, seed) 决定，第几帧先渲染都一样。

// ---------------------------------------------------------------- 调色板（屏幕色；内部过 screen()）
export const MEADOW = {
  // 叶片：深（冷青蓝暗部）→ 暗绿 → 中绿 → 亮黄绿 → 浪峰浅鹅黄（K4 迎光叶尖）
  blade: ['#254344', '#436650', '#799252', '#c3c66a', '#f2e89e'],
  // 地面：草根下的暗部 → 草面中间色 → 亮 → 暖黄（晒干的一片）
  ground: ['#365247', '#6a8450', '#9da85c', '#d0c376'],
  plume: ['#aa9c6a', '#e2d396', '#f8f0c8'],
  rock: ['#3a3846', '#5a5562', '#8c7d6c', '#baa382'],          // 崖面：冷紫灰暗部 + 暖赭灰受光面（K2）
  boulder: ['#444a56', '#676b74', '#98948c', '#cbc4b4'],       // 草里的灰岩：偏冷的蓝灰受光暖灰（K4/K5）
  moss: ['#4b6340', '#7f8d4c'],
};

const C3 = (h) => new THREE.Color(screen(h));

// 草浪（地面和叶片共用）：核心 windWave 的 8 m 小浪 + 一层 ~24 m 的大浪带（远景里读成一道道翻过来的浪）
const WAVE = /* glsl */ `
float uWaveNear = 1.0;
float meadowWave(vec2 p){
  if(uWind.z <= 0.0) return 0.0;
  vec2 d = normalize(uWind.xy);
  float s = dot(p, d) - uWind.w;
  float side = dot(p, vec2(-d.y, d.x));
  float big = 0.5 + 0.5 * sin(s * 0.26 + 2.4 * vnoise(vec2(side * 0.018, s * 0.008)) * 2.0);
  big = smoothstep(0.42, 0.97, big) * (0.55 + 0.45 * vnoise(vec2(side * 0.03 + 7.0, s * 0.02)));
  return clamp(max(windWave(p) * uWaveNear, big * 0.9), 0.0, 1.0);
}
`;

// 与 materials.js 的 PAINT_LIGHT 同一个公式（绘画背景的统一照法），多返回一个受光量
const LIGHT = /* glsl */ `
vec3 meadowLight(vec3 N, vec3 wp, out float lit){
  float ndl = dot(N, uSunDir);
  lit = smoothstep(-0.03, 0.15, ndl) * sunShadow(wp, N);
  float up = smoothstep(-0.6, 0.9, N.y);
  vec3 amb = mix(uShadeTint, uSkyTint, up * 0.45 + 0.22) * 0.92;
  amb += uBounce * exp(-max(wp.y - uWaterLevel, 0.0) / 7.0) * (1.0 - up) * 0.2 * uSunStrength;
  vec3 sun = uSunColor * 0.46 * lit * uSunStrength;
  vec3 b = amb * (1.0 - 0.12 * lit) + sun;
  vec3 lampL = lampLight(wp, N, 0.3, 0.0);
  return max(b, lampL) + lampL * 0.06;
}
// 雨：变深、变冷、降饱和；wet 留到雨后（颜色深一档但不再灰）
vec3 meadowWeather(vec3 c, float wet, float rain){
  float l = dot(c, vec3(0.3, 0.55, 0.15));
  c = mix(c, vec3(l), rain * 0.3);
  c *= mix(vec3(1.0), vec3(0.66, 0.76, 0.8), clamp(wet * 0.55 + rain * 0.35, 0.0, 1.0));
  return c;
}
`;

// 共享的 uniform（地面、叶片、岩石同一组对象 → 部门每帧改一次全部生效）
export function meadowUniforms(o = {}) {
  return {
    uMeadow: { value: new THREE.Vector4(o.lod0 ?? 9, o.lod1 ?? 36, 0, 0) },   // lod0, lod1, wet, rain
    uPress: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uWDir: { value: new THREE.Vector2(...(o.windDir ?? [0, 1])).normalize() },
    uClear: { value: (o.clear ?? []).concat(Array(4).fill([0, 0, 0, 0])).slice(0, 4).map((c) => new THREE.Vector4(...c)) },
  };
}

// ---------------------------------------------------------------- 地面
// 几何体可带 aEdge（离崖边的有符号距离，米，+ 朝陆地）：崖顶草唇、崖面挂下来的绿条
// o.puddles: true（W10）平地上的硬边水洼（glsl.js PUDDLE_GLSL，覆盖量由 look.puddles 控制）。注意叶片层（GrassField）不知道水洼：
//            近景要么用 uClear 在水洼处清掉草，要么只在草稀的远处 / 小路上开。不给 = 与旧版逐像素一致
export function meadowGround(U, o = {}) {
  const P = o.palette ?? MEADOW;
  const u = base({
    ...U,
    uG: { value: P.ground.map(C3) },
    uR: { value: P.rock.map(C3) },
    uM: { value: P.moss.map(C3) },
    uSea: { value: o.seaLine ?? 2.0 },
  });
  const vs = /* glsl */ `
    ${VERT_STD}
    attribute float aEdge;
    varying float vEdge;
    void main(){ vEdge = aEdge; stdVertex(position, normal); }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    ${WAVE}
    ${LIGHT}
    #ifdef USE_PUDDLES
    ${PUDDLE_GLSL}
    #endif
    uniform vec3 uG[4], uR[4], uM[2];
    uniform vec4 uMeadow, uClear[4];
    uniform vec2 uWDir;
    uniform float uSea;
    varying vec3 vWorld, vNormalW, vNormalV;
    varying float vDepth, vEdge;
    varying vec2 vUv;
    vec3 pal4(vec3 a, vec3 b, vec3 c, vec3 d, float t){
      t = clamp(t, 0.0, 1.0) * 3.0;
      return t < 1.0 ? mix(a, b, t) : t < 2.0 ? mix(b, c, t - 1.0) : mix(c, d, t - 2.0);
    }
    // 沿风向拉长的笔触：一格一笔，笔的长宽 = cell，随机偏移/亮暗
    float strokes(vec2 q, vec2 cell, float seed){
      vec2 g = q / cell;
      g.x += 0.5 * floor(g.y);                    // 错行
      vec2 id = floor(g), f = fract(g) - 0.5;
      vec2 h = hash22(id + seed);
      f -= (h - 0.5) * 0.5;
      float e = length(f * vec2(1.0, 2.2));
      float dab = 1.0 - smoothstep(0.28, 0.5, e);
      return (h.y - 0.5) * 2.0 * dab;             // -1..1
    }
    void main(){
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 N = normalize(vNormalW), NV = normalize(vNormalV);
      if(!gl_FrontFacing){ N = -N; NV = -NV; }
      vec2 p = vWorld.xz;
      float dist = distance(vWorld, cameraPosition);
      float wet = uMeadow.z, rain = uMeadow.w;
      // 风向坐标系：q.x 沿风，q.y 横风
      vec2 wd = uWDir, wp2 = vec2(-wd.y, wd.x);
      vec2 q = vec2(dot(p, wd), dot(p, wp2));
      float foot = length(fwidth(p));               // 每像素的米数
      // 三个尺度的笔触，按像素足迹淡入淡出（远处只剩大笔、最后平涂）
      float s1 = strokes(q, vec2(1.7, 0.42), 1.0) * (1.0 - smoothstep(0.04, 0.12, foot));
      float s2 = strokes(q + 31.0, vec2(4.6, 1.15), 7.0) * (1.0 - smoothstep(0.12, 0.35, foot));
      float s3 = strokes(q + 77.0, vec2(13.0, 3.2), 3.0) * (1.0 - smoothstep(0.4, 1.4, foot));
      float st = s1 * 0.5 + s2 * 0.6 + s3 * 0.55;
      // 大块：暖黄晒干的一片 / 偏绿的一片（K2）
      float patchy = fbm2(p * 0.018 + 3.0);
      float warm = smoothstep(0.47, 0.62, patchy + 0.12 * (fbm2(p * 0.07) - 0.5));
      // 浪
      uWaveNear = 1.0 - smoothstep(0.06, 0.2, foot);
      float wv = meadowWave(p);
      float W = uWind.z > 0.0 ? clamp(0.3 + uWind.z * 1.4, 0.0, 1.0) : 0.0;
      float band = (smoothstep(0.3, 0.36, wv) * 0.55 + smoothstep(0.6, 0.66, wv) * 0.45) * W;
      // 叶片层的密度（和 GrassField 同一条曲线）：近处地面是草根下的暗部，远处是草面
      float dens = 1.0 - smoothstep(uMeadow.x, uMeadow.y, dist);
      float clr = 1.0;
      for(int i = 0; i < 4; i++){ vec4 c = uClear[i]; if(c.z > 0.0) clr = min(clr, smoothstep(c.z * 0.6, c.z, distance(p, c.xy))); }
      float under = dens * clr;
      float tone = 0.46 + 0.24 * st + 0.1 * (patchy - 0.5) + 0.32 * band * (1.0 - rain * 0.3);
      tone = mix(tone, 0.12 + 0.12 * st, under * 0.85);
      tone = floor(tone * 7.0 + 0.5) / 7.0;        // 画师的几档颜色
      vec3 c = pal4(uG[0], uG[1], uG[2], uG[3], tone);
      c = mix(c, mix(c, uG[3], 0.55), warm * (1.0 - under) * (1.0 - wet * 0.7));
      // 浪峰：晴天是浅黄绿（K4）；暴雨里是被压平的草叶背面，冷的银灰（K1b）
      vec3 crestC = mix(c * vec3(1.08, 1.1, 0.92) + vec3(0.03, 0.03, 0.0), c * vec3(1.0, 1.1, 1.2) + vec3(0.05, 0.06, 0.07), rain);
      c = mix(c, crestC, band * 0.6 * (1.0 - under));
      // 暴雨：被风压平的草一道道翻出灰白的背面，槽里是深的湿绿（K1b）
      float lum = dot(c, vec3(0.3, 0.55, 0.15));
      c = mix(c, mix(c * 0.7, vec3(lum) * vec3(1.25, 1.42, 1.5) + vec3(0.02, 0.03, 0.04), band), rain * (1.0 - under) * 0.8);
      // ---- 崖：陡坡是灰褐色岩壁，横向地层 + 竖向裂缝；崖顶 1–2 m 是悬出的草唇，下面挂着绿条
      float n2 = fbm2(vec2(p.x + p.y, vWorld.y) * 0.35);
      float steep = smoothstep(0.72, 0.5, N.y + (n2 - 0.5) * 0.25);
      float strata = fbm2(vec2((p.x - p.y) * 0.05, vWorld.y * 0.9));
      float crack = smoothstep(0.62, 0.7, fbm2(vec2((p.x - p.y) * 0.8, vWorld.y * 0.08)));
      float rt = 0.25 + 0.5 * strata + 0.3 * (dot(N, uSunDir) * 0.5) - 0.35 * crack;
      rt = floor(rt * 4.0 + 0.5) / 4.0;
      vec3 rock = pal4(uR[0], uR[1], uR[2], uR[3], rt);
      float drip = vEdge < 0.0 ? smoothstep(0.5, 0.75, fbm2(vec2((p.x - p.y) * 0.45, vWorld.y * 0.05)) + 0.25 * smoothstep(-12.0, -2.0, vEdge) - 0.15) : 0.0;
      rock = mix(rock, mix(uM[0], uM[1], step(0.5, n2)), drip * 0.85);
      c = mix(c, rock, steep);
      // 草唇：崖边那一条是草（不是岩），亮一档
      float lip = smoothstep(-2.2, -0.6, vEdge) * smoothstep(1.5, 0.0, vEdge);
      c = mix(c, mix(uG[1], uG[2], step(0.5, n2)), lip * steep * 0.9);
      // 海边湿岩
      c = mix(c, uR[0] * 0.9, smoothstep(uSea, 0.0, vWorld.y - uWaterLevel));
      c = meadowWeather(c, wet, rain);
      float lit;
      vec3 L = meadowLight(N, vWorld, lit);
      c *= L;
      // 雨后：湿地面在低太阳下的一层亮光（逆光方向）
      vec3 V = normalize(vWorld - cameraPosition);
      float glint = pow(max(dot(reflect(V, N), uSunDir), 0.0), 6.0) * wet * (1.0 - rain) * uSunStrength * (1.0 - steep * 0.5);
      c += uSunColor * glint * 0.18 * (0.6 + 0.4 * step(0.0, st));
      // 逆光看草面：草尖透光，整片泛金（K5）；晴天正午太阳高，几乎不起作用
      float bk = pow(max(dot(V, uSunDir), 0.0), 3.0) * (1.0 - steep) * uSunStrength * (1.0 - rain);
      c = mix(c, c * vec3(1.25, 1.18, 0.8) + uSunColor * vec3(0.10, 0.08, 0.02), bk * (0.55 + 0.25 * step(0.0, st)));
      #ifdef USE_PUDDLES
      float pud = puddleApply(c, vWorld, N);
      writeOut(c, 1.0, NV, vDepth, 0.0);
      if(pud > 0.5) oColor.a = 0.0;                                  // 水洼不吃 Kuwahara
      #else
      writeOut(c, 1.0, NV, vDepth, 0.0);
      #endif
    }
  `;
  const m = mat(u, vs, fs, o.puddles ? { defines: { USE_PUDDLES: '' } } : {});
  m.side = THREE.FrontSide;
  return m;
}

// ---------------------------------------------------------------- 岩石（草里卧着的灰岩、海里的礁石）
export function meadowRock(U, o = {}) {
  const P = o.palette ?? MEADOW;
  const u = base({ ...U, uR: { value: (o.boulder ? P.boulder : P.rock).map(C3) }, uM: { value: P.moss.map(C3) }, uMossK: { value: o.moss ?? 1 }, uSeed: { value: o.seed ?? 0 } });
  const vs = /* glsl */ `
    ${VERT_STD}
    void main(){ stdVertex(position, normal); }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    ${LIGHT}
    uniform vec3 uR[4], uM[2];
    uniform vec4 uMeadow;
    uniform float uMossK, uSeed;
    varying vec3 vWorld, vNormalW, vNormalV;
    varying float vDepth;
    varying vec2 vUv;
    void main(){
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 N = normalize(vNormalW), NV = normalize(vNormalV);
      if(!gl_FrontFacing){ N = -N; NV = -NV; }
      float wet = uMeadow.z, rain = uMeadow.w;
      vec3 p = vWorld + uSeed * 13.0;
      float lit;
      vec3 L = meadowLight(N, vWorld, lit);
      float n = fbm3(p * 0.9);
      float n2 = fbm3(p * 3.1 + 5.0);
      // 色阶：受光决定大关系，噪声切出“画上去”的块面
      float t = 0.2 + 0.5 * lit + 0.35 * (n - 0.5) + 0.4 * smoothstep(-0.2, 0.9, N.y);
      t = floor(t * 4.0) / 3.0;
      vec3 c = t < 0.34 ? uR[0] : t < 0.67 ? uR[1] : t < 0.99 ? uR[2] : uR[3];
      c = mix(c, uR[1], 0.0);
      // 地衣小点、深色凹坑
      c = mix(c, uR[3] * vec3(1.05, 1.04, 0.92), smoothstep(0.66, 0.7, n2) * 0.7);
      c = mix(c, uR[0], smoothstep(0.36, 0.3, n2) * 0.5);
      // 苔藓：顶面
      float mv = N.y * 0.55 + (n - 0.5) * 1.3 + (n2 - 0.5) * 0.4;
      float moss = smoothstep(0.75 - 0.45 * uMossK, 0.8 - 0.45 * uMossK, mv) * step(0.01, uMossK);
      c = mix(c, mix(uM[0], uM[1], step(0.45, lit * n2 + 0.2)), moss * 0.85);
      c = meadowWeather(c, wet, rain);
      c *= L;
      // 湿岩高光（K5）：雨后低太阳在岩石顶面上亮一片
      vec3 V = normalize(vWorld - cameraPosition);
      float sp = pow(max(dot(reflect(V, N), uSunDir), 0.0), 10.0);
      c += uSunColor * step(0.35, sp) * wet * (1.0 - rain * 0.7) * uSunStrength * 0.35;
      writeOut(c, 1.0, NV, vDepth, 0.0);
    }
  `;
  const m = mat(u, vs, fs);
  m.side = THREE.FrontSide;
  return m;
}

// ---------------------------------------------------------------- 叶片
// 一片叶 = 一条 NS 段的丝带（position.x = 沿叶 0..1，position.y = 横向 -1..1），每个实例一片叶。
// 实例属性：aP = (根 x, y, z, rank)，aQ = (自身倒向方位, 长, 宽, 种子)，aK = (种类, 色相, 柔软度, 初始倾角)
//   种类：0 叶片  1 羽状草穗  2 贴地短草  3 崖边草唇（朝外垂下去）
const NS = 9;
function bladeGeometry() {
  const pos = [], idx = [];
  for (let i = 0; i <= NS; i++) { const s = i / NS; pos.push(s, -1, 0, s, 1, 0); }
  for (let i = 0; i < NS; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export function bladeMaterial(U, o = {}) {
  const P = o.palette ?? MEADOW;
  const u = base({ ...U, uB: { value: P.blade.map(C3) }, uPl: { value: P.plume.map(C3) } });
  const vs = /* glsl */ `
    ${COMMON}
    ${WAVE}
    attribute vec4 aP, aQ, aK;
    uniform vec4 uMeadow, uPress[8];
    uniform vec2 uWDir;
    varying vec3 vWorld, vN;
    varying float vS, vSide, vWave, vHue, vKind, vDepth, vSeed, vClump;
    void main(){
      vec3 root = aP.xyz;
      float dist = distance(root, cameraPosition);
      float dens = 1.0 - smoothstep(uMeadow.x, uMeadow.y, dist);
      float keep = dens - aP.w;
      if(keep <= 0.0){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
      float kind = aK.x;
      float grow = smoothstep(0.0, 0.12, keep);
      float wid = aQ.z * min(inversesqrt(max(dens, 0.05)), 2.6);
      float L = aQ.y * mix(0.35, 1.0, grow);
      float lean0 = aK.w, flex = aK.z;
      vec2 own = vec2(cos(aQ.x), sin(aQ.x));
      float W = uWind.z, rain = uMeadow.w;
      float wv = meadowWave(root.xz);
      vec2 wd = W > 0.0 ? normalize(uWind.xy) : own;
      // 岬角上常年的海风：叶片整体顺同一风向压弯（K4 的“成片倒向同一侧”），大风与暴雨里更整齐
      float k = clamp(0.76 + W * 0.95 + rain * 0.5, 0.0, 0.985) * (kind > 2.5 ? 0.25 : 1.0);
      if(W <= 0.0) wd = normalize(uWDir);
      vec2 dirH = normalize(mix(own, wd, k) + vec2(1e-4, 0.0));
      // 弯曲：初始倾角 + 沿叶长线性增加的曲率（风越大、浪峰处越弯；雨里被压得更平）
      float B = (0.74 + W * (1.05 + 1.55 * wv) + rain * 0.85) * flex;
      B += sin(uDrawTime * 5.5 + aQ.w * 6.283 + dot(root.xz, wd) * 0.7) * 0.16 * W * flex;
      lean0 += (0.14 + W * 0.34 + rain * 0.42) * flex;
      if(kind > 0.5 && kind < 1.5) B = B * 1.18 + 0.42;                   // 草穗：穗头沉、顺风弯垂
      // 接触：被巨人压平（顺着离开压点的方向倒伏）
      for(int i = 0; i < 8; i++){
        vec4 pr = uPress[i];
        if(pr.w <= 0.0) continue;
        vec2 dd = root.xz - pr.xy;
        float r = length(dd);
        float f = (1.0 - smoothstep(pr.z * 0.55, pr.z, r)) * pr.w;
        if(f <= 0.0) continue;
        dirH = normalize(mix(dirH, dd / max(r, 1e-3), f) + vec2(1e-4, 0.0));
        lean0 = mix(lean0, 1.25, f);
        B = mix(B, 0.35, f);
        L *= 1.0 - 0.3 * f;
      }
      float th1 = min(lean0 + B, 2.3);
      B = th1 - lean0;
      float s = position.x;
      float th = lean0 + B * s;
      float h, v;
      if(abs(B) < 1e-3){ h = s * sin(lean0); v = s * cos(lean0); }
      else { h = (cos(lean0) - cos(th)) / B; v = (sin(th) - sin(lean0)) / B; }
      vec3 T = vec3(dirH.x * sin(th), cos(th), dirH.y * sin(th));
      // 丝带的宽度方向：一半跟着弯曲平面（真实），一半转向镜头（侧面看也不会变成一根线）+ 随机扭转
      vec3 sideH = vec3(-dirH.y, 0.0, dirH.x);
      vec3 toCam = cameraPosition - root; toCam.y = 0.0;
      vec3 sideV = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-4, 0.0, 0.0));
      sideV *= sign(dot(sideV, sideH) + 1e-4);
      vec3 side = normalize(mix(sideH, sideV, 0.55));
      float tw = (aQ.w - 0.5) * 1.6 + s * 0.5 * (aQ.w - 0.5);
      vec3 nrm0 = normalize(cross(side, T));
      side = normalize(side * cos(tw) + nrm0 * sin(tw));
      // 宽度轮廓
      float wp;
      if(kind > 0.5 && kind < 1.5){
        float hs = smoothstep(0.48, 0.60, s);
        float spindle = pow(max(sin(3.14159 * clamp((s - 0.50) / 0.50, 0.0, 1.0)), 0.0), 0.72);
        wp = mix(0.11, 4.2 * spindle, hs);
      } else {
        wp = pow(max(1.0 - s, 0.0), 0.75) * mix(0.75, 1.0, smoothstep(0.0, 0.12, s));
      }
      vec3 P = root + vec3(dirH.x * h * L, v * L, dirH.y * h * L) + side * position.y * 0.5 * wid * wp;
      vWorld = P;
      vN = normalize(cross(side, T));
      vClump = vnoise(root.xz * 0.55 + 11.0) * 0.6 + vnoise(root.xz * 2.1) * 0.4;
      vS = s; vSide = position.y; vWave = wv; vHue = aK.y; vKind = kind; vSeed = aQ.w;
      vec4 mv = viewMatrix * vec4(P, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    ${LIGHT}
    uniform vec3 uB[5], uPl[3];
    uniform vec4 uMeadow;
    varying vec3 vWorld, vN;
    varying float vS, vSide, vWave, vHue, vKind, vDepth, vSeed, vClump;
    vec3 pal5(float t){
      t = clamp(t, 0.0, 1.0) * 4.0;
      return t < 1.0 ? mix(uB[0], uB[1], t) : t < 2.0 ? mix(uB[1], uB[2], t - 1.0) : t < 3.0 ? mix(uB[2], uB[3], t - 2.0) : mix(uB[3], uB[4], t - 3.0);
    }
    void main(){
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      float wet = uMeadow.z, rain = uMeadow.w;
      bool plume = vKind > 0.5 && vKind < 1.5;
      if(plume && vS > 0.52){
        // 羽状穗：斜向上的连续芒刺小穗（手绘狗尾/芒草穗感，避免碎像素噪点）
        float u = (vS - 0.52) / 0.48;
        float fz = abs(vSide);
        float barb = 0.5 + 0.5 * sin((u * 24.0 - fz * 5.2) * 6.283 + vSeed * 19.0);
        float env = sin(3.14159 * clamp(u, 0.03, 0.98));
        if(fz > env * (0.46 + 0.54 * smoothstep(0.18, 0.78, barb))) discard;
      }
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 Nn = normalize(vN);
      if(dot(Nn, V) < 0.0) Nn = -Nn;
      vec3 Nl = normalize(mix(Nn, vec3(0.0, 1.0, 0.0), 0.35));
      float lit, lit2;
      vec3 L = meadowLight(Nl, vWorld, lit);
      vec3 L2 = meadowLight(normalize(mix(-Nn, vec3(0.0, 1.0, 0.0), 0.35)), vWorld, lit2);
      L = max(L, mix(L, L2, 0.55)); lit = max(lit, lit2 * 0.55);
      // 逆光：太阳在叶子背后 → 透光
      float back = max(dot(-V, uSunDir), 0.0);
      float W = uWind.z > 0.0 ? clamp(0.3 + uWind.z * 1.4, 0.0, 1.0) : 0.0;
      float crest = (smoothstep(0.3, 0.36, vWave) * 0.6 + smoothstep(0.6, 0.66, vWave) * 0.4) * W * (1.0 - rain * 0.4);
      vec3 c;
      if(plume && vS > 0.5){
        float t = 0.42 + 0.46 * lit + 0.2 * (vHue - 0.5) + 0.3 * crest + 0.25 * smoothstep(0.55, 0.95, vS);
        c = t < 0.42 ? uPl[0] : t < 0.74 ? uPl[1] : uPl[2];
      } else {
        // 一丛亮、一丛暗 + 叶尖迎光泛浅黄绿（K4 长叶片的浅亮叶尖）
        float tipLit = smoothstep(0.62, 0.98, vS) * (0.22 + 0.25 * crest) * (1.0 - rain * 0.6);
        float t = 0.0 + 0.52 * pow(vS, 0.72) + 0.34 * lit + 0.22 * (vHue - 0.5) + 0.45 * (vClump - 0.5) + 0.34 * crest + tipLit;
        if(vKind > 1.5 && vKind < 2.5) t = 0.25 + 0.35 * vS + 0.2 * lit + 0.2 * (vHue - 0.5);
        if(plume) t = 0.45 + 0.3 * lit + 0.1 * vHue;
        // 软的色阶：大部分是平的一档颜色，交界处有一点点过渡（画笔，不是赛璐璐）
        float tq = t * 5.0, tf = fract(tq);
        t = (floor(tq) + smoothstep(0.7, 1.0, tf)) / 5.0;
        c = pal5(t);
        // 叶片两色：中脉一侧略深（K4 的长叶片是“一边亮一边暗”）
        c *= mix(1.0, 0.86, step(vSide, -0.1) * (1.0 - lit * 0.5));
      }
      c = meadowWeather(c, wet, rain);
      c *= L;
      // 透光（逆光的叶片发黄绿）
      float thin = smoothstep(0.2, 0.9, vS);
      vec3 glow = mix(uB[3], uB[4], step(0.5, vClump)) * uSunColor * 1.15;
      c = mix(c, max(c, glow), pow(back, 2.5) * thin * uSunStrength * 0.75 * (1.0 - rain));
      // 湿亮边（K5）：叶缘一条亮线，逆光 + 湿时最亮；暴雨里是冷的灰白小亮边
      float edge = smoothstep(0.55, 0.95, abs(vSide));
      float rim = edge * thin * (pow(back, 1.5) * (0.35 + 0.9 * wet) * uSunStrength * (1.0 - rain) + rain * 0.25);
      c += mix(uSunColor * vec3(1.0, 0.9, 0.62), uSkyTint, rain) * rim * 0.55;
      // 雨后叶面上的水珠亮点
      float drop = step(0.985, hash12(floor(vec2(vS * 22.0, vSeed * 97.0 + vSide * 1.4)))) * wet * (1.0 - rain) * uSunStrength;
      c += uSunColor * drop * 0.6 * (0.4 + back);
      writeOut(c, 1.0, vec3(0.0, 0.0, 1.0), vDepth, 0.0);
    }
  `;
  return mat(u, vs, fs);
}

// ---------------------------------------------------------------- 草场：按地块懒生成
// o: { seed, cell = 8, density = 每平方米叶数, height(x,z), spot(x,z) → null | { k: 密度 0..1, len: 长度系数, kind?, dir?, lean? }, plume = 0.05 }
// update(camera)：生成相机周围 lod1 + margin 以内的地块；只有这些地块会画（防止“别的帧先生成了”带来的不确定）。
export class GrassField {
  constructor(U, o = {}) {
    this.U = U; this.o = o;
    this.cell = o.cell ?? 8;
    this.group = new THREE.Group();
    this.mat = bladeMaterial(U, o);
    this.base = bladeGeometry();
    this.chunks = new Map();
    this.margin = o.margin ?? 22;
    this._cam = new THREE.Vector3(1e9, 0, 0);
    this.onBeforeRender = null;   // (renderer, scene, camera) 每个地块渲染前调用（部门在这里填 uPress）
  }
  _gen(ix, iz) {
    const o = this.o, S = this.cell;
    const rng = new Rng(((o.seed ?? 1) * 73856093) ^ (ix * 19349663) ^ (iz * 83492791));
    const n = Math.round(S * S * (o.density ?? 36));
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = (ix + rng.next()) * S, z = (iz + rng.next()) * S;
      const r0 = rng.next(), r1 = rng.next(), r2 = rng.next(), r3 = rng.next(), r4 = rng.next(), r5 = rng.next(), r6 = rng.next();
      const sp = o.spot(x, z);
      if (!sp || r0 > sp.k) continue;
      let kind = sp.kind ?? 0;
      if (kind === 0 && r1 < (o.plume ?? 0.05) * (sp.plume ?? 1)) kind = 1;
      const len = (kind === 1 ? 1.15 + 0.55 * r2 : 0.42 + 0.85 * Math.pow(r2, 0.8)) * sp.len;
      const wid = kind === 1 ? 0.03 : (0.026 + 0.034 * r3) * (kind === 2 ? 0.7 : 1);
      const wAz = Math.atan2(this.U.uWDir.value.y, this.U.uWDir.value.x);
      const az = sp.dir != null ? sp.dir + (r4 - 0.5) * 0.9 : wAz + (r4 - 0.5) * 1.45;
      const lean = sp.lean ?? (0.16 + 0.44 * r5);
      const flex = kind === 2 ? 0.4 : 0.75 + 0.5 * r6;
      out.push([x, o.height(x, z), z, rng.next(), az, len, wid, rng.next(), kind, r3 * 0.5 + r6 * 0.5, flex, lean]);
    }
    out.sort((a, b) => a[3] - b[3]);
    const N = Math.max(1, out.length);
    const aP = new Float32Array(N * 4), aQ = new Float32Array(N * 4), aK = new Float32Array(N * 4);
    let y0 = Infinity, y1 = -Infinity;
    out.forEach((b, i) => { aP.set(b.slice(0, 4), i * 4); aQ.set(b.slice(4, 8), i * 4); aK.set(b.slice(8, 12), i * 4); y0 = Math.min(y0, b[1]); y1 = Math.max(y1, b[1]); });
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.base.index;
    g.setAttribute('position', this.base.attributes.position);
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(aP, 4));
    g.setAttribute('aQ', new THREE.InstancedBufferAttribute(aQ, 4));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(aK, 4));
    g.instanceCount = out.length;
    if (!out.length) { y0 = 0; y1 = 0; }
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3((ix + 0.5) * S, (y0 + y1) / 2 + 0.6, (iz + 0.5) * S), S * 0.75 + (y1 - y0) / 2 + 2);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(ix * S, y0, iz * S), new THREE.Vector3((ix + 1) * S, y1 + 2, (iz + 1) * S));
    const m = new THREE.Mesh(g, this.mat);
    m.matrixAutoUpdate = false;
    m.userData.noShadow = true;
    m.userData.ranks = out.map((b) => b[3]);
    m.userData.n = out.length;
    m.userData.c = [ix, iz];
    const self = this;
    m.onBeforeRender = function (renderer, scene, camera) {
      self.onBeforeRender?.(renderer, scene, camera);
      // 只画到“离相机最近的那一点”需要的 rank（排过序 → 二分）
      const [cx, cz] = this.userData.c;
      const dx = Math.max(cx * S - camera.position.x, 0, camera.position.x - (cx + 1) * S);
      const dz = Math.max(cz * S - camera.position.z, 0, camera.position.z - (cz + 1) * S);
      const dy = Math.max(0, camera.position.y - g.boundingBox.max.y - 1);
      const d = Math.hypot(dx, dz, dy);
      const U = self.U.uMeadow.value;
      const t = Math.min(1, Math.max(0, (d - U.x) / (U.y - U.x)));
      const dens = 1 - t * t * (3 - 2 * t);
      const r = this.userData.ranks;
      let lo = 0, hi = r.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (r[mid] < dens) lo = mid + 1; else hi = mid; }
      g.instanceCount = lo;
    };
    this.group.add(m);
    return m;
  }
  // 相机（部门 update 时的相机）周围的地块：生成、显示；其余隐藏
  update(camera) {
    const S = this.cell, R = this.U.uMeadow.value.y + this.margin;
    const p = camera.position;
    const x0 = Math.floor((p.x - R) / S), x1 = Math.floor((p.x + R) / S);
    const z0 = Math.floor((p.z - R) / S), z1 = Math.floor((p.z + R) / S);
    const want = new Set();
    // 高机位（大远景）离地面远：叶片层整个不需要
    const gy = this.o.height(p.x, p.z);
    if (p.y - gy < this.U.uMeadow.value.y) {
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
        const dx = Math.max(ix * S - p.x, 0, p.x - (ix + 1) * S), dz = Math.max(iz * S - p.z, 0, p.z - (iz + 1) * S);
        if (Math.hypot(dx, dz) > R) continue;
        const key = ix + ',' + iz;
        want.add(key);
        if (!this.chunks.has(key)) this.chunks.set(key, this._gen(ix, iz));
      }
    }
    for (const [key, m] of this.chunks) m.visible = want.has(key);
    // 缓存上限：太多就扔掉不需要的（内容是确定的，扔了下次再生成也一样）
    if (this.chunks.size > 900) for (const [key, m] of this.chunks) if (!want.has(key)) { this.group.remove(m); m.geometry.dispose(); this.chunks.delete(key); }
  }
}
