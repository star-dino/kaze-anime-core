import * as THREE from 'three';
import { G } from './glsl.js';
import { hash, smooth, invLerp } from './util.js';

// 雨（W8，移植自 Sunshower src/fx-rain.js + fx-overlay.js 的 rainMaterial，MIT）和远方雨幕（W9，新写）。
// 都画在 overlay 场景里（水面、大气之后；没有深度缓冲，自己读 uSceneData.b 的场景深度做遮挡）。
// 全部是 t 的纯函数：雨丝位置 = 种子 + 速度 × 时间，在跟着相机走的盒子里按世界坐标取模，不累积任何状态。
//
//   const rain = new RainField();                  overlay.add(rain.mesh)
//   rain.update({ camera, t, amount, shelter })    shelter = { x, y, z, rx, rz, rot } —— 椭圆脚印以上的高度挡雨（角色伏身挡雨）
//   const wall = new RainCurtain();                overlay.add(wall.mesh)
//   wall.update({ camera, t, amount, origin:[x,z], dir:[x,z], dist, color, foam, sea, lean })
//   field.update({ camera, t, amount: RainCurtain.nearRain(dist) })   雨墙推到眼前（dist → 0）时交接给近处雨丝
//   armorMist(water, glows, points, t, { amount, radius, seed })     暴雨砸在角色朝上的面上弹起的白水刺 + 薄雾（W8）
//
// 风：雨丝的倾斜读全局 G.uWind（look.wind），和草浪同一个风。
// 画风：Sunshower 的是逆光金色细雨丝（太阳雨）；这里默认是暗天的暴雨 —— 灰白、密、斜，没有闪光的雨滴头。

const H = /* glsl */ `
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
`;

// 近处少而粗、远处多而细（巨人尺度：机位离主体 1–60 m）
export const RAIN_LAYERS = [
  { n: 900, box: [9, 10, 9], dist: 4.0, len: [0.5, 1.1], wid: [0.006, 0.010], gain: 1.15 },
  { n: 4200, box: [30, 22, 30], dist: 14, len: [0.8, 1.8], wid: [0.008, 0.014], gain: 1.0 },
  { n: 6000, box: [90, 50, 90], dist: 46, len: [1.4, 3.2], wid: [0.016, 0.03], gain: 0.85 },
];

