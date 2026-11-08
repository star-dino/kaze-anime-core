import * as THREE from 'three';
import { cloudTower, skyDome as coreSkyDome } from '../../core/clouds.js';
import { screen } from '../../core/color.js';
import { Rng } from '../../core/util.js';

// 天空部门（atmo）多层绘画天穹（基于 core/clouds.js 的 skyDome，这里定义本片的云塔布局与共享 uniform）：
//   统一在 360° 天穹上绘制：
//   1. 高空细卷云丝（cirrus wisps）
//   2. 多塔团块并集积云（billow-union cumulus towers：fwidth 抗锯齿边缘、三阶赛璐璐明暗、团块交叠折痕、逆光银边与地平线雾化）
//   3. 起风至暴雨期的自然水粉阴云层（uOvercast 0→1：沿风向舒展铺开的石板蓝/灰紫云腹）
//   4. 雨后黑场亮回后的“单侧云开斜阳”（uAfterRain + uSideRays：左侧海天云层裂开透出柔和暖金斜射光幕，右侧残留远去的薰衣草灰雨云）

export const STORM = {
  uOvercast: { value: 0 },                                  // 0 晴空积云 → 1 漫天暴雨石板蓝阴云
  uCloudShift: { value: new THREE.Vector2(0, 0) },          // 高空卷云与阴云纹理的平缓风向漂移
  uAfterRain: { value: 0 },                                 // 雨后模式（右侧残留退去雨云，左侧云开见日）
  uSideRays: { value: 0 },                                  // 左侧单侧柔和斜射阳光强度（0..1）
  uFlash: { value: new THREE.Vector4(0, 1, 0, 0) },         // 闪电方向 xyz 与强度 w
  uDeckDark: { value: new THREE.Color(screen('#2c364b')) },
  uDeckMid: { value: new THREE.Color(screen('#475570')) },
  uDeckLit: { value: new THREE.Color(screen('#7686a3')) },
};

export function buildcapeClouds() {
  const rng = new Rng(7319);
  const towers = [];
  const mound = (f) => 1 - 0.58 * f * f * (0.7 + 0.3 * f);
  const add = (o) => towers.push(cloudTower(rng, { prof: mound, ...o }));

  // 宽底座、柔和金字塔轮廓的水粉夏日积云群（避开 -44° 雨后单侧阳光主窗口，消除窄柱感）
  add({ az: -86, base: -3.2, w: 42, h: 19, r: 5.4, lean: 0.05, haze: 0.12 });
  add({ az: 26,  base: -3.0, w: 46, h: 21, r: 5.8, lean: 0.04, haze: 0.10 });
  add({ az: 74,  base: -3.0, w: 38, h: 17, r: 5.0, lean: -0.04, haze: 0.14 });
  // 陆地一侧（+Z，az ≈ ±180°）的宽阔远景云峦
  add({ az: 124, base: -3.0, w: 40, h: 18, r: 5.2, lean: 0.03, haze: 0.12 });
  add({ az: 168, base: -2.8, w: 44, h: 20, r: 5.6, lean: -0.04, haze: 0.10 });
  add({ az: -142, base: -2.8, w: 38, h: 17, r: 4.9, lean: 0.03, haze: 0.14 });
  // 中高空少量舒展扁平碎云
  for (const [az, el, w] of [
    [-62, 13, 9.5], [0, 12, 8.5], [52, 14, 8.5],
    [102, 13, 9.0], [148, 15, 8.0], [-168, 14, 8.5], [-114, 12, 8.0],
  ]) {
    add({ az, base: el, w, h: w * 0.42, r: w * 0.28, cut: el + w * 0.08, haze: 0.08 });
  }
  return { towers };
}

export function skyDome(clouds = buildcapeClouds()) {
  // 雨后侧光光幕中心 = 方位 -44° / 仰角 13°；残云从方位 -8° 起变浓
  return coreSkyDome(clouds, { uniforms: STORM, rays: { az: -44, el: 13 }, remnant: { az0: -8, az1: 42 } });
}
