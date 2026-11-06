// Alpaca paper execution for three strategies: v2 5-MIN, v2 TECH GO and v3 1-min Momentum, one Alpaca paper account each.
// PAPER ONLY: orders go to paper-api.alpaca.markets and live keys (AK...) are refused.
//
// How it stays close to real prices:
//   - Massive (real-time OPRA) is the only price source. Alpaca's own market data is never read.
//   - Every order is a limit order priced from Massive's live bid/ask at that moment. Entries start at the mid and
//     step toward the ask every few seconds; exits start at the mid and step toward the bid (then a few ticks under it).
//     Nothing is sent as a market order, so a wide or moving spread cannot fill far from the quote.
//   - Guards before any entry: quote must be fresh, spread not too wide, the ask not run too far past the board's entry
//     price, the signal itself recent (no chasing plays found late), and size capped by the contracts shown at the ask.
//   - Every fill is recorded with the bid/ask at order time and at fill time, so slippage against the live market and
//     against the board's own price is measured per account and per day.
//
// The board engines decide; this only mirrors their plays. Exits follow the board (stop, target, VWAP, 2:40), and a
// safety net closes anything still held at 2:50 PM CT.

const PAPER_BASE = 'https://paper-api.alpaca.markets';

export const ACCOUNTS = [
  { k: 'five', name: 'v2 5-MIN', keyEnv: 'ALPACA_FIVE_KEY', secEnv: 'ALPACA_FIVE_SECRET' },
  { k: 'techgo', name: 'v2 TECH GO', keyEnv: 'ALPACA_TECHGO_KEY', secEnv: 'ALPACA_TECHGO_SECRET' },
  { k: 'm1', name: 'v3 1-min Momentum', keyEnv: 'ALPACA_M1_KEY', secEnv: 'ALPACA_M1_SECRET' },
];

// Which account (if any) a board record belongs to, and the play in a common shape
export function playOf(board, coll, id, d) {
  if (!d || typeof d !== 'object') return null;
  const occ = t => (t ? String(t).replace(/^O:/, '') : null);
  if (board === 'v2' && coll === 'paper' && (d.source === 'five' || d.source === 'shadow')) {
    return { acct: d.source === 'five' ? 'five' : 'techgo', playId: id, date: d.date, sym: d.sym, occ: occ(d.contract && d.contract.ticker),
      est: !!(d.contract && d.contract.est), qty: Number.isFinite(d.contracts) ? d.contracts : null, signalAt: d.source === 'five' ? d.fiveAt : d.techAt,
      late: !!d.late, legacy: !!d.legacy, refPx: d.premEntry, status: d.status, exitReason: d.exitReason, partialQty: 0 };
  }
  if (board === 'v3' && coll === 'v3trades' && d.tab === 'm1' && d.instr === 'option') {
    return { acct: 'm1', playId: id, date: d.date, sym: d.sym, occ: occ(d.contract && d.contract.ticker), est: false,
      qty: d.qty, signalAt: d.entryAt, late: false, legacy: false, refPx: d.entryAsk ?? d.entryFill, status: d.status, exitReason: d.exitReason,
      partialQty: d.partialQty || 0 };
  }
  return null;
}

export function ctParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, wd: p.weekday };
}

const num = (v, d) => (v === undefined || v === '' || v === null || !Number.isFinite(+v) ? d : +v);

