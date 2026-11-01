import { DEFAULTS, evaluate, tree, plan, flips, trendChange, itemName, maxTrade, isCapped, isThin, isOutlier } from './model/craft.js?v=17';
import { initI18n, setLang, getLang, t, tn, onLangChange } from './i18n.js?v=5';

const $ = id => document.getElementById(id);
const qsa = sel => [...document.querySelectorAll(sel)];

let GRAPH = null, SERVERS = null, META = null, PRICES = {}, HISTORY = {}, REF = {}, TREND = {}, MORPH = {}, FACTION = {}, P = { ...DEFAULTS }, RESULT = null, SELECTED = null;
let LAST_STATUS = null, DATA_ERROR = null;
let recalcTimer = 0;

const locale = () => getLang() === 'ru' ? 'ru-RU' : 'en-US';
const isRu = () => getLang() === 'ru';
const nf = digits => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits });
const fmt = n => {
  if (n == null || isNaN(n)) return '–';
  if (Math.abs(n) >= 1e6) return nf(2).format(n / 1e6) + (isRu() ? ' млн' : 'M');
  if (Math.abs(n) >= 1e4) return nf(1).format(n / 1e3) + (isRu() ? ' тыс.' : 'k');
  return Math.round(n).toLocaleString(locale());
};
const sign = n => n > 0 ? '+' : '';
const sfmt = n => n == null || isNaN(n) ? '–' : sign(n) + fmt(n);
const pct = n => {
  if (n == null || isNaN(n)) return '–';
  const v = n * 100;
  const abs = Math.abs(v);
  return nf(abs > 0 && abs < 1 ? 1 : 0).format(v) + '%';
};
const spct = n => n == null || isNaN(n) ? '–' : sign(n) + pct(n);
// The API sometimes emits impossible changes (< -100%); hide those, and cap
// absurd values so a data glitch cannot dominate the screen.
const spctChg = n => {
  if (n == null || isNaN(n) || n < -100) return '–';
  if (Math.abs(n) > 999) return sign(n) + '999%+';
  return sign(n) + nf(0).format(n) + '%';   // chg is already a percentage
};
const cls = n => n > 0 ? 'good' : n < 0 ? 'bad' : '';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = k => {
  const it = GRAPH && GRAPH.items[k];
  return it && it.icon
    ? `<img class="ic" src="${esc(it.icon)}" referrerpolicy="no-referrer" loading="lazy" alt="">`
    : '<span class="ic empty" aria-hidden="true"></span>';
};
const nm = k => esc(itemName(GRAPH, PRICES, k));
const spark = k => {
  const s = TREND && TREND.p && TREND.p[k];
  if (!s) return '';
  const vals = s.filter(v => v != null);
  if (vals.length < 2) return '';
  const mn = Math.min(...vals), mx = Math.max(...vals), w = 90, h = 18, rng = mx - mn || 1;
  const pts = s.map((v, i) => v == null ? null : [(i / (s.length - 1)) * w, h - 1 - ((v - mn) / rng) * (h - 2)])
    .filter(Boolean).map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
};
const HOW = { buy: 'how_buy', craft: 'how_craft', 'craft-combo': 'how_combo', npc: 'how_npc', morph: 'how_morph' };

/* ---------- UI preferences (density, columns) ---------- */
const LS_UI = 'aion2c:ui';
const OPP_COLS = [
  { k: 'name', l: 'c_recipe', always: true },
  { k: 'ml', l: 'c_ml', num: true },
  { k: 'ppm', l: 'c_ppm', num: true },
  { k: 'profitDay', l: 'c_profitDay', num: true },
  { k: 'roi', l: 'c_roi', num: true },
  { k: 'profit', l: 'c_profit', num: true },
  { k: 'cost', l: 'c_cost', num: true },
  { k: 'days', l: 'c_days', num: true },
  { k: 'plainL', l: 'c_plainL', num: true },
  { k: 'status', l: 'c_status', sortable: false },
  { k: 'ev', l: 'c_ev', num: true, opt: true },
  { k: 'mins', l: 'c_mins', num: true, opt: true },
  { k: 'crafts', l: 'c_crafts', num: true, opt: true },
  { k: 'plain', l: 'c_plain', num: true, opt: true },
  { k: 'green', l: 'c_green', num: true, opt: true },
  { k: 'maxTrade', l: 'c_maxtrade', num: true, opt: true },
  { k: 'bandLo', l: 'c_band_low', opt: true },
  { k: 'breakEvenGreen', l: 'c_beGreen', num: true, opt: true },
  { k: 'beSuccess', l: 'c_beSuccess', num: true, opt: true },
  { k: 'chg', l: 'm_chg', num: true, opt: true },
];
const OPP_DEFAULT = new Set(['name', 'ml', 'ppm', 'profitDay', 'roi', 'profit', 'cost', 'days', 'plainL', 'status']);
const UI = loadUi();
function loadUi() {
  let u = {};
  try { u = JSON.parse(localStorage.getItem(LS_UI) || '{}') || {}; } catch (e) { u = {}; }
  return { density: u.density === 'compact' ? 'compact' : 'comfortable', cols: { ...Object.fromEntries([...OPP_DEFAULT].map(k => [k, true])), ...(u.cols || {}) } };
}
function saveUi() {
  try { localStorage.setItem(LS_UI, JSON.stringify({ density: UI.density, cols: UI.cols })); } catch (e) { /* private */ }
}
const oppVisibleCols = () => OPP_COLS.filter(c => c.always || UI.cols[c.k]);

/* ---------- sorting / paging ---------- */
const SORT = {
  opps: { key: 'ppm', dir: -1 },
  market: { key: 'listings', dir: -1 },
  flip: { key: 'roiDay', dir: -1 },
};
const PAGE = { opps: 50, market: 60, flip: 50 };
window.setSort = (tab, key) => {
  const s = SORT[tab];
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = (key === 'name' || key === 'item') ? 1 : -1; }
  ({ opps: window.renderOpps, market: window.renderMarket, flip: window.renderFlip }[tab])();
  const tableId = { opps: 'oppTable', market: 'mktTable', flip: 'flipTable' }[tab];
  const btn = document.querySelector(`#${tableId} thead button[data-key="${key}"]`);
  if (btn) btn.focus();
};
window.showMore = tab => {
  PAGE[tab] += 50;
  ({ opps: window.renderOpps, market: window.renderMarket, flip: window.renderFlip }[tab])();
};
function sortRows(rows, state, val) {
  return [...rows].sort((a, b) => {
    const x = val(a, state.key), y = val(b, state.key);
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * state.dir;
    return (x > y ? 1 : x < y ? -1 : 0) * state.dir;
  });
}

