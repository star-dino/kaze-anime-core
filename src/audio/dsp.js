// 音频 DSP 工具箱（精简自原作 audio-dsp.js，MIT）。
// 原则：全部纯 JS 逐采样合成 + 种子噪声 → 每次渲染采样级一致（原生 OscillatorNode 在不同次渲染间会有 1e-6 级漂移）。
// 只有混响用 OfflineAudioContext 的 ConvolverNode。
import { Rng, clamp, smooth, invLerp } from '../core/util.js';

export const SR = 48000;
export const TAU = Math.PI * 2;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// 'Bb4' | 'F#3' → MIDI（C4 = 60）
export function nm(s) {
  if (typeof s === 'number') return s;
  const m = /^([A-G])([b#]?)(-?\d)$/.exec(s);
  if (!m) throw new Error('bad note ' + s);
  return PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
}
export const dbToGain = (db) => Math.pow(10, db / 20);

// 整片长度的立体声浮点总线。效果写进 dry（干声）和 send（送混响）。
export class Bus { constructor(n) { this.n = n; this.L = new Float32Array(n); this.R = new Float32Array(n); } }
export function panGains(p) { const a = (clamp(p, -1, 1) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; }

// 把单声道信号 sig 放到 t0 秒：out = { dry: Bus, send: Bus }；o = { gain, pan (常数或 i→pan 函数), send }
export function put(out, t0, sig, o = {}) {
  const g = o.gain ?? 1, send = o.send ?? 0.2;
  const s0 = Math.round(t0 * SR), n = out.dry.n;
  const panFn = typeof o.pan === 'function' ? o.pan : null;
  let [gl, gr] = panGains(panFn ? 0 : (o.pan ?? 0));
  for (let i = Math.max(0, -s0); i < Math.min(sig.length, n - s0); i++) {
    if (panFn && (i & 255) === 0) [gl, gr] = panGains(panFn(i / SR));
    const v = sig[i] * g, j = s0 + i;
    out.dry.L[j] += v * gl; out.dry.R[j] += v * gr;
    if (send) { out.send.L[j] += v * gl * send; out.send.R[j] += v * gr * send; }
  }
}

// 状态变量滤波器（Zavalishin TPT）：调制截止频率很便宜
export class SVF {
  constructor(f = 1000, q = 0.707) { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q;
    const g = Math.tan(Math.PI * clamp(f, 5, SR * 0.46) / SR), k = 1 / q;
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  run(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

export class Noise {
  constructor(seed) { this.r = new Rng(seed); this.b = [0, 0, 0, 0, 0, 0, 0]; }
  white() { return this.r.next() * 2 - 1; }
  pink() {   // Paul Kellet
    const w = this.white(), b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
    const p = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362; b[6] = w * 0.115926;
    return p * 0.11;
  }
}

// 模态合成：一组 [频率比, 振幅, 衰减秒] 的正弦分音 → 钟琴、钢片琴、木琴、定音鼓都是它
// 注意：默认 64 采样（1.3 ms）硬起音 + 不衰减的高次分音，密集使用会在 3–8 kHz 造成“叮叮当”听觉疲劳。
// o（可选，不给时与旧版逐采样一致）：
//   attackMs  余弦软起音时长（毫秒，例如 8–20 = 毛毡槌 / 指腹）
//   maxHz     丢弃高于此频率的分音（例如 2600）
//   lpCut     低通截止（Hz）；lpDecay 秒：截止频率从 lpCut 指数收向 max(f0 * 1.5, 300)（敲击后迅速变暗）
export function ping(m, vel, partials, dur = 3, seed = 1, o) {
  const f0 = mtof(nm(m)), len = Math.ceil(dur * SR), out = new Float32Array(len);
  const rng = new Rng(seed);
  for (const [r, a, dk] of partials) {
    const w = TAU * f0 * r / SR, ph = rng.next() * TAU, k = Math.exp(-1 / (dk * SR));
    if (o?.maxHz && f0 * r > o.maxHz) continue;
    let e = a * vel;
    for (let i = 0; i < len; i++) { out[i] += e * Math.sin(w * i + ph); e *= k; }
  }
  if (!o) { for (let i = 0; i < 64; i++) out[i] *= i / 64; return out; }   // 去咔哒（旧行为）
  const att = Math.max(64, Math.round((o.attackMs ?? 64000 / SR) * SR / 1000));
  for (let i = 0; i < Math.min(att, len); i++) out[i] *= o.attackMs ? 0.5 - 0.5 * Math.cos(Math.PI * i / att) : i / att;
  if (o.lpCut) {
    const lp = new SVF(o.lpCut, 0.7), floor = Math.max(f0 * 1.5, 300);
    for (let i = 0; i < len; i++) {
      if ((i & 63) === 0) lp.set(o.lpDecay ? floor + (o.lpCut - floor) * Math.exp(-i / SR / o.lpDecay) : o.lpCut, 0.7);
      out[i] = lp.run(out[i]);
    }
  }
  return out;
}
export const CELESTA = [[1, 1, 1.8], [2, 0.08, 0.6], [3.98, 0.2, 0.4], [8.15, 0.04, 0.12]];
export const GLOCK = [[1, 1, 2.2], [2.756, 0.28, 0.7], [5.404, 0.1, 0.28], [8.933, 0.04, 0.12]];

// 弦乐/合成 pad：PolyBLEP 锯齿波（带限，不混叠），3 个失谐声部 + 颤音 + 低通 + ADSR
const blep = (t, dt) => { if (t < dt) { const x = t / dt; return x + x - x * x - 1; } if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; } return 0; };
export function pad(m, hold, vel, o = {}) {
  const f0 = mtof(nm(m)), att = o.att ?? 0.6, rel = o.rel ?? 1.2;
  const len = Math.ceil((hold + rel) * SR), out = new Float32Array(len);
  const det = o.det ?? [-9, 0, 8], rng = new Rng(o.seed ?? 3);
  const lp = new SVF(Math.min(o.cut ?? 2200, f0 * 6), 0.7);
  const ph = det.map(() => rng.next());
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let s = 0;
    for (let v = 0; v < det.length; v++) {
      const cents = det[v] + 5 * Math.sin(TAU * (4.8 + v * 0.37) * t + v);
      const dt = f0 * Math.pow(2, cents / 1200) / SR;
      let p = ph[v] + dt; if (p >= 1) p -= 1; ph[v] = p;
      s += 2 * p - 1 - blep(p, dt);
    }
    const env = Math.min(1, t / att) * (t > hold ? Math.exp(-(t - hold) / (rel * 0.3)) : 1);
    out[i] = lp.run(s / det.length) * env * vel * 0.22;
  }
  return out;
}

// ===================================================================== 温暖声部（C7，从《海岬的测风人》下沉）
// 用来替代“全靠 ping() 叮当”的写法：全部慢起音 / 软起音 + 随包络开合的低通，泛音不进 3–8 kHz 刺耳区。
//   sing(note, hold, vel, { att, rel, bright, seed })      木管 / 陶笛独奏：0.30 s 余弦起音、延迟颤音、气息噪声
//   celloHorn(note, hold, vel, { att, rel, bright, seed }) 大提琴 / 圆号齐奏：3 声部失谐带限锯齿 + 基频正弦、拱形低通
//   warmHarp(note, dur, vel, seed)                          尼龙弦 / 竖琴拨弦：14 ms 指腹起音、>2.6 kHz 泛音截断
//   warmTimpani(note, dur, vel, seed)                       毛毡定音鼓：28 ms 软槌、低频托底
//   airSwell(dur, peakRatio, vel, seed)                     气声 / 吊镲渐强：滤波粉红噪声，推向高潮顶点
//   softDrop(kind = 'puddle' | 'rock' | 'flower', vel, seed) 无音高雨滴 / 落水拟音（不要再用 ping 敲音阶当雨点）
// 都返回单声道 Float32Array，用 put(bus, t0, sig, { pan, send }) 放进总线。

// 柔和木管/高音独奏（慢余弦起音、无敲击头、随包络打开温暖泛音）
export function sing(note, hold, vel = 0.22, o = {}) {
  const f0 = mtof(nm(note));
  const att = o.att ?? 0.30, rel = o.rel ?? 0.95;
  const bright = o.bright ?? 1.0;
  const len = Math.ceil((hold + rel) * SR), out = new Float32Array(len);
  const nz = new Noise(o.seed ?? 7);
  const lp = new SVF(Math.min(1200 * bright, f0 * 2.8 * bright), 0.72);
  const bpBreath = new SVF(f0 * 1.5, 1.8);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const envAtt = t < att ? 0.5 - 0.5 * Math.cos(Math.PI * (t / att)) : 1;
    const envRel = t > hold ? Math.exp(-(t - hold) / (rel * 0.40)) : 1;
    const swell = 0.82 + 0.18 * Math.sin(Math.PI * clamp(t / Math.max(0.2, hold), 0, 1));
    const env = envAtt * envRel * swell;

    if ((i & 31) === 0) {
      lp.set(Math.min((1050 + 650 * swell) * bright, f0 * (2.4 + 1.4 * swell) * bright), 0.72);
    }

    const vib = smooth(invLerp(0.20, 0.75, t)) * (4.5 * bright) * Math.sin(TAU * 4.6 * t);
    const f = f0 * Math.pow(2, vib / 1200);
    ph += TAU * f / SR;
    const tone = Math.sin(ph) * 0.76 + Math.sin(ph * 2) * (0.18 * bright) + Math.sin(ph * 3) * (0.06 * bright);
    bpBreath.run(nz.pink());
    const breath = bpBreath.bp * 0.03;
    out[i] = lp.run(tone + breath) * env * vel * 0.34;
  }
  return out;
}

// 温暖大提琴 / 圆号齐奏声部（用于守护段与第四幕情感高潮的厚重中低音歌唱与推进）
export function celloHorn(note, hold, vel = 0.28, o = {}) {
  const f0 = mtof(nm(note));
  const att = o.att ?? 0.42, rel = o.rel ?? 1.25;
  const bright = o.bright ?? 1.0;
  const len = Math.ceil((hold + rel) * SR), out = new Float32Array(len);
  const det = [-5, 0, 5];
  const rng = new Rng(o.seed ?? 19);
  const ph = det.map(() => rng.next());
  let phSub = rng.next() * TAU;
  const lp = new SVF(f0 * 2.5, 0.80);

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const envAtt = t < att ? 0.5 - 0.5 * Math.cos(Math.PI * (t / att)) : 1;
    const envRel = t > hold ? Math.exp(-(t - hold) / (rel * 0.42)) : 1;
    const arch = Math.sin(Math.PI * clamp(t / Math.max(0.3, hold), 0, 1));
    const env = envAtt * envRel * (0.75 + 0.25 * arch);

    if ((i & 31) === 0) {
      const cut = Math.min(2400 * bright, f0 * (2.0 + 2.8 * arch * bright));
      lp.set(cut, 0.80);
    }

    const vib = smooth(invLerp(0.25, 0.8, t)) * 3.8 * Math.sin(TAU * 4.4 * t);
    let saw = 0;
    for (let v = 0; v < 3; v++) {
      const dt = f0 * Math.pow(2, (det[v] + vib) / 1200) / SR;
      let p = ph[v] + dt; if (p >= 1) p -= 1; ph[v] = p;
      saw += 2 * p - 1 - blep(p, dt);
    }
    phSub += TAU * f0 / SR;
    // 叠加圆润基频正弦，赋予圆号/大提琴饱满温暖的胸腔共鸣
    const sig = (saw / 3) * 0.55 + Math.sin(phSub) * 0.45;
    out[i] = lp.run(sig) * env * vel * 0.30;
  }
  return out;
}

// 温暖竖琴/尼龙拨弦（14ms 指腹余弦软起音 + 快速变暗的木质共鸣，提供高潮流动感而绝无金属“叮当”刺耳感）
export function warmHarp(note, dur = 2.2, vel = 0.20, seed = 11) {
  const f0 = mtof(nm(note));
  const len = Math.ceil(dur * SR), out = new Float32Array(len);
  const rng = new Rng(seed);
  // 严格整数倍谐波（偶次与基频为主），快速衰减高次泛音
  const harmonics = [[1, 1.0, 1.45], [2, 0.34, 0.55], [3, 0.10, 0.24], [4, 0.03, 0.12]];
  const lp = new SVF(Math.min(1800, f0 * 3.4), 0.65);
  for (const [r, a, dk] of harmonics) {
    const f = f0 * r;
    if (f > 2600) continue; // 硬截断高于 2.6 kHz 的泛音，杜绝任何钟琴/铁片感
    const w = TAU * f / SR, ph = rng.next() * TAU, k = Math.exp(-1 / (dk * SR));
    let e = a * vel * 0.28;
    for (let i = 0; i < len; i++) {
      out[i] += e * Math.sin(w * i + ph);
      e *= k;
    }
  }
  // 14 ms (672 采样) 余弦指腹软包络 + 随时间温和收敛的低通
  const attSmp = Math.round(0.014 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    if ((i & 63) === 0) lp.set(Math.min(1750, f0 * (1.5 + 2.0 * Math.exp(-t * 3.5))), 0.65);
    const attEnv = i < attSmp ? 0.5 - 0.5 * Math.cos(Math.PI * (i / attSmp)) : 1;
    out[i] = lp.run(out[i] * attEnv);
  }
  return out;
}

// 交响毛毡定音鼓/温暖低音轰鸣（用于高潮起拍与情绪托底）
export function warmTimpani(note, dur = 2.6, vel = 0.34, seed = 23) {
  const f0 = mtof(nm(note));
  const len = Math.ceil(dur * SR), out = new Float32Array(len);
  const nz = new Noise(seed), lp = new SVF(160, 0.75);
  let ph1 = 0, ph2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.08 * Math.exp(-t * 9));
    ph1 += TAU * f / SR;
    ph2 += TAU * (f * 1.5) / SR;
    const att = smooth(t / 0.028); // 28 ms 毛毡软槌起音
    const body = (Math.sin(ph1) * 0.82 + Math.sin(ph2) * 0.18) * Math.exp(-t * 1.35);
    const felt = lp.run(nz.pink()) * Math.exp(-t * 16) * 0.22;
    out[i] = (body + felt) * att * vel * 0.45;
  }
  return out;
}

