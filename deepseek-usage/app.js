'use strict';

/* ======================================================================
 * DeepSeek 用量看板（非官方，个人自用）
 *
 * 数据来源：官方文档接口 GET {base}/user/balance（Bearer API Key）。
 * 该接口只返回「当前余额」，不返回 token 用量；所以「消耗」是用本机每次刷新
 * 得到的余额快照做差估算出来的，不是官方用量数据。
 * ====================================================================== */

const KEY = {
  apiKey: 'dsu.apiKey',
  base: 'dsu.apiBase',
  hist: 'dsu.history',
  latest: 'dsu.latest',
  cur: 'dsu.currency',
};
const DEFAULT_BASE = 'https://api.deepseek.com';
const MAX_SNAPSHOTS = 2000;   // 历史上限，超出丢最早的
const HEARTBEAT_MS = 3600e3;  // 余额没变时，每小时最多补一个点，让走势图有时间轴
const STALE_MS = 60e3;        // 回到前台时，数据超过 1 分钟才自动刷新
const AUTO_MS = 5 * 60e3;     // 前台常开时，每 5 分钟自动刷新
const DAY = 86400e3;
const SYMBOL = { CNY: '¥', USD: '$' };

/* ---------------------------- 存储（容错） ---------------------------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
  getJSON(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  setJSON(k, v) { return this.set(k, JSON.stringify(v)); },
};

/* ---------------------------- 纯函数：数据与估算 ---------------------------- */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtNum = (n, dp = 2) => n.toLocaleString('zh-CN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const spendText = (n) => (n <= 0 ? '0.00' : n < 0.01 ? fmtNum(n, 4) : fmtNum(n, 2));
const money = (n, cur, fmt = fmtNum) => (SYMBOL[cur] ? SYMBOL[cur] + fmt(n) : `${fmt(n)} ${cur}`);

function validSnapshot(s) {
  return !!s && typeof s.t === 'number' && !!s.b && typeof s.b === 'object' &&
    Object.keys(s.b).length > 0 &&
    Object.values(s.b).every((v) => v && Number.isFinite(v.total) && Number.isFinite(v.granted) && Number.isFinite(v.topped));
}

/** API 响应 -> 快照。余额字段是字符串（如 "110.00"）。 */
function toSnapshot(data, now = Date.now()) {
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : null;
  if (!infos) throw new ApiError('format', '返回数据里没有 balance_infos 字段');
  const b = {};
  for (const i of infos) {
    const total = Number(i.total_balance);
    if (!i.currency || !Number.isFinite(total)) continue;
    const granted = Number(i.granted_balance);
    const topped = Number(i.topped_up_balance);
    b[i.currency] = {
      total,
      granted: Number.isFinite(granted) ? granted : 0,
      topped: Number.isFinite(topped) ? topped : 0,
    };
  }
  if (!Object.keys(b).length) throw new ApiError('format', '账户没有返回任何币种的余额');
  return { t: now, ok: data.is_available !== false, b };
}

function sameBalances(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((c) => b[c] && a[c].total === b[c].total && a[c].granted === b[c].granted && a[c].topped === b[c].topped);
}

/** 余额变了，或距上一个点超过心跳间隔，才记一个点；返回新的历史数组。 */
function recordSnapshot(hist, snap) {
  const last = hist[hist.length - 1];
  if (last && sameBalances(last.b, snap.b) && snap.t - last.t < HEARTBEAT_MS) return hist;
  const next = hist.concat(snap);
  return next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
}

/**
 * 每日消耗：相邻两次快照间总余额下降的部分，记在后一次快照所在的本地日期。
 * 余额上升（充值）不算消耗，也不会抵扣——所以刷新间隔内「又充值又消耗」会被低估。
 * 返回 Map<'YYYY-MM-DD', number>。
 */
function dailySpend(hist, cur) {
  const map = new Map();
  let prev = null;
  for (const s of hist) {
    const v = s.b[cur];
    if (!v) continue;
    if (prev) {
      const d = Math.round((prev.total - v.total) * 1e6) / 1e6; // 去掉浮点噪声
      if (d > 0) { const k = dayKey(s.t); map.set(k, (map.get(k) || 0) + d); }
    }
    prev = v;
  }
  return map;
}

/** 以 now 所在本地日期为终点，往前 n 天的日期键（旧 -> 新）。 */
function lastDayKeys(n, now) {
  const d0 = new Date(now);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i).getTime()));
  }
  return keys;
}