/* ---------- status / meta / freshness ---------- */
function ageHours(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return isNaN(ms) ? null : ms / 3600000;
}
function relTime(iso) {
  const h = ageHours(iso);
  if (h == null) return '';
  const mins = Math.max(0, Math.round(h * 60));
  if (mins < 1) return t('just_now');
  if (mins < 60) return t('mins_ago', { n: mins });
  if (h < 48) return t('hours_ago', { n: Math.floor(h) });
  return t('days_ago', { n: Math.floor(h / 24) });
}
function bakedLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
}
function renderMeta() {
  const chip = $('freshness'), banner = $('staleBanner');
  if (!META || !META.baked_at) {
    chip.textContent = t('loading');
    chip.className = 'chip';
    banner.hidden = true;
    return;
  }
  const h = ageHours(META.baked_at);
  const level = DATA_ERROR ? 'stale' : h == null ? '' : h < 6 ? 'fresh' : h < 24 ? 'warn' : 'stale';
  chip.className = 'chip ' + level;
  chip.textContent = DATA_ERROR ? t('error_title') : relTime(META.baked_at);
  chip.title = t('baked', { time: bakedLocal(META.baked_at), rel: relTime(META.baked_at) }) + ' · UTC ' + META.baked_at;
  chip.onclick = () => reloadPrices();
  const stale = h != null && h >= 24;
  banner.hidden = !stale || !!DATA_ERROR;
  if (stale) {
    $('staleText').textContent = t('stale_text', { time: bakedLocal(META.baked_at), rel: relTime(META.baked_at) });
  }
  const kp = $('kpiFresh');
  if (kp) {
    kp.textContent = DATA_ERROR ? t('error_title') : relTime(META.baked_at);
    kp.className = level === 'fresh' ? 'good' : level === 'warn' ? 'warn' : level === 'stale' ? 'bad' : '';
    const srv = serverName(P.server);
    $('kpiFreshSub').textContent = srv + ' · ' + bakedLocal(META.baked_at);
  }
}
function serverName(id) {
  const s = ((SERVERS && SERVERS.servers) || []).find(x => String(x.server_id) === String(id));
  return s ? s.name : String(id);
}

function renderStatus() {
  if (!LAST_STATUS) return;
  const [k, vars] = LAST_STATUS;
  $('status').textContent = t(k, vars);
}

/* ---------- server + data ---------- */
function buildServerOptions() {
  const baked = new Set(Object.keys((META && META.servers) || {}));
  const cur = $('server').value;
  const opts = ((SERVERS && SERVERS.servers) || []).filter(s => baked.has(String(s.server_id)))
    .map(s => `<option value="${s.server_id}">${esc(s.name)} (${esc(s.region)} ${esc(s.faction)})</option>`);
  $('server').innerHTML = opts.join('') || `<option value="${DEFAULTS.server}">${DEFAULTS.server}</option>`;
  if ([...$('server').options].some(o => o.value === cur)) $('server').value = cur;
}
function currentFaction() {
  const s = ((SERVERS && SERVERS.servers) || []).find(x => String(x.server_id) === String(P.server));
  return s && s.faction ? String(s.faction).toLowerCase() : null;
}

function showDataError(msg) {
  const el = $('dataError');
  if (!el) return;
  el.hidden = false;
  $('dataErrorText').textContent = t('price_error') + (msg ? ': ' + msg : '');
}
function hideDataError() {
  const el = $('dataError');
  if (el) el.hidden = true;
}

async function loadServerData(server) {
  LAST_STATUS = ['loading_prices', {}];
  renderStatus();
  try {
    const d = await (await fetch(`data/prices_${server}.json`, { cache: 'no-cache' })).json();
    const nextPrices = d.prices || {}, nextHistory = d.history || {};
    // guard against impossible percentage changes from the source
    for (const v of Object.values(nextPrices)) {
      if (v.chg != null && (!isFinite(v.chg) || v.chg < -100)) v.chg = null;
    }
    PRICES = nextPrices; HISTORY = nextHistory;
    TREND = await fetch(`data/trend_${server}.json`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    DATA_ERROR = null;
    hideDataError();
    LAST_STATUS = ['status_loaded', { items: Object.keys(PRICES).length, hist: Object.keys(HISTORY).length, time: bakedLocal(d.baked_at) }];
  } catch (e) {
    // keep the last good prices visible; surface the failure instead of an empty table
    DATA_ERROR = String(e && e.message || e);
    showDataError(DATA_ERROR);
    LAST_STATUS = ['status_error', { s: server, e: DATA_ERROR }];
  }
  renderStatus();
}

function readParams() {
  const num = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
  P = {
    server: parseInt($('server').value, 10) || DEFAULTS.server,
    profession: $('profession').value,
    maxMastery: num('maxMastery', DEFAULTS.maxMastery),
    priceBasis: $('priceBasis').value,
    greenMult: Math.max(0.01, num('greenMult', 100) / 100),
    tax: Math.min(0.9, Math.max(0, num('tax', 10) / 100)),
    listFee: Math.min(0.5, Math.max(0, num('listFee', 2) / 100)),
    npcPrice: Math.max(0, num('npcPrice', 400)),
    rsOverride: Math.max(0, num('rsOverride', 0)),
    minPerCraft: Math.max(0.05, num('minPerCraft', 0.25)),
    budget: Math.max(0, num('budget', 0)),
    hours: Math.max(0, num('hours', 0)),
    horizon: Math.max(0, num('horizon', 0)),
    succLow: num('succLow', 96) / 100, succMid: num('succMid', 80) / 100,
    succHigh: num('succHigh', 70) / 100, succTop: num('succTop', 60) / 100,
    askCap: Math.max(0, num('askCap', 20) / 100),
    minListings: Math.max(1, num('minListings', 3)),
    xserverMult: Math.max(0, num('xserverMult', 3)),
  };
}
function setDefaultsToInputs() {
  for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) el.value = DEFAULTS[k]; }
}
window.resetDefaults = () => { setDefaultsToInputs(); recalc(true); };

