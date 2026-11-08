import * as THREE from 'three';
import { celMaterial } from '../../core/materials.js';
import { Rng, smooth, onThrees, onTwos, clamp, hash, noise1 } from '../../core/util.js';
import { screen } from '../../core/color.js';
import { SPOT } from './cues.js';
import { WIND_DIR, wind } from './weather.js';
import { foliage } from '../../core/foliage.js';
import { meadowUniforms, meadowGround, meadowRock, GrassField } from '../../core/grass.js';

// 草地·地面部门：
//   岬角地形（崖顶草台地 + 灰褐色陡崖 + 悬出的草唇）、
//   凪坐处的风化崖顶扁平卧石台（高约 2.42 m，让凪以髋高膝低的舒展坐姿端坐）、
//   草（core/grass.js：近景叶片 / 中景笔触 / 远景平涂 + 风浪）、
//   草里的灰岩、海里的礁石、测风杆 + 风向袋。

const SC = 4;
const edge0 = (X) => -9 + 0.018 * X * X + 1.5 * Math.sin(X * 0.21 + 1);
const top0 = (X) => edge0(X) + 0.55 + 0.14 * Math.sin(X * 1.7 + 0.3) + 0.09 * Math.sin(X * 3.3 + 1.1);
export const cliffTop = (x) => SC * top0(x / SC);
export function terrain(x, z) { return SC * terrain0(x / SC, z / SC); }
function terrain0(x, z) {
  const edge = edge0(x);
  const plateau = 6 + 0.35 * Math.sin(x * 0.3) * Math.sin(z * 0.25) + Math.max(0, z - 14) * 0.18 * smooth((z - 14) / 30);
  const hills = 5 * smooth((z - 30) / 40) * (0.58 + 0.32 * Math.sin(x * 0.041 + 0.7) + 0.18 * (noise1(x * 0.09, 17) - 0.5));
  const top = top0(x), u = z - top;
  let cliff;
  if (u >= 0) cliff = smooth((z - (edge - 6)) / 7);
  else {
    const a = -u, cTop = smooth((top - (edge - 6)) / 7);
    const ledge = 0.035 * Math.sin(a * 5.1 + x * 0.7) * smooth(a / 0.6) * (1 - smooth((a - 1.6) / 0.6));
    cliff = cTop * clamp(1 - smooth(a / 2.2) + ledge, 0, 1);
  }
  const nearHero = 1 - smooth((Math.hypot(x - 1.5, z + 1.0) - 2.0) / 3.5);
  const undul = 0.26 * (noise1(x * 0.31 + 0.65 * noise1(z * 0.27, 3), 5) - 0.5)
    + 0.15 * (noise1(z * 0.47 - 0.55 * noise1(x * 0.39, 9), 11) - 0.5);
  const micro = nearHero * 0.25 * Math.sin(x * 1.3 + z * 0.7) + (1 - nearHero) * undul;
  return -5 + (plateau + hills + 5) * cliff + micro * cliff;
}
const slopeAt = (x, z) => Math.hypot(terrain(x + 0.4, z) - terrain(x - 0.4, z), terrain(x, z + 0.4) - terrain(x, z - 0.4)) / 0.8;

function terrainGeometry() {
  const xs = [];
  for (let x = -560; x < -180; x += 5) xs.push(x);
  for (let x = -180; x <= 180; x += 1) xs.push(x);
  for (let x = 185; x <= 560; x += 5) xs.push(x);
  const us = [];
  for (let u = -380; u < -14; u += 4) us.push(u);
  for (let u = -14; u < 5; u += 0.4) us.push(u);
  for (let u = 5; u < 240; u += 1.6) us.push(u);
  for (let u = 240; u <= 900; u += 8) us.push(u);
  const W = xs.length, H = us.length;
  const pos = new Float32Array(W * H * 3), edge = new Float32Array(W * H);
  for (let i = 0; i < W; i++) {
    const x = xs[i], zt = cliffTop(x);
    for (let j = 0; j < H; j++) {
      const z = Math.min(zt + us[j], 820 + j * 0.01), k = i * H + j;
      pos[k * 3] = x; pos[k * 3 + 1] = terrain(x, z); pos[k * 3 + 2] = z;
      edge[k] = z - zt;
    }
  }
  const idx = [];
  for (let i = 0; i < W - 1; i++) for (let j = 0; j < H - 1; j++) {
    const a = i * H + j, b = (i + 1) * H + j;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function vnoise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = (t) => t * t * (3 - 2 * t);
  const h = (a, b, c) => hash(a + 1000, b + 2000 + s * 31, c + 3000);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u(fx)), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u(fx)), u(fy)),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u(fx)), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u(fx)), u(fy)), u(fz));
}

