// Pure crafting-economics model. No DOM access in here.
// Inputs: graph (items, recipes, byProduct, byCombo), prices {key:{p,n,sold,avg,...}}, history {key:{lo,hi,gone,...}}, params.

// DEFAULTS is in the *input field* units (percent, kina) used to seed the form.
// readParams() in app.js converts them to the fractions the model expects
// (tax 0.10, succLow 0.96, …). Pass fractions to evaluate()/makeCtx(), never DEFAULTS directly.
export const DEFAULTS = {
  server: 12302,
  profession: 'all',
  maxMastery: 55,
  tax: 10,            // percent sales tax at settlement
  listFee: 2,         // percent registration fee, paid per listing whether it sells or not
  npcPrice: 400,      // kina per bound NPC consumable (abrasive, catalyst, sandpaper, hardener, bottles)
  greenMult: 100,     // percent of ask applied to Splendent/combo outputs
  priceBasis: 'low',  // ask | low | high  (cleared band from history when available, else ask)
  rsOverride: 0,      // 0 = use market
  minPerCraft: 1,
  budget: 5000000,
  succLow: 96, succMid: 80, succHigh: 70, succTop: 60,  // percent, by mastery tier
  askCap: 20,         // percent: ignore the ask when it sits more than this above the highest known trade
};

// Highest price we have evidence actually traded: 28d max sale (where the game publishes it)
// or the highest ask that ever vanished from the book. Null when nothing is known.
export function maxTrade(k, ctx) {
  const row = ctx.prices[k] || {}, h = ctx.history && ctx.history[k];
  const cands = [row.smax, h && h.tmax_ever, h && h.tmax].filter(x => x);
  return cands.length ? Math.max(...cands) : null;
}

export function successFor(ml, P) {
  if (ml <= 50) return P.succLow;
  if (ml <= 55) return P.succMid;
  if (ml <= 70) return P.succHigh;
  return P.succTop;
}

// Expected days to sell one unit. Little's law on the item's market:
//   λ = 28d units sold / 28 (units/day),  W = (listings + 1) / λ
// (a new listing competes with the n listings already on the book).
export function daysToSell(k, ctx) {
  const row = ctx.prices[k], h = ctx.history && ctx.history[k];
  let perDay = null;
  if (row && row.sold > 0) perDay = row.sold / 28;                      // published 28d sales
  else if (h && h.gone > 0 && h.hours > 0) perDay = h.gone / (h.hours / 24); // vanished listings as a proxy
  if (!perDay || perDay <= 0) return null;
  return ((row && row.n || 0) + 1) / perDay;
}

// Distribution statistics of the per-craft profit over its discrete outcomes.
// outcomes: array of [probability, value].
export function risk(outcomes) {
  const total = outcomes.reduce((a, o) => a + o[0], 0) || 1;
  const norm = outcomes.map(([p, v]) => [p / total, v]);
  const mean = norm.reduce((a, [p, v]) => a + p * v, 0);
  const variance = norm.reduce((a, [p, v]) => a + p * (v - mean) * (v - mean), 0);
  const sigma = Math.sqrt(Math.max(0, variance));
  const probLoss = norm.filter(([, v]) => v < 0).reduce((a, [p]) => a + p, 0);
  // CVaR 10%: mean of the worst 10% of the distribution
  const sorted = [...norm].sort((a, b) => a[1] - b[1]);
  let need = 0.1, acc = 0, wsum = 0;
  for (const [p, v] of sorted) {
    if (need <= 0) break;
    const take = Math.min(p, need);
    acc += take * v; wsum += take; need -= take;
  }
  return { mean, sigma, probLoss, cvar10: wsum > 0 ? acc / wsum : null };
}

export function itemName(graph, prices, k) {
  return (graph.items[k] && graph.items[k].n) || (prices[k] && prices[k].name) || k;
}