function computeStats(hist, cur, total, now) {
  const points = hist.filter((s) => s.b[cur]);
  const perDay = dailySpend(hist, cur);
  const keys = lastDayKeys(30, now);
  const series = keys.map((k) => perDay.get(k) || 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const spanDays = points.length ? (now - points[0].t) / DAY : 0;
  const d7 = sum(series.slice(-7));
  const avg = spanDays >= 1 ? d7 / Math.min(7, spanDays) : null; // 观察不足 7 天时，按实际观察天数求日均
  return {
    hasDeltas: points.length >= 2,
    series,
    keys,
    today: series[series.length - 1],
    d7,
    d30: sum(series),
    spanDays,
    avg,
    runwayDays: avg && avg > 0 ? total / avg : null,
  };
}

/* ---------------------------- 网络 ---------------------------- */
class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

async function fetchBalance(apiKey, base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('timeout', '请求超时（15 秒）');
    throw new ApiError(navigator.onLine === false ? 'offline' : 'network', '网络请求失败');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new ApiError('auth', 'API Key 无效或已被删除（401）', 401);
  if (res.status === 429) throw new ApiError('http', '请求过于频繁（429），稍后再试', 429);
  if (!res.ok) throw new ApiError('http', `接口返回 HTTP ${res.status}`, res.status);
  let data;
  try { data = await res.json(); } catch { throw new ApiError('format', '返回内容不是有效的 JSON'); }
  return data;
}

function describeError(e) {
  switch (e.code) {
    case 'offline': return '当前离线。';
    case 'network': return '网络请求失败：可能网络不通，也可能是接口不允许浏览器跨域（CORS）。若一直如此，请在设置里配置代理地址（见 README）。';
    default: return e.message || String(e);
  }
}

/* ---------------------------- 应用状态 ---------------------------- */
function loadHistory() {
  const h = store.getJSON(KEY.hist);
  return Array.isArray(h) ? h.filter(validSnapshot) : [];
}
function loadLatest() {
  const s = store.getJSON(KEY.latest);
  return validSnapshot(s) ? s : null;
}

const state = {
  apiKey: store.get(KEY.apiKey) || '',
  base: store.get(KEY.base) || DEFAULT_BASE,
  cur: store.get(KEY.cur) || '',
  hist: loadHistory(),
  snapshot: loadLatest(),
  stale: true,          // 当前展示的是否只是缓存
  loading: false,
  lastAttempt: 0,
  error: null,
  storageWarn: false,
};

const $ = (id) => document.getElementById(id);

function activeCur() {
  const list = state.snapshot ? Object.keys(state.snapshot.b) : [];
  if (!list.length) return null;
  if (list.includes(state.cur)) return state.cur;
  return list.includes('CNY') ? 'CNY' : list[0];
}

async function refresh() {
  if (!state.apiKey || state.loading) return;
  state.loading = true;
  state.lastAttempt = Date.now();
  render();
  try {
    const data = await fetchBalance(state.apiKey, state.base);
    const snap = toSnapshot(data);
    state.snapshot = snap;
    state.stale = false;
    state.error = null;
    state.hist = recordSnapshot(state.hist, snap);
    const ok1 = store.setJSON(KEY.latest, snap);
    const ok2 = store.setJSON(KEY.hist, state.hist);
    state.storageWarn = !(ok1 && ok2);
  } catch (e) {
    state.error = e instanceof ApiError ? e : new ApiError('unknown', String(e && e.message || e));
  } finally {
    state.loading = false;
  }
  render();
}

function maybeRefresh(minAge) {
  if (state.apiKey && Date.now() - state.lastAttempt >= minAge) refresh();
}

/* ---------------------------- 渲染 ---------------------------- */
function timeText(t) {
  const d = new Date(t);
  const sameDay = dayKey(t) === dayKey(Date.now());
  return `${sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const shortTime = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function emptyNote(host, text) {
  host.textContent = '';
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  host.appendChild(p);
}

function renderBanner() {
  const el = $('banner');
  let text = '';
  let kind = 'warn';
  if (state.error) {
    kind = state.error.code === 'offline' ? 'warn' : 'err';
    text = describeError(state.error);
    if (state.snapshot) text += `当前显示的是 ${timeText(state.snapshot.t)} 的缓存数据。`;
  } else if (state.storageWarn) {
    text = '无法写入本机存储（可能处于隐私模式），关闭应用后 Key 和历史会丢失。';
  }
  el.hidden = !text;
  el.className = `banner ${kind}`;
  el.textContent = text;
}

function renderSeg(list, cur) {
  const seg = $('seg');
  seg.textContent = '';
  seg.hidden = list.length < 2;
  if (list.length < 2) return;
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c;
    b.dataset.cur = c;
    b.setAttribute('aria-pressed', String(c === cur));
    seg.appendChild(b);
  }
}

function renderBars(stats, cur) {
  const host = $('chartBars');
  const values = stats.series.slice(-14);
  const keys = stats.keys.slice(-14);
  if (!stats.hasDeltas) return emptyNote(host, '还没有消耗数据：至少刷新两次、且余额发生变化后才会出现。');

  const W = 640, H = 220, L = 8, R = 8, T = 26, B = 30;
  const n = values.length;
  const slot = (W - L - R) / n;
  const bw = Math.min(34, slot * 0.62);
  const max = Math.max(...values, 0.01);
  const ch = H - T - B;
  const total = values.reduce((x, y) => x + y, 0);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 14 天每日消耗，合计 ${money(total, cur, spendText)}">`;
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
  values.forEach((v, i) => {
    const cx = L + slot * i + slot / 2;
    const h = v > 0 ? Math.max(3, (v / max) * ch) : 0;
    const y = H - B - h;
    if (h) s += `<rect class="bar${i === n - 1 ? ' today' : ''}" x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5"/>`;
    if (v > 0) s += `<text class="val" x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${spendText(v)}</text>`;
    const [, m, d] = keys[i].split('-');
    s += `<text class="tick" x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle">${Number(m)}/${Number(d)}</text>`;
  });
  host.innerHTML = s + '</svg>';
}

function renderLine(cur, now) {
  const host = $('chartLine');
  const pts = state.hist.filter((s) => s.b[cur]).map((s) => ({ t: s.t, v: s.b[cur].total }));
  const snap = state.snapshot;
  if (snap && snap.b[cur] && (!pts.length || pts[pts.length - 1].t < snap.t)) pts.push({ t: snap.t, v: snap.b[cur].total });
  let win = pts.filter((p) => p.t >= now - 30 * DAY);
  if (win.length < 2) win = pts.slice(-2);
  if (win.length < 2 || win[win.length - 1].t <= win[0].t) return emptyNote(host, '至少要在不同时间刷新两次，才画得出走势。');

  const W = 640, H = 220, L = 12, R = 12, T = 28, B = 32;
  const t0 = win[0].t, t1 = win[win.length - 1].t;
  let lo = Math.min(...win.map((p) => p.v));
  let hi = Math.max(...win.map((p) => p.v));
  if (hi === lo) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.12;
  lo -= padY; hi += padY;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = win.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const last = win[win.length - 1];
  const pMax = Math.max(...win.map((p) => p.v));
  const pMin = Math.min(...win.map((p) => p.v));

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 30 天余额走势，从 ${money(win[0].v, cur)} 到 ${money(last.v, cur)}">`;
  s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
  s += `<path class="area" d="${path} L${x(last.t).toFixed(1)} ${H - B} L${x(t0).toFixed(1)} ${H - B} Z"/>`;
  s += `<path class="line" d="${path}"/>`;
  s += `<circle class="dot" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="5"/>`;
  s += `<text class="tick" x="${L}" y="${T - 10}">最高 ${money(pMax, cur)}</text>`;
  s += `<text class="tick" x="${W - R}" y="${T - 10}" text-anchor="end">最低 ${money(pMin, cur)}</text>`;
  s += `<text class="tick" x="${L}" y="${H - 10}">${shortTime(t0)}</text>`;
  s += `<text class="tick" x="${W - R}" y="${H - 10}" text-anchor="end">${shortTime(t1)}</text>`;
  host.innerHTML = s + '</svg>';
}

function render() {
  const hasKey = !!state.apiKey;
  const snap = state.snapshot;
  const cur = activeCur();

  $('btnRefresh').classList.toggle('spin', state.loading);
  $('btnRefresh').disabled = !hasKey || state.loading;
  $('setup').hidden = hasKey;
  $('dash').hidden = !(hasKey && snap && cur);
  $('pending').hidden = !(hasKey && !(snap && cur));
  $('pendingText').textContent = state.loading ? '正在读取余额…' : '暂无数据，请点右上角刷新重试。';
  $('updated').textContent = hasKey && snap ? `${state.stale ? '缓存于' : '更新于'} ${timeText(snap.t)}` : '';
  renderBanner();
  if ($('dash').hidden) return;

  const v = snap.b[cur];
  const now = Date.now();
  const stats = computeStats(state.hist, cur, v.total, now);
  const dash = (n) => (stats.hasDeltas ? money(n, cur, spendText) : '—');

  renderSeg(Object.keys(snap.b), cur);
  $('vTotal').textContent = money(v.total, cur);
  $('vTopped').textContent = money(v.topped, cur);
  $('vGranted').textContent = money(v.granted, cur);
  $('badge').textContent = snap.ok ? '可用' : '余额不足';
  $('badge').className = `pill ${snap.ok ? 'ok' : 'bad'}`;
  $('vToday').textContent = dash(stats.today);
  $('v7d').textContent = dash(stats.d7);
  $('v30d').textContent = dash(stats.d30);

  if (stats.runwayDays !== null) {
    const d = stats.runwayDays;
    $('vRunway').textContent = d > 365 ? '> 1 年' : d >= 10 ? `${Math.round(d)} 天` : `${d.toFixed(1)} 天`;
    const win = stats.spanDays >= 7 ? '近 7 日' : `已观察 ${stats.spanDays.toFixed(1)} 天`;
    $('subRunway').textContent = `${win}日均 ${money(stats.avg, cur, spendText)}`;
  } else {
    $('vRunway').textContent = '—';
    $('subRunway').textContent = !stats.hasDeltas ? '需要至少两次刷新' : stats.avg === null ? '观察不满 1 天，数据不足' : '近期没有消耗';
  }

  renderBars(stats, cur);
  renderLine(cur, now);
}

/* ---------------------------- 设置弹窗 ---------------------------- */
const dlg = $('dlg');
const openDlg = () => (typeof dlg.showModal === 'function' ? dlg.showModal() : dlg.setAttribute('open', ''));
const closeDlg = () => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open'));

function dlgError(msg) { const el = $('dlgError'); el.textContent = msg; el.hidden = !msg; }

function openSettings() {
  $('inKey').value = state.apiKey;
  $('inKey').type = 'password';
  $('btnShowKey').textContent = '显示';
  $('inBase').value = state.base === DEFAULT_BASE ? '' : state.base;
  $('btnClearHist').disabled = state.hist.length === 0;
  $('btnLogout').hidden = !state.apiKey;
  dlgError('');
  openDlg();
}

function wipeData() {
  state.hist = [];
  state.snapshot = null;
  state.stale = true;
  state.error = null;
  store.del(KEY.hist);
  store.del(KEY.latest);
}

async function saveSettings() {
  const key = $('inKey').value.trim().replace(/^Bearer\s+/i, '');
  if (!key) return dlgError('请填写 API Key');
  if (/\s/.test(key)) return dlgError('API Key 里不应有空白字符，检查一下是不是多复制了内容');

  let base = $('inBase').value.trim() || DEFAULT_BASE;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' || u.search || u.hash) throw new Error('bad');
    base = u.href.replace(/\/+$/, '');
  } catch {
    return dlgError('接口地址必须是 https:// 开头的有效网址，且不带 ? 或 # 部分');
  }

  const changed = key !== state.apiKey || base !== state.base;
  if (changed && state.hist.length &&
      confirm('你修改了 Key 或接口地址。\n\n如果新 Key 属于另一个账号，旧历史会让消耗估算出错。\n\n点「确定」清空本机历史，点「取消」保留历史。')) {
    wipeData();
  }

  state.apiKey = key;
  state.base = base;
  const ok = store.set(KEY.apiKey, key) && (base === DEFAULT_BASE ? (store.del(KEY.base), true) : store.set(KEY.base, base));
  state.storageWarn = !ok;

  $('btnSave').disabled = true;
  $('btnSave').textContent = '验证中…';
  state.lastAttempt = 0;
  await refresh();
  $('btnSave').disabled = false;
  $('btnSave').textContent = '保存并刷新';

  if (state.error && state.error.code === 'auth') return dlgError('Key 验证失败：' + state.error.message);
  closeDlg();
}

