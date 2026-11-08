import * as THREE from 'three';
import { G } from './glsl.js';
import { deg, onThrees } from './util.js';

// 色彩脚本（color script）。原作的做法：定义两套完整调色板 A / B，
// 每个镜头只给一个 k ∈ [0,1] 在两者之间插值 —— 天空、雾、水、角色暗部、调色全部联动，
// 所以“阴天变晴”只需要动一个数字，而且永远不会出现某个部门忘了跟着变色。
//
// look = { k, sunElev, sunAz (0 = -Z，+ 朝 +X), key:[x,y,z]?, shafts, water, waterLevel,
//          fogMul, mistMul, paintRadius, inkWidth, shadow:{center,radius,depth}, cloudDrift,
//          stars?, lights?: [{ pos:[x,y,z], color:'#hex', radius:m, intensity }],
//          wind?: { dir:[x,z], strength 0..1, phase: 草浪行进距离 m（风力对时间的积分，故事层算好） },
//          presetWeights?: { 名字: 权重, … }（给了就不看 k，见 blendPresets），
//          shaftStyle?: 'radial' | 'slanted', shaftAngle?, shaftBeams?, shaftDown?, fadeSoft?（见 passes.js FINAL_FS），
//          vignette?, grain?, paper? 0..1, paperColor?（K5），cloudShadow?: { strength, scale, offset:[x,z] }（W5），
//          rainRings?: 0..1 | { amount, scale: 格子边长 m（默认 0.7） }（W8 雨打水面 + 水洼里的雨环；与 look.rain 无关，必须显式给），
//          puddles?: 0..1 | { amount, scale: 1/m（默认 0.22）, seed, sky:'#hex', zenith:'#hex' }（W10 地面水洼，
//                    只作用于 paintMaterial({ puddles: true }) / meadowGround(U, { puddles: true })） }
//
// 多段调色板：presets 可以给 2 套以上。每套可写 at（0..1，在 k 轴上的位置），不写就按顺序均匀分布；
// k 落在哪两套之间就在哪两套之间插值。两套时与旧行为完全一致（第一套 k=0，第二套 k=1）。
//   例：{ night:{at:0,...}, magic:{at:0.25,...}, gold:{at:0.6,...}, day:{at:1,...} } —— 从白天到星夜一条 k 走到底，
//   中间的“金暮”“逢魔时刻”是画师定的颜色，而不是首尾两套混出来的灰。
// 每套调色板可选：stars（0..1，星空亮度）、sky.star（星色）。look.stars 显式给出时覆盖调色板。
//
// 局部暖光：look.lights 给出的灯每帧重置；跟着角色走的灯（提着的灯笼）在部门的 update() 里调用 setLamp()
// （部门 update 在 applyLook 之后执行，会覆盖同一个槽位）。
export const DEFAULT_PRESETS = {
  // k = 0：薄云遮日（依旧明亮，只是更柔）
  soft: {
    sunColor: '#fff1dc', sunStrength: 0.74, skyTint: '#eef2fb', shadeTint: '#aab3dc', deepTint: '#7c84bc', bounce: '#c8e6e4',
    sky: { zenith: '#3f78cc', mid: '#86b6e6', warm: '#f6f7f4', cool: '#d4e4f1', cloudLit: '#fefeff', cloudMid: '#e4e9f4', cloudShade: '#a5aed2' },
    fog: { warm: '#f0f3f4', cool: '#d4e0ec', density: 0.0021, mist: 0.24, mistHeight: 5 },
    water: { deep: '#24808c', shallow: '#52b9b2', foam: '#f6fbff', skyRefl: '#cfdeec' },
    grade: { lift: '#191d2c', gain: '#fffefb', sat: 1.02 },
  },
  // k = 1：盛夏晴空（深蓝天顶、白积云、松石绿水面）
  summer: {
    sunColor: '#fff3dc', sunStrength: 1.0, skyTint: '#eaf3ff', shadeTint: '#a6b1e2', deepTint: '#7b85c6', bounce: '#c2f0e6',
    sky: { zenith: '#1c5ed2', mid: '#55a5ef', warm: '#f3f7f0', cool: '#c3e2f7', cloudLit: '#ffffff', cloudMid: '#e8eefa', cloudShade: '#a2b0de' },
    fog: { warm: '#eff5f2', cool: '#cde5f4', density: 0.0016, mist: 0.15, mistHeight: 4 },
    water: { deep: '#178796', shallow: '#43c6bd', foam: '#ffffff', skyRefl: '#b8dcf3' },
    grade: { lift: '#161c2e', gain: '#fffdf8', sat: 1.06 },
  },
};

const ca = new THREE.Color(), cb = new THREE.Color(), cl = new THREE.Color();
const MAX_LAMPS = 2;