function rainMaterial(S) {
  const V3 = THREE.Vector3;
  const u = {
    uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uDraw: { value: 0 }, uRain: { value: 0 }, uS: { value: S },
    uCenter: { value: [new V3(), new V3(), new V3()] },
    uBox: { value: RAIN_LAYERS.map((L) => new V3(...L.box)) },
    uLayerGain: { value: new V3(...RAIN_LAYERS.map((L) => L.gain)) },
    uWindK: { value: 9 },                               // 风力 1 时的水平速度（m/s）
    uShelter: { value: new THREE.Vector4(0, 0, 0, 0) },
    uShelterB: { value: new THREE.Vector4(1, 1, 0, 0) },
    uColor: { value: new THREE.Color(0.82, 0.87, 0.92) },
    uWind: G.uWind, uSunDir: G.uSunDir, uSunColor: G.uSunColor, uSunStrength: G.uSunStrength, uWaterLevel: G.uWaterLevel,
  };
  const vs = /* glsl */ `
    attribute vec4 iSeed;   // 盒内位置 xyz (0..1), w 随机
    attribute vec4 iL;      // 层, 长度 (m), 宽度 (m), -
    uniform float uDraw, uRain, uS, uWaterLevel, uWindK;
    uniform vec3 uCenter[3];
    uniform vec3 uBox[3];
    uniform vec3 uLayerGain;
    uniform vec4 uWind;
    uniform vec3 uSunDir;
    uniform vec4 uShelter, uShelterB;
    uniform vec2 uRes;
    varying vec2 vQ;
    varying vec4 vK;
    varying float vDepth;
    varying float vF;
    ${H}
    void hide(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vK = vec4(0.0); vQ = vec2(0.0); vDepth = 0.0; vF = 0.0; }
    bool clipBelow(inout vec3 head, vec3 tail, float y){
      if(tail.y < y) return false;
      if(head.y < y) head = mix(tail, head, (tail.y - y) / max(tail.y - head.y, 1e-4));
      return true;
    }
    bool sheltered(vec3 p, vec4 S0, vec4 S1){
      if(S0.w <= 0.0) return false;
      vec2 d = p.xz - S0.xz;
      float c = cos(S1.z), s = sin(S1.z);
      d = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / S1.xy;
      return dot(d, d) < 1.0;
    }
    void main(){
      int L = int(iL.x + 0.5);
      vec3 B = uBox[L], C = uCenter[L];
      float key = fract(iSeed.w * 91.7 + iSeed.x * 13.3 + iSeed.z * 5.1);
      if(key > uRain){ hide(); return; }
      float speed = mix(9.0, 12.5, fract(iSeed.w * 17.9));
      float wv = 0.7 + 0.6 * fract(iSeed.w * 5.31 + iSeed.y * 2.7);
      vec2 wd = normalize(uWind.xy) * uWind.z * uWindK * wv;
      vec3 vel = vec3(wd.x, -speed, wd.y);
      vec3 lo = C - 0.5 * B;
      vec3 p = iSeed.xyz * B + vel * uDraw;
      p = mod(p - lo, B) + lo;
      vec3 e3 = min(p - lo, lo + B - p) / (0.08 * B);
      float edge = clamp(min(e3.x, min(e3.y, e3.z)), 0.0, 1.0);
      vec3 dir = normalize(vel);
      vec3 head = p, tail = p - dir * iL.y;
      if(!clipBelow(head, tail, uWaterLevel)){ hide(); return; }
      if(sheltered(head, uShelter, uShelterB)){
        if(!clipBelow(head, tail, uShelter.y)){ hide(); return; }
      }
      vec4 vh = viewMatrix * vec4(head, 1.0), vt = viewMatrix * vec4(tail, 1.0);
      if(vh.z > -0.35 || vt.z > -0.35){ hide(); return; }
      vec4 ch = projectionMatrix * vh, ct = projectionMatrix * vt;
      vec2 sh = ch.xy / ch.w * 0.5 * uRes, st = ct.xy / ct.w * 0.5 * uRes;
      vec2 d = sh - st;
      float len = length(d);
      vec2 ax = len > 1e-3 ? d / len : vec2(0.0, -1.0);
      vec2 nr = vec2(-ax.y, ax.x);
      float pxm = projectionMatrix[1][1] * 0.5 * uRes.y / -vh.z;
      float wpx = iL.z * pxm;
      float wdp = clamp(wpx, 0.8 * uS, 3.2 * uS);
      float thin = clamp(wpx / (0.8 * uS), 0.25, 1.0);
      float pad = 1.5 * uS;
      float s = position.y + 0.5;
      float across = position.x * 2.0 * (wdp * 0.5 + pad);
      float along = mix(-pad, len + pad, s);
      vec2 P = st + ax * along + nr * across;
      float z = mix(ct.z / ct.w, ch.z / ch.w, s);
      gl_Position = vec4(P / (0.5 * uRes), clamp(z, -1.0, 1.0), 1.0);
      vQ = vec2(across, along);
      vDepth = mix(-vt.z, -vh.z, s);
      vec3 V = normalize(head - cameraPosition);
      vF = smoothstep(-0.35, 0.95, dot(V, uSunDir));
      float base = mix(0.3, 0.7, fract(iSeed.w * 41.3)) * uLayerGain[L];
      float n = floor(uDraw * 12.0 + 0.5);
      float tw = h12(vec2(n * 1.37 + iSeed.y * 311.0, iSeed.w * 97.0 + iSeed.z * 13.0));
      float flash = tw > 0.95 ? 1.6 : (tw < 0.3 ? 0.75 : 1.0);
      vK = vec4(len, wdp, base * flash * edge * thin, 0.0);
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    uniform vec3 uSunColor, uColor;
    uniform float uSunStrength, uS;
    varying vec2 vQ;
    varying vec4 vK;
    varying float vDepth;
    varying float vF;
    out vec4 oColor;
    void main(){
      if(vK.z <= 0.0) discard;
      float sceneD = texture(uSceneData, gl_FragCoord.xy / uRes).b;
      if(sceneD > 0.0 && vDepth > sceneD + 0.05) discard;
      float len = vK.x, wd = vK.y;
      float ax = abs(vQ.x);
      float inLen = step(0.0, vQ.y) * step(vQ.y, len);
      float al = clamp(vQ.y / max(len, 1.0), 0.0, 1.0);
      float taper = 0.2 + 0.8 * al * al;
      vec3 c = mix(uColor, uSunColor, 0.25 * vF * uSunStrength);
      float aC = clamp(wd * 0.5 - ax + 0.5, 0.0, 1.0) * inLen * taper * clamp(vK.z * 1.35, 0.0, 0.9);
      // 宽的近处雨丝加一圈很淡的蓝灰边：在白装甲前面也看得见
      float rimOn = smoothstep(1.5 * uS, 2.6 * uS, wd);
      float aR = clamp(wd * 0.5 + 0.9 * uS - ax + 0.5, 0.0, 1.0) * (1.0 - clamp(wd * 0.5 - ax + 0.5, 0.0, 1.0)) * inLen * taper * rimOn * 0.35 * clamp(vK.z * 2.0, 0.0, 1.0);
      float a = aC + aR * (1.0 - aC);
      if(a < 0.004) discard;
      vec3 rimC = vec3(0.36, 0.44, 0.56);
      oColor = vec4(min(c, vec3(1.0)) * aC + rimC * aR * (1.0 - aC), a);
    }
  `;
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vs, fragmentShader: fs,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  // 预乘 over：永远不比雨丝本色更亮，不会把亮天推进泛光
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.premultipliedAlpha = true;
  return m;
}

export class RainField {
  constructor(o = {}) {
    const S = o.S ?? 1;
    const total = RAIN_LAYERS.reduce((a, l) => a + l.n, 0);
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const seed = new Float32Array(total * 4), lay = new Float32Array(total * 4);
    let k = 0;
    RAIN_LAYERS.forEach((L, li) => {
      for (let i = 0; i < L.n; i++, k++) {
        const h = (j) => hash(i, li * 31 + j, 977);
        seed.set([h(1), h(2), h(3), h(4)], k * 4);
        const len = (L.len[0] + (L.len[1] - L.len[0]) * h(5)) * (h(8) < 0.2 ? 0.5 : 1);
        lay.set([li, len, L.wid[0] + (L.wid[1] - L.wid[0]) * h(6), 0], k * 4);
      }
    });
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.setAttribute('iL', new THREE.InstancedBufferAttribute(lay, 4));
    g.instanceCount = total;
    this.mat = rainMaterial(S);
    if (o.color) this.mat.uniforms.uColor.value.set(o.color);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this._f = new THREE.Vector3();
  }
  // camera, t（建议传一拍二的时间）, amount 0..1, shelter?
  update({ camera, t, amount, shelter = null }) {
    const U = this.mat.uniforms;
    U.uDraw.value = t;
    U.uRain.value = amount;
    this.mesh.visible = amount > 0.004;
    if (!this.mesh.visible) return;
    camera.getWorldDirection(this._f);
    RAIN_LAYERS.forEach((L, li) => {
      const c = U.uCenter.value[li].copy(camera.position).addScaledVector(this._f, L.dist);
      c.y = Math.max(c.y, L.box[1] * 0.5 - 0.6);
    });
    if (shelter) { U.uShelter.value.set(shelter.x, shelter.y, shelter.z, 1); U.uShelterB.value.set(shelter.rx, shelter.rz, shelter.rot ?? 0, 0); }
    else U.uShelter.value.set(0, 0, 0, 0);
  }
}

