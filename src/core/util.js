// 确定性工具函数（改编自 Sunshower / LEVIATHAN 的 src/util.js，MIT）。
// 铁律：整部片的任何一帧都必须是 t 的纯函数 —— 帧可以乱序渲染、可以断点续渲。
// 所以：禁止 Math.random()，禁止跨帧累积状态；随机一律用种子 RNG 或 hash。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.r = mulberry32(seed); }
  next() { return this.r(); }
  range(a, b) { return a + (b - a) * this.r(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  sign() { return this.r() < 0.5 ? -1 : 1; }
  gauss() { return (this.r() + this.r() + this.r() + this.r() - 2) * 0.8660254; }
}

// 无状态整数哈希 → [0,1)。粒子/闪电/雨滴“第 i 个、第 n 张原画”的随机量都从这里取，
// 同样的 (a,b,c) 永远得到同样的值，这就是“无状态特效”的根基。
export function hash(a, b = 0, c = 0) {
  let h = Math.imul((a * 7919) | 0, 0x27d4eb2d) ^ Math.imul((b * 104729) | 0, 0x165667b1) ^ Math.imul((c * 15485863) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hr = (a, b, c, lo, hi) => lo + (hi - lo) * hash(a, b, c);

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const easeIn = (t, p = 2) => Math.pow(clamp(t), p);
export const easeOut = (t, p = 2) => 1 - Math.pow(1 - clamp(t), p);
export const easeInOut = (t, p = 2) => { t = clamp(t); return t < 0.5 ? Math.pow(2 * t, p) / 2 : 1 - Math.pow(2 - 2 * t, p) / 2; };
export const deg = (d) => (d * Math.PI) / 180;
export const mix3 = (a, b, k) => a.map((x, i) => lerp(x, b[i], k));

// ---- 重型机械的“重量感”缓动（C4，《海岬的测风人》20 m 机甲验证过）
// easeHeavy：五次 smootherstep（起停的速度和加速度都为 0），配合 4–5 秒的长动作区间，巨型机甲才不显得轻飘。
export const easeHeavy = (u) => { u = clamp(u); return u * u * u * (u * (u * 6 - 15) + 10); };
// heavyAct(t, [t0, t1], { prep, damp, freq, decay }) → 动作进度（大致 0..1，可略超出）
//   prep  预备：动作开始前段先往反方向退一点（进度最低到 -prep），0 = 不要
//   damp  液压落位：到位后以 freq Hz、decay 1/s 的阻尼振荡轻微过冲再停稳（振幅 damp），0 = 不要
//   两项都不给时与 easeHeavy((t - t0) / (t1 - t0)) 完全一致。纯函数，乱序渲染安全。
export function heavyAct(t, [t0, t1], { prep = 0, damp = 0, freq = 1.1, decay = 4.5 } = {}) {
  const u = clamp((t - t0) / (t1 - t0));
  let v = easeHeavy(u);
  if (prep) { const a = clamp(u / 0.24); v -= prep * Math.sin(Math.PI * a) ** 2 * (1 - u); }
  if (damp && t > t1) { const r = t - t1; v += damp * Math.sin(2 * Math.PI * freq * r) * Math.exp(-decay * r) * smooth(r / 0.2); }
  return v;
}

// ---- 日式动画的“拍数”：角色一拍二（12 张/秒），水/火特效一拍三（8 张/秒）。
// 把时间量化到原画时刻，动作就会像手绘一样“一格一格跳”，而不是 3D 软件的丝滑插值。
export const onTwos = (t) => Math.floor(t * 12 + 1e-6) / 12;
export const onThrees = (t) => Math.floor(t * 8 + 1e-6) / 8;
// 第几张原画（给 hash 当种子用：同一张原画内随机量不变，换张才变 → 闪电“闪”而不是“沸腾”）
export const drawing = (t, fps = 8) => Math.floor(t * fps + 1e-6);
// 从某个瞬间重新起拍：保证“弓弦松开”这种关键帧正好落在它自己的那一帧上（LEVIATHAN archer-pose.js 的做法）
export const onTwosFrom = (t, t0) => (t < t0 ? onTwos(t) : t0 + onTwos(t - t0));

// 关键帧轨道：[[time, value, ease?], ...]，value 可以是数字或数组。
export function track(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, ease] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) {
      const u = (ease || smooth)((t - t0) / (t1 - t0));
      if (Array.isArray(v0)) return v0.map((x, j) => lerp(x, v1[j], u));
      return lerp(v0, v1, u);
    }
  }
  return keys[keys.length - 1][1];
}

// 一维值噪声：镜头手持抖动、角色的“呼吸”漂移
export function noise1(x, seed = 0) {
  const h = (n) => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
}

// 冲击抖动：在 t0 处炸开、指数衰减（LEVIATHAN s09 放箭后的镜头震动）
export function kick(t, t0, amp = 1, decay = 2.6, freq = 21, seed = 1) {
  const r = t - t0;
  if (r < 0) return [0, 0, 0];
  const a = amp * Math.exp(-r * decay);
  return [noise1(t * freq, seed) * a, noise1(t * freq * 1.1, seed + 1) * a, noise1(t * freq * 0.9, seed + 2) * a];
}
