import * as THREE from 'three';
import { Engine } from './engine.js';
import { G } from './glsl.js';
import { applyLook } from './look.js';
import { createTimeline } from './film.js';
import { onTwos, deg } from './util.js';

// 运行时：把 story 跑起来，并暴露 window.FILM 给工具链（snap / render / probe）。
// 与原作 main.js 一致的约定：
//   ?scale=2            内部超采样（预览用 1）
//   ?frame=N / ?t=秒     打开时显示哪一帧
//   ?test=1&cam=x,y,z&at=x,y,z&fov=35&t=3   自由机位（检查布景/构图）
//   ?k=1&elev=24&az=150 覆盖光照（test 模式）
//   ?<部门名>=0          跳过某个部门（定位是谁出的问题）
//   其余参数通过 ctx.params 交给部门自己解释（例如角色的 ?expr=happy&mouth=1&pose=rest）
//   ?headless=1          给无头渲染用：不自动画第一帧、隐藏 UI

// 颜色空间注意（原作同样如此）：three r170 默认 ColorManagement.enabled = true，
// THREE.Color('#hex') 会被转换成线性值，而管线输出不做 sRGB 编码、最后由 FINAL_FS 的
// gamma 0.84 + exposure 1.12 提亮。所以 look.js 里写的 hex ≠ 屏幕上的颜色（屏幕上更深更艳）。
// 所有调色板都是在这个前提下调出来的；如果关掉 ColorManagement，必须整体重调调色板和 grade。

export async function boot(story, canvas) {
  const P = new URLSearchParams(location.search);
  const S = parseFloat(P.get('scale') ?? '2');
  const W = story.width ?? 1920, H = story.height ?? 1040;
  canvas.width = W; canvas.height = H;

  const engine = new Engine(canvas, W, H, S);
  const scene = new THREE.Scene();
  const overlay = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 9000);
  const TL = createTimeline(story);
  // params：URL 参数原样交给各部门（例如角色部门的 ?expr=happy&mouth=1 —— 出设定图/表情表时覆盖表演）
  const ctx = { THREE, scene, overlay, engine, camera, G, CUES: TL.CUES, SHOTS: TL.SHOTS, FPS: TL.FPS, shadowRoots: [], sky: null, story, params: P };

  // 部门独立加载：任何一个模块崩了都退化成 no-op，其他部门照常出图（多 agent 并行开发的保险丝）
  const NOOP = { update() {} };
  const order = [];
  for (const d of story.departments) {
    if (P.get(d.name) === '0') { ctx[d.name] = NOOP; continue; }
    try {
      const mod = await d.load();
      ctx[d.name] = (await mod[d.factory](ctx)) || NOOP;
    } catch (e) {
      console.error(`[${d.name}] failed to load: ${e.stack || e}`);
      ctx[d.name] = NOOP;
    }
    order.push(d.name);
  }

  const num3 = (s) => s.split(',').map(Number);
  function stateFor(frame) {
    const st = TL.evalFrame(frame);
    if (P.get('test') === '1') {
      if (P.get('cam')) st.cam = { pos: num3(P.get('cam')), look: num3(P.get('at') ?? '0,1,0'), fov: parseFloat(P.get('fov') ?? '35') };
      const L = { ...st.look };
      if (P.get('k')) L.k = parseFloat(P.get('k'));
      if (P.get('elev')) L.sunElev = parseFloat(P.get('elev'));
      if (P.get('az')) L.sunAz = parseFloat(P.get('az'));
      st.look = L;
      if (P.get('fade') === '0') st.fade = 0;
    }
    return st;
  }

  const _v = new THREE.Vector3();
  function renderState(st) {
    G.uTime.value = st.t;
    G.uDrawTime.value = onTwos(st.t);
    applyLook(ctx, st.look, story.presets);
    const c = st.cam;
    camera.position.set(...c.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(_v.set(...c.look));
    if (c.roll) camera.rotateZ(deg(c.roll));
    camera.fov = c.fov;
    camera.near = c.near ?? 0.1;
    camera.far = c.far ?? 9000;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    for (const d of order) {
      try { ctx[d].update(st); } catch (e) { console.error(`[${d}] update failed: ${e.stack || e}`); }
    }
    scene.updateMatrixWorld(true);
    overlay.updateMatrixWorld(true);
    const sh = st.shadow;
    engine.render(scene, overlay, camera, {
      shadow: sh && { center: new THREE.Vector3(...sh.center), radius: sh.radius, depth: sh.depth },
      shadowRoots: ctx.shadowRoots, shadowFix: !!story.shadowFix,
      frame: st.frame, fade: st.fade, fadeColor: st.fadeColor, fadeSoft: st.fadeSoft ?? st.look.fadeSoft,
      inkSeed: Math.floor(st.t * 12) % 5,          // 描线笔压噪声随“原画”换（一拍二）
      paintRadius: st.look.paintRadius ?? 4, inkWidth: st.look.inkWidth, waterLevel: st.look.waterLevel ?? 0,
      water: st.look.water,
    });
    ctx.lastState = st;
  }

  window.FILM = {
    FPS: TL.FPS, FRAMES: TL.FRAMES, CUES: TL.CUES, SHOTS: TL.SHOTS, ctx, story: { title: story.title, duration: story.duration },
    renderFrame(n) { renderState(stateFor(n)); return true; },
    capture(q = 0.93) { return canvas.toDataURL('image/jpeg', q); },
    stateFor,
  };
  // 预热：首帧会有 GPU 懒初始化差异，先渲一帧丢掉，保证所有采集帧确定一致
  renderState(stateFor(0));
  window.FILM_READY = true;

  const startFrame = parseInt(P.get('frame') ?? (P.get('t') ? Math.round(parseFloat(P.get('t')) * TL.FPS) : 0), 10);
  if (P.get('headless') !== '1') {
    window.FILM.renderFrame(startFrame);
    document.dispatchEvent(new CustomEvent('film-ready', { detail: { frame: startFrame } }));
  }
  return window.FILM;
}
