// 探针：在给定时刻读出角色骨骼 / 锚点的世界坐标（米），用来放道具、定机位。
//   STORY=cape-keeper node tools/probe.mjs --dept nagi --t 8,40 [--joints ankleR,handR,head] [--q extra=1]
//
// 巡检模式（C4：重型机甲的膝盖 / 肩甲挡脸、挡主体，自穿模）—— 不给 --t 时自动取每个镜头的首 / 中 / 尾帧：
//   --check-cam @lens,flower.head          相机 → 主体：中间被别的赛璐璐零件挡住就告警
//   --check-sight @lens>flower.head        角色视线：A → B 的连线被挡住就告警（多对用逗号分隔）
//   --collide                              Rig.checkSelfCollision()（需要建模时 addCollider）
//   --tol 0.35                             目标点附近多少米内的命中不算遮挡（锚点通常贴在零件表面上）
//   --shots s03_reach,s10_under_eave       只查这些镜头
// 目标写法：@anchor（--dept 的锚点）| dept@anchor（别的部门的 rig.anchors / anchors）| dept.method（调用 ctx[dept].method(vec3, t)，
//   例如 flower.head）| x;y;z（世界坐标）。只把赛璐璐零件（有 uId 的材质）当遮挡物：绘画背景、草、雨、overlay 都不算。
// 有告警时退出码为 1，可以放进 CI。
import { serve, launch, openFilm } from './env.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);
const dept = opt('dept', 'nagi');
const joints = opt('joints', '').split(',').filter(Boolean), q = opt('q', '');
const camTargets = opt('check-cam', '').split(',').filter(Boolean);
const sightPairs = opt('check-sight', '').split(',').filter(Boolean).map((p) => p.split('>'));
const collide = has('collide'), tol = parseFloat(opt('tol', '0.35'));
const onlyShots = opt('shots', '').split(',').filter(Boolean);
const inspect = camTargets.length || sightPairs.length || collide;

const srv = await serve();
const browser = await launch();
let warnings = 0;
try {
  const { page } = await openFilm(browser, srv.url, `scale=0.25&${q}`);
  let times = opt('t', '') ? opt('t').split(',').map(Number) : null;
  if (!times) {
    times = await page.evaluate((only) => window.FILM.SHOTS.filter((s) => !only.length || only.includes(s.name))
      .flatMap((s) => [s.start + 0.05, (s.start + s.end) / 2, s.end - 0.05]), onlyShots);
    if (!inspect) times = [0];
  }
  if (inspect) {
    await page.evaluate(async () => { window.__THREE = await import(location.origin + '/vendor/three.module.js'); });
  }
  for (const t of times) {
    if (!inspect) {
      const out = await page.evaluate((dept, t, joints) => {
        const F = window.FILM, n = Math.round(t * F.FPS);
        F.renderFrame(n);
        const rig = F.ctx[dept]?.rig; if (!rig) return 'no rig';
        const names = joints.length ? joints : [...Object.keys(rig.anchors).map((a) => '@' + a)];
        const r = {};
        for (const nm of names) {
          const o = nm.startsWith('@') ? rig.anchors[nm.slice(1)] : rig.j[nm];
          if (!o) { r[nm] = null; continue; }
          o.updateMatrixWorld(true);
          const e = o.matrixWorld.elements;
          r[nm] = [e[12], e[13], e[14]].map((v) => +v.toFixed(2));
        }
        return { t, shot: F.ctx.lastState?.shot, ...r };
      }, dept, t, joints);
      console.log(JSON.stringify(out));
      continue;
    }
    const rep = await page.evaluate((dept, t, camTargets, sightPairs, collide, tol) => {
      const THREE = window.__THREE, F = window.FILM, n = Math.round(t * F.FPS);
      F.renderFrame(n);
      const ctx = F.ctx, st = ctx.lastState;
      const scene = ctx.scene ?? ctx.camera?.parent;
      const point = (spec) => {
        const v = new THREE.Vector3();
        if (spec.includes(';')) return v.set(...spec.split(';').map(Number));
        if (spec.includes('@')) {
          const [d, a] = spec.split('@'); const D = ctx[d || dept];
          const o = D?.rig?.anchors?.[a] ?? D?.anchors?.[a]; if (!o) return null;
          o.updateMatrixWorld(true); return v.setFromMatrixPosition(o.matrixWorld);
        }
        const [d, m] = spec.split('.'); const fn = ctx[d]?.[m];
        if (typeof fn !== 'function') return null;
        const r = fn.call(ctx[d], v, st.t); return r?.isVector3 ? r : v;
      };
      const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
      const occluders = [];
      scene?.traverse((o) => { if (o.isMesh && o.material?.uniforms?.uId && shown(o)) occluders.push(o); });
      // 零件名 = 最近的具名祖先（通常是 rig 关节）+ 材质 id（同一关节下多个零件靠 id 区分）
      const label = (o) => { let n = o.type; for (let p = o; p; p = p.parent) if (p.name) { n = p.name; break; } return `${n}#${o.material.uniforms.uId.value}`; };
      const rc = new THREE.Raycaster();
      const blocked = (A, B) => {
        const d = B.clone().sub(A), L = d.length(); if (L < 1e-4) return null;
        rc.set(A, d.divideScalar(L)); rc.near = tol; rc.far = Math.max(0, L - tol);
        const hit = rc.intersectObjects(occluders, false)[0];
        return hit ? { part: label(hit.object), at: +hit.distance.toFixed(2), of: +L.toFixed(2) } : null;
      };
      const out = { t: +t.toFixed(2), frame: n, shot: st.shot, issues: [] };
      const camPos = new THREE.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld);
      for (const s of camTargets) {
        const P = point(s); if (!P) { out.issues.push(`cam→${s}: target not found`); continue; }
        const ndc = P.clone().project(ctx.camera);
        if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) continue;          // 不在画面里：不查
        const b = blocked(camPos, P); if (b) out.issues.push(`cam→${s} blocked by "${b.part}" at ${b.at}/${b.of} m`);
      }
      for (const [a, b2] of sightPairs) {
        const A = point(a), B = point(b2); if (!A || !B) { out.issues.push(`${a}>${b2}: target not found`); continue; }
        const b = blocked(A, B); if (b) out.issues.push(`sight ${a}>${b2} blocked by "${b.part}" at ${b.at}/${b.of} m`);
      }
      if (collide) {
        const rig = ctx[dept]?.rig;
        if (!rig?.colliders?.length) out.issues.push(`collide: ${dept} has no colliders (rig.addCollider)`);
        else for (const c of rig.checkSelfCollision({ minDepth: 0.01 })) out.issues.push(`clip ${c.a} × ${c.b} depth ${c.depth} m`);
      }
      return out;
    }, dept, t, camTargets, sightPairs, collide, tol);
    warnings += rep.issues.length;
    console.log(`${rep.issues.length ? 'WARN' : 'ok  '} t=${rep.t} frame ${rep.frame} ${rep.shot}${rep.issues.length ? '\n       ' + rep.issues.join('\n       ') : ''}`);
  }
  if (inspect) { console.log(warnings ? `${warnings} issue(s)` : 'no issues'); process.exitCode = warnings ? 1 : 0; }
} finally { await browser.close(); srv.close(); }
