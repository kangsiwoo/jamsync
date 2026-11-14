// PeerJS(WebRTC) 기반 P2P 방.
// - 시그널링(처음 서로 찾는 과정)만 PeerJS 공개 서버를 쓰고, 이후 데이터는 폰끼리 직접 오간다.
// - 셀룰러끼리처럼 직접 연결이 안 되는 NAT이면 PeerJS 기본 TURN 서버로 자동 중계된다.
// - 방장(host)이 별 모양 중심. 멤버마다 연결 2개:
//     ctrl: 신뢰/순서 보장, 바이너리 — 파일 전송, 멤버 목록, 명령
//     sync: JSON, 작은 메시지만 — 시계 ping/pong, 재생 상태 (파일 전송에 밀리지 않도록 분리)

import { CONFIG } from './config.js';

const PREFIX = 'jamsync-v1-';
const CHUNK = 15000; // PeerJS 내부 분할(약 16KB) 아래로
const HIGH_WATER = 128 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Emitter {
  constructor() {
    this._h = {};
  }
  on(e, f) {
    (this._h[e] ??= []).push(f);
    return this;
  }
  emit(e, ...a) {
    (this._h[e] || []).forEach((f) => f(...a));
  }
}

let iceCache = null;
async function iceServers() {
  if (iceCache) return iceCache;
  const list = [{ urls: CONFIG.stun }, ...CONFIG.turnServers];
  if (CONFIG.turnCredentialsUrl) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(CONFIG.turnCredentialsUrl, { signal: ctl.signal });
      clearTimeout(t);
      const servers = await res.json();
      if (Array.isArray(servers)) list.push(...servers.filter((s) => String(s.urls).includes('turn')));
    } catch (e) {
      console.warn('TURN 자격증명을 못 받았어요', e);
    }
  }
  iceCache = list;
  return list;
}

export const hasTurn = () => CONFIG.turnServers.length > 0 || !!CONFIG.turnCredentialsUrl;

async function peerOptions() {
  return { debug: 1, config: { iceServers: await iceServers() } };
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function noRouteMsg() {
  return hasTurn()
    ? '방장 폰과 연결하지 못했어요. 방장 폰이 켜져 있는지, 인터넷이 되는지 확인하세요.'
    : '방장 폰과 직접 연결하지 못했어요. 셀룰러끼리는 중계(TURN) 서버가 필요해요 — 같은 와이파이로 바꾸거나 js/config.js에 TURN을 설정하세요.';
}

function buffered(conn) {
  return (conn.dataChannel?.bufferedAmount || 0) + (conn.bufferSize || 0);
}

function humanError(e) {
  switch (e?.type) {
    case 'peer-unavailable':
      return '방을 찾을 수 없어요. 코드를 확인하세요.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return '연결 서버에 닿지 않아요. 인터넷 연결을 확인하세요.';
    case 'browser-incompatible':
      return '이 브라우저는 WebRTC를 지원하지 않아요.';
    default:
      return e?.message || String(e);
  }
}

export class HostRoom extends Emitter {
  constructor(name) {
    super();
    this.name = name;
    this.isHost = true;
    this.members = new Map(); // peerId -> { id, name, ctrl, sync, status }
    this.closed = false;
  }

  async start() {
    const opts = await peerOptions();
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const code = randomCode();
        const peer = new Peer(PREFIX + code, opts);
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer;
          this.code = code;
          peer.on('connection', (c) => this._onConn(c));
          resolve(code);
        });
        peer.on('disconnected', () => {
          // 시그널링 서버와 끊겨도 기존 P2P 연결은 유지됨. 새 멤버를 받기 위해 재접속.
          if (!this.closed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500);
        });
        peer.on('error', (e) => {
          if (!opened) {
            peer.destroy();
            if (e.type === 'unavailable-id' && n < 5) attempt(n + 1);
            else reject(new Error(humanError(e)));
          } else if (e.type !== 'peer-unavailable') {
            this.emit('warn', humanError(e));
          }
        });
      };
      attempt(0);
    });
  }

  _member(conn) {
    let m = this.members.get(conn.peer);
    if (!m) {
      m = { id: conn.peer, name: conn.metadata?.name || '멤버', status: {} };
      this.members.set(conn.peer, m);
    }
    return m;
  }

  _onConn(conn) {
    const m = this._member(conn);
    if (conn.label === 'sync') {
      m.sync?.close();
      m.sync = conn;
      conn.on('data', (d) => {
        if (d && d.t === 'p') conn.send({ t: 'q', a: d.a, b: performance.now() });
      });
    } else {
      m.ctrl?.close();
      m.ctrl = conn;
      conn.on('open', () => this.emit('join', m));
      conn.on('data', (d) => this.emit('message', m, d));
      conn.on('close', () => {
        if (m.ctrl !== conn) return;
        m.xfer = null;
        m.sync?.close();
        this.members.delete(m.id);
        this.emit('leave', m);
      });
    }
    conn.on('error', (e) => console.warn('conn error', m.name, e));
  }

  send(m, msg) {
    if (m.ctrl?.open) m.ctrl.send(msg);
  }

  broadcast(msg) {
    for (const m of this.members.values()) this.send(m, msg);
  }

  /** 재생 상태는 sync 채널(빠름)과 ctrl 채널(보험) 양쪽으로. 멤버는 seq로 중복 제거. */
  broadcastState(state) {
    for (const m of this.members.values()) {
      if (m.sync?.open) m.sync.send({ t: 'state', state });
      this.send(m, { t: 'state', state });
    }
  }

  async sendFile(m, file, onProgress) {
    const conn = m.ctrl;
    if (!conn?.open) return;
    const token = {};
    m.xfer = token;
    const buf = file.buf;
    const chunks = Math.ceil(buf.byteLength / CHUNK);
    conn.send({ t: 'file-meta', id: file.id, name: file.name, size: buf.byteLength, mime: file.mime, duration: file.duration, chunks });
    for (let i = 0; i < chunks; i++) {
      while (buffered(conn) > HIGH_WATER) {
        await sleep(15);
        if (m.xfer !== token || !conn.open) return;
      }
      if (m.xfer !== token || !conn.open) return;
      conn.send({ t: 'chunk', id: file.id, i, data: buf.slice(i * CHUNK, (i + 1) * CHUNK) });
      if (onProgress && i % 20 === 0) onProgress(i / chunks);
    }
    conn.send({ t: 'file-done', id: file.id });
    m.xfer = null;
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
  }
}

