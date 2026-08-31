'use strict';

let RADIUS_M = 50;              // 30 / 50 / 100 선택
const MAX_POLL = 12;            // 서버 제한과 동일
const MOVE_REFETCH_M = 10;      // 마지막 조회 지점에서 이만큼 이동하면 재조회
const DEBOUNCE_MS = 3000;       // 재조회 최소 간격
const RED_POLL_MS = 20000;      // 카운트다운이 없을 때(전부 적색) 재조회 주기

const $error = document.getElementById('error');
const $status = document.getElementById('status');
const $sheet = document.getElementById('sheet');
const $nearby = document.getElementById('nearby');
const $locate = document.getElementById('locate');
const $radius = document.getElementById('radius');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function setStatus(t) { $status.textContent = t; }
function showError(msg) { $error.textContent = msg; $error.hidden = false; }
function clearError() { $error.hidden = true; }

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('script load failed'));
    document.head.appendChild(el);
  });
}

// ---- 상태 ----
let map = null;
let meMarker = null;
let lastPos = null;                 // { lat, lon } 현재 GPS
let follow = true;
let intersections = [];             // [{ itstId, name, lat, lon }]
const live = new Map();             // itstId -> { marker, state, name, dist, expiresAt }

let lastFetchPos = null;
let lastFetchAt = 0;
let nextRefetchAt = Infinity;
let refreshing = false;

// ---- 부팅: 설정 → 네이버 지도 로드 → 시작 ----
// 네이버가 인증 실패 시 호출하는 전역 콜백. 등록해야 할 도메인을 그대로 보여준다.
window.navermap_authFailure = () =>
  showError(
    `네이버 지도 인증 실패 — NCP 콘솔 > Application > Maps 에서 ` +
    `Web 서비스 URL 에 "${location.origin}" 를 등록하고 Web Dynamic Map 활성화를 확인하세요`
  );

const NAVER_JS = 'https://oapi.map.naver.com/openapi/v3/maps.js';

async function loadNaver(clientId) {
  // 콘솔 개편 전/후 파라미터명이 달라 둘 다 시도한다.
  for (const param of ['ncpKeyId', 'ncpClientId']) {
    try {
      await loadScript(`${NAVER_JS}?${param}=${encodeURIComponent(clientId)}`);
    } catch {
      continue;
    }
    if (window.naver && naver.maps) return true;
  }
  return false;
}

(async function boot() {
  console.info('[traffic-map] NCP Web 서비스 URL 에 등록할 origin:', location.origin);
  let cfg;
  try {
    cfg = await fetch('/api/config').then((r) => r.json());
  } catch {
    showError('설정을 불러오지 못했습니다 (/api/config)');
    return;
  }
  if (!cfg.naverMapClientId) {
    showError('네이버 지도 클라이언트 ID가 설정되지 않았습니다 (NAVER_MAP_CLIENT_ID)');
    return;
  }
  if (!(await loadNaver(cfg.naverMapClientId))) {
    showError(`네이버 지도 로드 실패 — 클라이언트 ID 확인, 그리고 NCP 콘솔에 "${location.origin}" 등록 필요`);
    return;
  }
  try {
    initMap();
  } catch (e) {
    showError('지도 초기화 실패: ' + (e && e.message ? e.message : e));
    return;
  }
  startGeolocation();
  loadIntersections();
  setInterval(loop, 1000);
})();

function initMap() {
  map = new naver.maps.Map('map', {
    center: new naver.maps.LatLng(37.5665, 126.978),
    zoom: 18,
    scaleControl: false,
    mapDataControl: false,
  });
  naver.maps.Event.addListener(map, 'dragstart', () => { follow = false; });
  // 컨테이너 크기가 늦게 잡히는 경우 대비
  setTimeout(() => naver.maps.Event.trigger(map, 'resize'), 300);
}

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    showError('이 브라우저는 위치 기능을 지원하지 않습니다');
    return;
  }
  navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 10000,
  });
}

function onPos(p) {
  lastPos = { lat: p.coords.latitude, lon: p.coords.longitude };
  const ll = new naver.maps.LatLng(lastPos.lat, lastPos.lon);
  if (!meMarker) {
    meMarker = new naver.maps.Marker({
      position: ll, map, zIndex: 1000,
      icon: { content: '<div class="me"></div>', anchor: new naver.maps.Point(12, 12) },
    });
  } else {
    meMarker.setPosition(ll);
  }
  if (follow) map.setCenter(ll);

  if (!lastFetchPos) refresh('init');
  else if (haversine(lastPos.lat, lastPos.lon, lastFetchPos.lat, lastFetchPos.lon) >= MOVE_REFETCH_M) {
    refresh('move');
  }
}

