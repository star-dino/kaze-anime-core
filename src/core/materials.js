import * as THREE from 'three';
import { G, COMMON, MRT_OUT, VERT_STD, INK_TAB, PUDDLE_GLSL } from './glsl.js';
import { screen } from './color.js';

const SHADE_REF = '#a6b1e2';      // summer 调色板的 shadeTint：celMaterial({ shade }) 在这个光下正好等于设定的暗部色

// 材质库。所有“场景材质”都必须走 writeOut()（MRT 协议），并处理三种 uPass：
//   uPass 1（阴影）：写任意值即可；uPass 2（反射）：丢弃水面以下；uPass 0：正常。

export const base = (extra) => ({ ...G, ...extra });
const col = (c) => new THREE.Color(c);

export function mat(uniforms, vertexShader, fragmentShader, opts = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader,
    side: opts.side ?? THREE.DoubleSide, transparent: false, ...opts,
  });
}

// ===================================================================== 赛璐璐（角色）
// 两个硬色阶 + 冷色暗部 + 极少数“第三深色” + 阶跃高光 + 逆光边缘光。
// 污渍噪声取“物体局部坐标”，所以角色动起来污渍粘在装甲上不会游走
// （原作用 aRest = 静止姿态下的顶点坐标，效果相同、适用于蒙皮/IK 后的部件）。
//   o: { color, id, gloss, wear, wearScale, emissive, emis,
//        rest, pattern, colors, uniforms, name }
//
// 花纹（来自原作 kf3d-geo.js 的 kfMaterial，这里做成 celMaterial 的正式选项，不再靠字符串替换）：
//   pattern: GLSL 源码，必须定义  vec4 pattern(vec3 p, vec3 n)
//            p / n = 静止空间的位置 / 法线；返回 rgb = 这一点的固有色，a = “不受光”的比例
//            （0 = 正常赛璐璐受光；1 = 平涂原色，用于眼睛高光、墨线、腮红一类“画上去的”标记）。
//            色块在着色器里按坐标算出来 → 分辨率无关、边缘锐利，而且同一个材质 id 内部不会出描线
//            （肚皮和背的交界没有黑线，这正是动画设定的画法）。
//   colors:  { cName: '#hex' } → uniform vec3（线性，与 uColor 一致）
//   uniforms:{ uName: 数值 | Vector | {value} } → 对应类型的 uniform（传 {value} 对象可在多个材质间共享）
//   rest:    true = 几何体带 aRest / aRestN（SoftBody 蒙皮网格）。污渍和花纹读静止坐标，动起来不游走；
//            false = 读顶点局部坐标（刚体零件，效果相同）。
//
// 角色明暗（2026-11 内核需求 R1，三项都不给时与旧行为逐像素一致）：
//   shadeProxy: { center:[x,y,z], r: 半径 | [rx,ry,rz], k: 0..1 }   刚体零件的“明暗法线代理”（物体局部坐标）。
//            受光用的法线 = mix(真实法线, 代理椭球在这一点的外法线, k)；k = 1 时整个零件像一个光滑的球/椭球那样受光，
//            小起伏（眼窝、鼻梁、颧骨）不再切出乱扭的明暗线。描线、边缘光、投影偏移仍用真实法线。
//   shadeNormal: true   几何体自带 aShadeN（SoftBody.shadeProxy() + build() 生成，随蒙皮一起动）：
//            SoftBody 的代理按骨骼指定，代理中心跟着骨骼走，脖子处按蒙皮权重平滑过渡。
//   shade:   '#hex'（屏幕色）  单层阴影色：暗部直接是这个颜色（内部过 screen()），没有反弹光渐变、没有第三色。
//            它是 shadeBase（默认 = color）那块颜色的暗部；pattern 画出的其他色块按同一比例变暗（下巴浅色区在暗部也比身体浅）。
//            shadeFollow（默认 1）：暗部随 look 的 shadeTint 变化（金色傍晚暗部跟着变暖）；在 summer 调色板下正好等于 shade。
//            shadeVolume: true  保留反弹光（up）和背光朝下面的第三层深暗部（deep），兼具自定义暗部色与立体体积感。
//            sunTint: 0..1      受光面吃太阳/天光染色的比例（默认 1；白装甲设 0.2–0.3 可避免盛夏暖阳把白漆染成米黄）。
//            pattern 里可以给某块颜色指定它自己的暗部：赋值全局变量 gShade（管线色，例如 gShade = cChinShade;）。
//            不赋值（gShade.x < 0）就用上面的比例。浅色块（下巴、肚皮）按比例变暗容易发紫发灰，最好显式给。
//   receiveShadow: false   不接收角色投影（阴影图）。用了明暗代理的脸要关掉：代理说“这里受光”，
//            真实几何却把自己的影子投在脸上 → 脸上横一道直的硬影（story.shadowFix 打开后才会出现）。默认 true。
//   ink:     '#hex'（屏幕色）  这个材质 id 的描线颜色（写进 INK_TAB，按 id 查表；同一 id 后写的覆盖先写的）。
//   inkWeight: 0.55..2.5（K3）这个材质 id 的描线粗细倍数（同样按 id 查表）：巨人身上的面板线比外轮廓细就给 0.6–0.8。
//   transmit: 0..1（W6）逆光透亮：太阳在背后时叠一层暖色透射光（花瓣、叶片、薄布）；transmitColor '#hex'（屏幕色，默认 #ffe6a8）。
//
// 表面细节（2026-11 内核需求 K1 / K2，都不给时与旧行为逐像素一致；移植 / 扩展自 Sunshower 的 celMaterial）：
//   weather: { patch, chip, rust, stain, scale = 1, seed = 0 }（各 0..1）+ 颜色（屏幕色，内部过 screen()）：
//            primer / primerShade（底漆斑及其暗部）、rust、metal（掉漆露出的金属）。坐标取物体局部（或 aRest），零件动起来不游走。
//     patch  大块硬边的底漆斑（迷彩 / 岛屿形状、大小悬殊）—— The Moss Keeper 那种“掉了一大片漆”的画法
//     chip   小块掉漆：露出深色金属 + 一圈浅色底漆边
//     rust   锈：长在底漆斑边缘，另有沿 -Y 往下流的锈痕
//     stain  深一档、偏紫的污渍大斑（比 wear 大、硬）
//     scale  噪声频率（× 每米）：9 m 的巨人用 0.6–1，1 m 以下的小东西用 3–6；seed 让相同零件花纹不同
//   map:     贴图（按几何体 uv，画布按 sRGB 解码：画 screen('#hex') 上屏就是 #hex）：rgb 按 a 盖到固有色上；mapCut: true = a < 0.5 的地方挖空（贴花平面用）
//   det:     [{ tex, axis: 0|1|2, sign: ±1, rect: [cu, cv, w, h] }]（最多 2 个）沿局部轴投影的贴花：
//            面板线、编号、条纹包在弯曲的装甲上。rect 是投影平面上的中心和宽高（局部单位，米）。
//            axis 0 = 从 ±X 看（平面坐标 (-z·sign, y)），1 = 从 ±Y 看（(x, -z·sign)），2 = 从 ±Z 看（(x·sign, y)）。
export function celMaterial(o = {}) {
  const u = base({
    uColor: { value: col(o.color ?? '#eef0f4') },
    uId: { value: o.id ?? 1 },
    uGloss: { value: o.gloss ?? 1 },
    uWear: { value: o.wear ?? 0.6 },
    uWearScale: { value: o.wearScale ?? 1.2 },
    uEmissive: { value: col(o.emissive ?? '#000000') },
    uEmis: { value: o.emis ?? 0 },
  });
  const defines = {};
  if (o.shadeProxy) {
    const P = o.shadeProxy, r = Array.isArray(P.r) ? P.r : [P.r ?? 1, P.r ?? 1, P.r ?? 1];
    u.uProxyC = { value: new THREE.Vector3(...P.center) };
    u.uProxyR = { value: new THREE.Vector3(...r) };
    u.uProxyK = { value: P.k ?? 1 };
    defines.USE_SHADEPROXY = '';
  } else if (o.shadeNormal) defines.USE_SHADEN = '';
  if (o.shade) {
    const a = col(screen(o.shade)), b = col(screen(o.shadeBase ?? o.color ?? '#eef0f4'));
    u.uShadeRatio = { value: new THREE.Vector3(a.r / Math.max(b.r, 1e-4), a.g / Math.max(b.g, 1e-4), a.b / Math.max(b.b, 1e-4)) };
    u.uShadeRef = { value: col(SHADE_REF) };
    u.uShadeFollow = { value: o.shadeFollow ?? 1 };
    defines.USE_SHADE = '';
    if (o.shadeVolume) defines.SHADE_VOLUME = '';
  }
  if (o.sunTint !== undefined) {
    u.uSunTint = { value: o.sunTint };
    defines.USE_SUNTINT = '';
  }
  if (o.ink || o.inkWeight) {
    const id = o.id ?? 1, T = INK_TAB.value[id];
    if (id >= 1 && id < 100) {
      if (o.ink) { const c = col(screen(o.ink)); T.set(c.r, c.g, c.b, T.w > 0 ? T.w : 1); }
      else if (T.w <= 0) T.set(-1, -1, -1, 1);                      // 只设粗细：颜色标记为“用默认墨色”
      if (o.inkWeight) T.w = o.inkWeight;
    }
  }
  const decl = [];
  for (const [k, v] of Object.entries(o.colors ?? {})) { u[k] = { value: col(v) }; decl.push(`uniform vec3 ${k};`); }
  for (const [k, v] of Object.entries(o.uniforms ?? {})) {
    u[k] = v && v.value !== undefined ? v : { value: v };
    const val = u[k].value;
    const ty = typeof val === 'number' ? 'float' : val.isColor ? 'vec3' : val.isMatrix3 ? 'mat3' : val.isVector4 ? 'vec4' : val.isVector3 ? 'vec3' : val.isVector2 ? 'vec2' : 'float';
    decl.push(`uniform ${ty} ${k};`);
  }
  if (o.weather) {
    const w = o.weather, sc = (h) => col(screen(h));
    u.uWeather = { value: new THREE.Vector4(w.patch ?? 0, w.chip ?? 0, w.rust ?? 0, w.stain ?? 0) };
    u.uWScale = { value: w.scale ?? 1 };
    u.uWSeed = { value: new THREE.Vector3(w.seed ?? 0, (w.seed ?? 0) * 1.7, (w.seed ?? 0) * 2.3) };
    u.uPrimer = { value: sc(o.primer ?? '#efcf9f') };
    u.uPrimerShade = { value: sc(o.primerShade ?? '#c9a77e') };
    u.uRust = { value: sc(o.rust ?? '#7a3b2c') };
    u.uMetal = { value: sc(o.metal ?? '#4a4552') };
    defines.USE_WEATHER = '';
    if (w.edge) defines.USE_EDGE_WEATHER = '';
  }
  if (o.wet !== undefined) {
    u.uWet = o.wet && o.wet.value !== undefined ? o.wet : { value: o.wet };
    const wr = o.wetRain ?? 0;
    u.uWetRain = wr && wr.value !== undefined ? wr : { value: wr };
    u.uWetScale = { value: o.wetScale ?? 0.02 };
    defines.USE_WET = '';
  }
  if (o.transmit) {
    u.uTransmit = { value: o.transmit };
    u.uTransmitColor = { value: col(screen(o.transmitColor ?? '#ffe6a8')) };
    defines.USE_TRANSMIT = '';
  }
  if (o.map) {
    u.uMap = { value: o.map };
    defines.USE_MAP = '';
    if (o.mapCut) defines.MAP_CUT = '';
  }
  if (o.det?.length) {
    o.det.slice(0, 2).forEach((d, i) => {
      u['uDet' + i] = { value: d.tex };
      u['uDet' + i + 'P'] = { value: new THREE.Vector2(d.axis ?? 2, d.sign ?? 1) };
      u['uDet' + i + 'R'] = { value: new THREE.Vector4(...(d.rect ?? [0, 0, 1, 1])) };
    });
    defines.USE_DET = String(Math.min(2, o.det.length));
  }
  if (o.rest) defines.USE_REST = '';
  if (o.receiveShadow === false) defines.NO_SHADOW_RECV = '';
  if (o.pattern) defines.USE_PATTERN = '';
  const vs = /* glsl */ `
    #ifdef USE_REST
    attribute vec3 aRest;
    attribute vec3 aRestN;
    #endif
    varying vec3 vLocal;
    varying vec3 vLocalN;
    #ifdef USE_EDGE_WEATHER
    attribute float aEdge;
    varying float vEdge;
    #endif
    #if defined(USE_SHADEN) || defined(USE_SHADEPROXY)
    varying vec3 vShadeW;
    #endif
    #ifdef USE_SHADEN
    attribute vec3 aShadeN;
    #endif
    #ifdef USE_SHADEPROXY
    uniform vec3 uProxyC, uProxyR;
    uniform float uProxyK;
    #endif
    ${VERT_STD}
    void main(){
      #ifdef USE_REST
      vLocal = aRest; vLocalN = aRestN;
      #else
      vLocal = position; vLocalN = normal;
      #endif
      #ifdef USE_EDGE_WEATHER
      vEdge = aEdge;
      #endif
      stdVertex(position, normal);
      #if defined(USE_SHADEN) || defined(USE_SHADEPROXY)
      #ifdef USE_SHADEN
      vec3 sn = aShadeN;
      #else
      vec3 sn = normalize(mix(normal, normalize((position - uProxyC) / (uProxyR * uProxyR)), uProxyK));
      #endif
      vShadeW = normalize(transpose(mat3(viewMatrix)) * normalize(normalMatrix * sn));
      #endif
    }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    uniform vec3 uColor, uEmissive;
    uniform float uId, uGloss, uWear, uWearScale, uEmis;
    ${decl.join('\n    ')}
    varying vec3 vWorld, vNormalW, vNormalV, vLocal, vLocalN;
    varying float vDepth;
    varying vec2 vUv;
    #if defined(USE_SHADEN) || defined(USE_SHADEPROXY)
    varying vec3 vShadeW;
    #endif
    #ifdef USE_SHADE
    uniform vec3 uShadeRatio, uShadeRef;
    uniform float uShadeFollow;
    #endif
    #ifdef USE_SUNTINT
    uniform float uSunTint;
    #endif
    vec3 gShade = vec3(-1.0);          // pattern 可赋值：这一点的暗部色（只在 shade 选项打开时生效）
    #ifdef USE_WEATHER
    uniform vec4 uWeather;
    uniform float uWScale;
    uniform vec3 uWSeed, uPrimer, uPrimerShade, uRust, uMetal;
    #ifdef USE_EDGE_WEATHER
    varying float vEdge;
    #endif
    #endif
    #ifdef USE_WET
    uniform float uWet, uWetRain, uWetScale;
    #endif
    #ifdef USE_TRANSMIT
    uniform float uTransmit;
    uniform vec3 uTransmitColor;
    #endif
    #if defined(USE_MAP) || defined(USE_DET)
    // 画布贴图按 sRGB 存：解码成线性，和 celMaterial 的 color（THREE.Color 线性化后的 hex）同一套规则 ——
    // 画布上画 screen('#hex') 的颜色，上屏就是 #hex
    vec4 texLin(vec4 t){ return vec4(mix(t.rgb / 12.92, pow((t.rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, t.rgb)), t.a); }
    #endif
    #ifdef USE_MAP
    uniform sampler2D uMap;
    #endif
    #ifdef USE_DET
    uniform sampler2D uDet0, uDet1;
    uniform vec2 uDet0P, uDet1P;
    uniform vec4 uDet0R, uDet1R;
    // 沿局部轴投影的贴花（Sunshower projDecal）：只贴在朝向投影方向的面上（|n·axis| > 0.25）
    vec4 projDecal(sampler2D t, vec2 P, vec4 R){
      int ax = int(P.x + 0.5); float sg = P.y;
      vec3 ln = normalize(vLocalN); vec3 lp = vLocal;
      float face = ax == 0 ? ln.x : (ax == 1 ? ln.y : ln.z);
      if(face * sg < 0.25) return vec4(0.0);
      vec2 q = ax == 0 ? vec2(-lp.z * sg, lp.y) : (ax == 2 ? vec2(lp.x * sg, lp.y) : vec2(lp.x, -lp.z * sg));
      vec2 uv = (q - R.xy) / R.zw + 0.5;
      if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
      return texLin(texture(t, uv));
    }
    #endif
    ${o.pattern ?? ''}
    void main(){
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      #ifdef USE_MAP
      vec4 mapT = texLin(texture(uMap, vUv));
      #ifdef MAP_CUT
      if(mapT.a < 0.5) discard;
      #endif
      #endif
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 N = normalize(vNormalW), NV = normalize(vNormalV);
      if(!gl_FrontFacing){ N = -N; NV = -NV; }
      vec3 Ns = N;                                                     // 受光用的法线（明暗代理）
      #if defined(USE_SHADEN) || defined(USE_SHADEPROXY)
      Ns = normalize(vShadeW);
      if(!gl_FrontFacing) Ns = -Ns;
      #endif
      vec3 c = uColor;
      float unlit = 0.0;
      #ifdef USE_PATTERN
      vec4 pat = pattern(vLocal, normalize(vLocalN));
      c = pat.rgb; unlit = pat.a;
      #endif
      // ---- 硬边污渍：暗一档、偏紫，永远不是灰脏
      vec3 r = vLocal * uWearScale;
      c = mix(c, c * vec3(0.86, 0.85, 0.93), step(0.63, fbm3(r * 0.85 + 3.1)) * uWear);
      float scuff = step(0.8, vnoise3(r * 26.0 + 2.0)) * step(0.55, fbm3(r * 3.0));
      c = mix(c, c * vec3(0.84, 0.83, 0.9), scuff * uWear * 0.8);
      #ifdef USE_WEATHER
      {
        vec3 wp = vLocal * uWScale + uWSeed;
        // 污渍：深一档偏紫的大斑（先上，底漆斑会盖掉一部分）
        float st = step(mix(0.66, 0.52, uWeather.w), fbm3(wp * 1.3 + 5.0)) * step(0.001, uWeather.w);
        c *= mix(vec3(1.0), vec3(0.8, 0.78, 0.9), st);
        if(gShade.x >= 0.0) gShade *= mix(vec3(1.0), vec3(0.84, 0.82, 0.92), st);
        // 底漆斑：域扭曲的 fbm 取阈值 → 硬边、岛屿形状、大小悬殊；再撒一点小碎斑
        vec3 q = wp + (vec3(fbm3(wp * 0.7 + 1.3), fbm3(wp * 0.7 + 7.1), fbm3(wp * 0.7 + 3.7)) - 0.5) * 1.1;
        float f = fbm3(q * 0.9) + 0.16 * (vnoise3(q * 5.0) - 0.5);
        float thr = mix(0.66, 0.42, uWeather.x);                             // fbm3 均值约 0.47、标准差约 0.09：0.5 → 约三成面积
        float on = step(0.001, uWeather.x);
        float pa = step(thr, f) * on;
        float bits = step(0.86, vnoise3(wp * 7.0 + 3.0)) * step(thr - 0.12, f) * on;
        pa = max(pa, bits);
        float pst = step(0.6, fbm3(wp * 2.2 + 9.0)) * 0.5;                     // 底漆斑上也有一点旧污痕
        vec3 prim = uPrimer * mix(vec3(1.0), vec3(0.9, 0.86, 0.84), pst);
        c = mix(c, prim, pa);
        if(pa > 0.5) gShade = uPrimerShade * mix(vec3(1.0), vec3(0.9, 0.86, 0.84), pst);
        // 小块掉漆：深色金属 + 浅色底漆边（Sunshower 的 chip / rim）
        #ifdef USE_EDGE_WEATHER
        float eMask = smoothstep(0.45, 0.92, vEdge);
        float eRun = smoothstep(0.18, 0.85, vEdge);
        float cc = (fbm3(wp * 6.2 + 11.0) + 0.25 * vnoise3(wp * 24.0)) * step(0.02, eMask) + eMask * 0.05;
        #else
        float cc = fbm3(wp * 5.5 + 11.0) + 0.25 * vnoise3(wp * 22.0);
        #endif
        float ct = 0.9 - 0.12 * uWeather.y;
        float onc = step(0.001, uWeather.y);
        float chip = step(ct, cc) * onc;
        float rim = step(ct - 0.035, cc) * (1.0 - chip) * onc;
        c = mix(c, uPrimer, rim);
        if(rim > 0.5) gShade = uPrimerShade;
        c = mix(c, uMetal, chip);
        if(chip > 0.5) gShade = uMetal * 0.72;
        // 锈：底漆斑边缘的一圈锈块 + 沿 -Y 往下流的锈痕
        float onr = step(0.001, uWeather.z);
        float rimR = step(thr - 0.06, f) * (1.0 - step(thr, f)) * step(0.42, vnoise3(wp * 6.0 + 2.0)) * onr * on;   // 只有底漆斑存在时才有边缘锈
        float runs = step(mix(0.8, 0.6, uWeather.z), fbm3(vec3(wp.x * 6.0, wp.y * 0.55, wp.z * 6.0) + 7.0)) * step(0.45, fbm3(wp * 2.0)) * onr;
        float blot = step(mix(0.8, 0.6, uWeather.z), fbm3(wp * 2.6 + 13.0)) * onr;
        #ifdef USE_EDGE_WEATHER
        runs *= eRun;
        blot *= eMask;
        #endif
        float ru = max(max(rimR, runs), blot);
        c = mix(c, uRust, ru);
        if(ru > 0.5) gShade = uRust * 0.7;
      }
      #endif
      #ifdef USE_MAP
      c = mix(c, mapT.rgb, mapT.a);
      #endif
      #ifdef USE_DET
      { vec4 d0 = projDecal(uDet0, uDet0P, uDet0R); c = mix(c, d0.rgb, d0.a); if(d0.a > 0.5 && gShade.x >= 0.0) gShade = mix(gShade, d0.rgb * 0.7, d0.a); }
      #if USE_DET > 1
      { vec4 d1 = projDecal(uDet1, uDet1P, uDet1R); c = mix(c, d1.rgb, d1.a); if(d1.a > 0.5 && gShade.x >= 0.0) gShade = mix(gShade, d1.rgb * 0.7, d1.a); }
      #endif
      #endif
      #ifdef USE_WET
      float wetRiv = 0.0, wetBead = 0.0;
      if(uWet > 0.001){
        vec3 wp2 = vLocal * uWetScale;
        float tqW = floor(uDrawTime * 4.0) * 0.22 * step(0.02, uWetRain);
        float sideFace = clamp(1.15 - abs(N.y), 0.0, 1.0);
        float rv = fbm3(vec3(wp2.x * 7.2, wp2.y * 0.48 + tqW, wp2.z * 7.2) + 19.0);
        wetRiv = step(0.64, rv) * sideFace * uWet;
        wetBead = step(0.962, vnoise3(wp2 * 26.0 + 4.3)) * smoothstep(-0.2, 0.55, N.y) * uWet * (1.0 - 0.55 * uWetRain);
        vec3 wetMul = mix(vec3(1.0), vec3(0.79, 0.83, 0.91), uWet * (0.82 + 0.28 * wetRiv));
        c *= wetMul;
        if(gShade.x >= 0.0) gShade *= mix(vec3(1.0), vec3(0.75, 0.80, 0.89), uWet * (0.85 + 0.22 * wetRiv));
      }
      #endif

      // ---- 光照：两个硬色阶（smoothstep 极窄 = 赛璐璐的分界线）
      float ndl = dot(Ns, uKeyDir);
      #ifdef NO_SHADOW_RECV
      float lit = smoothstep(-0.03, 0.05, ndl);
      #else
      float lit = smoothstep(-0.03, 0.05, ndl) * sunShadow(vWorld, N);
      #endif
      #ifdef USE_SUNTINT
      vec3 litCol = c * mix(vec3(1.0), mix(uSkyTint, uSunColor * 1.06, uSunStrength), uSunTint);
      #else
      vec3 litCol = c * mix(uSkyTint, uSunColor * 1.06, uSunStrength);
      #endif
      #ifdef USE_SHADE
      // 单层阴影色：一块平涂的暗部（随 look 的 shadeTint 冷暖变化）
      vec3 shadeCol = (gShade.x >= 0.0 ? gShade : c * uShadeRatio) * mix(vec3(1.0), uShadeTint / max(uShadeRef, vec3(1e-4)), uShadeFollow);
      #ifdef SHADE_VOLUME
      float up = smoothstep(-0.7, 0.6, Ns.y);
      vec3 shadeB = shadeCol * mix(uBounce, vec3(1.0), up);
      vec3 outc = mix(mix(shadeB, litCol, 0.08), litCol, lit);
      float deep = step(ndl, -0.55) * step(Ns.y, -0.35);
      outc = mix(outc, shadeCol * (uDeepTint / max(uShadeTint, vec3(1e-4))), deep * 0.85);
      #else
      vec3 outc = mix(shadeCol, litCol, lit);
      #endif
      #else
      float up = smoothstep(-0.7, 0.6, Ns.y);
      vec3 shadeCol = c * uShadeTint * mix(uBounce, vec3(1.0), up);    // 暗部朝下的面吃反弹光
      vec3 outc = mix(mix(shadeCol, litCol, 0.12), litCol, lit);
      float deep = step(ndl, -0.55) * step(Ns.y, -0.35);               // 第三色：只在背光且朝下的面
      outc = mix(outc, c * uDeepTint, deep * 0.85);
      #endif

      // ---- 阶跃高光 + 逆光边缘光
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 H = normalize(uKeyDir + V);
      float spec = step(0.985, dot(Ns, H)) * lit * uGloss;
      outc = mix(outc, mix(vec3(1.0), uSunColor, 0.3) * 1.04, spec * (0.55 + 0.4 * uSunStrength));
      float fres = 1.0 - max(dot(N, V), 0.0);
      float back = smoothstep(0.1, 0.5, dot(-V, uSunDir));
      float rimL = smoothstep(0.68, 0.72, fres) * smoothstep(-0.05, 0.15, ndl) * back * uSunStrength;
      outc = mix(outc, uSunColor * 1.15, rimL * 0.85);
      #ifdef USE_TRANSMIT
      // W6 逆光透亮（花瓣、叶片、薄布、耳廓）：太阳在物体背后时，朝镜头这面整块透出一层暖光。
      // 两档硬边（赛璐璐的画法，不是 SSS 渐变）：背光的暗部最亮（光从背面透过来），受光面只淡淡叠一点。
      {
        float behind = smoothstep(0.05, 0.45, dot(-V, uSunDir)) * uSunStrength * cloudShade(vWorld);
        float through = step(0.18, behind) * (1.0 - 0.55 * lit) + step(0.6, behind) * 0.25;
        vec3 glowC = c * uTransmitColor * mix(vec3(1.0), uSunColor, 0.6) * 1.18 + uTransmitColor * 0.06;
        outc = mix(outc, max(outc, glowC), clamp(through * uTransmit, 0.0, 1.0));
      }
      #endif
      #ifdef USE_WET
      if(uWet > 0.001){
        vec3 wetHiC = mix(uSkyTint * 0.96 + vec3(0.06, 0.08, 0.12), uSunColor * 1.24, clamp(uSunStrength * (0.35 + 0.65 * back), 0.0, 1.0));
        float wetSpec = step(0.945, dot(Ns, H)) * (0.35 + 0.65 * lit) * uWet;
        float wetEdge = smoothstep(0.60, 0.66, fres) * smoothstep(-0.18, 0.45, N.y) * uWet;
        float rivHi = wetRiv * step(0.55, dot(N, H)) * 0.55;
        outc = mix(outc, wetHiC, clamp(wetSpec * 0.55 + wetEdge * 0.48 + rivHi + wetBead * 0.75, 0.0, 0.88));
      }
      #endif
      // ---- 局部暖光（灯笼等）：两档硬色阶。用 max 而不是相加：被灯照到的地方“变成”灯色下的固有色，
      //      不会在本来就亮的面上叠爆（夜里角色大部分在暗部，max 正好把灯照的那块提亮）
      vec3 lampL = lampLight(vWorld, N, 0.15, 1.0);
      outc = max(outc, c * lampL) + c * lampL * 0.08;

      // ---- 画上去的标记（眼睛高光、墨线、腮红）：平涂原色，不吃明暗
      outc = mix(outc, c, clamp(unlit, 0.0, 1.0));
      // ---- 自发光（> 1.05 才进泛光）
      outc = mix(outc, uEmissive * (1.0 + 2.0 * uEmis), clamp(uEmis, 0.0, 1.0));
      writeOut(outc, 1.0, NV, vDepth, uId);
    }
  `;
  const m = mat(u, vs, fs, { defines });
  if (o.name) m.name = o.name;
  return m;
}