const BOUND_RE = /\(Bound\)/i;
// Bound items cannot be traded, so they are costed at the NPC price input.
// The name suffix is the reliable signal (prefixed keys only cover part of them).
export function isNpcItem(graph, prices, k) {
  return BOUND_RE.test(itemName(graph, prices, k)) || k.startsWith('630') || k.startsWith('631');
}

export function isGreen(name) { return /Splendent/.test(name); }

// Sale value of one unit, given basis. Returns null when unknown.
export function saleValue(k, ctx) {
  const { graph, prices, history, P } = ctx;
  const row = prices[k];
  if (!row || row.p == null) return null;
  let v = row.p;
  const h = history && history[k];
  if (P.priceBasis === 'low' && h && h.lo) v = Math.min(v, h.lo);
  if (P.priceBasis === 'high' && h && h.hi) v = h.hi;
  // ask-cap rule: an ask more than askCap% above the highest known trade is not a price, use the trade
  const mt = maxTrade(k, ctx);
  if (mt && row.p > mt * (1 + P.askCap)) v = Math.min(v, mt);
  if (isGreen(itemName(graph, prices, k))) v *= P.greenMult;
  return v;
}

export function isCapped(k, ctx) {
  const row = ctx.prices[k]; const mt = maxTrade(k, ctx);
  return !!(row && row.p != null && mt && row.p > mt * (1 + ctx.P.askCap));
}

export function buyPrice(k, ctx) {
  const { prices, P } = ctx;
  if (k === ctx.rsKey && P.rsOverride > 0) return P.rsOverride;
  const row = prices[k];
  if (row && row.p != null) {
    // a lone cheap ask is not a buy price: use the higher of ask and the cheapest ask that vanished recently
    const h = ctx.history && ctx.history[k];
    return h && h.lo ? Math.max(row.p, h.lo) : row.p;
  }
  if (isNpcItem(ctx.graph, ctx.prices, k)) return P.npcPrice; // bound NPC consumables
  return null;
}

function buyCandidate(k, ctx) {
  const bp = buyPrice(k, ctx);
  if (bp == null) return null;
  return { cost: bp, mins: 0, how: isNpcItem(ctx.graph, ctx.prices, k) ? 'npc' : 'buy', via: null };
}

// Cheapest offer for an input: its current acquire value, or the alternative key.
function cheapOffer(key, alt, ctx, acq) {
  let best = acq.has(key) ? acq.get(key) : buyCandidate(key, ctx), used = key;
  if (alt) {
    const b = acq.has(alt) ? acq.get(alt) : buyCandidate(alt, ctx);
    if (b && (!best || b.cost < best.cost)) { best = b; used = alt; }
  }
  return best ? { key: used, cost: best.cost, mins: best.mins, how: best.how, via: best.via } : null;
}

// Cost/mins of running recipe r, reading input prices from the acquire table.
function runRecipe(r, ctx, acq) {
  let cost = r.gold || 0, mins = 0;
  const lines = [];
  for (const inp of r.in) {
    const k = String(inp[0]), qty = inp[1], alt = inp[2] ? String(inp[2]) : null;
    const a = cheapOffer(k, alt, ctx, acq);
    if (!a) return null;
    cost += a.cost * qty; mins += a.mins * qty;
    lines.push({ key: a.key, qty, unit: a.cost, how: a.how, via: a.via, mins: a.mins });
  }
  return { cost, mins, lines };
}

function plainOffer(rid, r, run, ctx) {
  const P = ctx.P, s = successFor(r.ml, P), cp = (r.cp || 0) / 10000, outq = r.outq || 1;
  const denom = s * (1 - cp) * outq;
  if (denom <= 0) return null;
  const comboCredit = r.combo ? cp * (saleValue(String(r.combo), ctx) || 0) * ctx.keep : 0;
  const cost = (run.cost - s * comboCredit) / denom;
  if (cost < 0) return null;
  return { cost, mins: (run.mins + P.minPerCraft) / denom, how: 'craft', via: rid };
}

