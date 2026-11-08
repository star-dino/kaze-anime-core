// 内核回归测试片（不是作品）：在示例场景上验证 局部暖光 / 星空 / 发光涟漪(24 槽) / 多段调色板，
// 以及 v3 下沉的 天穹 skyDome / 斜射光束 / 旋转残影 / 重型缓动 + 碰撞体 / 命名权重调色 / 柔边淡变（v3Test.js），
// 飞散物 / 云影 / 纸张质感 / 逆光透亮 / 水帘与溅落 / 玻璃水珠 / 描线粗细（weatherTest.js），
// 雨打水面的雨环 / 地面水洼（rainWaterTest.js），远方雨墙交接近处雨丝 / 盔甲雨雾（rainWallTest.js）。
//   STORY=_coretest node tools/snap.mjs s:dayToNight@0.5 ...
import base, { DINO } from '../../story/story.js';
import { DEFAULT_PRESETS } from '../../core/look.js';
import { Ripples } from '../../core/fx.js';
import { onThrees } from '../../core/util.js';
import { terrain } from '../../story/world.js';
import { PROXY_AT } from './proxyTest.js';
import { SURF_AT } from './surfaceTest.js';
import { ROTOR_AT } from './v3Test.js';
import { GALE_AT, WET_AT, galeWind, cloudOffset } from './weatherTest.js';
import { RAIN_AT } from './rainWaterTest.js';
import { RAINWALL_AT, STORM_PRESET } from './rainWallTest.js';
import { smooth, invLerp } from '../../core/util.js';

const S = DEFAULT_PRESETS.summer;
// 四段调色板：夜(0) → 逢魔(0.3) → 金暮(0.62) → 白天(1)
export const PRESETS = {
  night: { at: 0, stars: 1,
    sunColor: '#c8b8ff', sunStrength: 0.35, skyTint: '#5a6aa8', shadeTint: '#6a6aa8', deepTint: '#4a4a88', bounce: '#5a7aa8',
    sky: { zenith: '#0e1238', mid: '#1f2a66', warm: '#6a4a8a', cool: '#2c3a78', cloudLit: '#8a86c8', cloudMid: '#5a5aa0', cloudShade: '#34366e', star: '#fff4e0' },
    fog: { warm: '#4a4a80', cool: '#2a3468', density: 0.0018, mist: 0.2, mistHeight: 4 },
    water: { deep: '#0c1a40', shallow: '#1c3a6a', foam: '#c8d0ff', skyRefl: '#3a4a8a' },
    grade: { lift: '#0e1024', gain: '#f4f0ff', sat: 1.04 } },
  magic: { at: 0.3, stars: 0.45,
    sunColor: '#ffb08a', sunStrength: 0.6, skyTint: '#b89ad8', shadeTint: '#8a7ac8', deepTint: '#6a5aa8', bounce: '#c8a0c8',
    sky: { zenith: '#2a2a78', mid: '#7a5ab0', warm: '#ffb07a', cool: '#9a7ac8', cloudLit: '#ffd0a8', cloudMid: '#d89ab8', cloudShade: '#7a6aa8', star: '#fff0e0' },
    fog: { warm: '#e8a8a8', cool: '#8a7ab8', density: 0.0019, mist: 0.24, mistHeight: 5 },
    water: { deep: '#2a3070', shallow: '#5a5a98', foam: '#ffe0e8', skyRefl: '#c890b8' },
    grade: { lift: '#181430', gain: '#fff4f0', sat: 1.08 } },
  gold: { at: 0.62,
    sunColor: '#ffd08a', sunStrength: 0.85, skyTint: '#ffe0c0', shadeTint: '#a69ad0', deepTint: '#7a74b8', bounce: '#f0d0b0',
    sky: { zenith: '#3060b8', mid: '#88a8d8', warm: '#ffd8a0', cool: '#c8c8e0', cloudLit: '#fff0d0', cloudMid: '#f0d0c0', cloudShade: '#a89ac8' },
    fog: { warm: '#f8e0c0', cool: '#c8d0e4', density: 0.0017, mist: 0.18, mistHeight: 4 },
    water: { deep: '#1a6a88', shallow: '#4aa0a8', foam: '#fff4e0', skyRefl: '#e0d0c8' },
    grade: { lift: '#1a1a2c', gain: '#fffaf0', sat: 1.06 } },
  day: { ...S, at: 1 },
  storm: STORM_PRESET,          // at = 2：只给 presetWeights 用（rainWall），k 轴 0..1 的插值不变
};

