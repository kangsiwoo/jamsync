import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../js/clock.js';

// 가짜 네트워크: 방장 시계 = 로컬 + TRUE_OFFSET, 편도 지연은 기본값 + 지터(가끔 큰 스파이크, 비대칭)
function simulate({ trueOffset, base, jitter, spikeProb, n, seed = 1 }) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const c = new ClockSync();
  let t = 1000;
  for (let i = 0; i < n; i++) {
    const up = base + rnd() * jitter + (rnd() < spikeProb ? 200 * rnd() : 0);
    const down = base + rnd() * jitter * 1.5 + (rnd() < spikeProb ? 300 * rnd() : 0);
    const a = t;
    const b = a + up + trueOffset;
    const cc = a + up + down;
    c.addSample(a, b, cc);
    t += 1000;
  }
  return c;
}

test('같은 와이파이 수준 (편도 3ms, 지터 5ms)', () => {
  const c = simulate({ trueOffset: 12345.6, base: 3, jitter: 5, spikeProb: 0.1, n: 40 });
  assert.ok(c.ready);
  assert.ok(Math.abs(c.offset - 12345.6) < 3, `offset err ${c.offset - 12345.6}`);
});

test('셀룰러+TURN 수준 (편도 60ms, 지터 40ms, 스파이크 많음)', () => {
  const c = simulate({ trueOffset: -98765.4, base: 60, jitter: 40, spikeProb: 0.3, n: 40 });
  const err = Math.abs(c.offset + 98765.4);
  assert.ok(err < 15, `offset err ${err}`);
  assert.ok(err <= c.error, '실제 오차는 보고된 상한 이내');
});

test('변환이 서로 역함수', () => {
  const c = simulate({ trueOffset: 500, base: 5, jitter: 2, spikeProb: 0, n: 10 });
  assert.equal(c.toLocal(c.toRemote(42)), 42);
});

test('샘플이 부족하면 ready가 아님', () => {
  const c = new ClockSync();
  c.addSample(0, 10, 4);
  assert.equal(c.ready, false);
});
