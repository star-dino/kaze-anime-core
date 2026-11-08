import * as THREE from 'three';
import { paintMaterial, skyMaterial } from '../core/materials.js';
import { blob } from '../core/kit.js';
import { Rng, smooth, onThrees } from '../core/util.js';
import { DINO } from './story.js';
import { foliage, scatter, FOLIAGE_PALETTES } from '../core/foliage.js';

// 环境部门：天空、岬角地形、海中岩石、灌木。水面本身由引擎的屏幕空间 pass 画，这里只驱动它的时间。

// 地形高度（纯函数：其他部门也可以 import 它做落脚点/接触）
export function terrain(x, z) {
  // 悬崖边线：抛物线 → 一条伸进海里的窄岬角，两侧都是海
  const edge = -9 + 0.018 * x * x + 1.5 * Math.sin(x * 0.21 + 1);
  const cliff = smooth((z - (edge - 6)) / 7);                                          // 0 海底 → 1 台地
  const plateau = 6 + 0.35 * Math.sin(x * 0.3) * Math.sin(z * 0.25) + Math.max(0, z - 14) * 0.18 * smooth((z - 14) / 30);
  const hills = 5 * smooth((z - 30) / 40) * (0.6 + 0.4 * Math.sin(x * 0.045 + 0.7));
  return -5 + (plateau + hills + 5) * cliff + 0.25 * Math.sin(x * 1.3 + z * 0.7) * cliff;
}

// 积云：每座“塔”是一串团块 [方位角, 仰角, 半径, 云底仰角]
function cumulus() {
  const rng = new Rng(7);
  const puffs = [];
  const tower = (az, el0, w, h, n) => {
    const cut = el0 + 0.6;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const y = el0 + u * h;
      const r = w * (1 - 0.55 * u) * rng.range(0.55, 0.9);
      puffs.push([az + rng.range(-w, w) * (1 - 0.6 * u), y + rng.range(0, 1.5), r, cut]);
    }
  };
  tower(-32, 1.5, 9, 16, 12);
  tower(30, 1.0, 11, 20, 14);           // 给流星的轨迹让出一块蓝天
  tower(46, 2.0, 7, 10, 8);
  tower(150, 1.0, 12, 18, 12);
  tower(196, 1.5, 9, 14, 10);
  return puffs.slice(0, 64);
}

export function createWorld(ctx) {
  const { scene, engine, camera } = ctx;

  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMaterial(cumulus()));
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  ctx.sky = sky;                       // look.js 会驱动它的颜色

  // 岬角地形：一块位移平面，绘画材质（id 0 → 吃 Kuwahara 笔触、不描线）
  const g = new THREE.PlaneGeometry(320, 320, 220, 220);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, 60);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrain(pos.getX(i), pos.getZ(i)));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, paintMaterial({ color: '#9ccc6a', color2: '#5b9a52', rock: '#c2ae94', sand: '#eadfb8', scale: 0.05, steps: 3 }));
  scene.add(ground);

  // 海里的岩石：会出现在水面倒影里，并自动拿到引擎的“接触泡沫”
  const rng = new Rng(11);
  const rockMat = paintMaterial({ color: '#a99a8c', color2: '#8a7f86', scale: 0.4, steps: 2 });
  for (const [x, z, r] of [[-7, -17, 2.4], [5, -19.5, 1.6], [-18, -9, 3.0], [16, -8, 2.0], [-28, -22, 2.2], [30, -2, 2.6]]) {
    const m = new THREE.Mesh(blob(r, r * 0.8, r * 0.9, 2.6, 10, (q) => q.multiplyScalar(rng.range(0.85, 1.1))), rockMat);
    m.position.set(x, -r * 0.35, z);
    m.rotation.y = rng.range(0, 6.28);
    scene.add(m);
  }
  // 台地上的植被：core/foliage.js 的绘画团块卡片（原作 Sunshower 的做法），一组一次绘制
  const nearDino = (x, z, r) => Math.hypot(x - DINO[0], z - DINO[1]) < r;
  const onLand = (x, z) => terrain(x, z) > 4.5;
  const bushes = scatter({ seed: 11, n: 70, area: [-45, -4, 45, 45], height: terrain, kinds: ['bush', 'shrub', 'bush', 'flowers'], size: [1.6, 3.4], sy: 0.8,
    avoid: (x, z) => nearDino(x, z, 6) || !onLand(x, z) });
  const grass = scatter({ seed: 12, n: 520, area: [-30, -6, 30, 30], height: terrain, kinds: ['grass', 'grassBank', 'moss', 'grass'], size: [1.0, 2.2], sy: 0.6,
    avoid: (x, z) => nearDino(x, z, 2.2) || !onLand(x, z) });
  const trees = scatter({ seed: 13, n: 40, area: [-70, 18, 70, 70], height: terrain, kinds: ['roundTree', 'zelkova', 'camphor', 'blossomTree'], size: [6, 12],
    avoid: (x, z) => nearDino(x, z, 14) || !onLand(x, z) });
  scene.add(foliage([...bushes, ...grass], { ...FOLIAGE_PALETTES.meadow, sway: 0.8 }));
  scene.add(foliage(trees, { ...FOLIAGE_PALETTES.summer, sway: 0.4 }));

  const wu = engine.mWater.uniforms;
  return {
    sky, terrain,
    update(st) {
      sky.position.copy(camera.position);
      wu.uFxTime.value = onThrees(st.t);       // 水面动画一拍三（特效的节奏）
      wu.uWaveAmp.value = 0.35;
    },
  };
}