// 温暖气声/吊镲渐强（纯滤波粉红噪声呼吸推进，用于把情绪推向高潮顶点）
export function airSwell(dur = 3.2, peakRatio = 0.78, vel = 0.22, seed = 31) {
  const len = Math.ceil(dur * SR), out = new Float32Array(len);
  const nz = new Noise(seed), bp = new SVF(600, 0.9), hp = new SVF(260, 0.7);
  const tPeak = dur * peakRatio;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = t < tPeak
      ? Math.pow(smooth(t / tPeak), 1.8)
      : Math.exp(-(t - tPeak) / Math.max(0.15, (dur - tPeak) * 0.38));
    if ((i & 31) === 0) bp.set(420 + 1350 * env, 0.85);
    const w = nz.pink();
    bp.run(w); hp.run(bp.lp);
    out[i] = (bp.bp * 0.65 + hp.hp * 0.35) * env * vel * 0.38;
  }
  return out;
}

// 自然界轻柔雨滴落石/落水声（无固定音阶、无金属泛音，仅短促低通水花与微气泡）
export function softDrop(kind = 'puddle', vel = 0.14, seed = 1) {
  const dur = kind === 'puddle' ? 0.18 : 0.11;
  const len = Math.ceil(dur * SR), out = new Float32Array(len);
  const nz = new Noise(seed);
  const fCut = kind === 'rock' ? 680 : kind === 'flower' ? 540 : 820;
  const svf = new SVF(fCut, 1.1);
  let ph = 0;
  const fBase = kind === 'puddle' ? 240 : 190;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const patEnv = smooth(t / 0.004) * Math.exp(-t * 38);
    const pat = svf.run(nz.pink()) * patEnv * 0.85;
    let bub = 0;
    if (kind === 'puddle' && t < 0.055) {
      const f = fBase + 90 * smooth(t / 0.04);
      ph += TAU * f / SR;
      bub = Math.sin(ph) * Math.sin(Math.PI * (t / 0.055)) * 0.18;
    }
    out[i] = (pat + bub) * vel;
  }
  return out;
}

