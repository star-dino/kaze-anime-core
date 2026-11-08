// 工具链公共部分：静态服务器 + 无头 Chrome（开 GPU / 软件 WebGL）。
// 改编自原作 tools/env.mjs，补了 Linux / WSL 的默认值：
//   - 原作写死 --use-angle=d3d11（只适合 Windows）；Linux 默认用 swiftshader（纯 CPU，慢但稳），
//     有可用 GPU 时可设 ANGLE=gl 或 ANGLE=vulkan 提速。
//   - puppeteer-core 先找本项目 node_modules，找不到再看 TOOLS_DIR。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 片名与输出目录约定：一部片的所有产物都落在 out/<片名>/ 下。
// 片名 = --name（工具自己解析，缺省见各工具）→ 环境变量 STORY（多片并存时用它选片）→ 'film'。
// 例：STORY=cape-keeper 时，配乐/分段/成片是 out/cape-keeper/{soundtrack.wav,render/,cape-keeper.mp4}。
export const FILM = process.env.STORY || 'film';
export const filmOut = (name = FILM) => path.join(ROOT, 'out', name);

function loadPuppeteer() {
  const tries = [ROOT, process.env.TOOLS_DIR].filter(Boolean);
  for (const dir of tries) {
    try { return createRequire(path.join(dir, 'package.json'))('puppeteer-core'); } catch { /* next */ }
  }
  throw new Error('puppeteer-core not found: run `npm install` here, or set TOOLS_DIR to a folder whose node_modules has it');
}
export const puppeteer = loadPuppeteer();

const CHROME_DEFAULTS = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
};
export const CHROME = process.env.CHROME || CHROME_DEFAULTS[process.platform] || CHROME_DEFAULTS.linux;
// GPU 显式开关（C6）：默认关闭 —— Linux 上走 SwiftShader（纯 CPU），像素级回归基线（示例片 #151 = 77d7bd9f9f92）都按它生成。
// GPU=1：Linux 默认改用 ANGLE=gl 并补 --enable-gpu（WSL2 + NVIDIA 实测约快 9.6×；与 SwiftShader 肉眼一致、
// 但不是逐字节相同（PSNR ≈ 44 dB），所以只用于预览 / 成片，不要拿来比对基线哈希）。ANGLE 显式给出时优先。
export const GPU = process.env.GPU === '1';
const ANGLE = process.env.ANGLE || (process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : GPU ? 'gl' : 'swiftshader');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.css': 'text/css' };

export function serve(root = ROOT) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(root, p === '/' ? 'index.html' : p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

export async function launch() {
  const args = [`--use-angle=${ANGLE}`, '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-sandbox',
    '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'];
  if (ANGLE === 'swiftshader') args.push('--enable-unsafe-swiftshader');
  else args.push('--enable-gpu');
  if (process.platform === 'linux') args.push('--no-sandbox');
  return puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 1200000, args,
    defaultViewport: { width: 1920, height: 1040, deviceScaleFactor: 1 },
  });
}

// 页面实际用的 WebGL 渲染器（UNMASKED_RENDERER_WEBGL）。用一块临时 canvas 查，和影片画布同一个 GPU 进程。
export async function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no-webgl2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }).catch(() => 'unknown');
}
// 打印渲染器；GPU=1 却落回软件渲染 / 核显时给出醒目提示
export function reportRenderer(r) {
  const soft = /swiftshader|llvmpipe|software/i.test(r), igpu = /intel/i.test(r);
  console.log(`webgl renderer: ${r}${GPU ? ' (GPU=1)' : ''}`);
  if (GPU && (soft || igpu)) console.warn(`!!! GPU=1 but the page is rendering on ${soft ? 'a software rasterizer' : 'the integrated GPU'} — check ANGLE / MESA_D3D12_DEFAULT_ADAPTER_NAME`);
  return r;
}

// 打开影片页（headless=1），等 window.FILM_READY
// 环境变量 STORY=<名字> → 加 ?story=<名字>（加载 src/films/<名字>/story.js），所有工具通用
export async function openFilm(browser, base, query = '', page = 'index.html') {
  if (process.env.STORY && !/(^|&)story=/.test(query)) query = `story=${encodeURIComponent(process.env.STORY)}&${query}`;
  const pg = await browser.newPage();
  const errors = [];
  pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  pg.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await pg.goto(`${base}/${page}?headless=1&${query}`, { waitUntil: 'load', timeout: 600000 });
  await pg.waitForFunction('window.FILM_READY === true || window.AUDIO_READY === true', { timeout: 600000 }).catch(() => {});
  const renderer = page === 'index.html' ? reportRenderer(await webglRenderer(pg)) : null;
  return { page: pg, errors, renderer };
}
