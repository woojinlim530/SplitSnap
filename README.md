# SplitSnap Cloudflare Workers v1.5.0

SplitSnap은 영수증을 읽고 여러 사람이 동시에 항목을 배분한 뒤, 각자의 부담액과 미납액을 확인하는 모바일 우선 웹앱입니다.

## 이번 버전: My Splits, Host 복구, PWA

1. 같은 브라우저에서 만들거나 참가한 세션을 홈의 **My Splits**에서 다시 열 수 있습니다. 기존 v1.4의 `splitsnap.access.<sessionId>` 로컬 저장 토큰을 자동으로 읽어오므로 이전 세션을 별도로 이전할 필요가 없습니다.
2. 새 정산을 만들면 **Save your Host recovery link** 안내가 표시됩니다. Host는 세션 상단이나 My Splits에서도 링크를 복사할 수 있습니다. 새 기기 또는 홈 화면 앱에서 **Restore a split**에 링크를 붙여 넣으면 서버가 Host 권한을 확인하고 해당 기기에 접근 권한을 저장합니다.
3. `manifest.webmanifest`, 홈 화면 앱 아이콘, Service Worker가 포함되었습니다. iPhone Safari에서는 공유 메뉴에서 홈 화면에 추가할 수 있고, 설치 프롬프트를 지원하는 브라우저에서는 설치 버튼을 사용할 수 있습니다.

복구 링크에는 실제 Host 접근 토큰이 포함됩니다. 친구 초대 링크와 절대로 혼동해서는 안 됩니다. 복구 링크를 받은 사람은 Host와 같은 권한을 갖습니다.

## Cloudflare Workers에 업데이트

기존 `splitsnap` Worker 이름을 그대로 사용합니다.

```bash
npm install
npm test
npm run deploy
```

배포 주소는 기존에 사용하던 `https://splitsnap.splitsnap.workers.dev`입니다. Cloudflare 대시보드에서 설정한 `GEMINI_API_KEY` Secret은 동일 Worker에 재배포하면 보통 유지되므로 다시 입력할 필요가 없습니다.

실제 Cloudflare 계정에서의 배포는 사용자 계정 인증이 필요하므로 이번 패키지는 로컬에서 제작 및 테스트한 배포 소스입니다.

## 이용 방법

### 이전 정산을 찾기

SplitSnap 홈페이지로 이동하면 해당 브라우저에 저장된 토큰으로 접근할 수 있는 세션 목록이 보입니다. 각 카드에는 제목, 전체 금액, Host인 경우 미납액, 세션 만료일이 표시됩니다.

**Open split**을 누르면 기존 정산으로 돌아갑니다. **My Splits**는 앱 상단에도 있습니다. 브라우저 데이터를 삭제했다면 목록이 비어 있을 수 있습니다.

### 다른 기기에서 Host 세션 복구

Host가 정산 방에서 **Save Host recovery link**를 누르고 **Copy private link**로 복구 주소를 안전한 곳에 보관합니다. 새 기기에서 SplitSnap 홈페이지의 **Restore a split**에 전체 주소를 붙여 넣습니다. 복구 완료 후 목록에도 표시됩니다.

Host 링크는 닉네임이 아니라 토큰으로 권한을 검증합니다. 실제 정산 데이터는 세션별 Cloudflare Durable Objects SQLite에 남아 있습니다. 복구 링크를 잃어버리고 브라우저 저장 데이터까지 지운 경우, 계정 시스템이 없는 이 MVP에서 임의로 Host를 복구할 수는 없습니다.

### iPhone에 PWA 설치

1. Safari에서 `https://splitsnap.splitsnap.workers.dev`를 엽니다.
2. Safari 공유 메뉴를 열고 **홈 화면에 추가(Add to Home Screen)**를 선택합니다.
3. 이름을 확인하고 **추가(Add)**를 누릅니다.
4. 홈 화면에 생긴 SplitSnap 아이콘으로 실행합니다.

일부 iOS 버전 및 설치 환경에서는 Safari와 홈 화면 앱의 저장 공간이 분리될 수 있습니다. 홈 화면 앱에서 기존 정산이 보이지 않는 경우 **Restore a split**에 개인 Host 복구 링크를 넣으세요.

Android Chrome은 설치 안내를 지원하면 **How to install**에서 **Install app** 버튼을 보여줍니다. 없는 경우 브라우저 메뉴의 홈 화면에 추가 기능을 사용합니다.

## 저장과 개인정보

세션의 금액과 참여자 정보는 Cloudflare Durable Objects SQLite에 보관됩니다. 브라우저에는 해당 세션에 대한 접근 토큰만 저장합니다. 일반 참여자는 다른 사람의 입금 상태를 서버 API로도 볼 수 없습니다.

미납 또는 미확정 세션은 마지막 변경 이후 최대 90일, 모두 정산된 세션은 마지막 변경 이후 최대 30일 동안 보관하는 기존 만료 정책을 유지합니다. 만료되었거나 삭제된 세션은 복구 링크로도 복원할 수 없습니다.

Service Worker는 정적 앱 파일만 캐싱합니다. `/api/` 응답이나 카드 결제 내역, Gemini 영수증 이미지 등을 오프라인 캐시에 저장하지 않습니다. 인터넷이 없으면 과거 메뉴 선택과 입금 기록을 수정할 수 없습니다.

## 기존 기능

영수증 사진 업로드, Gemini 이미지 분석, 인식 결과 검토, 한 식당의 여러 영수증 매칭, 서로 다른 식당 차단, 수량 배분, 공유 메뉴 균등 분할, 정확한 세금과 팁 계산, WebSocket 실시간 협업, Host 확정, 부분 입금 기록 기능은 유지합니다.

## 테스트

```bash
npm test
```

`tests/saved-access.test.mjs`는 기존 브라우저 접근 토큰 발견, 복구 링크 파싱, 다른 출처의 복구 링크 차단, 브라우저 저장소 접근 실패 처리를 검증합니다. 기존 정산 및 권한 테스트도 함께 실행됩니다.

Chromium에서 320px, 390px, 1280px의 Dashboard, Host 복구 링크, PWA 설치 안내 UI를 렌더링해 레이아웃 오버플로가 없는지 확인했습니다. 실제 Safari 27, Cloudflare 운영 계정, iOS 홈 화면 설치 동작은 배포 후 실기기에서 추가 검증이 필요합니다.
