# iPhone Safari에서 확장 패널이 안 보였던 원인

정리: 2026-11-19 · 해결 커밋 `8f4efd6` (2026-11-18) · 관련 커밋 `04507ae`

## 증상

- iPhone Safari(iOS 26.6.1)에서 ts.net 링크로 handide를 열면, Claude Code·OpenCode 같은 확장 패널이 머리글만 보이고 그 아래가 빈 화면이었다.
- 오류 메시지도 없었다. 웹뷰 호스트 페이지의 진행 기록(mark)은 `content/started`에서 멈추고, 다음 단계인 `content/workerReady`로 넘어가지 않았다.

## 원인

VS Code는 확장 패널을 **웹뷰 호스트 페이지**(iframe) 안에 그린다. 이 페이지는 다음 순서로 동작한다.

1. VS Code에서 패널 내용을 받는다.
2. 자기 서비스 워커가 준비될 때까지 기다린다(`await workerReady`).
3. 준비되면 실제 내용을 담을 frame을 만든다.

iOS Safari에서는 2번의 `workerReady` promise가 **영영 끝나지 않았다.** 그 시점에 페이지는 이미 웹뷰 자신의 서비스 워커(`service-worker.js`)의 제어를 받고 있었는데도 그랬다. 그래서 3번의 frame이 만들어지지 않았고, 패널은 빈 채로 남았다.

다른 브라우저(Chromium 등)에서는 이 promise가 업데이트 확인 직후 바로 끝나서 문제가 드러나지 않았다.

## 해결 (`8f4efd6`)

handide는 원래부터 이 웹뷰 호스트 페이지를 고쳐서 내보내고 있었다(`proxy/webview.mjs`의 `patchWebviewHost`). 여기에 기다리는 조건을 하나 더했다.

- `await workerReady` 대신 `await hdWorkerReady(workerReady)`를 쓴다.
- 원래 promise가 끝나면 그대로 진행한다.
- **2초 뒤부터는** 0.25초마다, 페이지가 웹뷰 자신의 서비스 워커(`/service-worker.js`)에 제어되고 있는지 확인한다. 제어되고 있으면 준비된 것으로 보고 진행한다.
- 다른 서비스 워커에 제어되거나 서비스 워커가 아예 없으면 준비된 것으로 치지 않는다.
- 2초를 먼저 기다리는 이유: 다른 브라우저에서는 원래 promise가 곧 끝나므로, 그쪽 동작은 바꾸지 않기 위해서다.

함께 바꾼 것:

- 이 페이지는 원래 1년 동안 캐시되는 정적 파일로 나간다. handide가 고친 부분은 바뀔 수 있으므로 `cache-control: no-cache`로 보낸다(`proxy/server.mjs`). 그러지 않으면 폰이 고치기 전의 옛 페이지를 계속 쓴다.

## 확인

- `npm run check:webview`: 설치된 VS Code 서버의 웹뷰 호스트 페이지에 이 수정이 제대로 들어가는지, 기다리는 동작이 맞는지 검사한다.
- 실제 iPhone에서 패널이 보이는 것을 확인했다.

## 같은 시기에 고친 관련 문제 (`04507ae`)

ts.net 링크(또는 LAN 주소)로 열면 Safari를 포함한 모든 브라우저에서 생기던 문제다. 증상이 비슷해 함께 적어 둔다.

- VS Code가 쓰는 CDN(`main.vscode-cdn.net`)은 **localhost 페이지에만** CORS 허용 헤더를 보낸다. `www.vscode-unpkg.net`은 아예 보내지 않는다.
- 그래서 ts.net 주소에서는 브라우저가 다음 파일들을 막았다.
  - 마켓플레이스 제어 목록(차단·사용 중단 확장)
  - 채팅 참여자 목록
  - UI 번역 파일 (그래서 한국어 폰인데 VS Code UI가 영어로 나왔다)
- 해결: 워크벤치 페이지가 이 파일들을 `/__handide/cdn/`에서 받게 바꾸고, handide가 대신 받아 전달한다(10분 캐시). 접근 토큰이 있어야 하고, 정해진 파일 형태만 전달한다.
- 확인: ts.net 주소로 Chromium·WebKit(한국어 설정)에서 열어, 네 파일이 모두 handide를 거쳐 오고 CORS 오류가 없으며 UI가 한국어로 나오는 것을 확인했다. `npm run check:cdn`이 페이지 변경과 전달 범위를 검사한다.

## 더 이전의 WebKit 대응 (`8ac5d4a`, 2026-11-03)

- EditContext가 없는 브라우저(WebKit)에서 입력 시트의 글자를 넣을 때, 합성 붙여넣기가 성공한 척하고 문서를 바꾸지 않는 문제를 companion을 거치는 방식으로 우회했다.
- WebKit이 보내는 구식 `x-webkit-deflate-frame` 압축 요청을 빼서, WebSocket 연결이 실패하지 않고 압축 없이 연결되게 했다.
