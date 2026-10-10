import { DEFAULTS, evaluate, tree, itemName, maxTrade, isCapped } from './model/craft.js?v=6';
import { initI18n, setLang, getLang, t, tn, onLangChange } from './i18n.js?v=2';

const $ = id => document.getElementById(id);
let GRAPH = null, SERVERS = null, META = null, PRICES = {}, HISTORY = {}, P = { ...DEFAULTS }, RESULT = null, SELECTED = null;
let sortKey = 'ppm', sortDir = -1;
let LAST_STATUS = null;

const locale = () => getLang() === 'ru' ? 'ru-RU' : 'en-US';
const fmt = n => n == null || isNaN(n) ? '–' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString(locale());
const pct = n => n == null || isNaN(n) ? '–' : (n * 100).toFixed(0) + '%';
const cls = n => n > 0 ? 'good' : n < 0 ? 'bad' : '';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = k => { const it = GRAPH.items[k]; return it && it.icon ? `<img class="ic" src="${esc(it.icon)}" referrerpolicy="no-referrer" loading="lazy" alt="">` : '<span class="ic"></span>'; };
const nm = k => esc(itemName(GRAPH, PRICES, k));
const HOW = { buy: 'how_buy', craft: 'how_craft', 'craft-combo': 'how_combo', npc: 'how_npc' };

function bakedLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return '';
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return t('just_now');
  if (mins < 60) return t('mins_ago', { n: mins });
  const h = Math.floor(mins / 60);
  if (h < 48) return t('hours_ago', { n: h });
  return t('days_ago', { n: Math.floor(h / 24) });
}

window.toggleInputs = () => { const d = $('inputs'); const open = d.style.display === 'none'; d.style.display = open ? '' : 'none'; $('togArrow').textContent = open ? '▾' : '▸'; };
window.setTab = t_ => { for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === t_); for (const b of document.querySelectorAll('.tabs .mbtn')) b.classList.toggle('on', b.id === 'tab-' + t_); };
window.setLanguage = l => setLang(l);

function setDefaultsToInputs() {
  for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) el.value = DEFAULTS[k]; }
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
    minPerCraft: Math.max(0.1, num('minPerCraft', 1)),
    budget: Math.max(0, num('budget', 0)),
    succLow: num('succLow', 96) / 100, succMid: num('succMid', 80) / 100, succHigh: num('succHigh', 70) / 100, succTop: num('succTop', 60) / 100,
    askCap: Math.max(0, num('askCap', 20) / 100),
  };
}
window.resetDefaults = () => { setDefaultsToInputs(); recalc(); };

const LS_PARAMS = 'aion2c:params';
function saveParams() {
  const o = {};
  for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) o[k] = el.value; }
  try { localStorage.setItem(LS_PARAMS, JSON.stringify(o)); } catch (e) { /* private mode */ }
}
function loadParams() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(LS_PARAMS) || '{}') || {}; } catch (e) { o = {}; }
  for (const [k, v] of Object.entries(o)) { const el = $(k); if (el && v != null) el.value = v; }
  const valid = id => [...$(id).options].some(op => op.value === $(id).value);
  if (!valid('profession')) $('profession').value = DEFAULTS.profession;
  if (!valid('priceBasis')) $('priceBasis').value = DEFAULTS.priceBasis;
}

function renderStatus() {
  if (!LAST_STATUS) return;
  const [k, vars] = LAST_STATUS;
  $('status').textContent = t(k, vars);
}

function renderMeta() {
  const el = $('meta');
  if (!META || !META.baked_at) { el.textContent = t('loading'); el.removeAttribute('title'); return; }
  el.textContent = t('baked', { time: bakedLocal(META.baked_at), rel: relTime(META.baked_at) });
  el.title = 'UTC ' + META.baked_at;
}

