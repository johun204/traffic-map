"""FastAPI 백엔드 — 서울시 C-ITS(t-data.seoul.go.kr) 신호 데이터를 프록시한다.

키를 클라이언트에 노출하지 않고, t-data 엔드포인트가 http 라서 https PWA에서 직접 못 부르는 문제도 해결한다.
데모/합성 데이터 없음. 서울시 API가 주는 교차로/신호만 반환한다.

- /api/intersections : 교차로 Map 정보(전체 목록, id·이름·좌표). 일 1회 갱신이라 6h 캐시.
- /api/signals?itstId=a,b,c : 교차로별 신호 현시·잔여시간. 좌표는 교차로 캐시에서 붙여 반환.
"""

import asyncio
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

_ROOT = Path(__file__).resolve().parent.parent

# 로컬 개발 편의: .env 로드 (Vercel은 환경변수를 직접 주입하므로 dotenv 불필요)
try:
    from dotenv import load_dotenv

    load_dotenv(_ROOT / ".env")
except ModuleNotFoundError:
    pass

# http로 두고 follow_redirects로 https 승격을 따라간다 (https 직접 요청이 간헐적으로 응답 지연).
BASE = "http://t-data.seoul.go.kr/apig/apiman-gateway/tapi"
MAP_URL = f"{BASE}/v2xCrossroadMapInformation/1.0"
SIG_URL = f"{BASE}/v2xSignalPhaseTimingInformation/1.0"
MAX_ITST = 12
CACHE_TTL = 6 * 3600
# 일부 환경(해외 IP)에서 apiman 게이트웨이 http→https 리다이렉트 응답이 느리다. 국내에선 보통 1초 이내.
HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
UA = {"User-Agent": "Mozilla/5.0 (traffic-map)"}

app = FastAPI(title="traffic-map api (Seoul C-ITS)")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"]
)

_cache: dict = {"at": 0.0, "list": None, "by_id": {}}
_sig_cache: dict = {}  # itstId -> (ts, result)  게이트웨이 호출 한도 보호용
SIG_TTL = 4.0


# 신호 API와 교차로맵 API 키가 다를 수 있어 개별 지정 가능. 없으면 공통 SEOUL_API_KEY 사용.
def _map_key() -> str:
    k = os.environ.get("SEOUL_MAP_API_KEY") or os.environ.get("SEOUL_API_KEY")
    if not k:
        raise HTTPException(status_code=503, detail="map API key not configured")
    return k


def _sig_key() -> str:
    k = os.environ.get("SEOUL_SIGNAL_API_KEY") or os.environ.get("SEOUL_API_KEY")
    if not k:
        raise HTTPException(status_code=503, detail="signal API key not configured")
    return k


@app.get("/api/health")
@app.get("/health")
def health():
    return {
        "ok": True,
        "map_key": bool(os.environ.get("SEOUL_MAP_API_KEY") or os.environ.get("SEOUL_API_KEY")),
        "signal_key": bool(os.environ.get("SEOUL_SIGNAL_API_KEY") or os.environ.get("SEOUL_API_KEY")),
        "kakao_map_key": bool(os.environ.get("KAKAO_MAP_APP_KEY")),
    }


@app.get("/api/config")
@app.get("/config")
def config():
    # 카카오맵 JavaScript 키(도메인 제한 키). 없으면 빈 문자열 → 프런트가 오류 표시.
    return {"kakaoMapAppKey": os.environ.get("KAKAO_MAP_APP_KEY", "")}


@app.get("/api/intersections")
@app.get("/intersections")
async def intersections():
    await _ensure_intersections()
    return {"intersections": _cache["list"]}


@app.get("/api/signals")
@app.get("/signals")
async def signals(itstId: str = Query(..., description="comma-separated intersection ids")):
    key = _sig_key()
    await _ensure_intersections()
    ids = [s for s in (x.strip() for x in itstId.split(",")) if s][:MAX_ITST]
    if not ids:
        raise HTTPException(status_code=422, detail="itstId required")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True, headers=UA) as client:
        results = await asyncio.gather(
            *[_fetch_signal(client, key, i) for i in ids], return_exceptions=True
        )
    out = [r for r in results if isinstance(r, dict)]
    return {"signals": out}


