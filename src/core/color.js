import * as THREE from 'three';

// “屏幕色”→ 管线输入色。
//
// 为什么需要：three r170 的 THREE.Color('#hex') 会把 hex 当 sRGB 线性化，而管线最后不做 sRGB 编码，
// 只在 FINAL_FS 里做 曝光 ×1.12 → gamma 0.84 → 饱和度（+自然饱和度）→ lift/gain。
// 结果是：材质里写的 hex 在屏幕上更深、更艳（例：薄荷绿 #8ad66f 上屏变成草绿 #4fb52c 一类）。
// 场景调色板都是在这个前提下“凭眼睛”调出来的，没问题；但角色设定色（model sheet）必须所见即所得 ——
// 设计师说“身体是 #8ad66f”，屏幕上平涂处就该是它。
//
// screen(hex) 反解最终调色，返回一个 hex：拿它当材质颜色，“不受光的平涂处”在屏幕上就是 hex。
// 受光面会再乘太阳色（偏暖），暗部乘薰衣草暗部色 —— 那是打光，属于有意为之。
// 参数默认等于 engine.js 的 FINAL 默认值 + look.js summer 预设的 grade；换了 grade 可以传进来。

const LUM = [0.299, 0.587, 0.114];
const lin = (hex) => new THREE.Color(hex);   // ColorManagement 打开时 = 线性值（与管线里的 uniform 一致）

export function screen(hex, o = {}) {
  const exposure = o.exposure ?? 1.12, gamma = o.gamma ?? 0.84, sat = o.sat ?? 1.06, vib = o.vibrance ?? 0.3;
  const lift = lin(o.lift ?? '#161c2e'), gain = lin(o.gain ?? '#fffdf8');
  const t = new THREE.Color(); t.setStyle(hex, THREE.NoColorSpace);   // 目标：屏幕上的原始值（不线性化）
  let d = [t.r, t.g, t.b];
  // 撤销 lift/gain
  d = d.map((x, i) => (x - [lift.r, lift.g, lift.b][i]) / Math.max(1e-4, [gain.r, gain.g, gain.b][i] - [lift.r, lift.g, lift.b][i]));
  // 撤销饱和度：s_eff = sat * (1 + vib * (1 - chroma_before))，chroma_before 未知 → 不动点迭代
  const l = d[0] * LUM[0] + d[1] * LUM[1] + d[2] * LUM[2];
  let c = d.slice();
  for (let it = 0; it < 8; it++) {
    const chroma = Math.max(...c) - Math.min(...c);
    const s = sat * (1 + vib * (1 - chroma));
    c = d.map((x) => l + (x - l) / s);
  }
  // 撤销 gamma 与曝光 → 线性的管线输入
  const pre = c.map((x) => Math.pow(Math.max(x, 0), 1 / gamma) / exposure);
  // 交还给 THREE.Color 时它会再线性化一次，所以这里编码回 sRGB
  const out = new THREE.Color().setRGB(...pre.map((x) => Math.min(1, x)), THREE.LinearSRGBColorSpace);
  return '#' + out.getHexString();
}

// 一组设定色一次换算：{ body: '#8ad66f', ... } → 同名的管线色
export const screenAll = (pal, o) => Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, screen(v, o)]));
