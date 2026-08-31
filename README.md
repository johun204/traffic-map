# traffic-map

지도 위에 **서울시가 지원하는 교차로**를 표시하고, 현위치 주변 교차로의 **실시간 신호 잔여시간**을 보여주는 도보용 PWA.

## 데이터 출처 — 서울시 C-ITS (t-data.seoul.go.kr)

국가 ITS `signalPhase` 는 서울 도로 커버리지가 사실상 없어서 사용하지 않는다.
대신 서울교통 빅데이터 플랫폼(t-data.seoul.go.kr)의 C-ITS Open API 2종을 쓴다.

| API | 용도 |
|-----|------|
| `v2xCrossroadMapInformation/1.0` (교차로 Map 정보) | 지원 교차로 전체 목록 (id·이름·좌표). 일 1회 갱신 → 서버 6h 캐시 |
| `v2xSignalPhaseTimingInformation/1.0` (신호제어기 잔여시간) | 교차로ID별 신호 현시·잔여시간(0.1초 단위) |

커버리지: 도심(사대문안)·여의도·강남·상암·중앙버스전용차로 등 주요 교차로 788개소(2022) → 4차로 이상 전 교차로 3,660개소로 확대 중.
키 발급: [t-data.seoul.go.kr](https://t-data.seoul.go.kr) 회원가입 후 활용신청(무료).

## 구조

| 경로 | 역할 |
|------|------|
| `index.html` / `style.css` / `app.js` | Leaflet 지도. 지원 교차로를 회색 점으로, 현위치 800m 이내 교차로(최대 12개)의 실시간 신호를 색상 마커 + 1초 카운트다운 |
| `api/index.py` | FastAPI. 서울시 C-ITS API 프록시(키 은닉 + http→https 중계). `/api/intersections`, `/api/signals?itstId=a,b,c` |
| `vendor/leaflet/` | Leaflet 1.9.4 (CDN 의존 제거) |
| `sw.js` / `manifest.webmanifest` / `icon.svg` | PWA 설치·오프라인 셸 |

## 배포 (Vercel)

1. repo import → 프레임워크 프리셋 **Other**. `vercel.json` 이 `/api/*` 를 FastAPI 함수로 라우팅.
2. 환경변수 `SEOUL_API_KEY` = t-data.seoul.go.kr 인증키. **없으면 503** (데모 없음).
3. 배포된 HTTPS URL 접속 → 위치 권한 허용.

### 로컬 실행

```
pip install -r requirements-dev.txt
cp .env.example .env      # .env 에 t-data 인증키 입력
python -m uvicorn api.index:app --reload --port 8000
```

`http://localhost:8000` 접속. FastAPI 가 정적 파일(`/`)과 API(`/api/*`)를 한 프로세스로 서빙한다.
`.env` 는 `python-dotenv` 로 자동 로드되며 git 에 커밋되지 않는다. 키 상태는 `GET /api/health` 로 확인.
브라우저 geolocation 은 `localhost` 에서는 http 여도 동작한다.

## 알려진 제약

- `api/index.py` 의 `_rows()` / `_normalize_signal()` 필드 매핑은 t-data 응답 문서를 추정한 것. 실호출 JSON 1건 확인해 필드명만 맞추면 된다.
- 신호는 방향별로 나오는데 현재는 "가장 빨리 바뀌는 현시" 하나로 요약해 교차로당 마커 1개로 표시한다.
