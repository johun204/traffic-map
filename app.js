'use strict';

const MAX_POLL = 20;            // 서버 제한과 동일
const MAX_LEVEL = 6;           // 카카오 지도 level 이 이보다 크면(축소) 조회 안 함
const MOVE_REFETCH_M = 10;
const DEBOUNCE_MS = 3000;
const RED_POLL_MS = 20000;
const TILT_MAX = 45;

const $ = (id) => document.getElementById(id);
const $error = $('error'), $status = $('status'), $sheet = $('sheet'), $nearby = $('nearby');
const $locate = $('locate'), $toast = $('toast'), $mapEl = $('map'), $mapwrap = $('mapwrap');
const $popup = $('popup'), $popupBody = $('popup-body');
const $devToggle = $('devtoggle'), $devChk = $('devchk'), $devPanel = $('devpanel');
const $devState = $('dev-state'), $devLog = $('dev-log');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function setStatus(t) { $status.textContent = t; }
function showError(m) { $error.textContent = m; $error.hidden = false; }
function clearError() { $error.hidden = true; }

let toastTimer = null;
function showToast(m) {
  $toast.textContent = m;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = res; el.onerror = () => rej(new Error('load fail'));
    document.head.appendChild(el);
  });
}

// ---------- 개발자 모드 ----------
const devLog = [];
function devUnlocked() { return localStorage.getItem('devUnlocked') === '1'; }
function devOn() { return localStorage.getItem('devMode') === '1'; }

async function apiFetch(url) {
  const t0 = performance.now();
  const e = { time: new Date().toLocaleTimeString(), url, status: '…', ms: 0 };
  devLog.unshift(e);
  if (devLog.length > 60) devLog.pop();
  try {
    const r = await fetch(url);
    e.status = r.status; e.ms = Math.round(performance.now() - t0);
    renderDev();
    return r;
  } catch (err) {
    e.status = 'ERR'; e.ms = Math.round(performance.now() - t0);
    renderDev();
    throw err;
  }
}

function renderDev() {
  if ($devPanel.hidden) return;
  const b = map && map.getBounds();
  $devState.textContent = [
    `mode=${mode} follow-heading=${headingLock}`,
    `heading=${heading() == null ? '-' : Math.round(heading()) + '°'} tilt=${Math.round(tilt)}°`,
    `level=${map ? map.getLevel() : '-'} live=${live.size} intersections=${intersections.length}`,
    `pos=${lastPos ? lastPos.lat.toFixed(5) + ',' + lastPos.lon.toFixed(5) : '-'}`,
    b ? `bounds=${b.getSouthWest().getLat().toFixed(4)},${b.getSouthWest().getLng().toFixed(4)} ~ ${b.getNorthEast().getLat().toFixed(4)},${b.getNorthEast().getLng().toFixed(4)}` : '',
  ].join('\n');
  $devLog.innerHTML = devLog.map((x) => {
    const cls = x.status === 200 ? 'ok' : (x.status === 'ERR' || x.status >= 400 ? 'err' : '');
    return `<li><span class="${cls}">${x.status}</span> ${x.ms}ms · ${x.time} · ${x.url}</li>`;
  }).join('');
}

function initDev() {
  if (devUnlocked()) $devToggle.hidden = false;
  $devChk.checked = devOn();
  $devPanel.hidden = !devOn();

  let taps = 0, tt = null;
  $status.addEventListener('click', () => {
    taps++;
    clearTimeout(tt);
    tt = setTimeout(() => { taps = 0; }, 1800);
    if (taps >= 7) {
      taps = 0;
      localStorage.setItem('devUnlocked', '1');
      $devToggle.hidden = false;
      showToast('개발자 모드 잠금 해제');
    }
  });
  $devChk.addEventListener('change', () => {
    localStorage.setItem('devMode', $devChk.checked ? '1' : '0');
    $devPanel.hidden = !$devChk.checked;
    renderDev();
  });
  $('dev-clear').addEventListener('click', () => { devLog.length = 0; renderDev(); });
}

// ---------- 상태 ----------
let map = null;
let mode = 'idle';               // 'idle' | 'follow' | 'compass'
let headingLock = false;         // compass 모드에서 지도 회전 여부
let lastPos = null;
let deviceHeading = null;        // deviceorientation 기반(도, 0=북, 시계방향)
let gpsHeading = null;           // GPS 기반 fallback
let tilt = 0;
let intersections = [];
const live = new Map();          // itstId -> { overlay, el, state, name, lat, lon, dist, expiresAt }
let meOverlay = null, meEl = null;

let lastFetchPos = null, lastFetchAt = 0, nextRefetchAt = Infinity, refreshing = false;
let openPopupId = null;