// ===================================================================== 绘画背景
// 柔和明暗交界 + 薰衣草色暗部 + 天光 + 贴水反弹光（原作 bgmaterials.js 的 PAINT_LIGHT）。
// 颜色用世界坐标 fbm 在 color / color2 之间做“色块”（posterize 成几档），再交给 Kuwahara 出笔触。
//   o: { color, color2, scale, steps, id (默认 0 = 绘画), rock (陡坡自动换成岩石色), sand (贴水一圈沙色) }
//   puddles: true（W10）平地上长出硬边水洼（倒映三档天色 + 太阳亮点 + 远边亮水沿 + 雨环），覆盖量由 look.puddles 控制
//            （见 glsl.js PUDDLE_GLSL）。不给 = 与旧版逐像素一致
const PAINT_LIGHT = /* glsl */ `
vec3 paintLight(vec3 c, vec3 N, vec3 wp){
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.03, 0.15, ndl) * sunShadow(wp, N);
  float up = smoothstep(-0.6, 0.9, N.y);
  vec3 amb = mix(uShadeTint, uSkyTint, up * 0.45 + 0.22) * 0.92;
  amb += uBounce * exp(-max(wp.y - uWaterLevel, 0.0) / 7.0) * (1.0 - up) * 0.2 * uSunStrength;
  vec3 sun = uSunColor * 0.46 * lit * uSunStrength;     // 高调：受光面落在“接近白”，不爆
  vec3 base = amb * (1.0 - 0.12 * lit) + sun;
  vec3 lampL = lampLight(wp, N, 0.3, 0.0);
  return c * (max(base, lampL) + lampL * 0.06);
}
`;
export function paintMaterial(o = {}) {
  const u = base({
    uColor: { value: col(o.color ?? '#7fbf5a') },
    uColor2: { value: col(o.color2 ?? o.color ?? '#5d9c4a') },
    uScale: { value: o.scale ?? 0.08 },
    uSteps: { value: o.steps ?? 3 },
    uId: { value: o.id ?? 0 },
    uRock: { value: col(o.rock ?? '#000000') }, uRockK: { value: o.rock ? 1 : 0 },
    uSand: { value: col(o.sand ?? '#000000') }, uSandK: { value: o.sand ? 1 : 0 },
  });
  // windSheen（W1）：草地上随风扫过的亮带（和植物的草浪同一个波场）。不给 = 与旧版逐像素一致
  const defs = {};
  if (o.windSheen) { u.uSheen = { value: o.windSheen }; defs.USE_WIND_SHEEN = ''; }
  if (o.puddles) defs.USE_PUDDLES = '';
  const vs = /* glsl */ `
    ${VERT_STD}
    void main(){ stdVertex(position, normal); }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    ${PAINT_LIGHT}
    #ifdef USE_PUDDLES
    ${PUDDLE_GLSL}
    #endif
    uniform vec3 uColor, uColor2, uRock, uSand;
    uniform float uScale, uSteps, uId, uRockK, uSandK;
    #ifdef USE_WIND_SHEEN
    uniform float uSheen;
    #endif
    varying vec3 vWorld, vNormalW, vNormalV;
    varying float vDepth;
    varying vec2 vUv;
    void main(){
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 N = normalize(vNormalW), NV = normalize(vNormalV);
      if(!gl_FrontFacing){ N = -N; NV = -NV; }
      // 大色块 + 近处的小色块（近景不至于是一整片平涂）
      float f = fbm3(vWorld * uScale) + 0.45 * (fbm3(vWorld * uScale * 9.0 + 7.0) - 0.5) * smoothstep(60.0, 8.0, vDepth);
      f = floor(f * uSteps * 1.6) / (uSteps * 1.6 - 1.0);               // 色块化：画师的“几档颜色”
      vec3 c = mix(uColor, uColor2, clamp(f, 0.0, 1.0));
      float n2 = fbm3(vWorld * uScale * 6.0);
      // 陡坡 → 岩石（加横向地层纹）；贴水 → 沙/湿岩
      float steep = smoothstep(0.8, 0.6, N.y + (n2 - 0.5) * 0.3) * uRockK;
      vec3 rock = uRock * (0.86 + 0.28 * step(0.5, fbm3(vec3(vWorld.x * 0.15, vWorld.y * 1.4, vWorld.z * 0.15))));
      c = mix(c, rock, steep);
      c = mix(c, uSand, smoothstep(1.2, 0.4, vWorld.y - uWaterLevel + (n2 - 0.5)) * uSandK);
      c *= 0.94 + 0.12 * n2;
      #ifdef USE_WIND_SHEEN
      if(uWind.z > 0.0){
        // 赛璐璐式的硬边亮带：两档（波峰 + 波峰顶），不是渐变
        float grass = (1.0 - steep) * step(0.8, N.y);
        float wv = windWave(vWorld.xz);
        float band = step(0.32, wv) * 0.6 + step(0.62, wv) * 0.4;
        c = mix(c, c * vec3(1.16, 1.2, 1.0) + vec3(0.04, 0.05, 0.0), band * clamp(uWind.z * 1.6, 0.0, 1.0) * uSheen * grass);
      }
      #endif
      #ifdef USE_PUDDLES
      vec3 outc = paintLight(c, N, vWorld);
      float pud = puddleApply(outc, vWorld, N);
      writeOut(outc, 1.0, NV, vDepth, uId);
      if(pud > 0.5) oColor.a = 0.0;                                  // 水洼 = 平涂赛璐璐块：不吃 Kuwahara（id 仍为 0 → 不描线）
      #else
      writeOut(paintLight(c, N, vWorld), 1.0, NV, vDepth, uId);
      #endif
    }
  `;
  const m = mat(u, vs, fs);
  if (o.windSheen || o.puddles) { m.defines = { ...(m.defines ?? {}), ...defs }; m.needsUpdate = true; }
  return m;
}