// 卷积混响的脉冲响应：种子噪声 × 指数衰减，越往后越暗
export function makeIR(ctx, { dur = 2.5, rt60 = 1.8, seed = 5, bright = 6000 } = {}) {
  const len = Math.round(dur * SR), ir = ctx.createBuffer(2, len, SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch), nz = new Noise(seed + ch * 101), f = new SVF(bright, 0.6);
    let e = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      f.set(bright * Math.exp(-t * 1.2) + 400, 0.6);
      d[i] = f.run(nz.white()) * Math.exp(-6.91 * t / rt60) * Math.min(1, t / 0.01);
      e += d[i] * d[i];
    }
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return ir;
}

// 同上，但不依赖 AudioContext：返回 [Float32Array L, Float32Array R]，与 makeIR 的通道数据逐采样相同
// （同样的 float32 存储 / 能量累加顺序）。给纯 JS 卷积混响（convolveStereo）用。
export function makeIRData({ dur = 2.5, rt60 = 1.8, seed = 5, bright = 6000 } = {}) {
  const len = Math.round(dur * SR), out = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(len), nz = new Noise(seed + ch * 101), f = new SVF(bright, 0.6);
    let e = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      f.set(bright * Math.exp(-t * 1.2) + 400, 0.6);
      d[i] = f.run(nz.white()) * Math.exp(-6.91 * t / rt60) * Math.min(1, t / 0.01);
      e += d[i] * d[i];
    }
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
    out.push(d);
  }
  return out;
}