// ------------------------------------------------------------------ 远方雨幕（W9）
// 一堵从海上推过来的雨墙：几层平行于前沿的竖直长条（雨帘，最前一层在前沿，后面几层往海里退 depth 米），
// 顶上是一面云底正面（下沿是一团团下垂的、画出来的清晰水彩边：边缘积色更深），脚下是一条被打白的海面线，
// 雨墙下和前方一段海面再铺一条深色半透明暗带（雨下的海是暗的；前方一段是阵风先压暗的水面）。
// 全部画在一个 instanced 网格里：实例顺序 = 绘制顺序（海面暗带 → 雨帘后层 → 前层 → 云底正面）。
// dist = 雨墙前沿离 origin 的距离（米），dir = 雨墙推进的方向（雨从 origin − dir × dist 那边来）。
//
// 交接给近处雨丝（dist → 0）：雨墙按 dist 在 fade = [近, 远] 米之间平滑淡出（片元离相机 nearFade 米以内也淡掉，
// 前沿穿过相机时不会被近裁面切出一条硬边），同时近处 RainField 按 RainCurtain.nearRain(dist, fade) 淡入：
//   wall.update({ t, amount: 1, origin, dir, dist })
//   field.update({ camera, t: onTwos(t), amount: RainCurtain.nearRain(dist) })
// 海面暗带不随 dist 淡出（雨到了头顶，海还是暗的）；sea: 0 关掉。
// 构造参数：{ width = 3200, height = 650（云顶）, depth = 120（层距）, base = 0.4（云底高度 / height）, layers = 4,
//            color（雨帘）, cloud（云底）, foam（海面白线）, sea = 0.5（暗带浓度）, seaColor, seaAhead = 140, seaBehind = 2400,
//            fade = [30, 240], nearFade = [20, 110] }。旧参数 n（帘子条数）已不再使用（接受但忽略）。
export class RainCurtain {
  constructor(o = {}) {
    const NL = Math.max(1, Math.min(8, o.layers ?? 4));
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1, 24, 1);
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    // 类型（0 海面暗带 / 1 雨帘 / 2 云底正面），层号（0 = 前沿），-，随机
    const inst = [[0, 0]];
    for (let L = NL - 1; L >= 0; L--) inst.push([1, L]);
    inst.push([2, 0]);
    const a = new Float32Array(inst.length * 4);
    inst.forEach(([ty, L], i) => a.set([ty, L, 0, hash(i, 3, 41)], i * 4));
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(a, 4));
    g.instanceCount = inst.length;
    this.fade = o.fade ?? [30, 240];
    const nf = o.nearFade ?? [20, 110];
    const u = {
      uSceneData: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
      uT: { value: 0 }, uAmt: { value: 0 }, uK: { value: 1 }, uLean: { value: 0 },
      uFront: { value: new THREE.Vector4(0, 0, 0, -1) },     // 前沿中心 xz, 推进方向 xz
      uSpan: { value: new THREE.Vector4(o.width ?? 3200, o.height ?? 650, o.depth ?? 120, o.base ?? 0.4) },
      uSea: { value: new THREE.Vector4(o.seaAhead ?? 140, o.seaBehind ?? 2400, o.sea ?? 0.5, NL) },
      uNear: { value: new THREE.Vector2(nf[0], nf[1]) },
      uColor: { value: new THREE.Color(o.color ?? '#5d6676') },
      uCloud: { value: new THREE.Color(o.cloud ?? '#3f4654') },
      uFoam: { value: new THREE.Color(o.foam ?? '#d8dee6') },
      uSeaC: { value: new THREE.Color(o.seaColor ?? '#1e2631') },
      uWaterLevel: G.uWaterLevel,
    };
    const vs = /* glsl */ `
      attribute vec4 iA;
      uniform vec4 uFront, uSpan, uSea;
      uniform float uWaterLevel, uLean;
      varying vec3 vW;          // 横向（米，跨实例连续）, 离海面高度（米）, 沿推进方向离前沿（米，+ = 前方）
      varying float vDepth, vType, vLayer, vDist;
      void main(){
        vec2 d = normalize(uFront.zw), sd = vec2(-d.y, d.x);
        float Hc = uSpan.y * uSpan.w;
        float lat = position.x * uSpan.x, s = position.y + 0.5;
        float h, along, y;
        if(iA.x < 0.5){
          // 海面暗带：贴水面的一张横片，前沿前方 uSea.x 米 → 后方 uSea.y 米
          along = mix(-uSea.y, uSea.x, s); h = 0.0; y = uWaterLevel + 0.03;
          along += uLean;
        } else {
          along = -iA.y * uSpan.z;
          // 雨帘：海面 → 云底以上一点（被云底正面盖住）；云底正面：从最深的下垂团块以下 → 云顶
          h = iA.x < 1.5 ? s * Hc * 1.12 : mix(Hc * 0.68, uSpan.y, s);
          y = uWaterLevel + h;
          along += uLean * clamp(1.0 - h / Hc, 0.0, 1.0);    // lean：雨脚比云底超前（米）
        }
        vec2 xz = uFront.xy + sd * lat + d * along;
        vec3 P = vec3(xz.x, y, xz.y);
        vec4 mv = viewMatrix * vec4(P, 1.0);
        vW = vec3(lat, h, along - (iA.x < 0.5 ? uLean : 0.0));
        vDepth = -mv.z; vType = iA.x; vLayer = iA.y; vDist = length(P - cameraPosition);
        gl_Position = projectionMatrix * mv;
      }
    `;
    const fs = /* glsl */ `
      uniform sampler2D uSceneData;
      uniform vec2 uRes, uNear;
      uniform float uT, uAmt, uK;
      uniform vec4 uSpan, uSea;
      uniform vec3 uColor, uCloud, uFoam, uSeaC;
      varying vec3 vW;
      varying float vDepth, vType, vLayer, vDist;
      out vec4 oColor;
      ${H}
      void main(){
        float sceneD = texture(uSceneData, gl_FragCoord.xy / uRes).b;
        if(sceneD > 0.0 && vDepth > sceneD) discard;
        float W = uSpan.x, Ht = uSpan.y, Hc = Ht * uSpan.w;
        float lat = vW.x, h = vW.y, al = vW.z;
        float tq = floor(uT * 8.0) / 8.0;                  // 一拍三
        // 云底下沿（世界横向坐标的函数 → 所有实例同一条边）：大团块 + 中团块 + 小碎边
        float e = Hc * (1.0 - 0.16 * vn(vec2(lat * 0.0036, 3.1)) - 0.08 * vn(vec2(lat * 0.011, 5.7)) - 0.035 * vn(vec2(lat * 0.04, 8.9)));
        float dh = h - e;
        float aa = max(fwidth(dh), 1e-3);                  // 1 像素左右的抗锯齿：清晰但不出锯齿
        float ends = smoothstep(0.5, 0.36, abs(lat) / W);  // 整堵墙的两端淡出
        float nearK = smoothstep(uNear.x, uNear.y, vDepth);
        vec3 c; float a;
        if(vType < 0.5){
          // ---- 海面暗带：雨下的海是暗的，前方 uSea.x 米渐变（阵风压暗的水面），远处 uSea.y 米淡出
          float under = smoothstep(uSea.x, 0.0, al) * smoothstep(-uSea.y, -uSea.y * 0.5, al);
          float tex = 0.78 + 0.22 * vn(vec2(lat * 0.012, al * 0.05 + tq * 0.2));   // 横向风纹（不规则的暗块）
          a = uSea.z * under * tex * ends * uAmt;
          // 前沿脚下一条断续的白浪线（被打白的海面），宽约 6–14 米
          float fl = smoothstep(-14.0, -3.0, al) * smoothstep(4.0, 0.0, al) * smoothstep(0.35, 0.7, vn(vec2(lat * 0.05, tq * 2.0)));
          fl *= uK * uAmt * ends;
          c = mix(uSeaC, uFoam, fl / max(a + fl, 1e-3));
          a = max(a, fl * 0.85);
        } else if(vType < 1.5){
          // ---- 雨帘层：横向疏密（粗雨柱）× 竖向细丝（往下流）；上部被云底压暗，下部是雨打起的浅雾
          float L = vLayer, hk = h / Hc;
          float dens = 0.55 + 0.45 * smoothstep(0.2, 0.8, vn(vec2(lat * 0.0045 + L * 7.3, L * 3.1)));
          float streak = vn(vec2(lat * 0.11 + L * 13.0, h * 0.01 + tq * 1.1)) * 0.65 + vn(vec2(lat * 0.37 + L * 5.0, h * 0.03 + tq * 2.3)) * 0.35;
          streak = 0.62 + 0.38 * smoothstep(0.3, 0.8, streak);
          a = dens * streak * mix(0.82, 0.45, L / max(uSea.w - 1.0, 1.0));
          a *= smoothstep(1.12, 0.78, hk);                 // 顶部融进云底（后层顶边从前沿云底下面透出来时不出硬边）
          c = mix(uColor, uCloud, smoothstep(0.3, 1.0, hk) * 0.75);
          float mist = smoothstep(0.32, 0.0, hk);
          c = mix(c, mix(uColor, uFoam, 0.5), mist * 0.55);
          a = mix(a, max(a, 0.5), mist * 0.6);
          if(L < 0.5){
            // 前沿脚下：被打白的浪花 / 水雾（约 18 米高）
            float foam = smoothstep(18.0, 0.0, h) * (0.55 + 0.45 * vn(vec2(lat * 0.07, tq * 3.0)));
            c = mix(c, uFoam, foam);
            a = max(a, foam * 0.9);
          }
          a *= exp(-vDist * 0.00016);                      // 很远的更淡
          a *= ends * nearK * uK * uAmt;
        } else {
          // ---- 云底正面：清晰的团块下沿 + 水彩积色（边缘一条更深的色，越往上越淡、有大块的明暗笔触）
          float inC = smoothstep(-aa, aa, dh);
          float pool = exp(-max(dh, 0.0) / (0.045 * Hc));
          float wash = smoothstep(0.35, 0.8, vn(vec2(lat * 0.0028 + 1.7, h * 0.006)));
          c = mix(uCloud, min(uCloud * 1.22 + 0.025, vec3(1.0)), 0.55 * wash * (1.0 - pool));
          c = mix(c, uCloud * 0.74, pool * 0.7);
          a = inC * 0.95 * smoothstep(Ht, Ht * 0.7, h) * ends * nearK * uK * uAmt;
        }
        a = clamp(a, 0.0, 0.95);
        if(a < 0.004) discard;
        oColor = vec4(c * a, a);
      }
    `;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vs, fragmentShader: fs,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      premultipliedAlpha: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  // 近处雨丝的交接量（0..1）：比雨墙淡出稍早开始、稍晚结束，交叉淡变时画面里总有雨
  static nearRain(dist, fade = [30, 240]) { return 1 - smooth(invLerp(fade[0] * 0.5, fade[1] * 0.8, dist)); }
  // 雨墙本体在 dist 处的可见度（0..1）
  static wallK(dist, fade = [30, 240]) { return smooth(invLerp(fade[0], fade[1], dist)); }
  update({ t, amount = 1, origin = [0, 0], dir = [0, 1], dist = 1000, color, cloud, foam, sea, seaColor, lean }) {
    const U = this.mat.uniforms;
    const l = Math.hypot(dir[0], dir[1]) || 1, dx = dir[0] / l, dz = dir[1] / l;
    U.uFront.value.set(origin[0] - dx * dist, origin[1] - dz * dist, dx, dz);
    U.uT.value = t; U.uAmt.value = amount;
    U.uK.value = RainCurtain.wallK(dist, this.fade);
    if (color) U.uColor.value.set(color);
    if (cloud) U.uCloud.value.set(cloud);
    if (foam) U.uFoam.value.set(foam);
    if (seaColor) U.uSeaC.value.set(seaColor);
    if (sea != null) U.uSea.value.z = sea;
    if (lean != null) U.uLean.value = lean;
    this.mesh.visible = amount > 0.004 && (U.uK.value > 0.001 || U.uSea.value.z > 0.001);
  }
}

