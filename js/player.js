// Web Audio로 "방장 시계 기준 시각"에 정확히 소리가 귀에 도달하도록 재생한다.
//
// 시간축 3개:
//   방장 시각(hostMs)  --clock.toLocal-->  로컬 performance.now(ms)  --perfToCtx-->  AudioContext 시각(s)
// perfToCtx는 출력 지연(getOutputTimestamp)과 사용자 지연 보정(블루투스 등)까지 반영해서
// "이 ctx 시각에 렌더링하면 그 perf 시각에 귀에 들린다"가 되도록 맞춘다.
//
// 재생 중에는 기대 위치와 실제 위치를 계속 비교해서 playbackRate를 ±0.3% 이내로 살짝 조절해 따라잡는다
// (약 5센트, 귀로 거의 구분 불가). 35ms 넘게 어긋나면 그 자리에서 다시 시작한다.

const MAP_WINDOW = 25;
const HARD_RESYNC_S = 0.035;
const DEADBAND_S = 0.0015;
const MAX_RATE_DELTA = 0.003;

export class SyncPlayer {
  constructor(clock) {
    this.clock = clock;
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.src = null;
    this.anchor = null;
    this.userLatencyMs = 0; // +값이면 "내 소리가 늦게 들린다" → 그만큼 일찍 재생
    this.st = { mode: 'stopped', pos: 0 };
    this.lastErrMs = 0;
    this.clicksOn = false;
    this._lastClickK = -Infinity;
    this._map = null;
    this._mapSamples = [];
    this._timer = null;
  }

  setClock(clock) {
    this.clock = clock;
  }

