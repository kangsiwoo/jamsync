// 연결 설정.
//
// STUN: 폰이 자기 공인 주소를 알아내는 용도. 무료 공개 서버로 충분하다.
// TURN: 폰끼리 직접 연결이 안 될 때(셀룰러↔셀룰러, 회사/학교 와이파이 등) 데이터를 대신 전달해 주는 중계 서버.
//       PeerJS가 예전에 주던 무료 TURN은 더 이상 동작하지 않으므로, 아래 둘 중 하나를 채워야
//       셀룰러 환경에서도 확실히 붙는다. (같은 와이파이끼리는 TURN 없이도 대부분 된다.)
//
// 1) turnCredentialsUrl: GET 하면 RTCIceServer 배열 JSON을 돌려주는 주소.
//    예) Metered(무료 20GB/월): https://<앱이름>.metered.live/api/v1/turn/credentials?apiKey=<API키>
// 2) turnServers: 고정 TURN 서버 목록.
//    예) [{ urls: ['turn:example.com:3478', 'turns:example.com:443?transport=tcp'], username: 'u', credential: 'p' }]

export const CONFIG = {
  stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turnCredentialsUrl: '',
  turnServers: [],
};
