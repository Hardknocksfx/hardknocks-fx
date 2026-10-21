// api.js — Dashboard data layer for Hardknocks Fx XAUUSD Engine

const API_BASE = 'http://localhost:3000/api';
const REFRESH_INTERVAL = 15000; // 15s polling

// ─── Fetch helpers ───────────────────────────────────────────────
async function fetchJSON(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}`);
    return await res.json();
  } catch (err) {
    console.error(`[API] Failed to fetch ${endpoint}:`, err.message);
    return null;
  }
}

// ─── Status label mapping ────────────────────────────────────────
const STATUS_LABELS = {
  PENDING:     { text: 'PENDING',     cls: 'status-pending' },
  ACTIVE:      { text: 'ACTIVE',      cls: 'status-active' },
  WIN:         { text: 'WIN',         cls: 'status-win' },
  LOSS:        { text: 'LOSS',        cls: 'status-loss' },
  INVALIDATED: { text: 'INVALIDATED', cls: 'status-invalidated' },
  EXPIRED:     { text: 'EXPIRED',     cls: 'status-expired' },
};

function statusBadge(status) {
  const s = STATUS_LABELS[status?.toUpperCase()] || { text: status, cls: 'status-unknown' };
  return `<span class="badge ${s.cls}">${s.text}</span>`;
}

// ─── Render: Summary stats ───────────────────────────────────────
function renderSummary(summary) {
  document.getElementById('completed-trades').textContent = summary.completed ?? 0;
  document.getElementById('win-rate').textContent =
    summary.completed > 0 ? `${summary.winRate}%` : '—';
  document.getElementById('avg-r-multiple').textContent =
    summary.avgR !== undefined && summary.avgR !== null ? summary.avgR.toFixed(2) : '—';
  document.getElementById('expectancy').textContent =
    summary.expectancy !== undefined && summary.expectancy !== null
      ? summary.expectancy.toFixed(2) + 'R' : '—';
}

// ─── Render: Live signals feed ───────────────────────────────────
function renderLiveSignals(signals) {
  const container = document.getElementById('live-feed');
  if (!signals || signals.length === 0) {
    container.innerHTML = '<p class="empty-msg">No pending or confirmed active XAU/USD signals are available.</p>';
    return;
  }

  container.innerHTML = signals.map(sig => `
    <div class="signal-card">
      <div class="signal-header">
        <span class="order-type ${sig.direction?.toLowerCase()}">${sig.orderType || sig.side}</span>
        <span class="symbol">${sig.sym || sig.symbol}</span>
        ${statusBadge(sig.status)}
      </div>
      <div class="signal-body">
        <div><strong>Entry:</strong> ${fmt(sig.entry)}</div>
        <div><strong>SL:</strong> ${fmt(sig.sl)}</div>
        <div><strong>TP:</strong> ${fmt(sig.tp)}</div>
        <div><strong>R:R:</strong> ${sig.rr}:1</div>
        <div><strong>Score:</strong> ${sig.score}/10</div>
      </div>
      ${sig.confluence?.length ? `<div class="confluence">${sig.confluence.join(' · ')}</div>` : ''}
      <div class="signal-meta">Published: ${timeAgo(sig.published_at)}</div>
    </div>
  `).join('');
}

// ─── Render: Track record table ──────────────────────────────────
function renderTrackRecord(data) {
  const container = document.getElementById('track-record');
  const signals = data.signals || [];

  if (signals.length === 0) {
    container.innerHTML = '<p class="empty-msg">No completed trades with verified R results yet.</p>';
    return;
  }

  container.innerHTML = signals.map(sig => `
    <div class="track-row">
      <span class="order-type ${sig.direction?.toLowerCase()}">${sig.orderType || sig.side}</span>
      <span class="sym">${sig.sym || sig.symbol}</span>
      <span class="entry">${fmt(sig.entry)}</span>
      <span class="sl">${fmt(sig.sl)}</span>
      <span class="tp">${fmt(sig.tp)}</span>
      <span class="rr">${sig.rr}:1</span>
      ${statusBadge(sig.status)}
      ${sig.r_multiple !== null && sig.r_multiple !== undefined
        ? `<span class="r-result ${sig.r_multiple >= 0 ? 'pos' : 'neg'}">${sig.r_multiple >= 0 ? '+' : ''}${sig.r_multiple}R</span>`
        : ''}
    </div>
  `).join('');

  // Update footer counts
  const liveCount = signals.filter(s => ['PENDING','ACTIVE'].includes(s.status?.toUpperCase())).length;
  const histCount = signals.filter(s => !['PENDING','ACTIVE'].includes(s.status?.toUpperCase())).length;
  document.getElementById('footer-info').textContent =
    `Updated ${new Date().toLocaleTimeString()} · ${liveCount} live records · ${histCount} history records`;
}

// ─── Utilities ───────────────────────────────────────────────────
function fmt(n) {
  return n != null ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—';
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Main refresh cycle ──────────────────────────────────────────
async function refreshDashboard() {
  const [liveRes, trackRes] = await Promise.all([
    fetchJSON('/signals/live'),
    fetchJSON('/track-record'),
  ]);

  if (liveRes?.success) renderLiveSignals(liveRes.signals);
  if (trackRes?.success) {
    renderSummary(trackRes.summary);
    renderTrackRecord(trackRes);
  }
}

// ─── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  refreshDashboard();
  setInterval(refreshDashboard, REFRESH_INTERVAL);
});