const LAMP = [DINO[0] + 0.55, 7.0, DINO[1] - 1.1];
// R1/R2 测试角色（proxyTest.js）：两只并排、面朝 +Z，中点 PROXY_AT
const PX = [PROXY_AT[0], terrain(PROXY_AT[0], PROXY_AT[1]), PROXY_AT[1]];
const SX = [SURF_AT[0], terrain(SURF_AT[0], SURF_AT[1]), SURF_AT[1]];
const RX = [ROTOR_AT[0], terrain(ROTOR_AT[0], ROTOR_AT[1]), ROTOR_AT[1]];
const RW = [RAINWALL_AT[0], terrain(RAINWALL_AT[0], RAINWALL_AT[1]), RAINWALL_AT[1]];

const SHOTS = [
  // 1 正面看恐龙：k 从 1 走到 0（白天 → 金暮 → 逢魔 → 夜），灯笼在它身前右下
  { name: 'dayToNight', start: 0, end: 4,
    cam: () => ({ pos: [2.2, 7.6, -11.5], look: [0, 7.4, -4], fov: 34 }),
    look: (lt, d) => ({ k: 1 - lt / d, sunElev: 26 - 24 * lt / d, sunAz: 160, key: [-0.35, 0.55, -0.75],
      lights: [{ pos: LAMP, color: '#ffb35a', radius: 3.2, intensity: 1.1 * Math.min(1, lt / 1.2) }] }) },
  // 2 越过恐龙看海：夜空星星 + 海面一串发光涟漪
  { name: 'stars', start: 4, end: 8,
    cam: () => ({ pos: [2.8, 8.9, 2.4], look: [-6, 14, -84], fov: 46 }),
    look: () => ({ k: 0.02, sunElev: 2, sunAz: 175, key: [-0.35, 0.55, 0.75],
      lights: [{ pos: LAMP, color: '#ffb35a', radius: 3.2, intensity: 1.1 }] }) },
  // 3 明暗代理（R1）+ 圆角盒（R2）：从海上正面看两只测试角色（左旧右新），主光与脸朝向的夹角从 30° 扫到 150°
  //   （角色面朝 -Z = 方位 0°；az 30 = 主光在正面偏 +X 30°，az 150 = 从侧后方打来）
  { name: 'proxy', start: 8, end: 12,
    cam: () => ({ pos: [PX[0], PX[1] + 0.42, PX[2] - 2.3], look: [PX[0], PX[1] + 0.26, PX[2]], fov: 30 }),
    look: (lt, d) => ({ k: 1, sunElev: 35, sunAz: 30 + 120 * lt / d, shadow: { center: [PX[0], PX[1] + 0.3, PX[2]], radius: 1.2, depth: 6 } }) },
  // 4 表面细节（K1 风化 / K2 贴花 / K4 挂在零件上的苔藓）：从海上看三件零件，右边那件转一整圈
  { name: 'surface', start: 12, end: 16,
    cam: () => ({ pos: [SX[0], SX[1] + 1.1, SX[2] - 4.6], look: [SX[0], SX[1] + 0.6, SX[2]], fov: 34 }),
    look: () => ({ k: 1, sunElev: 38, sunAz: 35, shadow: { center: [SX[0], SX[1] + 0.6, SX[2]], radius: 2.6, depth: 8 } }) },
  // 5 天穹（C2）+ 斜射光束（C1）：积云 → 阴云 → 2 s 起雨后一侧云开，太阳在画面左侧，屏幕光束从云隙斜洒向海面
  { name: 'stormSky', start: 16, end: 20,
    cam: () => ({ pos: [0, 9, 0], look: [-40, 15, -70], fov: 58 }),
    look: (lt) => ({ k: 1, sunElev: 9, sunAz: -44, sunDisk: 1, key: [-0.5, 0.4, -0.7],
      shafts: lt >= 2 ? 0.9 * smooth(invLerp(2, 3, lt)) : 0, shaftStyle: 'slanted', shaftBeams: 7 }) },
  // 6 旋转残影（C3）+ 重型缓动 / 碰撞体（C4）+ 命名权重调色 / 柔边淡变（C5）
  { name: 'motionArc', start: 20, end: 24,
    cam: () => ({ pos: [RX[0] + 0.8, RX[1] + 4.4, RX[2] - 4.6], look: [RX[0] + 0.7, RX[1] + 1.6, RX[2]], fov: 42 }),   // 俯视 ~30°：转子平面不能侧对镜头
    look: (lt) => ({ presetWeights: { day: 1 - 0.7 * smooth(lt / 3.2), gold: 0.7 * smooth(lt / 3.2) }, sunElev: 30, sunAz: 40,
      shadow: { center: [RX[0] + 0.8, RX[1] + 1.2, RX[2]], radius: 3, depth: 8 } }) },
  // 7 大风草地：飞散物（W2）+ 云影（W5，偏移 = 风的积分 W7）+ 纸张质感 / 暗角 / 颗粒（K5）
  { name: 'gale', start: 24, end: 28,
    cam: () => ({ pos: [GALE_AT[0], terrain(GALE_AT[0], GALE_AT[1]) + 1.7, GALE_AT[1]], look: [GALE_AT[0] - 4, terrain(GALE_AT[0], GALE_AT[1]) + 0.9, GALE_AT[1] + 8], fov: 50 }),
    look: (lt) => ({ k: 1, sunElev: 40, sunAz: 20, wind: { dir: [0.95, 0.3], strength: galeWind(24 + lt), phase: cloudOffset(24 + lt) * 1.4 },
      cloudShadow: { strength: 0.75, scale: 0.06, offset: [-cloudOffset(24 + lt) * 0.95, -cloudOffset(24 + lt) * 0.3] },
      paper: 0.7, vignette: 0.28, grain: 0.035 }) },
  // 8 雨檐：水帘 / 溅落 / 雨滴（W8 / W10）+ 玻璃水珠（W11）+ 逆光花瓣（W6）+ 描线粗细（K3）。太阳在镜头对面偏左上 → 花瓣逆光
  { name: 'wetGlass', start: 28, end: 32,
    cam: () => ({ pos: [WET_AT[0], terrain(WET_AT[0], WET_AT[1]) + 1.5, WET_AT[1] - 4.2], look: [WET_AT[0], terrain(WET_AT[0], WET_AT[1]) + 1.0, WET_AT[1]], fov: 46 }),
    look: (lt) => ({ k: 0.62 + 0.38 * smooth(invLerp(1.6, 2.8, lt)), sunElev: 14, sunAz: 165,   // 不给 key：主光跟太阳 → 朝镜头的面都是逆光
      shadow: { center: [WET_AT[0], terrain(WET_AT[0], WET_AT[1]) + 1, WET_AT[1]], radius: 3.5, depth: 8 } }) },
  // 9 雨打水面（W8：look.rainRings）+ 地面水洼（W10：paintMaterial puddles + look.puddles）：站在崖顶湿地上看海，
  //   太阳在镜头对面低处 → 水洼里有太阳倒影亮点，海面和水洼里同一套雨环；雨环在 1 s 内由疏变密
  { name: 'rainWater', start: 32, end: 36,
    cam: () => ({ pos: [RAIN_AT[0] + 0.5, terrain(RAIN_AT[0] + 0.5, RAIN_AT[1] + 1) + 2.4, RAIN_AT[1] + 1], look: [RAIN_AT[0] - 2, 0, RAIN_AT[1] - 17], fov: 48 }),
    look: (lt) => ({ k: 0.82, sunElev: 15, sunAz: -14, rainRings: { amount: 0.5 + 0.5 * smooth(invLerp(0, 1, lt)), scale: 0.7 }, puddles: { amount: 0.5, scale: 0.4 } }) },
  // 10 远方雨墙（W9）推过海面交接给近处雨丝 + 盔甲雨雾（W8）（rainWallTest.js）
  { name: 'rainWall', start: 36, end: 40,
    cam: () => ({ pos: [RW[0] - 2.6, RW[1] + 2.1, RW[2] + 2.6], look: [RW[0] + 4, RW[1] + 3.0, RW[2] - 12], fov: 52 }),
    look: () => ({ presetWeights: { storm: 1 }, sunElev: 30, sunAz: 200, key: [0.45, 0.6, 0.6], sunDisk: 0,
      shadow: { center: [RW[0], RW[1] + 1.2, RW[2]], radius: 2.2, depth: 8 } }) },
];