function heading() {
  if (deviceHeading != null) return deviceHeading;
  if (gpsHeading != null && !Number.isNaN(gpsHeading)) return gpsHeading;
  return null;
}

// ---------- 부팅 ----------
async function loadKakao(appkey) {
  try {
    await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appkey)}&autoload=false`);
  } catch { return false; }
  if (typeof kakao === 'undefined' || !kakao.maps || !kakao.maps.load) return false;
  return await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    try { kakao.maps.load(() => { clearTimeout(t); resolve(!!(kakao.maps && kakao.maps.Map)); }); }
    catch { clearTimeout(t); resolve(false); }
  });
}

(async function boot() {
  console.info('[traffic-map] Kakao 플랫폼 Web 사이트 도메인에 등록할 origin:', location.origin);
  initDev();

  let cfg;
  try { cfg = await apiFetch('/api/config').then((r) => r.json()); }
  catch { showError('설정을 불러오지 못했습니다 (/api/config)'); return; }
  if (!cfg.kakaoMapAppKey) { showError('카카오맵 JavaScript 키가 설정되지 않았습니다 (KAKAO_MAP_APP_KEY)'); return; }
  if (!(await loadKakao(cfg.kakaoMapAppKey))) {
    showError(`카카오맵 로드 실패 — JavaScript 키 확인, 그리고 Kakao Developers > 플랫폼 > Web 에 "${location.origin}" 등록 및 카카오맵 활성화를 확인하세요`);
    return;
  }
  try { initMap(); } catch (e) { showError('지도 초기화 실패: ' + (e && e.message || e)); return; }
  startGeolocation();
  startOrientation();
  loadIntersections();
  setInterval(loop, 1000);
})();

function initMap() {
  map = new kakao.maps.Map($mapEl, { center: new kakao.maps.LatLng(37.5665, 126.978), level: 3 });
  kakao.maps.event.addListener(map, 'dragstart', () => setMode('idle'));
  kakao.maps.event.addListener(map, 'idle', onMapIdle);
  setTimeout(() => map.relayout(), 200);
  setupTilt();
}

let idleTimer = null;
function onMapIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => refresh('viewport'), 350);
}

// ---------- 위치 ----------
function startGeolocation() {
  if (!('geolocation' in navigator)) { showError('이 브라우저는 위치 기능을 지원하지 않습니다'); return; }
  navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
}
function onPos(p) {
  lastPos = { lat: p.coords.latitude, lon: p.coords.longitude };
  gpsHeading = (p.coords.speed && p.coords.speed > 0.5) ? p.coords.heading : gpsHeading;
  drawMe();
  if (mode !== 'idle') map.setCenter(new kakao.maps.LatLng(lastPos.lat, lastPos.lon));
  applyTransform();

  if (!lastFetchPos) refresh('init');
  else if (haversine(lastPos.lat, lastPos.lon, lastFetchPos.lat, lastFetchPos.lon) >= MOVE_REFETCH_M) refresh('move');
}
function onPosErr(err) {
  showError(err.code === err.PERMISSION_DENIED
    ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용하세요.'
    : '위치를 가져오지 못했습니다.');
}

// ---------- 방향(나침반) ----------
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;           // iOS
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;        // 표준 절대
  if (h == null) return;
  const scr = (screen.orientation && screen.orientation.angle) || 0;
  deviceHeading = (h + scr + 360) % 360;
  drawMe();
  if (headingLock) applyTransform();
}
function startOrientation() {
  window.addEventListener('deviceorientationabsolute', onOrient, true);
  window.addEventListener('deviceorientation', onOrient, true);
}
async function ensureOrientationPermission() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') {
    try { return (await D.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true;
}

// ---------- 현위치 마커 ----------
function drawMe() {
  if (!map || !lastPos) return;
  const ll = new kakao.maps.LatLng(lastPos.lat, lastPos.lon);
  if (!meOverlay) {
    meEl = document.createElement('div');
    meEl.className = 'me';
    meEl.innerHTML = '<div class="me-fan"></div><div class="me-dot"></div><div class="me-arrow"></div>';
    meOverlay = new kakao.maps.CustomOverlay({ position: ll, content: meEl, xAnchor: 0.5, yAnchor: 0.5, zIndex: 100 });
    meOverlay.setMap(map);
  } else {
    meOverlay.setPosition(ll);
  }
  const h = heading();
  meEl.classList.toggle('compass', mode === 'compass');
  meEl.querySelector('.me-arrow').style.display = (h == null) ? 'none' : 'block';
  // 지도(#map)가 compass 에서 -heading 회전하므로, 로컬 rotate(heading) 이면 어느 모드든 올바른 화면방향이 된다.
  meEl.style.transform = (h == null) ? 'none' : `rotate(${h}deg)`;
}

// ---------- 모드 ----------
async function setMode(next) {
  if (next === 'compass') {
    await ensureOrientationPermission();
    if (heading() == null) showToast('방향 센서를 사용할 수 없습니다');
    headingLock = true;
  } else {
    headingLock = false;
  }
  mode = next;
  $locate.classList.toggle('follow', next === 'follow');
  $locate.classList.toggle('compass', next === 'compass');
  updateBigClass();
  if (mode !== 'idle' && lastPos) map.setCenter(new kakao.maps.LatLng(lastPos.lat, lastPos.lon));
  drawMe();
  applyTransform();
}

$locate.addEventListener('click', async () => {
  if (mode === 'idle') await setMode('follow');
  else if (mode === 'follow') await setMode('compass');
  else await setMode('follow');
});

// ---------- 회전 + 틸트 (카카오 SDK 미지원 → CSS 변환) ----------
// ponytail: 카카오맵 JS SDK 는 bearing/tilt 네이티브 미지원. #map 을 CSS transform 으로 흉내낸다.
function mapRotZ() { return (mode === 'compass' && headingLock && heading() != null) ? -heading() : 0; }
function needsBig() { return mapRotZ() !== 0 || tilt > 1; }
function updateBigClass() {
  const big = needsBig();
  if ($mapEl.classList.contains('big') !== big) {
    $mapEl.classList.toggle('big', big);
    if (map) setTimeout(() => map.relayout(), 0);
  }
}
function applyTransform() {
  updateBigClass();
  const z = mapRotZ();
  $mapEl.style.transform = $mapEl.classList.contains('big')
    ? `perspective(900px) rotateX(${tilt}deg) rotateZ(${z}deg)`
    : 'none';
  const inv = z ? `rotate(${-z}deg)` : 'none';
  for (const m of live.values()) m.el.style.transform = inv;
  if (meEl) {
    const h = heading();
    meEl.style.transform = (h == null) ? 'none' : `rotate(${h}deg)`;
  }
}

function setupTilt() {
  let baseY = null, baseDist = null, baseTilt = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const midY = (t) => (t[0].clientY + t[1].clientY) / 2;
  $mapwrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { baseY = midY(e.touches); baseDist = dist(e.touches); baseTilt = tilt; }
  }, { passive: true });
  $mapwrap.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || baseY == null) return;
    const dY = midY(e.touches) - baseY;
    const dD = Math.abs(dist(e.touches) - baseDist);
    if (dD > 24) return;                       // 핀치 줌 제스처는 카카오에 양보
    e.preventDefault();
    tilt = Math.max(0, Math.min(TILT_MAX, baseTilt - dY * 0.25));
    applyTransform();
  }, { passive: false });
  $mapwrap.addEventListener('touchend', (e) => { if (e.touches.length < 2) baseY = null; }, { passive: true });
}

// ---------- 신호 조회 ----------
async function loadIntersections() {
  try {
    const r = await apiFetch('/api/intersections');
    if (!r.ok) { showError(r.status === 503 ? '서버에 서울시 API 키가 없습니다' : `교차로 목록 오류 (${r.status})`); return; }
    intersections = (await r.json()).intersections || [];
    clearError();
    refresh('list');
  } catch { showError('교차로 목록을 불러오지 못했습니다'); }
}

function inViewIntersections() {
  const b = map.getBounds();
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  // #map 이 확대(180%)돼 있으면 실제 뷰포트는 중앙 ~55%. 회전 시 여유분 포함해 대략 필터.
  const f = $mapEl.classList.contains('big') ? 0.30 : 0.5;
  const cLat = (sw.getLat() + ne.getLat()) / 2, cLng = (sw.getLng() + ne.getLng()) / 2;
  const dLat = (ne.getLat() - sw.getLat()) * f, dLng = (ne.getLng() - sw.getLng()) * f;
  const ref = lastPos || { lat: cLat, lon: cLng };
  return intersections
    .filter((it) => it.lat >= cLat - dLat && it.lat <= cLat + dLat && it.lon >= cLng - dLng && it.lon <= cLng + dLng)
    .map((it) => ({ it, d: haversine(ref.lat, ref.lon, it.lat, it.lon) }))
    .sort((a, b) => a.d - b.d);
}

async function refresh(reason) {
  if (refreshing || !map || !intersections.length) return;
  if (reason !== 'radius' && reason !== 'move' && reason !== 'viewport' && Date.now() - lastFetchAt < DEBOUNCE_MS) return;
  refreshing = true;
  try {
    if (map.getLevel() > MAX_LEVEL) {
      clearLive();
      setStatus('지도를 확대하세요');
      showToast('확대해야 신호등 정보를 표시할 수 있습니다');
      nextRefetchAt = Infinity;
      return;
    }
    const near = inViewIntersections().slice(0, MAX_POLL);
    lastFetchPos = lastPos ? { ...lastPos } : null;
    lastFetchAt = Date.now();

    if (!near.length) { clearLive(); setStatus('화면 안에 지원 신호등이 없습니다'); nextRefetchAt = Date.now() + RED_POLL_MS; return; }

    const ids = near.map((x) => x.it.itstId).join(',');
    const r = await apiFetch('/api/signals?itstId=' + encodeURIComponent(ids));
    if (!r.ok) { showError(`신호 정보 오류 (${r.status})`); nextRefetchAt = Date.now() + DEBOUNCE_MS; return; }
    const signals = (await r.json()).signals || [];
    clearError();
    applySignals(signals, near);

    const rems = signals.filter((s) => s.state === 'GREEN' && s.secondsRemaining > 0).map((s) => s.secondsRemaining);
    nextRefetchAt = Date.now() + (rems.length ? Math.min(...rems) * 1000 : RED_POLL_MS);
  } catch {
    showError('신호 정보 네트워크 오류');
    nextRefetchAt = Date.now() + DEBOUNCE_MS;
  } finally {
    refreshing = false;
    renderDev();
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
      const el = document.createElement('div');
      el.addEventListener('click', () => openPopup(s.id));
      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(s.lat, s.lon), content: el, xAnchor: 0.5, yAnchor: 0.5,
      });
      overlay.setMap(map);
      m = { overlay, el };
      live.set(s.id, m);
    }
    Object.assign(m, { state: s.state, name: s.name, lat: s.lat, lon: s.lon, dist: distById.get(s.id) ?? null, expiresAt: now + (s.secondsRemaining || 0) * 1000 });
    m.overlay.setPosition(new kakao.maps.LatLng(s.lat, s.lon));
  }
  for (const [id, m] of live) if (!seen.has(id)) { m.overlay.setMap(null); live.delete(id); if (openPopupId === id) closePopup(); }

  setStatus(live.size ? `화면 내 신호등 ${live.size}개` : '화면 안에 신호 데이터가 없습니다');
  render(now);
}

function clearLive() {
  for (const m of live.values()) m.overlay.setMap(null);
  live.clear();
  closePopup();
  render(Date.now());
}

function badge(state, expiresAt, now) {
  if (state === 'GREEN') return { cls: 'green', text: `${Math.max(0, Math.round((expiresAt - now) / 1000))}<i>초</i>` };
  return { cls: 'red', text: '적색' };
}

function loop() {
  const now = Date.now();
  render(now);
  if (openPopupId) renderPopup();
  if (now >= nextRefetchAt) refresh('timer');
}

function render(now) {
  const z = mapRotZ();
  const inv = z ? `rotate(${-z}deg)` : 'none';
  for (const m of live.values()) {
    const b = badge(m.state, m.expiresAt, now);
    m.el.className = 'sig ' + b.cls;
    m.el.innerHTML = b.text;
    m.el.style.transform = inv;
  }
  const rows = [...live.values()].filter((m) => m.dist != null).sort((a, b) => a.dist - b.dist);
  if (!rows.length) { $sheet.hidden = true; $nearby.innerHTML = ''; return; }
  $sheet.hidden = false;
  $nearby.innerHTML = rows.map((m) => {
    const b = badge(m.state, m.expiresAt, now);
    return `<li><span class="nm">${m.name}</span><span class="di">${Math.round(m.dist)}m</span><span class="rt ${b.cls}">${b.text}</span></li>`;
  }).join('');
}

// ---------- 팝업 ----------
function openPopup(id) { openPopupId = id; $popup.hidden = false; renderPopup(); }
function closePopup() { openPopupId = null; $popup.hidden = true; }
$('popup-close').addEventListener('click', closePopup);
$popup.addEventListener('click', (e) => { if (e.target === $popup) closePopup(); });

function renderPopup() {
  const m = live.get(openPopupId);
  if (!m) { closePopup(); return; }
  const rem = m.state === 'GREEN' ? Math.max(0, Math.round((m.expiresAt - Date.now()) / 1000)) + '초' : '-';
  const ago = Math.round((Date.now() - lastFetchAt) / 1000);
  $popupBody.innerHTML =
    `<h3>${m.name}</h3>` +
    row('상태', m.state === 'GREEN' ? '보행 녹색' : '적색', m.state === 'GREEN' ? 'green' : 'red') +
    row('잔여', rem) +
    row('거리', m.dist != null ? Math.round(m.dist) + 'm' : '-') +
    row('교차로 ID', openPopupId) +
    row('좌표', m.lat.toFixed(6) + ', ' + m.lon.toFixed(6)) +
    row('갱신', ago + '초 전');
}
function row(k, v, cls) { return `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`; }
