'use strict';

const NEARBY_RADIUS_M = 800;   // 이 반경 안의 교차로만 폴링
const MAX_POLL = 12;           // 서버 제한과 동일
const REFRESH_MS = 5000;

const $status = document.getElementById('status');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const map = L.map('map', { zoomControl: true }).setView([37.5665, 126.978], 16);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

let meMarker = null;
let intersections = [];                 // [{ itstId, name, lat, lon }]
const supportDots = new Map();          // itstId -> L.circleMarker (회색 점)
const live = new Map();                 // itstId -> { marker, state, expiresAt }

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const LIVE_STYLE = { radius: 9, weight: 2, color: '#0b0f17', fillColor: '#f59e0b', fillOpacity: 1 };
function setStatus(t) { $status.textContent = t; }

navigator.geolocation.watchPosition(
  (p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) {
      meMarker = L.circleMarker(ll, {
        radius: 7, weight: 3, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 1,
      }).addTo(map);
      map.setView(ll, 16);
    } else {
      meMarker.setLatLng(ll);
    }
  },
  () => setStatus('위치를 가져오지 못했습니다. 권한을 확인하세요.'),
  { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 },
);

async function loadIntersections() {
  try {
    const r = await fetch('/api/intersections');
    if (!r.ok) {
      setStatus(r.status === 503 ? '서버에 서울시 API 키가 설정되지 않았습니다' : '교차로 목록을 불러오지 못했습니다');
      return;
    }
    intersections = (await r.json()).intersections || [];
    for (const it of intersections) {
      if (supportDots.has(it.itstId)) continue;
      const dot = L.circleMarker([it.lat, it.lon], {
        radius: 3, weight: 0, fillColor: '#6b7280', fillOpacity: 0.7,
      }).addTo(map);
      dot.bindTooltip(it.name, { direction: 'top' });
      supportDots.set(it.itstId, dot);
    }
    setStatus(`지원 교차로 ${intersections.length}개 · 주변 신호 조회 중`);
  } catch {
    setStatus('네트워크 오류 (교차로 목록)');
  }
}

function nearbyIds() {
  const c = map.getCenter();
  return intersections
    .map((it) => ({ it, d: haversine(c.lat, c.lng, it.lat, it.lon) }))
    .filter((x) => x.d <= NEARBY_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_POLL)
    .map((x) => x.it.itstId);
}

async function refresh() {
  if (!intersections.length) return;
  const ids = nearbyIds();
  if (!ids.length) {
    clearLive();
    setStatus('이 부근에는 지원되는 신호가 없습니다');
    return;
  }
  try {
    const r = await fetch('/api/signals?itstId=' + ids.join(','));
    if (!r.ok) { setStatus('신호 정보를 불러오지 못했습니다'); return; }
    applySignals((await r.json()).signals || []);
  } catch {
    setStatus('네트워크 오류 (신호)');
  }
}

function applySignals(list) {
  const now = Date.now();
  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    let m = live.get(s.id);
    if (!m) {
      const marker = L.circleMarker([s.lat, s.lon], LIVE_STYLE).addTo(map);
      marker.bindTooltip('', { permanent: true, direction: 'top', className: 'sig-tip', offset: [0, -6] });
      m = { marker, name: s.name };
      live.set(s.id, m);
    }
    m.expiresAt = now + (s.secondsRemaining || 0) * 1000;
    m.marker.setLatLng([s.lat, s.lon]);
    const dot = supportDots.get(s.id);
    if (dot) dot.setStyle({ fillOpacity: 0 });
  }
  for (const [id, m] of live) {
    if (!seen.has(id)) {
      map.removeLayer(m.marker);
      live.delete(id);
      const dot = supportDots.get(id);
      if (dot) dot.setStyle({ fillOpacity: 0.7 });
    }
  }
  setStatus(live.size ? `실시간 신호 ${live.size}개 / 지원 교차로 ${intersections.length}개` : '주변 신호 데이터가 없습니다');
  tick();
}

function clearLive() {
  for (const [id, m] of live) {
    map.removeLayer(m.marker);
    const dot = supportDots.get(id);
    if (dot) dot.setStyle({ fillOpacity: 0.7 });
  }
  live.clear();
}

function tick() {
  const now = Date.now();
  for (const m of live.values()) {
    const rem = Math.max(0, Math.round((m.expiresAt - now) / 1000));
    m.marker.setTooltipContent(`<span class="sig">${rem}<i>초</i></span>`);
  }
}

let moveTimer;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(refresh, 400);
});
setInterval(refresh, REFRESH_MS);
setInterval(tick, 1000);

loadIntersections().then(refresh);