function comboOffer(rid, r, run, ctx) {
  const P = ctx.P, cp = (r.cp || 0) / 10000;
  if (cp <= 0) return null;
  const s = successFor(r.ml, P), denom = s * cp;
  if (denom <= 0) return null;
  const plainCredit = (1 - cp) * (saleValue(String(r.out), ctx) || 0) * ctx.keep;
  const cost = (run.cost - s * plainCredit) / denom;
  if (cost < 0) return null;
  return { cost, mins: (run.mins + P.minPerCraft) / denom, how: 'craft-combo', via: rid };
}

// Cheapest obtainable cost for every item, as a fixed point: relax each usable
// recipe until no unit gets cheaper. Unlike the old depth-5 recursion this
// prices arbitrarily long craft chains correctly. Costs only fall, so it stops.
export function computeAcquire(ctx) {
  const acq = new Map();
  const keys = new Set([...ctx.byOut.keys(), ...ctx.byCombo.keys()]);
  for (const r of Object.values(ctx.graph.recipes)) {
    if (!r.in) continue;
    for (const inp of r.in) { keys.add(String(inp[0])); if (inp[2]) keys.add(String(inp[2])); }
  }
  for (const k of keys) { const b = buyCandidate(k, ctx); if (b) acq.set(k, b); }
  const usable = [];
  for (const [rid, r] of Object.entries(ctx.graph.recipes)) {
    if (!r.in || !r.in.length) continue;
    if (r.ml > ctx.P.maxMastery) continue;
    if (ctx.P.profession !== 'all' && r.p !== ctx.P.profession) continue;
    usable.push([rid, r]);
  }
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const [rid, r] of usable) {
      const run = runRecipe(r, ctx, acq);
      if (!run) continue;
      const outKey = String(r.out);
      const po = plainOffer(rid, r, run, ctx);
      if (po && !(acq.has(outKey) && acq.get(outKey).cost <= po.cost)) { acq.set(outKey, po); changed = true; }
      if (r.combo) {
        const cKey = String(r.combo);
        const co = comboOffer(rid, r, run, ctx);
        if (co && !(acq.has(cKey) && acq.get(cKey).cost <= co.cost)) { acq.set(cKey, co); changed = true; }
      }
    }
    if (!changed) break;
  }
  return acq;
}

// Cheapest way to obtain one unit of k: buy, craft, or craft-via-combo.
export function acquire(k, ctx) {
  if (ctx.acq && ctx.acq.has(k)) return ctx.acq.get(k);
  return buyCandidate(k, ctx);
}

export function recipeCost(r, ctx) {
  return runRecipe(r, ctx, ctx.acq || new Map());
}

export function makeCtx(graph, prices, history, P) {
  // Candidate recipes per output, honouring the same mastery/profession limits
  // as evaluate(), so a cost route never assumes a craft the player cannot do.
  const byOut = new Map(), byCombo = new Map();
  const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const [rid, r] of Object.entries(graph.recipes)) {
    if (!r.in || !r.in.length) continue;
    if (r.ml > P.maxMastery) continue;
    if (P.profession !== 'all' && r.p !== P.profession) continue;
    push(byOut, String(r.out), rid);
    if (r.combo) push(byCombo, String(r.combo), rid);
  }
  let rsKey = null;
  for (const [k, v] of Object.entries(prices)) if (v.name === 'Refining Stone') rsKey = k;
  const ctx = { graph, prices, history, P, byOut, byCombo, rsKey, keep: 1 - P.tax - P.listFee };
  ctx.acq = computeAcquire(ctx);
  return ctx;
}

