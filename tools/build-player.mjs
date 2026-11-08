// 打包单文件播放器：MP4 以 base64 塞进 <script type="text/plain">，打开时分块解码成 Blob URL。
// 一个 HTML 文件 = 整部片，离线可看、可直接发给别人（这是 Moss Keeper → Sunshower → LEVIATHAN 一脉相承的交付方式）。
//   node tools/build-player.mjs [--video out/<片名>/<片名>.mp4] [--out dist/<片名>.html] [--poster-time 5.2] [--title 名字]
// 海报写到视频旁边的 out/<片名>/poster.jpg（整部片的产物留在同一个目录）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const o = { video: 'out/film/film.mp4', out: 'dist/film.html', posterTime: 5.2, title: 'anime-core film' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--video') o.video = v(); else if (a === '--out') o.out = v();
  else if (a === '--poster-time') o.posterTime = parseFloat(v()); else if (a === '--title') o.title = v();
  else { console.error('unknown option ' + a); process.exit(2); }
}
const video = path.resolve(ROOT, o.video);
if (!fs.existsSync(video)) { console.error(`no video at ${o.video} - run tools/render.mjs first`); process.exit(1); }
const poster = path.join(path.dirname(video), 'poster.jpg');
fs.mkdirSync(path.dirname(poster), { recursive: true });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(o.posterTime), '-i', video, '-frames:v', '1', '-q:v', '3', poster]);
const tpl = fs.readFileSync(path.join(ROOT, 'player', 'player.html'), 'utf8');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const [head, tail] = tpl.replaceAll('%%TITLE%%', esc(o.title)).replace('%%POSTER%%', fs.readFileSync(poster).toString('base64')).split('%%REEL%%');
const out = path.resolve(ROOT, o.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
const fd = fs.openSync(out, 'w');
fs.writeSync(fd, head);
const bytes = fs.readFileSync(video), CH = 3 * (1 << 20);       // 3 的倍数：分块 base64 能无缝拼接
for (let i = 0; i < bytes.length; i += CH) fs.writeSync(fd, bytes.subarray(i, i + CH).toString('base64'));
fs.writeSync(fd, tail);
fs.closeSync(fd);
console.log(`wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
