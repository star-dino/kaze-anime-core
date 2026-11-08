// 新故事骨架：复制整个 story-skeleton/ 到 anime-core/src/story-<名字>/，
// 再把 anime-core/src/main.js 的 import 指向它。下面每一处 TODO 都是你要填的。
import { smooth, invLerp, mix3, easeInOut } from '../core/util.js';

// ---------------------------------------------------------------- 节拍（唯一时间真相）
export const CUES = {
  fadeInEnd: 0.6,
  turn: [1.4, 2.0],          // TODO：你的节拍
  sparkle: 2.6,
  fadeOutStart: 3.4,
};

// ---------------------------------------------------------------- 世界布局（米）
export const HERO = [0, 0];  // 主角站位 x, z（面朝 -Z）

const SUN = { k: 1, sunElev: 30, sunAz: 150 };

export const SHOTS = [
  { name: 'wide', start: 0, end: 2.0,
    cam: (lt, d) => ({ pos: mix3([-6, 2.2, -10], [-5.5, 2.3, -9], easeInOut(lt / d)), look: [0, 1.2, 0], fov: 35 }),
    look: () => ({ ...SUN, key: [-0.4, 0.6, -0.7] }) },
  { name: 'close', start: 2.0, end: 4.0,
    cam: (lt, d) => ({ pos: mix3([-2.2, 1.8, -3.6], [-2.0, 1.8, -3.3], lt / d), look: [0, 1.4, 0], fov: 30 }),
    look: () => ({ ...SUN, key: [-0.4, 0.6, -0.7] }) },
];

export const story = {
  title: 'TODO 片名',
  fps: 24,
  duration: 4,
  cues: CUES,
  shots: SHOTS,
  look: { ...SUN, shadow: { center: [HERO[0], 1, HERO[1]], radius: 3, depth: 10 } },
  state(st) {
    const t = st.t, c = CUES;
    if (t < c.fadeInEnd) { st.fade = 1 - smooth(t / c.fadeInEnd); st.fadeColor = '#ffffff'; }
    if (t > c.fadeOutStart) { st.fade = smooth(invLerp(c.fadeOutStart, 3.95, t)) * 0.9; st.fadeColor = '#fff6e6'; }
  },
  departments: [
    { name: 'world', load: () => import('./world.js'), factory: 'createWorld' },
    { name: 'hero', load: () => import('./hero.js'), factory: 'createHero' },
    { name: 'fx', load: () => import('./fx.js'), factory: 'createFx' },
  ],
};
export default story;
