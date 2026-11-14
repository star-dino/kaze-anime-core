import * as THREE from 'three';
import { Rng } from './util.js';
import { COMMON, MRT_OUT, WIND_VS } from './glsl.js';
import { base, mat } from './materials.js';

// 植被层（移植自原作 Sunshower src/tex-foliage.js 的 makeFoliageAtlas + bgmaterials.js 的 foliageMaterial）。
// 原作的做法：植物不建模，而是“画”——启动时在 canvas 上用几万个椭圆笔触画出 22 种植物团块，
// 每个笔触只记录“色阶”（r：0 暗 .. 1 亮，按一个固定光向预先算好明暗并量化成 4 阶）、
// 色相偏移（g）和花（b），颜色留到着色器里按调色板 + 当前光照上色。
// 场景里每一丛植物就是一张始终朝向镜头的卡片（InstancedMesh，一次绘制成千上万丛），
// 画好的受光面会根据太阳在屏幕上的左右自动镜像，所以永远和场景光一致。
// 材质 id 0 = 绘画背景：会吃 Kuwahara 笔触、不描线 —— 这就是日系背景美术“手绘感”的来源。
//
// 图集格子（index = col + row * 4）：
//   0 圆冠树   1 灌木丛     2 草簇      3 垂藤
//   4 苔藓垫   5 花丛       6 小树苗    7 鸟巢
//   8 榉树     9 松         10 垂柳     11 双生小树
//   12 芦苇    13 常春藤帘  14 竹       15 铺展灌木
//   16 绣球    17 开花藤帘  18 大樟树   19 花树（樱）
//   20 野花草坡             21 牵牛花架
export const FOLIAGE = {
  roundTree: 0, bush: 1, grass: 2, vines: 3, moss: 4, flowers: 5, sapling: 6, nest: 7,
  zelkova: 8, pine: 9, willow: 10, twinTrees: 11, reeds: 12, ivy: 13, bamboo: 14, shrub: 15,
  hydrangea: 16, vineCurtain: 17, camphor: 18, blossomTree: 19, grassBank: 20, morningGlory: 21,
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { mips = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.premultiplyAlpha = false;
  t.anisotropy = 8;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ foliage
// 4x6 atlas of painted clumps. r = tone, g = hue variation,
// b = blossom (128 = first blossom colour, 255 = second).
// Cells (index = col + row * 4, row 0 at the bottom of the texture):
//   0 round tree   1 bush        2 grass tuft   3 hanging vines
//   4 moss pad     5 flowers     6 sapling      7 bird nest
//   8 zelkova      9 pine        10 willow      11 twin young trees
//   12 reeds       13 ivy drape  14 bamboo      15 spreading shrub
//   16 hydrangea   17 flowering vine curtain    18 camphor giant  19 blossom tree
//   20 grass bank with wildflowers               21 morning-glory trellis
export function makeFoliageAtlas() {
  const cols = 4, rows = 6, S = 512;
  const [c, g] = canvas(cols * S, rows * S);
  const rng = new Rng(4242);
  const L = [-0.55, -0.7, 0.45];
  const ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const toneVal = [0.12, 0.37, 0.62, 0.87];

  const cellOrigin = (idx) => {
    const cx = idx % cols, cyFromBottom = Math.floor(idx / cols);
    return [cx * S, (rows - 1 - cyFromBottom) * S];
  };
  const dab = (x, y, tone, hue, size, ang, bloom = 0, stretch = 0.45) => {
    g.fillStyle = `rgb(${Math.round(toneVal[tone] * 255)},${Math.round(hue * 255)},${bloom === 2 ? 255 : bloom ? 128 : 0})`;
    g.beginPath();
    g.ellipse(x, y, size, size * stretch, ang, 0, Math.PI * 2);
    g.fill();
  };
  // a mound made of spherical blobs, shaded by the light dir and quantised
  const clump = (ox, oy, blobs, o = {}) => {
    const dabs = [];
    for (const b of blobs) {
      // keep every billow inside its cell: a crown clipped by the cell edge reads as a
      // flat-topped block (the 'voxel' look); drapes get a rounded, scalloped top instead
      const topY = b.y - b.r * (b.sq ?? 1) * 1.04 - 14;
      if (topY < 0) b.y -= topY;
      const n = Math.floor(b.r * b.r * (o.density ?? 0.11) * (b.dens ?? 1));
      const sq = b.sq ?? 1;
      for (let i = 0; i < n; i++) {
        const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * b.r * 1.04;
        const x = b.x + Math.cos(a) * rr, y = b.y + Math.sin(a) * rr * sq;
        const nx = (x - b.x) / b.r, ny = (y - b.y) / (b.r * sq);
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        let s = nx * L[0] + ny * L[1] + nz * L[2];
        s += rng.range(-0.18, 0.18) - (y - S * 0.5) / S * (o.vgrad ?? 0.35) + (b.lift ?? 0);
        // inner occlusion between blobs
        s -= (1 - nz) * 0.12;
        const tone = s < -0.05 ? 0 : s < 0.32 ? 1 : s < 0.62 ? 2 : 3;
        const size = rng.range(o.leafMin ?? 5, o.leafMax ?? 13) * (tone === 3 ? 0.9 : 1);
        dabs.push([x, y, tone, rng.next() * 0.3 + (b.hue ?? 0), size, rng.range(-0.9, 0.9) + (o.leafAng ?? 0), (o.bloom && tone >= 2 && rng.next() < o.bloom) ? 1 : 0, o.stretch ?? 0.45]);
      }
    }
    dabs.sort((p, q) => p[2] - q[2] || p[1] - q[1]);
    for (const d of dabs) dab(ox + d[0], oy + d[1], d[2], d[3], d[4], d[5], d[6], d[7]);
  };
  // trunks/branches painted in the darkest tone (r=20 -> tone 0 band)
  const limb = (ox, oy, pts, w0, w1) => {
    g.strokeStyle = 'rgb(20,40,0)'; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      g.lineWidth = w0 + (w1 - w0) * (i / (pts.length - 1));
      g.beginPath(); g.moveTo(ox + pts[i - 1][0], oy + pts[i - 1][1]); g.lineTo(ox + pts[i][0], oy + pts[i][1]); g.stroke();
    }
  };
  const branchy = (ox, oy, x0, y0, ang, len, w, depth, spread, out) => {
    const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
    const mx = (x0 + x1) / 2 + rng.range(-1, 1) * len * 0.12, my = (y0 + y1) / 2;
    limb(ox, oy, [[x0, y0], [mx, my], [x1, y1]], w, w * 0.7);
    if (depth <= 0) { out.push([x1, y1]); return; }
    const n = 2 + (rng.next() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = ang + (i - (n - 1) / 2) * spread + rng.range(-0.25, 0.25);
      branchy(ox, oy, x1, y1, a, len * rng.range(0.6, 0.8), w * 0.62, depth - 1, spread * 0.9, out);
    }
  };

  // 0: big round tree canopy with a trunk
  {
    const [ox, oy] = cellOrigin(0);
    g.strokeStyle = 'rgb(20,40,0)'; g.lineCap = 'round';
    g.lineWidth = 22; g.beginPath(); g.moveTo(ox + 256, oy + 510); g.quadraticCurveTo(ox + 246, oy + 420, ox + 262, oy + 330); g.stroke();
    g.lineWidth = 10; g.beginPath(); g.moveTo(ox + 256, oy + 420); g.lineTo(ox + 200, oy + 350); g.moveTo(ox + 258, oy + 390); g.lineTo(ox + 320, oy + 330); g.stroke();
    const blobs = [];
    for (let i = 0; i < 9; i++) blobs.push({ x: 256 + rng.range(-120, 120), y: 230 + rng.range(-120, 70), r: rng.range(70, 115) });
    blobs.push({ x: 256, y: 160, r: 110 });
    clump(ox, oy, blobs);
  }
  // 1: low bush mound
  {
    const [ox, oy] = cellOrigin(1);
    const blobs = [];
    for (let i = 0; i < 10; i++) blobs.push({ x: 256 + rng.range(-170, 170), y: 380 + rng.range(-70, 60), r: rng.range(55, 95) });
    clump(ox, oy, blobs);
  }
  // 2: grass tuft — vertical blades
  {
    const [ox, oy] = cellOrigin(2);
    const blades = [];
    for (let i = 0; i < 160; i++) {
      const x = 256 + rng.gauss() * 90, h = rng.range(140, 400), lean = rng.range(-60, 60);
      blades.push([x, h, lean, rng.next()]);
    }
    blades.sort((a, b) => a[3] - b[3]);
    for (const [x, h, lean, k] of blades) {
      const tone = k < 0.25 ? 0 : k < 0.55 ? 1 : k < 0.85 ? 2 : 3;
      g.fillStyle = `rgb(${Math.round(toneVal[tone] * 255)},${Math.round(rng.next() * 76)},0)`;
      g.beginPath();
      g.moveTo(ox + x - 7, oy + 512);
      g.quadraticCurveTo(ox + x + lean * 0.3, oy + 512 - h * 0.6, ox + x + lean, oy + 512 - h);
      g.quadraticCurveTo(ox + x + lean * 0.3 + 4, oy + 512 - h * 0.55, ox + x + 7, oy + 512);
      g.fill();
    }
  }
  // 3: hanging vines / ivy curtain
  {
    const [ox, oy] = cellOrigin(3);
    for (let s = 0; s < 26; s++) {
      const x0 = rng.range(30, 482), len = rng.range(180, 500);
      let x = x0;
      for (let y = 70; y < len; y += 6) {
        x += rng.range(-1.5, 1.5);
        const k = rng.next();
        const tone = k < 0.3 ? 0 : k < 0.65 ? 1 : k < 0.9 ? 2 : 3;
        dab(ox + x + rng.range(-9, 9), oy + y, tone, rng.next() * 0.3, rng.range(5, 10) * (1 - y / len * 0.5), rng.range(-1, 1));
      }
    }
    clump(ox, oy, [{ x: 256, y: 30, r: 120 }, { x: 120, y: 20, r: 90 }, { x: 400, y: 25, r: 95 }]);
  }
  // 4: moss pad — wide flat clump
  {
    const [ox, oy] = cellOrigin(4);
    const blobs = [];
    for (let i = 0; i < 14; i++) blobs.push({ x: 256 + rng.range(-200, 200), y: 430 + rng.range(-40, 40), r: rng.range(35, 65) });
    clump(ox, oy, blobs, { leafMin: 3, leafMax: 7, density: 0.2 });
  }
  // 5: flowering bush (white & yellow wildflowers)
  {
    const [ox, oy] = cellOrigin(5);
    const blobs = [];
    for (let i = 0; i < 9; i++) blobs.push({ x: 256 + rng.range(-150, 150), y: 360 + rng.range(-90, 70), r: rng.range(55, 90) });
    clump(ox, oy, blobs, { bloom: 0.06 });
  }
  // 6: sapling — thin trunk, airy crown
  {
    const [ox, oy] = cellOrigin(6);
    g.strokeStyle = 'rgb(20,40,0)'; g.lineCap = 'round';
    g.lineWidth = 9; g.beginPath(); g.moveTo(ox + 256, oy + 512); g.bezierCurveTo(ox + 270, oy + 420, ox + 236, oy + 330, ox + 252, oy + 220); g.stroke();
    g.lineWidth = 5; g.beginPath(); g.moveTo(ox + 254, oy + 330); g.lineTo(ox + 330, oy + 250); g.moveTo(ox + 250, oy + 300); g.lineTo(ox + 180, oy + 240); g.stroke();
    const blobs = [{ x: 250, y: 170, r: 85 }, { x: 330, y: 230, r: 60 }, { x: 175, y: 225, r: 58 }, { x: 260, y: 100, r: 60 }];
    clump(ox, oy, blobs, { leafMin: 6, leafMax: 14 });
  }
  // 7: bird nest — woven twigs (brown palette material)
  {
    const [ox, oy] = cellOrigin(7);
    for (let i = 0; i < 900; i++) {
      const a = rng.range(Math.PI * 0.05, Math.PI * 0.95);
      const r = rng.range(0.55, 1.0);
      const x = 256 + Math.cos(a) * 200 * r * rng.sign();
      const y = 330 + Math.sin(a) * 110 * r - 30;
      const sy = (y - 300) / 110;
      const s = -sy * 0.6 + rng.range(-0.4, 0.4) - (x - 256) / 400;
      const tone = s < -0.35 ? 0 : s < 0.05 ? 1 : s < 0.4 ? 2 : 3;
      g.strokeStyle = `rgb(${Math.round(toneVal[tone] * 255)},${Math.round(rng.next() * 76)},0)`;
      g.lineWidth = rng.range(2.5, 5);
      const ang = rng.range(-0.5, 0.5), len = rng.range(30, 80);
      g.beginPath(); g.moveTo(ox + x - Math.cos(ang) * len / 2, oy + y - Math.sin(ang) * len / 2);
      g.quadraticCurveTo(ox + x, oy + y + rng.range(-8, 8), ox + x + Math.cos(ang) * len / 2, oy + y + Math.sin(ang) * len / 2);
      g.stroke();
    }
    // dark hollow
    g.fillStyle = `rgb(${Math.round(toneVal[0] * 255)},20,0)`;
    g.beginPath(); g.ellipse(ox + 256, oy + 262, 150, 34, 0, 0, Math.PI * 2); g.fill();
  }
  // 8: zelkova — vase of upward branches, fan of small clumps
  {
    const [ox, oy] = cellOrigin(8);
    const tips = [];
    limb(ox, oy, [[256, 512], [252, 460], [258, 400]], 20, 15);
    for (let i = 0; i < 5; i++) branchy(ox, oy, 256, 400, -Math.PI / 2 + (i - 2) * 0.32 + rng.range(-0.1, 0.1), rng.range(80, 110), 10, 2, 0.32, tips);
    const blobs = tips.map(([x, y]) => ({ x: x + rng.range(-12, 12), y: y + rng.range(-8, 14), r: rng.range(34, 58), hue: rng.range(0, 0.12) }));
    blobs.push({ x: 256, y: 150, r: 95 }, { x: 180, y: 190, r: 70 }, { x: 330, y: 185, r: 72 });
    clump(ox, oy, blobs, { leafMin: 4, leafMax: 10, density: 0.13 });
  }
  // 9: pine — crooked trunk, layered horizontal cloud pads
  {
    const [ox, oy] = cellOrigin(9);
    const trunk = [[250, 512], [262, 450], [240, 390], [266, 320], [244, 250], [258, 170]];
    limb(ox, oy, trunk, 18, 7);
    const pads = [[160, 330, 95], [350, 290, 100], [190, 220, 80], [320, 175, 75], [250, 110, 70], [120, 260, 55]];
    for (const [x, y] of pads) limb(ox, oy, [[256, y + 30], [(x + 256) / 2, y + 8], [x, y]], 6, 3);
    const blobs = [];
    for (const [x, y, w] of pads) for (let k = 0; k < 4; k++) blobs.push({ x: x + rng.range(-w * 0.5, w * 0.5), y: y + rng.range(-8, 6), r: rng.range(w * 0.35, w * 0.55), sq: 0.45, lift: 0.08 });
    clump(ox, oy, blobs, { leafMin: 3, leafMax: 8, density: 0.3, stretch: 0.3, leafAng: 0 });
  }
  // 10: willow — arching limbs, hanging fronds
  {
    const [ox, oy] = cellOrigin(10);
    limb(ox, oy, [[256, 512], [250, 430], [262, 340], [255, 280]], 22, 12);
    const anchors = [];
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.42;
      const x1 = 256 + Math.cos(a) * 150, y1 = 280 + Math.sin(a) * 140;
      limb(ox, oy, [[256, 300], [(256 + x1) / 2, Math.min(300, y1) - 30], [x1, y1]], 8, 3);
      anchors.push([x1, y1]);
    }
    clump(ox, oy, [{ x: 256, y: 150, r: 120, sq: 0.6 }, { x: 160, y: 185, r: 80, sq: 0.6 }, { x: 352, y: 185, r: 80, sq: 0.6 }], { leafMin: 4, leafMax: 9, density: 0.12 });
    for (let s = 0; s < 60; s++) {
      const [ax, ay] = anchors[s % anchors.length];
      let x = ax + rng.range(-70, 70);
      const y0 = ay + rng.range(-20, 40), len = rng.range(150, 330);
      for (let y = y0; y < Math.min(505, y0 + len); y += 5) {
        x += rng.range(-1, 1) + 0.15;
        const k = rng.next();
        const tone = k < 0.25 ? 0 : k < 0.6 ? 1 : k < 0.88 ? 2 : 3;
        dab(ox + x, oy + y, tone, 0.1 + rng.next() * 0.25, rng.range(3, 6), Math.PI / 2 + rng.range(-0.3, 0.3), 0, 0.35);
      }
    }
  }
  // 11: twin young trees
  {
    const [ox, oy] = cellOrigin(11);
    limb(ox, oy, [[220, 512], [214, 420], [196, 300], [190, 220]], 11, 5);
    limb(ox, oy, [[290, 512], [300, 430], [326, 330], [338, 250]], 10, 5);
    const blobs = [{ x: 180, y: 200, r: 75 }, { x: 150, y: 270, r: 55 }, { x: 225, y: 150, r: 60 },
      { x: 345, y: 230, r: 70 }, { x: 380, y: 290, r: 50 }, { x: 320, y: 170, r: 55 }, { x: 262, y: 230, r: 45 }];
    clump(ox, oy, blobs, { leafMin: 5, leafMax: 12, density: 0.12 });
  }
  // 12: reeds — thin blades with seed heads
  {
    const [ox, oy] = cellOrigin(12);
    const blades = [];
    for (let i = 0; i < 120; i++) blades.push([256 + rng.gauss() * 110, rng.range(200, 480), rng.range(-50, 50), rng.next()]);
    blades.sort((a, b) => a[3] - b[3]);
    for (const [x, h, lean, k] of blades) {
      const tone = k < 0.3 ? 0 : k < 0.6 ? 1 : k < 0.88 ? 2 : 3;
      g.fillStyle = `rgb(${Math.round(toneVal[tone] * 255)},${Math.round(60 + rng.next() * 76)},0)`;
      g.beginPath();
      g.moveTo(ox + x - 3.5, oy + 512);
      g.quadraticCurveTo(ox + x + lean * 0.4, oy + 512 - h * 0.6, ox + x + lean, oy + 512 - h);
      g.quadraticCurveTo(ox + x + lean * 0.4 + 2, oy + 512 - h * 0.55, ox + x + 3.5, oy + 512);
      g.fill();
      if (k > 0.75) dab(ox + x + lean, oy + 512 - h + 10, 2, 0.5, 6, Math.PI / 2 + lean * 0.004, 0, 0.35);
    }
  }
  // 13: ivy drape — dense crown, ragged strands
  {
    const [ox, oy] = cellOrigin(13);
    for (let s = 0; s < 40; s++) {
      let x = rng.range(20, 492);
      const len = rng.range(120, 470) * (0.6 + 0.4 * Math.sin(x / 70) ** 2);
      for (let y = 78; y < len; y += 5) {
        x += rng.range(-1.2, 1.2);
        const k = rng.next();
        const tone = k < 0.3 ? 0 : k < 0.62 ? 1 : k < 0.9 ? 2 : 3;
        dab(ox + x + rng.range(-10, 10), oy + y, tone, rng.next() * 0.35, rng.range(5, 11) * (1 - y / len * 0.4), rng.range(-1, 1));
      }
    }
    clump(ox, oy, [{ x: 256, y: 40, r: 110, sq: 0.5 }, { x: 110, y: 35, r: 95, sq: 0.5 }, { x: 400, y: 38, r: 100, sq: 0.5 }], { leafMin: 5, leafMax: 11 });
  }
  // 14: bamboo clump
  {
    const [ox, oy] = cellOrigin(14);
    const culms = [];
    for (let i = 0; i < 16; i++) culms.push([256 + rng.gauss() * 60, rng.range(-0.12, 0.12) + (rng.next() - 0.5) * 0.25, rng.range(330, 500)]);
    for (const [x, lean, h] of culms) {
      g.strokeStyle = `rgb(${rng.next() < 0.5 ? 95 : 160},${Math.round(80 + rng.next() * 60)},0)`;
      g.lineWidth = rng.range(4, 7); g.lineCap = 'butt';
      g.beginPath(); g.moveTo(ox + x, oy + 512); g.quadraticCurveTo(ox + x + lean * h * 0.3, oy + 512 - h * 0.6, ox + x + lean * h, oy + 512 - h); g.stroke();
    }
    const blobs = culms.map(([x, lean, h]) => ({ x: x + lean * h, y: 512 - h + 50, r: rng.range(40, 60), sq: 1.3, hue: 0.15 }));
    clump(ox, oy, blobs, { leafMin: 6, leafMax: 12, density: 0.1, stretch: 0.25, leafAng: 0.6 });
  }
  // 15: spreading shrub — low, wide, ragged
  {
    const [ox, oy] = cellOrigin(15);
    const blobs = [];
    for (let i = 0; i < 12; i++) blobs.push({ x: 256 + rng.range(-200, 200), y: 420 + rng.range(-60, 40), r: rng.range(45, 80), sq: 0.7, hue: rng.range(0, 0.2) });
    clump(ox, oy, blobs, { leafMin: 4, leafMax: 10, density: 0.14, bloom: 0.015 });
  }

  // flower heads: dense round clusters of small florets, shaded like the clumps
  const flowerHead = (ox, oy, x, y, r, which, n = 60) => {
    const ds = [];
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * r;
      const fx = x + Math.cos(a) * rr, fy = y + Math.sin(a) * rr * 0.85;
      const nx = (fx - x) / r, ny = (fy - y) / r;
      const s = nx * L[0] + ny * L[1] + Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * L[2] + rng.range(-0.15, 0.15);
      const tone = s < 0.0 ? 1 : s < 0.45 ? 2 : 3;
      ds.push([fx, fy, tone, rng.range(r * 0.16, r * 0.3)]);
    }
    ds.sort((p, q) => p[2] - q[2]);
    for (const [fx, fy, tone, sz] of ds) dab(ox + fx, oy + fy, tone, rng.next() * 0.2, sz, rng.range(0, 3), which, 0.8);
  };
  // 16: hydrangea bush — dark glossy leaves, big blue/violet flower heads
  {
    const [ox, oy] = cellOrigin(16);
    const blobs = [];
    for (let i = 0; i < 9; i++) blobs.push({ x: 256 + rng.range(-170, 170), y: 360 + rng.range(-80, 70), r: rng.range(60, 95) });
    clump(ox, oy, blobs, { leafMin: 9, leafMax: 18, stretch: 0.6 });
    for (let i = 0; i < 11; i++) {
      const x = 256 + rng.range(-185, 185), y = 330 + rng.range(-110, 80);
      flowerHead(ox, oy, x, y, rng.range(30, 46), rng.next() < 0.7 ? 1 : 2);
    }
  }
  // 17: flowering vine curtain — morning glories hanging from a parapet
  {
    const [ox, oy] = cellOrigin(17);
    for (let s = 0; s < 34; s++) {
      let x = rng.range(20, 492);
      const len = rng.range(140, 480) * (0.55 + 0.45 * Math.sin(x / 60 + 1) ** 2);
      for (let y = 78; y < len; y += 5) {
        x += rng.range(-1.4, 1.4);
        const k = rng.next();
        const tone = k < 0.28 ? 0 : k < 0.6 ? 1 : k < 0.88 ? 2 : 3;
        dab(ox + x + rng.range(-10, 10), oy + y, tone, rng.next() * 0.35, rng.range(6, 12) * (1 - y / len * 0.4), rng.range(-1, 1), 0, 0.55);
        if (rng.next() < 0.03) {
          const fx = ox + x + rng.range(-12, 12), fy = oy + y, fr = rng.range(6, 10), which = rng.next() < 0.7 ? 1 : 2;
          dab(fx, fy, 2, 0.1, fr, 0, which, 1.0);
          dab(fx - fr * 0.2, fy - fr * 0.2, 3, 0.1, fr * 0.55, 0, which, 1.0);
          if (which === 1) dab(fx, fy, 3, 0.1, fr * 0.22, 0, 2, 1.0);
        }
      }
    }
    clump(ox, oy, [{ x: 256, y: 40, r: 115, sq: 0.5 }, { x: 110, y: 35, r: 95, sq: 0.5 }, { x: 400, y: 38, r: 100, sq: 0.5 }], { leafMin: 6, leafMax: 12 });
  }
  // 18: camphor giant — huge billowing crown (the Ghibli tree), short thick trunk
  {
    const [ox, oy] = cellOrigin(18);
    limb(ox, oy, [[250, 512], [244, 450], [256, 390]], 34, 22);
    const tips = [];
    for (let i = 0; i < 6; i++) branchy(ox, oy, 252, 395, -Math.PI / 2 + (i - 2.5) * 0.42 + rng.range(-0.1, 0.1), rng.range(70, 100), 14, 1, 0.4, tips);
    const blobs = tips.map(([x, y]) => ({ x: x + rng.range(-15, 15), y: y + rng.range(-10, 10), r: rng.range(55, 80) }));
    for (let i = 0; i < 14; i++) {
      const a = rng.range(Math.PI * 1.05, Math.PI * 1.95), rr = rng.range(0.45, 1.0);
      blobs.push({ x: 256 + Math.cos(a) * 190 * rr, y: 260 + Math.sin(a) * 200 * rr, r: rng.range(55, 88) });
    }
    blobs.push({ x: 256, y: 200, r: 120 }, { x: 160, y: 270, r: 95 }, { x: 352, y: 268, r: 95 });
    clump(ox, oy, blobs, { leafMin: 5, leafMax: 11, density: 0.11, vgrad: 0.5 });
  }
  // 19: blossom tree — crape myrtle crown dusted with pink flower sprays
  {
    const [ox, oy] = cellOrigin(19);
    const tips = [];
    limb(ox, oy, [[256, 512], [262, 450], [250, 380]], 16, 11);
    for (let i = 0; i < 4; i++) branchy(ox, oy, 252, 385, -Math.PI / 2 + (i - 1.5) * 0.5 + rng.range(-0.1, 0.1), rng.range(80, 105), 8, 2, 0.35, tips);
    const blobs = tips.map(([x, y]) => ({ x: x + rng.range(-12, 12), y: y + rng.range(-8, 12), r: rng.range(38, 60) }));
    blobs.push({ x: 256, y: 170, r: 100 }, { x: 175, y: 215, r: 72 }, { x: 337, y: 210, r: 74 });
    clump(ox, oy, blobs, { leafMin: 4, leafMax: 10, density: 0.12 });
    for (let i = 0; i < 16; i++) {
      const b = blobs[Math.floor(rng.next() * blobs.length)];
      flowerHead(ox, oy, b.x + rng.range(-b.r * 0.6, b.r * 0.6), b.y - b.r * rng.range(0.1, 0.7), rng.range(22, 36), rng.next() < 0.8 ? 1 : 2, 45);
    }
  }
  // 20: grass bank with wildflowers — wide low tuft
  {
    const [ox, oy] = cellOrigin(20);
    const blades = [];
    for (let i = 0; i < 260; i++) blades.push([256 + rng.range(-240, 240), rng.range(60, 230), rng.range(-40, 40), rng.next()]);
    blades.sort((a, b) => a[3] - b[3]);
    for (const [x, h, lean, k] of blades) {
      const tone = k < 0.25 ? 0 : k < 0.55 ? 1 : k < 0.85 ? 2 : 3;
      g.fillStyle = `rgb(${Math.round(toneVal[tone] * 255)},${Math.round(rng.next() * 76)},0)`;
      g.beginPath();
      g.moveTo(ox + x - 6, oy + 512);
      g.quadraticCurveTo(ox + x + lean * 0.3, oy + 512 - h * 0.6, ox + x + lean, oy + 512 - h);
      g.quadraticCurveTo(ox + x + lean * 0.3 + 4, oy + 512 - h * 0.55, ox + x + 6, oy + 512);
      g.fill();
      if (k > 0.8 && rng.next() < 0.4) dab(ox + x + lean, oy + 512 - h, 3, 0.1, rng.range(6, 10), 0, rng.next() < 0.5 ? 1 : 2, 1.0);
    }
  }
  // 21: morning-glory trellis — a leafy screen with many blue trumpets
  {
    const [ox, oy] = cellOrigin(21);
    const blobs = [];
    for (let i = 0; i < 12; i++) blobs.push({ x: 256 + rng.range(-190, 190), y: 300 + rng.range(-170, 170), r: rng.range(50, 80) });
    clump(ox, oy, blobs, { leafMin: 8, leafMax: 15, stretch: 0.7, density: 0.1 });
    for (let i = 0; i < 46; i++) {
      const b = blobs[Math.floor(rng.next() * blobs.length)];
      const fx = ox + b.x + rng.range(-b.r, b.r), fy = oy + b.y + rng.range(-b.r, b.r), fr = rng.range(6, 9.5);
      if (rng.next() < 0.8) {
        // morning glory: a blue trumpet face with a pale throat
        dab(fx, fy, 2, 0.1, fr, 0, 1, 1.0);
        dab(fx - fr * 0.2, fy - fr * 0.2, 3, 0.1, fr * 0.6, 0, 1, 1.0);
        dab(fx, fy, 3, 0.1, fr * 0.22, 0, 2, 1.0);
      } else dab(fx, fy, 3, 0.1, fr * 0.8, 0, 2, 1.0);
    }
  }
  const t = tex(c);
  return { texture: t, cols, rows };
}