// ===================================================================== 水的笔画（W8 / W10，从《海岬的测风人》fx.js 下沉）
// 透光的水舌、水串、水花、雨滴拉丝：屏幕空间挤出的折线（世界半宽 r 米，至少 px 像素），预乘 alpha，
// 截面 = 半透明水身 + 一道偏左的高光 + 冷色细边（亮背景上也看得见）。读 uSceneData 做软遮挡（bias 米）。
//   const water = new WaterStrokeBatch(engine.S, 20000); overlay.add(water.mesh)
//   每帧：water.begin(); fallingDrop(...) / splashCrown(...) / eaveCurtain(...) / rainSplashes(...) / water.push(pts, o); water.end();
//   push(pts, { r, px, color:[r,g,b], alpha, taper(s), alphaFn(s), spec, bias })，pts = [[x,y,z], ...]
function waterStrokeMaterial(S = 1) {
  const u = {
    uSceneData: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uS: { value: S },
  };
  const vs = /* glsl */ `
    attribute vec3 aPrev;
    attribute vec3 aNext;
    attribute vec4 aA;      // side ±1, s(0..1), 世界半宽(m), 最小像素半宽(px)
    attribute vec4 aC;      // rgb, alpha
    attribute vec2 aM;      // 深度容差 bias(m), 高光强度
    uniform vec2 uRes;
    uniform float uS;
    varying float vSide, vS, vDepth, vBias, vSpec;
    varying vec4 vC;
    void main(){
      vSide = aA.x; vS = aA.y; vC = aC; vBias = aM.x; vSpec = aM.y;
      vec4 mv = viewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      if(mv.z > -0.12 || aC.a <= 0.001){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
      vec4 clip = projectionMatrix * mv;
      vec4 ca = projectionMatrix * viewMatrix * vec4(aPrev, 1.0);
      vec4 cb = projectionMatrix * viewMatrix * vec4(aNext, 1.0);
      vec2 da = (cb.xy / max(cb.w, 1e-3) - ca.xy / max(ca.w, 1e-3)) * 0.5 * uRes;
      float dl = length(da);
      vec2 tang = dl > 1e-3 ? da / dl : vec2(0.0, -1.0);
      vec2 nrm = vec2(-tang.y, tang.x);
      float pxPerM = projectionMatrix[1][1] * 0.5 * uRes.y / max(-mv.z, 0.15);
      float halfPx = clamp(max(aA.z * pxPerM, aA.w * uS), 0.70 * uS, 22.0 * uS);
      clip.xy += nrm * aA.x * halfPx * 2.0 / uRes * clip.w;
      gl_Position = clip;
    }
  `;
  const fs = /* glsl */ `
    uniform sampler2D uSceneData;
    uniform vec2 uRes;
    varying float vSide, vS, vDepth, vBias, vSpec;
    varying vec4 vC;
    out vec4 oColor;
    void main(){
      if(vC.a <= 0.002) discard;
      vec4 sd = texture(uSceneData, gl_FragCoord.xy / uRes);
      if(sd.b > 0.0 && vDepth > sd.b + vBias) discard;
      float ax = abs(vSide);
      float body = 1.0 - smoothstep(0.45, 0.98, ax);
      float glint = (1.0 - smoothstep(0.0, 0.42, abs(vSide + 0.18))) * vSpec;
      float rim = (1.0 - smoothstep(0.75, 1.0, ax)) * (1.0 - body) * 0.36;
      float a = clamp(vC.a * (body * 0.88 + glint * 0.35 + rim), 0.0, 0.94);
      if(a < 0.004) discard;
      vec3 rimCol = vec3(0.28, 0.35, 0.48);
      vec3 specCol = mix(vC.rgb, vec3(1.0, 0.98, 0.92), 0.65) * 1.06;
      vec3 col = mix(rimCol, vC.rgb, clamp(body * 1.15, 0.0, 1.0));
      col = mix(col, specCol, clamp(glint, 0.0, 1.0));
      oColor = vec4(col * a, a);
    }
  `;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vs, fragmentShader: fs,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    premultipliedAlpha: true,
  });
}

