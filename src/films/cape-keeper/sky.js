import * as THREE from 'three';
import { screen } from '../../core/color.js';
import { smooth, invLerp, onThrees } from '../../core/util.js';
import { CUES } from './cues.js';
import { overcast, windPhase, WIND_DIR } from './weather.js';
import { skyDome, STORM } from './sky_storm.js';

// 天空·云·雨部门（部门名 atmo）：
//   由 sky_storm.js 的多层绘画天穹统一承载：晴空团块积云 + 卷云丝 → 起风平稳增厚的石板蓝阴云 → 雨后左侧云开单侧斜阳。
//   海面由引擎 mWater 配合调色板自然过渡。

const C = CUES;
const scr = (h) => new THREE.Color(screen(h));
const DECK_GALE = { dark: scr('#3a4459'), mid: scr('#525f78'), lit: scr('#7c8aa4') };
const DECK_STORM = { dark: scr('#2a354b'), mid: scr('#42506a'), lit: scr('#6e7e99') };

export function createSky(ctx) {
  const { scene, camera } = ctx;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 56, 28), skyDome());
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  ctx.sky = sky;

  return {
    sky,
    update(st) {
      const t = st.t, tq = onThrees(t);
      sky.position.copy(camera.position);

      const ov = overcast(t);
      STORM.uOvercast.value = ov;

      // 云纹沿风向平缓漂移（由积分曲线驱动，全片速度平稳连贯，绝不忽快忽慢）
      const wp = windPhase(tq) * 0.012;
      STORM.uCloudShift.value.set(-WIND_DIR[0] * wp, -WIND_DIR[1] * wp);

      // 阴云颜色随暴雨加深从青灰过渡至石板蓝灰紫
      const kDeep = smooth(invLerp(42.0, 58.0, t));
      STORM.uDeckDark.value.copy(DECK_GALE.dark).lerp(DECK_STORM.dark, kDeep);
      STORM.uDeckMid.value.copy(DECK_GALE.mid).lerp(DECK_STORM.mid, kDeep);
      STORM.uDeckLit.value.copy(DECK_GALE.lit).lerp(DECK_STORM.lit, kDeep);

      // 73.5 s 黑场转场后进入雨后单侧斜阳状态
      const after = t >= C.rainStop ? 1 : 0;
      STORM.uAfterRain.value = after;
      STORM.uSideRays.value = after * smooth(invLerp(C.shafts[0], C.shafts[1], t));
    },
  };
}