let _atlas = null;
// 图集画一次（~0.5 s）就缓存；所有植被材质共享同一张纹理
export function foliageAtlas() { return _atlas ??= makeFoliageAtlas(); }

// 常用调色板（四个色阶从暗到亮 + 两种花色）。可以直接传 hex，也可以先过 color.js 的 screen()。
export const FOLIAGE_PALETTES = {
  summer:  { deep: '#25423f', shade: '#3e6a52', mid: '#6f9a57', light: '#b8c873', blossom: '#f4efe0' },
  meadow:  { deep: '#2c4a3a', shade: '#4a7a4a', mid: '#7cb056', light: '#b4d276', blossom: '#fff6e8', blossom2: '#f7b8c8' },
  sakura:  { deep: '#5a3a4e', shade: '#a2687e', mid: '#e8a6b8', light: '#fbe0e6', blossom: '#ffffff', blossom2: '#f7c4d2' },
  autumn:  { deep: '#4a2a26', shade: '#8a3e2a', mid: '#d0743a', light: '#f2c063', blossom: '#f8e4b0' },
  dusk:    { deep: '#1f2440', shade: '#33405e', mid: '#4f6a6a', light: '#a0a070', blossom: '#f0d8c0' },
  hydrangea: { deep: '#2a3a4a', shade: '#3e6a58', mid: '#6f9a6a', light: '#b8c890', blossom: '#8aa0f0', blossom2: '#c8a0e8' },
};

