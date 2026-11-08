import * as THREE from 'three';
import { G, COMMON, MRT_OUT } from './glsl.js';
import { screen } from './color.js';

// 绘画天穹（C2）：360° 一体的四层天空着色器（从《海岬的测风人》sky_storm.js 下沉）：
//   1. 高空卷云丝（球面透视 + 旋转域扭曲的手绘刷痕）
//   2. 多塔团块并集积云：最多 24 座云塔 × 每塔 64 个团块，存在 RGBA32F DataTexture 里，
//      每塔用方位 / 仰角包围盒早退；smooth-max 融合（无鱼鳞圆环）、fwidth 抗锯齿、三阶赛璐璐明暗、逆光银边、地平线雾化
//   3. uOvercast 0→1：连续的水粉石板蓝阴云（地平线柔和融入远海雾气，没有硬切线）；uFlash = 云内闪电
//   4. uAfterRain + uSideRays：雨后一侧云开、另一侧残云退去，云开一侧画几束宽阔柔和的斜射霞光（不是 360° 轮辐）
// 另外把“云遮光率”写进 data.r（旧天空恒为 0），look.shaftStyle = 'slanted' 的屏幕光束会据此从真实云隙里漏光。
//
//   const clouds = { towers: [cloudTower(rng, { az, base, w, h, r, lean, haze, cut, prof }), …] }
//   const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 56, 28), skyDome(clouds, {
//     rays: { az: -44, el: 13 },        // 侧光光幕中心（度，az 0 = -Z，+ 朝 +X）
//     remnant: { az0: -8, az1: 42 },    // 雨后残云从哪个方位开始变浓（度）
//     uniforms: STORM,                  // 可选：共享的 uniform 对象（部门每帧写 STORM.uOvercast.value …）
//   }));
//   ctx.sky = sky   （applyLook 照常驱动 uZenith / uMid / 地平线 / 云色 / uCloudDrift / uSunDisk）
// 云漂移：uCloudDrift（度）/ uCloudShift（卷云与阴云纹理）请用风速的预积分（见 secondary.js 的做法），不要写 t × wind(t)。

// 天穹的天气 uniform（每次调用新建一份；想在多个部门间共享就自己建一份传给 o.uniforms）
export function skyDomeUniforms() {
  return {
    uOvercast: { value: 0 },                                  // 0 晴空积云 → 1 漫天阴云
    uCloudShift: { value: new THREE.Vector2(0, 0) },          // 卷云与阴云纹理的漂移
    uAfterRain: { value: 0 },                                 // 雨后模式（一侧残云、一侧云开）
    uSideRays: { value: 0 },                                  // 云开一侧的斜射光幕强度 0..1
    uFlash: { value: new THREE.Vector4(0, 1, 0, 0) },         // 闪电方向 xyz 与强度 w
    uDeckDark: { value: new THREE.Color(screen('#2c364b')) },
    uDeckMid: { value: new THREE.Color(screen('#475570')) },
    uDeckLit: { value: new THREE.Color(screen('#7686a3')) },
  };
}

// 天穹用的 2D 值噪声（cN / cF）
export const CLOUD_NOISE = /* glsl */ `
float cH12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cN(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(cH12(i), cH12(i+vec2(1,0)), u.x), mix(cH12(i+vec2(0,1)), cH12(i+vec2(1,1)), u.x), u.y); }
float cF(vec2 p){ float s = 0., a = .5; for(int i = 0; i < 4; i++){ s += a*cN(p); p = p*2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
`;

