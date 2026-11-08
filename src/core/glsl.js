import * as THREE from 'three';

// 全局共享 uniform（改编自原作 src/glsl.js）。
// 每个材质把 G 展开进自己的 uniforms —— 展开的是 {value} 对象的引用，
// 所以改一次 G.uSunDir.value，全场所有材质同时生效。
export const G = {
  uTime: { value: 0 },
  uDrawTime: { value: 0 },          // 量化到原画（一拍二）的时间
  uPass: { value: 0 },              // 0 主渲染 / 1 阴影深度 / 2 水面反射
  uWaterLevel: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
  uKeyDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },   // 角色主光（动画作弊光：与太阳解耦）
  uSunColor: { value: new THREE.Color('#fff3dc') },
  uSunStrength: { value: 1 },
  uShadeTint: { value: new THREE.Color('#a6b1e2') },   // 赛璐璐暗部：冷的薰衣草蓝，绝不用灰
  uDeepTint: { value: new THREE.Color('#7b85c6') },    // 第三色（最深）
  uBounce: { value: new THREE.Color('#c2f0e6') },      // 地面/水面反弹光
  uSkyTint: { value: new THREE.Color('#eaf3ff') },
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowOn: { value: 0 },
  // 局部暖光（灯笼、篝火、发光生物）：最多 MAX_LAMPS 个。pos = (x, y, z, 半径 m)，col = (r, g, b, 强度)
  // 由 look.lights 设置（applyLook），或部门在 update() 里用 look.js 的 setLamp() 跟随锚点（在 applyLook 之后执行，会覆盖）
  uLampPos: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  uLampCol: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  // 风场（W1）：(风向 x, 风向 z, 强度 0..1, 行进距离 m)。由 look.wind 设置；强度 0 = 没有风，所有材质与旧版逐像素一致
  uWind: { value: new THREE.Vector4(0, 1, 0, 0) },
  // 云影（W5）：(强度 0..1, 尺度 1/m, 偏移 x, 偏移 z)。强度 0 = 没有云影（逐像素不变）。由 look.cloudShadow 设置
  uCloudShadow: { value: new THREE.Vector4(0, 0.012, 0, 0) },
  // 雨打水面（W8）：(雨点密度 0..1, 格子边长 m, 一拍三的时间 s, 0)。由 look.rainRings 设置；密度 0 = 水面 / 水洼都不画雨环（逐像素不变）
  // 只有水面 pass（WATER_FS）和开了 puddles 的地面材质读它（其余材质不声明这个 uniform）
  uRainRing: { value: new THREE.Vector4(0, 0.7, 0, 0) },
  // 地面水洼（W10）：(覆盖量 0..1, 尺度 1/m, 种子偏移, 0)。由 look.puddles 设置；只有 paintMaterial / meadowGround 的 puddles 选项打开时才读
  uPuddle: { value: new THREE.Vector4(0, 0.22, 0, 0) },
  uPudSky: { value: new THREE.Color('#cfdeec') },      // 水洼里倒映的天空：地平线一档（默认 = 调色板的 water.skyRefl）
  uPudZen: { value: new THREE.Color('#55a5ef') },      // 天顶一档（默认 = 天空材质的 uMid）
};
export const MAX_LAMPS = 2;

// 描线色表（按材质 id 查）：INK_TAB.value[id] = (r, g, b, 粗细)。w = 0 = 未设置（默认墨色、粗细 1）；r < 0 = 只设了粗细、颜色用默认墨色。
// 由 celMaterial({ ink }) 写入（同一个 id 只能有一种描线色，后写的覆盖先写的）；描线 pass 读它（engine.js 的 mInk）。
// 只有 1..99（会描线的 id）有意义。
export const INK_TAB = { value: Array.from({ length: 100 }, () => new THREE.Vector4(0, 0, 0, 0)) };

