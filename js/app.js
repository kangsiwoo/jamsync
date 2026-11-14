import { ClockSync, identityClock } from './clock.js';
import { SyncPlayer, makeTestTrack } from './player.js';
import { HostRoom, MemberRoom } from './net.js';

const LEAD_MS = 1500; // 재생 명령 후 실제 시작까지 여유 (셀룰러 왕복 지연 감안)
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('jamsync.' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('jamsync.' + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- 상태 ----------
const clock = new ClockSync();
const player = new SyncPlayer(identityClock);
let room = null;
let isHost = false;
let song = null; // { id, name, duration, buf?(방장만), mime }
let curState = { mode: 'stopped', pos: 0, seq: 0, fileId: null }; // 방장 시각 기준
let lastSeq = -1;
let incoming = null; // 멤버: 받는 중인 파일
let memberList = []; // 화면 표시용
let pingTimer = null;
let statusTimer = null;
let wakeLock = null;
let decodedForId = null;

// ---------- 공통 유틸 ----------
const fmt = (s, tenths = true) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${(tenths ? r.toFixed(1) : Math.floor(r).toString()).padStart(tenths ? 4 : 2, '0')}`;
};
const hostNow = () => (isHost ? performance.now() : clock.toRemote(performance.now()));
const posAt = (st, hostT) => (st.mode === 'playing' ? st.pos + (hostT - st.hostT0) / 1000 : st.pos);
const clampPos = (p) => Math.max(0, Math.min(p, song ? song.duration : 0));
const fileStatus = () => (song && decodedForId === song.id ? 'ready' : incoming ? Math.round((incoming.got / incoming.chunks) * 100) : 'none');

function setConn(text, cls = '') {
  const el = $('conn');
  el.textContent = text;
  el.className = 'status ' + cls;
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && room) {
    keepAwake();
    if (player.ctx && player.ctx.state !== 'running') $('tap-overlay').classList.remove('hidden');
  }
});

$('btn-tap').onclick = () => {
  player.unlock().then(() => {
    $('tap-overlay').classList.add('hidden');
    applyState();
  });
};

// ---------- 홈 ----------
$('name').value = store.get('name', '');
const params = new URLSearchParams(location.search);
if (params.get('room')) $('join-code').value = params.get('room').replace(/\D/g, '').slice(0, 6);

function myName() {
  const n = $('name').value.trim() || '이름없음';
  store.set('name', n);
  return n;
}

function homeMsg(t) {
  $('home-msg').textContent = t || '';
}

function setBusy(b) {
  $('btn-create').disabled = b;
  $('btn-join').disabled = b;
}

$('btn-create').onclick = async () => {
  player.unlock(); // 사용자 탭 안에서 바로
  if (typeof Peer === 'undefined') return homeMsg('네트워크 라이브러리를 불러오지 못했어요. 인터넷을 확인하고 새로고침하세요.');
  setBusy(true);
  homeMsg('방 만드는 중…');
  try {
    const r = new HostRoom(myName());
    const code = await r.start();
    room = r;
    isHost = true;
    player.setClock(identityClock);
    wireHost(r);
    enterRoom(code);
  } catch (e) {
    homeMsg(e.message);
  } finally {
    setBusy(false);
  }
};

$('btn-join').onclick = async () => {
  player.unlock();
  const code = $('join-code').value.replace(/\D/g, '');
  if (code.length !== 6) return homeMsg('방 코드 6자리를 입력하세요.');
  if (typeof Peer === 'undefined') return homeMsg('네트워크 라이브러리를 불러오지 못했어요. 인터넷을 확인하고 새로고침하세요.');
  setBusy(true);
  homeMsg('방에 연결 중…');
  const r = new MemberRoom(myName(), code);
  wireMember(r); // 연결 전에 이벤트부터 연결해 둔다
  try {
    await r.start();
    room = r;
    isHost = false;
    player.setClock(clock);
    enterRoom(code);
  } catch (e) {
    homeMsg(e.message);
  } finally {
    setBusy(false);
  }
};

$('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());

function enterRoom(code) {
  homeMsg('');
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('room-code').textContent = code;
  $('host-file').classList.toggle('hidden', !isHost);
  const url = new URL(location.href);
  url.search = '?room=' + code;
  history.replaceState(null, '', url);
  buildInvite(url.toString());
  keepAwake();
  setConn(isHost ? '방장 · 멤버를 기다리는 중' : '방장과 연결됨, 시계 맞추는 중…', isHost ? 'ok' : '');
  render();
  requestAnimationFrame(frame);
  // 곡 끝 감지는 rAF 말고 타이머로 (방장 화면이 백그라운드여도 동작하도록)
  if (isHost) {
    setInterval(() => {
      if (curState.mode === 'playing' && song && posAt(curState, performance.now()) >= song.duration) hostCommand('end');
    }, 250);
  }
}

$('btn-leave').onclick = () => {
  if (!confirm('방에서 나갈까요?')) return;
  location.href = location.pathname;
};

// ---------- 초대 ----------
function buildInvite(link) {
  $('invite-link').textContent = link;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    $('qr').classList.add('hidden');
  }
  $('btn-share').classList.toggle('hidden', !navigator.share);
  $('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('btn-copy').textContent = '복사됨';
      setTimeout(() => ($('btn-copy').textContent = '링크 복사'), 1500);
    } catch {
      prompt('이 링크를 복사하세요', link);
    }
  };
  $('btn-share').onclick = () => navigator.share({ title: '합주싱크', text: `합주싱크 방 코드 ${room.code}`, url: link }).catch(() => {});
}
$('btn-invite').onclick = () => $('invite').classList.toggle('hidden');

// ---------- 방장 ----------
function wireHost(r) {
  r.on('join', (m) => {
    r.send(m, { t: 'welcome', hostName: r.name });
    if (song) r.sendFile(m, song);
    r.send(m, { t: 'state', state: curState });
    refreshMembers();
  });
  r.on('leave', () => refreshMembers());
  r.on('warn', (msg) => console.warn(msg));
  r.on('message', (m, d) => {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'status') {
      m.status = { file: d.file, err: d.err, lat: d.lat };
    } else if (d.t === 'cmd') {
      hostCommand(d.action, d.arg);
    }
  });
  statusTimer = setInterval(() => {
    refreshMembers();
  }, 1000);
}

function refreshMembers() {
  if (!isHost) return;
  memberList = [
    { name: room.name, host: true, file: fileStatus(), err: 0 },
    ...[...room.members.values()].map((m) => ({ name: m.name, host: false, file: m.status.file ?? 'none', err: m.status.err ?? null, lat: m.status.lat })),
  ];
  room.broadcast({ t: 'members', list: memberList });
  const n = room.members.size;
  setConn(n ? `방장 · 멤버 ${n}명 연결됨` : '방장 · 멤버를 기다리는 중', 'ok');
  renderMembers();
}

function hostCommand(action, arg) {
  if (!song || decodedForId !== song.id) return;
  const now = performance.now();
  const cur = clampPos(posAt(curState, now));
  const playing = curState.mode === 'playing';
  let next;
  switch (action) {
    case 'toggle':
      return hostCommand(playing ? 'pause' : 'play');
    case 'play':
      next = { mode: 'playing', pos: cur >= song.duration - 0.05 ? 0 : cur, hostT0: now + LEAD_MS };
      break;
    case 'pause':
      next = { mode: 'paused', pos: cur };
      break;
    case 'seek': {
      const p = clampPos(Number(arg) || 0);
      next = playing ? { mode: 'playing', pos: p, hostT0: now + LEAD_MS } : { mode: 'paused', pos: p };
      break;
    }
    case 'nudge':
      return hostCommand('seek', cur + (Number(arg) || 0));
    case 'end':
      next = { mode: 'stopped', pos: 0 };
      break;
    default:
      return;
  }
  setState({ ...next, fileId: song.id });
}

function setState(st) {
  curState = { ...st, seq: (curState.seq || 0) + 1 };
  room.broadcastState(curState);
  applyState();
}

async function hostLoadFile(name, mime, buf) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  $('song-name').textContent = '불러오는 중…';
  let audio;
  try {
    audio = await player.decode(buf);
  } catch {
    $('song-name').textContent = song ? song.name : '곡 없음';
    alert('이 파일은 재생할 수 없어요. mp3, m4a, wav 파일을 써 보세요.');
    return;
  }
  player.setBuffer(audio);
  song = { id, name, mime, buf, duration: audio.duration };
  decodedForId = id;
  setState({ mode: 'stopped', pos: 0, fileId: id });
  for (const m of room.members.values()) room.sendFile(m, song);
  render();
  refreshMembers();
}

$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 60 * 1024 * 1024) return alert('파일이 너무 커요 (60MB 이하).');
  hostLoadFile(f.name, f.type, await f.arrayBuffer());
};

$('btn-test-track').onclick = () => hostLoadFile('테스트 음원 (120BPM 클릭)', 'audio/wav', makeTestTrack(90));

// ---------- 멤버 ----------
function wireMember(r) {
  r.on('connected', () => {
    setConn('방장과 연결됨, 시계 맞추는 중…');
    clock.reset();
    startPinging(r);
    sendStatus();
  });
  r.on('disconnected', () => {
    setConn('방장과 연결이 끊겼어요. 다시 연결 중…', 'bad');
    stopPinging();
  });
  r.on('warn', (msg) => console.warn(msg));
  r.on('pong', (a, b, c) => {
    const wasReady = clock.ready;
    clock.addSample(a, b, c);
    if (!wasReady && clock.ready) applyState();
    if (clock.ready && r.connected) setConn(`방장과 연결됨 · 시계 오차 ±${clock.error.toFixed(0)}ms`, 'ok');
  });
  r.on('message', (d) => onMemberMessage(d));
}

function startPinging(r) {
  stopPinging();
  let burst = 0;
  const fast = setInterval(() => {
    r.ping();
    if (++burst >= 20) {
      clearInterval(fast);
      pingTimer = setInterval(() => r.ping(), 1000);
    }
  }, 60);
  pingTimer = fast;
  statusTimer = statusTimer || setInterval(sendStatus, 1000);
}

function stopPinging() {
  clearInterval(pingTimer);
  pingTimer = null;
}

function sendStatus() {
  if (!room || isHost) return;
  room.send({ t: 'status', file: fileStatus(), err: Number.isFinite(clock.error) ? Math.round(clock.error) : null, lat: player.userLatencyMs });
}

function onMemberMessage(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'welcome':
      room.hostName = d.hostName;
      break;
    case 'members':
      memberList = d.list;
      renderMembers();
      break;
    case 'state':
      if (d.state.seq <= lastSeq) return;
      lastSeq = d.state.seq;
      curState = d.state;
      applyState();
      break;
    case 'file-meta':
      incoming = { ...d, parts: new Array(d.chunks), got: 0 };
      song = { id: d.id, name: d.name, duration: d.duration, mime: d.mime };
      decodedForId = null;
      player.setBuffer(null);
      render();
      break;
    case 'chunk':
      if (!incoming || d.id !== incoming.id || incoming.parts[d.i]) return;
      incoming.parts[d.i] = d.data;
      incoming.got++;
      if (incoming.got % 25 === 0) render();
      break;
    case 'file-done':
      if (incoming && d.id === incoming.id) finishIncoming();
      break;
  }
}

async function finishIncoming() {
  const inc = incoming;
  if (inc.got !== inc.chunks) {
    console.warn('파일 일부 누락', inc.got, inc.chunks);
  }
  const blob = new Blob(inc.parts, { type: inc.mime || 'application/octet-stream' });
  try {
    const audio = await player.decode(await blob.arrayBuffer());
    if (incoming !== inc) return; // 그 사이 새 곡
    player.setBuffer(audio);
    song.duration = audio.duration;
    decodedForId = inc.id;
    incoming = null;
    sendStatus();
    render();
    applyState();
  } catch {
    incoming = null;
    $('song-name').textContent = '이 기기에서 재생할 수 없는 형식이에요';
  }
}

// ---------- 재생 반영 ----------
function applyState() {
  const st = curState;
  const ready = song && decodedForId === song.id && st.fileId === song.id && (isHost || clock.ready) && player.buffer;
  if (!ready || st.mode !== 'playing') {
    player.stop(st.pos || 0);
  } else {
    player.play(st.pos, st.hostT0);
  }
  render();
}

// ---------- 조작 버튼 (누구나 조작 가능, 방장이 결정) ----------
function command(action, arg) {
  if (!player.unlocked) player.unlock();
  if (isHost) hostCommand(action, arg);
  else room.send({ t: 'cmd', action, arg });
}
$('btn-play').onclick = () => command('toggle');
$('btn-start').onclick = () => command('seek', 0);
$('btn-back').onclick = () => command('nudge', -5);
$('btn-fwd').onclick = () => command('nudge', 5);
let seeking = false;
$('seek').addEventListener('input', () => {
  seeking = true;
  if (song) $('t-cur').textContent = fmt((($('seek').value / 1000) * song.duration));
});
$('seek').addEventListener('change', () => {
  seeking = false;
  if (song) command('seek', ($('seek').value / 1000) * song.duration);
});

// ---------- 내 설정 ----------
function setLatency(ms) {
  ms = Math.max(-100, Math.min(400, ms));
  player.setLatency(ms);
  $('lat').value = ms;
  $('lat-val').textContent = (ms > 0 ? '+' : '') + ms + 'ms';
  store.set('lat', ms);
  sendStatus();
}
setLatency(store.get('lat', 0));
$('lat').oninput = () => setLatency(Number($('lat').value));
$('lat-minus').onclick = () => setLatency(player.userLatencyMs - 5);
$('lat-plus').onclick = () => setLatency(player.userLatencyMs + 5);

const vol = store.get('vol', 1);
$('vol').value = vol;
$('vol').oninput = () => {
  player.setVolume(Number($('vol').value));
  store.set('vol', Number($('vol').value));
};
setTimeout(() => player.setVolume(vol), 0);

$('btn-click').onclick = () => {
  player.unlock();
  player.setVolume(Number($('vol').value));
  const on = !player.clicksOn;
  player.setClicks(on);
  $('btn-click').textContent = on ? '클릭 테스트 끄기' : '클릭 테스트 켜기';
  $('btn-click').classList.toggle('primary', on);
};

// ---------- 렌더링 ----------
function render() {
  const has = !!song && decodedForId === song.id;
  $('song-name').textContent = song ? song.name : isHost ? '음악 파일을 골라주세요' : '방장이 곡을 고르길 기다리는 중';
  if (incoming) {
    $('xfer').classList.remove('hidden');
    $('xfer').firstElementChild.style.width = (incoming.got / incoming.chunks) * 100 + '%';
    $('song-name').textContent = `받는 중… ${song.name}`;
  } else {
    $('xfer').classList.add('hidden');
  }
  $('t-dur').textContent = '/ ' + fmt(song?.duration || 0, false);
  for (const id of ['btn-play', 'btn-start', 'btn-back', 'btn-fwd', 'seek']) $(id).disabled = !has;
  $('btn-play').textContent = curState.mode === 'playing' ? '⏸' : '▶';
  $('btn-play').setAttribute('aria-label', curState.mode === 'playing' ? '일시정지' : '재생');
}

function renderMembers() {
  const ul = $('members');
  ul.innerHTML = '';
  for (const m of memberList) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = m.name;
    if (m.host) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '방장';
      name.append(tag);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const file = m.file === 'ready' ? '<span class="good">곡 ✓</span>' : typeof m.file === 'number' ? `받는 중 ${m.file}%` : '<span class="dim">곡 없음</span>';
    let sync = '';
    if (!m.host) {
      if (m.err == null) sync = ' · <span class="meh">시계 맞추는 중</span>';
      else sync = ` · <span class="${m.err <= 15 ? 'good' : m.err <= 40 ? 'meh' : 'badc'}">±${m.err}ms</span>`;
    }
    const lat = m.lat ? ` · 보정 ${m.lat > 0 ? '+' : ''}${m.lat}ms` : '';
    meta.innerHTML = file + sync + lat;
    li.append(name, meta);
    ul.append(li);
  }
}

function frame() {
  if (!room) return;
  const hn = hostNow();
  const st = curState;
  let pos = clampPos(posAt(st, hn));
  if (st.mode === 'playing' && song) {
    const left = (st.hostT0 - hn) / 1000 - Math.min(0, st.pos);
    $('countdown').textContent = left > 0 ? `시작까지 ${left.toFixed(1)}초` : '';
  } else {
    $('countdown').textContent = st.mode === 'paused' ? '일시정지' : '';
  }
  if (!seeking) {
    $('t-cur').textContent = fmt(pos);
    $('seek').value = song?.duration ? Math.round((pos / song.duration) * 1000) : 0;
  }
  const map = player._map;
  $('diag').textContent =
    `오디오 ${player.ctx?.state ?? '-'} · 출력지연 ${map != null && player.ctx ? Math.round((player.ctx.currentTime - performance.now() / 1000 - map) * 1000) : '-'}ms` +
    (isHost ? '' : ` · 시계 ±${Number.isFinite(clock.error) ? clock.error.toFixed(1) : '-'}ms (${clock.samples.length})`) +
    (st.mode === 'playing' ? ` · 재생오차 ${player.lastErrMs.toFixed(1)}ms` : '');
  requestAnimationFrame(frame);
}

// 디버깅용
window.__jam = { player, clock, get room() { return room; }, get state() { return curState; }, get song() { return song; } };
