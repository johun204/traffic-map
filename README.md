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
| `index.html` / `style.css` / `app.js` | Leaflet 지도. 지원 교차로 = 회색 점, 현위치 800m 이내(최대 12개) = 주황 마커 + 상시 잔여초 툴팁 + 하단 목록. 현위치 자동 추적, ◎ 버튼으로 복귀 |
| `api/index.py` | FastAPI. 서울시 C-ITS API 프록시(키 은닉 + http→https 중계). `/api/intersections`, `/api/signals?itstId=a,b,c`. 교차로 목록 6h·신호 4s 캐시 |
| `vendor/leaflet/` | Leaflet 1.9.4 (CDN 의존 제거) |
| `sw.js` / `manifest.webmanifest` / `icon.svg` | PWA 설치·오프라인 셸 |

## 배포 (Vercel) — 웹앱 + FastAPI 한 배포

이 repo 하나로 정적 PWA와 FastAPI가 같은 도메인에서 동작한다.

- 루트의 `index.html` / `app.js` / `style.css` / `vendor/` … → Vercel 정적(CDN)
- `api/index.py` (FastAPI) → Vercel Python 서버리스 함수
- `vercel.json` 이 `/api/*` 요청을 그 함수로 rewrite. 그 외 경로는 정적으로 폴백.
- `requirements.txt` (`fastapi`, `httpx`) 를 Vercel 이 자동 설치. `@vercel/python` 이 `app` 을 ASGI 앱으로 인식.

### 순서

1. [vercel.com](https://vercel.com) → **Add New → Project** → `johun204/traffic-map` import.
2. Framework Preset: **Other** (자동 감지됨). Build Command / Output Directory: **비움**.
3. **Environment Variables**: `SEOUL_API_KEY` = t-data.seoul.go.kr 인증키.
   (신호·교차로맵 키가 다르면 `SEOUL_MAP_API_KEY`, `SEOUL_SIGNAL_API_KEY` 로 각각.)
   키 없으면 `/api/*` 가 503 (데모 없음).
4. Deploy.

### 배포 후 확인

| URL | 기대 |
|-----|------|
| `https://<app>.vercel.app/` | 지도 웹앱 |
| `https://<app>.vercel.app/api/health` | `{"ok":true,"map_key":true,"signal_key":true}` |
| `https://<app>.vercel.app/api/intersections` | 교차로 배열 JSON |

`/api/health` 가 404 면 `vercel.json` rewrite 가 안 먹은 것 → 프로젝트 재배포.
`map_key:false` 면 환경변수 미설정 → 추가 후 재배포.

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

- 교차로맵 응답은 확인함(최상위 배열, `itstId`/`itstNm`/`mapCtptIntLat`/`mapCtptIntLot`). 일부 행 좌표 오류가 있어 서울 범위로 필터링.
- 신호(SPaT) 응답도 확인함(최상위 배열, `{방위}{현시}sgRmdrCs` = 1/10초, `36001` = 미정의). **색상(녹/적) 필드가 없어** 잔여시간만 표시한다. `_normalize_signal()` 은 최신 레코드의 최소 잔여시간을 교차로당 1개로 요약.
- 실제 신호등과 비교해 이 잔여시간이 녹색분/적색분 중 무엇인지 확인되면 색 구분을 추가할 수 있다.
