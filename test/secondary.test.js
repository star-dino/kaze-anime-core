import test from 'node:test';
import assert from 'node:assert/strict';
import { Spring, SpringChain, lag, overshoot, integral, windDrive } from '../src/core/secondary.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('Spring：t0 之前返回驱动值，乱序查询结果一致', () => {
  const mk = () => new Spring((t) => (t > 1 ? 1 : 0), { freq: 2, zeta: 0.4 });
  assert.equal(mk().at(0), 0);
  near(mk().at(1.5), 0.9453444279331791);
  const s = mk();
  const fwd = [0.5, 1.2, 1.5, 2.5].map((t) => s.at(t));
  const rev = [2.5, 1.5, 1.2, 0.5].map((t) => s.at(t)).reverse();
  assert.deepEqual(fwd, rev);
  near(s.at(30), 1, 1e-3);
});

test('Spring 向量驱动返回数组', () => {
  const s = new Spring((t) => [t, 2 * t], { freq: 3 });
  const v = s.at(1);
  assert.ok(Array.isArray(v) && v.length === 2);
});

test('SpringChain：每节一个值，末端更软', () => {
  const c = new SpringChain((t) => Math.sin(t), 3, { freq: 2 });
  const a = c.at(2);
  assert.equal(a.length, 3);
  near(a[0], 0.9347980807708463, 1e-9);
  near(a[2], 0.991672784637292, 1e-9);
});

test('lag / overshoot', () => {
  assert.equal(lag((t) => t * 2, 1, 0.25), 1.5);
  assert.equal(overshoot(0.9, 1), 0);
  assert.equal(overshoot(1, 1), 0);
  near(overshoot(1.2, 1), -0.21623411014216998, 1e-9);
});

test('integral：对 1+t 积分查表', () => {
  const f = integral((t) => 1 + t, { t1: 10 });
  assert.equal(f(0), 0);
  near(f(4), 12, 1e-9);
  near(f(100), f(10));
  near(f(-5), 0);
});

test('windDrive：确定性，无阵风时 = k * W', () => {
  assert.equal(windDrive(() => 0.5, 10, { gust: 0 })(2), 5);
  near(windDrive(() => 0.5, 10, { seed: 3 })(2), 5.241864355098632, 1e-9);
});