// 设置第 i 个局部光（i < 2）。o = { pos:[x,y,z] | Vector3, color:'#hex' | Color, radius (m), intensity }；intensity 0 = 关
export function setLamp(i, o = {}) {
  if (i < 0 || i >= MAX_LAMPS) return;
  const P = G.uLampPos.value[i], C = G.uLampCol.value[i];
  const p = o.pos ?? [0, 0, 0];
  if (p.isVector3) P.set(p.x, p.y, p.z, o.radius ?? 4); else P.set(p[0], p[1], p[2], o.radius ?? 4);
  cl.set(o.color ?? '#ffb866');
  C.set(cl.r, cl.g, cl.b, o.intensity ?? 1);
}
export function clearLamps() { for (let i = 0; i < MAX_LAMPS; i++) G.uLampCol.value[i].set(0, 0, 0, 0); }

// 多段调色板：返回 [A, B, 段内 k]
function presetSegment(presets, k) {
  const keys = Object.keys(presets);
  if (keys.length === 1) return [presets[keys[0]], presets[keys[0]], 0];
  const list = keys.map((n, i) => ({ p: presets[n], at: presets[n].at ?? i / (keys.length - 1) })).sort((a, b) => a.at - b.at);
  if (k <= list[0].at) return [list[0].p, list[0].p, 0];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (k <= b.at) return [a.p, b.p, b.at > a.at ? (k - a.at) / (b.at - a.at) : 1];
  }
  const last = list[list.length - 1].p;
  return [last, last, 0];
}
// 命名权重混合（C5）：presetWeights = { summer: 0.2, gale: 0.8 } → 按权重（自动归一化）把几套调色板混成一套。
// 适合“盛夏 / 起风 / 暴雨 / 雨后”这种 4 套以上、不在一条直线上的状态：k 轴分段插值从 A 走到 C 必然路过 B，
// 权重混合可以从任意一套直接走向任意一套。颜色在显示空间线性混合（与 k 轴插值同一种算法）。
function blendPresets(presets, weights) {
  const ws = Object.entries(weights).filter(([n, w]) => presets[n] && w > 0);
  const tot = ws.reduce((a, [, w]) => a + w, 0);
  if (!ws.length || tot <= 0) return null;
  const rec = (objs) => {
    const out = {}, keys = new Set(objs.flatMap(([o]) => (o ? Object.keys(o) : [])));
    for (const key of keys) {
      if (key === 'at') continue;
      const items = objs.map(([o, w]) => [o?.[key], w]).filter(([v]) => v !== undefined);
      const v0 = items[0][0], wt = items.reduce((a, [, w]) => a + w, 0);
      if (typeof v0 === 'number') out[key] = items.reduce((a, [v, w]) => a + v * w, 0) / wt;
      else if (typeof v0 === 'string' || v0?.isColor) {
        const c = new THREE.Color(0, 0, 0);
        for (const [v, w] of items) c.add(ca.set(v).multiplyScalar(w / wt));
        out[key] = c;
      } else if (typeof v0 === 'object') out[key] = rec(items);
      else out[key] = v0;
    }
    return out;
  };
  return rec(ws.map(([n, w]) => [presets[n], w / tot]));
}

