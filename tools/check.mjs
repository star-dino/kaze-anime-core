// 快速加载检查：打开影片页，等 FILM_READY，打印控制台错误。  node tools/check.mjs [秒] [query]
import { serve, launch, webglRenderer, reportRenderer } from './env.mjs';

const secs = parseFloat(process.argv[2] ?? '60');
const query = (process.env.STORY ? `story=${encodeURIComponent(process.env.STORY)}&` : '') + (process.argv[3] ?? '');
const srv = await serve();
const browser = await launch();
try {
  const page = await browser.newPage();
  const log = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${srv.url}/index.html?headless=1&scale=1&${query}`, { waitUntil: 'load', timeout: secs * 1000 });
  const ready = await page.waitForFunction('window.FILM_READY === true', { timeout: secs * 1000 }).then(() => true, () => false);
  const info = ready ? await page.evaluate(() => ({ frames: window.FILM.FRAMES, fps: window.FILM.FPS, shots: window.FILM.SHOTS.map((s) => s.name) })) : null;
  console.log('ready:', ready, info ? JSON.stringify(info) : '');
  reportRenderer(await webglRenderer(page));
  console.log(log.filter((l) => !l.includes('favicon')).join('\n') || '(no errors)');
  process.exitCode = ready && !log.some((l) => /\[(error|pageerror)\]/.test(l)) ? 0 : 1;
} finally {
  await browser.close();
  srv.close();
}
