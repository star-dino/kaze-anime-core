import { track } from '../../core/util.js';
import { DEFAULT_PRESETS } from '../../core/look.js';
import { screen } from '../../core/color.js';
import { weatherLook } from './weather.js';

// 光与色（天空·云·雨部门拥有）：调色板、色彩脚本（时间 → 调色板混合 k / 太阳）、lookAt(t)。
// 设计要点：
//   1. 单侧柔和斜阳由天穹着色器的侧光光幕呈现（shafts 置 0）；
//   2. 73.5 s 黑场静默期间切换至海岬左侧低角度暖阳（sunAz = -44°, sunElev = 12°→9°），亮回后阳光从画面一侧自然洒入。

const S = DEFAULT_PRESETS.summer;
export const PRESETS = {
  // 雨后单侧暖阳（k = 0）：左侧暖金斜阳 + 右侧清透薰衣草蓝暗部，温润不刺眼
  gold: { at: 0,
    sunColor: '#ffd692', sunStrength: 0.92, skyTint: '#ffe8cc', shadeTint: '#9a94ca', deepTint: '#6c6ab0', bounce: '#f2d2aa',
    sky: { zenith: screen('#3d74c4'), mid: screen('#86b4dc'), warm: screen('#ffdc9e'), cool: screen('#c4cce6'),
      cloudLit: screen('#fff3d6'), cloudMid: screen('#e8c4b2'), cloudShade: screen('#8882b4') },
    fog: { warm: '#f8e2c0', cool: '#c4cee6', density: 0.0010, mist: 0.18, mistHeight: 8 },
    water: { deep: '#1f5e7c', shallow: '#4e92a4', foam: '#fff4d6', skyRefl: '#f2cfa8' },
    grade: { lift: '#18192a', gain: '#fffaf2', sat: 1.06 } },

  // 暴雨（k = 0.35）：石板蓝与灰紫主调，暗部带冷蓝紫色相，海面自然深沉
  storm: { at: 0.35,
    sunColor: '#b8c6dc', sunStrength: 0.28, skyTint: '#96a6c2', shadeTint: '#6a789e', deepTint: '#465276', bounce: '#6a808c',
    sky: { zenith: screen('#303e56'), mid: screen('#4d5d78'), warm: screen('#6c7890'), cool: screen('#5b6a86'),
      cloudLit: screen('#8a96b0'), cloudMid: screen('#5f6b84'), cloudShade: screen('#39435b') },
    fog: { warm: '#707c90', cool: '#5e6c84', density: 0.0038, mist: 0.34, mistHeight: 24 },
    water: { deep: '#213447', shallow: '#3f5468', foam: '#d6dfe9', skyRefl: '#606e84' },
    grade: { lift: '#121725', gain: '#eaf0f8', sat: 0.82 } },

  // 起风转阴（k = 0.62）：高空云层增厚，天光转冷白青灰
  gale: { at: 0.62,
    sunColor: '#eaeef2', sunStrength: 0.58, skyTint: '#dae2ee', shadeTint: '#949ec6', deepTint: '#6a74a4', bounce: '#b2cad0',
    sky: { zenith: screen('#486fa8'), mid: screen('#8ea8cc'), warm: screen('#dfe4e8'), cool: screen('#c0ccde'),
      cloudLit: screen('#f0f3f8'), cloudMid: screen('#c2cce0'), cloudShade: screen('#848eb4') },
    fog: { warm: '#dce2e8', cool: '#bcc8da', density: 0.0017, mist: 0.20, mistHeight: 9 },
    water: { deep: '#28647a', shallow: '#54929e', foam: '#f0f6fa', skyRefl: '#becad8' },
    grade: { lift: '#171b29', gain: '#f8faff', sat: 0.95 } },

  // 盛夏晴空（k = 1.0）：清爽浅青蓝天顶，地平线柔和泛白
  summer: { ...S, at: 1, fog: { ...S.fog, density: 0.0010 },
    sky: { ...S.sky, zenith: screen('#4b97cf'), mid: screen('#84bee0'), warm: screen('#eef2e6'), cool: screen('#cfe6ee') } },
};

// ---------------------------------------------------------------- 色彩脚本（100 s 时间轴）
// 73.5 s 处于黑场静默（71.2–76.4 s 淡黑过渡），在此处无痕切换至雨后单侧暖金晨光/斜阳
export const K_SCRIPT = [
  [0, 1.0], [27.5, 0.98],
  [35.0, 0.72], [44.0, 0.56], [52.0, 0.44], [58.0, 0.35],
  [73.4, 0.35], [73.6, 0.08], [86.0, 0.03], [100.0, 0.0],
];
const ELEV = [
  [0, 48], [28, 45], [45, 36], [73.4, 28],
  [73.6, 13.5], [100, 9.5],
];
// sunAz：0 = 正朝海(-Z)，负值朝画面左侧(-X 西海面)。雨后定在 -44°，使阳光从海岬左侧斜射入画，不糊在画面正中
const AZ = [
  [0, 56], [45, 42], [73.4, 35],
  [73.6, -44], [100, -47],
];

export function lookAt(t, extra = {}) {
  return {
    k: track(K_SCRIPT, t),
    sunElev: track(ELEV, t),
    sunAz: track(AZ, t),
    shafts: 0,               // 禁用 passes.js 全向轮辐噪声，由 sky_storm.js 绘制单侧柔和云隙斜光
    ...weatherLook(t),
    ...extra,
  };
}
