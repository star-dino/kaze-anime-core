import * as THREE from 'three';
import { Rng } from './util.js';

// 手绘贴图工具（K2，移植自 Sunshower src/textures.js，MIT © Beyond Dev）。
// 原作的做法：机器人身上的编号、名字、标签、铆钉、面板缝都不是字体排版，而是在 canvas 上用“毛笔笔触”画出来，
// 再整体轻微扭动、把边缘啃掉一点（handPaint），像动画色指定表上画在金属上的漆字。
// 这里只移植通用工具；具体角色的贴花在各片自己的文件里画（例：films/<片名>/xxx.js 里调 paintTexture）。
//
// 用法：
//   const t = paintTexture(512, 256, (g, rng) => { letter(g, 'NO 07', 20, 40, 120, rng); bolt(g, 400, 60, 14); }, { seed: 3 });
//   celMaterial({ map: t })                          整张贴图乘到零件上（按几何体的 uv）
//   rig.decal(t, hostMesh, joint, w, h, pos, rot)    贴一块平面贴花（kit.js）
//   celMaterial({ det: [{ tex, axis, sign, rect }] }) 沿局部轴投影到弯曲的装甲上（面板线、标记）
// 颜色规则：celMaterial 会把贴图按 sRGB 解码，和 color: '#hex' 一样处理 —— 画布上画 screen('#hex')（color.js），上屏就是 #hex。

