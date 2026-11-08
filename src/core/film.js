// “导演层”：把一部片子描述成纯数据 + 纯函数，与渲染完全解耦。
// 原作里这部分写死在各自的 shots.js（Sunshower）或 shots.js + cams/<部门>.js（LEVIATHAN）里，
// 这里把它抽成与故事无关的框架：换故事 = 换一个 story 对象。
//
// story = {
//   title, fps, duration, width, height,
//   cues:  { 名字: 秒 | [秒, 秒] }          ← 剧情节拍。画面、特效、音乐全都以它为准
//   shots: [{ name, start, end, cam(lt, d, t, st) → {pos, look, fov, roll?, near?, far?},
//             look?(lt, d, t, st) → look 对象 }]
//   look:  默认 look（每个镜头的 look 会覆盖它）
//   state?(st) → 给 st 加故事专属字段（天气、情绪、角色姿态……）
//   departments: [{ name, load: () => import('./xxx.js'), factory: 'createXxx' }]
//   presets?: 两套调色板（见 look.js）
//   shadowFix?: true = 角色投影真的画出来（修正阴影 pass 的 GL 反馈回路；旧片为保持逐像素不变而不开，新片都应该开）
// }

export function shotIndexAt(shots, t) {
  for (let i = 0; i < shots.length; i++) if (t < shots[i].end) return i;
  return shots.length - 1;
}

export function createTimeline(story) {
  const FPS = story.fps ?? 24;
  const FRAMES = Math.round(FPS * story.duration);
  const SHOTS = story.shots;
  const CUES = story.cues;

  // 校验：镜头首尾相接、不重叠（AI 改时间时最容易出错的地方）
  for (let i = 1; i < SHOTS.length; i++) {
    if (Math.abs(SHOTS[i].start - SHOTS[i - 1].end) > 1e-6) console.warn(`[film] shot '${SHOTS[i].name}' does not start where '${SHOTS[i - 1].name}' ends`);
  }

  function evalFrame(frame) {
    const t = frame / FPS;
    const si = shotIndexAt(SHOTS, t);
    const sh = SHOTS[si];
    const lt = t - sh.start, dur = sh.end - sh.start;
    const st = { frame, t, si, shot: sh.name, lt, dur, cues: CUES, fade: 0, fadeColor: '#ffffff', shadow: null };
    st.look = { ...(story.look ?? {}), ...(sh.look ? sh.look(lt, dur, t, st) : {}) };
    st.shadow = st.look.shadow ?? null;
    if (story.state) story.state(st);          // 故事专属状态（先于镜头，镜头可以读它来构图）
    st.cam = sh.cam(lt, dur, t, st);
    return st;
  }
  return { FPS, FRAMES, CUES, SHOTS, evalFrame, shotAt: (t) => shotIndexAt(SHOTS, t) };
}
