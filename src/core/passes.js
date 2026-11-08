// 全屏后期 pass 的着色器（改编自原作 engine.js + passes-env.js，MIT，做了精简与中文注释）。
// 所有 pass 都只读两张图：tColor（颜色）和 tData（视法线.xy / 视深度 / 材质 id）。
import { RAIN_RING_GLSL } from './glsl.js';

export const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm2(vec2 p){ float s = 0., a = .5; for(int i = 0; i < 4; i++){ s += a*vnoise(p); p = p*2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
`;

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ------------------------------------------------------------------ 1. 笔触（只作用于背景）
// 各向异性 Kuwahara：8 个重叠扇区的椭圆笔刷，沿一个缓慢旋转的“笔触方向场”排列；
// 按扇区平坦度加权混合 → 平坦区变成水粉笔触、边缘与小细节保留。
// 远处笔刷变小（深度自适应），远处的窗户/招牌才不会被糊掉。
export const PAINT_FS = /* glsl */ `
uniform sampler2D tColor, tData;
uniform vec2 uRes;
uniform float uRadius, uS;
varying vec2 vUv;
out vec4 o;
${NOISE}
void main(){
  vec4 c0 = texture(tColor, vUv);
  if(c0.a < 0.5){ o = vec4(c0.rgb, 0.0); return; }          // 赛璐璐像素：原样通过（保持锐利）
  vec2 px = 1.0 / uRes;
  vec2 fc = gl_FragCoord.xy / uS;
  float ang = (fbm2(fc / 140.0) - 0.5) * 3.2 + 0.4;            // 笔触方向场
  vec2 dA = vec2(cos(ang), sin(ang)), dB = vec2(-dA.y, dA.x);
  float depth = texture(tData, vUv).b;
  float rad = uRadius * mix(0.72, 0.4, smoothstep(10.0, 120.0, depth)) * uS;
  vec3 m[8]; vec3 s[8]; float n[8];
  for(int k = 0; k < 8; k++){ m[k] = c0.rgb; s[k] = c0.rgb * c0.rgb; n[k] = 1.0; }
  for(int r = 1; r <= 3; r++){
    float rr = rad * float(r) / 3.0;
    for(int k = 0; k < 16; k++){
      float a = float(k) * 0.39269908 + (r == 2 ? 0.19634954 : 0.0);
      vec2 off = (dA * cos(a) * 1.45 + dB * sin(a) * 0.8) * rr;
      vec4 t = texture(tColor, vUv + off * px);
      vec3 tc = t.rgb * t.a, tq = t.rgb * t.rgb * t.a;           // t.a=0（角色像素）不参与平均 → 角色不会“晕”进背景
      if(k / 2 * 2 == k){
        int i0 = k / 2;
        m[i0] += tc; s[i0] += tq; n[i0] += t.a;
      } else {
        int i0 = (k - 1) / 2, i1 = ((k + 1) / 2) % 8;
        m[i0] += tc * 0.5; s[i0] += tq * 0.5; n[i0] += t.a * 0.5;
        m[i1] += tc * 0.5; s[i1] += tq * 0.5; n[i1] += t.a * 0.5;
      }
    }
  }
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for(int k = 0; k < 8; k++){
    vec3 mu = m[k] / n[k];
    vec3 v = abs(s[k] / n[k] - mu * mu);
    float sd = sqrt(v.r + v.g + v.b);
    float w = 1.0 / (1.0 + pow(sd * 22.0, 8.0));                 // 越平坦的扇区权重越大
    acc += mu * w; wsum += w;
  }
  vec3 col = wsum > 1e-5 ? acc / wsum : c0.rgb;
  // 干笔刷纹 + 纸张颗粒
  mat2 R = mat2(dA.x, dA.y, dB.x, dB.y);
  vec2 sp = R * fc;
  float bristle = vnoise(vec2(sp.x / 26.0, sp.y / 2.2));
  float paper = vnoise(fc / 2.5) * 0.5 + vnoise(fc / 9.0) * 0.5;
  col *= 0.98 + 0.04 * bristle;
  col *= 0.99 + 0.02 * paper;
  o = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ 2. 描线（只作用于赛璐璐）
// 在 8 个方向采样 data 图，三种边：材质 id 不同 / 相对深度跳变 / 法线折角。
// 线宽 = 基础宽 × 笔压噪声 × 距离衰减；两种宽度各采一次再平均 → 线有“粗细起伏”。
// 关键技巧：同一角色不同零件用不同 id，线就会正好落在装甲板的接缝上。
export const INK_FS = /* glsl */ `
uniform sampler2D tColor, tData;
uniform vec2 uRes;
uniform float uS, uWidth, uSeed;
uniform vec3 uInk;
uniform vec4 uInkTab[100];       // 每个材质 id 的描线色 rgb（r < 0 → 用 uInk）+ 粗细 w（0 = 未设置）。见 glsl.js INK_TAB
varying vec2 vUv;
out vec4 o;
${NOISE}
bool inked(float id){ return id > 0.5 && id < 99.5; }
vec3 nrm(vec4 d){ vec2 xy = d.rg * 2.0 - 1.0; return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))); }
// eid：这条线“属于”哪个材质 id（交界两侧取在前面的那个赛璐璐）—— 用来查描线色
float edgeAt(vec2 uv, vec4 dC, vec3 nC, float w, inout float eid){
  vec2 px = w / uRes;
  float e = 0.0;
  float eBest = 0.0;
  for(int k = 0; k < 8; k++){
    float a = float(k) * 0.78539816;
    vec4 dN = texture(tData, uv + vec2(cos(a), sin(a)) * px);
    bool cC = inked(dC.a), cN = inked(dN.a);
    if((!cC && !cN) || dC.a > 99.5 || dN.a > 99.5) continue;
    float ee = 0.0;
    if(abs(dN.a - dC.a) > 0.5){
      // 与背景交界：只有赛璐璐在前面时才画轮廓线
      if(cC && cN) ee = 1.0;
      else if(cC) ee = (dC.b < dN.b + 0.5) ? 1.0 : 0.0;
      else ee = (dN.b < dC.b + 0.5) ? 1.0 : 0.0;
    } else {
      float rel = abs(dN.b - dC.b) / max(min(dN.b, dC.b), 0.01);
      ee = smoothstep(0.015, 0.035, rel);
      ee = max(ee, smoothstep(0.78, 0.6, dot(nC, nrm(dN))) * 0.85);
    }
    e = max(e, ee);
    if(ee > eBest){
      eBest = ee;
      eid = (cC && (!cN || dC.b <= dN.b)) ? dC.a : dN.a;
    }
  }
  return e;
}
void main(){
  vec4 col = texture(tColor, vUv);
  vec4 dC = texture(tData, vUv);
  vec3 nC = nrm(dC);
  vec2 fc = gl_FragCoord.xy / uS;
  float press = 0.72 + 0.56 * vnoise(fc / 34.0 + uSeed * 7.0);        // 笔压（随原画张数 uSeed 换）
  float dist = clamp(14.0 / max(dC.b, 0.1), 0.5, 1.25);
  float w = uWidth * uS * press * dist;
  float idA = 0.0, idB = 0.0;
  float eA = edgeAt(vUv, dC, nC, w, idA), eB = edgeAt(vUv, dC, nC, w * 0.55, idB);
  float e = 0.5 * eA + 0.5 * eB;
  int ii = int(clamp(floor((eB > 0.0 ? idB : idA) + 0.5), 0.0, 99.0));
  vec4 tab = uInkTab[ii];
  // K3 描线粗细按 id：tab.w = 粗细（0 = 未设置 = 1）。< 1 时往细的那一笔靠（最细约 0.55 倍），> 1 时再采一圈更宽的
  float wgt = tab.w > 0.0 ? tab.w : 1.0;
  if(wgt < 0.999) e = mix(eB, e, clamp((wgt - 0.55) / 0.45, 0.0, 1.0));
  else if(wgt > 1.001){ float idW = 0.0; float eW = edgeAt(vUv, dC, nC, w * min(wgt, 2.5), idW); e = max(e, 0.5 * eW + 0.5 * eA); }
  float alpha = e * (0.82 + 0.18 * vnoise(fc / 7.0 + uSeed));
  vec3 inkC = (tab.w > 0.0 && tab.r >= 0.0) ? tab.rgb : uInk;      // r < 0 = 只设了粗细、颜色用默认墨色
  vec3 ink = mix(inkC, col.rgb * 0.32, 0.25);                          // 墨色带一点底色，不是死黑
  o = vec4(mix(col.rgb, ink, clamp(alpha, 0.0, 1.0)), 1.0);
}
`;

// ------------------------------------------------------------------ 3. 屏幕空间水面
// 不建水面网格：对每个像素求视线与 y = uWaterLevel 平面的交点，在那里“画”水。
// 反射用镜像相机渲染的半分辨率图，并在竖直方向涂抹（动画里的水面倒影画法）。
export const MAX_RIP = 24;
export const WATER_FS = /* glsl */ `
#define MAX_RIP 24
uniform sampler2D tColor, tData, tRefl;
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat4 uInvProj, uCamWorld, uReflMat;
uniform float uWaterLevel, uFxTime, uOn, uWaveAmp;
uniform vec3 uSunDir, uSunColor;
uniform float uSunStrength;
uniform vec3 uDeep, uShallow, uFoam, uSkyRefl;
uniform vec4 uRip[MAX_RIP];      // x, z, 起始时间, 振幅
uniform vec4 uRipB[MAX_RIP];     // 速度 m/s, 环宽 m, 衰减 1/s, 泡沫 0..1
uniform vec4 uRipC[MAX_RIP];     // 发光颜色 rgb, 发光强度（0 = 普通涟漪；>1 的部分进泛光）
uniform float uRipN;             // 本帧用了几个槽位（循环提前结束：软件渲染下省很多）
uniform vec4 uRainRing;          // 雨环：(密度 0..1, 格子边长 m, 一拍三时间 s, 0) —— = G.uRainRing（look.rainRings）
varying vec2 vUv;
out vec4 o;
${NOISE}
${RAIN_RING_GLSL}
float hfield(vec2 q){
  float t = uFxTime;
  return fbm2(q * 0.18 + vec2(t * 0.035, t * 0.02)) + vnoise(q * vec2(0.9, 1.6) - vec2(t * 0.22, -t * 0.05)) * 0.22;
}
float ripples(vec2 q, float px, bool wantGlow, out float foam, out vec3 glow){
  float h = 0.0; foam = 0.0; glow = vec3(0.0);
  for(int i = 0; i < MAX_RIP; i++){
    if(float(i) >= uRipN) break;
    vec4 R = uRip[i]; vec4 B = uRipB[i];
    if(R.w <= 0.0) continue;
    float age = uFxTime - R.z;
    if(age <= 0.0) continue;
    float r = length(q - R.xy);
    float x = (r - age * B.x) / B.y;
    float env = R.w * exp(-age * B.z) * smoothstep(0.0, 0.3, age);
    float ring = exp(-x * x) * env;
    h += ring * sin(x * 2.6);
    float x2 = (r - age * B.x * 0.72) / (B.y * 0.7);             // 第二道细环，像手绘的涟漪
    foam = max(foam, smoothstep(0.32, 0.5, ring + exp(-x2 * x2) * env * 0.6) * B.w);
    // 发光环（生物荧光、魔法涟漪）：亮度只看包络、不看振幅 → 波很小的涟漪也能亮。
    // 两道硬一点的环（画出来的光环）+ 一层柔光，环内侧留一点余晖
    vec4 G4 = uRipC[i];
    if(wantGlow && G4.a > 0.0){
      // 环宽至少 ~2 像素：远处的细环不会混叠成摩尔纹，而是自然地化成一条柔光
      float wpx = max(B.y, px * 3.0);
      float xg = (r - age * B.x) / wpx, xg2 = (r - age * B.x * 0.72) / (wpx * 0.7);
      float fade = B.y / wpx;                                    // 环被加宽多少就暗多少（能量守恒，远处不糊成一片亮）
      float envN = exp(-age * B.z) * smoothstep(0.0, 0.3, age);
      float gl = (smoothstep(0.35, 0.75, exp(-xg * xg)) * 0.8 + exp(-xg2 * xg2) * 0.4) * fade + exp(-xg * xg * 0.2) * 0.18;
      glow += G4.rgb * G4.a * gl * envN;
    }
  }
  return h;
}
void main(){
  vec4 col = texture(tColor, vUv);
  if(uOn < 0.5){ o = col; return; }
  vec4 d = texture(tData, vUv);
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 wdir = normalize(mat3(uCamWorld) * vdir);
  if(wdir.y > -1e-4){ o = col; return; }
  float t = (uWaterLevel - uCamPos.y) / wdir.y;
  if(t <= 0.0){ o = col; return; }
  float cosv = -vdir.z;
  float waterVD = t * cosv, sceneVD = d.b;
  if(sceneVD < 8000.0 && waterVD > sceneVD){ o = col; return; }    // 水面前面有东西
  vec3 P = uCamPos + wdir * t;
  vec2 q = P.xz;
  float pxWorld = waterVD * 0.0018;

  // 法线：高度场 + 涟漪环
  float e = max(0.06, pxWorld * 2.0), rf, rfx, rfz;
  vec3 rglow, gx, gz;
  float h0 = hfield(q) * uWaveAmp + ripples(q, pxWorld, true, rf, rglow);
  float hx = hfield(q + vec2(e, 0.0)) * uWaveAmp + ripples(q + vec2(e, 0.0), pxWorld, false, rfx, gx);
  float hz = hfield(q + vec2(0.0, e)) * uWaveAmp + ripples(q + vec2(0.0, e), pxWorld, false, rfz, gz);
  vec3 n = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e) * vec3(0.6, 1.0, 0.6));
  // 雨环（W8）：掠射角下环在屏幕上被压扁 → 像素足迹按 1/sqrt(sinθ) 放大，压扁的环早一点淡出成小白点
  vec4 rr = vec4(0.0);
  if(uRainRing.x > 0.0){
    rr = rainRings(q, uRainRing.z, uRainRing.x, uRainRing.y, pxWorld / sqrt(max(-wdir.y, 0.03)), floor(vUv * uRes / 2.0));
    rr.z *= smoothstep(700.0, 120.0, waterVD);                     // 天边不再闪
    n = normalize(n + vec3(-rr.x, 0.0, -rr.y));
  }

  // 反射：竖直涂抹 + 轻微色阶化（赛璐璐式的分层）
  vec4 rc = uReflMat * vec4(P, 1.0);
  vec2 ruv = rc.xy / rc.w + n.xz * vec2(0.035, 0.05);
  vec3 refl = vec3(0.0); float wsum = 0.0;
  for(int i = -3; i <= 3; i++){
    float w = 1.0 - abs(float(i)) / 4.0;
    refl += texture(tRefl, ruv + vec2((vnoise(vec2(q.x * 0.7, float(i))) - 0.5) * 0.004, float(i) * 0.0045)).rgb * w; wsum += w;
  }
  refl = mix(refl / wsum, uSkyRefl, 0.1);
  float lum = dot(refl, vec3(0.299, 0.587, 0.114));
  refl *= mix(1.0, (floor(lum * 7.0 + 0.5) / 7.0) / max(lum, 0.001), 0.3);

  // 透过水看水下（浅水透明，深处吸收成 uDeep）
  // 注意：天空像素在地平线附近 waterVD 可能 > sceneVD，under 会是很大的负数，
  // exp() 溢出成 inf，再乘 0 得 NaN → 被泛光模糊扩散成黑色方块。必须先夹到 >= 0。
  bool skyBehind = sceneVD >= 8000.0;
  float under = skyBehind ? 1e4 : max((sceneVD - waterVD) / max(cosv, 0.05), 0.0);
  float absorb = skyBehind ? 1.0 : 1.0 - exp(-min(under * 0.12 + max(t - 25.0, 0.0) * 0.004, 60.0));
  vec3 below = texture(tColor, vUv + n.xz * 0.009 * smoothstep(0.0, 1.5, under)).rgb;
  vec3 body = mix(mix(below, uShallow, 0.15), uDeep, absorb);

  float ndv = max(dot(-wdir, n), 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 wc = mix(body, refl, fres);

  // 太阳：柔光 + 一颗颗“画出来的”闪点（一拍三刷新），绝不是一整块过曝
  vec3 rd = reflect(wdir, n);
  float sd = max(dot(rd, uSunDir), 0.0);
  wc += uSunColor * (pow(sd, 40.0) * 0.07 + pow(sd, 8.0) * 0.025) * uSunStrength;
  vec2 sp = floor(vUv * uRes / 2.0);
  float glit = step(0.985, hash12(sp + floor(uFxTime * 8.0) * 1.7)) * smoothstep(0.985, 0.999, sd);
  wc += uSunColor * glit * 1.5 * uSunStrength;

  // 画出来的水纹短横线（相机对齐）
  vec3 camR = normalize(vec3(uCamWorld[0].x, 0.0, uCamWorld[0].z));
  vec3 camF = normalize(vec3(-uCamWorld[2].x, 0.0, -uCamWorld[2].z));
  vec2 qc = vec2(dot(P, camR), dot(P, camF));
  float dash = vnoise(vec2(qc.x * 0.22, qc.y * 3.2) + vec2(uFxTime * 0.15, 0.0));
  float dash2 = vnoise(vec2(qc.x * 0.5, qc.y * 7.0) - vec2(uFxTime * 0.25, 0.0));
  float lines = step(0.82, dash) * 0.5 + step(0.86, dash2) * 0.35 / (1.0 + waterVD * 0.02);
  wc = mix(wc, mix(uSkyRefl, vec3(1.0), 0.4), lines * 0.4 * smoothstep(400.0, 30.0, waterVD));

  // 接触泡沫：任何刺穿水面的东西周围自动出一圈白沫（无需美术摆放）
  float contact = smoothstep(0.35 + pxWorld * 2.0, 0.05, under) * step(sceneVD, 8000.0);
  float foamLine = step(0.45, contact * (0.7 + 0.6 * vnoise(q * 3.0 + uFxTime * 0.8)));
  float foam = max(foamLine, rf);
  wc = mix(wc, uFoam * mix(vec3(1.0), uSunColor, 0.35 * uSunStrength), foam * 0.85);
  if(uRainRing.x > 0.0){
    // 雨环两档：环内侧暗一档（冷）、环线是天光色偏白的亮线
    vec3 ringC = mix(uSkyRefl, vec3(1.0), 0.55) * mix(vec3(1.0), uSunColor, 0.25 * uSunStrength);
    wc = mix(wc, wc * vec3(0.8, 0.86, 0.94), rr.w * 0.55);
    wc = mix(wc, ringC, rr.z * 0.85);
  }
  wc += rglow;                                                     // 发光涟漪：加法（可以 >1 → 泛光）
  o = vec4(wc, 1.0);
}
`;

// ------------------------------------------------------------------ 4. 大气：雾、贴水薄雾、光束
export const ATMOS_FS = /* glsl */ `
uniform sampler2D tColor, tData;
uniform vec3 uCamPos;
uniform mat4 uInvProj, uCamWorld;
uniform float uWaterLevel, uTime, uWaterOn;
uniform vec3 uSunDir, uSunColor;
uniform float uSunStrength;
uniform vec3 uFogWarm, uFogCool;
uniform float uFogDensity, uMist, uMistHeight;
uniform vec2 uSunUV;
uniform float uShafts;
// C1 光束风格：0 = radial（旧版：朝太阳屏幕位置的放射条纹）/ 1 = slanted（单侧平行斜射光幕）
uniform float uShaftStyle, uShaftFreq, uShaftDown, uAspect;
uniform vec2 uShaftDir;          // slanted：光束在屏幕上的行进方向（宽高比校正后的单位向量，由 engine 每帧算好）
varying vec2 vUv;
out vec4 o;
${NOISE}
void main(){
  vec4 col = texture(tColor, vUv);
  vec4 d = texture(tData, vUv);
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 wdir = normalize(mat3(uCamWorld) * vdir);
  float cosv = -vdir.z;
  float vd = d.b;
  if(uWaterOn > 0.5 && wdir.y < -1e-4){
    float t = (uWaterLevel - uCamPos.y) / wdir.y;
    if(t > 0.0) vd = min(vd, t * cosv);
  }
  bool sky = vd > 8000.0;
  float dist = sky ? 3000.0 : vd / max(cosv, 0.05);
  vec3 P = uCamPos + wdir * dist;
  float toSun = dot(wdir, uSunDir);
  vec3 fogC = mix(uFogCool, uFogWarm, smoothstep(-0.3, 1.0, toSun));    // 朝阳一侧暖、背阳冷
  float fog = sky ? 0.0 : 1.0 - exp(-dist * uFogDensity);
  float hgt = max(P.y - uWaterLevel, 0.0);
  float bank = fbm2(P.xz * 0.03 + vec2(uTime * 0.012, uTime * 0.004));
  float mist = uMist * exp(-hgt / uMistHeight) * smoothstep(10.0, 50.0, dist) * (0.35 + 1.1 * bank);
  if(sky) mist = uMist * exp(-max(wdir.y, 0.0) * 18.0) * 0.7;
  vec3 c = mix(col.rgb, fogC, clamp(fog + mist, 0.0, 0.95));
  // 光束：从像素朝太阳屏幕位置步进，统计“天空像素”占比
  vec3 camF = normalize(mat3(uCamWorld) * vec3(0.0, 0.0, -1.0));
  float facing = dot(camF, uSunDir);
  if(uShafts > 0.0 && uShaftStyle > 0.5){
    // slanted（C1）：几束宽阔柔和的平行斜光，从太阳一侧向画面下方 / 海面舒展。
    //   - 横向用低频噪声（uShaftFreq 4–10）切出光束，不再用极角 × 30/80 的高频噪声（= 360° 车轮辐条伪影）；
    //   - 透光率沿光束反方向（朝太阳）平行步进：天空像素按 data.r 里的“云遮光率”打折（skyDome 写入；旧天空 = 0 → 全透），
    //     几何体全挡 → 光从真实的云隙 / 山隙里漏下来；
    //   - uShaftDown：只向太阳下游（光束行进方向）延伸，不会朝天顶倒射。
    vec2 asp = vec2(uAspect, 1.0);
    vec2 rel = (vUv - uSunUV) * asp;
    float along = dot(rel, uShaftDir), across = dot(rel, vec2(-uShaftDir.y, uShaftDir.x));
    float span = clamp(along, 0.04, 0.8), acc = 0.0;
    vec2 stepUv = uShaftDir / asp;
    for(int i = 1; i <= 16; i++){
      vec2 uv = vUv - stepUv * span * (float(i) / 16.0);
      float s;
      if(uv.y > 1.0) s = 1.0;
      else if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0) s = 0.6;
      else { vec4 td = texture(tData, uv); s = td.b > 8000.0 ? 1.0 - clamp(td.r * 2.0 - 1.0, 0.0, 1.0) : 0.0; }
      acc += s;
    }
    acc /= 16.0;
    float f = uShaftFreq;
    float beams = smoothstep(0.32, 0.82, vnoise(vec2(across * f + 3.1, uTime * 0.02)) * 0.72 + vnoise(vec2(across * f * 2.3 + 11.0, 7.7)) * 0.32);
    float lenFade = uShaftDown > 0.5 ? smoothstep(-0.04, 0.14, along) * (1.0 - smoothstep(0.5, 1.5, along))
                                     : 1.0 - smoothstep(0.5, 1.5, abs(along));
    float spread = exp(-across * across / 0.8);
    c += uSunColor * acc * beams * lenFade * spread * uShafts * uSunStrength * smoothstep(-0.1, 0.3, facing) * (sky ? 0.12 : 0.28);
  } else if(uShafts > 0.0 && facing > 0.05){
    vec2 toS = uSunUV - vUv;
    float L = length(toS);
    vec2 dirS = toS / max(L, 1e-4);
    float span = min(L, 0.7), acc = 0.0;
    for(int i = 1; i <= 24; i++){
      vec2 uv = vUv + dirS * span * (float(i) / 24.0);
      float s = uv.y > 1.0 ? 1.0 : (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0) ? 0.6 : (texture(tData, uv).b > 8000.0 ? 1.0 : 0.0);
      acc += s;
    }
    acc /= 24.0;
    float ang = atan(toS.y, toS.x);
    float streak = smoothstep(0.25, 0.95, vnoise(vec2(ang * 30.0, uTime * 0.05)) * 0.7 + vnoise(vec2(ang * 80.0, 3.0)) * 0.4);
    c += uSunColor * acc * streak * uShafts * uSunStrength * smoothstep(0.05, 0.4, facing) * smoothstep(1.5, 0.3, L) * (sky ? 0.14 : 0.32);
  }
  o = vec4(c, 1.0);
}
`;

// ------------------------------------------------------------------ 5. 泛光 + 6. 调色
export const BRIGHT_FS = /* glsl */ `
uniform sampler2D tColor;
uniform float uThreshold;
varying vec2 vUv;
out vec4 o;
void main(){
  vec3 c = texture(tColor, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(uThreshold, uThreshold + 0.4, l), 1.0);
}
`;

export const BLUR_FS = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uDir;
varying vec2 vUv;
out vec4 o;
void main(){
  vec3 s = texture(tColor, vUv).rgb * 0.227;
  s += texture(tColor, vUv + uDir * 1.385).rgb * 0.316;
  s += texture(tColor, vUv - uDir * 1.385).rgb * 0.316;
  s += texture(tColor, vUv + uDir * 3.231).rgb * 0.070;
  s += texture(tColor, vUv - uDir * 3.231).rgb * 0.070;
  o = vec4(s, 1.0);
}
`;

// 高调（high-key）动画调色：提曝光、开中间调、Vibrance 只给低饱和区加饱和，
// 软肩压高光，暗角，逐帧胶片颗粒，最后淡入淡出。
export const FINAL_FS = /* glsl */ `
uniform sampler2D tColor, tBloom1, tBloom2;
uniform vec2 uRes;
uniform float uS, uFrame, uBloom, uVignette, uGrain, uFade, uFadeSoft, uPaper;
uniform vec3 uLift, uGain, uFadeColor, uPaperColor;
uniform float uSat, uExposure, uGamma, uVibrance;
varying vec2 vUv;
out vec4 o;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
void main(){
  vec2 px = 1.0 / uRes;
  vec3 c;
  if(uS > 1.5){   // 超采样：内部 2x 分辨率，这里 4 点平均下采样（= 抗锯齿）
    c = (texture(tColor, vUv + px * vec2(-0.5, -0.5)).rgb + texture(tColor, vUv + px * vec2(0.5, -0.5)).rgb +
         texture(tColor, vUv + px * vec2(-0.5, 0.5)).rgb + texture(tColor, vUv + px * vec2(0.5, 0.5)).rgb) * 0.25;
  } else c = texture(tColor, vUv).rgb;
  c += (texture(tBloom1, vUv).rgb * 0.6 + texture(tBloom2, vUv).rgb * 0.8) * uBloom;
  c = c / (1.0 + max(c - 1.0, 0.0) * 0.6);
  c *= uExposure;
  c = pow(max(c, 0.0), vec3(uGamma));
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, uSat * (1.0 + uVibrance * (1.0 - chroma)));
  c = uLift + c * (uGain - uLift);
  vec2 q = vUv - 0.5;
  if(uPaper > 0.0){
    // K5 纸张质感：暖色纸底（乘）+ 固定在画面上的纤维 / 纸纹（按输出像素定频率，不随镜头游走，所以像“印在纸上”）
    vec2 fp = gl_FragCoord.xy / uS;
    float fib = vn(vec2(fp.x * 0.9, fp.y * 0.07)) * 0.5 + vn(vec2(fp.x * 0.06, fp.y * 0.8) + 17.0) * 0.5;
    float tooth = vn(fp * 0.45) * 0.6 + vn(fp * 0.11 + 5.0) * 0.4;
    c *= mix(vec3(1.0), uPaperColor, uPaper * 0.55) * (1.0 - uPaper * (0.05 * (fib - 0.5) + 0.07 * (tooth - 0.5)));
  }
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  c += (hash12(gl_FragCoord.xy + uFrame * 17.31) - 0.5) * uGrain;
  if(uFadeSoft > 0.0){
    // C5 胶片式柔边淡变：四角先暗 / 先白、画面中心最后收（像光圈呼吸），uFade = 0 / 1 时与整屏淡变端点一致
    float rn = clamp(dot(q, q) * 2.0, 0.0, 1.0);                       // 0 = 中心，1 = 四角
    float fl = clamp(uFade * (1.0 + uFadeSoft) - uFadeSoft * (1.0 - rn), 0.0, 1.0);
    c = mix(c, uFadeColor, fl * fl * (3.0 - 2.0 * fl));
  } else c = mix(c, uFadeColor, uFade);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