// 生成一座由多层团块（billows）组成的绘画积云塔（角度制：az 0 = -Z，+ 朝 +X）。
//   o = { az, base (云底仰角°), w (宽°), h (高°), r? (团块半径°), lean?, prof?(f) 轮廓, cut? (平底仰角°), haze? }
export function cloudTower(rng, o) {
  const puffs = [];
  const R0 = o.r ?? Math.max(1.0, o.w * 0.17);
  const rows = Math.max(1, Math.round((o.h - R0) / (R0 * 0.85)));
  const prof = o.prof ?? ((f) => 1 - 0.42 * f * f);
  for (let k = 0; k <= rows; k++) {
    const f = rows ? k / rows : 0;
    const y = o.base + R0 * 0.55 + f * (o.h - R0 * 1.35);
    const width = Math.max(R0 * 0.6, o.w * prof(f));
    const n = Math.max(1, Math.round(width / (R0 * 1.12)));
    for (let i = 0; i < n; i++) {
      const uu = n === 1 ? 0 : i / (n - 1) - 0.5;
      const x = o.az + (o.lean ?? 0) * f * o.h + uu * (width - R0) + rng.range(-0.3, 0.3) * R0;
      const r = R0 * rng.range(0.8, 1.15) * (1 - 0.2 * f);
      const z = (1 - f) * R0 * 1.6 + (0.5 - Math.abs(uu)) * R0 * 1.3 + rng.range(0, 0.5) * R0;
      puffs.push([x, y + rng.range(-0.3, 0.3) * R0, r, z]);
    }
  }
  const body = puffs.length;
  for (let i = 0; i < body && puffs.length < 50; i++) {
    const [x, y, r, z] = puffs[i];
    if (y < o.base + o.h * 0.25 || rng.next() < 0.35) continue;
    const a = rng.range(0.25, Math.PI - 0.25);
    puffs.push([x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.8, r * rng.range(0.32, 0.5), z + r * 0.35]);
  }
  const topY = o.base + o.h - R0 * 0.7;
  const topW = Math.max(R0, o.w * prof(1));
  const nc = Math.max(2, Math.round(topW / (R0 * 0.7)));
  for (let i = 0; i < nc; i++) {
    const uu = i / (nc - 1) - 0.5;
    puffs.push([
      o.az + (o.lean ?? 0) * o.h + uu * topW * 0.85,
      topY - Math.abs(uu) * R0 * 1.1 + rng.range(-0.2, 0.3) * R0,
      R0 * rng.range(0.5, 0.72),
      rng.range(-0.3, 0.2) * R0,
    ]);
  }
  return { puffs: puffs.slice(0, 64), cut: o.cut ?? o.base + R0 * 0.3, haze: o.haze ?? 0 };
}