export const INK = '#2a2236';
const SEAM_LIGHT = 'rgba(255,255,255,0.75)';

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// canvas → 纹理（NoColorSpace：着色器里自己处理颜色）
export function tex(c, { mips = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.premultiplyAlpha = false;
  t.anisotropy = 8;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// 一步画好一张贴图：draw(g, rng, c) 画内容；rough > 0 时整体过 handPaint（手绘的抖动和边缘侵蚀）
export function paintTexture(w, h, draw, { seed = 1, rough = 1.6, erode = 0.18, mips = true, repeat = false } = {}) {
  const [c, g] = canvas(w, h);
  const rng = new Rng(seed);
  draw(g, rng, c);
  if (rough > 0) handPaint(c, seed + 101, rough, erode);
  return tex(c, { mips, repeat });
}

// ------------------------------------------------------------ 毛笔字
// 字形骨架：1 个单位高的框（y 向下）。每个字形：[字宽, 笔画列表]
const ell = (cx, cy, rx, ry, a0 = 0, a1 = Math.PI * 2, n = 22) =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
export const GLYPHS = {
  A: [0.62, [[[0, 1], [0.31, 0], [0.62, 1]], [[0.13, 0.64], [0.49, 0.64]]]],
  B: [0.5, [[[0, 1], [0, 0], [0.3, 0], [0.44, 0.08], [0.44, 0.38], [0.28, 0.48], [0, 0.48]], [[0.28, 0.48], [0.47, 0.58], [0.5, 0.82], [0.36, 1], [0, 1]]]],
  C: [0.52, [ell(0.3, 0.5, 0.3, 0.5, -0.6, -Math.PI * 2 + 0.6, 26)]],
  D: [0.54, [[[0, 0], [0, 1], [0.24, 1], [0.46, 0.86], [0.54, 0.5], [0.46, 0.14], [0.24, 0], [0, 0]]]],
  E: [0.44, [[[0.44, 0], [0, 0], [0, 1], [0.44, 1]], [[0, 0.5], [0.36, 0.5]]]],
  F: [0.42, [[[0.42, 0], [0, 0], [0, 1]], [[0, 0.5], [0.34, 0.5]]]],
  G: [0.56, [ell(0.28, 0.5, 0.28, 0.5, -0.45, Math.PI * 1.62, 24).reverse().concat([[0.56, 0.58], [0.56, 0.58], [0.32, 0.58]])]],
  H: [0.52, [[[0, 0], [0, 1]], [[0.52, 0], [0.52, 1]], [[0, 0.5], [0.52, 0.5]]]],
  I: [0.06, [[[0.03, 0], [0.03, 1]]]],
  K: [0.5, [[[0, 0], [0, 1]], [[0.5, 0], [0.02, 0.6]], [[0.18, 0.46], [0.5, 1]]]],
  L: [0.44, [[[0, 0], [0, 1], [0.44, 1]]]],
  M: [0.66, [[[0, 1], [0, 0], [0.33, 0.66], [0.66, 0], [0.66, 1]]]],
  N: [0.52, [[[0, 1], [0, 0], [0.52, 1], [0.52, 0]]]],
  O: [0.56, [ell(0.28, 0.5, 0.28, 0.5, -Math.PI / 2, Math.PI * 1.5, 28)]],
  P: [0.5, [[[0, 1], [0, 0], [0.3, 0], [0.45, 0.07], [0.5, 0.24], [0.45, 0.41], [0.3, 0.49], [0, 0.49]]]],
  R: [0.52, [[[0, 1], [0, 0], [0.32, 0], [0.47, 0.08], [0.5, 0.24], [0.45, 0.4], [0.3, 0.48], [0, 0.48]], [[0.24, 0.48], [0.52, 1]]]],
  S: [0.5, [[[0.48, 0.13], [0.36, 0.02], [0.16, 0.0], [0.03, 0.1], [0.04, 0.3], [0.24, 0.46], [0.44, 0.6], [0.5, 0.8], [0.4, 0.96], [0.18, 1.0], [0.0, 0.87]]]],
  T: [0.5, [[[0, 0], [0.5, 0]], [[0.25, 0], [0.25, 1]]]],
  U: [0.52, [[[0, 0], [0, 0.7], [0.08, 0.92], [0.26, 1], [0.44, 0.92], [0.52, 0.7], [0.52, 0]]]],
  V: [0.58, [[[0, 0], [0.29, 1], [0.58, 0]]]],
  W: [0.8, [[[0, 0], [0.2, 1], [0.4, 0.3], [0.6, 1], [0.8, 0]]]],
  X: [0.52, [[[0, 0], [0.52, 1]], [[0.52, 0], [0, 1]]]],
  Y: [0.52, [[[0, 0], [0.26, 0.5], [0.52, 0]], [[0.26, 0.5], [0.26, 1]]]],
  0: [0.5, [ell(0.25, 0.5, 0.25, 0.5, -Math.PI / 2, Math.PI * 1.5, 26)]],
  1: [0.3, [[[0.02, 0.18], [0.24, 0], [0.24, 1]]]],
  2: [0.5, [[[0.02, 0.22], [0.12, 0.05], [0.3, 0], [0.46, 0.1], [0.48, 0.3], [0.36, 0.52], [0, 1], [0.5, 1]]]],
  3: [0.5, [[[0.02, 0.1], [0.2, 0], [0.42, 0.06], [0.46, 0.24], [0.24, 0.46]], [[0.24, 0.46], [0.46, 0.6], [0.48, 0.84], [0.3, 1], [0.02, 0.92]]]],
  4: [0.52, [[[0.38, 1], [0.38, 0], [0, 0.68], [0.52, 0.68]]]],
  5: [0.5, [[[0.46, 0], [0.06, 0], [0.02, 0.44], [0.26, 0.38], [0.46, 0.5], [0.48, 0.8], [0.3, 1], [0.0, 0.92]]]],
  6: [0.5, [[[0.42, 0.04], [0.2, 0.06], [0.04, 0.34], [0.02, 0.7]].concat(ell(0.25, 0.7, 0.24, 0.3, Math.PI, Math.PI * 3, 22))]],
  7: [0.48, [[[0, 0], [0.48, 0], [0.16, 1]]]],
  8: [0.5, [ell(0.25, 0.24, 0.21, 0.24, Math.PI / 2, Math.PI * 2.5, 22), ell(0.25, 0.73, 0.25, 0.27, -Math.PI / 2, Math.PI * 1.5, 22)]],
  9: [0.5, [ell(0.25, 0.27, 0.25, 0.27, 0, Math.PI * 2, 22), [[0.5, 0.27], [0.49, 0.66], [0.36, 0.94], [0.16, 1.0], [0.02, 0.9]]]],
  '-': [0.34, [[[0.04, 0.55], [0.3, 0.55]]]],
  '.': [0.1, [[[0.04, 0.95], [0.06, 0.97]]]],
  ' ': [0.3, []],
};

function catmull(pts, steps = 6) {
  if (pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    // 拐角（重复点或急转）保持锐利，只平滑缓弯
    const sharp = Math.abs(Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(p1[1] - p0[1], p1[0] - p0[0])) > 1.1;
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      if (sharp && pts.length > 4) { out.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]); continue; }
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// 一笔：密集的圆点，宽度像毛笔一样起笔收笔变细
export function brushStroke(g, pts, width, rng, color = INK) {
  const path = catmull(pts, 8);
  let total = 0;
  const seg = [];
  for (let i = 1; i < path.length; i++) { const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); seg.push(d); total += d; }
  g.fillStyle = color;
  const press = rng.range(0.9, 1.1);
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1], [x1, y1] = path[i];
    const n = Math.max(1, Math.ceil(seg[i - 1] / (width * 0.18)));
    for (let k = 0; k < n; k++) {
      const t = k / n, u = (acc + seg[i - 1] * t) / Math.max(total, 1e-6);
      const taper = Math.min(1, u / 0.08, (1 - u) / 0.1) * 0.35 + 0.65;
      const w = width * press * taper * (0.92 + 0.16 * Math.sin(u * 9 + press * 7));
      g.beginPath(); g.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, 0, Math.PI * 2); g.fill();
    }
    acc += seg[i - 1];
  }
}