// ------------------------------------------------------------- 植被材质
// 朝向镜头的绘画团块。图集纹素：r = 色阶，g = 色相偏移，b = 花，a = 覆盖。
//   o: { deep, shade, mid, light, blossom, blossom2, id = 0, sway = 1, glow = 1 }
// 逆光时叶片透光发黄绿（原作的“夏日逆光树”）；摇曳用 uDrawTime（一拍二），不会抖成实拍。
export function foliageMaterial(o = {}) {
  const atlas = foliageAtlas();
  const C = (h) => new THREE.Color(h);
  const u = base({
    uAtlas: { value: atlas.texture },
    uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
    uPal0: { value: C(o.deep ?? '#25423f') },
    uPal1: { value: C(o.shade ?? '#3e6a52') },
    uPal2: { value: C(o.mid ?? '#6f9a57') },
    uPal3: { value: C(o.light ?? '#b8c873') },
    uBloom: { value: C(o.blossom ?? '#f4efe0') },
    uBloom2: { value: C(o.blossom2 ?? o.blossom ?? '#f4efe0') },
    uId: { value: o.id ?? 0 },
    uSway: { value: o.sway ?? 1 },
    uGlow: { value: o.glow ?? 1 },
  });
  const vs = /* glsl */ `
    attribute vec4 aVar;   // 图集格子, 色相偏移, 摇曳相位, 镜像
    varying vec2 vUv;
    varying float vDepth;
    varying vec4 vVar;
    varying vec3 vWorld;
    varying vec2 vLocal;
    uniform float uSway, uDrawTime, uPass;
    uniform vec3 uSunDir;
    varying float vWave;
    ${WIND_VS}
    void main(){
      mat4 im = instanceMatrix;
      vec3 center = (modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float sc = length((modelMatrix * im * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      float scy = length((modelMatrix * im * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      vec4 mv = viewMatrix * vec4(center, 1.0);
      vec2 off = vec2(position.x * sc, (position.y + 0.5) * scy);
      float hgt = position.y + 0.5;
      off.x += sin(uDrawTime * 1.1 + aVar.z * 6.283) * 0.025 * sc * hgt * uSway;
      // 风（W1）：卡片顶部朝下风方向倒（按风向在屏幕上的投影），波峰处倒得更多、更扁；强度 0 时完全不走这里
      vWave = 0.0;
      if(uWind.z > 0.0){
        float wv = windWave(center.xz);
        vWave = wv;
        vec3 wd = mat3(viewMatrix) * vec3(uWind.x, 0.0, uWind.y);
        float bendK = uWind.z * (0.25 + 0.45 * wv) * uSway;
        float flick = sin(uDrawTime * 7.0 + aVar.z * 6.283 + center.x * 0.3) * 0.07 * uWind.z * uSway;
        float hp = pow(hgt, 1.6);
        off.x += (wd.x * bendK + flick) * sc * hp;
        off.y -= hgt * scy * uWind.z * (0.12 + 0.3 * wv) * uSway;
      }
      // 画好的受光面跟着太阳在屏幕上的左右镜像
      vec3 sunV = mat3(viewMatrix) * uSunDir;
      float flip = (sunV.x < 0.0) ? 1.0 : -1.0;
      if(aVar.w > 0.5) flip *= -1.0;
      if(uPass > 1.5) off = -off;
      mv.xy += off;
      vWorld = center + vec3(0.0, hgt * scy, 0.0);
      vLocal = vec2(position.x, hgt);
      float idx = aVar.x;
      vec2 cell = vec2(mod(idx, ${atlas.cols}.0), floor(idx / ${atlas.cols}.0));
      vec2 luv = vec2(flip > 0.0 ? uv.x : 1.0 - uv.x, uv.y);
      luv = mix(vec2(0.004), vec2(0.996), luv);
      vUv = (cell + luv) / vec2(${atlas.cols}.0, ${atlas.rows}.0);
      vVar = aVar;
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const fs = /* glsl */ `
    ${COMMON}
    ${MRT_OUT}
    uniform sampler2D uAtlas;
    uniform vec3 uPal0, uPal1, uPal2, uPal3, uBloom, uBloom2;
    uniform vec2 uGrid;
    uniform float uId, uGlow;
    varying vec2 vUv;
    varying float vDepth;
    varying vec4 vVar;
    varying vec3 vWorld;
    varying vec2 vLocal;
    varying float vWave;
    void main(){
      vec4 t = texture(uAtlas, vUv);
      if(t.a < 0.5) discard;
      if(uPass > 1.5 && vWorld.y < uWaterLevel - 0.03) discard;
      if(uPass > 0.5 && uPass < 1.5){ oColor = vec4(1); oData = vec4(0); return; }
      float tone = t.r;
      vec3 Vv = normalize(vWorld - cameraPosition);
      float backK = smoothstep(0.35, 0.85, dot(Vv, uSunDir)) * uSunStrength;
      vec3 c = tone < 0.25 ? uPal0 : tone < 0.5 ? uPal1 : tone < 0.75 ? uPal2 : uPal3;
      // 大块平色里再撒一层“叶形”，比所在色阶高一阶或低一阶 —— 近景读成一层层叶子而不是平板
      {
        vec2 lp = vUv * uGrid * 512.0 / 9.0;
        float lfw = length(fwidth(lp));
        vec2 lc = floor(lp);
        vec2 h2 = hash22(lc + vVar.x * 7.0);
        vec2 lf = fract(lp) - 0.5 - (h2 - 0.5) * 0.35;
        float la = h2.x * 6.2831;
        lf = mat2(cos(la), sin(la), -sin(la), cos(la)) * lf;
        float leaf = 1.0 - smoothstep(0.3, 0.3 + lfw, length(vec2(lf.x, lf.y * 2.3)));
        float lk = leaf * (1.0 - smoothstep(0.35, 0.8, lfw));
        float hi = step(0.62, h2.y), lo = step(h2.y, 0.22);
        vec3 up = tone < 0.25 ? uPal1 : tone < 0.5 ? uPal2 : uPal3;
        vec3 dn = tone < 0.5 ? uPal0 : tone < 0.75 ? uPal1 : uPal2;
        c = mix(c, mix(c, up, 0.55), lk * hi * step(tone, 0.85));
        c = mix(c, mix(c, dn, 0.45), lk * lo * step(0.3, tone));
      }
      c *= mix(vec3(1.0), vec3(0.8, 0.86, 0.94), backK * (1.0 - smoothstep(0.7, 0.8, tone)));
      float hv = t.g + vVar.y;
      c *= mix(vec3(0.92, 1.02, 0.96), vec3(1.07, 1.0, 0.86), fract(hv));
      float isBloom = step(0.3, t.b);
      vec3 bl = mix(uBloom, uBloom2, step(0.75, t.b));
      bl *= mix(0.78, 1.04, smoothstep(0.2, 0.8, tone));
      c = mix(c, bl, isBloom);
      // 草浪波峰：叶子翻过来露出浅色的背面（亮一档、偏黄绿）
      if(uWind.z > 0.0) c = mix(c, c * vec3(1.16, 1.2, 1.0) + vec3(0.045, 0.055, 0.0), (step(0.32, vWave) * 0.6 + step(0.62, vWave) * 0.4) * clamp(uWind.z * 1.6, 0.0, 1.0) * (1.0 - isBloom));
      float cloudK = cloudShade(vWorld);                                   // W5 云影（关闭时 = 1.0）
      vec3 tint = mix(uSkyTint, uSunColor * 1.06, uSunStrength * smoothstep(0.5, 0.8, tone) * cloudK);
      c *= mix(uShadeTint * 1.12, tint, smoothstep(0.2, 0.6, tone));
      // 逆光：亮部叶片透光发黄绿
      float back = pow(max(dot(Vv, uSunDir), 0.0), 2.0) * uSunStrength * uGlow * cloudK;
      float thin = smoothstep(0.25, 0.9, tone) * (0.55 + 0.45 * smoothstep(0.4, 1.0, vLocal.y));
      c = mix(c, c * vec3(1.08, 1.12, 0.9) + vec3(0.05, 0.07, 0.0), back * thin * 0.5 * (1.0 - isBloom));
      // 局部暖光：卡片没有真实法线，用“不看法线”的照法，亮部多吃一点（叶片朝外的一面）
      vec3 lampL = lampLight(vWorld, vec3(0.0, 1.0, 0.0), 1.0, 0.0) * mix(0.6, 1.0, smoothstep(0.3, 0.8, tone));
      c = max(c, (tone < 0.25 ? uPal0 : tone < 0.5 ? uPal1 : tone < 0.75 ? uPal2 : uPal3) * lampL);
      writeOut(c, 1.0, vec3(0.0, 0.0, 1.0), vDepth, uId);
    }
  `;
  return mat(u, vs, fs);
}

// ------------------------------------------------------------- 摆放
// items: [{ p:[x,y,z] (卡片底边中心), s: 宽(米), sy: 高宽比 = 1, k: 图集格子(数字或 FOLIAGE 名), h: 色相偏移, f: 镜像 0/1 }]
// o: 调色板（见 FOLIAGE_PALETTES）+ { id, sway, glow, noShadow }
// 返回一个 InstancedMesh（一次绘制）。同一调色板的植物放在同一组里。
export function foliage(items, o = {}) {
  const fm = foliageMaterial(o);
  const geo = new THREE.PlaneGeometry(1, 1);
  const im = new THREE.InstancedMesh(geo, fm, Math.max(1, items.length));
  const aVar = new Float32Array(Math.max(1, items.length) * 4);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  items.forEach((it, i) => {
    const sc = it.s ?? 1;
    im.setMatrixAt(i, m4.compose(v.set(...it.p), q, s.set(sc, sc * (it.sy ?? 1), sc)));
    const k = typeof it.k === 'string' ? FOLIAGE[it.k] : (it.k ?? 0);
    aVar.set([k, it.h ?? 0, it.phase ?? i * 0.37, it.f ?? 0], i * 4);
  });
  im.count = items.length;
  geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 4));
  im.frustumCulled = false;
  // 挂在角色身上的植物（K4，Sunshower robot.js 的 overgrowth）：把返回的网格 add 到关节下面就会跟着走
  // （卡片中心取 modelMatrix，朝镜头、受光面镜像都照常）。noShadow: true → 不往角色身上投斑驳的卡片影子。
  if (o.noShadow) im.userData.noShadow = true;
  return im;
}

// 撒点：在地形上按规则随机摆一片（确定性：同一个 seed 永远同一片林子）
//   scatter({ seed, n, area:[x0,z0,x1,z1], height:(x,z)=>y, kinds:['bush','grass',...], size:[a,b], sy, avoid:(x,z)=>bool, sink })
export function scatter(o) {
  const rng = new Rng(o.seed ?? 1);
  const [x0, z0, x1, z1] = o.area;
  const out = [];
  for (let i = 0; i < (o.n ?? 50); i++) {
    const x = rng.range(x0, x1), z = rng.range(z0, z1);
    const k = rng.pick(o.kinds ?? ['bush']);
    const s = rng.range(...(o.size ?? [1, 2]));
    if (o.avoid?.(x, z)) continue;
    out.push({ p: [x, (o.height?.(x, z) ?? 0) - (o.sink ?? 0.08) * s, z], s, sy: o.sy ?? 1, k, h: rng.range(0, 0.3), f: rng.int(0, 1) });
  }
  return out;
}
