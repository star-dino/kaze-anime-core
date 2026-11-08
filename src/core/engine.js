import * as THREE from 'three';
import { G, INK_TAB } from './glsl.js';
import { MAX_RIP, FS_VERT, PAINT_FS, INK_FS, WATER_FS, ATMOS_FS, BRIGHT_FS, BLUR_FS, FINAL_FS } from './passes.js';

// 多 pass 渲染器（结构与原作 engine.js 一致）。每帧顺序：
//   1 阴影（只有角色投影） → 2 水面反射（镜像相机） → 3 主渲染 MRT（颜色 + data）
//   → 4 笔触（只画背景） → 5 描线（只画赛璐璐） → 6 屏幕空间水面 → 7 大气
//   → 8 overlay 叠加层（特效精灵/闪电，无深度测试，靠 data 图做软深度）
//   → 9 泛光 → 10 调色 + 颗粒 + 下采样到画布
//
// S = 内部超采样倍数：预览 1，成片 2（最后 4 点平均 = 抗锯齿，也让描线更细腻）。

function fsMat(fs, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: fs, uniforms,
    depthTest: false, depthWrite: false,
  });
}

export class Engine {
  constructor(canvas, W, H, S) {
    this.W = W; this.H = H; this.S = S;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.autoClear = false;
    // 整条管线工作在“显示空间”：不做 sRGB 编码，调色由 FINAL_FS 负责
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    const IW = this.IW = Math.round(W * S), IH = this.IH = Math.round(H * S);
    const half = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    // MRT：textures[0] = 颜色（a=是否绘画背景），textures[1] = data（法线.xy, 视深度, id）
    this.rtMain = new THREE.WebGLRenderTarget(IW, IH, {
      count: 2, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(IW, IH),
    });
    this.rtMain.textures[0].minFilter = this.rtMain.textures[0].magFilter = THREE.LinearFilter;
    this.rtA = new THREE.WebGLRenderTarget(IW, IH, half);
    this.rtB = new THREE.WebGLRenderTarget(IW, IH, half);
    this.rtRefl = new THREE.WebGLRenderTarget(Math.round(IW / 2), Math.round(IH / 2), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtShadow = new THREE.WebGLRenderTarget(2048, 2048, { depthTexture: new THREE.DepthTexture(2048, 2048) });
    const bw = Math.round(IW / 4), bh = Math.round(IH / 4);
    this.rtBl = [0, 1, 2, 3].map((i) => new THREE.WebGLRenderTarget(i < 2 ? bw : bw >> 1, i < 2 ? bh : bh >> 1, half));

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene(); this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const res = new THREE.Vector2(IW, IH);
    this.mPaint = fsMat(PAINT_FS, { tColor: { value: null }, tData: { value: null }, uRes: { value: res }, uRadius: { value: 4 }, uS: { value: S } });
    this.mInk = fsMat(INK_FS, { tColor: { value: null }, tData: { value: null }, uRes: { value: res }, uS: { value: S }, uWidth: { value: 1.15 }, uSeed: { value: 0 }, uInk: { value: new THREE.Color('#2a2236') }, uInkTab: INK_TAB });
    this.mWater = fsMat(WATER_FS, {
      tColor: { value: null }, tData: { value: null }, tRefl: { value: null }, uRes: { value: res },
      uCamPos: { value: new THREE.Vector3() }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uReflMat: { value: new THREE.Matrix4() },
      uWaterLevel: G.uWaterLevel, uFxTime: { value: 0 }, uOn: { value: 1 }, uWaveAmp: { value: 0.35 },
      uSunDir: G.uSunDir, uSunColor: G.uSunColor, uSunStrength: G.uSunStrength,
      uDeep: { value: new THREE.Color('#178796') }, uShallow: { value: new THREE.Color('#43c6bd') }, uFoam: { value: new THREE.Color('#ffffff') }, uSkyRefl: { value: new THREE.Color('#b8dcf3') },
      uRip: { value: Array.from({ length: MAX_RIP }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uRipB: { value: Array.from({ length: MAX_RIP }, () => new THREE.Vector4(2, 0.4, 0.5, 1)) },
      uRipC: { value: Array.from({ length: MAX_RIP }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uRipN: { value: 0 },
      uRainRing: G.uRainRing,     // 雨打水面（W8）：look.rainRings 设置；密度 0 = 跳过
    });
    this.mAtmos = fsMat(ATMOS_FS, {
      tColor: { value: null }, tData: { value: null },
      uCamPos: { value: new THREE.Vector3() }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uWaterLevel: G.uWaterLevel, uTime: G.uTime, uWaterOn: { value: 1 }, uSunDir: G.uSunDir, uSunColor: G.uSunColor, uSunStrength: G.uSunStrength,
      uFogWarm: { value: new THREE.Color('#eff5f2') }, uFogCool: { value: new THREE.Color('#cde5f4') },
      uFogDensity: { value: 0.0016 }, uMist: { value: 0.15 }, uMistHeight: { value: 4 },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uShafts: { value: 0 },
      uShaftStyle: { value: 0 }, uShaftFreq: { value: 6 }, uShaftDown: { value: 1 }, uAspect: { value: W / H }, uShaftDir: { value: new THREE.Vector2(0, -1) },
    });
    this.shaftAngle = null;     // slanted 光束的屏幕角（度，0 = 竖直向下，+ 偏右）；null = 自动：从太阳指向画面底部中央
    this.mBright = fsMat(BRIGHT_FS, { tColor: { value: null }, uThreshold: { value: 1.05 } });
    this.mBlur = fsMat(BLUR_FS, { tColor: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mFinal = fsMat(FINAL_FS, {
      tColor: { value: null }, tBloom1: { value: null }, tBloom2: { value: null }, uRes: { value: res }, uS: { value: S },
      uFrame: { value: 0 }, uBloom: { value: 0.9 }, uVignette: { value: 0.16 }, uGrain: { value: 0.02 }, uFade: { value: 0 }, uFadeSoft: { value: 0 },
      uExposure: { value: 1.12 }, uGamma: { value: 0.84 }, uVibrance: { value: 0.3 },
      uLift: { value: new THREE.Color('#161c2e') }, uGain: { value: new THREE.Color('#fffdf8') }, uSat: { value: 1.06 },
      uFadeColor: { value: new THREE.Color('#ffffff') },
      uPaper: { value: 0 }, uPaperColor: { value: new THREE.Color('#f3e4c8') },
    });

    this.shadowCam = new THREE.OrthographicCamera(-20, 20, 20, -20, 1, 200);
    this.reflCam = new THREE.PerspectiveCamera();
    this.reflMat = new THREE.Matrix4();
    this._v = new THREE.Vector3(); this._t = new THREE.Vector3(); this._u = new THREE.Vector3();
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  // 正交阴影相机贴着角色框（depth 越小 bias 越小 → 小鸟也能在手指上投出影子）
  setupShadow(center, radius, depth = 24) {
    const sc = this.shadowCam;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.near = 1; sc.far = depth * 2;
    sc.position.copy(center).addScaledVector(G.uKeyDir.value, depth);
    sc.up.set(0, 1, 0);
    sc.lookAt(center);
    sc.updateProjectionMatrix();
    sc.updateMatrixWorld();
    G.uShadowMatrix.value.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
  }

  updateReflection(cam) {
    const wl = G.uWaterLevel.value;
    const p = this._v.setFromMatrixPosition(cam.matrixWorld);
    const rc = this.reflCam;
    rc.position.set(p.x, 2 * wl - p.y, p.z);
    const look = this._t.set(0, 0, -1).applyQuaternion(cam.quaternion).add(p);
    look.y = 2 * wl - look.y;
    const up = this._u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    up.y = -up.y;
    rc.up.copy(up);
    rc.lookAt(look);
    rc.fov = cam.fov; rc.aspect = cam.aspect; rc.near = cam.near; rc.far = cam.far;
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld();
    const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.reflMat.copy(bias).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
  }

  // 用 userData 标记临时隐藏（noShadow / noReflect）
  _hide(root, key) { root.traverse((o) => { if (o.userData[key]) { o.userData._v = o.visible; o.visible = false; } }); }
  _show(root, key) { root.traverse((o) => { if (o.userData[key]) o.visible = o.userData._v; }); }

  render(scene, overlay, cam, opt) {
    const r = this.renderer;
    G.uWaterLevel.value = opt.waterLevel ?? 0;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();

    // 1. 阴影：只渲染 shadowRoots（角色），布景不投影 —— “画出来的光”，不是物理
    if (opt.shadow && opt.shadowRoots?.length) {
      this.setupShadow(opt.shadow.center, opt.shadow.radius, opt.shadow.depth);
      G.uShadowOn.value = 1; G.uPass.value = 1;
      // shadowFix：画阴影图时先解绑它自己（否则所有材质的 uShadowMap 都指着正在写的深度图 → GL 判为反馈回路，
      // 拒绝这些绘制，阴影图永远是空的 —— 旧片就是在“没有角色投影”的状态下调的，所以默认保持旧行为）
      if (opt.shadowFix) G.uShadowMap.value = null;
      r.setRenderTarget(this.rtShadow);
      r.setClearColor(0xffffff, 1);
      r.clear(true, true, false);
      for (const root of opt.shadowRoots) { this._hide(root, 'noShadow'); r.render(root, this.shadowCam); this._show(root, 'noShadow'); }
      G.uShadowMap.value = this.rtShadow.depthTexture;
    } else G.uShadowOn.value = 0;

    // 2. 反射（uPass = 2：材质要丢弃水面以下的片元）
    const waterOn = opt.water !== false;
    if (waterOn) {
      this.updateReflection(cam);
      G.uPass.value = 2;
      r.setRenderTarget(this.rtRefl);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      this._hide(scene, 'noReflect'); r.render(scene, this.reflCam); this._show(scene, 'noReflect');
    }

    // 3. 主渲染 MRT
    G.uPass.value = 0;
    r.setRenderTarget(this.rtMain);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, cam);
    const data = this.rtMain.textures[1];

    // 4. 笔触
    const pu = this.mPaint.uniforms;
    pu.tColor.value = this.rtMain.textures[0]; pu.tData.value = data; pu.uRadius.value = opt.paintRadius ?? 4;
    this.pass(this.mPaint, this.rtA);
    // 5. 描线
    const ink = this.mInk.uniforms;
    ink.tColor.value = this.rtA.texture; ink.tData.value = data;
    ink.uSeed.value = opt.inkSeed ?? 0; ink.uWidth.value = opt.inkWidth ?? 1.15;
    this.pass(this.mInk, this.rtB);

    const invProj = cam.projectionMatrixInverse;
    // 6. 水面
    const w = this.mWater.uniforms;
    w.uOn.value = waterOn ? 1 : 0;
    w.tColor.value = this.rtB.texture; w.tData.value = data; w.tRefl.value = this.rtRefl.texture;
    w.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    w.uInvProj.value.copy(invProj); w.uCamWorld.value.copy(cam.matrixWorld); w.uReflMat.value.copy(this.reflMat);
    this.pass(this.mWater, this.rtA);
    // 7. 大气
    const a = this.mAtmos.uniforms;
    a.uWaterOn.value = waterOn ? 1 : 0;
    a.tColor.value = this.rtA.texture; a.tData.value = data;
    a.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    a.uInvProj.value.copy(invProj); a.uCamWorld.value.copy(cam.matrixWorld);
    const sp = this._v.copy(G.uSunDir.value).multiplyScalar(5000).add(a.uCamPos.value).project(cam);
    a.uSunUV.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    if (a.uShaftStyle.value > 0.5) {
      if (this.shaftAngle != null) a.uShaftDir.value.set(Math.sin(this.shaftAngle * Math.PI / 180), -Math.cos(this.shaftAngle * Math.PI / 180));
      else {
        const asp = this.W / this.H, dx = (0.5 - a.uSunUV.value.x) * asp, dy = -0.15 - a.uSunUV.value.y, l = Math.hypot(dx, dy) || 1;
        a.uShaftDir.value.set(dx / l, dy / l);
      }
    }
    this.pass(this.mAtmos, this.rtB);
    // 8. overlay：用场景相机直接画在 rtB 上（无深度缓冲，材质自己读 uSceneData 做软遮挡）
    if (overlay) {
      overlay.traverse((o) => {
        const m = o.material;
        if (m && m.uniforms && m.uniforms.uSceneData) { m.uniforms.uSceneData.value = data; m.uniforms.uRes.value.set(this.IW, this.IH); }
      });
      r.setRenderTarget(this.rtB);
      r.render(overlay, cam);
    }
    // 9. 泛光：亮度 > 1.05 的才发光（所以“自发光”材质要输出 > 1 的颜色）
    this.mBright.uniforms.tColor.value = this.rtB.texture;
    this.pass(this.mBright, this.rtBl[0]);
    const blur = (src, dst, dx, dy, tw, th) => { this.mBlur.uniforms.tColor.value = src.texture; this.mBlur.uniforms.uDir.value.set(dx / tw, dy / th); this.pass(this.mBlur, dst); };
    const [b0, b1, b2, b3] = this.rtBl;
    blur(b0, b1, 1, 0, b0.width, b0.height); blur(b1, b0, 0, 1, b0.width, b0.height);
    blur(b0, b2, 1, 0, b0.width, b0.height); blur(b2, b3, 0, 1, b2.width, b2.height);
    blur(b3, b2, 2, 0, b2.width, b2.height); blur(b2, b3, 0, 2, b2.width, b2.height);
    // 10. 调色输出
    const f = this.mFinal.uniforms;
    f.tColor.value = this.rtB.texture; f.tBloom1.value = b0.texture; f.tBloom2.value = b3.texture;
    f.uFrame.value = opt.frame ?? 0;
    f.uFade.value = opt.fade ?? 0;
    f.uFadeSoft.value = opt.fadeSoft ?? 0;
    if (opt.fadeColor) f.uFadeColor.value.set(opt.fadeColor);
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.W, this.H);
    this.quad.material = this.mFinal;
    r.render(this.quadScene, this.quadCam);
  }
}