// ===================================================================== 纯 JS 卷积混响
// 原生 ConvolverNode 在不同次渲染间不是逐位一致的（100 s 的片三次渲染里有一次 275 个采样差 ±1 LSB）。
// 这里用 float64 基 2 FFT + 重叠相加（overlap-add）做离线线性卷积：单线程、只用 IEEE 双精度四则运算
// 和查表旋转因子 → 同一浏览器每次结果逐位相同。
//   convolveStereo(L, R, irL, irR, n) → [wetL, wetR]（Float32Array，长度 n，零延迟，等价于 normalize = false
//   的立体声 ConvolverNode：L * irL、R * irR，各通道独立；超出 n 的尾巴截掉，与 OfflineAudioContext 一致）
// 技巧：把两个实信号打包成一个复信号 L + iR 做一次 FFT，按共轭对称拆出两路频谱分别乘 IR 频谱，
// 再合成 Y = A·H0 + i·B·H1，一次 IFFT 同时得到两路实输出（计算量减半）。
// FFT 长度 = 2 × nextPow2(IR 长度)，块长 = N − M + 1（3 s IR → N = 2^19、块长约 38 万采样）。
const _fftTabs = new Map();
function fftTables(N) {
  let t = _fftTabs.get(N);
  if (t) return t;
  const bits = Math.round(Math.log2(N)), rev = new Uint32Array(N);
  for (let i = 1; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(N >> 1), sin = new Float64Array(N >> 1);
  for (let i = 0; i < N >> 1; i++) { const a = -TAU * i / N; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  t = { N, rev, cos, sin };
  _fftTabs.set(N, t);
  return t;
}
// 原位复数 FFT（基 2，按时间抽取）；inv = true 时用共轭旋转因子（不除 N，缩放折进 IR 频谱）
function fft(re, im, tb, inv) {
  const { N, rev, cos, sin } = tb, sg = inv ? -1 : 1;
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let i = 0; i < N; i += 2) {   // size = 2：旋转因子恒为 1
    const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
    re[i] = ar + br; im[i] = ai + bi; re[i + 1] = ar - br; im[i + 1] = ai - bi;
  }
  for (let size = 4; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s0 = 0; s0 < N; s0 += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = sg * sin[w];
        const a = s0 + k, b = a + half, br = re[b], bi = im[b];
        const xr = br * wr - bi * wi, xi = br * wi + bi * wr;
        const ar = re[a], ai = im[a];
        re[a] = ar + xr; im[a] = ai + xi; re[b] = ar - xr; im[b] = ai - xi;
      }
    }
  }
}

