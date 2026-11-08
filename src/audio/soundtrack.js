// 声音总装：OfflineAudioContext 离线渲染，长度精确等于影片时长。
//   music  → 大厅混响 → ducking（入水瞬间“断”一下）─┐
//   sfx    → 户外短混响 ───────────────────────────┴→ 求和 → 峰值归一化 → 末尾淡出 → 16-bit WAV
// 原作在此之上还有：BS.1770 响度归一化（LUFS）、前视限幅器、按镜头的水下闷音、频谱图审听。
//
// 混响后端（opt-in，默认不变 → 旧片配乐逐字节一致）：
//   'native'（默认）  OfflineAudioContext 的 ConvolverNode。注意：Chrome 的卷积器不是逐位确定的，
//                     同一部 100 s 片多次渲染偶尔会有几百个采样差 ±1 LSB。
//   'js'              纯 JS float64 FFT 重叠相加卷积（dsp.js 的 convolveStereo + makeIRData），信号图完全相同：
//                     music 干声 + music send→大厅(返回 0.5) → ducking 曲线；sfx 干声 + sfx send→户外(返回 0.4)；
//                     求和 → 峰值 -1.5 dB → 10 ms 淡入 / 0.8 s cos² 淡出。每次渲染逐位相同；
//                     与 native 的零延迟对齐，差值约在 -100 dB 量级（只差 float32 舍入）。100 s 片卷积约 1–2 s。
// 选择方式（优先级从高到低）：
//   renderSoundtrack(story, log, { reverb: 'js' })   ← audio.html 的 ?reverb=js、tools/render-audio.mjs --reverb js
//   story.audio = { reverb: 'js' }                    ← 片子自己声明（推荐需要逐位可复现配乐的片子用）
import { SR, Bus, makeIR, makeIRData, convolveStereo, encodeWav, dbToGain } from './dsp.js';
import { buildScore } from './score.js';

const PEAK_DB = -1.5;
// 两个混响的参数（native / js 共用）
const HALL = { dur: 3, rt60: 2.2, seed: 3, bright: 7000 }, HALL_RET = 0.5;
const AIR = { dur: 1.6, rt60: 0.9, seed: 11, bright: 5000 }, AIR_RET = 0.4;

function toBuffer(ctx, bus, n) {
  const b = ctx.createBuffer(2, n, SR);
  b.copyToChannel(bus.L.subarray(0, n), 0); b.copyToChannel(bus.R.subarray(0, n), 1);
  return b;
}

export async function renderSoundtrack(story, log = () => {}, opts = {}) {
  const dur = story.duration, n = Math.round(dur * SR);
  const t0 = performance.now();
  const music = { dry: new Bus(n), send: new Bus(n) }, sfx = { dry: new Bus(n), send: new Bus(n) };
  // 每部片自带配乐：story.score = (CUES, dur, music, sfx) => { report, duck }（写法照 score.js）；没给就用示例配乐
  const { report, duck } = (story.score ?? buildScore)(story.cues, dur, music, sfx);
  log(`synth ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  // ducking 曲线（200 点/秒）
  const rate = 200, curve = new Float32Array(Math.ceil(dur * rate) + 1);
  for (let i = 0; i < curve.length; i++) curve[i] = duck(i / rate);

  const reverb = opts.reverb ?? story.audio?.reverb ?? 'native';
  let L, R;
  if (reverb === 'js') {
    [L, R] = mixJS(music, sfx, n, dur, curve);
    log(`reverb js ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: n, sampleRate: SR });
    const play = (bus, dst) => { const s = ctx.createBufferSource(); s.buffer = toBuffer(ctx, bus, n); s.connect(dst); s.start(0); };
    const mDuck = ctx.createGain();
    const hall = ctx.createConvolver(); hall.normalize = false; hall.buffer = makeIR(ctx, HALL);
    const hallRet = ctx.createGain(); hallRet.gain.value = HALL_RET;
    const air = ctx.createConvolver(); air.normalize = false; air.buffer = makeIR(ctx, AIR);
    const airRet = ctx.createGain(); airRet.gain.value = AIR_RET;
    const mDry = ctx.createGain(), mSend = ctx.createGain(), sDry = ctx.createGain(), sSend = ctx.createGain();
    mDry.connect(mDuck); mSend.connect(hall); hall.connect(hallRet); hallRet.connect(mDuck); mDuck.connect(ctx.destination);
    sDry.connect(ctx.destination); sSend.connect(air); air.connect(airRet); airRet.connect(ctx.destination);
    play(music.dry, mDry); play(music.send, mSend); play(sfx.dry, sDry); play(sfx.send, sSend);
    mDuck.gain.setValueCurveAtTime(curve, 0, dur);

    const out = await ctx.startRendering();
    L = out.getChannelData(0); R = out.getChannelData(1);
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = dbToGain(PEAK_DB) / Math.max(peak, 1e-6);
  const f0 = Math.round((dur - 0.8) * SR);
  for (let i = 0; i < n; i++) {
    let k = g;
    if (i < 480) k *= i / 480;
    if (i > f0) k *= Math.pow(Math.cos(((i - f0) / (n - f0)) * Math.PI / 2), 2);
    L[i] *= k; R[i] *= k;
  }
  log(`rendered ${((performance.now() - t0) / 1000).toFixed(1)} s, peak gain ${(20 * Math.log10(g)).toFixed(1)} dB`);
  return { wav: encodeWav([L, R]), L, R, report };
}

// 纯 JS 混音（与上面 native 信号图逐节点对应），返回 float32 [L, R]
function mixJS(music, sfx, n, dur, curve) {
  const hall = makeIRData(HALL), air = makeIRData(AIR);
  const [hL, hR] = convolveStereo(music.send.L, music.send.R, hall[0], hall[1], n);
  const [aL, aR] = convolveStereo(sfx.send.L, sfx.send.R, air[0], air[1], n);
  // GainNode 的增益是 float32 AudioParam：返回增益按 float32 取值，与原生一致
  const hg = Math.fround(HALL_RET), ag = Math.fround(AIR_RET);
  // setValueCurveAtTime(curve, 0, dur)：第 i 个采样取 v = (N−1)·t/dur 处的线性插值，曲线结束后保持最后一个值
  const N1 = curve.length - 1, kc = N1 / dur;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i / SR) * kc, k = Math.floor(p);
    const d = k >= N1 ? curve[N1] : curve[k] + (curve[k + 1] - curve[k]) * (p - k);
    L[i] = (music.dry.L[i] + hL[i] * hg) * d + (sfx.dry.L[i] + aL[i] * ag);
    R[i] = (music.dry.R[i] + hR[i] * hg) * d + (sfx.dry.R[i] + aR[i] * ag);
  }
  return [L, R];
}