export class MemberRoom extends Emitter {
  constructor(name, code) {
    super();
    this.name = name;
    this.code = code;
    this.isHost = false;
    this.closed = false;
    this.connected = false;
  }

  async start() {
    const opts = await peerOptions();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(noRouteMsg()), 25000);
      this.on('ice-failed', () => fail(noRouteMsg()));
      const peer = new Peer(undefined, opts);
      this.peer = peer;
      peer.on('open', () => this._connect());
      peer.on('disconnected', () => {
        if (!this.closed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500);
      });
      peer.on('error', (e) => {
        if (!settled) fail(humanError(e));
        else this.emit('warn', humanError(e));
      });
      this.on('connected', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  _connect() {
    if (this.closed) return;
    const hostId = PREFIX + this.code;
    this.ctrl?.close();
    this.sync?.close();
    const ctrl = this.peer.connect(hostId, { label: 'ctrl', reliable: true, metadata: { name: this.name } });
    const sync = this.peer.connect(hostId, { label: 'sync', reliable: false, serialization: 'json', metadata: { name: this.name } });
    this.ctrl = ctrl;
    this.sync = sync;
    const watchIce = () => {
      const pc = ctrl.peerConnection;
      if (!pc) return setTimeout(watchIce, 200);
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed' && !this.connected) this.emit('ice-failed');
      });
    };
    watchIce();
    ctrl.on('open', () => {
      this.connected = true;
      this.emit('connected');
    });
    ctrl.on('data', (d) => this.emit('message', d));
    ctrl.on('close', () => {
      if (this.ctrl !== ctrl) return;
      this.connected = false;
      this.emit('disconnected');
      this._retry();
    });
    sync.on('data', (d) => {
      if (d?.t === 'q') this.emit('pong', d.a, d.b, performance.now());
      else this.emit('message', d);
    });
  }

  _retry() {
    if (this.closed || this._retrying) return;
    this._retrying = true;
    const loop = async () => {
      while (!this.closed && !this.connected) {
        await sleep(3000);
        if (this.closed || this.connected) break;
        if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
        else this._connect();
      }
      this._retrying = false;
    };
    loop();
  }

  ping() {
    if (this.sync?.open) this.sync.send({ t: 'p', a: performance.now() });
  }

  send(msg) {
    if (this.ctrl?.open) this.ctrl.send(msg);
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
  }
}