// ===================================================================== 绘画天空
// 渐变天空 + 由“团块”并集构成的积云：每个团块是天球上的一个圆（方位角、仰角、半径），
// 噪声扰动边缘、平底切割；最“里面”的团块决定法线 → 受光/中间/阴影三档硬色，阴影偏薰衣草。
//   puffs: [[azDeg, elDeg, rDeg, cutElDeg], ...]  （最多 64 个）
export const MAX_PUFFS = 64;
export function skyMaterial(puffs = []) {
  const arr = Array.from({ length: MAX_PUFFS }, (_, i) => new THREE.Vector4(...(puffs[i] ?? [0, -90, 0, -90])));
  const u = base({
    uZenith: { value: col('#1c5ed2') }, uMid: { value: col('#55a5ef') },
    uHorizonWarm: { value: col('#f3f7f0') }, uHorizonCool: { value: col('#c3e2f7') },
    uCloudLit: { value: col('#ffffff') }, uCloudMid: { value: col('#e8eefa') }, uCloudShade: { value: col('#a2b0de') },
    uPuffs: { value: arr }, uNPuffs: { value: Math.min(puffs.length, MAX_PUFFS) },
    uCloudDrift: { value: 0 }, uSunDisk: { value: 1 },
    uStars: { value: 0 }, uStarColor: { value: col('#fff6e8') },
  });
  const vs = /* glsl */ `
    varying vec3 vDir;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = normalize(wp.xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * wp;
      gl_Position.z = gl_Position.w * 0.99999;      // 永远在最远处
    }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    uniform vec3 uZenith, uMid, uHorizonWarm, uHorizonCool, uCloudLit, uCloudMid, uCloudShade;
    uniform vec4 uPuffs[${MAX_PUFFS}];
    uniform float uNPuffs, uCloudDrift, uSunDisk, uStars;
    uniform vec3 uStarColor;
    varying vec3 vDir;
    // 星空：天球方向切成网格，每格最多一颗星（位置/亮度/色温由格子哈希决定 → 固定在天上，不随镜头游走）。
    // 星点宽度按屏幕像素算（fwidth），远近机位都是 1–2 像素的“画上去的点”；最亮的几颗 >1 → 吃泛光、带十字闪。
    // 闪烁用 uDrawTime（一拍二），确定性。
    float starLayer(vec3 d, float scale, float density, float seed, float fw){
      vec3 p = d * scale;
      vec3 cell = floor(p);
      vec3 h = vec3(hash13(cell + seed), hash13(cell + seed + 17.1), hash13(cell + seed + 41.7));
      if(hash13(cell * 1.31 + seed + 5.3) > density) return 0.0;
      vec3 sp = cell + 0.2 + 0.6 * h;
      float r = length(p - sp);
      float px = max(fw * scale, 1e-4) * 0.6;                        // fw 在 main 里统一算（导数不能放进分支）
      float mag = pow(h.x, 4.0);                                     // 大多数暗、少数亮
      float core = 1.0 - smoothstep(px * (0.3 + 0.9 * mag), px * (0.9 + 1.4 * mag), r);
      float tw = 0.75 + 0.25 * sin(uDrawTime * (2.0 + 5.0 * h.y) + h.z * 40.0);
      return core * (0.25 + 1.5 * mag) * tw;
    }
    const float D2R = 0.0174532925;
    void main(){
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 d = normalize(vDir), s = normalize(uSunDir);
      float elD = asin(clamp(d.y, -1.0, 1.0)) / D2R;
      float azD = atan(d.x, -d.z) / D2R;
      float toSun = dot(d, s);
      float sunSide = dot(normalize(d.xz + 1e-5), normalize(s.xz + 1e-5)) * 0.5 + 0.5;
      // 渐变：地平线淡 → 饱和天蓝 → 深天顶
      vec3 hor = mix(uHorizonCool, uHorizonWarm, smoothstep(0.35, 1.0, sunSide));
      float h = max(elD, 0.0);
      vec3 c = mix(hor, uMid, smoothstep(0.0, 16.0, h));
      c = mix(c, uZenith, smoothstep(10.0, 75.0, h));
      c = mix(c, mix(hor, vec3(1.0), 0.35), pow(max(toSun, 0.0), 14.0) * 0.5);
      c += vec3(1.4) * smoothstep(0.9993, 0.9996, toSun) * uSunDisk;     // 太阳盘 >1 → 泛光
      // 星星（画在云的后面：云团会把它们盖住）。越靠地平线、越靠太阳越淡
      float fwD = fwidth(d.x) + fwidth(d.y) + fwidth(d.z);
      if(uStars > 0.001){
        float vis = uStars * smoothstep(2.0, 18.0, elD) * (1.0 - 0.85 * smoothstep(0.6, 0.97, toSun));
        float st = starLayer(d, 110.0, 0.16, 0.0, fwD) + starLayer(d, 230.0, 0.07, 7.0, fwD) * 0.55;
        // 一条极淡的银河带（斜跨天顶）
        float band = exp(-pow(dot(d, normalize(vec3(0.55, 0.35, 0.76))) / 0.22, 2.0));
        float milky = band * (0.5 + 0.5 * fbm3(d * 9.0)) * 0.12;
        st += starLayer(d, 320.0, 0.25 * band, 13.0, fwD) * 0.45;
        c = c + (uStarColor * st + mix(uStarColor, uZenith, 0.5) * milky) * vis;
      }

      // 积云（团块并集）
      vec3 east = normalize(vec3(-d.z, 0.0, d.x) + vec3(1e-6, 0.0, 0.0));
      vec3 upT = normalize(vec3(0.0, 1.0, 0.0) - d * d.y + vec3(0.0, 1e-6, 0.0));
      vec3 L = normalize(vec3(dot(s, east), dot(s, upT), dot(s, -d)));
      float edgeN = fbm3(d * 24.0 + 3.1) - 0.5, edgeN2 = vnoise3(d * 66.0) - 0.5;
      float ce = cos(elD * D2R);
      float best = -1e9, second = -1e9; vec3 bn = vec3(0, 0, 1); float bCut = -90.0;
      for(int k = 0; k < ${MAX_PUFFS}; k++){
        if(float(k) >= uNPuffs) break;
        vec4 P = uPuffs[k];
        float dx = (mod(azD - P.x - uCloudDrift + 540.0, 360.0) - 180.0) * ce;
        float dy = elD - P.y;
        float q2 = (dx * dx + dy * dy) / (P.z * P.z);
        if(q2 > 2.1) continue;
        float e = 1.0 - q2 + (edgeN * 0.5 + edgeN2 * 0.16) * (0.55 + 2.2 / (P.z + 1.5));
        e -= max(P.w - elD, 0.0) * 0.9;                                 // 平底
        if(e > best){ second = best; best = e; bn = normalize(vec3(dx / P.z, dy / P.z, sqrt(max(0.0, 1.0 - q2)) + 0.25)); bCut = P.w; }
        else if(e > second) second = e;
      }
      if(best > -0.05){
        float ndl = dot(bn, L) + edgeN * 0.35 + bn.y * 0.25;
        vec3 cc = ndl > 0.38 ? uCloudLit : (ndl > 0.0 ? uCloudMid : uCloudShade);
        // 团块之间的“折痕”：两个团块势均力敌处画一道阴影色 → 菜花状的体积感
        // 只画在团块的下沿（bn.y < 0）：上面的团块“坐”在下面的团块上，不要满屏网格
        float crease = (1.0 - smoothstep(0.0, 0.06, best - second)) * step(0.05, second) * smoothstep(0.15, -0.35, bn.y);
        cc = mix(cc, mix(uCloudMid, uCloudShade, 0.5), crease * 0.7);
        cc = mix(cc, uCloudShade, smoothstep(4.0, 0.5, elD - bCut) * 0.6);   // 云底一条薰衣草色
        float a = smoothstep(-0.05, 0.02, best);                            // 几乎是硬边
        c = mix(c, cc, a);
      }
      writeOut(c, 1.0, vec3(0.0, 0.0, 1.0), 9000.0, 0.0);
    }
  `;
  return mat(u, vs, fs, { side: THREE.BackSide, depthWrite: false });
}

