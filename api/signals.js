// Vercel serverless function: /api/signals?lat=..&lon=..
// ITS signalPhase API를 프록시(브라우저 CORS 회피 + 키 은닉)하고,
// 키가 없거나 응답이 비면 데모 신호를 돌려준다.

const RADIUS_M = 60; // 클라이언트 50m 필터보다 살짝 넓게

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ error: 'lat, lon required' });
    return;
  }

  const key = process.env.ITS_API_KEY;
  if (!key || process.env.DEMO === '1') {
    res.status(200).json({ source: 'demo', signals: demoSignals(lat, lon) });
    return;
  }

  const dLat = RADIUS_M / 111000;
  const dLon = RADIUS_M / (111000 * Math.cos((lat * Math.PI) / 180));
  const url =
    `https://openapi.its.go.kr:9443/signalPhase?apiKey=${key}&type=json` +
    `&minX=${lon - dLon}&maxX=${lon + dLon}&minY=${lat - dLat}&maxY=${lat + dLat}`;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const json = await r.json();
    const signals = normalize(json);
    if (signals.length) {
      res.status(200).json({ source: 'its', signals });
    } else {
      res.status(200).json({ source: 'its-empty', signals: demoSignals(lat, lon) });
    }
  } catch (e) {
    res.status(200).json({ source: 'error', error: String(e), signals: demoSignals(lat, lon) });
  }
}

// ponytail: ITS signalPhase 실제 응답 필드명 미확인 — 첫 실호출 JSON 보고 이 매핑만 고치면 됨.
function normalize(json) {
  const items = json?.body?.items || [];
  const out = [];
  for (const it of items) {
    const id = it.itstId ?? String(out.length);
    const y = num(it.mapY ?? it.yCrdn);
    const x = num(it.mapX ?? it.xCrdn);
    if (y == null || x == null) continue;
    const groups = it.trafficSignalGroupList || [];
    groups.forEach((g, i) => {
      out.push({
        id: `${id}-${i}`,
        name: it.itstNm || '신호등',
        lat: y,
        lon: x,
        state: toState(g.signalState ?? g.currentPhase),
        secondsRemaining: num(g.remainingTime ?? g.remndrCs) ?? 0,
      });
    });
  }
  return out;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function toState(v) {
  const s = String(v || '').toUpperCase();
  if (['GREEN', 'G', '03'].includes(s)) return 'GREEN';
  if (['YELLOW', 'Y', '04'].includes(s)) return 'RED'; // 보행신호 점멸은 곧 적색 취급
  return 'RED';
}

// 진행방향 무관, 현위치 주변 20~45m 지점에 가상 신호 2개. 63초 주기로 순환.
function demoSignals(lat, lon) {
  const t = Math.floor(Date.now() / 1000) % 63;
  const phase = (offset) => {
    const x = (t + offset) % 63;
    if (x < 30) return { state: 'GREEN', secondsRemaining: 30 - x };
    return { state: 'RED', secondsRemaining: 63 - x };
  };
  return [
    { id: 'demo-1', name: '횡단보도 A', ...offset(lat, lon, 30, 25), ...phase(0) },
    { id: 'demo-2', name: '횡단보도 B', ...offset(lat, lon, 300, 40), ...phase(20) },
  ];
}

function offset(lat, lon, bearingDeg, distM) {
  const R = 6371000;
  const d = distM / R;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}