  /** 반드시 사용자 탭(click) 핸들러 안에서 동기적으로 먼저 호출할 것 (iOS 자동재생 정책). */
  unlock() {
    try {
      // iOS 17+: 무음 스위치가 켜져 있어도 미디어 채널로 재생
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    const p = this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve();
    const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = silent;
    s.connect(this.ctx.destination);
    s.start();
    if (!this._timer) this._timer = setInterval(() => this._tick(), 200);
    return p.catch(() => {});
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  decode(arrayBuffer) {
    const copy = arrayBuffer.slice(0);
    return new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(copy, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  setBuffer(buffer) {
    this.stop(0);
    this.buffer = buffer;
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = v;
  }

  setLatency(ms) {
    this.userLatencyMs = ms;
  }

  // ---------- 시간 변환 ----------

  _sampleMap() {
    const ctx = this.ctx;
    let d = null;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
        d = ts.contextTime - ts.performanceTime / 1000;
      }
    }
    if (d === null) {
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      d = ctx.currentTime - performance.now() / 1000 - lat;
    }
    this._mapSamples.push(d);
    if (this._mapSamples.length > MAP_WINDOW) this._mapSamples.shift();
    const sorted = [...this._mapSamples].sort((a, b) => a - b);
    this._map = sorted[Math.floor(sorted.length / 2)];
    return this._map;
  }

  /** 로컬 perf ms에 귀에 들리게 하려면 렌더링해야 할 ctx 시각(s) */
  perfToCtx(perfMs) {
    if (this._map === null) this._sampleMap();
    return (perfMs - this.userLatencyMs) / 1000 + this._map;
  }

  /** 방장 시각 → ctx 시각 */
  hostToCtx(hostMs) {
    return this.perfToCtx(this.clock.toLocal(hostMs));
  }

  // ---------- 재생 ----------

  /** pos0초 지점이 방장 시각 hostT0에 들리도록 재생 */
  play(pos0, hostT0) {
    if (this.st.mode === 'playing' && this.st.pos0 === pos0 && this.st.hostT0 === hostT0 && this.src) return;
    this.st = { mode: 'playing', pos0, hostT0 };
    for (let i = 0; i < 5; i++) this._sampleMap();
    this._schedule();
  }

  stop(pos = 0) {
    this._killSrc();
    this.st = { mode: 'stopped', pos };
  }

  _killSrc() {
    if (!this.src) return;
    try {
      this.src.stop();
    } catch {}
    this.src.disconnect();
    this.src = null;
    this.anchor = null;
  }

  _t0Ctx() {
    return this.hostToCtx(this.st.hostT0);
  }

  _expectedPos(c) {
    return this.st.pos0 + (c - this._t0Ctx());
  }

  _actualPos(c) {
    const a = this.anchor;
    return a.pos + (c - a.ctx) * a.rate;
  }

  _schedule() {
    this._killSrc();
    if (!this.buffer || !this.ctx || this.st.mode !== 'playing') return;
    const earliest = this.ctx.currentTime + 0.03;
    let when = this._t0Ctx();
    let pos = this.st.pos0;
    if (pos < 0) {
      when += -pos;
      pos = 0;
    }
    if (when < earliest) {
      pos += earliest - when; // 늦게 합류했거나 늦게 받은 경우: 지금 있어야 할 위치부터
      when = earliest;
    }
    if (pos >= this.buffer.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.start(when, pos);
    this.src = src;
    this.anchor = { ctx: when, pos, rate: 1 };
  }

  _tick() {
    if (!this.ctx) return;
    this._sampleMap();
    this._clicks();
    if (this.st.mode !== 'playing' || !this.src || !this.anchor) return;

    const c = this.ctx.currentTime;
    const a = this.anchor;
    if (c < a.ctx) {
      // 아직 시작 전: 시계 추정이 바뀌었으면 소리 나기 전에 조용히 재예약
      const want = this._t0Ctx() + (a.pos - this.st.pos0);
      if (Math.abs(want - a.ctx) > 0.002 && want > c + 0.03) this._schedule();
      return;
    }

    const err = this._expectedPos(c) - this._actualPos(c); // +면 내가 뒤처짐
    this.lastErrMs = err * 1000;
    if (Math.abs(err) > HARD_RESYNC_S) {
      this._schedule();
      return;
    }
    let rate = 1;
    if (Math.abs(err) > DEADBAND_S) {
      rate = 1 + Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, err * 0.6));
    }
    if (rate !== a.rate) {
      this.anchor = { ctx: c, pos: this._actualPos(c), rate };
      this.src.playbackRate.setValueAtTime(rate, c);
    }
  }

  // ---------- 클릭 테스트 (방장 시계 0.5초 격자에 맞춘 딸깍 소리) ----------

  setClicks(on) {
    this.clicksOn = on;
    this._lastClickK = -Infinity;
  }

  _clicks() {
    if (!this.clicksOn || !this.clock.ready) return;
    const INTERVAL = 500;
    const nowHost = this.clock.toRemote(performance.now());
    let k = Math.max(this._lastClickK + 1, Math.ceil((nowHost + 50) / INTERVAL));
    for (; k * INTERVAL <= nowHost + 1000; k++) {
      const when = this.hostToCtx(k * INTERVAL);
      this._lastClickK = k;
      if (when < this.ctx.currentTime + 0.01) continue;
      this._beep(when, k % 4 === 0 ? 1760 : 880);
    }
  }

  _beep(when, freq) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.8, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(g).connect(this.gain);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}

/** 테스트 음원: 120BPM 클릭 + 마디마다 높은 음, 길이 sec초짜리 WAV ArrayBuffer */
export function makeTestTrack(sec = 90, sampleRate = 44100) {
  const n = sec * sampleRate;
  const data = new Int16Array(n);
  const beat = sampleRate / 2;
  for (let b = 0; b * beat < n; b++) {
    const start = Math.floor(b * beat);
    const freq = b % 4 === 0 ? 1320 : 660;
    const len = Math.floor(sampleRate * 0.06);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp(-i / (sampleRate * 0.012));
      data[start + i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * env * 26000);
    }
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(data);
  return buf;
}
