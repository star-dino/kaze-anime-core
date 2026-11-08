# 《<片名>》— 制片合同（CONTRACT）

> 用法：复制到新项目根目录，填满所有 `<…>`。所有部门 agent 开工前必须完整阅读本文件。
> 本模板的结构来自 Sunshower / LEVIATHAN 的 CONTRACT.md（见研究报告 08）。

## 0. 规格

一部 <时长> 秒、24 fps、1920×1040 的日式动画短片，用 anime-core（three.js r170 / WebGL2）在浏览器中渲染，
无头 Chrome 逐帧采集、ffmpeg 编码，最终交付为一个自包含 HTML（MP4 以 base64 内嵌）。

## 1. 美术指导（客户原话，照字面执行）

- **整体**：<例：明亮、高调的盛夏午后；干净饱和的颜色；闪光的阳光；没有浑浊的暗部。>
- **目标风格**：<例：手绘剧场版动画 —— 水粉绘画背景 + 带墨线的清爽赛璐璐角色。>
- **禁止**：不能看起来像 3D/CG、矢量图、网页动画、Minecraft 方块。不要塑料感高光、可见多边形、完美几何形、角色身上的软件缓动、持续的上下浮动。
- **颜色**：赛璐璐两阶硬色，暗部为冷薰衣草蓝（绝不用灰）；<天空/水/植被的颜色词>。
- **运动**：角色一拍二（`onTwos`）、水/能量特效一拍三；保持姿势、利落的重音；大的东西慢而有质量。关节自然，不折手腕，不滑步。
- **接触与尺度**：不能漂浮；接触和比例必须读得出。
- **被否决过的方向**：<每次客户否决都追加一条，写清楚否决的原因。>
- **情绪**：<例：温柔、明亮、怀旧、带一点幽默 —— 一部让人想重看、想分享的短片。>

## 2. 故事（一段话）

<从头到尾讲清楚。>

## 3. 设计

- **<角色 A>**（约 <尺寸> m）：<造型、配色、标志性细节、性格>。锚点：<head, handL, …>
- **<角色 B>**：…
- **<场景>**：…

## 4. 节拍（CUES，片秒；唯一时间真相，禁止在别处写死副本）

| 名字 | 时间 | 发生什么 |
|---|---|---|
| `fadeInEnd` | <s> | 淡入结束 |
| `<beat>` | <s> | … |

## 5. 镜头表

| # | 名字 | 时间 | 场景 set | 负责部门 | 画面内容 / 镜头运动 / 参考 |
|---|---|---|---|---|---|
| 1 | <name> | <a–b> | <set> | <dept> | <…> |

## 6. 世界布局与尺度（米）

- 水面 y = <0>；地面 <…>；<角色 A> 站在 <坐标>，**面朝 <-Z>**，它的左边是世界 <-X>。
- 太阳：仰角 <°>，方位角 <°>（0 = -Z，+ 朝 +X）。<为什么这样打光，例如“太阳在角色身后 → 逆光的雨会闪”>。
- 角色主光作弊：<方向>。
- 所有东西保持在相机 8000 m 以内（视深度 > 8000 视为天空）；远处用雾作弊。

## 7. 部门与文件所有权 —— 只能改你自己的文件

| 部门 | 拥有 |
|---|---|
| 导演（主会话） | `src/core/*`、`src/story/story.js`、`src/main.js`、`index.html`、`tools/*` |
| 环境 | `src/story/world*.js` |
| <角色 A> | `src/story/<hero>*.js` |
| 特效 | `src/story/fx*.js` |
| 声音 | `src/audio/*`、`audio.html` |

其他部门同时在改它们的文件。永远不要编辑、格式化或“修复”不属于你的文件；需要改动请写进你的最终报告。

## 8. 接口（别人可以依赖什么）

- 部门工厂：`export function createX(ctx) { return { update(st) {}, ...API }; }`，`update` 每帧调用一次、**帧顺序随机**。
- `ctx = { THREE, scene, overlay, engine, camera, G, CUES, SHOTS, FPS, shadowRoots, sky, story, <各部门> }`；部门更新顺序：<world, hero, fx>。
- `ctx.<hero>.rig.at(name, vec3)`：锚点世界坐标（`update` 内有效）。锚点清单：<…>。
- `ctx.world.terrain(x, z)`：地面高度。
- 水面：`engine.mWater.uniforms.uRip/uRipB`（8 个涟漪槽，由特效部门拥有），`uFxTime`（环境部门按一拍三设置）。
- 描线 id 分段：<角色 A> 1–59，<角色 B> 60–79，特效 80–99，不描线 100+。相邻零件 id 必须不同。

## 9. 引擎事实

- Pass 顺序：阴影 → 反射 → 主渲染 MRT → 笔触 → 描线 → 水面 → 大气 → overlay → 泛光 → 调色。
- 每个场景材质都写 `writeOut(color, a, viewNormal, viewDepth, id)`；id 0 绘画（笔触、不描线）、1–99 赛璐璐描线、100+ 赛璐璐不描线。
- 反射 pass `G.uPass = 2`：水面以下必须 discard。阴影 pass `G.uPass = 1`。
- 只有 `ctx.shadowRoots` 投影（画出来的光，不是物理）。
- overlay 特效遮挡模式：0 全测 / 1 只被角色遮挡（水面附近用这个）/ 2 不测；亮背景上的线条必须加 `rim`。
- 颜色约定：`THREE.Color('#hex')` 会被线性化，管线不做 sRGB 编码；所有部门统一按此调色。
- **一切都是 `st.t` 与 `CUES` 的纯函数**：随机只用 `hash()` / `Rng`，禁止 `Math.random`、禁止跨帧累积状态。`npm run determinism` 必须通过。
- 性能预算：GPU 上 scale 2 每帧 < <0.4> s。不在画面里的组设 `visible = false`。

## 10. 运行与检查

```bash
node tools/check.mjs 60                                    # 必须零报错
node tools/snap.mjs --scale 1 --out out/<部门> --sheet review s:<镜头> t:<秒> f:<帧>
node tools/snap.mjs --scale 1 --out out/<部门> "q:test=1&cam=x,y,z&at=x,y,z&fov=35&t=10=name:mytest"
# 跳过部门定位问题：&world=0 &fx=0 &<hero>=0
```

**每次修改都出静帧，用 Read 工具打开 JPG，严格评判。** 把当前最好的静帧存到 `out/<部门>/latest/`：客户要看进度。