export function createBroker({ env = process.env, quote, store, log = console.log, fetchImpl = fetch, now = () => Date.now(), haltFile = null, fs = null, base = PAPER_BASE }) {
  const C = {
    on: env.BROKER !== 'off',
    stepMs: num(env.BROKER_STEP_MS, 3000),            // time between price steps
    entryMaxMs: num(env.BROKER_ENTRY_MAX_MS, 20000),  // give up on an entry that has not filled in this long
    maxSignalAgeMs: num(env.BROKER_MAX_SIGNAL_AGE_S, 120) * 1000,  // only follow plays that fired this recently
    maxSpreadPct: num(env.BROKER_MAX_SPREAD_PCT, 10),  // skip entries when (ask - bid) / mid is wider than this (%)...
    maxSpreadAbs: num(env.BROKER_MAX_SPREAD_ABS, 0.05), // ...unless the spread is this many dollars or less
    maxChasePct: num(env.BROKER_MAX_CHASE_PCT, 8),     // skip if the ask is this % above the board's entry premium
    quoteMaxAgeMs: num(env.BROKER_QUOTE_MAX_AGE_S, 15) * 1000,
    maxContracts: num(env.BROKER_MAX_CONTRACTS, 10),
    maxOpen: num(env.BROKER_MAX_OPEN, 4),
    dailyLoss: num(env.BROKER_DAILY_LOSS, 1500),       // no new entries once an account is down this much today
    entryStart: 8 * 60 + 30, entryEnd: num(env.BROKER_ENTRY_END_MIN, 14 * 60 + 35), flatMin: 14 * 60 + 50, closeMin: 15 * 60,
  };
  const ENTRY_STEPS = [0.5, 0.65, 0.8, 1.0];   // fraction of the spread above the bid: mid -> ask
  const EXIT_STEPS = [0.5, 0.65, 0.8, 1.0];    // fraction of the spread below the ask: mid -> bid, then ticks under the bid
  const accts = {};
  for (const a of ACCOUNTS) {
    const key = (env[a.keyEnv] || '').trim(), sec = (env[a.secEnv] || '').trim();
    let why = null;
    if (!key || !sec) why = 'no keys set';
    else if (/^AK/.test(key)) why = 'live key refused: paper accounts only (paper keys start with PK)';
    accts[a.k] = { ...a, key, sec, ok: !why, why, info: null };
  }
  const L = store.data;   // { plays: {acct:playId -> play}, orders: {cid -> order}, days: {date -> {acct -> stats}} }
  L.plays = L.plays || {}; L.orders = L.orders || {};
  const save = () => store.save();
  const pk = (acct, playId) => acct + ':' + playId;
  const halted = () => env.BROKER_HALT === '1' || (haltFile && fs && fs.existsSync(haltFile));
  let seq = 0;

  async function api(acct, method, p, body) {
    const a = accts[acct];
    const r = await fetchImpl(base + p, { method, headers: { 'APCA-API-KEY-ID': a.key, 'APCA-API-SECRET-KEY': a.sec, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = { message: txt }; }
    if (!r.ok) { const e = new Error((j && j.message) || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // Option tick size: $0.01 under $3 (and always for SPY/QQQ/IWM), else $0.05. An order rejected for its increment retries one size up.
  const tickOf = (o, px) => (o.tick5 ? (px < 3 ? 0.05 : 0.10) : (/^(SPY|QQQ|IWM)\d/.test(o.occ) || px < 3 ? 0.01 : 0.05));
  const roundTo = (px, t, up) => { const n = px / t; return +(Math.max(t, (up ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9)) * t)).toFixed(2); };

  async function getQuote(sym, occ) {
    const q = await quote(sym, 'O:' + occ);
    if (!q || !(q.ask > 0) || !(q.bid >= 0) || q.ask < q.bid) return null;
    return { bid: q.bid, ask: q.ask, mid: (q.bid + q.ask) / 2, bidSize: q.bidSize ?? null, askSize: q.askSize ?? null, at: q.at ?? null };
  }
  const fresh = q => q && (!q.at || now() - q.at <= C.quoteMaxAgeMs);

  function limitFor(o, q) {
    const spread = q.ask - q.bid; const t = tickOf(o, q.mid);
    if (o.side === 'buy') {
      const f = ENTRY_STEPS[Math.min(o.step, ENTRY_STEPS.length - 1)];
      return Math.min(roundTo(q.bid + spread * f, t, true), roundTo(q.ask, t, true));
    }
    if (o.step < EXIT_STEPS.length) return roundTo(q.ask - spread * EXIT_STEPS[o.step], t, false);
    const under = o.step - EXIT_STEPS.length + 1;   // past the bid: one more tick under it each step, never below 80% of the bid
    return Math.max(roundTo(q.bid * 0.8, t, false), roundTo(q.bid - under * t, t, false), 0.01);
  }

  function dayStats(date, acct) { L.days = L.days || {}; const d = (L.days[date] = L.days[date] || {}); return (d[acct] = d[acct] || { fills: 0, realized: 0, slipMid: 0, slipBoard: 0, slipSpread: 0, skipped: {} }); }
  function audit(o, q, px, qty) {
    const P = L.plays[o.play]; const st = dayStats(P.date, P.acct);
    const mid = q && q.ask > 0 ? (q.bid + q.ask) / 2 : null, spread = q && q.ask > 0 ? q.ask - q.bid : null;
    const slipMid = mid != null ? (o.side === 'buy' ? px - mid : mid - px) : null;          // $ per share worse than the mid
    const boardPx = o.side === 'buy' ? P.refPx : null;
    const slipBoard = boardPx > 0 ? px - boardPx : null;
    o.fills = o.fills || []; o.fills.push({ at: now(), qty, px, bid: q ? q.bid : null, ask: q ? q.ask : null, slipMid, slipBoard });
    st.fills++; if (slipMid != null) { st.slipMid += slipMid * qty * 100; if (spread > 0) st.slipSpread += (slipMid / spread) * qty; }
    if (slipBoard != null) st.slipBoard += slipBoard * qty * 100;
  }

  function newOrder(play, kind, side, qty, reason) {
    const cid = `${play.acct}-${play.playId}`.slice(0, 34) + `-${kind[0]}${Date.now().toString(36).slice(-5)}${(seq++ % 36).toString(36)}`;
    const o = { cid, play: pk(play.acct, play.playId), acct: play.acct, sym: play.sym, occ: play.occ, kind, side, qty, filled: 0, cost: 0, step: 0, state: 'new', reason,
      created: now(), nextAt: now(), alpacaId: null, submitted: [], deadline: kind === 'entry' ? now() + C.entryMaxMs : null };
    L.orders[cid] = o; save(); return o;
  }

  // ---- play events from the boards ----
  async function onDoc(board, coll, id, d) {
    const p = playOf(board, coll, id, d); if (!p || !C.on) return;
    const A = accts[p.acct]; if (!A || (!A.ok && !L.plays[pk(p.acct, p.playId)])) return;   // account without keys: ignore its plays quietly
    const key = pk(p.acct, p.playId); let P = L.plays[key];
    const t = ctParts(now());
    if (!P) {
      if (p.status !== 'open' || p.legacy || p.date !== t.date) return;
      P = L.plays[key] = { acct: p.acct, playId: p.playId, date: p.date, sym: p.sym, occ: p.occ, refPx: p.refPx, boardQty: p.qty, held: 0, sold: 0, cost: 0, proceeds: 0, state: 'new', created: now(), partialDone: false };
      const skip = why => { P.state = 'skipped'; P.why = why; const st = dayStats(p.date, p.acct); st.skipped[why.split(':')[0]] = (st.skipped[why.split(':')[0]] || 0) + 1; log(`broker ${A.name}: skipped ${p.playId}: ${why}`); save(); };
      if (halted()) return skip('trading halted (kill switch)');
      if (t.min < C.entryStart || t.min > C.entryEnd) return skip('outside entry hours');
      if (p.late) return skip('found late: the board saw it after it fired');
      if (p.signalAt && now() - p.signalAt > C.maxSignalAgeMs) return skip(`stale signal: fired ${Math.round((now() - p.signalAt) / 1000)} s ago`);
      if (!(p.qty >= 1)) return skip('board size is 0 contracts');
      const open = Object.values(L.plays).filter(x => x.acct === p.acct && x.date === p.date && (x.state === 'entering' || x.state === 'open')).length;
      if (open >= C.maxOpen) return skip(`max ${C.maxOpen} open positions`);
      if (dayStats(p.date, p.acct).realized <= -C.dailyLoss) return skip(`daily loss limit ($${C.dailyLoss}) reached`);
      if (!p.occ) { P.state = 'waiting'; P.why = 'no contract yet'; save(); return; }
      return startEntry(P, p);
    }
    if (P.state === 'waiting' && p.occ && p.status === 'open') { P.occ = p.occ; P.refPx = p.refPx; P.boardQty = p.qty; return startEntry(P, p); }
    if (P.state === 'waiting' && p.status === 'closed') { P.state = 'skipped'; P.why = 'closed before a contract was routed'; save(); return; }
    if (p.partialQty > 0 && !P.partialDone && (P.state === 'open' || P.state === 'entering')) {
      P.partialDone = true; save();
      const q = Math.floor(P.held / 2); if (q >= 1) newOrder(P, 'partial', 'sell', q, 'half off at 1R');
    }
    if (p.status === 'closed' && (P.state === 'open' || P.state === 'entering')) {
      P.state = 'closing'; P.exitReason = p.exitReason || 'closed on the board'; save();
      for (const o of Object.values(L.orders)) if (o.play === key && o.kind === 'entry' && !['done', 'failed', 'missed'].includes(o.state)) o.cancelForExit = true;
      queueExit(P);
    }
  }

  async function startEntry(P, p) {
    if (p.est) {   // 5-MIN first records an estimated contract, then routes the real one: wait up to 30 s for it, then use the estimate only if it has a live quote
      if (!P.estSince) { P.estSince = now(); P.state = 'waiting'; P.why = 'waiting for the routed contract'; save(); return; }
      if (now() - P.estSince < 30000) return;
    }
    if (P.state === 'checking' || P.state === 'entering') return;   // already being started (board write and tick can arrive together)
    P.state = 'checking';
    const q = await getQuote(P.sym, P.occ).catch(() => null);
    const skip = why => { P.state = 'skipped'; P.why = why; const st = dayStats(P.date, P.acct); st.skipped[why.split(':')[0]] = (st.skipped[why.split(':')[0]] || 0) + 1; log(`broker ${accts[P.acct].name}: skipped ${P.playId}: ${why}`); save(); };
    if (!q) return skip('no live quote for ' + P.occ);
    if (!fresh(q)) return skip('quote is stale');
    const spread = q.ask - q.bid, pct = q.mid > 0 ? spread / q.mid * 100 : 999;
    if (pct > C.maxSpreadPct && spread > C.maxSpreadAbs) return skip(`spread too wide: ${pct.toFixed(1)}% ($${q.bid.toFixed(2)} x $${q.ask.toFixed(2)})`);
    if (P.refPx > 0 && q.ask > P.refPx * (1 + C.maxChasePct / 100)) return skip(`price ran: ask $${q.ask.toFixed(2)} is ${((q.ask / P.refPx - 1) * 100).toFixed(1)}% above the board's $${P.refPx.toFixed(2)}`);
    let qty = Math.min(P.boardQty, C.maxContracts);
    if (q.askSize > 0 && q.askSize < qty) { P.sizeNote = `capped at the ${q.askSize} contracts shown at the ask (board: ${P.boardQty})`; qty = q.askSize; }
    P.state = 'entering'; P.entryQuote = q; save();
    newOrder(P, 'entry', 'buy', qty, 'board entry');
  }

  function queueExit(P) {
    const working = Object.values(L.orders).some(o => o.play === pk(P.acct, P.playId) && o.side === 'sell' && !['done', 'failed'].includes(o.state));
    const entryLive = Object.values(L.orders).some(o => o.play === pk(P.acct, P.playId) && o.kind === 'entry' && !['done', 'failed', 'missed'].includes(o.state));
    if (entryLive || working) return;   // the tick loop calls this again once the entry is finished
    const left = P.held;
    if (left >= 1) newOrder(P, 'exit', 'sell', left, P.exitReason || 'exit');
    else { P.state = P.cost > 0 ? 'closed' : 'missed'; save(); }
  }

  // ---- order engine: one pass per second ----
  async function submit(o) {
    const P = L.plays[o.play];
    let q = await getQuote(o.sym, o.occ).catch(() => null);
    if (q) o.lastQ = q;
    else if (o.side === 'sell' && now() - o.created > 30000) q = o.lastQ || P.entryQuote || null;   // Massive unreachable: keep working the exit from the last known quote
    if (o.kind === 'entry') {
      if (!q || !fresh(q)) { o.nextAt = now() + 1000; return; }
      if (P.refPx > 0 && q.ask > P.refPx * (1 + C.maxChasePct / 100)) { o.state = 'missed'; o.why = 'price ran past the chase limit'; return finishEntry(o); }
    }
    if (!q) { o.nextAt = now() + 1000; return; }
    const left = o.qty - o.filled; if (left < 1) { o.state = 'done'; return; }
    const limit = limitFor(o, q);
    o.attempts = (o.attempts || 0) + 1;   // every submission, accepted or refused, gets its own client order id
    const cid = o.cid + (o.attempts > 1 ? '-' + (o.attempts - 1) : '');
    const body = { symbol: o.occ, qty: String(left), side: o.side, type: 'limit', time_in_force: 'day', limit_price: limit.toFixed(2), client_order_id: cid,
      position_intent: o.side === 'buy' ? 'buy_to_open' : 'sell_to_close' };
    try {
      const r = await api(o.acct, 'POST', '/v2/orders', body);
      o.alpacaId = r.id; o.state = 'working'; o.limit = limit; o.submitted.push({ at: now(), limit, bid: q.bid, ask: q.ask, qty: left, id: r.id });
      o.nextAt = now() + C.stepMs;
    } catch (e) {
      if (/increment|tick|sub-?penny|price.*(multiple|invalid)/i.test(e.message) && !o.tick5) { o.tick5 = true; o.nextAt = now(); return; }
      o.errors = (o.errors || 0) + 1; o.lastErr = e.message; log(`broker ${accts[o.acct].name}: order ${o.kind} ${o.occ} refused: ${e.message}`);
      if (o.errors >= 3) { o.state = 'failed'; if (o.kind === 'entry') return finishEntry(o); }
      o.nextAt = now() + 2000;
    }
  }

  async function finishEntry(o) {
    const P = L.plays[o.play];
    if (o.filled > 0) { P.state = P.state === 'closing' ? 'closing' : 'open'; }
    else if (P.state !== 'closing') { P.state = 'missed'; P.why = o.why || 'entry did not fill in ' + Math.round(C.entryMaxMs / 1000) + ' s'; dayStats(P.date, P.acct).skipped['not filled'] = (dayStats(P.date, P.acct).skipped['not filled'] || 0) + 1; }
    save();
    if (P.state === 'closing') queueExit(P);
  }

  async function poll(o) {
    let r; try { r = await api(o.acct, 'GET', '/v2/orders/' + o.alpacaId); } catch (e) { o.lastErr = e.message; return; }
    const filled = num(r.filled_qty, 0), avg = num(r.filled_avg_price, 0);
    const already = o.submitted[o.submitted.length - 1].filledSeen || 0;
    if (filled > already) {
      const add = filled - already; const lastCost = (o.submitted[o.submitted.length - 1].avgSeen || 0) * already;
      const px = (avg * filled - lastCost) / add;
      o.submitted[o.submitted.length - 1].filledSeen = filled; o.submitted[o.submitted.length - 1].avgSeen = avg;
      const q = await getQuote(o.sym, o.occ).catch(() => null);
      o.filled += add; o.cost += px * add; audit(o, q || o.submitted[o.submitted.length - 1], px, add);
      const P = L.plays[o.play];
      if (o.side === 'buy') { P.held += add; P.cost += px * add * 100; }
      else { P.held -= add; P.sold += add; P.proceeds += px * add * 100; }
      save();
    }
    const st = r.status;
    if (st === 'filled') {
      o.state = 'done'; o.avgPx = o.cost / Math.max(1, o.filled);
      const P = L.plays[o.play];
      if (o.kind === 'entry') return finishEntry(o);
      if (P.held <= 0) { P.state = 'closed'; const pl = P.proceeds - P.cost; P.realized = Math.round(pl); dayStats(P.date, P.acct).realized += pl;
        log(`broker ${accts[P.acct].name}: closed ${P.playId} ${P.sold}x ${P.occ}: ${pl >= 0 ? '+' : '-'}$${Math.abs(Math.round(pl))}`); }
      save(); return;
    }
    if (['canceled', 'expired', 'rejected', 'done_for_day', 'replaced'].includes(st)) {
      if (o.kind === 'entry' && (o.cancelForExit || o.giveUp || st === 'rejected' || st === 'expired')) { o.state = o.filled > 0 ? 'done' : 'missed'; return finishEntry(o); }
      if (o.filled >= o.qty) { o.state = 'done'; save(); return; }
      o.step++; o.state = 'new'; o.nextAt = now(); save(); return;   // our own cancel to re-price: send the next step
    }
    // still working: re-price when its step time is up, or give up on a slow entry
    if (o.state === 'working' && (now() >= o.nextAt || o.cancelForExit || (o.deadline && now() >= o.deadline))) {
      if (o.kind === 'entry' && ((o.deadline && now() >= o.deadline) || o.cancelForExit)) o.giveUp = true;
      if (o.kind === 'entry' && !o.giveUp && o.step >= ENTRY_STEPS.length - 1) { o.nextAt = now() + C.stepMs; return; }   // already at the ask: wait for the deadline
      o.state = 'canceling';
      try { await api(o.acct, 'DELETE', '/v2/orders/' + o.alpacaId); } catch (e) { /* already filled or gone: the next poll sees it */ }
    }
  }

  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const t = ctParts(now());
      for (const o of Object.values(L.orders)) {
        if (['done', 'failed', 'missed'].includes(o.state)) continue;
        if (!accts[o.acct] || !accts[o.acct].ok) continue;
        if (t.min >= C.closeMin + 5 && o.kind === 'entry') { o.state = 'missed'; o.why = 'market closed'; await finishEntry(o); continue; }
        if (o.state === 'new' && now() >= o.nextAt) await submit(o);
        else if (o.state === 'working' || o.state === 'canceling') await poll(o);
      }
      // positions waiting on an entry to finish before their exit, and the 2:50 PM safety net
      for (const P of Object.values(L.plays)) {
        if (P.state === 'closing') queueExit(P);
        if (P.state === 'open' && P.held > 0 && P.date === t.date && t.min >= C.flatMin && t.min < C.closeMin + 10) { P.state = 'closing'; P.exitReason = 'safety close 2:50 PM'; save(); queueExit(P); }
        if (P.state === 'waiting' && P.estSince) startEntry(P, { est: true }).catch(() => {});
      }
    } finally { busy = false; }
  }

  async function connect() {
    for (const a of Object.values(accts)) {
      if (!a.ok) { log(`broker ${a.name}: ${a.why}`); continue; }
      try {
        const r = await api(a.k, 'GET', '/v2/account');
        a.info = { status: r.status, equity: num(r.equity, null), buyingPower: num(r.options_buying_power ?? r.buying_power, null), optionsLevel: r.options_trading_level ?? r.options_approved_level ?? null, number: r.account_number ? String(r.account_number).slice(-4) : null };
        if (a.info.optionsLevel != null && a.info.optionsLevel < 2) { a.ok = false; a.why = 'options level ' + a.info.optionsLevel + ' on this paper account: buying calls and puts needs level 2'; }
        log(`broker ${a.name}: connected to paper account …${a.info.number || '?'} (equity $${a.info.equity}, options level ${a.info.optionsLevel})`);
      } catch (e) { a.ok = false; a.why = e.status === 401 || e.status === 403 ? 'Alpaca refused the keys' : 'cannot reach Alpaca: ' + e.message; log(`broker ${a.name}: ${a.why}`); }
    }
  }

  function status() {
    const t = ctParts(now()); const out = { on: C.on, halted: halted(), paperOnly: true, accounts: {} };
    for (const a of Object.values(accts)) {
      const st = (L.days && L.days[t.date] && L.days[t.date][a.k]) || null;
      const plays = Object.values(L.plays).filter(x => x.acct === a.k && x.date === t.date);
      out.accounts[a.k] = { name: a.name, connected: a.ok, why: a.why, info: a.info,
        today: { plays: plays.length, open: plays.filter(x => x.state === 'open' || x.state === 'entering' || x.state === 'closing').length,
          closed: plays.filter(x => x.state === 'closed').length, skipped: plays.filter(x => x.state === 'skipped' || x.state === 'missed').length,
          realized: st ? Math.round(st.realized) : 0, fills: st ? st.fills : 0,
          slipVsMidUsd: st ? Math.round(st.slipMid) : 0, slipVsBoardUsd: st ? Math.round(st.slipBoard) : 0, skipReasons: st ? st.skipped : {} } };
    }
    return out;
  }

  return { onDoc, tick, connect, status, config: C, accounts: accts, ledger: L };
}
