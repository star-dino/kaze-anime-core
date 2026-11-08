import * as THREE from 'three';
import { paintMaterial, skyMaterial } from '../core/materials.js';
import { onThrees } from '../core/util.js';

// 环境部门骨架：天空 + 一块刚浮出水面的小沙洲（高度 < 1.2 m 的地方 paintMaterial 自动画成沙色；
// 想要草地就把地形抬高）。水面由引擎画，这里只驱动它的时间。
export function terrain(x, z) {
  return 0.4 - 0.004 * (x * x + z * z);      // TODO：你的地形（纯函数，别的部门也会用）
}

export function createWorld(ctx) {
  const { scene, engine, camera } = ctx;
  // 积云团块 [方位角°, 仰角°, 半径°, 云底仰角°]（方位 0 = -Z，+ 朝 +X）
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMaterial([
    [170, 6, 7, 3], [178, 10, 6, 3], [186, 7, 6, 3], [-20, 5, 8, 2], [-12, 11, 6, 2],
  ]));
  sky.frustumCulled = false;
  scene.add(sky);
  ctx.sky = sky;

  const g = new THREE.PlaneGeometry(40, 40, 80, 80);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrain(pos.getX(i), pos.getZ(i)));
  g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, paintMaterial({ color: '#9ccc6a', color2: '#5b9a52', sand: '#eadfb8', scale: 0.15 })));

  const wu = engine.mWater.uniforms;
  return {
    sky, terrain,
    update(st) {
      sky.position.copy(camera.position);
      wu.uFxTime.value = onThrees(st.t);
    },
  };
}
