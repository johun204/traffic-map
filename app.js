'use strict';

const RADIUS_M = 50;
const FETCH_INTERVAL_MS = 5000;
const REFETCH_MOVE_M = 20;

const $list = document.getElementById('list');
const $status = document.getElementById('status');
const $coords = document.getElementById('coords');
const $source = document.getElementById('source');
const $retry = document.getElementById('retry');

let pos = null;          // { lat, lon }
let lastFetchPos = null;
let lastFetchAt = 0;
let signals = [];        // [{ id, name, lat, lon, state, expiresAt }]

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function stateClass(state) {
  if (state === 'GREEN') return 'green';
  if (state === 'YELLOW') return 'amber';
  return 'red';
}
function stateLabel(state) {
  if (state === 'GREEN') return '보행 녹색';
  if (state === 'YELLOW') return '점멸';
  return '적색';
}

async function fetchSignals() {
  if (!pos) return;
  lastFetchAt = Date.now();
  lastFetchPos = pos;
  try {
    const r = await fetch(`/api/signals?lat=${pos.lat}&lon=${pos.lon}`);
    const data = await r.json();
    const now = Date.now();
    signals = (data.signals || []).map((s) => ({
      id: s.id,
      name: s.name || '신호등',
      lat: s.lat,
      lon: s.lon,
      state: s.state,
      expiresAt: now + (s.secondsRemaining || 0) * 1000,
    }));
    $source.hidden = false;
    $source.textContent = data.source === 'its' ? '실시간(ITS)' : '데모 데이터';
  } catch (e) {
    // 네트워크 실패 시 기존 신호 유지
  }
  render();
}

function render() {
  if (!pos) return;
  $coords.textContent = `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;

  const now = Date.now();
  const near = signals
    .map((s) => ({ ...s, distance: haversine(pos, s), remaining: Math.max(0, Math.round((s.expiresAt - now) / 1000)) }))
    .filter((s) => s.distance <= RADIUS_M)
    .sort((a, b) => a.distance - b.distance);

  if (!near.length) {
    $list.innerHTML = '';
    $status.hidden = false;
    $status.textContent = '50m 이내 신호등이 없습니다.';
    return;
  }

  $status.hidden = true;
  $list.innerHTML = near.map((s) => {
    const cls = stateClass(s.state);
    return `<li class="card">
      <div class="name">${s.name}</div>
      <div class="meta"><span class="state ${cls}">${stateLabel(s.state)}</span> · ${Math.round(s.distance)}m</div>
      <div class="count ${cls}">${s.remaining}<span class="unit">초</span></div>
    </li>`;
  }).join('');
}

function onPosition(p) {
  pos = { lat: p.coords.latitude, lon: p.coords.longitude };
  $retry.hidden = true;

  const moved = lastFetchPos ? haversine(pos, lastFetchPos) : Infinity;
  if (Date.now() - lastFetchAt >= FETCH_INTERVAL_MS || moved >= REFETCH_MOVE_M) {
    fetchSignals();
  } else {
    render();
  }
}

function onPositionError(err) {
  $status.hidden = false;
  $status.textContent = err.code === err.PERMISSION_DENIED
    ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.'
    : '위치를 가져오지 못했습니다.';
  $retry.hidden = false;
}

function start() {
  if (!('geolocation' in navigator)) {
    $status.textContent = '이 브라우저는 위치 기능을 지원하지 않습니다.';
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 10000,
  });
}

$retry.addEventListener('click', start);
setInterval(render, 1000);
start();
