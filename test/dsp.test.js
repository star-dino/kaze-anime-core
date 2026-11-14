import test from 'node:test';
import assert from 'node:assert/strict';
import { SR, TAU, mtof, nm, dbToGain, panGains, Bus, encodeWav } from '../src/audio/dsp.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

test('常量', () => {
  assert.equal(SR, 48000);
  assert.equal(TAU, Math.PI * 2);
});

test('mtof：A4 = 440，八度翻倍', () => {
  assert.equal(mtof(69), 440);
  near(mtof(60), 261.6255653005986);
  near(mtof(81) / mtof(69), 2);
});

test('nm：音名 → MIDI', () => {
  assert.equal(nm('A4'), 69);
  assert.equal(nm('C4'), 60);
  assert.equal(nm('Bb4'), 70);
  assert.equal(nm('F#3'), 54);
  assert.equal(nm(61), 61);
  assert.throws(() => nm('H4'));
});

test('dbToGain / panGains', () => {
  assert.equal(dbToGain(0), 1);
  near(dbToGain(-6), 0.5011872336272722);
  assert.deepEqual(panGains(-1), [1, 0]);
  near(panGains(0)[0], Math.SQRT1_2);
  near(panGains(1)[1], 1);
});

test('Bus 与 encodeWav：确定性、RIFF 头', () => {
  const b = new Bus(4);
  assert.equal(b.L.length, 4);
  assert.equal(b.R.length, 4);
  const mk = () => encodeWav([new Float32Array([0, 0.5, -0.5, 1]), new Float32Array([0, 0.25, -0.25, -1])]);
  const w1 = Buffer.from(mk()), w2 = Buffer.from(mk());
  assert.ok(w1.equals(w2));
  assert.equal(w1.toString('latin1', 0, 4), 'RIFF');
  assert.equal(w1.toString('latin1', 8, 12), 'WAVE');
});
