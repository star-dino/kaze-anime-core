// 角色设定图（model sheet）：转面图 + 表情表，一条命令出一张联系表。
// 造型是代码写的，改完必须“看一眼”—— 这个工具把每次都要手算的自由机位固定下来：
//   node tools/turnaround.mjs --at 0,5.92,-4 --facing 180 --height 3.7 \
//        --query "pose=rest" --exprs open,closed,happy,squint --mouth happy=1,squint=0.6 --sheet dino
//   --at       角色根节点（脚底）在世界里的位置
//   --facing   角色正面朝向（度，绕 Y；0 = 朝 +Z，180 = 朝 -Z）
//   --height   角色身高（米）：决定机位距离
//   --head     头部中心高度（相对脚底，米；默认 0.82 × height）—— 表情特写对准这里
//   --views    front,q3,side,back,top3（默认前四个）
//   --exprs    表情特写，依次把 expr=<名字> 传给页面（角色部门从 ctx.params 读）
//   --mouth    每个表情配的 mouth 参数，如 happy=1,squint=0.6
//   --query    额外的 URL 参数（默认 pose=rest：静止姿态）
//   --t        用哪一帧的布景/天气（秒，默认 1.5）
//   --light    front（默认：主光从镜头侧上方打，看清造型）| film（用镜头本来的光）
//   --out / --sheet / --scale   同 snap.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, FILM, filmOut } from './env.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
const num3 = (s) => s.split(',').map(Number);
const at = num3(A.at ?? '0,0,0');
const facing = ((parseFloat(A.facing ?? '0')) * Math.PI) / 180;
const H = parseFloat(A.height ?? '2');
const headY = parseFloat(A.head ?? String(0.82 * H));
const views = (A.views ?? 'front,q3,side,back').split(',').filter(Boolean);
const exprs = (A.exprs ?? '').split(',').filter(Boolean);
const mouth = Object.fromEntries((A.mouth ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')));
const extra = A.query ?? 'pose=rest';
const t = A.t ?? '1.5';
const fov = 28;
const dist = (H * 0.62) / Math.tan((fov * Math.PI) / 360) + H * 0.3;

const f = (x) => x.toFixed(3);
// 角色正面方向 → 世界方向；ang 是相对正面的方位（度，+ = 角色的左侧）
function camAt(angDeg, d, yOff, lookY) {
  const a = facing + (angDeg * Math.PI) / 180;
  const p = [at[0] + Math.sin(a) * d, at[1] + yOff, at[2] + Math.cos(a) * d];
  return `cam=${p.map(f).join(',')}&at=${f(at[0])},${f(at[1] + lookY)},${f(at[2])}`;
}
// 正面打光：太阳从镜头那侧偏左上来（look 的 az：0 = 从 -Z 方向照来，+ 朝 +X）
function lightFor(angDeg) {
  if (A.light === 'film') return '';
  const a = facing + ((angDeg - 35) * Math.PI) / 180;      // 镜头左上方
  const az = (Math.atan2(Math.sin(a), -Math.cos(a)) * 180) / Math.PI;
  return `&az=${az.toFixed(1)}&elev=38`;
}
const VIEW = { front: [0, 0.05], q3: [-35, 0.12], side: [-90, 0.05], back: [160, 0.2], top3: [-30, 0.55] };
const specs = [];
for (const v of views) {
  const [ang, yk] = VIEW[v] ?? [0, 0.05];
  specs.push(`q:test=1&t=${t}&fov=${fov}&${extra}&${camAt(ang, dist, H * (0.5 + yk), H * 0.48)}${lightFor(ang)}=name:${A.sheet ?? 'model'}_${v}`);
}
for (const e of exprs) {
  const m = mouth[e] != null ? `&mouth=${mouth[e]}` : '';
  specs.push(`q:test=1&t=${t}&fov=20&${extra}&expr=${e}${m}&${camAt(-22, H * 1.7, headY + H * 0.04, headY)}${lightFor(-22)}=name:${A.sheet ?? 'model'}_${e}`);
}
const outDir = A.out ?? path.join(filmOut(A.name ?? FILM), 'model');
const args = ['tools/snap.mjs', '--scale', A.scale ?? '1', '--name', A.name ?? FILM, '--out', outDir, '--sheet', A.sheet ?? 'model', ...specs];
const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
console.log('sheet:', path.join(outDir, (A.sheet ?? 'model') + '.jpg'));
process.exitCode = r.status ?? 1;
