import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, Rng, hash, hr, clamp, lerp, invLerp, smooth, smoother, easeHeavy, heavyAct,
  onTwos, onThrees, drawing, onTwosFrom, track, noise1,
} from '../src/core/util.js';

const near = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('mulberry32: 相同种子相同序列，值域 [0,1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('Rng(1) 前三个输出（回归常量）', () => {
  const r = new Rng(1);
  assert.deepEqual([r.next(), r.next(), r.next()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
});

test('Rng 方法：range / int / pick / sign / gauss', () => {
  const r = new Rng(1);
  assert.equal(r.range(2, 5), 3.881221821764484);
  assert.equal(r.int(1, 6), 1);
  assert.equal(r.sign(), 1);
  near(r.gauss(), 0.7303809061564829);
  const q = new Rng(7);
  for (let i = 0; i < 500; i++) {
    const v = q.range(-3, 4); assert.ok(v >= -3 && v < 4);
    const n = q.int(2, 5); assert.ok(Number.isInteger(n) && n >= 2 && n <= 5);
    assert.ok([-1, 1].includes(q.sign()));
    assert.ok(['a', 'b', 'c'].includes(q.pick(['a', 'b', 'c'])));
  }
});

test('hash：确定性、值域 [0,1)、回归常量', () => {
  assert.equal(hash(1, 2, 3), 0.3689947403036058);
  assert.equal(hash(0), 0);
  assert.equal(hash(7, 0, 0), 0.3488377761095762);
  for (let i = 0; i < 2000; i++) {
    const h = hash(i, i * 3, -i);
    assert.equal(h, hash(i, i * 3, -i));
    assert.ok(h >= 0 && h < 1);
  }
  assert.equal(hr(1, 2, 3, 10, 20), 10 + 10 * hash(1, 2, 3));
});

test('clamp / lerp / invLerp', () => {
  assert.equal(clamp(-1), 0); assert.equal(clamp(2), 1); assert.equal(clamp(0.3), 0.3);
  assert.equal(clamp(5, 1, 3), 3);
  assert.equal(lerp(2, 6, 0), 2); assert.equal(lerp(2, 6, 1), 6); assert.equal(lerp(2, 6, 0.5), 4);
  assert.equal(invLerp(2, 6, 4), 0.5); assert.equal(invLerp(2, 6, 0), 0); assert.equal(invLerp(2, 6, 9), 1);
});

test('smooth / smoother / easeHeavy 端点与中点', () => {
  for (const f of [smooth, smoother, easeHeavy]) {
    assert.equal(f(0), 0); assert.equal(f(1), 1);
    assert.equal(f(-5), 0); assert.equal(f(5), 1);
    near(f(0.5), 0.5);
  }
});

test('heavyAct 无 prep/damp 时等于 easeHeavy', () => {
  for (const t of [-1, 0, 0.5, 1.3, 2, 3]) {
    assert.equal(heavyAct(t, [0, 2]), easeHeavy(t / 2));
  }
  assert.equal(heavyAct(5, [1, 3]), 1);
});

test('heavyAct prep / damp（回归常量）', () => {
  near(heavyAct(1, [0, 2], { prep: 0.1 }), 0.5);
  near(heavyAct(2.3, [0, 2], { damp: 0.05 }), 1.0113586986070153, 1e-9);
  assert.ok(heavyAct(0.3, [0, 2], { prep: 0.2 }) < easeHeavy(0.15));
});

test('onTwos / onThrees / drawing / onTwosFrom 量化', () => {
  assert.equal(onTwos(0), 0);
  assert.equal(onTwos(0.0833), 0);
  assert.equal(onTwos(1 / 12), 1 / 12);
  assert.equal(onTwos(0.1), 1 / 12);
  assert.equal(onTwos(1), 1);
  assert.equal(onThrees(0.124), 0);
  assert.equal(onThrees(0.125), 0.125);
  assert.equal(onThrees(0.2), 0.125);
  assert.equal(drawing(0.5), 4);
  assert.equal(drawing(0.5, 24), 12);
  assert.equal(onTwosFrom(0.1, 5), onTwos(0.1));
  assert.equal(onTwosFrom(5.05, 5), 5);
});

test('track 关键帧插值', () => {
  const k = [[0, 0], [1, 10], [3, 20]];
  assert.equal(track(k, -1), 0);
  assert.equal(track(k, 0.5), 5);
  assert.equal(track(k, 1), 10);
  assert.equal(track(k, 9), 20);
  assert.deepEqual(track([[0, [0, 0]], [2, [4, 8]]], 1), [2, 4]);
});

test('noise1 确定性且在 [-1,1]', () => {
  for (let i = 0; i < 200; i++) {
    const v = noise1(i * 0.37, 2);
    assert.equal(v, noise1(i * 0.37, 2));
    assert.ok(v >= -1 && v <= 1);
  }
  near(noise1(0.5, 1), -0.07600584434476332, 1e-9);
});
