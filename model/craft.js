// Pure crafting-economics model. No DOM access in here.
// Inputs: graph (items, recipes, byProduct, byCombo), prices {key:{p,n,sold,avg,...}}, history {key:{lo,hi,gone,...}}, params.

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

// Cheapest way to obtain one unit: buy, craft (plain output), or craft-combo (green output).
// Returns {cost, mins, how, via} or null.
export function acquire(k, ctx, depth = 0) {
  const memo = ctx.memo;
  const mk = k + '|' + (depth < 5);
  if (memo.has(mk)) return memo.get(mk);
  const { graph, P } = ctx;
  let best = null;
  const bp = buyPrice(k, ctx);
  if (bp != null) best = { cost: bp, mins: 0, how: isNpcItem(graph, ctx.prices, k) ? 'npc' : 'buy', via: null };
  if (depth < 5) {
    for (const rid of ctx.byOut.get(k) || []) {
      const r = graph.recipes[rid];
      const rc = recipeCost(r, ctx, depth + 1);
      if (!rc) continue;
      const s = successFor(r.ml, P), cp = (r.cp || 0) / 10000, outq = r.outq || 1;
      const denom = s * (1 - cp) * outq;
      if (denom <= 0) continue;
      const comboCredit = r.combo ? cp * (saleValue(String(r.combo), ctx) || 0) * ctx.keep : 0;
      const perUnit = (rc.cost - s * comboCredit) / denom;
      const mins = (rc.mins + P.minPerCraft) / denom;
      if (perUnit >= 0 && (!best || perUnit < best.cost)) best = { cost: perUnit, mins, how: 'craft', via: rid };
    }
    for (const crid of ctx.byCombo.get(k) || []) {
      const r = graph.recipes[crid];
      const cp = (r.cp || 0) / 10000;
      if (cp <= 0) continue;
      const rc = recipeCost(r, ctx, depth + 1);
      if (!rc) continue;
      const s = successFor(r.ml, P);
      const denom = s * cp;
      if (denom <= 0) continue;
      const plainCredit = (1 - cp) * (saleValue(String(r.out), ctx) || 0) * ctx.keep;
      const perUnit = (rc.cost - s * plainCredit) / denom;
      const mins = (rc.mins + P.minPerCraft) / denom;
      if (perUnit >= 0 && (!best || perUnit < best.cost)) best = { cost: perUnit, mins, how: 'craft-combo', via: crid };
    }
  }
  memo.set(mk, best);
  return best;
}

export function recipeCost(r, ctx, depth = 0) {
  let cost = r.gold || 0, mins = 0;
  const lines = [];
  for (const inp of r.in) {
    const k = String(inp[0]), qty = inp[1], alt = inp[2] ? String(inp[2]) : null;
    let a = acquire(k, ctx, depth), used = k;
    if (alt) { const b = acquire(alt, ctx, depth); if (b && (!a || b.cost < a.cost)) { a = b; used = alt; } }
    if (!a) return null;
    cost += a.cost * qty; mins += a.mins * qty;
    lines.push({ key: used, qty, unit: a.cost, how: a.how, via: a.via, mins: a.mins });
  }
  return { cost, mins, lines };
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
  return { graph, prices, history, P, byOut, byCombo, rsKey, keep: 1 - P.tax - P.listFee, memo: new Map() };
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
    const mins = rc.mins + P.minPerCraft;
    const breakEvenGreen = cp > 0 ? (rc.cost / (s * ctx.keep) - (1 - cp) * plainV) / cp : null;
    const pr = prices[out] || {}, pc = combo ? (prices[combo] || {}) : {};
    const row = {
      rid, name, prof: r.p, ml: r.ml, cost: rc.cost, ev, profit: ev - rc.cost, mins, ppm: (ev - rc.cost) / mins,
      roi: rc.cost ? (ev - rc.cost) / rc.cost : 0, out, combo, cp, s,
      plain: pr.p ?? null, plainL: pr.n || 0, plainSold: pr.sold || 0, green: pc.p ?? null, greenL: pc.n || 0, greenSold: pc.sold || 0,
      hist: history && (history[combo || out] || null), breakEvenGreen, lines: rc.lines,
      bandLo: (history && history[combo || out] && history[combo || out].lo) || null,
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