const mixC = (target, a, b, k) => target.copy(ca.set(a)).lerp(cb.set(b), k);
const mixN = (a, b, k) => a + (b - a) * k;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function applyLook(ctx, look, presets = DEFAULT_PRESETS) {
  const blend = look.presetWeights && blendPresets(presets, look.presetWeights);
  const [A, B, k] = blend ? [blend, blend, 0] : presetSegment(presets, clamp01(look.k ?? 1));
  const el = deg(look.sunElev ?? 24), az = deg(look.sunAz ?? 150);
  G.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  mixC(G.uSunColor.value, A.sunColor, B.sunColor, k);
  G.uSunStrength.value = mixN(A.sunStrength, B.sunStrength, k);
  mixC(G.uSkyTint.value, A.skyTint, B.skyTint, k);
  mixC(G.uShadeTint.value, A.shadeTint, B.shadeTint, k);
  mixC(G.uDeepTint.value, A.deepTint, B.deepTint, k);
  mixC(G.uBounce.value, A.bounce, B.bounce, k);
  // 角色主光（anime cheat）：不给就跟太阳走
  if (look.key) G.uKeyDir.value.set(...look.key).normalize(); else G.uKeyDir.value.copy(G.uSunDir.value);
  // 风场（W1）：look.wind = { dir:[x,z], strength 0..1, phase(m) }。不给 = 强度 0（旧片逐像素不变）
  const wd = look.wind;
  if (wd && wd.strength > 0) G.uWind.value.set(wd.dir?.[0] ?? 0, wd.dir?.[1] ?? 1, wd.strength, wd.phase ?? 0);
  else G.uWind.value.set(0, 1, 0, 0);

  const sky = ctx.sky;
  if (sky) {
    const u = sky.material.uniforms;
    mixC(u.uZenith.value, A.sky.zenith, B.sky.zenith, k);
    mixC(u.uMid.value, A.sky.mid, B.sky.mid, k);
    mixC(u.uHorizonWarm.value, A.sky.warm, B.sky.warm, k);
    mixC(u.uHorizonCool.value, A.sky.cool, B.sky.cool, k);
    mixC(u.uCloudLit.value, A.sky.cloudLit, B.sky.cloudLit, k);
    mixC(u.uCloudMid.value, A.sky.cloudMid, B.sky.cloudMid, k);
    mixC(u.uCloudShade.value, A.sky.cloudShade, B.sky.cloudShade, k);
    u.uCloudDrift.value = look.cloudDrift ?? 0;
    u.uSunDisk.value = look.sunDisk ?? 1;
    if (u.uStars) {
      u.uStars.value = look.stars ?? mixN(A.stars ?? 0, B.stars ?? 0, k);
      mixC(u.uStarColor.value, A.sky.star ?? '#fff6e8', B.sky.star ?? '#fff6e8', k);
    }
  }
  clearLamps();
  (look.lights ?? []).forEach((l, i) => setLamp(i, l));
  const e = ctx.engine;
  const a = e.mAtmos.uniforms;
  mixC(a.uFogWarm.value, A.fog.warm, B.fog.warm, k);
  mixC(a.uFogCool.value, A.fog.cool, B.fog.cool, k);
  a.uFogDensity.value = mixN(A.fog.density, B.fog.density, k) * (look.fogMul ?? 1);
  a.uMist.value = mixN(A.fog.mist, B.fog.mist, k) * (look.mistMul ?? 1);
  a.uMistHeight.value = mixN(A.fog.mistHeight, B.fog.mistHeight, k);
  a.uShafts.value = look.shafts ?? 0;
  // C1：shaftStyle 'slanted' = 单侧平行斜光（shaftAngle 屏幕角°，不给 = 自动朝画面底部；shaftBeams 光束疏密 4–10；
  //     shaftDown false = 两头都延伸）。默认 'radial' = 旧版放射条纹（旧片逐像素不变）
  a.uShaftStyle.value = look.shaftStyle === 'slanted' ? 1 : 0;
  a.uShaftFreq.value = look.shaftBeams ?? 6;
  a.uShaftDown.value = look.shaftDown === false ? 0 : 1;
  e.shaftAngle = look.shaftAngle ?? null;
  const w = e.mWater.uniforms;
  mixC(w.uDeep.value, A.water.deep, B.water.deep, k);
  mixC(w.uShallow.value, A.water.shallow, B.water.shallow, k);
  mixC(w.uFoam.value, A.water.foam, B.water.foam, k);
  mixC(w.uSkyRefl.value, A.water.skyRefl, B.water.skyRefl, k);
  const f = e.mFinal.uniforms;
  mixC(f.uLift.value, A.grade.lift, B.grade.lift, k);
  mixC(f.uGain.value, A.grade.gain, B.grade.gain, k);
  f.uSat.value = mixN(A.grade.sat, B.grade.sat, k);
  // K5 胶片 / 纸张质感：每帧按 look 重设（不给 = 引擎默认：暗角 0.16、颗粒 0.02、无纸纹）
  f.uVignette.value = look.vignette ?? 0.16;
  f.uGrain.value = look.grain ?? 0.02;
  f.uPaper.value = look.paper ?? 0;
  f.uPaperColor.value.set(look.paperColor ?? '#f3e4c8');
  // W5 云影：look.cloudShadow = { strength 0..1, scale (1/m，默认 0.012), offset:[x,z] (m，风的积分) }。不给 = 0（逐像素不变）
  const cs = look.cloudShadow;
  if (cs && cs.strength > 0) G.uCloudShadow.value.set(cs.strength, cs.scale ?? 0.012, cs.offset?.[0] ?? 0, cs.offset?.[1] ?? 0);
  else G.uCloudShadow.value.set(0, 0.012, 0, 0);
  // W8 雨打水面：look.rainRings = 0..1 | { amount, scale }。时间基 = 一拍三（G.uTime 已由 runtime 在 applyLook 之前设好）。
  //   注意：与 look.rain（天气层的雨量，部门自己读）是两个独立选项 —— 只有显式给 rainRings 才画雨环（旧片逐像素不变）
  const rr = look.rainRings, rrA = typeof rr === 'number' ? rr : rr?.amount ?? 0;
  G.uRainRing.value.set(Math.max(0, rrA), (typeof rr === 'object' && rr?.scale) || 0.7, onThrees(G.uTime.value), 0);
  // W10 地面水洼：look.puddles = 0..1 | { amount, scale (1/m), seed, sky, zenith }。只影响开了 puddles 选项的地面材质
  const pd = look.puddles, pdA = typeof pd === 'number' ? pd : pd?.amount ?? 0, po = typeof pd === 'object' ? pd : {};
  G.uPuddle.value.set(Math.max(0, pdA), po.scale ?? 0.22, po.seed ?? 0, 0);
  if (pdA > 0) {
    // 倒影里的天：地平线 = 调色板 water.skyRefl，天顶 = 天空材质的 uMid（没有就取地平线的深一档）；可用 hex 覆盖
    if (po.sky) G.uPudSky.value.set(po.sky); else G.uPudSky.value.copy(w.uSkyRefl.value);
    const mid = sky?.material?.uniforms?.uMid?.value;
    if (po.zenith) G.uPudZen.value.set(po.zenith);
    else if (mid) G.uPudZen.value.copy(mid);
    else G.uPudZen.value.copy(w.uSkyRefl.value).multiplyScalar(0.7);
  }
}