function boulder(rx, ry, rz, seed, flatTop = 0.82) {
  const g = new THREE.SphereGeometry(1, 34, 22);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = vnoise3(x * 1.3 + 5, y * 1.3, z * 1.3, seed) - 0.5, n2 = vnoise3(x * 3.2, y * 3.2 + 7, z * 3.2, seed + 1) - 0.5;
    const r = 1 + 0.30 * n + 0.10 * n2;
    let yy = y * r * ry;
    if (yy > ry * flatTop) yy = ry * flatTop + (yy - ry * flatTop) * 0.22;
    if (yy < -ry * 0.35) yy = -ry * 0.35 - (-ry * 0.35 - yy) * 0.28;
    p.setXYZ(i, x * r * rx, yy, z * r * rz);
  }
  g.computeVertexNormals();
  return g;
}

// 凪的崖顶风化卧石台高度（顶面高出 SPOT.seat 地面约 2.42 m）
export const SEAT_LEDGE_H = 2.42;

export function createWorld(ctx) {
  const { scene, engine, camera } = ctx;
  const [sx, sz] = SPOT.seat, [fx, fz] = SPOT.flower, [rkx, rkz] = SPOT.rock;
  const dist2 = (x, z, p) => Math.hypot(x - p[0], z - p[1]);

  // ---- 共享 uniform：风浪 / 天气 / 接触 / 叶片层距离（清空卧石台、岩缝、小花底部的长草）
  const seatCenter = [sx - 0.15, sz + 0.75];
  const U = meadowUniforms({
    lod0: 14, lod1: 50, windDir: WIND_DIR,
    clear: [[seatCenter[0], seatCenter[1], 4.2, 0], [rkx, rkz, 2.5, 0], [fx, fz, 1.6, 0]],
  });

  // ---- 地面
  const ground = new THREE.Mesh(terrainGeometry(), meadowGround(U));
  scene.add(ground);

  const rockMat = meadowRock(U, { moss: 0.48, boulder: true });

  // ---- 凪坐处的风化崖顶卧石台（主座石 + 两侧伴生矮石，自然嵌入草坡，顶面平整托住骨盆）
  const gSeat = terrain(sx, sz);
  const seatGroup = new THREE.Group();
  {
    const mainStone = new THREE.Mesh(boulder(3.85, 3.65, 2.95, 108, 0.64), rockMat);
    // flatTop = 0.64 -> 顶面约在 ry * 0.67 ≈ 2.45 m，放在 gSeat - 0.03 使顶面精确落在 gSeat + 2.42 m
    mainStone.position.set(seatCenter[0], gSeat - 0.03, seatCenter[1]);
    mainStone.rotation.y = 0.12;
    seatGroup.add(mainStone);

    const sideL = new THREE.Mesh(boulder(2.15, 1.95, 1.85, 112, 0.70), rockMat);
    sideL.position.set(sx - 3.35, terrain(sx - 3.35, sz + 1.35) - 0.15, sz + 1.35);
    sideL.rotation.y = 1.1;
    seatGroup.add(sideL);

    const sideR = new THREE.Mesh(boulder(1.75, 1.55, 1.55, 117, 0.72), rockMat);
    sideR.position.set(sx + 2.95, terrain(sx + 2.95, sz + 1.55) - 0.18, sz + 1.55);
    sideR.rotation.y = 2.4;
    seatGroup.add(sideR);
  }
  scene.add(seatGroup);

  // ---- 草里的灰岩：远离凪坐处、小花与视线走廊，避开崖边
  const rng = new Rng(21);
  const rocks = [
    [seatCenter[0], seatCenter[1], 3.9],
    [sx - 3.35, sz + 1.35, 2.1],
    [sx + 2.95, sz + 1.55, 1.7],
  ];
  const tryRock = (x, z, r) => {
    if (dist2(x, z, SPOT.seat) < 17.5 || dist2(x, z, SPOT.flower) < 7.5 || dist2(x, z, SPOT.mast) < 4.5) return;
    if (z - cliffTop(x) < 4 || terrain(x, z) < 20 || slopeAt(x, z) > 0.35) return;
    if (rocks.some((q) => Math.hypot(q[0] - x, q[1] - z) < q[2] + r + 1.2)) return;
    rocks.push([x, z, r]);
  };
  for (const [x, z, r] of [[21.5, 25.5, 1.75], [24.4, 27.6, 1.15], [19.2, 28.2, 0.85], [36.5, 24.0, 1.35], [38.6, 26.2, 0.8]]) tryRock(x, z, r);
  for (const [cx, cz] of [[20, 22], [32, 6], [28, 14], [-30, 22], [48, -6], [-8, 40], [70, 30], [-60, 0], [18, 70], [-40, 70]]) {
    const n = 1 + Math.floor(rng.next() * 3);
    for (let i = 0; i < n; i++) tryRock(cx + rng.range(-5, 5), cz + rng.range(-4, 4), rng.range(1.0, 2.5));
  }
  for (let i = 0; i < 38; i++) tryRock(rng.range(-110, 110), rng.range(-30, 140), rng.range(0.35, 1.2));
  rocks.slice(3).forEach(([x, z, r], i) => {
    const m = new THREE.Mesh(boulder(r * rng.range(1.0, 1.4), r * rng.range(0.75, 1.0), r * rng.range(0.85, 1.2), i), rockMat);
    m.position.set(x, terrain(x, z) + r * 0.05, z);
    m.rotation.y = rng.range(0, 6.28);
    scene.add(m);
  });

  // ---- 海里的礁石
  const seaRock = meadowRock(U, { moss: 0.15, seed: 3 });
  for (const [x, z, r] of [[-28, -68, 9], [20, -78, 6], [-72, -36, 12], [64, -32, 8], [-112, -88, 9], [120, -8, 10], [6, -52, 4], [34, -44, 3]]) {
    const m = new THREE.Mesh(boulder(r, r * 1.1, r * 0.9, 50 + x), seaRock);
    m.position.set(x, -r * 0.35, z);
    m.rotation.y = rng.range(0, 6.28);
    scene.add(m);
  }

  // ---- 草（近景叶片）
  const spot = (x, z) => {
    const y = terrain(x, z);
    if (y < 14) return null;
    const u = z - cliffTop(x);
    if (u < -2.6) return null;
    if (u < 0.8) {
      const dzdx = (cliffTop(x + 0.5) - cliffTop(x - 0.5));
      return { k: 0.9, len: 1.25, kind: 3, dir: Math.atan2(-1, dzdx), lean: 1.0 + 0.25 * clamp(-u, 0, 2), plume: 0 };
    }
    if (slopeAt(x, z) > 1.0) return null;
    for (const [rx, rz, r] of rocks) { const d = Math.hypot(x - rx, z - rz); if (d < r * 1.02) return null; }
    // 小花、岩缝、水洼周围留出干净低矮苔藓空地，绝不遮挡小花特写
    const dF = dist2(x, z, SPOT.flower), dR = dist2(x, z, SPOT.rock), dP = dist2(x, z, SPOT.puddle);
    if (dF < 0.65 || dP < 0.95 || (Math.abs(x - rkx) < 2.2 && Math.abs(z - rkz) < 1.35)) return null;
    const near = Math.min(dF, dR, dP);
    if (near < 3.8) return { k: 0.88, len: 0.22 + 0.78 * smooth((near - 1.5) / 2.3), kind: near < 2.4 ? 2 : 0, plume: 0 };
    const tall = 0.78 + 0.62 * smooth((noise1(x * 0.11, 3) + noise1(z * 0.13, 7)) * 0.6 + 0.5);
    return { k: 1, len: tall, plume: tall > 1.02 ? 1.85 : 0.75 };
  };
  const grass = new GrassField(U, { seed: 12, cell: 8, density: 40, height: terrain, spot, plume: 0.055, margin: 24 });
  scene.add(grass.group);

  // 接触：双脚把落脚处长草压平
  const _v = new THREE.Vector3();
  let pressFrame = -1;
  const PRESS = [['ankleL', 3.1, 3.6], ['ankleR', 3.1, 3.6]];
  grass.onBeforeRender = (renderer) => {
    const f = renderer.info.render.frame;
    if (f === pressFrame) return;
    pressFrame = f;
    const P = U.uPress.value;
    P.forEach((p) => p.set(0, 0, 0, 0));
    const rig = ctx.nagi?.rig;
    let i = 0;
    P[i++].set(seatCenter[0], seatCenter[1], 4.5, 1);
    if (rig) {
      for (const [name, r, hMax] of PRESS) {
        const o = rig.anchors?.[name] ?? rig.j?.[name];
        if (!o) continue;
        _v.setFromMatrixPosition(o.matrixWorld);
        const h = _v.y - terrain(_v.x, _v.z);
        const k = 1 - smooth((h - hMax * 0.6) / (hMax * 0.6));
        if (k > 0) P[i++].set(_v.x, _v.z, r, k);
      }
    }
  };

  // ---- 岩缝与石台周围的苔藓垫
  const MOSS = { deep: '#33483e', shade: '#4f6748', mid: '#768848', light: '#a3a25e', blossom: '#f4efe0' };
  const mossItems = [];
  const mr = new Rng(14);
  for (let i = 0; i < 95; i++) {
    const a = mr.range(0, 6.28), d = mr.range(1.25, 4.3);
    const x = rkx + Math.cos(a) * d * 1.3, z = rkz + Math.sin(a) * d;
    const s = mr.range(0.25, 0.6);
    if (dist2(x, z, SPOT.flower) < 0.68 || dist2(x, z, SPOT.puddle) < 0.92) continue;
    mossItems.push({ p: [x, terrain(x, z) - 0.03, z], s, sy: 0.45, k: 'moss', h: mr.range(0, 0.3), f: mr.int(0, 1) });
  }
  scene.add(foliage(mossItems, { ...MOSS, sway: 0.2 }));

  // ---- 测风杆 + 风向袋（全片拴在杆上：微风下垂、狂风绷直猎猎抖动、雨后轻摇，保持前后连贯）
  const [mx, mz] = SPOT.mast, gyM = terrain(mx, mz);
  const iron = celMaterial({ color: screen('#5a5560'), id: 86, gloss: 0.3, wear: 0 });
  const iron2 = celMaterial({ color: screen('#6a5a50'), id: 89, gloss: 0.2, wear: 0 });
  const mast = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 6, 10), iron); pole.position.y = 3;
  mast.add(pole);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 6), iron2);
    arm.rotation.z = Math.PI / 2; arm.rotation.y = a; arm.position.set(Math.cos(a) * 0.25, 6.05, -Math.sin(a) * 0.25);
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), iron2);
    cup.rotation.z = Math.PI / 2; cup.position.set(Math.cos(a) * 0.5, 6.05, -Math.sin(a) * 0.5);
    mast.add(arm, cup);
  }
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), iron); boom.rotation.z = Math.PI / 2;
  const sockMount = new THREE.Group(); sockMount.position.set(0, 5.4, 0);
  boom.position.x = 0.25; sockMount.add(boom);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.018, 6, 20), celMaterial({ color: screen('#4a4650'), id: 90, gloss: 0.3, wear: 0 }));
  ring.rotation.y = Math.PI / 2;
  const sock = new THREE.Group(); sock.position.x = 0.5;
  sockMount.add(sock);
  sock.add(ring);
  const red = celMaterial({ color: screen('#c94a3a'), id: 87, gloss: 0.1, wear: 0 });
  const white = celMaterial({ color: screen('#efe9dc'), id: 88, gloss: 0.1, wear: 0 });
  const segs = [];
  let parent = sock;
  const SEG = 0.36;
  for (let i = 0; i < 5; i++) {
    const r0 = 0.24 - i * 0.033, r1 = r0 - 0.033;
    const g = new THREE.CylinderGeometry(r1, r0, SEG, 14, 1, true);
    g.rotateZ(-Math.PI / 2); g.translate(SEG / 2, 0, 0);
    const j = new THREE.Group(); j.position.x = i === 0 ? 0 : SEG;
    j.add(new THREE.Mesh(g, i % 2 ? white : red));
    parent.add(j); segs.push(j); parent = j;
  }
  mast.add(sockMount);
  mast.position.set(mx, gyM, mz);
  scene.add(mast);
  const windYaw = Math.atan2(-WIND_DIR[1], WIND_DIR[0]);

  function sockPose(t) {
    const T = onTwos(t), W = wind(T);
    const lift = smooth(W / 0.42);
    const droop = (1 - lift) * 1.32;
    sockMount.rotation.y = windYaw + 0.14 * noise1(T * 0.7, 9) * W;
    sock.position.set(0.5, 0, 0);
    sock.rotation.set(0, 0, -droop);
    segs.forEach((j, i) => {
      const fl = Math.sin(T * (10 + 6 * W) - i * 1.3) * (0.04 + 0.18 * W) * (0.4 + i * 0.25);
      j.rotation.set(fl * 0.55, fl, -(1 - lift) * 0.12 * (i > 0 ? 1 : 0));
    });
  }

  const wu = engine.mWater.uniforms;
  return {
    terrain, cliffTop, ground, grass, seatGroup, uniforms: U,
    update(st) {
      wu.uFxTime.value = onThrees(st.t);
      wu.uWaveAmp.value = 0.32 + 0.72 * (st.look.wind?.strength ?? 0);
      const M = U.uMeadow.value;
      M.z = st.look.wet ?? 0;
      M.w = st.look.rain ?? 0;
      grass.update(camera);
      sockPose(st.t);
    },
  };
}
