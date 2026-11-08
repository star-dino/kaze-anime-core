import { smooth, invLerp, easeInOut, easeOut, mix3, kick } from '../core/util.js';

// 示例故事「星のかけら / 星之碎片」8 秒：
// 盛夏海边的岬角上站着一只小恐龙。它抬头 —— 一颗星星碎片划过晴空坠入大海，
// 闪光、电光、涟漪；小恐龙开心地跳了起来。淡出到暖白。
//
// 换故事时，只需要换掉 src/story/ 整个文件夹：core/ 一行都不用改。

// ---------------------------------------------------------------- 剧情节拍（全片唯一的时间真相）
export const CUES = {
  fadeInEnd: 0.8,
  lookUp: [2.3, 2.9],      // 小恐龙抬头
  streak: 3.2,             // 星星出现在天空
  impact: 4.6,             // 坠入大海：闪光 + 电光 + 涟漪
  jump: [5.6, 6.3],        // 开心地一跳（预备 → 腾空 → 落地）
  hop2: [6.7, 7.05],       // 再一小跳
  fadeOutStart: 7.2,
};

// 世界布局（米）：水面 y=0；小恐龙站在一条窄岬角的崖边（地面约 y=6），面朝 -Z（大海）。
export const DINO = [0, -4];                 // x, z（y 由地形决定）
export const IMPACT = [-22, 0, -120];
export const STAR_FROM = [120, 125, -470];

const SUN = { k: 1, sunElev: 34, sunAz: 160 };

export const SHOTS = [
  // 1. 低机位远景：海面上仰望崖边的小恐龙，太阳在它身后（逆光 + 边缘光），主光作弊从镜头侧打
  { name: 'hill', start: 0, end: 3.0,
    cam: (lt, d) => ({ pos: mix3([-8, 2.0, -42], [-7, 2.2, -37], easeInOut(lt / d)), look: [0, 5.2, -4], fov: 30 }),
    look: () => ({ ...SUN, key: [-0.45, 0.55, -0.7], shafts: 0.35 }) },
  // 2. 过肩：从小恐龙背后看向大海，星星从右上划向左下
  { name: 'gaze', start: 3.0, end: 4.6,
    cam: (lt, d) => ({ pos: mix3([3.0, 8.9, 2.4], [2.8, 8.7, 1.8], lt / d), look: [-9, 13, -84], fov: 42 }),
    look: () => ({ ...SUN }) },
  // 3. 广角：入水闪光、涟漪；小恐龙在前景跳起来；镜头被冲击震一下
  { name: 'splash', start: 4.6, end: 8.0,
    cam: (lt, d, t) => {
      const s = kick(t, CUES.impact, 0.35, 3.0);
      const p = mix3([3.6, 9.6, 7.4], [4.0, 10.0, 8.6], easeOut(lt / d));
      return { pos: [p[0] + s[0], p[1] + s[1], p[2]], look: [-13, 3 + s[2] * 2, -114], fov: 38 };
    },
    look: () => ({ ...SUN }) },
];

export const story = {
  title: '星のかけら',
  fps: 24,
  duration: 8,
  width: 1920, height: 1040,
  cues: CUES,
  shots: SHOTS,
  look: { ...SUN, shadow: { center: [DINO[0], 7, DINO[1]], radius: 4, depth: 14 } },
  // 故事专属状态：淡入、入水闪白、淡出
  state(st) {
    const t = st.t, c = CUES;
    if (t < c.fadeInEnd) { st.fade = 1 - smooth(t / c.fadeInEnd); st.fadeColor = '#ffffff'; }
    const a = t - c.impact;
    if (a >= 0 && a < 0.3) { st.fade = 0.85 * (1 - a / 0.3); st.fadeColor = '#ffffff'; }   // 闪白两三帧
    if (t > c.fadeOutStart) { st.fade = smooth(invLerp(c.fadeOutStart, 7.95, t)) * 0.94; st.fadeColor = '#fff6e6'; }
    st.excite = smooth(invLerp(c.impact, c.impact + 0.8, t));   // 情绪曲线：给尾巴/特效用
  },
  // 部门 = 并行开发的单元（原作里每个部门是一个 AI agent，只能改自己的文件）
  departments: [
    { name: 'world', load: () => import('./world.js'), factory: 'createWorld' },
    { name: 'dino', load: () => import('./dino.js'), factory: 'createDino' },
    { name: 'fx', load: () => import('./fx.js'), factory: 'createFx' },
  ],
};
export default story;