export const COMMON = /* glsl */ `
uniform float uTime;
uniform float uDrawTime;
uniform float uPass;
uniform float uWaterLevel;
uniform vec3 uSunDir;
uniform vec3 uKeyDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform vec3 uShadeTint;
uniform vec3 uDeepTint;
uniform vec3 uBounce;
uniform vec3 uSkyTint;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform vec4 uLampPos[2];
uniform vec4 uLampCol[2];
uniform vec4 uWind;
uniform vec4 uCloudShadow;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float vnoise3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.-2.*f);
  float a = mix(mix(hash13(i), hash13(i+vec3(1,0,0)), u.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z); }
float fbm2(vec2 p){ float s = 0., a = .5; for(int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
float fbm3(vec3 p){ float s = 0., a = .5; for(int i = 0; i < 4; i++){ s += a*vnoise3(p); p = p*2.07 + vec3(1.7, 9.2, 4.1); a *= .5; } return s; }
// 草浪：沿风向行进的一道道波峰（0..1）。p = 世界 xz；波长约 8 m，叠一层大尺度噪声让波峰断续、不像正弦
float windWave(vec2 p){
  vec2 d = normalize(uWind.xy);
  float s = dot(p, d) - uWind.w;
  float side = dot(p, vec2(-d.y, d.x));
  float w = 0.5 + 0.5 * sin(s * 0.785 + 1.3 * vnoise(vec2(side * 0.06, s * 0.03)) * 3.0);
  return pow(w, 3.0) * (0.55 + 0.45 * vnoise(vec2(side * 0.08 + 3.1, s * 0.05)));
}

// 局部暖光：返回“照度”（乘在固有色上再加进结果）。
//   wrap：0 = 按法线受光（立体物）；1 = 不看法线（植物卡片、毛绒）。
//   toon：0 = 柔和衰减（绘画背景/植物）；1 = 两档硬色阶（赛璐璐角色：灯光照在脸上也是“画”出来的一块亮色）
vec3 lampLight(vec3 wp, vec3 N, float wrap, float toon){
  vec3 s = vec3(0.0);
  for(int i = 0; i < 2; i++){
    vec4 C = uLampCol[i]; vec4 P = uLampPos[i];
    if(C.a <= 0.0 || P.w <= 0.0) continue;
    vec3 d = P.xyz - wp;
    float dist = length(d);
    float fall = 1.0 - smoothstep(0.0, P.w, dist);
    fall *= fall;
    float ndl = clamp((dot(N, d / max(dist, 1e-4)) + wrap) / (1.0 + wrap), 0.0, 1.0);
    float k = fall * ndl;
    float band = smoothstep(0.1, 0.13, k) * 0.55 + smoothstep(0.4, 0.43, k) * 0.45;
    s += C.rgb * C.a * mix(k, band, toon);
  }
  return s;
}

// 地面上随风扫过的云影（W5）：大块、边缘柔和的明暗团，返回直射光的乘数（1 = 不在云影里）。
// 只压直射太阳光，天光 / 暗部不变 —— 所以云影里是“暗一档”，不是变黑。强度 0 时恒为 1.0。
float cloudShade(vec3 wp){
  if(uCloudShadow.x <= 0.0) return 1.0;
  vec2 q = (wp.xz - uCloudShadow.zw) * uCloudShadow.y;
  float n = fbm2(q) + 0.35 * (vnoise(q * 3.7 + 11.0) - 0.5);
  return 1.0 - uCloudShadow.x * smoothstep(0.5, 0.62, n);
}

// 只有“角色”投影（画出来的光，不是物理光）：布景永远不会把影子砸到主角脸上
// 另外乘上云影（W5，关闭时 = 1.0）
float sunShadow(vec3 wp, vec3 n){
  if(uShadowOn < 0.5) return cloudShade(wp);
  vec4 sc = uShadowMatrix * vec4(wp + n * 0.04, 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if(c.x < 0. || c.x > 1. || c.y < 0. || c.y > 1. || c.z > 1.) return cloudShade(wp);
  vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
  float s = 0.;
  for(int x = -1; x <= 1; x++) for(int y = -1; y <= 1; y++){
    float d = texture(uShadowMap, c.xy + vec2(x, y) * texel).r;
    s += (c.z - 0.0009 > d) ? 0. : 1.;
  }
  return s / 9. * cloudShade(wp);
}
`;

// MRT 输出约定 —— 整个引擎最重要的一条“协议”：
//   oColor = 颜色；a 通道标记“画出来的背景”（1）还是“赛璐璐角色”（0）
//   oData  = (视空间法线.xy, 视深度, 材质 id)
//   id 0 = 绘画背景（吃笔触，不描线） / 1..99 = 赛璐璐 + 自动描线 / 100+ = 赛璐璐不描线
// 后面的 paint / ink / water / atmos / overlay 全都只读这两张图做决策。
export const MRT_OUT = /* glsl */ `
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oData;
void writeOut(vec3 col, float a, vec3 nView, float viewDepth, float id){
  oColor = vec4(col, id > 0.5 ? 0.0 : 1.0);
  oData = vec4(nView.xy * 0.5 + 0.5, viewDepth, id);
}
`;