export class WaterStrokeBatch {
  constructor(S = 1, maxVerts = 18000) {
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    const mk = (n) => { const a = new THREE.BufferAttribute(new Float32Array(maxVerts * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aPrev = mk(3); this.aNext = mk(3); this.aA = mk(4); this.aC = mk(4); this.aM = mk(2);
    g.setAttribute('position', this.aPos); g.setAttribute('aPrev', this.aPrev); g.setAttribute('aNext', this.aNext);
    g.setAttribute('aA', this.aA); g.setAttribute('aC', this.aC); g.setAttribute('aM', this.aM);
    this.idx = new THREE.BufferAttribute(new Uint32Array(maxVerts * 3), 1);
    this.idx.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, waterStrokeMaterial(S));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.nv = 0; this.ni = 0;
  }
  begin() { this.nv = 0; this.ni = 0; }
  push(pts, o = {}) {
    const n = pts.length;
    if (n < 2 || this.nv + n * 2 > this.max) return;
    const r = o.r ?? 0.014, px = o.px ?? 1.1, col = o.color ?? [0.76, 0.84, 0.93];
    const al0 = o.alpha ?? 0.65, bias = o.bias ?? 0.06, spec = o.spec ?? 0.7;
    const base = this.nv;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const wk = o.taper ? o.taper(s) : 1;
      const ak = (o.alphaFn ? o.alphaFn(s) : 1) * al0;
      for (let sd = 0; sd < 2; sd++) {
        const k = this.nv++;
        this.aPos.array.set(p, k * 3);
        this.aPrev.array.set(a, k * 3);
        this.aNext.array.set(b, k * 3);
        this.aA.array.set([sd ? 1 : -1, s, r * wk, px * wk], k * 4);
        this.aC.array.set([col[0], col[1], col[2], ak], k * 4);
        this.aM.array.set([bias, spec], k * 2);
      }
      if (i < n - 1) {
        const q = base + i * 2, ia = this.idx.array, k = this.ni;
        ia[k] = q; ia[k + 1] = q + 1; ia[k + 2] = q + 2; ia[k + 3] = q + 1; ia[k + 4] = q + 3; ia[k + 5] = q + 2;
        this.ni += 6;
      }
    }
  }
  seg(x0, y0, z0, x1, y1, z1, o) {
    this.push([[x0, y0, z0], [x1, y1, z1]], o);
  }
  end() {
    this.geo.setDrawRange(0, this.ni);
    for (const a of [this.aPos, this.aPrev, this.aNext, this.aA, this.aC, this.aM, this.idx]) a.needsUpdate = true;
    this.mesh.visible = this.ni > 0;
  }
}

// 常用的截面（沿线 0..1 的宽度 / 透明度函数）
export const WATER_TAPER = {
  tongue: (s) => (1 - 0.65 * s) * (0.65 + 0.35 * Math.sin(Math.min(1, s * 3) * Math.PI * 0.5)),   // 檐口挂下的水舌：上粗下细
  tongueAlpha: (s) => 1 - s * s * 0.85,
  bead: (s) => Math.sin(s * Math.PI) * 0.85 + 0.25,                                                // 断续水串的一节
  wind: (s) => Math.sin(s * Math.PI),                                                               // 风丝：两头尖
  drop: (s) => 0.25 + 0.95 * Math.pow(s, 0.65) * Math.sin(Math.min(1, (1 - s) * 2.6 + 0.25) * Math.PI * 0.5),   // 下落雨滴：头圆尾尖
};
const _wa = new THREE.Vector3(), _wb = new THREE.Vector3();
const v3w = (p, out) => (p.isVector3 ? out.copy(p) : out.set(p[0], p[1], p[2]));

// 一滴雨从 height 米高处落到 p（tHit 时刻落地），落地后炸开一圈小水花（splashCrown）。dur = 下落时长
export function fallingDrop(batch, p, t, tHit, o = {}) {
  const P = v3w(p, _wa), dur = o.dur ?? 0.24, h = o.height ?? 3.2, slant = o.slant ?? 0.22, wd = o.wind ?? [0, 0];
  const u = (t - (tHit - dur)) / dur;
  if (u >= 0 && u <= 1) {
    const yBot = P.y + h * (1 - u), yTop = yBot + (o.tail ?? 0.42);
    batch.seg(P.x - (yTop - P.y) * wd[0] * slant, yTop, P.z - (yTop - P.y) * wd[1] * slant,
      P.x - (yBot - P.y) * wd[0] * slant, yBot, P.z - (yBot - P.y) * wd[1] * slant,
      { r: o.r ?? 0.011, px: o.px ?? 2.1, color: o.color, alpha: o.alpha ?? 0.86, taper: WATER_TAPER.drop, spec: 0.95, bias: 0.04 });
  }
  splashCrown(batch, P, t, tHit, o.crown ?? {});
}

// 落点 p、时刻 t0 炸开的放射小水花皇冠（n 根水刺，life 秒内张开、跳起、淡出）
export function splashCrown(batch, p, t, t0, o = {}) {
  const dt = t - t0, life = o.life ?? 0.24;
  if (dt < 0 || dt >= life) return;
  const P = v3w(p, _wb), q = dt / life, fade = 1 - q, n = o.n ?? 5, R = o.radius ?? 0.25, Hh = o.height ?? 0.13, seed = o.seed ?? 0;
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2 + seed * 0.9;
    const rad = (R * 0.2 + R * 0.8 * q) * (0.8 + 0.4 * hash(seed, k, 919));
    const dy = Hh * Math.sin(q * Math.PI);
    batch.seg(P.x + Math.cos(ang) * rad * 0.4, P.y + dy * 0.55, P.z + Math.sin(ang) * rad * 0.4,
      P.x + Math.cos(ang) * rad, P.y + dy, P.z + Math.sin(ang) * rad,
      { r: o.r ?? 0.0075, px: o.px ?? 1.45, color: o.color, alpha: (o.alpha ?? 0.84) * fade, taper: WATER_TAPER.tongue, spec: 1.0, bias: 0.04 });
  }
}

