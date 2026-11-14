// NTP 방식 시계 동기화.
// 멤버가 ping(a=로컬 송신시각) → 방장이 b(방장 시각)로 응답 → 멤버가 c(로컬 수신시각)에 받음.
// offset = 방장시각 - 로컬시각 ≈ b - (a+c)/2, 오차 상한 = rtt/2.
// 네트워크 지연이 들쭉날쭉하므로 RTT가 가장 짧은 샘플들만 골라서 그 중앙값을 쓴다.

export class ClockSync {
  constructor({ windowSize = 40, minSamples = 8 } = {}) {
    this.windowSize = windowSize;
    this.minSamples = minSamples;
    this.samples = [];
    this.offset = 0;
    this.error = Infinity;
    this.minRtt = Infinity;
  }

  /** a: 로컬 송신, b: 방장 시각, c: 로컬 수신 (모두 ms) */
  addSample(a, b, c) {
    const rtt = c - a;
    if (!(rtt >= 0) || !Number.isFinite(b)) return;
    this.samples.push({ rtt, offset: b - (a + c) / 2 });
    if (this.samples.length > this.windowSize) this.samples.shift();
    this._recompute();
  }

  _recompute() {
    const byRtt = [...this.samples].sort((x, y) => x.rtt - y.rtt);
    const k = Math.max(1, Math.ceil(byRtt.length * 0.25));
    const best = byRtt.slice(0, k).map((s) => s.offset).sort((x, y) => x - y);
    this.offset = best[Math.floor(best.length / 2)];
    this.minRtt = byRtt[0].rtt;
    this.error = this.minRtt / 2;
  }

  get ready() {
    return this.samples.length >= this.minSamples;
  }

  reset() {
    this.samples = [];
    this.offset = 0;
    this.error = Infinity;
    this.minRtt = Infinity;
  }

  toRemote(localMs) {
    return localMs + this.offset;
  }

  toLocal(remoteMs) {
    return remoteMs - this.offset;
  }
}

/** 방장 자신은 자기 시계가 기준이다. */
export const identityClock = {
  ready: true,
  error: 0,
  offset: 0,
  toRemote: (t) => t,
  toLocal: (t) => t,
};
