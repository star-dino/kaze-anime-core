// 离线渲染整片 → MP4（可断点续渲）。精简自原作 tools/render.mjs（原版还有多页并行、崩溃回收、源码哈希防混剪等）。
//   node tools/render.mjs [--scale 2] [--from 0] [--to N] [--seg 48] [--crf 16] [--name <片名>] [--force] [--reuse] [--mixed]
//   GPU=1 node tools/render.mjs …   用显卡渲染（见 env.mjs；分段元数据记录 webgl 渲染器，换渲染器的旧分段自动重渲，--mixed 跳过这项检查）
// 产物一律进 out/<片名>/：分段 out/<片名>/render/，成片 out/<片名>/<片名>.mp4
// 原理：
//   1. 无头 Chrome 打开影片页，逐帧 FILM.renderFrame(n) + FILM.capture() 拿 JPEG
//   2. JPEG 通过管道喂给 ffmpeg（mjpeg → libx264 -tune animation），每 --seg 帧一个分段文件
//   3. 已完成的分段（有 .json 记录且参数 + 源码哈希一致）下次直接跳过 → 中断后重跑同一命令即可续渲。
//      源码哈希 = src/ 和 index.html 全部文件内容的 sha1：改了任何代码，旧分段自动作废，不会把旧画面拼进新片。
//      --reuse：忽略源码哈希、保留所有旧分段（明确知道改动只影响某几个镜头时用：先删掉那几段的 out/render/<片名>/seg_XXXXX.*，再 --reuse 重跑）
//   4. concat 拼接（不重编码），有 out/<片名>/soundtrack.wav 就混进去（AAC 256k）
// 能这样做的前提：每一帧都是时间的纯函数，乱序/分段渲染结果完全一致。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ROOT, FILM, filmOut, serve, launch, openFilm } from './env.mjs';

const argv = process.argv.slice(2);
const opt = { scale: 2, from: 0, to: null, seg: 48, crf: 16, q: 0.95, name: FILM, force: false, reuse: false, mixed: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--scale') opt.scale = parseFloat(v());
  else if (a === '--from') opt.from = parseInt(v(), 10);
  else if (a === '--to') opt.to = parseInt(v(), 10);
  else if (a === '--seg') opt.seg = parseInt(v(), 10);
  else if (a === '--crf') opt.crf = parseFloat(v());
  else if (a === '--q') opt.q = parseFloat(v());
  else if (a === '--name') opt.name = v();
  else if (a === '--force') opt.force = true;
  else if (a === '--reuse') opt.reuse = true;
  else if (a === '--mixed') opt.mixed = true;
  else { console.error('unknown option ' + a); process.exit(2); }
}
const OUT = filmOut(opt.name), SEG = path.join(OUT, 'render');   // 每部片一个目录：out/<片名>/
fs.mkdirSync(SEG, { recursive: true });
const pad5 = (n) => String(n).padStart(5, '0');
function srcHash() {
  const h = crypto.createHash('sha1');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { h.update(path.relative(ROOT, p)); h.update(fs.readFileSync(p)); }
  } };
  walk(path.join(ROOT, 'src'));
  h.update(fs.readFileSync(path.join(ROOT, 'index.html')));
  return h.digest('hex').slice(0, 12);
}
const SRC = srcHash();
const frames = (f) => parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim(), 10);

