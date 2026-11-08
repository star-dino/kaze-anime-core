// 配乐 + 音效：全部挂在 CUES 上。导演改了 CUES.impact，音乐的停顿、低音冲击、闪光音全部自动跟着走。
// 这就是原作“画面—声音锁同步”的方法：不是对着视频剪，而是和画面读同一份节拍表。
import { SR, TAU, put, SVF, Noise, ping, pad, CELESTA, GLOCK } from './dsp.js';
import { Rng, clamp, smooth, invLerp } from '../core/util.js';

// music / sfx: 各自 { dry: Bus, send: Bus }；dur 影片秒数。返回 cue 报告（给 audio.html 显示、给人核对）
export function buildScore(C, dur, music, sfx) {
  const report = [];
  const cue = (t, label) => report.push([+t.toFixed(3), label]);
  let seed = 100;
  const S = () => ++seed;
  const end = dur - 0.2;

  // ------------------------------------------------------------ 和声：[开始, 结束, 音符们]
  const chords = [
    [0.0, C.lookUp[0], ['F2', 'A3', 'C4', 'E4', 'G4']],           // Fmaj9：晴朗的海边
    [C.lookUp[0], C.streak, ['D2', 'F3', 'A3', 'C4', 'E4']],       // Dm9：抬头，好奇
    [C.streak, C.impact - 0.05, ['Bb1', 'D3', 'F3', 'A3', 'E4']],  // Bbmaj7#11：星星划过，悬念
    [C.impact + 0.35, C.jump[0], ['C2', 'F3', 'G3', 'C4', 'D4']], // Csus：余波
    [C.jump[0], end, ['F2', 'A3', 'C4', 'F4', 'G4', 'A4']],        // F(add9)：开心
  ];
  for (const [t0, t1, notes] of chords) {
    notes.forEach((n, i) => put(music, t0, pad(n, Math.min(t1, end) - t0, i === 0 ? 0.9 : 0.55, { seed: S(), cut: i === 0 ? 900 : 2400 }), { pan: (i - 2) * 0.18, send: 0.45 }));
    cue(t0, `chord ${notes.join(' ')}`);
  }
  // ------------------------------------------------------------ 旋律：钢片琴动机 + 钟琴琶音
  const cel = (t, n, v = 0.5) => put(music, t, ping(n, v, CELESTA, 2.4, S()), { pan: 0.3, send: 0.5 });
  const glk = (t, n, v = 0.4) => put(music, t, ping(n, v, GLOCK, 2.8, S()), { pan: -0.25, send: 0.55 });
  [['C5', 0.7], ['F5', 1.05], ['G5', 1.4], ['A5', 1.75], ['G5', 2.1]].forEach(([n, t]) => cel(t, n));
  cel(C.lookUp[0] + 0.1, 'A5', 0.45); cel(C.lookUp[0] + 0.45, 'D6', 0.5);
  // 星星划过：琶音越来越密，最后一个音正好落在 impact 前一刻（悬停）
  const arp = ['F5', 'A5', 'C6', 'E6', 'F6', 'A6'];
  for (let i = 0, t = C.streak; t < C.impact - 0.08; i++) {
    glk(t, arp[i % arp.length], 0.3 + 0.25 * (t - C.streak) / (C.impact - C.streak));
    t += 0.22 * Math.pow(0.88, i);
  }
  cue(C.streak, 'glock arpeggio accelerates into the impact');
  // 落地后的欢快动机（落在跳跃和第二跳上）
  [['F5', C.jump[0]], ['A5', C.jump[0] + 0.25], ['C6', C.jump[1]], ['F6', C.hop2[0]], ['G6', C.hop2[1]]].forEach(([n, t]) => { glk(t, n, 0.45); cel(t + 0.01, n, 0.3); });

  // ------------------------------------------------------------ 环境：海浪（粉噪声 + 慢速起伏 + 低通）
  {
    const len = Math.ceil(dur * SR), sig = new Float32Array(len), nz = new Noise(S()), f = new SVF(700, 0.6);
    for (let i = 0; i < len; i++) {
      const t = i / SR, swell = 0.55 + 0.45 * Math.sin(TAU * 0.13 * t) * Math.sin(TAU * 0.07 * t + 1);
      f.set(450 + 500 * swell, 0.6);
      sig[i] = f.run(nz.pink()) * (0.25 + 0.5 * swell) * 0.9;
    }
    put(sfx, 0, sig, { pan: -0.1, send: 0.15 });
    cue(0, 'sea wash');
  }
  // ------------------------------------------------------------ 流星呼啸：带通噪声，中心频率上扫，声像从右到左跟着画面
  {
    const d = C.impact - C.streak + 0.05, len = Math.ceil(d * SR), sig = new Float32Array(len), nz = new Noise(S()), f = new SVF(800, 3);
    for (let i = 0; i < len; i++) {
      const u = i / len;
      f.set(700 + 4200 * u * u, 2.5 + 3 * u);
      f.run(nz.white());
      sig[i] = f.bp * Math.pow(u, 1.6) * 0.6;
    }
    put(sfx, C.streak, sig, { pan: (t) => 0.75 - 1.1 * clamp(t / d), send: 0.3 });
    cue(C.streak, 'whoosh, panned right → left with the star');
  }
  // ------------------------------------------------------------ 入水：低频冲击 + 噼啪 + 水花 + 高频碎光
  {
    const len = Math.ceil(2.4 * SR), boom = new Float32Array(len), nz = new Noise(S());
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR, f = 38 + 70 * Math.exp(-t * 6);
      ph += TAU * f / SR;
      boom[i] = Math.sin(ph) * Math.exp(-t * 1.8) * 0.9 + nz.white() * Math.exp(-t * 60) * 0.5;
    }
    put(sfx, C.impact, boom, { pan: -0.15, send: 0.3 });
    const sp = new Float32Array(Math.ceil(1.6 * SR)), f = new SVF(3000, 0.7), nz2 = new Noise(S());
    for (let i = 0; i < sp.length; i++) { const t = i / SR; f.set(3500 * Math.exp(-t * 1.5) + 300); sp[i] = f.run(nz2.white()) * Math.exp(-t * 2.4) * 0.45 * smooth(t / 0.03); }
    put(sfx, C.impact + 0.02, sp, { pan: -0.2, send: 0.4 });
    const rng = new Rng(S()), penta = ['C6', 'D6', 'F6', 'G6', 'A6', 'C7', 'D7'];
    for (let k = 0; k < 14; k++) put(sfx, C.impact + 0.15 + k * 0.1 + rng.range(0, 0.06), ping(rng.pick(penta), 0.16, GLOCK, 1.5, S()), { pan: rng.range(-0.7, 0.4), send: 0.6 });
    cue(C.impact, 'impact: sub boom + crack + splash + sparkle');
  }
  // ------------------------------------------------------------ 跳跃：“啵嘤”上滑 + 落地闷响（和画面的预备/落地对齐）
  const boing = (t0, h) => {
    const len = Math.ceil(0.35 * SR), s = new Float32Array(len);
    let ph = 0;
    for (let i = 0; i < len; i++) { const t = i / SR, f = 260 + 520 * h * smooth(t / 0.18); ph += TAU * f / SR; s[i] = Math.sin(ph) * Math.exp(-t * 7) * 0.35; }
    put(sfx, t0, s, { pan: 0.1, send: 0.2 });
  };
  const thump = (t0, v) => {
    const len = Math.ceil(0.3 * SR), s = new Float32Array(len), nz = new Noise(S());
    let ph = 0;
    for (let i = 0; i < len; i++) { const t = i / SR; ph += TAU * (120 * Math.exp(-t * 9) + 50) / SR; s[i] = (Math.sin(ph) * 0.8 + nz.white() * 0.15 * Math.exp(-t * 40)) * Math.exp(-t * 12) * v; }
    put(sfx, t0, s, { pan: 0.1, send: 0.1 });
  };
  boing(C.jump[0], 1); thump(C.jump[1], 0.6); boing(C.hop2[0], 0.6); thump(C.hop2[1], 0.4);
  cue(C.jump[0], 'boing / thump on the jumps');

  // 音乐在入水那一刻“断”0.35 秒（ducking 曲线）：t → 增益
  const duck = (t) => 1 - 0.85 * smooth(invLerp(C.impact - 0.04, C.impact, t)) * (1 - smooth(invLerp(C.impact + 0.3, C.impact + 0.6, t)));
  return { report, duck };
}