async def _ensure_intersections() -> None:
    now = time.time()
    if _cache["list"] is not None and now - _cache["at"] < CACHE_TTL:
        return
    data = await _fetch_intersections(_map_key())
    _cache["list"] = data
    _cache["by_id"] = {d["itstId"]: d for d in data}
    _cache["at"] = now


async def _fetch_intersections(key: str) -> list[dict]:
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True, headers=UA) as client:
        for page in range(1, 21):
            r = await _get_retry(
                client, MAP_URL,
                {"apiKey": key, "type": "json", "pageNo": page, "numOfRows": 500},
            )
            r.raise_for_status()
            rows = _rows(r.json())
            if not rows:
                break
            for it in rows:
                lat = _num(it.get("mapCtptIntLat"))
                lon = _num(it.get("mapCtptIntLot"))
                iid = it.get("itstId")
                if not iid or lat is None or lon is None:
                    continue
                if not (37.3 <= lat <= 37.8 and 126.6 <= lon <= 127.3):
                    continue  # 서울 범위 밖 좌표(데이터 오류) 제외
                out.append(
                    {"itstId": str(iid), "name": it.get("itstNm") or "교차로", "lat": lat, "lon": lon}
                )
            if len(rows) < 500:
                break
    return out


async def _get_retry(client: httpx.AsyncClient, url: str, params: dict, tries: int = 2):
    last = None
    for _ in range(tries):
        try:
            return await client.get(url, params=params)
        except httpx.TransportError as exc:
            last = exc
    raise last


async def _fetch_signal(client: httpx.AsyncClient, key: str, itst_id: str):
    hit = _sig_cache.get(itst_id)
    if hit and time.time() - hit[0] < SIG_TTL:
        return hit[1]
    r = await _get_retry(
        client, SIG_URL,
        {"apiKey": key, "type": "json", "itstId": itst_id, "pageNo": 1, "numOfRows": 1},
    )
    r.raise_for_status()
    result = _normalize_signal(itst_id, r.json())
    _sig_cache[itst_id] = (time.time(), result)
    return result


# t-data SPaT: 레코드 배열. {방위}{현시}sgRmdrCs = 잔여시간(1/10초). 36001 = SAE J2735 "미정의".
_SENTINEL = 36000
_DIRS = ("nt", "et", "st", "wt", "ne", "se", "sw", "nw")


def _valid(v):
    v = _num(v)
    return v if (v is not None and 0 < v < _SENTINEL) else None


def _normalize_signal(itst_id: str, data: dict):
    meta = _cache["by_id"].get(itst_id)
    if not meta:
        return None
    rows = _rows(data)
    if not rows:
        return None
    rec = max(rows, key=lambda r: r.get("trsmUtcTime") or 0)

    # ponytail: 보행신호 잔여(1/10초)가 유효하면 현재 '보행 녹색'으로 간주(대다수 KR 보행 C-ITS 관행).
    #           유효값 없으면 '적색'. 다음 녹색까지 시간은 이 피드에 없음. 현장 실측으로 검증 필요.
    walk = [w for d in _DIRS if (w := _valid(rec.get(f"{d}PdsgRmdrCs"))) is not None]
    if walk:
        state, remaining = "GREEN", round(min(walk) / 10)
    elif any(_valid(v) is not None for k, v in rec.items() if k.endswith("RmdrCs")):
        state, remaining = "RED", 0
    else:
        return None  # 이 교차로는 쓸 만한 신호 데이터 없음

    return {
        "id": itst_id,
        "name": meta["name"],
        "lat": meta["lat"],
        "lon": meta["lon"],
        "state": state,
        "secondsRemaining": remaining,
    }


def _rows(data: dict) -> list:
    if isinstance(data, list):
        return data
    body = data.get("body") if isinstance(data, dict) else None
    for container in (body, data):
        if not isinstance(container, dict):
            continue
        for k in ("items", "itemList", "resultData", "row", "list"):
            v = container.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                inner = v.get("item")
                if isinstance(inner, list):
                    return inner
    return []


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# 로컬에서 단일 프로세스로 정적 파일까지 서빙. Vercel에선 정적은 CDN이 담당하므로 이 mount는 미사용.
if (_ROOT / "index.html").exists():
    app.mount("/", StaticFiles(directory=_ROOT, html=True), name="static")