/* ---------------------------- 事件 ---------------------------- */
$('btnRefresh').addEventListener('click', refresh);
$('btnSettings').addEventListener('click', openSettings);
$('btnSetup').addEventListener('click', openSettings);
$('btnCancel').addEventListener('click', closeDlg);
$('dlgForm').addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); }); // 点遮罩关闭

$('btnShowKey').addEventListener('click', () => {
  const input = $('inKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('btnShowKey').textContent = show ? '隐藏' : '显示';
});

$('btnClearHist').addEventListener('click', () => {
  if (!confirm('清空本机保存的全部余额历史？消耗统计会从零开始积累。')) return;
  state.hist = [];
  store.del(KEY.hist);
  $('btnClearHist').disabled = true;
  render();
});

$('btnLogout').addEventListener('click', () => {
  if (!confirm('清除这台设备上的 API Key 和全部历史数据？')) return;
  wipeData();
  state.apiKey = '';
  state.base = DEFAULT_BASE;
  store.del(KEY.apiKey);
  store.del(KEY.base);
  closeDlg();
  render();
});

$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cur]');
  if (!b) return;
  state.cur = b.dataset.cur;
  store.set(KEY.cur, state.cur);
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeRefresh(STALE_MS);
});
window.addEventListener('online', () => maybeRefresh(0));
setInterval(() => { if (document.visibilityState === 'visible') maybeRefresh(AUTO_MS); }, 30e3);

/* ---------------------------- 启动 ---------------------------- */
render();
maybeRefresh(0);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 无 HTTPS 时静默失败 */ }); });
}