const srv = await serve();
const browser = await launch();
const T0 = Date.now();
try {
  const { page, errors, renderer } = await openFilm(browser, srv.url, `scale=${opt.scale}`);
  const fatal = errors.filter((e) => /^\[(error|pageerror)\]/.test(e));
  if (fatal.length) throw new Error('film page logged errors while loading (a department failed?):\n' + fatal.join('\n'));
  const { FRAMES, FPS } = await page.evaluate(() => ({ FRAMES: window.FILM.FRAMES, FPS: window.FILM.FPS }));
  const to = Math.min(opt.to ?? FRAMES, FRAMES);
  const key = JSON.stringify({ scale: opt.scale, crf: opt.crf, q: opt.q, FPS });
  const segs = [];
  for (let a = Math.floor(opt.from / opt.seg) * opt.seg; a < to; a += opt.seg) segs.push({ from: Math.max(a, opt.from), to: Math.min(a + opt.seg, to) });
  console.log(`${FRAMES} frames @ ${FPS} fps; rendering [${opt.from}, ${to}) in ${segs.length} segment(s), scale ${opt.scale}, src ${SRC}`);
  let done = 0;
  for (const s of segs) {
    const file = path.join(SEG, `seg_${pad5(s.from)}.mp4`), meta = file.replace(/\.mp4$/, '.json');
    s.file = file;
    if (!opt.force && fs.existsSync(file) && fs.existsSync(meta)) {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      // 渲染器也要一致（C6）：SwiftShader 与 GPU 的分段有 PSNR≈44 dB 的差异，不能混拼进同一支成片
      // 旧版元数据没有 renderer 字段：按旧行为接受（不知道当时用的是什么后端，别因此整片重渲）
      const sameGL = m.renderer === undefined || m.renderer === renderer || opt.mixed;
      if (m.key === key && (opt.reuse || m.src === SRC) && m.to === s.to && fs.statSync(file).size === m.bytes && sameGL) { console.log(`  seg ${pad5(s.from)} complete, skipped`); continue; }
      if (!sameGL) console.log(`  seg ${pad5(s.from)} was rendered on "${m.renderer}" — re-rendering on this renderer (--mixed to keep it)`);
    }
    const part = file.replace(/\.mp4$/, '.part.mp4');
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(FPS), '-i', '-',
      '-vf', 'format=gbrp,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', String(opt.crf), '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', part], { stdio: ['pipe', 'ignore', 'inherit'] });
    const exited = new Promise((ok) => ff.on('close', ok));
    const ts = Date.now();
    for (let n = s.from; n < s.to; n++) {
      const data = await page.evaluate((n, q) => { window.FILM.renderFrame(n); return window.FILM.capture(q); }, n, opt.q);
      const buf = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
      if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once('drain', ok));
      done++;
    }
    ff.stdin.end();
    if ((await exited) !== 0) throw new Error('ffmpeg failed');
    if (frames(part) !== s.to - s.from) throw new Error(`segment ${pad5(s.from)} has wrong frame count`);
    fs.renameSync(part, file);
    fs.writeFileSync(meta, JSON.stringify({ from: s.from, to: s.to, key, src: SRC, bytes: fs.statSync(file).size, renderer }));
    console.log(`  seg ${pad5(s.from)} [${s.from}, ${s.to}) ${((Date.now() - ts) / 1000 / (s.to - s.from)).toFixed(2)} s/frame`);
  }
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
  // 拼接 + 混音
  const list = path.join(SEG, 'concat.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${path.basename(s.file)}'`).join('\n') + '\n');
  const video = path.join(OUT, `${opt.name}_video.mp4`), final = path.join(OUT, `${opt.name}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
  const wav = path.join(OUT, 'soundtrack.wav');   // render-audio.mjs 写到同一个目录
  if (fs.existsSync(wav)) {
    const a = (opt.from / FPS).toFixed(6), d = ((to - opt.from) / FPS).toFixed(6);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', wav, '-filter_complex', `[1:a]atrim=start=${a},asetpts=PTS-STARTPTS,apad=whole_dur=${d},atrim=end=${d}[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', final]);
    console.log(`muxed soundtrack -> ${path.relative(ROOT, final)}`);
  } else { fs.copyFileSync(video, final); console.log(`no soundtrack -> ${path.relative(ROOT, final)} (picture only)`); }
  console.log(`${frames(final)} frames, ${(fs.statSync(final).size / 1e6).toFixed(1)} MB; rendered ${done} frame(s) in ${((Date.now() - T0) / 1000).toFixed(0)} s`);
} finally {
  await browser.close();
  srv.close();
}