export default {
  ...base,
  title: 'core test',
  shots: SHOTS,
  presets: PRESETS,
  duration: 40,
  shadowFix: true,
  state(st) {
    base.state(st); if (st.t >= 8) st.fade = 0;                  // 示例片 7.2 s 起淡出；测试镜头不要
    if (st.t >= 23.2 && st.t < 24) { st.fade = smooth(invLerp(23.2, 23.95, st.t)); st.fadeColor = '#fff8ec'; st.fadeSoft = 0.8; }   // C5 柔边淡白
  },
  departments: [
    ...base.departments.filter((d) => d.name !== 'fx'),
    { name: 'glowRip', load: async () => ({ create: (ctx) => {
      const rip = new Ripples(ctx.engine.mWater.uniforms);
      return { update(st) {
        rip.begin();
        if (st.t >= 4) {
          // 20 个：一串沿航线的发光涟漪 + 4 个普通涟漪（测槽位与混用）
          // 远处一个“出水”：同一点 6 圈（青金），近处一条航迹 14 个（暖金，间隔 6 m）
          for (let i = 0; i < 6; i++) rip.push(-14, -60, onThrees(4 + i * 0.35), 0.3, 4.5, 1.2, 0.3, 0.6, { color: '#7ff0e0', power: 1.0 });
          for (let i = 0; i < 14; i++) rip.push(-2 - i * 1.2, -14 - i * 6, onThrees(4 + i * 0.2), 0.1, 1.6, 0.5, 0.3, 0.3, { color: '#ffd27a', power: 0.9 });
          for (let i = 0; i < 4; i++) rip.push(6 + i * 3, -24 - i * 4, onThrees(4.2 + i * 0.3), 0.2, 2, 0.4, 0.4, 1);
        }
        rip.end();
      } };
    } }), factory: 'create' },
    { name: 'proxyTest', load: () => import('./proxyTest.js'), factory: 'createProxyTest' },
    { name: 'surfaceTest', load: () => import('./surfaceTest.js'), factory: 'createSurfaceTest' },
    { name: 'v3Test', load: () => import('./v3Test.js'), factory: 'createV3Test' },
    { name: 'weatherTest', load: () => import('./weatherTest.js'), factory: 'createWeatherTest' },
    { name: 'rainWaterTest', load: () => import('./rainWaterTest.js'), factory: 'createRainWaterTest' },
    { name: 'rainWallTest', load: () => import('./rainWallTest.js'), factory: 'createRainWallTest' },
  ],
};