// Evaluate every recipe. Returns rows sorted by profit per minute.
export function evaluate(graph, prices, history, P) {
  const ctx = makeCtx(graph, prices, history, P);
  const byKey = new Map();
  for (const [rid, r] of Object.entries(graph.recipes)) {
    if (!r.in || !r.in.length) continue;
    if (P.profession !== 'all' && r.p !== P.profession) continue;
    if (r.ml > P.maxMastery) continue;
    const out = String(r.out), combo = r.combo ? String(r.combo) : null;
    const name = itemName(graph, prices, out);
    const so = saleValue(out, ctx), sc = combo ? saleValue(combo, ctx) : null;
    if (so == null && sc == null) continue;
    const rc = recipeCost(r, ctx);
    if (!rc) continue;
    const s = successFor(r.ml, P), cp = (r.cp || 0) / 10000, outq = r.outq || 1;
    const plainV = (so || 0) * outq, greenV = sc == null ? plainV : sc;
    const ev = s * ((1 - cp) * plainV + cp * greenV) * ctx.keep;
    const profit = ev - rc.cost;
    const mins = rc.mins + P.minPerCraft;
    const breakEvenGreen = cp > 0 ? (rc.cost / (s * ctx.keep) - (1 - cp) * plainV) / cp : null;
    // Break-even success: the s* at which EV equals cost (independent of s).
    const valueV = (1 - cp) * plainV + cp * greenV;
    const beSuccess = valueV > 0 && ctx.keep > 0 ? rc.cost / (valueV * ctx.keep) : null;
    // Turnover and risk.
    const days = daysToSell(out, ctx);
    const rk = risk((cp > 0 && sc != null)
      ? [[1 - s, -rc.cost], [s * (1 - cp), plainV * ctx.keep - rc.cost], [s * cp, greenV * ctx.keep - rc.cost]]
      : [[1 - s, -rc.cost], [s, plainV * ctx.keep - rc.cost]]);
    const pr = prices[out] || {}, pc = combo ? (prices[combo] || {}) : {};
    const row = {
      rid, name, prof: r.p, ml: r.ml, cost: rc.cost, ev, profit, mins, ppm: profit / mins,
      roi: rc.cost ? profit / rc.cost : 0, out, combo, cp, s,
      plain: pr.p ?? null, plainL: pr.n || 0, plainSold: pr.sold || 0, green: pc.p ?? null, greenL: pc.n || 0, greenSold: pc.sold || 0,
      hist: history && (history[combo || out] || null), breakEvenGreen, lines: rc.lines,
      bandLo: (history && history[combo || out] && history[combo || out].lo) || null,
      days, profitDay: days ? profit / days : null,
      roiDay: days && rc.cost ? (profit / rc.cost) / days : null,
      beSuccess, sigma: rk.sigma, probLoss: rk.probLoss, cvar10: rk.cvar10,
      sharpe: rk.sigma > 0 ? profit / rk.sigma : null,
      maxTrade: maxTrade(combo || out, ctx), capped: isCapped(combo || out, ctx) || isCapped(out, ctx),
      crafts: rc.cost > 0 ? Math.floor(P.budget / rc.cost) : 0,
    };
    // Same item+mastery can be produced by several recipes; keep the most profitable.
    const key = name + '|' + r.ml;
    const prev = byKey.get(key);
    if (!prev || row.profit > prev.profit) byKey.set(key, row);
  }
  const rows = [...byKey.values()];
  rows.sort((a, b) => b.ppm - a.ppm);
  return { rows, ctx };
}

// Expand a recipe into a cost tree for display.
export function tree(rid, ctx, depth = 0) {
  const r = ctx.graph.recipes[rid];
  const rc = recipeCost(r, ctx, depth);
  if (!rc) return null;
  return {
    rid, out: String(r.out), combo: r.combo ? String(r.combo) : null, ml: r.ml, gold: r.gold || 0, cost: rc.cost, mins: rc.mins,
    lines: rc.lines.map(l => ({ ...l, sub: l.via && depth < 4 ? tree(l.via, ctx, depth + 1) : null })),
  };
}