export function convolveStereo(L, R, irL, irR, n = L.length) {
  const M = Math.max(irL.length, irR.length, 1);
  let P = 1; while (P < M) P <<= 1;
  const N = P * 2, B = N - M + 1, H = N >> 1, tb = fftTables(N);
  // IR 频谱：打包 irL + i·irR 做一次 FFT，拆成 H0（左）/ H1（右），只存 0..N/2，并预乘 1/N（2 的幂，精确）
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(irL); im.set(irR);
  fft(re, im, tb, false);
  const h0r = new Float64Array(H + 1), h0i = new Float64Array(H + 1), h1r = new Float64Array(H + 1), h1i = new Float64Array(H + 1);
  const s = 0.5 / N;
  for (let k = 0; k <= H; k++) {
    const kk = (N - k) & (N - 1), xr = re[k], xi = im[k], yr = re[kk], yi = im[kk];
    h0r[k] = (xr + yr) * s; h0i[k] = (xi - yi) * s;
    h1r[k] = (xi + yi) * s; h1i[k] = (yr - xr) * s;
  }
  const oL = new Float32Array(n), oR = new Float32Array(n);
  const tail = M - 1, tL = new Float64Array(tail), tR = new Float64Array(tail);   // 上一块溢出的尾巴（tail < B）
  for (let s0 = 0; s0 < n; s0 += B) {
    const m = Math.min(B, n - s0);
    re.fill(0); im.fill(0);
    for (let i = 0; i < m; i++) { re[i] = L[s0 + i]; im[i] = R[s0 + i]; }
    fft(re, im, tb, false);
    for (let k = 0; k <= H; k++) {
      const kk = (N - k) & (N - 1), xr = re[k], xi = im[k], yr = re[kk], yi = im[kk];
      // A = L 的频谱，Bs = R 的频谱（第 k 个 bin）
      const ar = (xr + yr) * 0.5, ai = (xi - yi) * 0.5, br = (xi + yi) * 0.5, bi = (yr - xr) * 0.5;
      const pr = ar * h0r[k] - ai * h0i[k], pi = ar * h0i[k] + ai * h0r[k];
      const qr = br * h1r[k] - bi * h1i[k], qi = br * h1i[k] + bi * h1r[k];
      // Y[k] = P + iQ；Y[N−k] = conj(P) + i·conj(Q)
      re[k] = pr - qi; im[k] = pi + qr;
      if (kk !== k) { re[kk] = pr + qi; im[kk] = qr - pi; }
    }
    fft(re, im, tb, true);
    // 本块输出 = 本块卷积前 m + tail 个采样 + 上一块尾巴
    const lim = Math.min(m + tail, n - s0);
    for (let i = 0; i < lim; i++) {
      let yl = re[i], yr = im[i];
      if (i < tail) { yl += tL[i]; yr += tR[i]; }
      if (i < m) { oL[s0 + i] = yl; oR[s0 + i] = yr; }
      else { tL[i - m] = yl; tR[i - m] = yr; }
    }
    // 尾巴前移：i ∈ [m, m + tail) 已写入 tL[0..tail)；若 m < tail（只可能是最后一块）则剩余部分不再需要
  }
  return [oL, oR];
}

// 16-bit PCM WAV（TPDF 抖动）
export function encodeWav(chans, seed = 99) {
  const n = chans[0].length, nc = chans.length;
  const ab = new ArrayBuffer(44 + n * nc * 2), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * nc * 2, true); dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nc * 2, true);
  const r = new Rng(seed); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const x = chans[c][i] * 32767 + (r.next() - r.next());
    dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x))), true); o += 2;
  }
  return new Uint8Array(ab);
}