function buildServerOptions() {
  const baked = new Set(Object.keys((META && META.servers) || {}));
  const cur = $('server').value;
  const opts = ((SERVERS && SERVERS.servers) || []).filter(s => baked.has(String(s.server_id)))
    .map(s => `<option value="${s.server_id}">${esc(s.name)} (${esc(s.region)} ${esc(s.faction)})${META.servers[String(s.server_id)].has_sales ? t('sales_stats') : ''}</option>`);
  $('server').innerHTML = opts.join('') || `<option value="${DEFAULTS.server}">${DEFAULTS.server}</option>`;
  if ([...$('server').options].some(o => o.value === cur)) $('server').value = cur;
}

async function loadServerData(server) {
  LAST_STATUS = ['loading_prices', {}];
  renderStatus();
  try {
    const d = await (await fetch(`data/prices_${server}.json`, { cache: 'no-cache' })).json();
    PRICES = d.prices || {}; HISTORY = d.history || {};
    LAST_STATUS = ['status_loaded', { items: Object.keys(PRICES).length, hist: Object.keys(HISTORY).length, time: bakedLocal(d.baked_at) }];
  } catch (e) {
    PRICES = {}; HISTORY = {};
    LAST_STATUS = ['status_noprices', { s: server }];
  }
  renderStatus();
}

window.recalc = async () => {
  const prev = P.server; readParams(); saveParams();
  if (P.server !== prev || !Object.keys(PRICES).length) await loadServerData(P.server);
  RESULT = evaluate(GRAPH, PRICES, HISTORY, P);
  renderDynamic();
};

function buildSectionOptions() {
  const cur = $('mktSection').value;
  const secs = new Set();
  for (const v of Object.values(PRICES)) secs.add(v.sec);
  $('mktSection').innerHTML = `<option value="">${t('all_sections')}</option>` + [...secs].sort().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if ([...$('mktSection').options].some(o => o.value === cur)) $('mktSection').value = cur;
}

function renderDynamic() {
  renderMeta(); renderStatus(); buildSectionOptions(); renderOpps(); renderMarket(); if (SELECTED) renderRecipe(SELECTED);
}

const COLS = [
  ['name', 'c_recipe', false], ['ml', 'c_ml', true], ['ppm', 'c_ppm', true], ['profitDay', 'c_profitDay', true],
  ['profit', 'c_profit', true], ['roi', 'c_roi', true], ['cost', 'c_cost', true], ['ev', 'c_ev', true],
  ['mins', 'c_mins', true], ['days', 'c_days', true], ['crafts', 'c_crafts', true],
  ['plain', 'c_plain', true], ['plainL', 'c_plainL', true], ['green', 'c_green', true], ['greenL', 'c_greenL', true], ['maxTrade', 'c_maxtrade', true], ['bandLo', 'c_band', false], ['breakEvenGreen', 'c_beGreen', true], ['beSuccess', 'c_beSuccess', true],
];
window.sortBy = k => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; } renderOpps(); };

