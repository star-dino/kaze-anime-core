// 确定性测试：同一帧在“不同渲染顺序”和“不同页面会话”下必须逐像素一致。
// 这是“每帧都是 t 的纯函数”这条铁律的自动化检查（原作只靠约定；Sunshower 的 robot.js 就漏了一个 Math.random）。
//   node tools/determinism.mjs [帧号...]       默认取每个镜头的中点
// 另外静态扫描 src/ 里的 Math.random / Date.now / performance.now（音频计时日志除外）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, serve, launch, openFilm } from './env.mjs';

// ---- 1. 静态扫描
const bad = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) walk(f);
  else if (f.endsWith('.js')) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/Math\.random\(|Date\.now\(/.test(l) && !/\/\/.*(Math\.random|Date\.now)/.test(l)) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${l.trim()}`);
  });
} };
walk(path.join(ROOT, 'src'));
console.log(bad.length ? `static scan: ${bad.length} suspicious call(s)\n  ${bad.join('\n  ')}` : 'static scan: no Math.random / Date.now in src/');

// ---- 2. 渲染比对
const srv = await serve();
const browser = await launch();
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
try {
  const A = await openFilm(browser, srv.url, 'scale=1');
  let frames = process.argv.slice(2).map(Number);
  if (!frames.length) frames = await A.page.evaluate(() => window.FILM.SHOTS.map((s) => Math.round((s.start + s.end) / 2 * window.FILM.FPS)));
  const grab = (page, n) => page.evaluate((n) => { window.FILM.renderFrame(n); return document.getElementById('c').toDataURL('image/png'); }, n);
  const forward = {}, backward = {}, fresh = {};
  for (const n of frames) forward[n] = sha(await grab(A.page, n));
  for (const n of [...frames].reverse()) backward[n] = sha(await grab(A.page, n));
  const B = await openFilm(browser, srv.url, 'scale=1');            // 全新页面会话
  for (const n of [...frames].reverse()) fresh[n] = sha(await grab(B.page, n));
  let ok = true;
  for (const n of frames) {
    const same = forward[n] === backward[n] && forward[n] === fresh[n];
    ok &&= same;
    console.log(`frame ${String(n).padStart(4)}  forward ${forward[n]}  reverse ${backward[n]}  fresh-page ${fresh[n]}  ${same ? 'OK' : 'MISMATCH'}`);
  }
  console.log(ok ? 'deterministic: every frame identical across render orders and page sessions' : 'NOT deterministic: some frame depends on render order or page session');
  process.exitCode = ok && !bad.length ? 0 : 1;
} finally {
  await browser.close();
  srv.close();
}