// 檐口水帘（W10）：从边 a → b 挂下 n 股水舌，下面是往下坠的断续水串，砸到地面溅起小水花。
//   o = { n = 24, k = 强度 0..1, wind:[x,z], ground:(x,z)=>y, colors:[[r,g,b]...], seed, fall = 6.8 (m/s), splash = true }
//   t 建议用 onThrees(t)（水是一拍三）。全部由 (边, 序号, t) 闭式算出。
export function eaveCurtain(batch, a, b, t, o = {}) {
  const A = v3w(a, _wa).clone(), B = v3w(b, _wb).clone();
  const n = o.n ?? 24, k = o.k ?? 1, wd = o.wind ?? [0, 0], seed = o.seed ?? 307;
  const ground = o.ground ?? (() => Math.min(A.y, B.y) - 3), cols = o.colors ?? [[0.81, 0.86, 0.91], [0.92, 0.95, 0.99]];
  if (k <= 0.01) return;
  for (let i = 0; i < n; i++) {
    const h0 = hash(i, 11, seed), h1 = hash(i, 23, seed), h2 = hash(i, 37, seed);
    const u = (i + 0.15 + 0.7 * h0) / n;
    const ox = A.x + (B.x - A.x) * u + (h1 - 0.5) * 0.04, oy = A.y + (B.y - A.y) * u, oz = A.z + (B.z - A.z) * u;
    const gy = ground(ox + wd[0] * 0.3, oz + wd[1] * 0.3), fallH = Math.max(0.5, oy - gy);
    const col = cols[Math.floor(h2 * cols.length) % cols.length];
    const tongueL = (0.36 + 0.64 * h1 * h1) * (0.65 + 0.35 * k), drift = 0.09 * tongueL;
    batch.push([[ox, oy + 0.02, oz], [ox + wd[0] * drift * 0.4, oy - tongueL * 0.5, oz + wd[1] * drift * 0.4], [ox + wd[0] * drift, oy - tongueL, oz + wd[1] * drift]],
      { r: 0.015 + 0.015 * h0, px: 1.55 + 0.95 * h0, color: col, alpha: (0.54 + 0.28 * h2) * k, taper: WATER_TAPER.tongue, alphaFn: WATER_TAPER.tongueAlpha, spec: 0.92 });
    const spd = (o.fall ?? 6.8) + 3.4 * h1, nb = i % 2 === 0 ? 3 : 2;
    for (let j = 0; j < nb; j++) {
      const ph = (t * spd / fallH + h2 + j / nb + h0 * 0.37) % 1;
      const yTop = oy - ph * fallH, segL = Math.min(0.28 + 0.58 * hash(i * 7 + j, 51, seed), yTop - gy);
      if (segL < 0.05) continue;
      const d0 = (oy - yTop) * 0.12, d1 = (oy - (yTop - segL)) * 0.12;
      batch.seg(ox + wd[0] * d0, yTop, oz + wd[1] * d0, ox + wd[0] * d1, yTop - segL, oz + wd[1] * d1,
        { r: 0.011 + 0.01 * h1, px: 1.35 + 0.85 * h1, color: col, alpha: (0.48 + 0.3 * h0) * k * (1 - 0.22 * ph), taper: WATER_TAPER.bead, spec: 0.88 });
    }
    if (o.splash !== false && i % 2 === 0) {
      const st = Math.floor(t * 8 + i * 1.7), s0 = hash(st, i, 509), s1 = hash(st + 13, i, 509);
      if (s0 > 0.34) {
        const lx = ox + wd[0] * fallH * 0.12, lz = oz + wd[1] * fallH * 0.12, ly = ground(lx, lz) + 0.01;
        const hs = (0.07 + 0.13 * s1) * k, spr = 0.05 + 0.08 * s0;
        batch.seg(lx, ly, lz, lx + spr, ly + hs, lz + (s1 - 0.5) * 0.08, { r: 0.006, px: 0.9, color: cols[cols.length - 1], alpha: 0.5 * k, taper: WATER_TAPER.tongue });
        batch.seg(lx, ly, lz, lx - spr * 0.85, ly + hs * 0.85, lz - (s0 - 0.5) * 0.08, { r: 0.006, px: 0.9, color: cols[cols.length - 1], alpha: 0.45 * k, taper: WATER_TAPER.tongue });
      }
    }
  }
}

