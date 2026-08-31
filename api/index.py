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

BASE = "http://t-data.seoul.go.kr/apig/apiman-gateway/tapi"
MAP_URL = f"{BASE}/v2xCrossroadMapInformation/1.0"
SIG_URL = f"{BASE}/v2xSignalPhaseTimingInformation/1.0"
MAX_ITST = 12
CACHE_TTL = 6 * 3600

app = FastAPI(title="traffic-map api (Seoul C-ITS)")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"]
)

_cache: dict = {"at": 0.0, "list": None, "by_id": {}}


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
    }


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

    async with httpx.AsyncClient(timeout=6.0) as client:
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
    async with httpx.AsyncClient(timeout=8.0) as client:
        for page in range(1, 21):
            r = await client.get(
                MAP_URL,
                params={"apiKey": key, "type": "json", "pageNo": page, "numOfRows": 500},
            )
            r.raise_for_status()
            rows = _rows(r.json())
            if not rows:
                break
            for it in rows:
                lat = _num(it.get("mapCtptIntLat") or it.get("mapY") or it.get("yCrdn"))
                lon = _num(it.get("mapCtptIntLot") or it.get("mapX") or it.get("xCrdn"))
                iid = it.get("itstId") or it.get("inttId")
                if lat is None or lon is None or not iid:
                    continue
                out.append(
                    {"itstId": str(iid), "name": it.get("itstNm") or "교차로", "lat": lat, "lon": lon}
                )
            if len(rows) < 500:
                break
    return out


async def _fetch_signal(client: httpx.AsyncClient, key: str, itst_id: str):
    r = await client.get(SIG_URL, params={"apiKey": key, "type": "json", "itstId": itst_id})
    r.raise_for_status()
    return _normalize_signal(itst_id, r.json())


# ponytail: t-data 응답 필드명 미확인 — 첫 실호출 JSON 보고 _rows / 아래 매핑만 고치면 됨.
def _normalize_signal(itst_id: str, data: dict):
    meta = _cache["by_id"].get(itst_id)
    if not meta:
        return None
    rows = _rows(data)
    best_state = "RED"
    best_remaining = None
    for g in rows:
        state = _state(g.get("signalStngNm") or g.get("signalState") or g.get("currentPhase"))
        rem = _num(g.get("leftSecNm") or g.get("remainingTime") or g.get("remndrCs"))
        if rem is None:
            continue
        rem = round(rem / 10)  # t-data 잔여시간은 1/10초 단위
        if best_remaining is None or rem < best_remaining:
            best_remaining, best_state = rem, state
    if best_remaining is None:
        return None
    return {
        "id": itst_id,
        "name": meta["name"],
        "lat": meta["lat"],
        "lon": meta["lon"],
        "state": best_state,
        "secondsRemaining": best_remaining,
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


def _state(v) -> str:
    s = str(v or "").upper()
    if "GREEN" in s or s in ("G", "03") or "녹" in s or "보행" in s:
        return "GREEN"
    if "YELLOW" in s or s in ("Y", "04") or "황" in s or "점멸" in s:
        return "YELLOW"
    return "RED"


# 로컬에서 단일 프로세스로 정적 파일까지 서빙. Vercel에선 정적은 CDN이 담당하므로 이 mount는 미사용.
if (_ROOT / "index.html").exists():
    app.mount("/", StaticFiles(directory=_ROOT, html=True), name="static")
