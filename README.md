# traffic-map

카카오맵 위에 **현위치 30/50/100m 이내 신호등**의 녹색/적색 상태와 잔여 시간을 보여주는 도보용 PWA.

## 데이터 출처 — 서울시 C-ITS (t-data.seoul.go.kr)

국가 ITS `signalPhase` 는 서울 커버리지가 사실상 없어 사용하지 않는다.
서울교통 빅데이터 플랫폼의 C-ITS Open API 2종을 쓴다. **데모/목업 폴백 없음** — 호출 실패 시 화면에 오류만 띄운다.

| API | 용도 |
|-----|------|
| `v2xCrossroadMapInformation/1.0` | 지원 교차로 전체 목록(id·이름·좌표). 서버 6h 캐시 |
| `v2xSignalPhaseTimingInformation/1.0` | 교차로ID별 신호 잔여시간(1/10초). 서버 4s 캐시 |

커버리지: 도심·여의도·강남·상암·중앙버스전용차로 등 788개소(2022) → 3,660개소로 확대 중.
키 발급: [t-data.seoul.go.kr](https://t-data.seoul.go.kr) 회원가입 후 활용신청(무료).

## 동작

- 지도는 **카카오맵 JavaScript SDK**. JavaScript 키는 `/api/config` 로 서버에서 내려준다(미설정 시 지도 대신 오류).
- 반경 **30 / 50 / 100m** 버튼으로 선택. 그 안의 교차로만 신호를 조회.
- 마커(CustomOverlay): 녹색 = 보행 녹색 + 잔여초, 적색 = 적색. 하단 시트에 가까운 순 목록.
- **재조회는 최소화**: 첫 조회 후 잔여시간은 내부 타이머로 카운트다운만 한다.
  다시 호출하는 경우 = (1) 카운트다운 0 도달, (2) 마지막 조회 지점에서 10m 이상 이동,
  (3) 전부 적색이면 20초마다. (최소 간격 3초)

## 구조

| 경로 | 역할 |
|------|------|
| `index.html` / `style.css` / `app.js` | 카카오맵 + 반경 선택 + 하단 목록 + 오류 배너 |
| `api/index.py` | FastAPI. C-ITS 프록시(키 은닉 + http→https 중계). `/api/config`, `/api/intersections`, `/api/signals?itstId=a,b,c` |
| `sw.js` / `manifest.webmanifest` / `icon.svg` | PWA 설치·오프라인 셸 |

## 카카오맵 API 발급

1. [Kakao Developers](https://developers.kakao.com) 로그인 → **내 애플리케이션** → 애플리케이션 추가하기.
2. **앱 키** → **JavaScript 키** 복사.
3. **플랫폼 → Web 플랫폼 등록** → 사이트 도메인에 `http://localhost:8000`, `https://<app>.vercel.app` 추가.
4. **제품 설정 → 카카오맵** → 활성화 ON.
5. JavaScript 키를 환경변수 `KAKAO_MAP_APP_KEY` 로.

## 배포 (Vercel) — 웹앱 + FastAPI 한 배포

- 루트 정적 파일 → Vercel CDN
- `api/index.py` (FastAPI) → Vercel Python 서버리스. `@vercel/python` 이 `app` 을 ASGI 로 인식
- `vercel.json` 이 `/api/*` → 함수로 rewrite, 그 외는 정적 폴백
- `requirements.txt`(`fastapi`, `httpx`) 자동 설치

### 순서

1. [vercel.com](https://vercel.com) → Add New → Project → `johun204/traffic-map` import.
2. Framework Preset **Other**, Build Command / Output Directory **비움**.
3. Environment Variables:
   - `SEOUL_API_KEY` (또는 `SEOUL_MAP_API_KEY` / `SEOUL_SIGNAL_API_KEY`)
   - `KAKAO_MAP_APP_KEY`
4. Deploy.

### 배포 후 확인

| URL | 기대 |
|-----|------|
| `/` | 지도 웹앱 |
| `/api/health` | `{"ok":true,"map_key":true,"signal_key":true,"kakao_map_key":true}` |
| `/api/intersections` | 교차로 배열 JSON |

`/api/health` 가 404 → rewrite 미적용, 재배포. `*_key:false` → 환경변수 추가 후 재배포.

## 로컬 실행

```
pip install -r requirements-dev.txt
cp .env.example .env      # .env 에 SEOUL_API_KEY, KAKAO_MAP_APP_KEY 입력
python -m uvicorn api.index:app --reload --port 8000
```

`http://localhost:8000`. FastAPI 가 정적(`/`)과 API(`/api/*`)를 한 프로세스로 서빙. `.env` 는 자동 로드(커밋 안 됨).

## 지도가 안 뜰 때

1. **콘솔(F12) 확인.** `[traffic-map] ... origin: http://localhost:8000` 로그가 찍힌다.
2. 그 origin 을 [Kakao Developers](https://developers.kakao.com) → 내 애플리케이션 → 해당 앱 →
   **플랫폼 → Web → 사이트 도메인** 에 **그대로** 추가. (포트까지, 배포 시 `https://<app>.vercel.app` 도)
3. **제품 설정 → 카카오맵** 이 **활성화 ON** 인지 확인.
4. `127.0.0.1` 로 접속 중이면 `http://127.0.0.1:8000` 도 등록하거나 `localhost` 로 접속.
5. 상단 빨강 배너로 "카카오맵 로드 실패 …" 가 뜨면 위 문제다.
   배너 없이 회색이면 `/api/config` 가 키를 안 주는 것 → `.env` / Vercel 환경변수(`KAKAO_MAP_APP_KEY`) 확인.

## 알려진 제약

- 신호(SPaT) 피드에 **색상 필드가 없다**. `_normalize_signal()` 은 *보행 잔여시간이 유효하면 현재 보행 녹색*, 없으면 적색으로 간주한다(대다수 KR 보행 C-ITS 관행 기반 추정). 현장에서 실제 신호등과 대조해 검증 필요 — 틀리면 한 줄 수정.
- 적색일 때 "다음 녹색까지" 시간은 이 피드에 없어 표시하지 못한다.
- 교차로맵 일부 행의 좌표 오류는 서울 범위로 필터링.
