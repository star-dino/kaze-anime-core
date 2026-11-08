import * as THREE from 'three';
import { RainField, WaterStrokeBatch } from '../../core/rain.js';
import { GlowBatch, LineBatch, boltPts, GLOW } from '../../core/fx.js';
import { onTwos, onThrees, smooth, invLerp, clamp, hash, drawing } from '../../core/util.js';
import { screen } from '../../core/color.js';
import { CUES, SPOT } from './cues.js';
import { wind, rain, WIND_DIR, FIRST_DROPS } from './weather.js';
import { STORM } from './sky_storm.js';

// 天气特效部门（weather）：
//   1. 起风气流风丝（s05–s08）：掠过飞转三杯风速计的弧形旋风丝与贴草疾掠的半透明风带
//   2. 初雨一滴滴慢落（s08_first_drops，47.36–51.92 s）：严格同步 FIRST_DROPS，大颗银白雨滴斜落打在岩石、花苞与浅水洼激起飞沫
//   3. 右前臂护檐避雨区与绘画水帘（s09–s11）：沿前臂与手掌外下缘（eaveR0 → eaveR1）挂下透光水舌、水珠串与地面溅花
//   4. 远海闪电（CUES.flash1 = 63.2 s，s10_under_eave）：照亮石板蓝云层与檐下静谧花影
//   5. 雨后单侧斜阳水珠星芒（s13_retract）+ 最后一滴金珠落水（CUES.lastDrop = 88.2 s）+ 盛放柔光微粒（s14_drop_bloom）
// 全部是 st.t 与 CUES 的纯函数，零跨帧状态。

const C = CUES;

const rgb = (hex) => { const c = new THREE.Color(screen(hex)); return [c.r, c.g, c.b]; };