const LS_PARAMS = 'aion2c:params';
function saveParams() {
  const o = {};
  for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) o[k] = el.value; }
  try { localStorage.setItem(LS_PARAMS, JSON.stringify(o)); } catch (e) { /* private */ }
}
function loadParams() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(LS_PARAMS) || '{}') || {}; } catch (e) { o = {}; }
  for (const [k, v] of Object.entries(o)) { const el = $(k); if (el && v != null) el.value = v; }
  const valid = id => [...$(id).options].some(op => op.value === $(id).value);
  if (!valid('profession')) $('profession').value = DEFAULTS.profession;
  if (!valid('priceBasis')) $('priceBasis').value = DEFAULTS.priceBasis;
}

window.recalc = async (force) => {
  const prev = P.server;
  readParams(); saveParams();
  if (force || P.server !== prev || !Object.keys(PRICES).length) await loadServerData(P.server);
  RESULT = evaluate(GRAPH, PRICES, HISTORY, P, REF, MORPH, currentFaction(), FACTION);
  renderDynamic();
};
window.reloadPrices = async () => {
  await loadServerData(P.server);
  await recalc();
};
function scheduleRecalc() {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => recalc(), 400);
}

/* ---------- sidebar drawer ---------- */
function isDrawer() { return window.matchMedia('(max-width: 1279px)').matches; }
function syncDrawer(returnFocus) {
  const sb = $('sidebar'), sc = $('scrim'), btn = $('paramsBtn');
  if (!isDrawer()) {
    sb.classList.remove('open'); sb.inert = false;
    sb.removeAttribute('aria-hidden'); sb.removeAttribute('role'); sb.removeAttribute('aria-modal');
    sc.hidden = true; document.body.classList.remove('drawer-open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    return;
  }
  const open = sb.classList.contains('open');
  sb.inert = !open;
  if (open) {
    sb.removeAttribute('aria-hidden');
    sb.setAttribute('role', 'dialog'); sb.setAttribute('aria-modal', 'true');
    sc.hidden = false; document.body.classList.add('drawer-open');
    $('main').inert = true;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  } else {
    sb.setAttribute('aria-hidden', 'true');
    sb.removeAttribute('role'); sb.removeAttribute('aria-modal');
    sc.hidden = true; document.body.classList.remove('drawer-open');
    $('main').inert = false;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (returnFocus && btn) btn.focus();
  }
}
window.openParams = () => {
  $('sidebar').classList.add('open');
  syncDrawer(false);
  const first = $('sidebar').querySelector('select, input, button');
  if (first) first.focus();
};
window.closeParams = () => {
  $('sidebar').classList.remove('open');
  syncDrawer(true);
};

/* ---------- tabs ---------- */
const TABS = ['opps', 'recipe', 'market', 'plan', 'flip'];
window.setTab = (id, push = true) => {
  if (!TABS.includes(id)) id = 'opps';
  for (const b of qsa('.tabs [role="tab"]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === id));
    b.tabIndex = b.dataset.tab === id ? 0 : -1;
  }
  for (const p of qsa('.tabpanel')) p.classList.toggle('on', p.id === id);
  if (push) {
    const h = id === 'recipe' && SELECTED ? `#recipe/${SELECTED}` : '#' + id;
    if (location.hash !== h) {
      history.pushState(null, '', h);
      window.scrollTo(0, 0);
    }
  }
};
function tabFromHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (h.startsWith('recipe/')) {
    const rid = h.slice(7);
    if (rid) { SELECTED = rid; setTab('recipe', false); renderRecipe(rid); return; }
  }
  if (TABS.includes(h)) setTab(h, false);
}
window.setLanguage = l => setLang(l);

/* ---------- dynamic render ---------- */
function renderDynamic() {
  renderMeta(); renderStatus(); buildSectionOptions();
  renderKpis(); renderOpps(); renderMarket(); renderPlan(); renderFlip();
  if (SELECTED) renderRecipe(SELECTED);
}
function buildSectionOptions() {
  const cur = $('mktSection').value;
  const secs = new Set();
  for (const v of Object.values(PRICES)) secs.add(v.sec);
  $('mktSection').innerHTML = `<option value="">${t('all_sections')}</option>` + [...secs].sort().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if ([...$('mktSection').options].some(o => o.value === cur)) $('mktSection').value = cur;
}

function renderKpis() {
  const rows = RESULT ? RESULT.rows : [];
  const verified = rows.filter(r => !r.unverified);
  const pos = verified.filter(r => r.profit > 0);
  $('kpiOpps').textContent = pos.length.toLocaleString(locale());
  $('kpiOppsSub').textContent = t('kpi_opps_sub', { total: rows.length, pos: pos.length });
  const best = arr => arr.reduce((a, b) => (a == null || (b != null && b > a)) ? b : a, null);
  const day = best(pos.map(r => r.profitDay));
  const dayRow = day == null ? null : pos.find(r => r.profitDay === day);
  $('kpiBestDay').textContent = day == null ? '–' : fmt(day);
  $('kpiBestDaySub').textContent = dayRow
    ? dayRow.name + (dayRow.days != null ? ' · ' + dayRow.days.toFixed(1) + ' ' + t('days_unit') : '')
    : t('no_data');
  const roi = best(pos.map(r => r.roi));
  const roiRow = roi == null ? null : pos.find(r => r.roi === roi);
  $('kpiBestRoi').textContent = roi == null ? '–' : pct(roi);
  $('kpiBestRoiSub').textContent = roiRow ? roiRow.name : t('no_data');
  renderMeta();
}

/* ---------- filters ---------- */
function oppFilters() {
  return {
    positive: $('onlyPositive').checked,
    listed: $('onlyListed').checked,
    afford: $('onlyAfford').checked,
    verified: $('onlyVerified').checked,
    minGone: parseInt($('minGone').value, 10) || 0,
  };
}
function filterOppRows() {
  const f = oppFilters();
  const q = $('oppSearch').value.trim().toLowerCase();
  let rows = RESULT.rows.filter(r => !q || r.name.toLowerCase().includes(q));
  if (f.positive) rows = rows.filter(r => r.profit > 0);
  if (f.listed) rows = rows.filter(r => r.plainL > 0 || r.greenL > 0);
  if (f.afford && P.budget > 0) rows = rows.filter(r => r.cost <= P.budget);
  if (f.verified) rows = rows.filter(r => !r.unverified);
  if (f.minGone > 0 && Object.keys(HISTORY).length) rows = rows.filter(r => r.hist && r.hist.gone >= f.minGone);
  return rows;
}
function renderChips() {
  const f = oppFilters();
  const chips = [];
  if (f.positive) chips.push(['positive', t('only_positive')]);
  if (!f.listed) chips.push(['listed', t('only_listed')]);
  if (!f.afford) chips.push(['afford', t('only_afford')]);
  if (!f.verified) chips.push(['verified', t('only_verified')]);
  if (f.minGone > 1) chips.push(['minGone', t('min_units_short') + ' > ' + f.minGone]);
  $('oppChips').innerHTML = chips.map(([k, label]) => `<button type="button" class="chip-filter" onclick="removeFilter('${k}')">${esc(label)} <span aria-hidden="true">✕</span></button>`).join('');
  const nonDefault = (f.positive ? 1 : 0) + (!f.listed ? 1 : 0) + (!f.afford ? 1 : 0) + (!f.verified ? 1 : 0) + (f.minGone !== 1 ? 1 : 0);
  $('oppFilterCount').textContent = nonDefault;
  $('oppFilterCount').className = 'badge ' + (nonDefault ? 'info' : 'neutral');
}
window.removeFilter = k => {
  const el = { positive: 'onlyPositive', listed: 'onlyListed', afford: 'onlyAfford', verified: 'onlyVerified' }[k];
  if (el) $(el).checked = !$(el).checked;
  if (k === 'minGone') $('minGone').value = 1;
  onOppFilterChange();
  $('oppFilterBtn').focus();
};
window.onOppFilterChange = () => { PAGE.opps = 50; renderOpps(); };
window.onOppInput = () => { PAGE.opps = 50; renderOpps(); };
window.resetOppFilters = () => {
  $('onlyPositive').checked = false; $('onlyListed').checked = true;
  $('onlyAfford').checked = true; $('onlyVerified').checked = true;
  $('minGone').value = 1; $('oppSearch').value = '';
  onOppFilterChange();
};
window.toggleFilterPop = () => {
  const pop = $('oppFilterPop'), btn = $('oppFilterBtn');
  const open = pop.hidden;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
};
window.clearSearch = (id, fn) => { $(id).value = ''; window[fn](); };

/* ---------- columns / density ---------- */
function renderColumnsPop() {
  $('columnsPop').innerHTML = OPP_COLS.filter(c => !c.always).map(c =>
    `<label class="check"><input type="checkbox" ${UI.cols[c.k] ? 'checked' : ''} onchange="toggleCol('${c.k}', this.checked)"> ${esc(t(c.l))}</label>`).join('');
}
window.toggleColumnsPop = () => {
  const pop = $('columnsPop'), btn = $('columnsBtn');
  renderColumnsPop();
  const open = pop.hidden;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
};
window.toggleCol = (k, on) => {
  UI.cols[k] = on; saveUi();
  PAGE.opps = 50;
  renderOpps();
};
window.toggleDensity = () => {
  UI.density = UI.density === 'compact' ? 'comfortable' : 'compact';
  saveUi();
  $('densityBtn').textContent = t(UI.density);
  $('densityBtn').setAttribute('aria-pressed', String(UI.density === 'compact'));
  renderOpps(); renderMarket(); renderFlip(); renderPlan();
};

/* ---------- table helpers ---------- */
function headHtml(cols, sort, tab, labels) {
  return '<thead><tr>' + cols.map(c => {
    const isNum = c.num;
    if (!c.k || c.sortable === false) return `<th scope="col" class="${isNum ? 'num' : ''}">${esc(t(labels ? labels[c.k] : c.l))}</th>`;
    const active = sort.key === c.k;
    const aria = active ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none';
    return `<th scope="col" class="${isNum ? 'num' : ''}" aria-sort="${aria}"><button type="button" class="th-sort" data-key="${esc(c.k)}" onclick="setSort('${tab}','${c.k}')">${esc(t(labels ? labels[c.k] : c.l))}<span class="arrow" aria-hidden="true">${active ? (sort.dir < 0 ? '▾' : '▴') : ''}</span></button></th>`;
  }).join('') + '</tr></thead>';
}
function skeleton(rows, cols) {
  const cells = Array.from({ length: cols }, () => '<td><span class="sk"></span></td>').join('');
  return '<thead><tr>' + Array.from({ length: cols }, () => '<th scope="col">&nbsp;</th>').join('') + '</tr></thead><tbody>' +
    Array.from({ length: rows }, () => `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`).join('') + '</tbody>';
}
function emptyRow(cols, text, action) {
  return `<tbody><tr class="empty-row"><td colspan="${cols}"><strong>${esc(t('empty_title'))}</strong>${esc(text || t('empty_hint'))}${action ? `<div style="margin-top:10px">${action}</div>` : ''}</td></tr></tbody>`;
}
function moreLabel(shown, total) {
  return t('show_more', { n: Math.min(50, Math.max(0, total - shown)) });
}
function statusBadges(r) {
  const b = [];
  if (r.transfer) b.push(`<span class="badge info" title="${esc(t('transfer_title'))}">${esc(t('transfer'))}</span>`);
  if (r.outlier) b.push(`<span class="badge danger" title="${esc(t('outlier_title'))}">${esc(t('outlier'))}</span>`);
  else if (r.unverified) b.push(`<span class="badge warn" title="${esc(t('unverified_title'))}">${esc(t('unverified'))}</span>`);
  if (r.capped) b.push(`<span class="badge warn" title="${esc(t('cap_title'))}">${esc(t('capped'))}</span>`);
  return b.length ? `<span class="badge-row">${b.slice(0, 3).join('')}</span>` : '';
}

/* ---------- opportunities ---------- */
window.renderOpps = () => {
  const cols = oppVisibleCols();
  const sort = SORT.opps;
  if (!RESULT) {
    $('oppTable').innerHTML = skeleton(10, Math.max(8, cols.length));
    $('oppTable').classList.toggle('compact', UI.density === 'compact');
    $('oppCount').textContent = '–';
    $('oppMore').hidden = true;
    return;
  }
  let rows = filterOppRows();
  rows = sortRows(rows, sort, (r, k) => r[k]);
  renderChips();
  const total = rows.length;
  const shown = rows.slice(0, PAGE.opps);
  $('oppCount').textContent = t('n_of_m', { shown: shown.length, total });
  const head = headHtml(cols, sort, 'opps');
  const body = shown.map((r, idx) => {
    const cells = cols.map(c => {
      const label = t(c.l);
      const mobile = ['ml', 'cost', 'plainL'].includes(c.k) || c.opt ? ' hide-mobile' : '';
      if (c.k === 'name') {
        const sub = [esc(r.prof), r.combo ? '→ ' + nm(r.combo) : ''].filter(Boolean).join(' · ');
        return `<td data-label="${esc(label)}"><div class="name-cell">${icon(r.out)}<div><div class="nm" title="${esc(r.name)}">${esc(r.name)}</div><div class="sub">${sub}</div></div></div></td>`;
      }
      if (c.k === 'status') return `<td data-label="${esc(label)}" class="badge-cell">${statusBadges(r)}</td>`;
      const v = r[c.k];
      if (c.k === 'days') return `<td data-label="${esc(label)}" class="num num-cell${mobile}">${v == null ? '–' : v.toFixed(1)}</td>`;
      if (c.k === 'ml' || c.k === 'crafts' || c.k === 'plainL') return `<td data-label="${esc(label)}" class="num num-cell${mobile}">${v ?? '–'}</td>`;
      if (c.k === 'roi' || c.k === 'beSuccess') return `<td data-label="${esc(label)}" class="num num-cell ${cls(v)}${mobile}">${spct(v)}</td>`;
      if (c.k === 'chg') return `<td data-label="${esc(label)}" class="num num-cell ${cls(v)}${mobile}">${spctChg(v)}</td>`;
      if (c.k === 'ppm' || c.k === 'profitDay' || c.k === 'profit' || c.k === 'ev') return `<td data-label="${esc(label)}" class="num num-cell ${cls(v)}${mobile}">${sfmt(v)}</td>`;
      if (c.k === 'bandLo') return `<td data-label="${esc(label)}" class="num num-cell dim${mobile}">${fmt(v)}</td>`;
      if (c.k === 'mx') return `<td>${v ?? ''}</td>`;
      return `<td data-label="${esc(label)}" class="num num-cell${mobile}">${fmt(v)}</td>`;
    }).join('');
    return `<tr class="click${SELECTED === r.rid ? ' sel' : ''}" tabindex="${idx === 0 ? 0 : -1}" onclick="pick('${r.rid}')" onkeydown="rowKey(event,'${r.rid}',this)">${cells}</tr>`;
  }).join('');
  const empty = DATA_ERROR && !Object.keys(PRICES).length
    ? emptyRow(cols.length, t('price_error'), `<button type="button" class="btn small" onclick="reloadPrices()">${esc(t('retry'))}</button>`)
    : emptyRow(cols.length, t('empty_search'), `<button type="button" class="btn small" onclick="resetOppFilters()">${esc(t('reset_filters'))}</button>`);
  $('oppTable').innerHTML = total ? head + '<tbody>' + body + '</tbody>' : head + empty;
  $('oppTable').classList.toggle('compact', UI.density === 'compact');
  $('oppMore').hidden = total <= PAGE.opps;
  $('oppMore').textContent = moreLabel(PAGE.opps, total);
};
window.rowKey = (e, rid, el) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(rid); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const next = e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling;
  if (next && next.tagName === 'TR') { el.tabIndex = -1; next.tabIndex = 0; next.focus(); }
};
window.setMobileSort = key => {
  SORT.opps = { key, dir: (key === 'name') ? 1 : -1 };
  PAGE.opps = 15;
  renderOpps();
};

