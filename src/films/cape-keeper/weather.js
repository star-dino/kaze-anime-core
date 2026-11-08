import { smooth, invLerp, noise1, clamp, onTwos } from '../../core/util.js';
import { CUES } from './cues.js';
import { integral } from '../../core/secondary.js';

// 全片共用的风雨曲线（storyboard.md，100 s）。所有部门（草、云、风杯、雨、花、声音）都读这里，不各自写数。
// 全部是 t 的纯函数；需要积分的量（风杯转角、草浪相位、云漂移）在模块加载时按固定步长积分一次并缓存，
// 之后查表 + 线性插值，所以乱序渲染、断点续渲都一致（同 core/secondary.js 的做法）。

const C = CUES;

function curve(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1] = keys[i], [t0, v0] = keys[i - 1];
      if (t <= t1) return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
    return keys[keys.length - 1][1];
  };
}

// 风力曲线：夏日微风 → 28.5 s 起风翻起草浪 → 35–45 s 头顶风杯急转 → 45.8 s 阵风压弯花茎 → 暴雨狂风 → 73.5 s 黑场雨歇转微风
const W0 = curve([
  [0, 0.11], [27.5, 0.12],
  [31.5, 0.36], [35.0, 0.62], [40.5, 0.82], [45.0, 0.86],
  [45.8, 1.00], [47.2, 0.84], [52.0, 0.88], [57.4, 0.96],
  [65.0, 1.00], [70.5, 0.88], [73.4, 0.08],
  [75.0, 0.08], [92.0, 0.07], [100.0, 0.06],
]);

// 雨量曲线：47.2 s 前无雨（纯风吹草与花）；47.2–52.0 s 稀疏初雨渐起；52.6–57.4 s 随凪伸臂成檐由中雨转为倾盆暴雨；73.5 s 黑场归零
const R0 = curve([
  [0, 0], [47.2, 0],
  [49.5, 0.05], [52.0, 0.16], [55.2, 0.42], [57.4, 0.92],
  [62.0, 1.00], [70.2, 0.95], [72.8, 0.25], [73.5, 0],
]);

// 湿度：初雨慢慢浸润岩石，暴雨彻底湿透，雨后斜阳下保持温润水光并缓慢收干
const WET = curve([
  [0, 0], [47.2, 0], [51.5, 0.38], [57.6, 1.0], [78.0, 1.0], [100.0, 0.52],
]);

// 高空阴云铺展度（0 = 晴朗盛夏积云，1 = 漫天厚重石板蓝暴风雨云）：平稳自然增厚，绝不忽快忽慢
const OVERCAST = curve([
  [0, 0.0], [28.0, 0.0],
  [34.5, 0.32], [41.0, 0.68], [46.5, 0.88], [54.0, 1.0],
  [73.4, 1.0], [73.6, 0.0],
]);

export const wind = (t) => clamp(W0(t) * (1 + 0.10 * noise1(t * 1.4, 3)), 0, 1.08);
export const rain = (t) => clamp(R0(t) * (1 + 0.06 * noise1(t * 0.8 + 7, 5)), 0, 1);
export const wet = WET;
export const overcast = OVERCAST;

// ---- 积分缓存（覆盖全片 100 s + 余量；core/secondary.js 的 integral，W7 下沉）
const integrate = (rate) => integral(rate, { t0: 0, t1: 102, dt: 1 / 240 });

// 草浪“行进距离”（米）：波速随风力平滑变化，强度变化时相位绝不跳变
export const windPhase = integrate((t) => 1.4 + 8.6 * wind(t));
// 云层平稳漂移（度）：保持匀速舒缓推进，消除忽快忽慢感
export const cloudDrift = integrate((t) => 0.022 + 0.048 * wind(t));
// 风杯角速度与转角（弧度）：起风后真实三杯加速飞转（最高 ~19.5 rad/s），不用廉价静态圆盘贴片
export const cupOmega = (t) => 0.85 + 17.6 * Math.pow(wind(t), 1.15);
export const cupAngle = integrate(cupOmega);

// 小花处的护雨遮挡度：凪在 guard [52.6, 57.2] 期间伸出宽大右前臂悬停在花正上方 ~2.85 m 处，遮住狂风与直落暴雨
export function shelter(t) {
  if (t < C.guard[0]) return 0;
  if (t < C.rise[0]) return 0.96 * smooth(invLerp(C.guard[0] + 0.6, C.guard[1], t));
  return 0.96 * (1 - smooth(invLerp(C.rise[0], C.rise[1], t)));
}

export const windAtFlower = (t) => wind(t) * (1 - shelter(t));

// 雨水到来前的稀疏大颗初雨序列（s08_first_drops：47.35 s → 51.90 s，由疏到密，供花抖动、水洼涟漪、水花与音效逐拍同步）
// 每项：[落地时刻 t, 落点类型 'puddle' | 'flower' | 'rock', 偏移 u (0..1), 偏移 v (0..1)]
export const FIRST_DROPS = [
  [47.36, 'rock',   0.25, 0.40],
  [48.22, 'puddle', 0.48, 0.52],
  [48.94, 'flower', 0.50, 0.50],
  [49.54, 'puddle', 0.30, 0.66],
  [50.06, 'rock',   0.72, 0.34],
  [50.50, 'flower', 0.42, 0.58],
  [50.88, 'puddle', 0.65, 0.38],
  [51.20, 'rock',   0.40, 0.74],
  [51.48, 'puddle', 0.52, 0.44],
  [51.72, 'flower', 0.56, 0.46],
  [51.92, 'puddle', 0.36, 0.55],
];

// 风向（世界坐标，从海上 −Z 吹向陆地 +Z，略偏 +X）
export const WIND_DIR = [0.25, 0.97];

// 给 look 用的一包
export function weatherLook(t) {
  return {
    wind: { dir: WIND_DIR, strength: wind(onTwos(t)), phase: windPhase(onTwos(t)) },   // 草浪一拍二
    rain: rain(t),
    wet: wet(t),
    overcast: overcast(t),
    cloudDrift: cloudDrift(t),
  };
}
