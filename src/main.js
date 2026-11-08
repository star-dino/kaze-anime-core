// 入口：把故事交给运行时。
//   默认加载示例故事 src/story/story.js；?story=<名字> 加载 src/films/<名字>/story.js（新片不用改这个文件）。
//   工具链透传：node tools/snap.mjs "q:story=cape-keeper&t=3" …；渲染/检查用环境变量 STORY=<名字>。
import { boot } from './core/runtime.js';

const name = new URLSearchParams(location.search).get('story');
const story = name ? (await import(`./films/${name}/story.js`)).default : (await import('./story/story.js')).default;
await boot(story, document.getElementById('c'));
