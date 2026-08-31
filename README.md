# traffic-map

현위치 **50m 이내** 신호등의 잔여 시간을 표시하는 도보용 PWA.

## 구조

| 파일 | 역할 |
|------|------|
| `index.html` / `style.css` / `app.js` | 앱 셸. `geolocation.watchPosition` → `/api/signals` 호출 → 50m 이내 신호 카드 + 1초 로컬 카운트다운 |
| `api/signals.js` | Vercel 서버리스. ITS `signalPhase` API 프록시(CORS 회피·키 은닉). 키 없음/응답 없음 → 데모 신호 |
| `sw.js` / `manifest.webmanifest` / `icon.svg` | PWA 설치·오프라인 셸 |

## 배포 (Vercel)

1. 이 저장소를 Vercel 프로젝트로 import (프레임워크 프리셋: Other, 빌드 명령 없음).
2. 환경변수:
   - `ITS_API_KEY` — 국가교통정보센터(ITS) 오픈API 인증키. 없으면 데모 데이터로 동작.
   - `DEMO=1` — 키가 있어도 강제로 데모 데이터 사용(선택).
3. 배포 후 HTTPS URL 접속 → 위치 권한 허용.

## 알려진 제약

- ITS `signalPhase` 는 시범 지역 위주로 커버리지가 제한적이라, 대부분 지역에서 `api/signals.js` 가 데모 데이터로 폴백한다.
- `api/signals.js` 의 `normalize()` 는 ITS 응답 필드명을 추정한 매핑이다. 실제 응답을 확인해 필드명만 맞추면 실데이터가 표시된다.