export function createWeatherFx(ctx) {
  const { overlay, camera, engine } = ctx;
  const field = new RainField({ S: engine.S, color: '#d0dae6' });
  const water = new WaterStrokeBatch(engine.S, 20000);   // 水的笔画已下沉到 core/rain.js（W8 / W10）
  const bolts = new LineBatch(4096);
  const glows = new GlowBatch(256);
  bolts.mesh.renderOrder = 5;
  glows.mesh.renderOrder = 6;
  overlay.add(field.mesh, water.mesh, bolts.mesh, glows.mesh);

  const COL_WATER = rgb('#cfdbe8');
  const COL_BRIGHT = rgb('#ebf3fc');
  const COL_WIND = rgb('#f0f6ff');
  const COL_WARM_EAVE = rgb('#e8dfc8');
  const COL_GOLD_DROP = rgb('#fff1ca');

  const _e0 = new THREE.Vector3(), _e1 = new THREE.Vector3(), _ec = new THREE.Vector3();
  const _cp = new THREE.Vector3(), _hd = new THREE.Vector3(), _sh = new THREE.Vector3();
  const _fh = new THREE.Vector3(), _pd = new THREE.Vector3();
  const _pA = new THREE.Vector3(), _pB = new THREE.Vector3();
  const _camR = new THREE.Vector3(), _camU = new THREE.Vector3(), _tmp = new THREE.Vector3();

  const taperTongue = (s) => (1 - 0.65 * s) * (0.65 + 0.35 * Math.sin(Math.min(1, s * 3) * Math.PI * 0.5));
  const alphaTongue = (s) => (1 - s * s * 0.85);
  const taperBead = (s) => Math.sin(s * Math.PI) * 0.85 + 0.25;
  const taperWind = (s) => Math.sin(s * Math.PI);
  const taperDrop = (s) => 0.25 + 0.95 * Math.pow(s, 0.65) * Math.sin(Math.min(1, (1 - s) * 2.6 + 0.25) * Math.PI * 0.5);

  return {
    field, water, bolts, glows,
    update(st) {
      const t = st.t, t2 = onTwos(t), t3 = onThrees(t);
      const W = wind(t), R = rain(t);
      const rig = ctx.nagi?.rig;
      const terrain = ctx.world?.terrain ?? (() => 24);
      const wx = WIND_DIR[0], wz = WIND_DIR[1];

      water.begin();
      bolts.begin();
      glows.begin();
      STORM.uFlash.value.set(0, 1, 0, 0);

      const hasRig = !!(rig && rig.anchors?.eaveR0 && rig.anchors?.eaveR1);
      if (hasRig) {
        rig.at('eaveR0', _e0);
        rig.at('eaveR1', _e1);
        rig.at('eaveCenter', _ec);
        rig.at('cups', _cp);
        rig.at('handR', _hd);
        rig.at('shoulderR', _sh);
      }

      // ---- 1. 动态避雨椭圆（从右前臂护檐中心 eaveCenter 与小花坐标实时推算，护住前臂下方 2.85 m 净空）
      let shelter = null;
      if (hasRig && t >= C.guard[0] + 1.0 && t < C.rainStop) {
        const kSh = smooth(invLerp(C.guard[0] + 1.0, C.guard[1], t));
        const fx = SPOT.flower[0], fz = SPOT.flower[1];
        shelter = {
          x: fx * 0.55 + _ec.x * 0.45,
          y: Math.min(_e0.y, _e1.y) + 0.15,
          z: fz * 0.55 + _ec.z * 0.45,
          rx: 2.35 * kSh,
          rz: 2.75 * kSh,
          rot: 0,
        };
      }
      field.update({ camera, t: t2, amount: R, shelter });

      // ---- 2. 起风气流风丝（30.0–56.5 s：尤其 s06_cups_gale 头顶风杯飞转时，画出清晰灵动的空气流线与旋风弧）
      const kWindVis = smooth(invLerp(0.40, 0.74, W)) * (1 - smooth(invLerp(55.5, 58.5, t)));
      if (hasRig && kWindVis > 0.02) {
        // (a) 环绕三杯风速计的高速气流旋弧（贴合旋转方向，半透明轻薄手绘风丝，绝非实体圆盘）
        for (let i = 0; i < 7; i++) {
          const ph = (t * (2.8 + (i % 3) * 0.42) + i * 0.31) % 1;
          const env = Math.sin(ph * Math.PI);
          if (env < 0.08) continue;
          const aStart = t * 10.5 + i * 0.90;
          const arcLen = 1.25 + 0.45 * hash(i, 7, 101);
          const rad = 0.74 + 0.16 * (i % 4) + 0.14 * ph;
          const yOff = (i - 3) * 0.055;
          const pts = [];
          for (let s = 0; s <= 7; s++) {
            const u = s / 7, ang = aStart + u * arcLen;
            pts.push([
              _cp.x + Math.cos(ang) * rad + wx * u * 0.36,
              _cp.y + yOff + Math.sin(u * Math.PI) * 0.06,
              _cp.z - Math.sin(ang) * rad + wz * u * 0.36,
            ]);
          }
          water.push(pts, {
            r: 0.014, px: 2.15, color: COL_BRIGHT,
            alpha: 0.56 * kWindVis * env, taper: taperWind, alphaFn: taperWind, spec: 0.85, bias: 0.12,
          });
        }
        // (b) 掠过凪头肩与草地低空的疾风流线带
        for (let i = 0; i < 12; i++) {
          const h0 = hash(i, 13, 211), h1 = hash(i, 29, 211), h2 = hash(i, 43, 211);
          const period = 0.68 + 0.40 * h0;
          const ph = ((t + h1 * 3.7) / period) % 1;
          const env = Math.sin(ph * Math.PI);
          if (env < 0.06) continue;
          const nearCups = i < 7;
          const baseX = nearCups ? _cp.x + (h0 - 0.5) * 4.4 : SPOT.flower[0] + (h0 - 0.5) * 6.5;
          const baseY = nearCups ? _cp.y - 0.9 + h2 * 2.0 : terrain(SPOT.flower[0], SPOT.flower[1]) + 0.7 + h2 * 2.0;
          const baseZ = nearCups ? _cp.z - 4.2 + (h1 - 0.5) * 2.8 : SPOT.flower[1] - 4.2 + (h1 - 0.5) * 3.5;
          const travel = ph * (nearCups ? 6.2 : 8.0);
          const segLen = 2.4 + 1.8 * h1;
          const pts = [];
          for (let s = 0; s <= 6; s++) {
            const u = s / 6, dist = travel + u * segLen;
            const wave = Math.sin(dist * 1.2 + i * 2.1) * 0.16;
            pts.push([
              baseX + wx * dist - wz * wave,
              baseY + Math.sin(dist * 0.85 + i) * 0.12,
              baseZ + wz * dist + wx * wave,
            ]);
          }
          water.push(pts, {
            r: 0.015, px: 1.95, color: COL_WIND,
            alpha: 0.44 * kWindVis * env, taper: taperWind, alphaFn: taperWind, spec: 0.70, bias: 0.15,
          });
        }
      }

      // ---- 3. 初雨一滴滴慢落（s08_first_drops，47.36–51.92 s：大颗晶莹雨滴由疏到密落下并激起飞沫）
      if (t >= C.firstDrops[0] - 0.4 && t <= C.firstDrops[1] + 0.45) {
        const gyF = terrain(SPOT.flower[0], SPOT.flower[1]);
        if (ctx.flower?.head) ctx.flower.head(_fh, t); else _fh.set(SPOT.flower[0], gyF + 1.4, SPOT.flower[1]);
        if (ctx.flower?.puddleCenter) ctx.flower.puddleCenter(_pd); else _pd.set(SPOT.puddle[0], gyF + 0.02, SPOT.puddle[1]);

        const FALL_DUR = 0.24;
        for (let i = 0; i < FIRST_DROPS.length; i++) {
          const [th, kind, ou, ov] = FIRST_DROPS[i];
          let tx, ty, tz;
          if (kind === 'flower') {
            tx = _fh.x + (ou - 0.5) * 0.14;
            ty = _fh.y + 0.04;
            tz = _fh.z + (ov - 0.5) * 0.14;
          } else if (kind === 'puddle') {
            tx = _pd.x + (ou - 0.5) * 0.52;
            ty = _pd.y;
            tz = _pd.z + (ov - 0.5) * 0.34;
          } else {
            tx = SPOT.rock[0] + (ou - 0.5) * 0.85;
            tz = SPOT.rock[1] + (ov - 0.5) * 0.65;
            ty = terrain(tx, tz) + 0.34;
          }

          // 下落银白雨滴拉丝
          const uFall = (t - (th - FALL_DUR)) / FALL_DUR;
          if (uFall >= 0 && uFall <= 1.0) {
            const hStart = 3.2;
            const yBot = ty + hStart * (1 - uFall);
            const yTop = yBot + 0.42;
            const slant = 0.22;
            const dxB = (yBot - ty) * wx * slant, dzB = (yBot - ty) * wz * slant;
            const dxT = (yTop - ty) * wx * slant, dzT = (yTop - ty) * wz * slant;
            water.seg(tx - dxT, yTop, tz - dzT, tx - dxB, yBot, tz - dzB, {
              r: 0.011, px: 2.1, color: COL_BRIGHT, alpha: 0.86, taper: taperDrop, spec: 0.95, bias: 0.04,
            });
          }

          // 撞击瞬间的放射小水花皇冠
          const dt = t - th;
          if (dt >= 0 && dt < 0.24) {
            const p = dt / 0.24, fade = 1 - p;
            for (let k = 0; k < 5; k++) {
              const ang = (k / 5) * Math.PI * 2 + i * 0.9;
              const rad = (0.05 + 0.20 * p) * (0.8 + 0.4 * hash(i, k, 919));
              const dy = 0.13 * Math.sin(p * Math.PI);
              water.seg(
                tx + Math.cos(ang) * rad * 0.4, ty + dy * 0.55, tz + Math.sin(ang) * rad * 0.4,
                tx + Math.cos(ang) * rad, ty + dy, tz + Math.sin(ang) * rad,
                { r: 0.0075, px: 1.45, color: COL_BRIGHT, alpha: 0.84 * fade, taper: taperTongue, spec: 1.0, bias: 0.04 }
              );
            }
            _tmp.set(tx, ty + 0.03, tz);
            glows.push(_tmp, { kind: GLOW.soft, m: 0.07, px: 5, color: [0.85, 0.92, 1.0], power: 0.42 * fade, mode: 0, bias: 0.06 });
          }
        }
      }

      // ---- 4. 暴雨期：右前臂护檐（eaveR0 → eaveR1）挂水帘 + 前臂背部溅雾 + 地面飞沫（s09–s11）
      const kCurt = smooth(invLerp(C.guard[1] - 0.8, C.rainHit + 0.7, t)) * (1 - smooth(invLerp(C.rainStop - 1.2, C.rainStop, t)));
      if (hasRig && kCurt > 0.01) {
        const warmMix = smooth(invLerp(59.8, 61.0, t)) * (1 - smooth(invLerp(67.2, 68.0, t)));

        // (a) 沿右前臂与手掌外侧下缘排 30 股错落水舌与断续水串，围成屋檐外的透光雨帘
        const N_STR = 30;
        for (let i = 0; i < N_STR; i++) {
          const h0 = hash(i, 11, 307), h1 = hash(i, 23, 307), h2 = hash(i, 37, 307);
          const u = (i + 0.15 + 0.70 * h0) / N_STR;
          const ox = _e0.x + (_e1.x - _e0.x) * u + (h1 - 0.5) * 0.04;
          const oy = _e0.y + (_e1.y - _e0.y) * u;
          const oz = _e0.z + (_e1.z - _e0.z) * u;
          const gy = terrain(ox + wx * 0.30, oz + wz * 0.30);
          const fallH = Math.max(0.5, oy - gy);
          const col = warmMix > 0.05 && h2 > 0.42 ? COL_WARM_EAVE : (h2 > 0.58 ? COL_BRIGHT : COL_WATER);

          // 檐口下沿挂着的连续水舌
          const tongueL = (0.36 + 0.64 * h1 * h1) * (0.65 + 0.35 * kCurt);
          const driftT = 0.09 * tongueL;
          water.push([
            [ox, oy + 0.02, oz],
            [ox + wx * driftT * 0.4, oy - tongueL * 0.5, oz + wz * driftT * 0.4],
            [ox + wx * driftT, oy - tongueL, oz + wz * driftT],
          ], {
            r: 0.015 + 0.015 * h0, px: 1.55 + 0.95 * h0,
            color: col, alpha: (0.54 + 0.28 * h2) * kCurt,
            taper: taperTongue, alphaFn: alphaTongue, spec: 0.92,
          });

          // 往下坠落的断续水串
          const spd = 6.8 + 3.4 * h1;
          const nBeads = i % 2 === 0 ? 3 : 2;
          for (let b = 0; b < nBeads; b++) {
            const ph = (t3 * spd / fallH + h2 + b / nBeads + h0 * 0.37) % 1;
            const yTop = oy - ph * fallH;
            const segL = Math.min(0.28 + 0.58 * hash(i * 7 + b, 51, 307), yTop - gy);
            if (segL < 0.05) continue;
            const d0 = (oy - yTop) * 0.12, d1 = (oy - (yTop - segL)) * 0.12;
            water.seg(
              ox + wx * d0, yTop, oz + wz * d0,
              ox + wx * d1, yTop - segL, oz + wz * d1,
              {
                r: 0.011 + 0.010 * h1, px: 1.35 + 0.85 * h1,
                color: col, alpha: (0.48 + 0.30 * h0) * kCurt * (1 - 0.22 * ph),
                taper: taperBead, spec: 0.88,
              }
            );
          }

          // 水帘砸地的弹溅小水花
          if (i % 2 === 0) {
            const spStep = Math.floor(t3 * 8 + i * 1.7);
            const sh0 = hash(spStep, i, 509), sh1 = hash(spStep + 13, i, 509);
            if (sh0 > 0.34) {
              const lx = ox + wx * fallH * 0.12, lz = oz + wz * fallH * 0.12;
              const ly = terrain(lx, lz) + 0.01;
              const hSp = (0.07 + 0.13 * sh1) * kCurt;
              const spr = 0.05 + 0.08 * sh0;
              water.seg(lx, ly, lz, lx + spr, ly + hSp, lz + (sh1 - 0.5) * 0.08,
                { r: 0.006, px: 0.9, color: COL_BRIGHT, alpha: 0.50 * kCurt, taper: taperTongue });
              water.seg(lx, ly, lz, lx - spr * 0.85, ly + hSp * 0.85, lz - (sh0 - 0.5) * 0.08,
                { r: 0.006, px: 0.9, color: COL_BRIGHT, alpha: 0.45 * kCurt, taper: taperTongue });
            }
          }
        }

        // (b) 暴雨砸在右前臂白色背甲与肩甲顶面激起的水雾与细碎水刺
        const stepSp = Math.floor(t3 * 8);
        for (let i = 0; i < 10; i++) {
          const h0 = hash(stepSp, i * 3 + 1, 811), h1 = hash(stepSp, i * 3 + 2, 811);
          const u = 0.15 + 0.75 * h0;
          const bx = _e0.x + (_e1.x - _e0.x) * u - 0.55 + (h1 - 0.5) * 0.9;
          const by = _e0.y + (_e1.y - _e0.y) * u + 1.05 + 0.25 * h1;
          const bz = _e0.z + (_e1.z - _e0.z) * u + (h1 - 0.5) * 0.8;
          water.seg(bx, by, bz, bx + (h0 - 0.35) * 0.22, by + 0.16 + 0.14 * h1, bz + (h1 - 0.3) * 0.22,
            { r: 0.0075, px: 0.95, color: COL_BRIGHT, alpha: 0.48 * R, taper: taperTongue, bias: 0.18 });
          if (i % 3 === 0) {
            _tmp.set(bx, by + 0.14, bz);
            glows.push(_tmp, { kind: GLOW.soft, m: 0.52, px: 0, color: [0.68, 0.76, 0.88], power: 0.11 * R, mode: 0, bias: 0.35 });
          }
        }
      }

      // ---- 5. 远海闪电（CUES.flash1 = 63.2 s，s10_under_eave 水帘外右前方海面分叉落雷）
      {
        const dt = t - C.flash1;
        if (dt >= 0 && dt < 0.38) {
          const flashK = dt < 0.09 ? 0.78 : (dt > 0.15 && dt < 0.22 ? 0.52 : 0.24 * (1 - dt / 0.38));
          STORM.uFlash.value.set(145, 240, -320, flashK);
          if (dt < 0.26) {
            _camR.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
            _camU.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
            const sd = 41 + drawing(t, 12);
            _pA.set(148, 255, -325); _pB.set(134, 0, -345);
            const main = boltPts(_pA, _pB, sd, _camR, _camU, 0.18, 5);
            bolts.push(main, { px: 3.6, color: [0.72, 0.82, 1.0], power: 1.35 * Math.min(1, flashK + 0.2), rim: 0.65, mode: 0 });
            const mid = main[Math.floor(main.length * 0.45)];
            _pA.copy(mid); _pB.set(176, 48, -338);
            const fork = boltPts(_pA, _pB, sd + 17, _camR, _camU, 0.14, 4);
            bolts.push(fork, { px: 2.2, color: [0.72, 0.82, 1.0], power: 0.95 * Math.min(1, flashK + 0.2), rim: 0.55, mode: 0 });
          }
        }
      }

      // ---- 6. 雨后单侧斜阳照在湿润装甲上的细微水珠星芒（s13_retract，80.5–87.2 s）
      if (hasRig && t >= 80.5 && t <= 87.2) {
        const kGlint = smooth(invLerp(80.5, 81.8, t)) * (1 - smooth(invLerp(86.2, 87.2, t)));
        for (let i = 0; i < 4; i++) {
          const pulse = 0.5 + 0.5 * Math.sin(t2 * (2.6 + i * 0.5) + i * 2.1);
          const u = 0.22 + i * 0.20;
          _tmp.set(
            _sh.x + (_hd.x - _sh.x) * u - 0.35,
            _sh.y + (_hd.y - _sh.y) * u + 0.32,
            _sh.z + (_hd.z - _sh.z) * u - 0.25,
          );
          glows.push(_tmp, {
            kind: GLOW.kira, m: 0.05, px: 7.5,
            color: [1.0, 0.92, 0.70], power: 0.55 * kGlint * pulse, rot: 0.3 + i * 0.4, mode: 0, bias: 0.14,
          });
        }
      }

      // ---- 7. 最后一滴金色水珠落入水洼（CUES.lastDrop = 88.2 s）+ 盛放柔光微粒（s14_drop_bloom）
      const drop = ctx.flower?.puddle?.();
      if (drop && t >= C.lastDrop - 0.68 && t <= C.lastDrop + 0.36) {
        const dropX = drop.x, dropY = drop.y, dropZ = drop.z;
        const startY = dropY + 2.45;
        const FALL_T = 0.56;
        const tStart = C.lastDrop - FALL_T;
        if (t < C.lastDrop) {
          const u = clamp((t - tStart) / FALL_T, 0, 1);
          const y = startY - (startY - dropY) * Math.pow(u, 1.45);
          const tail = 0.08 + 0.10 * u;
          water.seg(dropX, y + tail, dropZ, dropX, y, dropZ, {
            r: 0.016, px: 3.4, color: COL_GOLD_DROP, alpha: 0.95, taper: taperDrop, bias: 0.03, spec: 1.0,
          });
          _tmp.set(dropX, y + 0.02, dropZ);
          glows.push(_tmp, { kind: GLOW.kira, m: 0.036, px: 9, color: [1.0, 0.90, 0.62], power: 0.92, rot: 0.35, mode: 0, bias: 0.05 });
        } else {
          const p = (t - C.lastDrop) / 0.32, fade = 1 - clamp(p, 0, 1);
          if (fade > 0.02) {
            for (let k = 0; k < 5; k++) {
              const ang = (k / 5) * Math.PI * 2 + 0.4;
              const rr = 0.03 + 0.11 * p;
              const yy = dropY + Math.max(0, 0.12 * Math.sin(p * Math.PI));
              const x = dropX + Math.cos(ang) * rr, z = dropZ + Math.sin(ang) * rr;
              water.seg(x, yy + 0.025, z, x, yy, z,
                { r: 0.007, px: 1.8, color: COL_GOLD_DROP, alpha: 0.86 * fade, taper: taperBead, bias: 0.03, spec: 1.0 });
            }
            _tmp.set(dropX, dropY + 0.025, dropZ);
            glows.push(_tmp, { kind: GLOW.soft, m: 0.09, px: 7, color: [1.0, 0.88, 0.58], power: 0.62 * fade, mode: 0, bias: 0.06 });
          }
        }
      }

      // 大白花从容盛放时的柔和逆光微尘（88.8–93.8 s）
      if (t >= C.bloom[0] && t <= C.bloom[1] + 1.2) {
        const kb = smooth(invLerp(C.bloom[0], C.bloom[0] + 0.9, t)) * (1 - smooth(invLerp(C.bloom[1] + 0.2, C.bloom[1] + 1.2, t)));
        if (kb > 0.02) {
          const gyF = terrain(SPOT.flower[0], SPOT.flower[1]);
          for (let i = 0; i < 6; i++) {
            const h0 = hash(i, 1, 991), h1 = hash(i, 2, 991), h2 = hash(i, 3, 991);
            const dtB = t2 - C.bloom[0];
            const ang = h0 * Math.PI * 2 + dtB * 0.24;
            const rr = 0.24 + 0.48 * h1;
            _tmp.set(
              SPOT.flower[0] + Math.cos(ang) * rr,
              gyF + 0.52 + 0.85 * h2 + dtB * 0.09,
              SPOT.flower[1] + Math.sin(ang) * rr,
            );
            glows.push(_tmp, { kind: GLOW.soft, m: 0.038, px: 5.5, color: [1.0, 0.93, 0.70], power: 0.40 * kb, mode: 0, bias: 0.05 });
          }
        }
      }

      water.end();
      bolts.end();
      glows.end();
    },
  };
}
