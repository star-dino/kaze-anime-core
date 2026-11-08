// 出静帧给人/AI 审片（原作最重要的迭代工具：每个部门改完都出静帧，用 Read 工具“看图”自查）。
//   node tools/snap.mjs [--scale 1] [--name <片名>] [--out out/<片名>/snaps] [--sheet name] spec...
// spec: f:120（帧） | t:4.8（秒） | s:gaze（镜头中点） | s:gaze@0.8（镜头内比例）
//       "q:test=1&cam=-10,3,-20&at=0,6,0&t=2=name:mycam"（自由机位）
// 每个 spec 末尾可加 =名字 指定文件名。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FILM, filmOut, serve, launch, openFilm } from './env.mjs';

const args = process.argv.slice(2);
let scale = '1', out = null, sheet = null, q = 0.92, name0 = FILM;
const specs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--scale') scale = args[++i];
  else if (a === '--name') name0 = args[++i];
  else if (a === '--out') out = args[++i];
  else if (a === '--sheet') sheet = args[++i];
  else if (a === '--q') q = parseFloat(args[++i]);
  else specs.push(a);
}
const outDir = path.resolve(ROOT, out ?? path.join(filmOut(name0), 'snaps'));
fs.mkdirSync(outDir, { recursive: true });
const srv = await serve();
const browser = await launch();
let shared = null;
const files = [];
const t0 = Date.now();
try {
  for (let si = 0; si < specs.length; si++) {
    let spec = specs[si], name = null;
    if (spec.startsWith('q:') && spec.includes('=name:')) [spec, name] = spec.split('=name:');
    else { const eq = spec.lastIndexOf('='); if (eq > 0 && !spec.startsWith('q:')) { name = spec.slice(eq + 1); spec = spec.slice(0, eq); } }
    let page, errors, frame;
    if (spec.startsWith('q:')) {
      ({ page, errors } = await openFilm(browser, srv.url, `scale=${scale}&${spec.slice(2)}`));
      frame = await page.evaluate(() => { const p = new URLSearchParams(location.search); return p.get('frame') ? +p.get('frame') : Math.round(parseFloat(p.get('t') ?? '0') * window.FILM.FPS); });
      name = name ?? `q${si}`;
    } else {
      if (!shared) shared = await openFilm(browser, srv.url, `scale=${scale}`);
      ({ page, errors } = shared);
      const fps = await page.evaluate(() => window.FILM.FPS);
      if (spec.startsWith('f:')) frame = parseInt(spec.slice(2), 10);
      else if (spec.startsWith('t:')) frame = Math.round(parseFloat(spec.slice(2)) * fps);
      else if (spec.startsWith('s:')) {
        const [nm, fr] = spec.slice(2).split('@');
        frame = await page.evaluate((nm, fr) => { const s = window.FILM.SHOTS.find((x) => x.name === nm); return Math.round((s.start + (s.end - s.start) * fr) * window.FILM.FPS); }, nm, fr ? parseFloat(fr) : 0.5);
      }
      name = name ?? `f${String(frame).padStart(4, '0')}`;
    }
    const ts = Date.now();
    const data = await page.evaluate((n, q) => { window.FILM.renderFrame(n); return window.FILM.capture(q); }, frame, q);
    const file = path.join(outDir, name + '.jpg');
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    files.push(file);
    console.log('wrote', path.relative(ROOT, file), `(frame ${frame}, ${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    if (errors.length) { console.log(errors.slice(0, 20).join('\n')); errors.length = 0; }
    if (spec.startsWith('q:')) await page.close();
  }
} finally {
  await browser.close();
  srv.close();
}
// 联系表（contact sheet）：多张静帧拼一张，方便一次性审片
if (sheet && files.length) {
  const cols = Math.min(3, files.length), n = files.length;
  const inputs = files.flatMap((f) => ['-i', f]);
  const lay = files.map((_, i) => { const c = i % cols, r = Math.floor(i / cols); return `${c ? Array(c).fill('w0').join('+') : '0'}_${r ? Array(r).fill('h0').join('+') : '0'}`; }).join('|');
  const filter = files.map((_, i) => `[${i}:v]scale=640:-1[v${i}]`).join(';') + ';' + files.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${n}:layout=${lay}:fill=black`;
  const dst = path.join(outDir, sheet + '.jpg');
  if (n === 1) fs.copyFileSync(files[0], dst);
  else execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-frames:v', '1', '-q:v', '3', dst]);
  console.log('sheet', path.relative(ROOT, dst));
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
