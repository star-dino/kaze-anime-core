// 随动（secondary motion）：尾巴、耳朵、触角、围巾、挂件、头发 —— “主动作停了，它还在晃”。
//
// 难点在于引擎的铁律：每一帧都是时间的纯函数（乱序渲染、分段续渲、确定性测试都靠它）。
// 普通的弹簧骨是“上一帧状态 + dt”，乱序渲染就错了。这里的做法：
//   从镜头起点 t0 开始、用固定步长 dt 积分到 t —— 结果只取决于 (驱动函数, t0, dt, t)，与渲染顺序无关。
//   为了不每帧都从头积分，内部缓存“网格上的最近一个状态”：顺序渲染时每帧只走几步；
//   倒着跳或跳到别处时从头算（几千步标量运算，<1 ms）。缓存只是加速，结果逐位相同。
//
// 用法（驱动值可以是数字，也可以是数组：角度、位置都行）：
//   const tailLag = new Spring((t) => bodyYaw(t), { freq: 2.2, zeta: 0.35, t0: shot.start });
//   tail.rotation.y = tailLag.at(t);
//   const tail = new SpringChain((t) => hipAngle(t), 5, { freq: 3, zeta: 0.3, falloff: 0.8 });
//   tail.at(t) → [a0, a1, ..., a4]：每一节跟随前一节，越往末端越滞后、甩得越开
//
// 参数直觉：freq = 每秒晃几次（软的大尾巴 1.5，耳朵/触角 3–5）；zeta = 阻尼（0.2 晃很多下，0.7 几乎不晃）。
// 表演上随动也要“一拍二”：把 t 先过 onTwos() 再传进来，否则身体抖一拍二、尾巴却是一拍一，会显得滑。

import { clamp, noise1 } from './util.js';

const toArr = (v) => (Array.isArray(v) ? v : [v]);

export class Spring {
  constructor(drive, o = {}) {
    this.drive = drive;
    this.w = 2 * Math.PI * (o.freq ?? 2);
    this.z = o.zeta ?? 0.4;
    this.t0 = o.t0 ?? 0;
    this.dt = o.dt ?? 1 / 120;
    this.scalar = !Array.isArray(drive(this.t0));
    this._k = -1; this._x = null; this._v = null;
  }
  _reset() {
    this._k = 0;
    this._x = toArr(this.drive(this.t0)).slice();
    this._v = this._x.map(() => 0);
  }
  _step() {
    const { w, z, dt } = this;
    const tgt = toArr(this.drive(this.t0 + (this._k + 1) * dt));
    for (let i = 0; i < this._x.length; i++) {
      // 半隐式欧拉：x'' = w²(目标 - x) - 2ζw x'
      this._v[i] += (w * w * (tgt[i] - this._x[i]) - 2 * z * w * this._v[i]) * dt;
      this._x[i] += this._v[i] * dt;
    }
    this._k++;
  }
  at(t) {
    if (t <= this.t0) { const d = this.drive(t); return this.scalar ? d : toArr(d).slice(); }
    const kt = Math.floor((t - this.t0) / this.dt + 1e-9);
    if (this._k < 0 || this._k > kt) this._reset();
    while (this._k < kt) this._step();
    // 网格之间线性插值到下一步（不改缓存）
    const f = (t - this.t0) / this.dt - kt;
    const x0 = this._x.slice(), v0 = this._v.slice(), k0 = this._k;
    this._step();
    const out = x0.map((a, i) => a + (this._x[i] - a) * f);
    this._x = x0; this._v = v0; this._k = k0;
    return this.scalar ? out[0] : out;
  }
}

// 一串跟随：第 i 节的目标 = 第 i-1 节当前值（第 0 节跟驱动函数）。
// falloff < 1：越往末端越软（频率逐节乘 falloff），甩尾/鞭梢的效果。
// 返回值是每一节的“绝对”量；做骨骼旋转时通常要相邻相减得到局部角：local_i = a_i - a_{i-1}。
export class SpringChain {
  constructor(drive, n, o = {}) {
    const fo = o.falloff ?? 0.85;
    this.links = [];
    let prev = drive;
    for (let i = 0; i < n; i++) {
      const s = new Spring(prev, { ...o, freq: (o.freq ?? 2.5) * Math.pow(fo, i) });
      this.links.push(s);
      prev = ((s) => (t) => s.at(t))(s);
    }
  }
  at(t) { return this.links.map((s) => s.at(t)); }
}

// 不需要物理、只要“拖一拍”的地方：纯延迟 + 过冲，零状态。
//   lag(fn, t, 0.08) = 0.08 秒前的值；overshoot 给一个衰减的回弹（适合落地后的耳朵/挂件）
export const lag = (fn, t, d) => fn(t - d);
export function overshoot(t, tHit, { amp = 1, freq = 3, decay = 5 } = {}) {
  const u = t - tHit;
  if (u < 0) return 0;
  return amp * Math.exp(-decay * u) * Math.sin(2 * Math.PI * freq * u);
}

// ---- 积分量（W7）：风杯转角、草浪相位、云漂移 —— 凡是“速度随时间变”的量，都要积分，不能写 t × v(t)
// （v 一变，乘积的导数突变，相位会忽快忽慢甚至倒退）。
// integral(rate, { t0, t1, dt }) 在创建时按固定步长（中点法）积分一次并缓存，返回 t → ∫[t0, t] rate，查表 + 线性插值，
// 乱序渲染、断点续渲都一致。t 超出 [t0, t1] 时夹在两端。
//   const windPhase = integral((t) => 1.4 + 8.6 * wind(t), { t1: 102 });
export function integral(rate, { t0 = 0, t1 = 120, dt = 1 / 240 } = {}) {
  const T = t1 - t0, N = Math.ceil(T / dt) + 1, a = new Float64Array(N);
  for (let i = 1; i < N; i++) a[i] = a[i - 1] + rate(t0 + (i - 0.5) * dt) * dt;
  return (t) => {
    const x = (clamp(t, t0, t1) - t0) / dt, i = Math.min(N - 2, Math.floor(x)), f = x - i;
    return a[i] + (a[i + 1] - a[i]) * f;
  };
}

// 风作为随动的驱动值（W7）：Spring 的驱动 = 姿态角 + windDrive(...)(t)。
//   windDrive(W, k, { seed, gust, rate }) → t ↦ k · W(t) · (1 + gust · 阵风噪声(t))
//   W：风力曲线（0..1，故事层的 wind(t)）；k：满风时偏转多少（角度 / 米）；gust：阵风起伏比例；rate：阵风每秒几次。
//   百叶颤动、风向袋、花茎、旗子：
//     const stem = new Spring((t) => restAngle + windDrive(wind, 18, { seed: 3 })(t), { freq: 1.6, zeta: 0.3, t0: shot.start });
//   不同物件给不同 seed，阵风才不会整齐划一。
export function windDrive(W, k = 1, { seed = 1, gust = 0.25, rate = 1.3 } = {}) {
  return (t) => k * W(t) * (1 + gust * noise1(t * rate, seed));
}