/* ---------- recipe ---------- */
window.pick = rid => {
  SELECTED = rid;
  renderRecipe(rid);
  setTab('recipe');
  $('recipeDetail').setAttribute('tabindex', '-1');
  $('recipeDetail').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
function treeHtml(tr) {
  if (!tr) return `<span class="bad">${esc(t('cannot_price'))}</span>`;
  return '<ul>' + tr.lines.map(l => `<li><span class="name-cell">${icon(l.key)}${l.qty} × ${nm(l.key)}</span> <span class="accent">@ ${fmt(l.unit)}</span><span class="how">${esc(t(HOW[l.how] || l.how))}${l.mins ? esc(t('mins_suffix', { m: l.mins.toFixed(1) })) : ''}</span>${l.sub ? treeHtml(l.sub) : ''}</li>`).join('') + '</ul>';
}
function mktRow(k) {
  const v = PRICES[k];
  if (!v) return `<div class="kv"><div>${nm(k)}</div><div class="dim">${esc(t('not_on_market'))}</div></div>`;
  const h = HISTORY[k];
  const c7 = trendChange(TREND, k, 7);
  return `<div class="kv">
    <div>${esc(t('ask'))}</div><div>${fmt(v.p)} <span class="dim">${esc(tn('n_listings', v.n))}</span></div>
    <div>${esc(t('d28_sold'))}</div><div>${v.sold ? esc(t('sold_line', { sold: v.sold.toLocaleString(locale()), avg: fmt(v.avg), min: fmt(v.smin), max: fmt(v.smax) })) : `<span class="dim">${esc(t('not_published'))}</span>`}</div>
    <div>${esc(t('cleared_band'))}</div><div>${h ? (h.lo ? `${fmt(h.lo)}–${fmt(h.hi)}` : `<span class="dim">${esc(t('no_priced_event'))}</span>`) + ` <span class="dim">· ${esc(t('hist_line', { gone: h.gone, hours: h.hours, low: fmt(h.low24), high: fmt(h.high24) }))}</span>` : `<span class="dim">${esc(t('no_history'))}</span>`}</div>
    <div>${esc(t('highest_trade'))}</div><div>${fmt(maxTrade(k, RESULT.ctx))}${isCapped(k, RESULT.ctx) ? ` <span class="badge warn">${esc(t('ask_capped'))}</span>` : ''}</div>
    <div>${esc(t('trend7'))}</div><div>${c7 == null ? '<span class="dim">–</span>' : `<span class="${cls(c7)}">${spct(c7)}</span>`} ${spark(k)}</div>
    ${isOutlier(k, RESULT.ctx) ? `<div class="bad">${esc(t('outlier_title'))}</div><div></div>` : isThin(k, RESULT.ctx) ? `<div class="bad">${esc(t('unverified_title'))}</div><div></div>` : ''}
  </div>`;
}
function renderRecipe(rid) {
  if (!RESULT) return;
  const r = RESULT.rows.find(x => x.rid === rid) || null;
  const rec = GRAPH.recipes[rid];
  if (!rec) { $('recipeDetail').innerHTML = `<div class="bad">${esc(t('pick_recipe'))}</div>`; return; }
  const tr = tree(rid, RESULT.ctx);
  const out = String(rec.out), combo = rec.combo ? String(rec.combo) : null;
  const s = r ? r.s : null;
  $('recipeDetail').innerHTML = `
    <h2><span class="name-cell">${icon(out).replace('class="ic"', 'class="ic big"')}${nm(out)}</span> <span class="badge neutral">${esc(rec.p)} · ${esc(t('mastery', { ml: rec.ml }))}</span></h2>
    ${combo ? `<div class="dim">${esc(t('combo_of', { pct: (rec.cp / 100).toFixed(0) }))} <span class="name-cell">${icon(combo)}${nm(combo)}</span></div>` : ''}
    ${r ? `<div class="kv">
      <div>${esc(t('cost_per_craft'))}</div><div>${fmt(r.cost)} <span class="dim">${esc(t('fee', { v: fmt(rec.gold || 0) }))}</span></div>
      <div>${esc(t('expected_value'))}</div><div>${fmt(r.ev)} <span class="dim">${esc(t('ev_at', { s: pct(s), tax: pct(P.tax), fee: pct(P.listFee) }))}</span></div>
      <div>${esc(t('profit_per_craft'))}</div><div class="${cls(r.profit)}">${sfmt(r.profit)} <span class="dim">(${spct(r.roi)})</span></div>
      <div>${esc(t('profit_per_min'))}</div><div class="${cls(r.ppm)}">${sfmt(r.ppm)} <span class="dim">${esc(t('mins_incl', { m: r.mins.toFixed(1) }))}</span></div>
      <div>${esc(t('days_to_sell'))}</div><div>${r.days == null ? '–' : r.days.toFixed(1) + ' ' + esc(t('days_unit'))}</div>
      <div>${esc(t('profit_per_day'))}</div><div class="${cls(r.profitDay)}">${sfmt(r.profitDay)}</div>
      <div>${esc(t('roi_per_day'))}</div><div class="${cls(r.roiDay)}">${r.roiDay == null ? '–' : spct(r.roiDay)}</div>
      ${combo ? `<div>${esc(t('breakeven_green'))}</div><div>${fmt(r.breakEvenGreen)}</div>` : ''}
      <div>${esc(t('breakeven_success'))}</div><div>${r.beSuccess == null ? '–' : pct(r.beSuccess)} <span class="dim">(${esc(t('your_success', { s: pct(s) }))})</span></div>
      <div>${esc(t('risk_sigma'))}</div><div>${fmt(r.sigma)} <span class="dim">${esc(t('sharpe_of', { v: r.sharpe == null ? '–' : r.sharpe.toFixed(2) }))}</span></div>
      <div>${esc(t('prob_loss'))}</div><div>${r.probLoss == null ? '–' : pct(r.probLoss)}</div>
      <div>${esc(t('cvar'))}</div><div class="${cls(r.cvar10)}">${fmt(r.cvar10)}</div>
      <div>${esc(t('crafts_budget'))}</div><div>${r.crafts} <span class="dim">${esc(t('expected_val', { v: fmt(r.crafts * r.profit) }))}</span></div>
    </div>` : `<div class="bad">${esc(t('output_not_priced'))}</div>`}
    <h2>${esc(t('inputs_route'))}</h2><div class="tree">${treeHtml(tr)}</div>`;
  $('recipeMarket').innerHTML = `<h2>${esc(t('output_market'))}</h2><b class="name-cell">${icon(out)}${nm(out)}</b>${mktRow(out)}${combo ? `<b class="name-cell">${icon(combo)}${nm(combo)}</b>${mktRow(combo)}` : ''}
    <h2>${esc(t('input_market'))}</h2>${rec.in.map(i => `<b class="name-cell">${icon(String(i[0]))}${nm(String(i[0]))}</b>${mktRow(String(i[0]))}`).join('')}`;
}
window.recipeSuggest = () => {
  const q = $('recipeSearch').value.trim().toLowerCase();
  if (!q || !RESULT) { $('recipeSuggestions').innerHTML = ''; return; }
  const hits = RESULT.rows.filter(r => r.name.toLowerCase().includes(q)).slice(0, 12);
  $('recipeSuggestions').innerHTML = hits.map(r => `<button type="button" onclick="pick('${r.rid}')">${esc(r.name)} <span class="dim">ml${r.ml}</span></button>`).join('');
};

/* ---------- plan ---------- */
window.renderPlan = () => {
  if (!RESULT) return;
  const rows = RESULT.rows.filter(r => !r.unverified && (r.plainL > 0 || r.greenL > 0));
  const p = plan(rows, P.budget, P.hours, 12, P.horizon);
  $('planBudget').textContent = fmt(P.budget);
  $('planSpent').textContent = fmt(p.cost);
  $('planProfit').textContent = fmt(p.profit);
  $('planTime').textContent = Math.round(p.mins) + ' ' + t('c_mins');
  $('planSummary').textContent = p.mix.length
    ? tn('n_recipes', p.mix.length) + ' · ' + t('plan_summary', { profit: fmt(p.profit), mins: Math.round(p.mins), cost: fmt(p.cost) })
    : t('plan_none');
  const head = '<thead><tr><th scope="col">' + esc(t('c_recipe')) + '</th><th scope="col" class="num">' + esc(t('plan_crafts')) + '</th><th scope="col" class="num">' + esc(t('c_cost')) + '</th><th scope="col" class="num">' + esc(t('c_mins')) + '</th><th scope="col" class="num">' + esc(t('c_profit_total')) + '</th></tr></thead>';
  const body = p.mix.map(m => {
    const row = RESULT.rows.find(x => x.rid === m.rid);
    return `<tr class="click" tabindex="0" onclick="pick('${m.rid}')" onkeydown="rowKey(event,'${m.rid}')">
      <td data-label="${esc(t('c_recipe'))}"><div class="name-cell">${icon(m.out)}<div><div class="nm">${esc(m.name)}</div><div class="sub">${esc(m.prof)}</div></div></div></td>
      <td data-label="${esc(t('plan_crafts'))}" class="num num-cell">${m.x.toFixed(1)}</td>
      <td data-label="${esc(t('c_cost'))}" class="num num-cell">${fmt(m.x * m.cost)}</td>
      <td data-label="${esc(t('c_mins'))}" class="num num-cell">${fmt(m.x * m.mins)}</td>
      <td data-label="${esc(t('c_profit_total'))}" class="num num-cell good">${fmt(m.x * m.profit)}</td></tr>`;
  }).join('');
  $('planTable').innerHTML = p.mix.length ? head + '<tbody>' + body + '</tbody>' : emptyRow(5, t('plan_none'));
  $('planTable').classList.toggle('compact', UI.density === 'compact');
};

/* ---------- flip ---------- */
window.renderFlip = () => {
  if (!RESULT) { $('flipTable').innerHTML = skeleton(8, 8); $('flipCount').textContent = '–'; $('flipMore').hidden = true; return; }
  const q = $('flipSearch').value.trim().toLowerCase();
  let rows = flips(RESULT.ctx);
  if (RESULT.ctx.blocked) rows = rows.filter(r => !RESULT.ctx.blocked(r.k));
  if ($('flipVerified').checked) rows = rows.filter(r => !r.unverified);
  if ($('flipProfit').checked) rows = rows.filter(r => r.profit > 0);
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
  rows = sortRows(rows, SORT.flip, (r, k) => k === 'trend7' ? trendChange(TREND, r.k, 7) : r[k]);
  const total = rows.length, shown = rows.slice(0, PAGE.flip);
  $('flipCount').textContent = t('n_of_m', { shown: shown.length, total });
  const cols = [
    { k: 'item', l: 'm_item', sortable: false }, { k: 'buy', l: 'f_buy', num: true }, { k: 'sell', l: 'f_sell', num: true, sortable: false },
    { k: 'spread', l: 'f_spread', num: true }, { k: 'roiDay', l: 'f_roiDay', num: true }, { k: 'days', l: 'c_days', num: true },
    { k: 'n', l: 'c_plainL', num: true, sortable: false }, { k: 'chg', l: 'm_chg', num: true }, { k: 'trend7', l: 'trend7', num: true },
  ];
  const body = shown.map(r => {
    const c7 = trendChange(TREND, r.k, 7);
    return `<tr>
      <td data-label="${esc(t('m_item'))}"><div class="name-cell">${icon(r.k)}<div><div class="nm" title="${esc(r.name)}">${esc(r.name)}</div><div class="sub">${r.unverified ? `<span class="badge warn" title="${esc(t('unverified_title'))}">${esc(t('unverified'))}</span>` : ''}</div></div></div></td>
      <td data-label="${esc(t('f_buy'))}" class="num num-cell">${fmt(r.buy)}</td>
      <td data-label="${esc(t('f_sell'))}" class="num num-cell">${fmt(r.sell)} <span class="dim">${esc(t('src_' + r.src))}</span></td>
      <td data-label="${esc(t('f_spread'))}" class="num num-cell ${cls(r.spread)}">${spct(r.spread)}</td>
      <td data-label="${esc(t('f_roiDay'))}" class="num num-cell ${cls(r.roiDay)}">${r.roiDay == null ? '–' : spct(r.roiDay)}</td>
      <td data-label="${esc(t('c_days'))}" class="num num-cell hide-mobile">${r.days == null ? '–' : r.days.toFixed(1)}</td>
      <td data-label="${esc(t('c_plainL'))}" class="num num-cell hide-mobile">${r.n}</td>
      <td data-label="${esc(t('m_chg'))}" class="num num-cell ${cls(r.chg)} hide-mobile">${spctChg(r.chg)}</td>
      <td data-label="${esc(t('trend7'))}" class="num num-cell ${cls(c7)} hide-mobile">${c7 == null ? '–' : spct(c7)}</td></tr>`;
  }).join('');
  const flipEmpty = DATA_ERROR && !Object.keys(PRICES).length
    ? emptyRow(cols.length, t('price_error'), `<button type="button" class="btn small" onclick="reloadPrices()">${esc(t('retry'))}</button>`)
    : emptyRow(cols.length, t('empty_search'));
  $('flipTable').innerHTML = total ? headHtml(cols, SORT.flip, 'flip') + '<tbody>' + body + '</tbody>' : headHtml(cols, SORT.flip, 'flip') + flipEmpty;
  $('flipTable').classList.toggle('compact', UI.density === 'compact');
  $('flipMore').hidden = total <= PAGE.flip;
  $('flipMore').textContent = moreLabel(PAGE.flip, total);
};
window.onFlipInput = () => { PAGE.flip = 50; renderFlip(); };

/* ---------- market ---------- */
window.renderMarket = () => {
  if (!RESULT) { $('mktTable').innerHTML = skeleton(10, 8); $('mktCount').textContent = '–'; $('mktMore').hidden = true; return; }
  const q = $('mktSearch').value.trim().toLowerCase(), sec = $('mktSection').value;
  const craftable = new Set([...RESULT.ctx.byOut.keys(), ...RESULT.ctx.byCombo.keys()]);
  const ridFor = k => (RESULT.ctx.byOut.get(k) || RESULT.ctx.byCombo.get(k) || [])[0];
  let rows = Object.entries(PRICES)
    .filter(([k, v]) => (!q || v.name.toLowerCase().includes(q)) && (!sec || v.sec === sec) && !(RESULT.ctx.blocked && RESULT.ctx.blocked(k)))
    .map(([k, v]) => ({ k, v, h: HISTORY[k], c7: trendChange(TREND, k, 7) }));
  const get = (r, key) => ({ item: r.v.name, ask: r.v.p, chg: r.v.chg, trend7: r.c7, sold: r.v.sold, avg: r.v.avg, band: r.h && r.h.lo, listings: r.v.n }[key]);
  rows = sortRows(rows, SORT.market, get);
  const total = rows.length, shown = rows.slice(0, PAGE.market);
  $('mktCount').textContent = t('n_of_m', { shown: shown.length, total });
  const cols = [
    { k: 'item', l: 'm_item', sortable: false }, { k: 'ask', l: 'ask', num: true }, { k: 'chg', l: 'm_chg', num: true },
    { k: 'trend7', l: 'trend7', num: true }, { k: 'sold', l: 'm_sold28', num: true }, { k: 'avg', l: 'm_avg', num: true },
    { k: 'band', l: 'cleared_band', sortable: false }, { k: 'craft', l: 'm_craft', sortable: false },
  ];
  const body = shown.map(r => {
    const { k, v, h, c7 } = r;
    return `<tr>
      <td data-label="${esc(t('m_item'))}"><div class="name-cell">${icon(k)}<div><div class="nm" title="${esc(v.name)}">${esc(v.name)}</div><div class="sub">${esc(v.cat)}</div></div></div></td>
      <td data-label="${esc(t('ask'))}" class="num num-cell">${fmt(v.p)}</td>
      <td data-label="${esc(t('m_chg'))}" class="num num-cell ${cls(v.chg)}">${spctChg(v.chg)}</td>
      <td data-label="${esc(t('trend7'))}" class="num num-cell ${cls(c7)} hide-mobile">${c7 == null ? '–' : spct(c7)}</td>
      <td data-label="${esc(t('m_sold28'))}" class="num num-cell hide-mobile">${v.sold ? v.sold.toLocaleString(locale()) : '–'}</td>
      <td data-label="${esc(t('m_avg'))}" class="num num-cell hide-mobile">${fmt(v.avg)}</td>
      <td data-label="${esc(t('cleared_band'))}" class="hide-mobile">${h && h.lo ? `${fmt(h.lo)}–${fmt(h.hi)} <span class="dim">(${esc(t('gone_h', { gone: h.gone, hours: h.hours }))})</span>` : h ? `<span class="dim">${esc(t('gone_h', { gone: h.gone, hours: h.hours }))}</span>` : ''}</td>
      <td data-label="${esc(t('m_craft'))}">${craftable.has(k) ? `<button type="button" class="btn small" onclick="pick('${ridFor(k)}')">${esc(t('recipe_btn'))}</button>` : ''}</td></tr>`;
  }).join('');
  const mktEmpty = DATA_ERROR && !Object.keys(PRICES).length
    ? emptyRow(cols.length, t('price_error'), `<button type="button" class="btn small" onclick="reloadPrices()">${esc(t('retry'))}</button>`)
    : emptyRow(cols.length, t('empty_search'));
  $('mktTable').innerHTML = total ? headHtml(cols, SORT.market, 'market') + '<tbody>' + body + '</tbody>' : headHtml(cols, SORT.market, 'market') + mktEmpty;
  $('mktTable').classList.toggle('compact', UI.density === 'compact');
  $('mktMore').hidden = total <= PAGE.market;
  $('mktMore').textContent = moreLabel(PAGE.market, total);
};
window.onMarketInput = () => { PAGE.market = 60; renderMarket(); };

/* ---------- errors / loading ---------- */
function showError(msg) {
  $('staleBanner').hidden = false;
  $('staleText').textContent = t('load_error') + (msg ? ' — ' + msg : '');
  $('freshness').className = 'chip stale';
  $('freshness').textContent = t('error_title');
  $('oppTable').innerHTML = skeleton(8, 8);
}

async function loadJson(url, cache) {
  const r = await fetch(url, cache ? { cache } : undefined);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

function renderLoading() {
  $('oppTable').innerHTML = skeleton(10, 8);
  $('mktTable').innerHTML = skeleton(8, 6);
  $('flipTable').innerHTML = skeleton(8, 6);
}

async function init() {
  initI18n();
  renderLoading();
  $('densityBtn').textContent = t(UI.density);
  $('densityBtn').setAttribute('aria-pressed', String(UI.density === 'compact'));
  if (window.matchMedia('(max-width: 640px)').matches) { PAGE.opps = 15; PAGE.market = 20; PAGE.flip = 15; }
  syncDrawer(false);
  setTab('opps', false);
  // tab keyboard + click
  for (const b of qsa('.tabs [role="tab"]')) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', e => {
      const i = TABS.indexOf(b.dataset.tab);
      let n = i;
      if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      else return;
      e.preventDefault();
      setTab(TABS[n]);
      qsa('.tabs [role="tab"]')[n].focus();
    });
  }
  window.addEventListener('hashchange', tabFromHash);
  window.addEventListener('popstate', tabFromHash);
  window.addEventListener('resize', () => syncDrawer(false));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const [btn, pop] of [[$('oppFilterBtn'), $('oppFilterPop')], [$('columnsBtn'), $('columnsPop')]]) {
      if (btn && pop && !pop.hidden) {
        pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus();
      }
    }
    if ($('sidebar').classList.contains('open')) closeParams();
  });
  try {
    [GRAPH, SERVERS, META] = await Promise.all([
      loadJson('data/graph.json'),
      loadJson('data/servers.json').catch(() => ({ servers: [] })),
      loadJson('data/meta.json', 'no-cache').catch(() => ({ servers: {} })),
    ]);
    REF = await loadJson('data/ref.json', 'no-cache').catch(() => ({}));
    MORPH = await loadJson('data/morph.json', 'no-cache').catch(() => ({}));
    FACTION = await loadJson('data/faction.json', 'no-cache').catch(() => ({}));
    if (!GRAPH || !GRAPH.items || !GRAPH.recipes) throw new Error('graph.json: unexpected shape');
  } catch (e) {
    showError(String(e && e.message || e));
    return;
  }
  buildServerOptions();
  setDefaultsToInputs();
  loadParams();
  if (![...$('server').options].some(o => o.value === $('server').value)) $('server').value = String(DEFAULTS.server);
  const baked = new Set(Object.keys(META.servers || {}));
  if (!baked.has($('server').value) && baked.size) $('server').value = [...baked][0];
  await loadServerData(parseInt($('server').value, 10));
  onLangChange(() => { buildServerOptions(); $('densityBtn').textContent = t(UI.density); renderDynamic(); });
  setInterval(renderMeta, 60000);
  $('server').addEventListener('change', scheduleRecalc);
  document.addEventListener('click', e => {
    for (const [btn, pop] of [[$('oppFilterBtn'), $('oppFilterPop')], [$('columnsBtn'), $('columnsPop')]]) {
      if (btn && pop && !pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    }
  });
  // auto-apply parameter changes (debounced) instead of a stale table
  for (const el of qsa('#sidebar input, #sidebar select')) {
    if (el.id === 'comboInfo') continue;
    el.addEventListener('input', scheduleRecalc);
    el.addEventListener('change', scheduleRecalc);
  }
  await recalc();
  tabFromHash();
}
init();