// ===================================================================== overlay：遮挡模式
// overlay 没有深度缓冲 → 读 uSceneData（主渲染 data 图）自己判断遮挡。
// 坑：水面是屏幕空间 pass 画的，不在 data 图里；水面附近的特效如果按深度测试，
// 会被“水下的海床”挡掉，出现一条笔直的硬边。所以给每个精灵/线条一个模式：
//   mode 0 = 对一切做深度测试   1 = 只被赛璐璐（角色，id>0）遮挡   2 = 不测试
export const OCCLUDE = /* glsl */ `
bool occluded(float mode, float depth, float bias, vec2 fragXY, vec2 res){
  if(mode > 1.5) return false;
  vec4 sd = texture(uSceneData, fragXY / res);
  bool nearer = sd.b < depth - bias;
  return mode < 0.5 ? nearer : (nearer && sd.a > 0.5);
}
`;

// ===================================================================== overlay：发光精灵
// kind: 0 柔光  1 十字星（kira）  2 光环
export function glowMaterial() {
  const u = { uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
  const vs = /* glsl */ `
    attribute vec3 iPos;
    attribute vec4 iC;      // rgb, power
    attribute vec4 iK;      // kind, 半径(米), 半径(输出像素), 旋转
    attribute vec2 iM;      // 遮挡模式, 偏差(米)
    uniform vec2 uRes;
    varying vec2 vP; varying vec4 vC; varying vec4 vK; varying float vDepth; varying vec2 vM;
    void main(){
      vM = iM;
      vec4 mv = viewMatrix * vec4(iPos, 1.0);
      float c = cos(iK.w), s = sin(iK.w);
      vec2 p = mat2(c, s, -s, c) * position.xy * 2.0;
      mv.xy += p * iK.y;
      vec4 clip = projectionMatrix * mv;
      clip.xy += p * iK.z * (uRes.y / 1040.0) * 2.0 / uRes * clip.w;
      vP = position.xy * 2.0; vC = iC; vK = iK; vDepth = -mv.z;
      gl_Position = clip;
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    varying vec2 vP; varying vec4 vC; varying vec4 vK; varying float vDepth; varying vec2 vM;
    out vec4 o;
    ${OCCLUDE}
    void main(){
      if(occluded(vM.x, vDepth, vM.y, gl_FragCoord.xy, uRes)) discard;
      float r = length(vP), k = vK.x, a;
      if(k < 0.5) a = exp(-r * r * 5.0);
      else if(k < 1.5){
        float arm = max(exp(-abs(vP.y) * 60.0) * (1.0 - smoothstep(0.0, 1.0, abs(vP.x))),
                        exp(-abs(vP.x) * 60.0) * (1.0 - smoothstep(0.0, 1.0, abs(vP.y))));
        a = max(arm, exp(-r * r * 40.0)) + exp(-r * r * 6.0) * 0.25;
      } else a = exp(-pow((r - 0.8) / 0.06, 2.0)) + exp(-r * r * 8.0) * 0.15;
      a *= vC.a;
      if(a < 0.003) discard;
      vec3 hot = mix(vC.rgb, vec3(1.0), smoothstep(0.6, 1.4, a));     // 中心发白（动画光效的白芯）
      o = vec4(hot * a, 1.0);
    }
  `;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vs, fragmentShader: fs,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// ===================================================================== overlay：屏幕空间线条
// 折线在顶点着色器里按“屏幕像素宽度”挤出 → 闪电/流星尾巴在任何距离都保持手绘笔画的粗细。
// 截面：白色芯 + 饱和色带 + 可选深色外缘（rim）。
// 为什么要 rim：纯叠加光打在白云/亮天空上会直接“消失”（白 + 光 = 白）。LEVIATHAN 的原话：
// “the plate is bright, so every bolt carries a dark rim”。所以用预乘 alpha 混合：
// 芯和色带 alpha=0（纯叠加），外缘 alpha>0（压暗背景并画上深色）。
export function lineMaterial() {
  const u = { uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
  const vs = /* glsl */ `
    attribute vec3 aPrev;
    attribute vec3 aNext;
    attribute vec4 aA;      // side ±1, s (0..1 沿线), 宽度(输出像素), 遮挡模式
    attribute vec4 aC;      // rgb, power
    attribute float aR;     // 深色外缘强度 0..1
    uniform vec2 uRes;
    varying float vSide; varying vec4 vC; varying float vDepth; varying float vS; varying float vMode; varying float vRim;
    void main(){
      vMode = aA.w; vRim = aR;
      vec4 mv = viewMatrix * vec4(position, 1.0);
      vec4 c = projectionMatrix * mv;
      vec4 a = projectionMatrix * viewMatrix * vec4(aPrev, 1.0);
      vec4 b = projectionMatrix * viewMatrix * vec4(aNext, 1.0);
      vec2 d = (b.xy / b.w - a.xy / a.w) * uRes;
      float l = length(d);
      d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
      c.xy += vec2(-d.y, d.x) * aA.x * aA.z * (uRes.y / 1040.0) / uRes * c.w;
      vSide = aA.x; vC = aC; vDepth = -mv.z; vS = aA.y;
      gl_Position = c;
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    varying float vSide; varying vec4 vC; varying float vDepth; varying float vS; varying float vMode; varying float vRim;
    out vec4 o;
    ${OCCLUDE}
    void main(){
      if(occluded(vMode, vDepth, 2.0, gl_FragCoord.xy, uRes)) discard;
      float v = abs(vSide);
      float hasRim = step(0.001, vRim);
      float wB = mix(1.0, 0.68, hasRim);                 // 有 rim 时色带收窄，外圈留给深色边
      float core = 1.0 - smoothstep(0.22 * wB, 0.4 * wB, v);
      float band = 1.0 - smoothstep(0.72 * wB, 0.95 * wB, v);
      vec3 add = mix(vC.rgb * band, vec3(1.3), core) * vC.a;
      float rim = (1.0 - smoothstep(0.88, 1.0, v)) * (1.0 - band) * vRim * clamp(vC.a, 0.0, 1.0);
      o = vec4(add + vC.rgb * 0.3 * rim, rim);           // 预乘：dst = src + dst * (1 - a)
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

// ===================================================================== overlay：旋转虚影弧（C3，MotionArcBatch 用）
// 一片环形扇区：u 沿扫掠方向（0 = 尾巴，1 = 头部），v 沿半径（0 = 内缘，1 = 外缘）。
// 头部略实、尾巴渐隐、内外缘羽化；可选几条径向细纹（像手绘的残影刷痕）。预乘 alpha：dst = src + dst × (1 - a)。
export function motionArcMaterial() {
  const u = { uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } };
  const vs = /* glsl */ `
    attribute vec2 aUV;
    attribute vec4 aC;      // rgb, alpha
    attribute vec4 aM;      // 遮挡模式, 偏差(米), 径向条纹数, -
    varying vec2 vUV; varying vec4 vC; varying vec4 vM; varying float vDepth;
    void main(){
      vec4 mv = viewMatrix * vec4(position, 1.0);
      vUV = aUV; vC = aC; vM = aM; vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    varying vec2 vUV; varying vec4 vC; varying vec4 vM; varying float vDepth;
    out vec4 o;
    ${OCCLUDE}
    void main(){
      if(occluded(vM.x, vDepth, vM.y, gl_FragCoord.xy, uRes)) discard;
      float u = vUV.x, v = vUV.y;
      float a = pow(u, 1.7) * (1.0 - smoothstep(0.9, 1.0, u));           // 尾巴渐隐、头部收一个软边
      a *= smoothstep(0.0, 0.22, v) * (1.0 - smoothstep(0.7, 1.0, v));   // 内外缘羽化
      if(vM.z > 0.5) a *= 0.55 + 0.45 * smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(v * 3.14159 * vM.z * 2.0));
      a *= vC.a;
      if(a < 0.003) discard;
      o = vec4(vC.rgb * a, a);
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