// 手写一行字（只支持 GLYPHS 里有的字符）。h = 字高（px），slant = 前倾
export function letter(g, text, x, y, h, rng, { width = h * 0.085, slant = 0.1, track = 0.16, color = INK, squash = 1 } = {}) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const [adv, strokes] = GLYPHS[ch] || GLYPHS[' '];
    const jx = rng.range(-0.01, 0.01) * h, jy = rng.range(-0.02, 0.02) * h, js = rng.range(0.97, 1.03);
    for (const s of strokes) {
      const pts = s.map(([px, py]) => {
        const X = cx + jx + px * h * squash * js + (1 - py) * h * slant + rng.range(-0.006, 0.006) * h;
        const Y = y + jy + py * h * js + rng.range(-0.006, 0.006) * h;
        return [X, Y];
      });
      brushStroke(g, pts, width, rng, color);
    }
    cx += (adv * squash + track) * h;
  }
  return cx - x;
}
export function measure(text, h, { track = 0.16, squash = 1 } = {}) {
  let w = 0;
  for (const ch of String(text).toUpperCase()) w += ((GLYPHS[ch] || GLYPHS[' '])[0] * squash + track) * h;
  return w - track * h;
}

// 整张画轻微扭动 + 边缘啃掉一点：像漆在金属上的手绘标记
export function handPaint(c, seed, amp = 1.6, erode = 0.18) {
  const g = c.getContext('2d');
  const { width: W, height: H } = c;
  const src = g.getImageData(0, 0, W, H), dst = g.createImageData(W, H);
  const rng = new Rng(seed);
  const ph = [rng.range(0, 6), rng.range(0, 6), rng.range(0, 6), rng.range(0, 6)];
  const n2 = (x, y) => Math.sin(x * 0.043 + ph[0]) * Math.cos(y * 0.051 + ph[1]) + 0.5 * Math.sin(x * 0.11 + y * 0.07 + ph[2]);
  const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233 + ph[3]) * 43758.5453; return s - Math.floor(s); };
  const S = src.data, D = dst.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.round(n2(x, y) * amp), dy = Math.round(n2(y + 37, x + 11) * amp);
      const sx = Math.min(W - 1, Math.max(0, x + dx)), sy = Math.min(H - 1, Math.max(0, y + dy));
      const si = (sy * W + sx) * 4, di = (y * W + x) * 4;
      D[di] = S[si]; D[di + 1] = S[si + 1]; D[di + 2] = S[si + 2];
      let a = S[si + 3];
      if (a > 0 && a < 255) a = a * (1 - erode * hash(x, y));
      else if (a === 255 && hash(x >> 1, y >> 1) < erode * 0.06) a = 120;
      D[di + 3] = a;
    }
  }
  g.putImageData(dst, 0, 0);
}

// ------------------------------------------------------------- 面板细节
// 刻线：一条深色线 + 旁边一条细高光（draw() 里只写路径）
export function seam(g, draw, w = 3.2, { ink = INK, light = SEAM_LIGHT } = {}) {
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.translate(1.6, 1.8); g.strokeStyle = light; g.lineWidth = w * 0.7; g.beginPath(); draw(); g.stroke();
  g.restore();
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = ink; g.lineWidth = w; g.globalAlpha = 0.9; g.beginPath(); draw(); g.stroke();
  g.restore();
}
// 铆钉 / 螺栓头：亮面 + 暗面 + 一字槽 + 描边
export function bolt(g, x, y, r, { lit = '#d9dae6', dark = '#8f8fb4', mid = '#c4c5d8', ink = INK } = {}) {
  g.fillStyle = lit; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = dark; g.beginPath(); g.arc(x + r * 0.28, y + r * 0.28, r * 0.78, 0, Math.PI * 2); g.fill();
  g.fillStyle = mid; g.beginPath(); g.arc(x - r * 0.1, y - r * 0.1, r * 0.6, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink; g.lineWidth = Math.max(1.6, r * 0.28); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(x - r * 0.45, y); g.lineTo(x + r * 0.45, y); g.stroke();
}
// 一组圆孔（2 + 1 + 2），孔里暗、孔边一圈亮
export function holeCluster(g, cx, cy, r, gap, mirror = 1, { rim = '#c9cbe0', hole = '#2b2440', holeHi = '#4a4266', ink = INK } = {}) {
  const pos = [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]].map(([a, b]) => [cx + a * gap * mirror, cy + b * gap]);
  for (const [x, y] of pos) {
    g.fillStyle = rim; g.beginPath(); g.arc(x, y, r * 1.18, 0, Math.PI * 2); g.fill();
    g.strokeStyle = ink; g.lineWidth = 3; g.stroke();
    g.fillStyle = hole; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = holeHi; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, Math.PI * 2); g.fill();
    g.strokeStyle = ink; g.lineWidth = 3.5; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  }
}
// 小字标签（用系统字体，逐字轻微抖动；适合日文小字，远看是“标签的感觉”）
export function smallLabel(g, text, x, y, size, rng, color = INK) {
  g.save();
  g.fillStyle = color; g.textBaseline = 'middle';
  g.font = `700 ${size}px "Yu Gothic", "Meiryo", "Noto Sans CJK JP", "MS Gothic", sans-serif`;
  let cx = x;
  for (const ch of text) {
    const w = g.measureText(ch).width;
    g.save(); g.translate(cx + w / 2, y + rng.range(-1, 1)); g.rotate(rng.range(-0.04, 0.04)); g.fillText(ch, -w / 2, 0); g.restore();
    cx += w * 1.02;
  }
  g.restore();
}