// 天穹材质：clouds = { towers: [cloudTower(...)] }，o 见文件头。返回 ShaderMaterial（BackSide，挂在跟随相机的大球上）。
export function skyDome(clouds, o = {}) {
  const rays = { az: -44, el: 13, ...(o.rays ?? {}) }, rem = { az0: -8, az1: 42, ...(o.remnant ?? {}) };
  const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  const MAXT = 24;
  const all = [], tb = [], ti = [];
  for (const t of clouds.towers.slice(0, MAXT)) {
    const start = all.length;
    let a0 = 1e9, a1 = -1e9, e0 = 1e9, e1 = -1e9;
    const azC = t.puffs[0][0];
    for (const p of t.puffs.slice(0, 64)) {
      const da = ((p[0] - azC + 540) % 360) - 180;
      const ra = p[2] * 1.45 / Math.max(0.2, Math.cos(Math.min(80, Math.abs(p[1]) + p[2] * 1.45) * Math.PI / 180));
      a0 = Math.min(a0, da - ra); a1 = Math.max(a1, da + ra);
      e0 = Math.min(e0, p[1] - p[2] * 1.45); e1 = Math.max(e1, p[1] + p[2] * 1.45);
      all.push(p);
    }
    const mid = (a0 + a1) / 2;
    tb.push(new THREE.Vector4(azC + mid, (a1 - a0) / 2, Math.max(e0, t.cut ?? -90) - 0.5, e1));
    ti.push(new THREE.Vector4(start, all.length - start, t.haze ?? 0, t.cut ?? -90));
  }
  while (tb.length < MAXT) {
    tb.push(new THREE.Vector4(0, 0, 100, 100));
    ti.push(new THREE.Vector4(0, 0, 0, -90));
  }
  const W = Math.max(1, all.length);
  const data = new Float32Array(W * 4);
  all.forEach((p, i) => data.set([p[0], p[1], p[2], p[3]], i * 4));
  const ptex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat, THREE.FloatType);
  ptex.minFilter = ptex.magFilter = THREE.NearestFilter;
  ptex.needsUpdate = true;

  const C = (h) => ({ value: new THREE.Color(h) });
  const u = {
    ...G, ...skyDomeUniforms(), ...(o.uniforms ?? {}),
    uZenith: C('#1c5ed2'), uMid: C('#55a5ef'), uHorizonWarm: C('#f3f7f0'), uHorizonCool: C('#c3e2f7'),
    uCloudLit: C('#ffffff'), uCloudMid: C('#e8eefa'), uCloudShade: C('#a2b0de'),
    uCloudDrift: { value: 0 }, uSunDisk: { value: 1 },
    uPuffs: { value: ptex },
    uTower: { value: tb },
    uTowerI: { value: ti },
    uNTowers: { value: Math.min(MAXT, clouds.towers.length) },
  };

  const vs = /* glsl */ `
    varying vec3 vDir;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = normalize(wp.xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * wp;
      gl_Position.z = gl_Position.w * 0.99999;
    }
  `;

  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    ${CLOUD_NOISE}
    uniform vec3 uZenith, uMid, uHorizonWarm, uHorizonCool, uCloudLit, uCloudMid, uCloudShade;
    uniform vec3 uDeckDark, uDeckMid, uDeckLit;
    uniform float uCloudDrift, uSunDisk, uNTowers, uOvercast, uAfterRain, uSideRays;
    uniform vec2 uCloudShift;
    uniform vec4 uFlash;
    uniform sampler2D uPuffs;
    uniform vec4 uTower[${MAXT}];
    uniform vec4 uTowerI[${MAXT}];
    varying vec3 vDir;
    const float D2R = 0.0174532925;

    float fbm2p(vec2 p){
      float v = 0.0, a = 0.5;
      mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
      for(int i = 0; i < 4; i++){ v += a * cN(p); p = rot * p * 2.03 + 1.7; a *= 0.5; }
      return v;
    }

    void main(){
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      vec3 d = normalize(vDir);
      vec3 s = normalize(uSunDir);
      float el = d.y;
      float elD = asin(clamp(el, -1.0, 1.0)) / D2R;
      float azD = atan(d.x, -d.z) / D2R;
      float toSun = dot(d, s);
      float sunSide = dot(normalize(d.xz + 1e-5), normalize(s.xz + 1e-5)) * 0.5 + 0.5;

      // ---- 1. 基础水粉天空渐变 + 太阳方向柔光
      vec3 hor = mix(uHorizonCool, uHorizonWarm, smoothstep(0.28, 0.98, sunSide));
      float h = max(elD, 0.0);
      vec3 col = mix(hor, uMid, smoothstep(0.0, 16.0, h));
      col = mix(col, uZenith, smoothstep(10.0, 75.0, h));
      float sunVis = (1.0 - smoothstep(0.20, 0.65, uOvercast)) * uSunDisk;
      float glow = pow(max(toSun, 0.0), 10.0);
      col = mix(col, mix(hor, vec3(1.0, 0.96, 0.88), 0.48), glow * 0.52 * sunVis);
      col += vec3(1.15, 1.04, 0.88) * smoothstep(0.9991, 0.9996, toSun) * sunVis * (1.0 - 0.35 * uAfterRain);
      col = mix(col, hor * 0.98, step(el, 0.0));

      // ---- 2. 高空细卷云丝（晴空与雨后云开处隐约可见的手绘刷痕）
      if(el > 0.04 && uOvercast < 0.85){
        vec2 cp = d.xz / (el + 0.24);
        vec2 cr = vec2(cp.x * 0.82 + cp.y * 0.57, -cp.x * 0.57 + cp.y * 0.82);
        float ci = fbm2p(cr * vec2(0.85, 4.8) + vec2(3.1, uCloudShift.x * 0.35)) * fbm2p(cr * 0.45 + 11.3);
        float wisp = smoothstep(0.27, 0.37, ci) * smoothstep(0.08, 0.34, el) * (1.0 - uOvercast);
        vec3 wispCol = mix(col, mix(uCloudLit, uHorizonWarm, 0.35 * uAfterRain), 0.68);
        col = mix(col, wispCol, wisp * 0.30);
      }

      // ---- 3. 平滑并集绘画积云塔（多项式 smooth-union 融合团块，彻底消除鱼鳞圆圈接缝，呈现整块奶油亮面与水粉笔触边缘）
      vec3 east = normalize(vec3(-d.z, 0.0, d.x) + vec3(1e-6, 0.0, 0.0));
      vec3 upT = normalize(vec3(0.0, 1.0, 0.0) - d * el + vec3(0.0, 1e-6, 0.0));
      vec3 L = normalize(vec3(dot(s, east), dot(s, upT), dot(s, -d)));
      vec3 warp = vec3(fbm3(d * 10.5 + 1.7), fbm3(d * 10.5 + 8.3), fbm3(d * 10.5 + 4.9)) - 0.5;
      float edgeN = fbm3(d * 20.0 + warp * 1.4 + 3.1 + vec3(uCloudShift * 0.12, 0.0)) - 0.5;
      float edgeN2 = vnoise3(d * 54.0) - 0.5;
      float ce = cos(elD * D2R);
      float maxE = -1.2;
      vec3 bnSum = vec3(0.0);
      float wSum = 0.0, bHaze = 0.0, bBase = 0.0, bTop = 18.0;
      for(int ti = 0; ti < ${MAXT}; ti++){
        if(float(ti) >= uNTowers) break;
        vec4 tbv = uTower[ti];
        float daz = mod(azD - tbv.x - uCloudDrift + 540.0, 360.0) - 180.0;
        if(abs(daz) > tbv.y || elD < tbv.z || elD > tbv.w) continue;
        vec4 tinf = uTowerI[ti];
        int st = int(tinf.x + 0.5), cnt = int(tinf.y + 0.5);
        float cut = tinf.w;
        for(int k = 0; k < 64; k++){
          if(k >= cnt) break;
          vec4 P = texelFetch(uPuffs, ivec2(st + k, 0), 0);
          float dx = (mod(azD - P.x - uCloudDrift + 540.0, 360.0) - 180.0) * ce;
          float dy = elD - P.y;
          float q2 = (dx * dx + dy * dy) / (P.z * P.z);
          if(q2 > 2.2) continue;
          float e = 1.0 - q2 + (edgeN * 0.68 + edgeN2 * 0.20) * (0.68 + 2.4 / (P.z + 1.5));
          e -= max(cut - elD, 0.0) * 0.95;
          // 多项式 smooth-max：将相邻圆团融合成连续的菜花状水粉云体，绝不出鱼鳞圆环
          float ks = 0.38;
          float hSm = clamp(0.5 + 0.5 * (e - maxE) / ks, 0.0, 1.0);
          maxE = mix(maxE, e, hSm) + ks * hSm * (1.0 - hSm);
          if(e > -0.25){
            float wt = pow(max(e + 0.25, 0.001), 2.2) * (1.0 + 0.12 * P.w);
            bnSum += normalize(vec3(dx / P.z, dy / P.z, sqrt(max(e, 0.02)) + 0.35)) * wt;
            if(wt > wSum){ bHaze = tinf.z; bBase = max(cut, tbv.z); bTop = tbv.w; }
            wSum += wt;
          }
        }
      }
      float occ = 0.0;                                   // 云遮光率 → data.r（ATMOS slanted 光束读它判断云隙）
      float fwE = max(fwidth(maxE), 1e-4);
      if(maxE > -0.5 && wSum > 0.0){
        float cov = smoothstep(-fwE * 0.8, fwE * 1.1, maxE);
        // 雨后左侧太阳窗口（sunSide 高处）远云柔化退让，突出单侧云开暖金天空
        cov *= 1.0 - 0.55 * uAfterRain * smoothstep(0.62, 0.92, sunSide);
        vec3 bn = normalize(bnSum);
        float sculpt = fbm3(d * 14.0 + warp * 1.2 + 5.0) - 0.5;
        vec3 nn = normalize(bn + vec3(sculpt * 0.42, (edgeN + sculpt * 0.6) * 0.48, 0.0));
        float lit = dot(nn, L) + bn.y * 0.18;
        float bandN = fbm3(d * 28.0 + 2.1) - 0.5;
        float tLit = smoothstep(-0.06, 0.05, lit + bandN * 0.18);
        float tHi = smoothstep(0.36, 0.48, lit + bandN * 0.14);
        float back = smoothstep(0.28, 0.95, toSun);
        vec3 shadeC = mix(uCloudShade, mix(uCloudShade, uCloudMid, 0.42), back);
        vec3 cc = mix(shadeC, uCloudMid, tLit);
        cc = mix(cc, uCloudLit, tHi);
        float hgt = clamp((elD - bBase) / max(bTop - bBase, 1.0), 0.0, 1.0);
        // 云底平缓薰衣草灰暗腹（仅在云体下沿柔和过渡）
        cc = mix(cc, mix(uCloudShade, uCloudMid, 0.22) * vec3(0.96, 0.97, 1.02), smoothstep(0.28, 0.0, hgt) * 0.58 * (1.0 - tHi));
        float thin = 1.0 - smoothstep(0.0, 0.34, maxE);
        float rimDir = clamp(dot(normalize(bn.xy + 1e-4), normalize(L.xy + 1e-4)) * 0.5 + 0.5, 0.0, 1.0);
        cc = mix(cc, uCloudLit * vec3(1.14, 1.08, 0.96), thin * rimDir * back * 0.92);
        cc = mix(cc, hor, clamp(smoothstep(8.5, 0.0, elD) * (0.58 - 0.22 * back) + bHaze, 0.0, 0.88));
        col = mix(col, cc, cov);
        occ = cov;
      }

      // ---- 4. 起风转阴与暴雨石板蓝水粉云层（uOvercast 0→1，从迎风侧平滑增厚覆盖全天）
      if(uOvercast > 0.002 && el > -0.02){
        vec2 uvC = d.xz / (max(el, 0.02) + 0.16);
        vec2 q = uvC * 0.42 + uCloudShift * 0.22;
        float nBig = fbm2p(q * vec2(0.85, 1.25));
        float nMid = fbm2p(q * 2.3 + 4.7);
        float nFine = cN(q * 5.8 + 9.2);
        float field = nBig * 0.62 + nMid * 0.28 + nFine * 0.10;
        // 起风初段先以成片水粉云絮涌起，暴雨前连成浑厚石板蓝云幕
        float thresh = mix(0.68, 0.08, smoothstep(0.0, 0.88, uOvercast));
        float mask = smoothstep(thresh, thresh + 0.16, field) * smoothstep(0.0, 0.18, uOvercast);
        mask = max(mask, smoothstep(0.72, 0.98, uOvercast));
        // 云底三阶绘画色块（暗腹 / 中灰蓝 / 受微光的石板蓝云缝）
        vec3 dc = mix(uDeckDark, uDeckMid, smoothstep(0.36, 0.52, field));
        dc = mix(dc, uDeckLit, smoothstep(0.58, 0.72, field) * (1.0 - 0.35 * uOvercast));
        // 闪电在云层内部透出的蓝白光晕
        float fl = uFlash.w * pow(max(dot(d, normalize(uFlash.xyz)), 0.0), 4.0);
        dc += vec3(0.74, 0.80, 0.98) * fl * (0.38 + 0.62 * field);
        // 地平线处柔和融入远海雾气，绝无生硬切线
        dc = mix(mix(hor, uDeckMid, 0.65), dc, smoothstep(0.0, 0.14, max(el, 0.0)));
        col = mix(col, dc, clamp(mask, 0.0, 1.0));
        occ = max(occ, clamp(mask, 0.0, 1.0));
      }

      // ---- 5. 雨后单侧云开与柔和斜射晨光/夕照（左侧云散透出斜光，右侧天际残留退去的淡紫灰雨云）
      if(uAfterRain > 0.01 && el > -0.02){
        // 右侧（+X，azD > 8°）远去的残余灰紫云层，衬托左侧晴朗暖金云隙
        float eastSide = smoothstep(${f(rem.az0)}, ${f(rem.az1)}, azD + 8.0 * (cN(vec2(elD * 0.08, 1.7)) - 0.5));
        vec2 uvR = d.xz / (max(el, 0.03) + 0.18);
        float rCloud = fbm2p(uvR * 0.55 + uCloudShift * 0.15 + 6.1);
        float rMask = eastSide * smoothstep(0.38, 0.62, rCloud) * smoothstep(0.01, 0.18, el) * 0.68 * uAfterRain;
        vec3 remCol = mix(uCloudShade * vec3(0.86, 0.86, 0.98), uCloudMid * vec3(0.95, 0.90, 0.94), smoothstep(0.46, 0.68, rCloud));
        // 朝左侧太阳的云缘镶一道柔和金边
        float edgeGlow = (1.0 - smoothstep(0.42, 0.58, rCloud)) * smoothstep(0.15, 0.75, sunSide);
        remCol = mix(remCol, uHorizonWarm * vec3(1.08, 0.95, 0.78), edgeGlow * 0.65);
        col = mix(col, remCol, rMask);
        occ = max(occ, rMask);

        // 左侧单侧平行斜射柔光幕（宽阔柔和的斜向暖金云隙霞光，从左上云裂处斜洒海面，非 360° 轮辐）
        if(uSideRays > 0.01 && sunSide > 0.32){
          float diag = (azD - (${f(rays.az)})) * 0.76 + (elD - ${f(rays.el)}) * 0.65;
          float beam1 = exp(-pow((diag + 5.0) / 7.5, 2.0));
          float beam2 = exp(-pow((diag - 8.5) / 9.0, 2.0)) * 0.82;
          float beam3 = exp(-pow((diag - 22.0) / 8.0, 2.0)) * 0.54;
          float beam4 = exp(-pow((diag + 17.5) / 6.5, 2.0)) * 0.45;
          float envEl = smoothstep(-2.0, 3.5, elD) * (1.0 - smoothstep(18.0, 38.0, elD));
          float envAz = smoothstep(0.35, 0.82, sunSide);
          float shaft = (beam1 + beam2 + beam3 + beam4) * envEl * envAz * uSideRays;
          col += vec3(1.12, 0.90, 0.58) * shaft * 0.46;
        }
      }

      // 闪电瞬间整片天幕微泛冷白蓝光
      col += vec3(0.55, 0.62, 0.80) * uFlash.w * 0.34 * smoothstep(-0.08, 0.35, el);
      writeOut(col, 1.0, vec3(${o.writeOcc === false ? '0.0' : 'occ'}, 0.0, 1.0), 9000.0, 0.0);
    }
  `;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: u,
    vertexShader: vs,
    fragmentShader: fs,
    side: THREE.BackSide,
    depthWrite: false,
  });
}