function onPosErr(err) {
  showError(err.code === err.PERMISSION_DENIED
    ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용하세요.'
    : '위치를 가져오지 못했습니다.');
}

async function loadIntersections() {
  try {
    const r = await fetch('/api/intersections');
    if (!r.ok) {
      showError(r.status === 503 ? '서버에 서울시 API 키가 없습니다' : `교차로 목록 오류 (${r.status})`);
      return;
    }
    intersections = (await r.json()).intersections || [];
    clearError();
    if (lastPos) refresh('list');
  } catch {
    showError('교차로 목록을 불러오지 못했습니다');
  }
}

$radius.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-r]');
  if (!b) return;
  RADIUS_M = Number(b.dataset.r);
  for (const el of $radius.children) el.classList.toggle('on', el === b);
  refresh('radius');
});

$locate.addEventListener('click', () => {
  follow = true;
  if (lastPos) map.setCenter(new naver.maps.LatLng(lastPos.lat, lastPos.lon));
});

function loop() {
  tick();
  if (Date.now() >= nextRefetchAt) refresh('timer');
}

async function refresh(reason) {
  if (refreshing || !map || !lastPos || !intersections.length) return;
  if (reason !== 'radius' && reason !== 'move' && Date.now() - lastFetchAt < DEBOUNCE_MS) return;
  refreshing = true;
  try {
    const near = intersections
      .map((it) => ({ it, d: haversine(lastPos.lat, lastPos.lon, it.lat, it.lon) }))
      .filter((x) => x.d <= RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_POLL);

    lastFetchPos = { ...lastPos };
    lastFetchAt = Date.now();

    if (!near.length) {
      clearLive();
      setStatus(`${RADIUS_M}m 이내 신호등 없음`);
      nextRefetchAt = Date.now() + RED_POLL_MS;
      return;
    }

    const ids = near.map((x) => x.it.itstId).join(',');
    const r = await fetch('/api/signals?itstId=' + encodeURIComponent(ids));
    if (!r.ok) {
      showError(`신호 정보 오류 (${r.status})`);
      nextRefetchAt = Date.now() + DEBOUNCE_MS;
      return;
    }
    const signals = (await r.json()).signals || [];
    clearError();
    applySignals(signals, near);

    const rems = signals.filter((s) => s.state === 'GREEN' && s.secondsRemaining > 0)
      .map((s) => s.secondsRemaining);
    nextRefetchAt = Date.now() + (rems.length ? Math.min(...rems) * 1000 : RED_POLL_MS);
  } catch {
    showError('신호 정보 네트워크 오류');
    nextRefetchAt = Date.now() + DEBOUNCE_MS;
  } finally {
    refreshing = false;
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
      m = {
        marker: new naver.maps.Marker({
          position: new naver.maps.LatLng(s.lat, s.lon), map,
          icon: { content: '', anchor: new naver.maps.Point(22, 14) },
        }),
      };
      live.set(s.id, m);
    }
    m.state = s.state;
    m.name = s.name;
    m.dist = distById.get(s.id) ?? null;
    m.expiresAt = now + (s.secondsRemaining || 0) * 1000;
    m.marker.setPosition(new naver.maps.LatLng(s.lat, s.lon));
  }
  for (const [id, m] of live) {
    if (!seen.has(id)) { m.marker.setMap(null); live.delete(id); }
  }

  setStatus(live.size ? `내 주변 신호등 ${live.size}개` : `${RADIUS_M}m 이내 신호 데이터 없음`);
  render(now);
}

function clearLive() {
  for (const m of live.values()) m.marker.setMap(null);
  live.clear();
  render(Date.now());
}

function badge(state, expiresAt, now) {
  if (state === 'GREEN') {
    const rem = Math.max(0, Math.round((expiresAt - now) / 1000));
    return { cls: 'green', text: `${rem}<i>초</i>` };
  }
  return { cls: 'red', text: '적색' };
}

function tick() { render(Date.now()); }

function render(now) {
  for (const m of live.values()) {
    const b = badge(m.state, m.expiresAt, now);
    m.marker.setIcon({
      content: `<div class="sig ${b.cls}">${b.text}</div>`,
      anchor: new naver.maps.Point(22, 14),
    });
  }
  const rows = [...live.values()].filter((m) => m.dist != null).sort((a, b) => a.dist - b.dist);
  if (!rows.length) { $sheet.hidden = true; $nearby.innerHTML = ''; return; }
  $sheet.hidden = false;
  $nearby.innerHTML = rows.map((m) => {
    const b = badge(m.state, m.expiresAt, now);
    return `<li><span class="nm">${m.name}</span>` +
      `<span class="di">${Math.round(m.dist)}m</span>` +
      `<span class="rt ${b.cls}">${b.text}</span></li>`;
  }).join('');
}