window.renderOpps = () => {
  if (!RESULT) return;
  const q = $('oppSearch').value.trim().toLowerCase();
  let rows = RESULT.rows.filter(r => !q || r.name.toLowerCase().includes(q));
  if ($('onlyPositive').checked) rows = rows.filter(r => r.profit > 0);
  if ($('onlyListed').checked) rows = rows.filter(r => r.plainL > 0 || r.greenL > 0);
  const minGone = parseInt($('minGone').value, 10) || 0;
  if (minGone > 0 && Object.keys(HISTORY).length) rows = rows.filter(r => (r.hist && r.hist.gone >= minGone));
  rows.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  $('oppCount').textContent = tn('n_recipes', rows.length);
  const head = '<tr>' + COLS.map(([k, l, n]) => `<th class="${n ? 'num' : ''}" onclick="sortBy('${k}')">${t(l)}${sortKey === k ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr>';
  const body = rows.slice(0, 400).map(r => {
    const h = r.hist, band = h && h.lo ? `${fmt(h.lo)}–${fmt(h.hi)} <span class="dim">(${t('gone_h', { gone: h.gone, hours: h.hours })})</span>` : h ? `<span class="dim">${t('gone_h', { gone: h.gone, hours: h.hours })}</span>` : '';
    return `<tr class="click ${SELECTED === r.rid ? 'sel' : ''}" onclick="pick('${r.rid}')">
      <td><span class="name">${icon(r.out)}${esc(r.name)}</span><span class="pill">${esc(r.prof)}</span>${r.combo ? `<span class="pill">→ ${nm(r.combo)}</span>` : ''}</td>
      <td class="num">${r.ml}</td><td class="num ${cls(r.ppm)}">${fmt(r.ppm)}</td><td class="num ${cls(r.profitDay)}">${fmt(r.profitDay)}</td><td class="num ${cls(r.profit)}">${fmt(r.profit)}</td><td class="num ${cls(r.roi)}">${pct(r.roi)}</td>
      <td class="num">${fmt(r.cost)}</td><td class="num">${fmt(r.ev)}</td><td class="num">${r.mins.toFixed(1)}</td><td class="num">${r.days == null ? '–' : r.days.toFixed(1)}</td><td class="num">${r.crafts}</td>
      <td class="num">${fmt(r.plain)}</td><td class="num dim">${r.plainL}</td><td class="num">${fmt(r.green)}${r.capped ? ` <span class="pill bad" title="${t('cap_title')}">${t('capped')}</span>` : ''}</td><td class="num dim">${r.greenL}</td><td class="num">${fmt(r.maxTrade)}</td><td>${band}</td><td class="num">${fmt(r.breakEvenGreen)}</td><td class="num">${r.beSuccess == null ? '–' : pct(r.beSuccess)}</td></tr>`;
  }).join('');
  $('oppTable').innerHTML = head + body;
};

window.pick = rid => { SELECTED = rid; renderRecipe(rid); setTab('recipe'); renderOpps(); };

function treeHtml(tr) {
  if (!tr) return `<span class="bad">${t('cannot_price')}</span>`;
  return '<ul>' + tr.lines.map(l => `<li><span class="name">${icon(l.key)}${l.qty} × ${nm(l.key)}</span> <span class="accent">@ ${fmt(l.unit)}</span><span class="how">${t(HOW[l.how] || l.how)}${l.mins ? t('mins_suffix', { m: l.mins.toFixed(1) }) : ''}</span>${l.sub ? treeHtml(l.sub) : ''}</li>`).join('') + '</ul>';
}

function mktRow(k) {
  const v = PRICES[k]; if (!v) return `<div class="kv"><div>${nm(k)}</div><div class="dim">${t('not_on_market')}</div></div>`;
  const h = HISTORY[k];
  return `<div class="kv">
    <div>${t('ask')}</div><div>${fmt(v.p)} <span class="dim">${t('n_listings', { n: v.n })}</span></div>
    <div>${t('d28_sold')}</div><div>${v.sold ? t('sold_line', { sold: v.sold.toLocaleString(locale()), avg: fmt(v.avg), min: fmt(v.smin), max: fmt(v.smax) }) : `<span class="dim">${t('not_published')}</span>`}</div>
    <div>${t('cleared_band')}</div><div>${h ? (h.lo ? `${fmt(h.lo)}–${fmt(h.hi)}` : `<span class="dim">${t('no_priced_event')}</span>`) + ` <span class="dim">· ${t('hist_line', { gone: h.gone, hours: h.hours, low: fmt(h.low24), high: fmt(h.high24) })}</span>` : `<span class="dim">${t('no_history')}</span>`}</div>
    <div>${t('highest_trade')}</div><div>${fmt(maxTrade(k, RESULT.ctx))}${isCapped(k, RESULT.ctx) ? ` <span class="pill bad">${t('ask_capped')}</span>` : ''}</div>
  </div>`;
}

function renderRecipe(rid) {
  if (!RESULT) return;
  const r = RESULT.rows.find(x => x.rid === rid) || null;
  const rec = GRAPH.recipes[rid];
  const tr = tree(rid, RESULT.ctx);
  const out = String(rec.out), combo = rec.combo ? String(rec.combo) : null;
  const s = r ? r.s : null;
  $('recipeDetail').innerHTML = `
    <h2 style="margin-top:0"><span class="name">${icon(out).replace('class="ic"', 'class="ic big"')}${nm(out)}</span> <span class="pill">${rec.p} · ${t('mastery', { ml: rec.ml })}</span></h2>
    ${combo ? `<div class="small">${t('combo_of', { pct: (rec.cp / 100).toFixed(0) })} <span class="name">${icon(combo)}${nm(combo)}</span></div>` : ''}
    ${r ? `<div class="kv">
      <div>${t('cost_per_craft')}</div><div>${fmt(r.cost)} <span class="dim">${t('fee', { v: fmt(rec.gold || 0) })}</span></div>
      <div>${t('expected_value')}</div><div>${fmt(r.ev)} <span class="dim">${t('ev_at', { s: pct(s), tax: pct(P.tax), fee: pct(P.listFee) })}</span></div>
      <div>${t('profit_per_craft')}</div><div class="${cls(r.profit)}">${fmt(r.profit)} <span class="dim">(${pct(r.roi)} ROI)</span></div>
      <div>${t('profit_per_min')}</div><div class="${cls(r.ppm)}">${fmt(r.ppm)} <span class="dim">${t('mins_incl', { m: r.mins.toFixed(1) })}</span></div>
      <div>${t('days_to_sell')}</div><div>${r.days == null ? '–' : r.days.toFixed(1) + ' ' + t('days_unit')}</div>
      <div>${t('profit_per_day')}</div><div class="${cls(r.profitDay)}">${fmt(r.profitDay)}</div>
      <div>${t('roi_per_day')}</div><div class="${cls(r.roiDay)}">${r.roiDay == null ? '–' : pct(r.roiDay)}</div>
      ${combo ? `<div>${t('breakeven_green')}</div><div>${fmt(r.breakEvenGreen)}</div>` : ''}
      <div>${t('breakeven_success')}</div><div>${r.beSuccess == null ? '–' : pct(r.beSuccess)} <span class="dim">(${t('your_success', { s: pct(s) })})</span></div>
      <div>${t('risk_sigma')}</div><div>${fmt(r.sigma)} <span class="dim">${t('sharpe_of', { v: r.sharpe == null ? '–' : r.sharpe.toFixed(2) })}</span></div>
      <div>${t('prob_loss')}</div><div>${r.probLoss == null ? '–' : pct(r.probLoss)}</div>
      <div>${t('cvar')}</div><div class="${cls(r.cvar10)}">${fmt(r.cvar10)}</div>
      <div>${t('crafts_budget')}</div><div>${r.crafts} <span class="dim">${t('expected_val', { v: fmt(r.crafts * r.profit) })}</span></div>
    </div>` : `<div class="bad">${t('output_not_priced')}</div>`}
    <h2>${t('inputs_route')}</h2><div class="tree">${treeHtml(tr)}</div>`;
  $('recipeMarket').innerHTML = `<h2 style="margin-top:0">${t('output_market')}</h2><b>${nm(out)}</b>${mktRow(out)}${combo ? `<b>${nm(combo)}</b>${mktRow(combo)}` : ''}
    <h2>${t('input_market')}</h2>${rec.in.map(i => `<b class="name">${icon(String(i[0]))}${nm(String(i[0]))}</b>${mktRow(String(i[0]))}`).join('')}`;
}

window.recipeSuggest = () => {
  const q = $('recipeSearch').value.trim().toLowerCase();
  if (!q || !RESULT) { $('recipeSuggestions').innerHTML = ''; return; }
  const hits = RESULT.rows.filter(r => r.name.toLowerCase().includes(q)).slice(0, 12);
  $('recipeSuggestions').innerHTML = hits.map(r => `<button class="mbtn" onclick="pick('${r.rid}')">${esc(r.name)} <span class="dim">ml${r.ml}</span></button>`).join(' ');
};

window.renderMarket = () => {
  if (!RESULT) return;
  const q = $('mktSearch').value.trim().toLowerCase(), sec = $('mktSection').value;
  const rows = Object.entries(PRICES).filter(([k, v]) => (!q || v.name.toLowerCase().includes(q)) && (!sec || v.sec === sec));
  rows.sort((a, b) => ((b[1].sold || 0) * (b[1].avg || b[1].p || 0)) - ((a[1].sold || 0) * (a[1].avg || a[1].p || 0)) || (b[1].p || 0) - (a[1].p || 0));
  $('mktCount').textContent = tn('n_items', rows.length);
  const craftable = new Set([...RESULT.ctx.byOut.keys(), ...RESULT.ctx.byCombo.keys()]);
  const ridFor = k => (RESULT.ctx.byOut.get(k) || RESULT.ctx.byCombo.get(k) || [])[0];
  $('mktTable').innerHTML = `<tr><th>${t('m_item')}</th><th>${t('m_category')}</th><th class="num">${t('ask')}</th><th class="num">L</th><th class="num">${t('m_chg')}</th><th class="num">${t('m_sold28')}</th><th class="num">${t('m_avg')}</th><th>${t('cleared_band')}</th><th>${t('m_craft')}</th></tr>` +
    rows.slice(0, 600).map(([k, v]) => { const h = HISTORY[k]; return `<tr><td><span class="name">${icon(k)}${esc(v.name)}</span></td><td class="dim">${esc(v.cat)}</td><td class="num">${fmt(v.p)}</td><td class="num dim">${v.n}</td><td class="num ${cls(v.chg)}">${v.chg == null ? '–' : v.chg.toFixed(0) + '%'}</td><td class="num">${v.sold ? v.sold.toLocaleString(locale()) : '<span class="dim">–</span>'}</td><td class="num">${fmt(v.avg)}</td><td>${h && h.lo ? `${fmt(h.lo)}–${fmt(h.hi)} <span class="dim">(${t('gone_h', { gone: h.gone, hours: h.hours })})</span>` : h ? `<span class="dim">${t('gone_h', { gone: h.gone, hours: h.hours })}</span>` : ''}</td><td>${craftable.has(k) ? `<button class="mbtn" onclick="pick('${ridFor(k)}')">${t('recipe_btn')}</button>` : ''}</td></tr>`; }).join('');
};

async function loadJson(url, cache) {
  const r = await fetch(url, cache ? { cache } : undefined);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

async function init() {
  initI18n();
  try {
    [GRAPH, SERVERS, META] = await Promise.all([
      loadJson('data/graph.json'),
      loadJson('data/servers.json').catch(() => ({ servers: [] })),
      loadJson('data/meta.json', 'no-cache').catch(() => ({ servers: {} })),
    ]);
    if (!GRAPH || !GRAPH.items || !GRAPH.recipes) throw new Error('graph.json: unexpected shape');
  } catch (e) {
    const el = $('meta');
    el.textContent = t('load_error');
    el.title = String((e && e.message) || e);
    return;
  }
  buildServerOptions();
  setDefaultsToInputs();
  loadParams();
  if (![...$('server').options].some(o => o.value === $('server').value)) $('server').value = String(DEFAULTS.server);
  const baked = new Set(Object.keys(META.servers || {}));
  if (!baked.has($('server').value) && baked.size) $('server').value = [...baked][0];
  await loadServerData(parseInt($('server').value, 10));
  renderMeta();
  onLangChange(() => { buildServerOptions(); renderDynamic(); });
  setInterval(renderMeta, 60000);
  await recalc();
}
init();