// 雨打地面 / 水面的溅落（W8）：在以 center 为中心、半径 radius 的圆盘里，每一张原画（一拍三）随机冒出一批小水花。
//   o = { center:[x,z], radius, ground:(x,z)=>y, amount 0..1（雨量）, rate = 每平方米每秒几个, seed, color, water:(x,z)=>bool（是水面就画涟漪状的扁水花） }
export function rainSplashes(batch, t, o = {}) {
  const amt = o.amount ?? 1; if (amt <= 0.01) return;
  const [cx, cz] = o.center ?? [0, 0], R = o.radius ?? 6, ground = o.ground ?? (() => 0), seed = o.seed ?? 71;
  const area = Math.PI * R * R, step = Math.floor(t * 8 + 1e-6), per = Math.min(400, Math.round(area * (o.rate ?? 6) * amt / 8));
  const col = o.color ?? [0.9, 0.94, 0.99];
  for (let s = 0; s < 2; s++) {                     // 当前一张 + 上一张（每朵水花活两张原画 = 0.25 s）
    const st = step - s, q = (t * 8 - st) / 2;        // q: 0..1 这朵的年龄
    for (let i = 0; i < per; i++) {
      const r = R * Math.sqrt(hash(st, i, seed)), a = hash(st, i, seed + 1) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = ground(x, z) + 0.01, h = hash(st, i, seed + 2);
      const flat = o.water?.(x, z);
      const hs = (flat ? 0.03 : 0.05 + 0.07 * h) * Math.sin(Math.min(1, q * 1.4) * Math.PI), spr = (0.03 + 0.05 * h) * (0.4 + q);
      const al = (1 - q) * (0.35 + 0.35 * h) * amt, rot = hash(st, i, seed + 3) * Math.PI * 2;
      for (let k = 0; k < 3; k++) {                   // 三根短水刺的小皇冠，朝向随机（避免一排排 V 字）
        const a2 = rot + k * 2.094 + (hash(st, i * 3 + k, seed + 4) - 0.5) * 0.8, l = spr * (0.7 + 0.6 * hash(st, i * 3 + k, seed + 5));
        batch.seg(x + Math.cos(a2) * l * 0.25, y, z + Math.sin(a2) * l * 0.25, x + Math.cos(a2) * l, y + hs * (0.75 + 0.5 * hash(st, k, i)), z + Math.sin(a2) * l,
          { r: 0.004, px: 0.8, color: col, alpha: al, taper: WATER_TAPER.tongue });
      }
    }
  }
}

