'use strict';

const NEARBY_RADIUS_M = 800;   // 이 반경 안의 교차로만 신호 폴링
const MAX_POLL = 12;           // 서버 제한과 동일
const REFRESH_MS = 15000;      // t-data 게이트웨이 호출 한도 고려

const $status = document.getElementById('status');
const $sheet = document.getElementById('sheet');
const $nearby = document.getElementById('nearby');
const $locate = document.getElementById('locate');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const map = L.map('map', { zoomControl: true }).setView([37.5665, 126.978], 16);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const LIVE_STYLE = { radius: 9, weight: 2, color: '#0b0f17', fillColor: '#f59e0b', fillOpacity: 1 };
const DOT_STYLE = { radius: 3, weight: 0, fillColor: '#6b7280', fillOpacity: 0.7 };

let meMarker = null;
let lastPos = null;                    // { lat, lon }
let follow = true;                     // 지도를 현위치에 고정할지
let intersections = [];                // [{ itstId, name, lat, lon }]
const supportDots = new Map();         // itstId -> L.circleMarker (지원 교차로 회색 점)
const live = new Map();                // itstId -> { marker, name, dist, expiresAt }

function setStatus(t) { $status.textContent = t; }

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

map.on('dragstart', () => { follow = false; });
$locate.addEventListener('click', () => {
  follow = true;
  if (lastPos) map.setView([lastPos.lat, lastPos.lon], Math.max(map.getZoom(), 17));
});

navigator.geolocation.watchPosition(onPos, onPosErr, {
  enableHighAccuracy: true, maximumAge: 3000, timeout: 10000,
});

function onPos(p) {
  lastPos = { lat: p.coords.latitude, lon: p.coords.longitude };
  const ll = [lastPos.lat, lastPos.lon];
  if (!meMarker) {
    meMarker = L.circleMarker(ll, {
      radius: 7, weight: 3, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 1,
    }).addTo(map);
    meMarker.bindTooltip('현위치', { direction: 'top' });
  } else {
    meMarker.setLatLng(ll);
  }
  if (follow) map.setView(ll, Math.max(map.getZoom(), 16), { animate: false });
}

function onPosErr() {
  setStatus('위치 권한을 허용해 주세요.');
}

async function loadIntersections() {
  try {
    const r = await fetch('/api/intersections');
    if (!r.ok) {
      setStatus(r.status === 503 ? '서버에 서울시 API 키가 없습니다' : `교차로 목록 오류 (${r.status})`);
      return;
    }
    intersections = (await r.json()).intersections || [];
    for (const it of intersections) {
      if (supportDots.has(it.itstId)) continue;
      const dot = L.circleMarker([it.lat, it.lon], DOT_STYLE).addTo(map);
      dot.bindTooltip(it.name, { direction: 'top' });
      supportDots.set(it.itstId, dot);
    }
    setStatus(`지원 교차로 ${intersections.length}개`);
  } catch {
    setStatus('교차로 목록을 불러오지 못했습니다');
  }
}

function refPoint() {
  if (lastPos) return lastPos;
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

async function refresh() {
  if (!intersections.length) return;
  const ref = refPoint();
  const near = intersections
    .map((it) => ({ it, d: haversine(ref.lat, ref.lon, it.lat, it.lon) }))
    .filter((x) => x.d <= NEARBY_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_POLL);

  if (!near.length) {
    clearLive();
    setStatus(`주변 ${NEARBY_RADIUS_M}m 내 지원 교차로가 없습니다`);
    return;
  }
  try {
    const r = await fetch('/api/signals?itstId=' + near.map((x) => x.it.itstId).join(','));
    if (!r.ok) { setStatus(`신호 정보 오류 (${r.status})`); return; }
    applySignals((await r.json()).signals || [], near);
  } catch {
    setStatus('신호 정보 네트워크 오류');
  }
}

function applySignals(list, near) {
  const now = Date.now();
  const distById = new Map(near.map((x) => [x.it.itstId, x.d]));
  const seen = new Set();

  for (const s of list) {
    seen.add(s.id);
    let m = live.get(s.id);
    if (!m) {
      const marker = L.circleMarker([s.lat, s.lon], LIVE_STYLE).addTo(map);
      marker.bindTooltip('', { permanent: true, direction: 'top', className: 'sig-tip', offset: [0, -6] });
      marker.bindPopup(s.name);
      m = { marker };
      live.set(s.id, m);
    }
    m.name = s.name;
    m.dist = distById.get(s.id) ?? null;
    m.expiresAt = now + (s.secondsRemaining || 0) * 1000;
    m.marker.setLatLng([s.lat, s.lon]).setPopupContent(s.name);
    const dot = supportDots.get(s.id);
    if (dot) dot.setStyle({ fillOpacity: 0 });
  }

  for (const [id, m] of live) {
    if (!seen.has(id)) {
      map.removeLayer(m.marker);
      live.delete(id);
      const dot = supportDots.get(id);
      if (dot) dot.setStyle(DOT_STYLE);
    }
  }

  setStatus(live.size ? `내 주변 신호 ${live.size}개` : '주변 신호 데이터가 없습니다');
  renderSheet();
  tick();
}

function clearLive() {
  for (const [id, m] of live) {
    map.removeLayer(m.marker);
    const dot = supportDots.get(id);
    if (dot) dot.setStyle(DOT_STYLE);
  }
  live.clear();
  renderSheet();
}

function renderSheet() {
  const rows = [...live.values()]
    .filter((m) => m.dist != null)
    .sort((a, b) => a.dist - b.dist);
  if (!rows.length) {
    $sheet.hidden = true;
    $nearby.innerHTML = '';
    return;
  }
  $sheet.hidden = false;
  $nearby.innerHTML = rows.map((m) =>
    `<li><span class="nm">${m.name}</span>` +
    `<span class="di">${Math.round(m.dist)}m</span>` +
    `<span class="rt" data-exp="${m.expiresAt}">–<i>초</i></span></li>`
  ).join('');
}

function tick() {
  const now = Date.now();
  for (const m of live.values()) {
    const rem = Math.max(0, Math.round((m.expiresAt - now) / 1000));
    m.marker.setTooltipContent(`<span class="sig">${rem}<i>초</i></span>`);
  }
  for (const el of $nearby.querySelectorAll('.rt')) {
    const rem = Math.max(0, Math.round((Number(el.dataset.exp) - now) / 1000));
    el.firstChild.nodeValue = String(rem);
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
