#!/usr/bin/env python3
# 参考图 vs 渲染 对比图：左边参考、右边一张或多张渲染，统一高度并排，顶上写文件名。
#   python3 tools/compare.py <输出.jpg> <参考图> <渲染1.jpg> [渲染2.jpg ...] [--h 540]
# 例：python3 tools/compare.py out/cape-keeper/flower/cmp_k3.jpg ../参考/cape-keeper/keyframes/k3_flower.png out/cape-keeper/flower/bud.jpg out/cape-keeper/flower/bloom.jpg
import sys
from PIL import Image, ImageDraw

args = sys.argv[1:]
h = 540
if '--h' in args:
    i = args.index('--h'); h = int(args[i + 1]); del args[i:i + 2]
if len(args) < 3:
    sys.exit(__doc__ or 'usage: compare.py out ref render...')
out, paths = args[0], args[1:]
tiles = []
for p in paths:
    im = Image.open(p).convert('RGB')
    im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    label = ('REF  ' if p == paths[0] else '') + p.split('/')[-1]
    d.rectangle([0, 0, 8 + 7 * len(label), 18], fill=(0, 0, 0))
    d.text((4, 3), label, fill=(255, 255, 255))
    tiles.append(im)
W = sum(t.width for t in tiles) + 6 * (len(tiles) - 1)
sheet = Image.new('RGB', (W, h), (20, 20, 24))
x = 0
for t in tiles:
    sheet.paste(t, (x, 0)); x += t.width + 6
sheet.save(out, quality=90)
print(out, sheet.size)
