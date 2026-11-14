// 유튜브 모드: YouTube IFrame 플레이어를 방장 시계에 맞춰 재생한다.
//
// 파일 모드(Web Audio)와 달리 유튜브 플레이어는
//  - 재생 시작 시점이 버퍼링에 따라 들쭉날쭉하고
//  - 현재 위치를 postMessage로 늦게/거칠게 알려 주고
//  - 재생 속도를 0.25 단위로만 바꿀 수 있다.
// 그래서 "대충 맞춘 뒤 계속 측정해서 짧게 빨리/느리게 감기"로 맞춘다. 목표 정확도는 수십 ms.

const API_SRC = 'https://www.youtube.com/iframe_api';
const TICK_MS = 200;
const READINGS = 5;
const DEADBAND_S = 0.02;
const HARD_SEEK_S = 1.0;

let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = API_SRC;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('유튜브를 불러오지 못했어요.'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

/** 유튜브 링크(또는 11자리 ID)에서 영상 ID 추출. 실패하면 null */
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export class YouTubeSync {
  /**
   * @param {HTMLElement} el 플레이어를 넣을 자리
   * @param {object} opts.clock 방장 시계 변환 ({toRemote})
   * @param {() => number} opts.leadS 얼마나 앞당겨 재생할지(초): 사용자 지연 보정 + 출력 지연
   */
  constructor(el, { clock, leadS }) {
    this.el = el;
    this.clock = clock;
    this.leadS = leadS;
    this.yt = null;
    this.videoId = null;
    this.ready = false;
    this.primed = false; // 사용자가 영상을 한 번 재생해 줘야(iOS 등) 이후 원격 재생이 허용된다
    this.st = { mode: 'stopped', pos: 0 };
    this.readings = [];
    this.nudgeUntil = 0;
    this.lastErrMs = 0;
    this.volume = 100;
    this.onChange = () => {};
    this._startTimer = null;
    setInterval(() => this._tick(), TICK_MS);
  }

  setClock(clock) {
    this.clock = clock;
  }

  async load(videoId) {
    await loadApi();
    this.stop(0);
    this.ready = false;
    this.videoId = videoId;
    if (this.yt) {
      this.yt.destroy();
      this.yt = null;
    }
    const holder = document.createElement('div');
    this.el.replaceChildren(holder);
    return new Promise((resolve, reject) => {
      this.yt = new YT.Player(holder, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, disablekb: 1, fs: 0, iv_load_policy: 3 },
        events: {
          onReady: () => {
            this.ready = true;
            this.yt.setVolume(this.volume);
            const data = this.yt.getVideoData?.() || {};
            resolve({ duration: this.yt.getDuration(), title: data.title || '유튜브 영상' });
            this.onChange();
          },
          onStateChange: (e) => this._onState(e.data),
          onError: (e) => reject(new Error(e.data === 101 || e.data === 150 ? '이 영상은 다른 사이트에서 재생할 수 없게 막혀 있어요.' : '유튜브 영상을 불러오지 못했어요.')),
        },
      });
    });
  }

  unload() {
    this.stop(0);
    this.yt?.destroy();
    this.yt = null;
    this.videoId = null;
    this.ready = false;
    this.el.replaceChildren();
  }

  setVolume(v01) {
    this.volume = Math.round(v01 * 100);
    if (this.ready) this.yt.setVolume(this.volume);
  }

  _onState(s) {
    if (s === YT.PlayerState.PLAYING && !this.primed) {
      this.primed = true;
      this.onChange();
    }
    // 사용자가 영상 안에서 직접 재생/정지해도 방 상태가 기준
    if (s === YT.PlayerState.PLAYING && this.st.mode !== 'playing') this._park(this.st.pos || 0);
  }

  play(pos0, hostT0) {
    if (this.st.mode === 'playing' && this.st.pos0 === pos0 && this.st.hostT0 === hostT0) return;
    this.st = { mode: 'playing', pos0, hostT0 };
    this.readings = [];
    this.nudgeUntil = 0;
    clearTimeout(this._startTimer);
    this._startTimer = null;
    if (this.ready) {
      // 시작 전에 미리 그 위치로 가서 버퍼링해 둔다
      if (this._target() < 0) this._park(pos0);
    }
  }

  stop(pos = 0) {
    clearTimeout(this._startTimer);
    this._startTimer = null;
    this.st = { mode: 'stopped', pos };
    if (this.ready) this._park(pos);
  }

  /** 멈춘 채로 pos에 대기. 시작 전(UNSTARTED/CUED) 상태에서 seekTo를 부르면 재생돼 버리므로 cue로 처리 */
  _park(pos) {
    const yt = this.yt;
    yt.setPlaybackRate(1);
    const s = yt.getPlayerState();
    if (s === YT.PlayerState.UNSTARTED || s === YT.PlayerState.CUED) {
      if (pos > 0.5) yt.cueVideoById({ videoId: this.videoId, startSeconds: pos });
      return;
    }
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) yt.pauseVideo();
    if (Math.abs(yt.getCurrentTime() - pos) > 0.05) yt.seekTo(pos, true);
  }

  /** 지금 영상이 있어야 할 위치(초). 음수면 아직 시작 전 */
  _target() {
    const hostNow = this.clock.toRemote(performance.now());
    return this.st.pos0 + (hostNow - this.st.hostT0) / 1000 + this.leadS();
  }

  _tick() {
    if (!this.ready || this.st.mode !== 'playing') return;
    const yt = this.yt;
    const state = yt.getPlayerState();
    const target = this._target();
    const dur = yt.getDuration();

    if (target >= dur) {
      if (state === YT.PlayerState.PLAYING) yt.pauseVideo();
      return;
    }

    if (target < 0) {
      // 시작 직전이면 정확한 순간에 재생하도록 타이머 예약
      if (target > -(TICK_MS * 2) / 1000 && !this._startTimer) {
        this._startTimer = setTimeout(() => {
          this._startTimer = null;
          if (this.st.mode === 'playing') yt.playVideo();
        }, Math.max(0, -target * 1000));
      }
      return;
    }

    if (state !== YT.PlayerState.PLAYING) {
      if (state === YT.PlayerState.BUFFERING || this._startTimer) return;
      // 늦게 받았거나 멈춰 있으면: 조금 앞에서 시작(시크+재생 준비 시간 감안)
      yt.seekTo(Math.max(0, target + 0.25), true);
      yt.playVideo();
      this.readings = [];
      this.nudgeUntil = performance.now() + 1200;
      return;
    }

    if (performance.now() < this.nudgeUntil) return;
    this.readings.push(target - yt.getCurrentTime());
    if (this.readings.length > READINGS) this.readings.shift();
    if (this.readings.length < READINGS) return;

    const err = median(this.readings); // +면 내가 뒤처짐
    this.lastErrMs = err * 1000;
    if (Math.abs(err) > HARD_SEEK_S) {
      yt.seekTo(target + 0.2, true);
      this.readings = [];
      this.nudgeUntil = performance.now() + 1500;
    } else if (Math.abs(err) > DEADBAND_S) {
      // 0.25배속 차이로 |err|/0.25 초 동안 빨리/느리게 감아서 따라잡기
      const rate = err > 0 ? 1.25 : 0.75;
      const ms = (Math.abs(err) / 0.25) * 1000;
      yt.setPlaybackRate(rate);
      setTimeout(() => this.ready && yt.setPlaybackRate(1), ms);
      this.readings = [];
      this.nudgeUntil = performance.now() + ms + 800;
    }
  }
}
