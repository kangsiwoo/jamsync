import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTapLatency } from '../js/player.js';
import { parseYouTubeId } from '../js/ytplayer.js';

const clicks = Array.from({ length: 20 }, (_, i) => 1000 + i * 600);
function taps(latency, jitter, { seed = 987654321, miss = [] } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  return clicks.filter((_, i) => !miss.includes(i)).map((c) => c + latency + rnd() * 2 * jitter);
}

test('블루투스 지연 200ms를 탭으로 추정', () => {
  const r = estimateTapLatency(clicks, taps(200, 30));
  assert.ok(Math.abs(r.latencyMs - 200) <= 15, JSON.stringify(r));
});

test('유선 이어폰(지연 거의 0)', () => {
  const r = estimateTapLatency(clicks, taps(5, 20));
  assert.ok(Math.abs(r.latencyMs) <= 15, JSON.stringify(r));
});

test('엉뚱한 탭 몇 개는 무시', () => {
  const t = taps(150, 20);
  t.push(clicks[10] - 280, clicks[12] + 290);
  const r = estimateTapLatency(clicks, t);
  assert.ok(Math.abs(r.latencyMs - 150) <= 15, JSON.stringify(r));
});

test('탭이 너무 적으면 null', () => {
  assert.equal(estimateTapLatency(clicks, taps(100, 10).slice(0, 7)), null);
});

test('유튜브 링크 파싱', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    `https://www.youtube.com/watch?v=${id}&t=30s`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=x`,
    `https://www.youtube.com/shorts/${id}`,
    `youtube.com/embed/${id}`,
    id,
  ]) assert.equal(parseYouTubeId(u), id, u);
  assert.equal(parseYouTubeId('https://example.com/watch?v=x'), null);
});
