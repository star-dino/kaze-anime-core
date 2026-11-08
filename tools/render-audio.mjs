// 渲染配乐 → out/<片名>/soundtrack.wav（48 kHz / 16-bit / 立体声，长度 = 影片时长）
//   node tools/render-audio.mjs [--name <片名>] [--out 路径] [--reverb js|native]
//   --reverb js：纯 JS 卷积混响（每次渲染逐位相同）；不给则按 story.audio.reverb（默认 native = 原生 ConvolverNode）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FILM, filmOut, serve, launch, openFilm } from './env.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--out'), ni = args.indexOf('--name'), ri = args.indexOf('--reverb');
const name = ni >= 0 ? args[ni + 1] : FILM;
const out = path.resolve(ROOT, oi >= 0 ? args[oi + 1] : path.join(filmOut(name), 'soundtrack.wav'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const srv = await serve();
const browser = await launch();
try {
  const { page, errors } = await openFilm(browser, srv.url, ri >= 0 ? `reverb=${encodeURIComponent(args[ri + 1])}` : '', 'audio.html');
  const info = await page.evaluate(() => window.AUDIO.render());
  for (const m of info.log) console.log('  ' + m);
  let b64 = '';
  for (let i = 0; i < info.length; i += 4 << 20) b64 += await page.evaluate((i, n) => window.AUDIO.chunk(i, n), i, 4 << 20);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  for (const [t, l] of info.report.sort((a, b) => a[0] - b[0])) console.log(`  ${t.toFixed(2).padStart(6)} s  ${l}`);
  if (errors.length) console.log(errors.join('\n'));
  try {
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    console.log(`ffprobe duration ${d} s (film ${info.duration} s)`);
  } catch { /* ffprobe optional */ }
} finally {
  await browser.close();
  srv.close();
}