// 盔甲雨雾（W8）：暴雨砸在角色朝上的面（肩甲、前臂顶、头顶）上，弹起一簇簇往上飞的白色短水刺 + 一层贴着表面的薄雾。
//   armorMist(water, glows, points, t, { amount, radius, seed, size, n, wind:[x,z], color, mistColor, mist, bias })
//   points：调用方每帧从 rig 上采样的世界坐标锚点，每项是 [x,y,z] | Vector3 | { p, n?:[x,y,z]（表面法线）, r?（该点半径）, w?（权重）}；
//           给了法线就只在朝上的面出水花（n.y < 0.15 不出，越朝上越密），水刺沿法线 + 向外张开；不给法线 = 水平朝上的面。
//   water：WaterStrokeBatch（短水刺，可为 null）；glows：fx.js 的 GlowBatch（kind soft 的薄雾团，可为 null）。
//   radius = 每个锚点的散布半径（米），size = 水刺长度（默认 radius × 0.7），n = 每张原画每个锚点的水刺数（默认 4），
//   mist = 薄雾强度（默认 1；薄雾是叠加光，在白装甲上几乎看不见，在暗背景前才显出来），bias = 遮挡容差（米，默认 radius × 0.6）。
//   t 原样传 st.t：内部按一拍三（8 张/秒）换原画，每簇水刺活两张原画（0.25 s）并在其间上升、张开、淡出。
//   全部由 (seed, 锚点序号, 原画张数, t) 闭式算出，不累积任何状态。
const _ma = new THREE.Vector3(), _mn = new THREE.Vector3(), _mt = new THREE.Vector3(), _mb = new THREE.Vector3(), _mg = new THREE.Vector3(), _md = new THREE.Vector3();
export function armorMist(batch, glows, points, t, o = {}) {
  const amt = o.amount ?? 1;
  if (amt <= 0.01 || !points || !points.length) return;
  const R0 = o.radius ?? 0.3, seed = o.seed ?? 613, nS = o.n ?? 4, wd = o.wind ?? [0, 0];
  const col = o.color ?? [0.93, 0.96, 1.0], mcol = o.mistColor ?? [0.62, 0.7, 0.8], mist = o.mist ?? 1;
  const f = t * 8 + 1e-6, step = Math.floor(f);
  for (let i = 0; i < points.length; i++) {
    const it = points[i], pp = it.p ?? it;
    v3w(pp, _ma);
    const hasN = !!it.n;
    if (hasN) v3w(it.n, _mn).normalize(); else _mn.set(0, 1, 0);
    const facing = hasN ? Math.min(1, Math.max(0, (_mn.y - 0.15) / 0.55)) : 1;
    const k = amt * (it.w ?? 1) * facing;
    if (k < 0.02) continue;
    const r = it.r ?? R0, size = o.size ?? r * 0.7, bias = o.bias ?? r * 0.6;
    // 切平面基底
    _mt.set(Math.abs(_mn.y) < 0.9 ? 0 : 1, Math.abs(_mn.y) < 0.9 ? 1 : 0, 0).cross(_mn).normalize();
    _mb.crossVectors(_mn, _mt);
    for (let s = 0; s < 2; s++) {                        // 当前一张 + 上一张原画
      const st = step - s, q = Math.min(1, Math.max(0, (f - st) / 2));   // q：这一簇的年龄 0..1
      const grow = Math.sin(Math.min(1, q * 1.7) * Math.PI * 0.5), fade = 1 - q * q;
      for (let j = 0; j < nS; j++) {
        const key = i * 16 + j;
        if (hash(st, key, seed + 7) > 0.35 + 0.65 * k) continue;          // 雨小时稀疏
        const h0 = hash(st, key, seed), h1 = hash(st, key, seed + 1), h2 = hash(st, key, seed + 2), h3 = hash(st, key, seed + 3);
        const rad = r * Math.sqrt(h0), ang = h1 * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
        const bx = _ma.x + (_mt.x * ca + _mb.x * sa) * rad + _mn.x * 0.01;
        const by = _ma.y + (_mt.y * ca + _mb.y * sa) * rad + _mn.y * 0.01;
        const bz = _ma.z + (_mt.z * ca + _mb.z * sa) * rad + _mn.z * 0.01;
        // 方向：沿法线往上 + 向外张开（离中心越远张得越开）+ 顺风
        const spread = 0.35 + 0.9 * h2 * (0.4 + rad / Math.max(r, 1e-4));
        _md.set(_mn.x + (_mt.x * ca + _mb.x * sa) * spread + wd[0] * 0.5, _mn.y + (_mt.y * ca + _mb.y * sa) * spread, _mn.z + (_mt.z * ca + _mb.z * sa) * spread + wd[1] * 0.5).normalize();
        const len = size * (0.45 + 0.75 * h3) * (0.35 + 0.65 * grow);
        const off = size * 0.55 * q;                     // 整簇往外飞
        const sag = size * 0.35 * q * q;                 // 末端被重力往下拽一点
        batch?.push([
          [bx + _md.x * off, by + _md.y * off, bz + _md.z * off],
          [bx + _md.x * (off + len * 0.55), by + _md.y * (off + len * 0.55) - sag * 0.3, bz + _md.z * (off + len * 0.55)],
          [bx + _md.x * (off + len), by + _md.y * (off + len) - sag, bz + _md.z * (off + len)],
        ], { r: size * 0.035, px: 0.95, color: col, alpha: (0.5 + 0.35 * hash(st, key, seed + 4)) * k * fade, taper: WATER_TAPER.wind, spec: 0.75, bias });
      }
      // 薄雾：每张原画每个锚点一团，贴着表面往上飘、变大、淡出（kind 0 = GLOW.soft）
      if (glows && mist > 0) {
        const g0 = hash(st, i, seed + 11), g1 = hash(st, i, seed + 12), ga = g1 * Math.PI * 2, gr = r * 0.5 * g0;
        const up = r * (0.25 + 0.5 * q);
        _mg.set(_ma.x + (_mt.x * Math.cos(ga) + _mb.x * Math.sin(ga)) * gr + _mn.x * up + wd[0] * r * q,
          _ma.y + (_mt.y * Math.cos(ga) + _mb.y * Math.sin(ga)) * gr + _mn.y * up,
          _ma.z + (_mt.z * Math.cos(ga) + _mb.z * Math.sin(ga)) * gr + _mn.z * up + wd[1] * r * q);
        glows.push(_mg, { kind: 0, m: r * (0.9 + 0.6 * q), px: 0, color: mcol, power: 0.16 * mist * k * Math.sin(Math.min(1, q * 2 + 0.15) * Math.PI * 0.5) * (1 - q), mode: 0, bias: bias + r });
      }
    }
  }
}
