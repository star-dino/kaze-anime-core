import * as THREE from 'three';
import { celMaterial, paintMaterial } from '../../core/materials.js';
import { cbox } from '../../core/kit.js';
import { RainField } from '../../core/rain.js';
import { screen } from '../../core/color.js';
import { onTwos } from '../../core/util.js';
import { terrain } from '../../story/world.js';

// 雨打水面 + 地面水洼的最小示例（W8 / W10 余项）：
//   镜头 'rainWater'（32–36 s）：崖顶一块湿地（paintMaterial({ puddles: true })，look.puddles 控制水洼多少），
//   崖下的海面和水洼里同时下雨环（look.rainRings —— 和天气层的 look.rain 无关，必须显式给）；
//   两根木桩（id 94）立在水洼边、海上一只浮标（id 95 / 96，自动拿到接触泡沫）；RainField 给一点雨丝当参照。
//   STORY=_coretest node tools/snap.mjs --sheet rainWater s:rainWater@0.1 s:rainWater@0.5 s:rainWater@0.9
export const RAIN_SHOT = [32, 36];
export const RAIN_AT = [15, -1];          // 湿地中心（x, z）：示例片岬角的东侧台地，崖边约在 z = -6
const inShot = (t, [a, b]) => t >= a && t < b;

export function createRainWaterTest(ctx) {
  const { scene, overlay, engine, camera } = ctx;
  const grp = new THREE.Group(); grp.visible = false; scene.add(grp);

  // ---- 湿地：贴着地形起伏的一块位移平面（略高于示例片的地面），只有这块开了 puddles
  const g = new THREE.PlaneGeometry(16, 11, 64, 44);
  g.rotateX(-Math.PI / 2);
  g.translate(RAIN_AT[0], 0, RAIN_AT[1]);
  const pos = g.attributes.position;
  // 示例片地形上有一层 0.25 m 的正弦起伏（满地是平行的小坡，水洼会被坡度判据切成一条条）：
  // 隔半个周期取平均把它抵消，抬成平地；起伏高出平地的地方仍是原地形 → 水洼里自然留出几块草岛
  const flatY = (x, z) => 0.5 * (terrain(x, z) + terrain(x + Math.PI / 1.3, z)) + 0.1;
  for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); pos.setY(i, Math.max(terrain(x, z) + 0.04, flatY(x, z))); }
  g.computeVertexNormals();
  // 和示例片地面同一组参数（色块是世界坐标的函数）→ 接缝看不出来，只多了水洼
  const ground = new THREE.Mesh(g, paintMaterial({ color: '#9ccc6a', color2: '#5b9a52', rock: '#c2ae94', sand: '#eadfb8', scale: 0.05, steps: 3, puddles: true }));
  grp.add(ground);

  // ---- 赛璐璐道具：两根木桩（94）、海上浮标（95 身 / 96 顶）
  const cel = (id, hex, shade) => celMaterial({ id, color: screen(hex), shadeBase: hex, shade, ink: '#2e3640', gloss: 0.3, receiveShadow: true });
  for (const [x, z, h] of [[RAIN_AT[0] - 2.4, RAIN_AT[1] - 3.6, 1.1], [RAIN_AT[0] + 1.6, RAIN_AT[1] - 4.4, 0.8]]) {
    const post = new THREE.Mesh(cbox(0.18, h, 0.18, 0.03), cel(94, '#8a6a4e', '#5a4438'));
    post.position.set(x, terrain(x, z) + h / 2, z); post.rotation.y = 0.4 + x * 0.3; grp.add(post);
  }
  const buoy = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 18), cel(95, '#e2553e', '#a83a36'));
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.5, 14), cel(96, '#f2efe6', '#a9a8c0'));
  cap.position.y = 0.8; buoy.add(body, cap);
  buoy.position.set(RAIN_AT[0] + 5.5, 0.1, -17.5); grp.add(buoy);

  const rain = new RainField({ S: engine.S });
  overlay.add(rain.mesh);
  rain.mesh.visible = false;

  return {
    grp, rain,
    update(st) {
      const on = inShot(st.t, RAIN_SHOT);
      grp.visible = on;
      if (!on) { rain.mesh.visible = false; return; }
      const lt = st.t - RAIN_SHOT[0];
      // 浮标一拍二地轻晃（纯函数）
      const tq = onTwos(st.t);
      buoy.position.y = 0.05 + 0.08 * Math.sin(tq * 2.1);
      buoy.rotation.set(0.08 * Math.sin(tq * 1.7 + 1), 0, 0.1 * Math.sin(tq * 1.3));
      rain.update({ camera, t: tq, amount: 0.32 + 0.04 * lt });
    },
  };
}