export const VERT_STD = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vNormalV;
varying float vDepth;
varying vec2 vUv;
void stdVertex(vec3 pos, vec3 nrm){
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
  vNormalV = normalize(normalMatrix * nrm);
  vNormalW = normalize(transpose(mat3(viewMatrix)) * vNormalV);
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}
`;

// 顶点着色器用的风场（植物卡片在顶点里弯）：自带一份小噪声，不依赖 COMMON
export const WIND_VS = /* glsl */ `
uniform vec4 uWind;
float wHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(wHash(i), wHash(i+vec2(1,0)), u.x), mix(wHash(i+vec2(0,1)), wHash(i+vec2(1,1)), u.x), u.y); }
float windWave(vec2 p){
  vec2 d = normalize(uWind.xy);
  float s = dot(p, d) - uWind.w;
  float side = dot(p, vec2(-d.y, d.x));
  float w = 0.5 + 0.5 * sin(s * 0.785 + 1.3 * wNoise(vec2(side * 0.06, s * 0.03)) * 3.0);
  return pow(w, 3.0) * (0.55 + 0.45 * wNoise(vec2(side * 0.08 + 3.1, s * 0.05)));
}
`;

// 玻璃上的雨水（W11）：舷窗、镜头眼、车窗。放进 celMaterial 的 pattern 前面用（依赖 COMMON 的 hash12）：
//   celMaterial({ pattern: GLASS_GLSL + `vec4 pattern(vec3 p, vec3 n){ vec3 c = cGlass; float un = 0.0;
//       c = glassWater(c, p.xy / 0.4, uDrawTime, uRainK, uWetK, vec3(0.86, 0.92, 1.02), un); return vec4(c, un); }`,
//     colors: { cGlass: '#2c3842' }, uniforms: { uRainK: 0, uWetK: 0 } })
//   q = 玻璃平面坐标（大约 -1..1）。rain 0..1：流下的水道（随时间一拍四地往下爬）；wet 0..1：雨停后挂着的静止水珠（上亮下暗 + 一颗高光）。
//   全部是坐标与时间的纯函数；颜色是平涂两三档（赛璐璐），不是折射模拟。
export const GLASS_GLSL = /* glsl */ `
// 竖向水道：返回 (水身, 亮边)
vec2 glassRivulets(vec2 q, float t){
  float tq = floor(t * 4.0) * 0.6;
  float riv = 0.0, edge = 0.0;
  for(int i = 0; i < 6; i++){
    float fi = float(i);
    float cx = -0.78 + fi * 0.31 + 0.12 * (hash12(vec2(fi, 3.1)) - 0.5) + 0.06 * sin(q.y * 5.5 + fi * 2.1 + floor(tq) * 0.35);
    float w = 0.026 + 0.012 * sin(q.y * 11.0 - tq * (2.6 + fi * 0.3) + fi * 4.0);
    float d = abs(q.x - cx);
    float seg = step(0.18, fract(q.y * 0.55 - tq * (0.45 + 0.08 * fi) + fi * 0.37));
    riv = max(riv, step(d, w) * seg);
    edge = max(edge, step(w * 0.55, d) * step(d, w * 1.15) * seg);
  }
  return vec2(riv, edge);
}
// 静止水珠（最多 8 颗，位置由 seed 哈希）：返回 (在珠内, 下沿暗边, 上→下的暖色渐变, 高光)
vec4 glassBeads(vec2 q, float seed){
  vec4 r = vec4(0.0);
  for(int i = 0; i < 8; i++){
    float fi = float(i);
    vec2 c = vec2(hash12(vec2(fi, seed)), hash12(vec2(seed, fi + 7.3))) * 1.5 - 0.75;
    float rad = 0.045 + 0.045 * hash12(vec2(fi + 2.7, seed * 1.3));
    vec2 dv = (q - c) / rad; dv.y *= 0.86;
    float dr = length(dv);
    if(dr < 1.0){
      r.x = 1.0;
      r.y = step(0.78, dr) * step(dv.y, 0.15);
      r.z = smoothstep(0.85, -0.55, dv.y);
      r.w = clamp(step(length(dv - vec2(-0.28, 0.34)), 0.27) + step(length(dv - vec2(0.22, -0.42)), 0.15) * 0.6, 0.0, 1.0);
    }
  }
  return r;
}
// 一步到位：把水道和水珠画到颜色 c 上；unlit 输出“不受光”比例（水的亮边 / 高光是画上去的）
vec3 glassWater(vec3 c, vec2 q, float t, float rain, float wet, vec3 tint, out float unlit){
  unlit = 0.0;
  if(rain > 0.02){
    vec2 rv = glassRivulets(q, t);
    c = mix(c, c * 0.82 + tint * 0.2, rv.x * rain * 0.75);
    c = mix(c, tint, rv.y * rain * 0.68);
    unlit = max(unlit, (rv.x * 0.35 + rv.y * 0.85) * rain);
  }
  float beadOn = wet * (1.0 - clamp(rain * 4.0, 0.0, 1.0));
  if(beadOn > 0.02){
    vec4 b = glassBeads(q, 3.7);
    if(b.x > 0.5){
      vec3 bc = mix(c * 0.72, uSunColor * vec3(1.0, 0.86, 0.6), b.z * 0.75 * beadOn);
      bc = mix(bc, c * 0.45, b.y * 0.7);
      bc = mix(bc, uSunColor * 1.3, b.w * beadOn);
      c = mix(c, bc, beadOn * 0.92);
      unlit = max(unlit, beadOn * 0.9);
    }
  }
  return c;
}
`;

// 雨打水面 / 水洼里的雨点涟漪（W8 / W10）：无状态的雨环场。水面 pass（passes.js WATER_FS）和水洼（PUDDLE_GLSL）共用这一个函数。
// 依赖 hash12 / hash22（COMMON 和 passes.js 的 NOISE 里都有）。
//   q = 世界 xz（米）；t = 一拍三的时间（秒，= uRainRing.z）；dens 0..1 = 每格每个周期落雨点的概率；cell = 格子边长（米）；
//   px = 这一点一个像素是多少米（环比几个像素还小时整层淡出，不出摩尔纹）；
//   sp = 屏幕格坐标（≥ 0 时：环淡出的远处改画一拍三闪烁的小白点，读成“一片被雨打毛的水面”；传 vec2(-1) 关掉）。
// 每格两个错相的雨点；每个雨点的位置 / 大小 / 落不落都由 (格子, 周期号) 哈希决定 → 第几帧先渲染都一样。
// 寿命 0.75 s = 6 张一拍三的原画：第 1 张是一颗溅起的白点 + 一圈断续的小冠，后 5 张一道亮环向外扩，环内侧跟一道暗环
// （两档色、硬边，赛璐璐的画法，不是物理波）。
// 返回 vec4(高度场梯度 x, 梯度 z（给水面法线加扰动）, 亮线 0..1, 暗线 0..1)
export const RAIN_RING_GLSL = /* glsl */ `
vec4 rainRings(vec2 q, float t, float dens, float cell, float px, vec2 sp){
  vec4 acc = vec4(0.0);
  float fade = 1.0 - smoothstep(0.07, 0.16, px / cell);
  if(fade > 0.0){
    vec2 g = q / cell, gi = floor(g);
    float aa = px * 0.75;
    for(int j = -1; j <= 1; j++) for(int i = -1; i <= 1; i++) for(int k = 0; k < 2; k++){
      vec2 id = gi + vec2(float(i), float(j));
      vec2 ik = id + float(k) * vec2(37.1, 91.7);
      float cyc = t / 0.75 + hash12(ik * 0.731 + 4.1);
      float n = floor(cyc), age = fract(cyc);
      vec2 sd = ik + n * vec2(17.13, 5.71);
      if(hash12(sd + 9.7) > dens * 0.55) continue;                   // 雨量 1 ≈ 每格每 0.75 s 一个雨点
      vec2 c = id + 0.15 + 0.7 * hash22(sd);                         // 雨点中心（格子单位；环最大 0.62 格 → 3×3 邻格够用）
      float sz = 0.55 + 0.45 * hash12(sd + 2.3);
      vec2 dv = (g - c) * cell;
      float r = length(dv);
      float lw = max(cell * 0.024, px * 1.1);                        // 线宽：至少一个像素
      if(age < 1.0 / 6.0){
        // 第 1 张原画：溅点 + 断续小冠
        float rd = cell * 0.05 * sz;
        float dotv = 1.0 - smoothstep(rd - aa, rd + aa, r);
        float rc = cell * 0.13 * sz;
        float ang = atan(dv.y, dv.x) * 0.95493 + hash12(sd + 5.1) * 6.0;   // × 6/2π：6 段
        float crown = (1.0 - smoothstep(lw * 0.5 - aa, lw * 0.5 + aa, abs(r - rc))) * step(0.45, fract(ang));
        acc.z = max(acc.z, max(dotv, crown) * fade);
      } else {
        float a2 = (age - 1.0 / 6.0) * 1.2;                          // 0..1
        float R = cell * sz * (0.12 + 0.5 * sqrt(a2));
        float w = lw * (1.0 - 0.45 * a2);                            // 越扩越细
        float x = r - R;
        float on = step(a2, 0.86);                                   // 最后一张收掉（不是渐隐：手绘是一张一张没的）
        float br = (1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(x))) * on;
        // 扩到后半程的环断成几段（手绘的环不是完整的圆，也避免满屏一模一样的圈）
        float seg = fract(atan(dv.y, dv.x) * 0.63662 + hash12(sd + 7.7) * 4.0);   // × 4/2π：4 段
        br *= 1.0 - step(0.5, a2) * step(seg, 0.18 + 0.5 * (a2 - 0.5));
        float bw = cell * 0.05 * sz * (1.0 - 0.4 * a2);
        float dk = smoothstep(-w * 0.5 - bw - aa, -w * 0.5 - bw + aa, x) * (1.0 - smoothstep(-w * 0.5 - aa, -w * 0.5 + aa, x)) * on;
        // 大雨点内侧再跟一道细环
        float R2 = R * 0.55;
        float br2 = (1.0 - smoothstep(w * 0.35 - aa, w * 0.35 + aa, abs(r - R2))) * step(0.78, sz) * step(0.2, a2) * on;
        acc.z = max(acc.z, max(br, br2 * 0.8) * fade);
        acc.w = max(acc.w, dk * fade);
        // 高度场：环处一道隆起，梯度 = h'(r) · dv / r
        float W = cell * 0.06 * sz;
        float h = cell * 0.014 * (1.0 - a2) * exp(-x * x / (W * W)) * on;
        acc.xy += (-2.0 * x / (W * W)) * h * dv / max(r, 1e-4) * fade;
      }
    }
    acc.w *= 1.0 - acc.z;
  }
  if(sp.x >= 0.0 && fade < 1.0){
    // 远处：环细过像素 → 一拍三闪烁的小白点
    float spk = step(1.0 - 0.025 * dens, hash12(sp + floor(t * 8.0 + 0.5) * 3.7));
    acc.z = max(acc.z, spk * (1.0 - fade) * 0.7);
  }
  return acc;
}
`;

// 地面水洼（W10）：paintMaterial({ puddles: true }) / meadowGround(U, { puddles: true }) 打开（编进 USE_PUDDLES），
// 覆盖量由 look.puddles 控制（0 = 不画，逐像素等于没开）。依赖 COMMON（fbm2 / vnoise / uSunDir …）。
//   形状：世界 xz 上域扭曲 fbm 取阈值 → 一摊一摊硬边的水洼，只长在平地上（N.y > ~0.92），外面一圈深色湿泥边。
//   颜色（赛璐璐式“画出来的倒影”，不是镜面反射）：反射方向的仰角切三档天空色（地平线浅 → 天顶深）、
//   和水下暗一档的泥地按菲涅尔混；太阳在反射方向上 → 一颗 >1 的亮点（吃泛光）；
//   远边（屏幕上方那条边）一道亮的水沿线、近边一道暗线；look.rainRings 打开时水洼里也有雨环（同一个 rainRings）。
//   水洼像素写 a = 0（平涂赛璐璐块）：不吃 Kuwahara，雨环才不会被笔触抹掉；id 仍是 0 → 不描线。
// puddleApply(col, wp, N)：col = 已受光的地面颜色（原地改）；返回水洼覆盖 0..1。必须在非分支的地方调用（里面用了 fwidth / dFdy）。
export const PUDDLE_GLSL = /* glsl */ `
uniform vec4 uPuddle;
uniform vec4 uRainRing;
uniform vec3 uPudSky, uPudZen;
${RAIN_RING_GLSL}
float puddleApply(inout vec3 col, vec3 wp, vec3 N){
  vec2 p = wp.xz * uPuddle.y + uPuddle.z;
  vec2 wv = vec2(fbm2(p * 0.5 + 3.3), fbm2(p * 0.5 + 8.1)) - 0.5;      // 域扭曲：一摊一摊，不是圆
  float f = fbm2(p + wv * 1.3) + 0.06 * (vnoise(p * 7.0) - 0.5);
  f -= (1.0 - smoothstep(0.93, 0.99, N.y)) * 0.4;                      // 只在平地上（坡度 > ~15° 就没有；缓坡上只剩最深的几摊）
  float fw = max(fwidth(f), 1e-5);
  float fdy = dFdy(f);
  float px = max(length(fwidth(wp.xz)), 1e-4);
  if(uPuddle.x <= 0.0) return 0.0;
  float thr = mix(0.7, 0.45, uPuddle.x);
  float inside = smoothstep(thr - fw * 0.5, thr + fw * 0.5, f);
  float halo = step(thr - 0.03 - 0.02 * uPuddle.x, f) * (1.0 - inside);
  col *= mix(vec3(1.0), vec3(0.74, 0.77, 0.86), halo);                  // 湿泥边：暗一档、偏冷
  if(inside <= 0.0) return 0.0;
  vec3 V = normalize(wp - cameraPosition);
  vec3 Nn = vec3(0.0, 1.0, 0.0);
  vec4 rr = vec4(0.0);
  if(uRainRing.x > 0.0){
    rr = rainRings(wp.xz, uRainRing.z, uRainRing.x * 0.6, uRainRing.y * 0.55, px, vec2(-1.0));   // 水洼里的雨点小一号、稀一点
    Nn = normalize(vec3(-rr.x * 1.6, 1.0, -rr.y * 1.6));
  }
  vec3 R = reflect(V, Nn);
  float e = R.y + 0.05 * (vnoise(wp.xz * 1.1 + 2.0) - 0.5);
  // 三档天空：地平线（浅）→ 中间 → 天顶（深），硬边
  vec3 hor = mix(uPudSky, uSunColor, 0.3 * smoothstep(0.55, 1.0, dot(normalize(R.xz + 1e-5), normalize(uSunDir.xz + 1e-5))) * uSunStrength);   // 朝太阳那边的地平线偏暖
  vec3 skyC = e < 0.17 ? hor : (e < 0.45 ? mix(hor, uPudZen, 0.5) : uPudZen);
  // 倒影里的云：反射方向投到一块“天花板”上取 fbm 阈值 → 几团硬边的亮云（被雨环扰动时跟着碎）
  float cl = step(0.57, fbm2(R.xz / max(R.y, 0.12) * 0.8 + uPuddle.z + vec2(3.7, 1.1)));
  skyC = mix(skyC, mix(hor, vec3(1.0), 0.5), cl * 0.85);
  vec3 wetC = col * vec3(0.48, 0.52, 0.62);                             // 水下的泥地
  float fr = 0.5 + 0.5 * pow(1.0 - clamp(-V.y, 0.0, 1.0), 2.0);
  vec3 pc = mix(wetC, skyC, fr);
  // 太阳的倒影：一颗硬边亮点 + 一圈淡光（>1 → 泛光）
  float sd = dot(R, uSunDir);
  pc = mix(pc, mix(skyC, uSunColor, 0.6) * 1.08, step(0.975, sd) * 0.5 * uSunStrength);
  pc = mix(pc, uSunColor * 1.7, step(0.996, sd) * uSunStrength);
  // 水沿：远边一道亮线（2–3 像素），近边一道暗线
  float edge = 1.0 - smoothstep(fw * 1.6, fw * 2.6, f - thr);
  float far = step(fdy, 0.0);
  pc = mix(pc, mix(uPudSky, vec3(1.0), 0.55) * 1.04, edge * far);
  pc = mix(pc, wetC * 0.72, edge * (1.0 - far) * 0.85);
  // 雨环（两档）
  pc = mix(pc, pc * vec3(0.78, 0.83, 0.92), rr.w * 0.6);
  pc = mix(pc, mix(uPudSky, vec3(1.0), 0.6) * 1.02, rr.z * 0.9);
  col = mix(col, pc, inside);
  return inside;
}
`;
