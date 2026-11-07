// Conviction Cloud: runs the Conviction boards around the clock on a server.
// - Serves each board page with a small shim that stands in for the Claude app (market data + database).
// - Market data: the official Massive MCP server (same one the Claude app used on the Mac), run locally with your API key.
// - Database: JSON files on this server, pushed live to every open page.
// - Engine: a headless Chromium keeps one copy of each board open 24/7. That copy is the only one that records trades;
//   pages you open in your own browser are viewers (they show everything live but never place paper trades).
// Paper trading only. Nothing here connects to a broker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBroker } from './broker.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
const CFG = {
  port: +(process.env.PORT || 80),
  host: process.env.HOST || '0.0.0.0',
  user: process.env.BOARD_USER || 'bilal',
  pass: process.env.BOARD_PASSWORD || '',
  massiveKey: process.env.MASSIVE_API_KEY || '',
  massiveCmd: process.env.MASSIVE_CMD || 'mcp_massive',
  massiveArgs: process.env.MASSIVE_ARGS ? JSON.parse(process.env.MASSIVE_ARGS) : [],
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  typesafeKey: process.env.TYPESAFE_API_KEY || '',      // real Jev (TypeSafe), the same model the claude.ai boards use
  evaluateCmd: process.env.EVALUATE_CMD || 'evaluate',
  jevModel: process.env.JEV_MODEL || 'claude-haiku-5-5',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  engine: process.env.ENGINE !== 'off',
  engineToken: process.env.ENGINE_TOKEN || crypto.randomBytes(18).toString('hex'),
  gitSync: process.env.GIT_SYNC !== 'off',
  exportKey: process.env.EXPORT_KEY || '',
  stream: process.env.STREAM !== 'off',
  streamUrl: process.env.STREAM_URL || 'wss://socket.massive.com/stocks',
};
const BOARDS = {
  v3: { file: 'boards/v3.html', title: 'Conviction Board v3', engineOnly: ['v3trades', 'v3signals'] },
  v2: { file: 'boards/v2.html', title: 'Conviction Engine v2', engineOnly: ['paper', 'real', 'managed'] },
};
fs.mkdirSync(CFG.dataDir, { recursive: true });
const LOG = [];
function log(...a) { const line = new Date().toISOString() + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(line); LOG.push(line); if (LOG.length > 400) LOG.shift(); }

function loadEnv(f) {
  try { for (const ln of fs.readFileSync(f, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(ln); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { }
}

/* ------------------------------------------------------------------ Massive (MCP over stdio) */
const M = { client: null, connecting: null, okAt: 0, fails: 0, lastErr: null, calls: 0 };
async function massiveClient() {
  if (M.client) return M.client;
  if (M.connecting) return M.connecting;
  if (M.startFailAt && Date.now() - M.startFailAt < 20000) throw new Error(M.lastStartErr || 'data server failed to start');
  M.connecting = (async () => {
    const env = { ...process.env, MASSIVE_API_KEY: CFG.massiveKey, HOME: process.env.HOME || '/root' };
    const transport = new StdioClientTransport({ command: CFG.massiveCmd, args: CFG.massiveArgs, env, stderr: 'pipe' });
    const c = new Client({ name: 'conviction-cloud', version: '1.0.0' });
    transport.onclose = () => { if (M.client === c) { M.client = null; log('massive: connection closed, will reconnect on next call'); } };
    // capture the data server's own messages from the start, so a startup failure shows its reason
    M.stderr = [];
    try { transport.stderr && transport.stderr.on('data', d => { for (const ln of String(d).split('\n')) { const t = ln.trim(); if (!t || /Processing request of type/.test(t)) continue; M.stderr.push(t); if (M.stderr.length > 30) M.stderr.shift(); log('massive:', t.slice(0, 300)); } }); } catch (e) { }
    try { await c.connect(transport); }
    catch (e) { await new Promise(r => setTimeout(r, 300)); const tail = (M.stderr || []).slice(-4).join(' | '); throw new Error(e.message + (tail ? ' — ' + tail : '')); }
    M.client = c; log('massive: connected');
    return c;
  })();
  try { const c = await M.connecting; M.startFailAt = 0; return c; } catch (e) { M.startFailAt = Date.now(); M.lastStartErr = e.message; throw e; } finally { M.connecting = null; }
}
async function callMassive(input) {
  M.calls++;
  let c;
  try { c = await massiveClient(); } catch (e) { M.fails++; M.lastErr = 'start: ' + e.message; throw { code: 'server_unavailable', message: 'Massive data server did not start: ' + e.message }; }
  let r;
  try { r = await c.callTool({ name: 'call_api', arguments: input }, undefined, { timeout: 60000 }); }
  catch (e) { M.fails++; M.lastErr = e.message; if (/closed|not connected/i.test(e.message)) M.client = null; throw { code: 'server_unavailable', message: e.message }; }
  const text = (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  const m = /^Error \[([A-Z_]+)\]/.exec(text);
  if (m) {
    M.lastErr = text.slice(0, 200);
    if (m[1] === 'RATE_LIMIT') { M.fails++; throw { code: 'rate_limited', message: text.slice(0, 300), retryAfterMs: 15000 }; }
    if (m[1] === 'SERVER' || m[1] === 'NETWORK') { M.fails++; throw { code: 'server_unavailable', message: text.slice(0, 300) }; }
    if (m[1] === 'AUTH') { M.fails++; throw { code: 'not_granted', message: 'Massive rejected the API key: ' + text.slice(0, 200) }; }
    // other errors (bad path, not found, too large) come back as text, the same way they did in the Claude app
  }
  M.okAt = Date.now(); M.fails = 0;
  return { payload: { result: text } };
}

/* ------------------------------------------------------------------ Jev (news score) */
// Preferred: the real Jev from TypeSafe, through its own MCP program ("evaluate"), exactly as the claude.ai boards reach it.
// Fallback only when no TypeSafe key is set: a stand-in that asks Claude (Haiku) through the Anthropic API.
const JEV = { calls: 0, lastErr: null, via: null, client: null, connecting: null, startFailAt: 0 };
async function evaluateClient() {
  if (JEV.client) return JEV.client;
  if (JEV.connecting) return JEV.connecting;
  if (JEV.startFailAt && Date.now() - JEV.startFailAt < 20000) throw new Error(JEV.lastStartErr || 'Jev program failed to start');
  JEV.connecting = (async () => {
    const env = { ...process.env, TYPESAFE_API_KEY: CFG.typesafeKey, HOME: process.env.HOME || '/root' };
    const transport = new StdioClientTransport({ command: CFG.evaluateCmd, args: ['mcp'], env, stderr: 'pipe' });
    const c = new Client({ name: 'conviction-cloud', version: '1.0.0' });
    transport.onclose = () => { if (JEV.client === c) { JEV.client = null; log('jev: connection closed, will reconnect on next call'); } };
    const err = []; try { transport.stderr && transport.stderr.on('data', d => { for (const ln of String(d).split('\n')) { const t = ln.trim(); if (t) { err.push(t); if (err.length > 20) err.shift(); } } }); } catch (e) { }
    try { await c.connect(transport); }
    catch (e) { await new Promise(r => setTimeout(r, 300)); throw new Error(e.message + (err.length ? ' — ' + err.slice(-3).join(' | ') : '')); }
    JEV.client = c; log('jev: connected to TypeSafe Jev');
    return c;
  })();
  try { const c = await JEV.connecting; JEV.startFailAt = 0; return c; } catch (e) { JEV.startFailAt = Date.now(); JEV.lastStartErr = e.message; throw e; } finally { JEV.connecting = null; }
}
async function callTypesafe(input) {
  const c = await evaluateClient();
  let r; try { r = await c.callTool({ name: 'evaluate', arguments: input }, undefined, { timeout: 60000 }); }
  catch (e) { if (/closed|not connected/i.test(e.message)) JEV.client = null; throw { code: 'server_unavailable', message: 'Jev: ' + e.message }; }
  const text = (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  let j = null; try { j = JSON.parse(text); } catch (e) { }
  if (r.isError || !j) throw { code: /rate|429/i.test(text) ? 'rate_limited' : 'server_unavailable', message: 'Jev: ' + text.slice(0, 300), retryAfterMs: /rate|429/i.test(text) ? 15000 : undefined };
  return { payload: j };   // {answers:{...}} or, for items, {results:{...}, errors, meta}: the same shape the boards read in claude.ai
}
async function jevOne(instructions, ticker, headlines) {
  const prompt = `${instructions}\n\nTicker: ${ticker || 'unknown'}\nHeadlines:\n${(headlines || []).map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n` +
    `Answer with only a JSON object {"p": <probability from 0 to 1 that the answer is yes>}. Use 0.5 when the headlines say nothing either way.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CFG.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CFG.jevModel, max_tokens: 50, messages: [{ role: 'user', content: prompt }] }),
  });
  if (res.status === 429) throw { code: 'rate_limited', message: 'Anthropic API rate limit', retryAfterMs: 20000 };
  if (!res.ok) throw { code: 'server_unavailable', message: 'Anthropic API ' + res.status + ': ' + (await res.text()).slice(0, 200) };
  const j = await res.json(); const t = ((j.content || []).find(x => x.type === 'text') || {}).text || '';
  const m = /"p"\s*:\s*([0-9.]+)/.exec(t) || /([01](?:\.\d+)?)/.exec(t);
  const p = m ? Math.max(0, Math.min(1, +m[1])) : null;
  return p;
}
async function callJev(input) {
  if (CFG.typesafeKey) {
    JEV.calls++; JEV.via = 'typesafe';
    try { return await callTypesafe(input); } catch (e) { JEV.lastErr = e.message || String(e); throw e; }
  }
  if (!CFG.anthropicKey) throw { code: 'server_not_connected', message: 'Jev news score is off on the server (no TypeSafe API key set).' };
  JEV.calls++; JEV.via = 'anthropic';
  const qs = input.questions || {}; const key = Object.keys(qs)[0] || 'up'; const ins = (qs[key] && qs[key].instructions) || '';
  try {
    if (input.items) {
      const results = {};
      for (const [k, st] of Object.entries(input.items)) { try { const p = await jevOne(ins, (st && st.ticker) || k, st && st.headlines); results[k] = { answers: { [key]: { noul: p } } }; } catch (e) { results[k] = { error: e.code || 'error' }; } }
      return { payload: { results } };
    }
    const st = input.state || {}; const p = await jevOne(ins, st.ticker, st.headlines);
    return { payload: { answers: { [key]: { noul: p } } } };
  } catch (e) { JEV.lastErr = e.message || String(e); throw e; }
}

/* ------------------------------------------------------------------ database (JSON files, live push) */
const DB = {};      // board -> {coll -> {id -> doc}}
const DIRTY = new Set(); const SUBS = {}; // board -> Set(res)
function dbFile(board) { return path.join(CFG.dataDir, `db-${board}.json`); }
function dbOf(board) {
  if (DB[board]) return DB[board];
  try { DB[board] = JSON.parse(fs.readFileSync(dbFile(board), 'utf8')); } catch (e) { DB[board] = {}; }
  return DB[board];
}
function dbSave(board) { DIRTY.add(board); }
setInterval(() => { for (const b of [...DIRTY]) { DIRTY.delete(b); const f = dbFile(b); const tmp = f + '.tmp'; try { fs.writeFileSync(tmp, JSON.stringify(DB[b])); fs.renameSync(tmp, f); } catch (e) { log('db save failed', b, e.message); } } }, 700);
// daily backup, keep 14
setInterval(() => { const d = new Date().toISOString().slice(0, 10); const dir = path.join(CFG.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  for (const b of [...Object.keys(BOARDS), 'broker']) { const f = path.join(dir, `db-${b}-${d}.json`); if (!fs.existsSync(f) && DB[b]) fs.writeFileSync(f, JSON.stringify(DB[b])); }
  const files = fs.readdirSync(dir).sort(); for (const b of Object.keys(BOARDS)) { const mine = files.filter(x => x.startsWith(`db-${b}-`)); while (mine.length > 14) fs.unlinkSync(path.join(dir, mine.shift())); } }, 3600e3);
const pushTimers = {};
function pushColl(board, coll) {
  const k = board + '/' + coll; if (pushTimers[k]) return;
  pushTimers[k] = setTimeout(() => { delete pushTimers[k]; const docs = dbOf(board)[coll] || {}; const msg = `data: ${JSON.stringify({ coll, docs })}\n\n`; for (const r of SUBS[board] || []) { try { r.write(msg); } catch (e) { } } }, 120);
}
function dbWrite(board, coll, id, op, data) {
  const d = dbOf(board); const c = (d[coll] = d[coll] || {});
  if (op === 'set') c[id] = data;
  else if (op === 'update') { if (!c[id]) throw { code: 'not_found', message: 'No such document' }; c[id] = deepMerge(c[id], data); }
  else if (op === 'delete') delete c[id];
  else throw { code: 'bad_request', message: 'Unknown op' };
  dbSave(board); pushColl(board, coll);
  // Alpaca paper execution mirrors the plays of three strategies (broker.mjs); it never blocks or changes the write
  if (BROKER && ((board === 'v2' && coll === 'paper') || (board === 'v3' && coll === 'v3trades')) && op !== 'delete') {
    BROKER.onDoc(board, coll, id, c[id]).catch(e => log('broker:', e.message));
  }
}
function deepMerge(a, b) { if (!b || typeof b !== 'object' || Array.isArray(b)) return b; const o = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) }; for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && v.__delete__) delete o[k]; else o[k] = v; } return o; }

/* ------------------------------------------------------------------ data files from GitHub (earnings dates, crowd lean) */
// Claude's morning task updates data/earn.json and data/crowd.json in the GitHub repo; this copies them into the v3 board.
const FEEDS = [['earn.json', 'next'], ['crowd.json', 'crowd']];
function loadFeeds() {
  for (const [f, doc] of FEEDS) {
    const p = path.join(ROOT, 'feeds', f); let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    let v; try { v = JSON.parse(txt); } catch (e) { log('feed parse failed', f); continue; }
    const cur = (dbOf('v3').v3earn || {})[doc];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) { dbWrite('v3', 'v3earn', doc, 'set', v); log('feed loaded:', f, 'asOf', v.asOf); }
  }
}

/* ------------------------------------------------------------------ live stream (Massive WebSocket) */
// One connection to Massive's real-time stocks stream. Per-second (A) and per-minute (AM) aggregates keep today's
// 1-minute bars and last prices in memory, so the boards' bar and snapshot requests are answered here in milliseconds
// instead of a round trip to Massive. Today's bars are first filled from Massive's REST data, then kept current by the
// stream, and re-checked against REST every 5 minutes. If the stream is down, not in the plan, or in use elsewhere
// (Massive allows one stream connection per key), every request goes to Massive exactly as before.
const ST = { ws: null, state: 'off', authed: false, gen: 0, want: new Set(), sent: new Set(), bars: {}, last: {}, seeded: {}, seededAt: {}, seeding: {},
  msgs: 0, events: 0, lastMsgAt: 0, lastDataAt: 0, connectedAt: 0, lastErr: null, retryMs: 1000, timer: null, served: 0, passed: 0 };
const STREAM_MAX = 400;
const ETF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDate = ms => ETF.format(new Date(ms));
function csvSplit(ln) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < ln.length; i++) { const ch = ln[i];
    if (q) { if (ch === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out;
}
function csvParse(text) {
  let header = null; const rows = [];
  for (const raw of String(text || '').split('\n')) { const ln = raw.replace(/\r$/, ''); if (!ln.trim()) { if (header) break; continue; }
    const cells = csvSplit(ln); if (!header) { header = cells; continue; } if (cells.length !== header.length) break;
    const o = {}; header.forEach((h, i) => { o[h] = cells[i]; }); rows.push(o); }
  return { header: header || [], rows };
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const numCell = x => Number.isFinite(+x) ? String(+x) : '';

/* ------------------------------------------------------------------ Alpaca paper execution (broker.mjs) */
// Live option bid/ask comes from Massive (real-time OPRA), never from Alpaca's data feed.
async function optionQuote(sym, occ) {
  const r = await callMassive({ path: `/v3/snapshot/options/${sym}/${occ}` });
  const row = csvParse(r.payload.result).rows[0]; if (!row) return null;
  const n = k => (row[k] === undefined || row[k] === '' ? null : +row[k]);
  const ns = n('last_quote_last_updated');
  return { bid: n('last_quote_bid'), ask: n('last_quote_ask'), bidSize: n('last_quote_bid_size'), askSize: n('last_quote_ask_size'), at: ns ? Math.round(ns / 1e6) : null };
}
let BROKER = null;
function brokerStart() {
  BROKER = createBroker({ quote: optionQuote, store: { data: dbOf('broker'), save: () => dbSave('broker') }, log,
    haltFile: path.join(CFG.dataDir, 'HALT_TRADING'), fs });
  if (!BROKER.config.on) { log('broker: off (BROKER=off)'); return; }
  BROKER.connect().then(() => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    for (const [b, coll] of [['v2', 'paper'], ['v3', 'v3trades']]) for (const [id, d] of Object.entries(dbOf(b)[coll] || {})) if (d && d.date === today) BROKER.onDoc(b, coll, id, d).catch(() => {});
  });
  setInterval(() => BROKER.tick().catch(e => log('broker tick:', e.message)), 1000);
}

function streamStart() {
  if (!CFG.stream) { ST.state = 'off'; return; }
  if (!CFG.massiveKey) { ST.state = 'no key'; return; }
  if (typeof WebSocket !== 'function') { ST.state = 'unavailable'; ST.lastErr = 'this Node.js has no built-in WebSocket (needs Node 22+)'; log('stream:', ST.lastErr); return; }
  if (ST.ws) return;
  clearTimeout(ST.timer); ST.timer = null;
  let ws; try { ws = new WebSocket(CFG.streamUrl); } catch (e) { return streamRetry('connect failed: ' + e.message); }
  ST.ws = ws; ST.state = 'connecting'; ST.authed = false; ST.sent = new Set();
  ws.onopen = () => { try { ws.send(JSON.stringify({ action: 'auth', params: CFG.massiveKey })); } catch (e) { } };
  ws.onmessage = (m) => {
    if (ST.ws !== ws) return; ST.lastMsgAt = Date.now(); ST.msgs++;
    let evs; try { evs = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch (e) { return; }
    if (!Array.isArray(evs)) evs = [evs];
    for (const ev of evs) { try { streamEvent(ws, ev); } catch (e) { } }
  };
  ws.onerror = (e) => { ST.lastErr = 'socket error' + (e && e.message ? ': ' + e.message : ''); };
  ws.onclose = (e) => {
    if (ST.ws !== ws) return; const was = ST.authed; ST.ws = null; ST.authed = false; streamGap();
    streamRetry(`connection closed (${(e && e.code) || '?'}${e && e.reason ? ' ' + e.reason : ''})${was ? '' : ' before sign-in'}`);
  };
}
function streamRetry(why, waitMs) {
  ST.lastErr = why; if (ST.state !== 'blocked') ST.state = 'reconnecting';
  const ms = waitMs || ST.retryMs; ST.retryMs = Math.min(60000, ST.retryMs * 2);
  log('stream:', why, '- trying again in', Math.round(ms / 1000) + 's');
  clearTimeout(ST.timer); ST.timer = setTimeout(() => { ST.timer = null; if (ST.state === 'blocked') ST.state = 'reconnecting'; streamStart(); }, ms);
}
function streamDrop(ws) { if (ST.ws === ws) ST.ws = null; ST.authed = false; streamGap(); try { ws.close(); } catch (e) { } }
// anything missed while disconnected: every ticker is re-filled from REST before it is served from the stream again
function streamGap() { ST.gen++; ST.seeded = {}; }
function streamEvent(ws, ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.ev === 'status') {
    const st = String(ev.status || ''), msg = String(ev.message || '');
    if (st === 'auth_success') { ST.authed = true; ST.state = 'live'; ST.connectedAt = Date.now(); ST.lastDataAt = 0; ST.retryMs = 1000; ST.lastErr = null; log('stream: signed in'); streamSubscribe(); return; }
    if (st === 'auth_failed' || st === 'max_connections' || /not authorized|not entitled/i.test(msg)) {
      const why = st === 'max_connections' ? 'Massive allows one stream connection per key and another program is using it'
        : st === 'auth_failed' ? 'Massive did not accept the API key for streaming' : 'your Massive plan does not include this stream';
      ST.state = 'blocked'; streamDrop(ws);
      streamRetry(why + ' (' + msg.slice(0, 160) + '); using regular requests meanwhile', st === 'max_connections' ? 3 * 60000 : 10 * 60000);
    }
    return;  // connected, subscribed, etc.
  }
  if (ev.ev === 'A' || ev.ev === 'AM') { ST.events++; ST.lastDataAt = Date.now(); streamBar(ev); }
}
function streamSubscribe() {
  if (!ST.authed || !ST.ws) return;
  const add = [...ST.want].filter(s => !ST.sent.has(s)); if (!add.length) return;
  for (let i = 0; i < add.length; i += 100) {
    const part = add.slice(i, i + 100);
    try { ST.ws.send(JSON.stringify({ action: 'subscribe', params: part.map(s => `A.${s},AM.${s}`).join(',') })); for (const s of part) ST.sent.add(s); } catch (e) { }
  }
  log('stream: following', add.length, 'more tickers,', ST.sent.size, 'in all');
}
let subTimer = null;
function streamWant(syms) {
  let n = 0;
  for (const s of syms) { if (ST.want.has(s) || ST.want.size >= STREAM_MAX || !/^[A-Z][A-Z0-9.]{0,9}$/.test(s)) continue; ST.want.add(s); n++; }
  if (n && !subTimer) subTimer = setTimeout(() => { subTimer = null; streamSubscribe(); }, 50);
}
function symBars(sym, date) { let B = ST.bars[sym]; if (!B || B.date !== date) B = ST.bars[sym] = { date, m: new Map() }; return B; }
function streamBar(ev) {
  const sym = ev.sym; if (!sym || !(ev.s > 0) || !Number.isFinite(+ev.c)) return;
  const t = Math.floor(ev.s / 60000) * 60000, date = etDate(t), B = symBars(sym, date), cur = B.m.get(t), e = +ev.e || +ev.s;
  if (ev.ev === 'AM') B.m.set(t, { t, o: +ev.o, h: +ev.h, l: +ev.l, c: +ev.c, v: +ev.v, vw: +ev.vw, n: (cur && cur.n) || 0, e, fin: true });  // the finished minute
  else if (!cur) B.m.set(t, { t, o: +ev.o, h: +ev.h, l: +ev.l, c: +ev.c, v: +ev.v, vw: +ev.vw, n: 0, e, fin: false });
  else {
    if (+ev.h > cur.h) cur.h = +ev.h; if (+ev.l < cur.l) cur.l = +ev.l; if (e >= cur.e) { cur.c = +ev.c; cur.e = e; }
    if (!cur.fin) { const v = cur.v + (+ev.v || 0); if (v > 0 && Number.isFinite(+ev.vw)) cur.vw = (cur.vw * cur.v + ev.vw * ev.v) / v; cur.v = v; }
  }
  if (ev.ev === 'A') { const L = ST.last[sym]; const same = L && L.date === date;
    if (!L || e >= L.e) ST.last[sym] = { c: +ev.c, e, av: +ev.av || (same ? L.av : 0), date, h: same ? Math.max(L.h, +ev.h) : +ev.h, l: same ? Math.min(L.l, +ev.l) : +ev.l }; }
}
// Fill (or re-check) today's minute bars from REST. REST is complete for every minute before its newest bar; the newest
// minute is still forming, so it is merged with whatever the stream has seen since.
function streamSeed(sym, date, force) {
  if (!force && ST.seeded[sym] === date) return Promise.resolve(true);
  if (ST.seeding[sym]) return ST.seeding[sym];
  const gen = ST.gen;
  const p = (async () => {
    const t0 = Date.now();
    const r = await callMassive({ path: `/v2/aggs/ticker/${sym}/range/1/minute/${date}/${date}`, params: { adjusted: 'true', sort: 'asc', limit: 50000 } });
    const { header, rows } = csvParse(r.payload.result);
    if (!header.includes('t') || !header.includes('c')) throw new Error('unexpected bar data for ' + sym);
    if (!ST.authed || ST.gen !== gen) return false;  // the stream dropped meanwhile: serve from REST this time
    const B = symBars(sym, date); let lastT = 0;
    for (const x of rows) if (+x.t > lastT) lastT = +x.t;
    for (const x of rows) {
      const t = +x.t; if (!(t > 0)) continue;
      const bar = { t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v, vw: +x.vw, n: +x.n || 0, e: t0, fin: t < lastT };
      const cur = B.m.get(t);
      if (!cur || (t < lastT && !cur.fin)) { B.m.set(t, bar); continue; }
      if (cur.fin) continue;
      B.m.set(t, { ...bar, h: Math.max(bar.h, cur.h), l: Math.min(bar.l, cur.l), c: cur.e > t0 ? cur.c : bar.c, v: Math.max(bar.v, cur.v), e: Math.max(t0, cur.e), fin: false });
    }
    ST.seeded[sym] = date; ST.seededAt[sym] = Date.now(); return true;
  })().finally(() => { delete ST.seeding[sym]; });
  ST.seeding[sym] = p; return p;
}
function barsCsv(sym, date) {
  const B = ST.bars[sym]; const arr = B && B.date === date ? [...B.m.values()].sort((a, b) => a.t - b.t) : [];
  return 'v,vw,o,c,h,l,t,n\n' + arr.map(b => [b.v, b.vw, b.o, b.c, b.h, b.l, b.t, b.n].map(numCell).join(',')).join('\n') + (arr.length ? '\n' : '');
}
// Snapshot: Massive's REST snapshot (refreshed every 20 s, for previous-day and quote fields) with the stream's latest trade on top
const SNAP = { rows: new Map(), asked: new Set(), header: null, at: 0, loading: null };
async function snapBase(syms) {
  const missing = syms.some(s => !SNAP.asked.has(s));
  if ((missing || Date.now() - SNAP.at > 20000) && !SNAP.loading) {
    SNAP.loading = callMassive({ path: '/v2/snapshot/locale/us/markets/stocks/tickers', params: { tickers: syms.join(',') } }).then(r => {
      const { header, rows } = csvParse(r.payload.result); if (!header.includes('ticker')) throw new Error('unexpected snapshot data');
      SNAP.header = header; for (const x of rows) SNAP.rows.set(x.ticker, x); for (const s of syms) SNAP.asked.add(s); SNAP.at = Date.now();
    }).finally(() => { SNAP.loading = null; });
    SNAP.loading.catch(() => { });
  }
  if ((missing || !SNAP.header) && SNAP.loading) await SNAP.loading;  // first time: wait; afterwards refresh in the background
}
async function snapLive(q) {
  const syms = String(q.tickers || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!syms.length || syms.length > STREAM_MAX) return null;
  streamWant(syms); await snapBase(syms);
  const H = SNAP.header; if (!H || !ST.authed) return null;
  const today = etDate(Date.now()); const lines = [H.map(csvCell).join(',')];
  for (const s of syms) {
    const base = SNAP.rows.get(s); if (!base) continue; const x = { ...base }; const L = ST.last[s];
    if (L && L.date === today && L.e * 1e6 > (+x.lastTrade_t || 0)) {
      const ns = String(BigInt(Math.round(L.e)) * 1000000n);
      x.lastTrade_p = L.c; x.lastTrade_t = ns; x.updated = ns; x.day_c = L.c; x.min_c = L.c;
      x.day_h = +x.day_h > 0 ? Math.max(+x.day_h, L.h) : L.h; x.day_l = +x.day_l > 0 ? Math.min(+x.day_l, L.l) : L.l;
      if (L.av > (+x.day_v || 0)) x.day_v = L.av;
      const pc = +x.prevDay_c; if (pc > 0) { x.todaysChange = +(L.c - pc).toFixed(4); x.todaysChangePerc = (L.c / pc - 1) * 100; }
    }
    lines.push(H.map(k => csvCell(x[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
// Answer a board's request from the stream when it can be; null means "ask Massive as usual"
async function tryLive(input) {
  if (!ST.authed) return null;
  const p = String(input.path || ''), q = input.params || {}, today = etDate(Date.now());
  const bm = /^\/v2\/aggs\/ticker\/([A-Z][A-Z0-9.]{0,9})\/range\/1\/minute\/(\d{4}-\d\d-\d\d)\/(\d{4}-\d\d-\d\d)$/.exec(p);
  if (bm && bm[2] === today && bm[3] === today && String(q.adjusted ?? 'true') === 'true' && String(q.sort ?? 'asc') === 'asc' && !q.cursor && (q.limit == null || +q.limit >= 5000)) {
    const sym = bm[1]; streamWant([sym]);
    if (!ST.sent.has(sym)) await new Promise(r => setTimeout(r, 120));  // let the subscription go out before filling from REST
    if (!ST.sent.has(sym) || !(await streamSeed(sym, today))) return null;
    if (Date.now() - (ST.seededAt[sym] || 0) > 5 * 60000) streamSeed(sym, today, true).catch(() => { });
    return barsCsv(sym, today);
  }
  if (p === '/v2/snapshot/locale/us/markets/stocks/tickers' && q.tickers && Object.keys(q).length === 1) return snapLive(q);
  return null;
}
// Requests that go to Massive: identical requests within 2 seconds share one answer (several open pages ask the same thing)
const PASS = new Map();
function cachedMassive(input) {
  const k = JSON.stringify(input), n = Date.now(), c = PASS.get(k);
  if (c && (c.pending || n - c.at < 2000)) return c.p;
  const ent = { at: n, pending: true, p: callMassive(input) }; PASS.set(k, ent);
  ent.p.then(() => { ent.pending = false; ent.at = Date.now(); }, () => { if (PASS.get(k) === ent) PASS.delete(k); });
  if (PASS.size > 300) for (const [kk, v] of PASS) if (!v.pending && n - v.at > 2000) PASS.delete(kk);
  return ent.p;
}
// A connection can go quiet without closing: during market hours, reconnect if the data stops for 30 seconds
setInterval(() => {
  if (!CFG.stream) return;
  if (!ST.ws && !ST.timer && ST.state !== 'off' && ST.state !== 'unavailable' && ST.state !== 'no key') streamStart();
  const t = ctNow(); const session = t.wd !== 'Sat' && t.wd !== 'Sun' && t.min >= 8 * 60 + 30 && t.min < 15 * 60;
  if (ST.authed && session && ST.lastDataAt && Date.now() - ST.lastDataAt > 30000) { log('stream: no data for 30 s during market hours, reconnecting'); streamDrop(ST.ws); streamRetry('went quiet during market hours', 1000); }
}, 5000);

/* ------------------------------------------------------------------ http */
const SHIM = fs.readFileSync(path.join(ROOT, 'shim.js'), 'utf8');
function boardHtml(board, engine) {
  const raw = fs.readFileSync(path.join(ROOT, BOARDS[board].file), 'utf8');
  const inject = `<script>window.__CC=${JSON.stringify({ board, engine: !!engine, token: engine ? CFG.engineToken : null })};</script><script>${SHIM}</script>`;
  const i = raw.search(/<script[\s>]/i);
  const body = i >= 0 ? raw.slice(0, i) + inject + raw.slice(i) : inject + raw;
  return /^\s*<!doctype/i.test(body) ? body : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + body + '</body></html>';
}
// Behind the HTTPS proxy (tools/https.sh) every request arrives from 127.0.0.1, so a forwarded request is never local:
// it must sign in like any other visitor. Only the engine and on-machine tools connect directly.
function isLocal(req) { if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false; const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
// Basic auth for every page, data call and live-update stream (one sign-in covers /v2, /v3 and /api/*: same host, same realm).
// The user name ignores case and surrounding spaces; the password ignores surrounding spaces (copy-paste from a web console).
function authCheck(req) {
  if (isLocal(req)) return { ok: true };
  if (!CFG.pass) return { ok: false, why: 'no BOARD_PASSWORD set on the server' };
  const h = req.headers.authorization || ''; if (!h.startsWith('Basic ')) return { ok: false, why: 'no credentials sent' };
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':'); const p = rest.join(':');
  const eq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const a = eq(String(u).trim().toLowerCase(), String(CFG.user).trim().toLowerCase()), b = eq(p.trim(), String(CFG.pass).trim());
  return a && b ? { ok: true } : { ok: false, why: !a ? 'wrong user name' : 'wrong password' };
}
function authed(req) { return authCheck(req).ok; }
// One log line per visitor, URL and reason every 60 s: shows why a browser keeps asking. Never logs what was typed.
const AUTHLOG = new Map();
function logDenied(req, why) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const path = String(req.url || '').split('?')[0]; const k = ip + ' ' + path + ' ' + why; const now = Date.now();
  if (now - (AUTHLOG.get(k) || 0) < 60000) return; AUTHLOG.set(k, now); if (AUTHLOG.size > 2000) AUTHLOG.clear();
  log(`auth: 401 ${req.method} ${path} from ${ip}: ${why}`);
}
function isEngine(req) { return isLocal(req) && req.headers['x-engine'] === CFG.engineToken; }
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
function readBody(req) { return new Promise((ok, bad) => { let s = ''; req.on('data', d => { s += d; if (s.length > 5e6) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); }); }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/healthz') return send(res, 200, { ok: true });
    // Read-only export for Claude's analysis: paper trades, signals, scans, backtests and health. Needs EXPORT_KEY; cannot change anything.
    const xm = /^\/export\/(v2|v3|health|broker)$/.exec(u.pathname);
    if (xm) {
      const k = String(req.headers['x-export-key'] || u.searchParams.get('key') || '');
      const ok = CFG.exportKey.length >= 20 && k.length === CFG.exportKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(CFG.exportKey));
      if (!ok) return send(res, 403, { error: 'export key required' });
      if (xm[1] === 'health') { const h = health(); return send(res, 200, h); }
      if (xm[1] === 'broker') return send(res, 200, { status: BROKER ? BROKER.status() : null, ledger: dbOf('broker') });
      const since = u.searchParams.get('since') || '';
      const d = dbOf(xm[1]); const out = {};
      for (const [coll, docs] of Object.entries(d)) { out[coll] = {}; for (const [id, doc] of Object.entries(docs)) { if (!since || !/^\d{4}-\d\d-\d\d/.test(id) || id.slice(0, 10) >= since) out[coll][id] = doc; } }
      return send(res, 200, { board: xm[1], at: new Date().toISOString(), collections: out });
    }
    // One-time import of the claude.ai board's older v2 paper history (recorded there before this server took over on Nov 5).
    // Needs EXPORT_KEY. Insert-only: never overwrites or deletes a play, and only accepts plays dated on or before LEGACY_CUTOFF.
    if (u.pathname === '/import/v2/paper' && req.method === 'POST') {
      const k = String(req.headers['x-export-key'] || '');
      const ok = CFG.exportKey.length >= 20 && k.length === CFG.exportKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(CFG.exportKey));
      if (!ok) return send(res, 403, { error: 'export key required' });
      const LEGACY_CUTOFF = '2026-11-05';
      const b = await readBody(req); const docs = (b && b.docs) || {};
      const d = dbOf('v2'); const c = (d.paper = d.paper || {}); const added = [], skipped = [];
      for (const [id, doc] of Object.entries(docs)) {
        const date = doc && typeof doc === 'object' ? String(doc.date || '') : '';
        if (!/^\d{4}-\d\d-\d\d-[A-Z]{1,6}(-[a-z0-9]+)?$/.test(id) || id.slice(0, 10) !== date || date > LEGACY_CUTOFF || c[id]) { skipped.push(id); continue; }
        c[id] = { ...doc, legacy: true, recordedBy: 'claude.ai board (old rules)' }; added.push(id);
      }
      if (added.length) { dbSave('v2'); pushColl('v2', 'paper'); log(`import: ${added.length} older paper plays from the claude.ai board`); }
      return send(res, 200, { added, skipped });
    }
    const au = authCheck(req);
    if (!au.ok) { logDenied(req, au.why); res.writeHead(401, { 'www-authenticate': 'Basic realm="Conviction boards", charset="UTF-8"', 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('Sign in with your board user name and password.'); }
    const p = u.pathname;
    if (p === '/' ) return send(res, 200, indexPage(), 'text/html; charset=utf-8');
    const bm = /^\/(v2|v3)\/?$/.exec(p);
    if (bm) { const engine = isLocal(req) && u.searchParams.get('engine') === CFG.engineToken; return send(res, 200, boardHtml(bm[1], engine), 'text/html; charset=utf-8'); }
    if (p === '/api/health') return send(res, 200, health());
    if (p === '/api/mcp' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        let r;
        if (b.server === 'host:massive' && b.tool === 'call_api') {
          const inp = b.input || {}; let live = null;
          try { live = await tryLive(inp); } catch (e) { live = null; }
          if (live != null) { ST.served++; r = { payload: { result: live } }; } else { ST.passed++; r = await cachedMassive(inp); }
        }
        else if (b.server === 'host:evaluate' && b.tool === 'evaluate') r = await callJev(b.input || {});
        else throw { code: 'server_not_connected', message: `${b.server} is not available on the cloud server` };
        return send(res, 200, { result: r, live: ST.authed });
      } catch (e) { return send(res, 502, { error: { code: e.code || 'error', message: e.message || String(e), retryAfterMs: e.retryAfterMs } }); }
    }
    const dm = /^\/api\/db\/(v2|v3)\/([A-Za-z0-9_\-.]+)(?:\/([A-Za-z0-9_\-.~:@+]+))?$/.exec(p);
    if (dm) {
      const [, board, coll, id] = dm;
      if (req.method === 'GET' && !id) return send(res, 200, { docs: dbOf(board)[coll] || {} });
      if (req.method === 'POST' && id) {
        const b = await readBody(req);
        // Viewer pages never record trades: only the always-on engine copy writes them. Deletes (Settings reset) are allowed.
        if (BOARDS[board].engineOnly.includes(coll) && !isEngine(req) && b.op !== 'delete') return send(res, 200, { ok: true, ignored: true });
        try { dbWrite(board, coll, id, b.op, b.data); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e }); }
      }
    }
    const em = /^\/api\/events\/(v2|v3)$/.exec(p);
    if (em) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hi\n\n'); const set = (SUBS[em[1]] = SUBS[em[1]] || new Set()); set.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { } }, 25000);
      req.on('close', () => { clearInterval(ka); set.delete(res); }); return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { log('http error', e.message); try { send(res, 500, { error: e.message }); } catch (x) { } }
});

function ctNow() { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }); const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value])); return { wd: p.weekday, min: (+p.hour % 24) * 60 + (+p.minute) }; }
function quietHours() { const t = ctNow(); return t.wd === 'Sat' || t.wd === 'Sun' || t.min < 6 * 60 + 30 || t.min > 15 * 60 + 30; }
function health() {
  const v3 = dbOf('v3'), v2 = dbOf('v2');
  const open3 = Object.values(v3.v3trades || {}).filter(t => t.status === 'open').length;
  return {
    now: new Date().toISOString(), uptimeMin: Math.round(process.uptime() / 60),
    massive: { connected: !!M.client, lastOkAgoSec: M.okAt ? Math.round((Date.now() - M.okAt) / 1000) : null, calls: M.calls, fails: M.fails, lastErr: M.lastErr, keySet: !!CFG.massiveKey },
    jev: { on: !!(CFG.typesafeKey || CFG.anthropicKey), via: CFG.typesafeKey ? 'TypeSafe Jev' : CFG.anthropicKey ? 'Anthropic stand-in' : null, connected: !!JEV.client, calls: JEV.calls, lastErr: JEV.lastErr },
    stream: { state: ST.state, live: ST.authed, tickers: ST.sent.size, filled: Object.keys(ST.seeded).length, lastDataAgoSec: ST.lastDataAt ? Math.round((Date.now() - ST.lastDataAt) / 1000) : null,
      events: ST.events, answeredFromStream: ST.served, sentToMassive: ST.passed, lastErr: ST.lastErr },
    engine: ENG.status(),
    data: { v3Trades: Object.keys(v3.v3trades || {}).length, v3Open: open3, v2Paper: Object.keys(v2.paper || {}).length, earningsAsOf: ((v3.v3earn || {}).next || {}).asOf || null, crowdAsOf: ((v3.v3earn || {}).crowd || {}).asOf || null },
    broker: BROKER ? BROKER.status() : null,
    version: GIT.head, log: LOG.slice(-40),
  };
}
function indexPage() {
  const h = health(); const ago = s => s == null ? 'never' : s < 90 ? s + ' sec ago' : Math.round(s / 60) + ' min ago';
  const pg = Object.entries(h.engine.pages || {}).map(([b, x]) => `<li><b>${BOARDS[b].title}</b>: ${x.ok ? 'running' : 'restarting'} · page loaded ${ago(x.loadedAgoSec)} · last heartbeat ${ago(x.beatAgoSec)}${x.errors ? ' · ' + x.errors + ' page errors' : ''}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conviction Cloud</title>
<style>:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#141a22;--mut:#5a6878;--card:#fff;--line:#dde3ea;--go:#0a8f4a;--warn:#c43a3a}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--fg:#e2e8ef;--mut:#8b9aab;--card:#131a22;--line:#26313d;--go:#38d97f;--warn:#ff6b6b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}a.b{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0;color:inherit;text-decoration:none}
a.b b{font-size:18px}.ok{color:var(--go)}.bad{color:var(--warn)}ul{padding-left:18px}</style></head><body><main>
<h1>Conviction Cloud</h1><div class="mut">Paper trading only · runs around the clock on your server</div>
<a class="b" href="/v3"><b>Conviction Board v3 →</b><div class="mut">Five strategy tabs, $50,000 paper account each</div></a>
<a class="b" href="/v2"><b>Conviction Engine v2 →</b><div class="mut">Opening-range play cards</div></a>
<h2 style="font-size:16px">Status</h2><ul>
<li>Market data (Massive): <span class="${h.massive.lastOkAgoSec != null && h.massive.lastOkAgoSec < 120 ? 'ok' : 'bad'}">${h.massive.keySet ? 'last good reply ' + ago(h.massive.lastOkAgoSec) : 'API key missing'}</span>${h.massive.lastErr ? ' · last problem: ' + escapeHtml(String(h.massive.lastErr).slice(0, 140)) : ''}</li>
<li>Live stream: ${h.stream.live ? `<span class="ok">on</span> · ${h.stream.tickers} tickers · last update ${ago(h.stream.lastDataAgoSec)} · ${h.stream.answeredFromStream} requests answered from the stream, ${h.stream.sentToMassive} sent to Massive`
    : `<span class="bad">${escapeHtml(h.stream.state)}</span> · boards use regular Massive requests`}${h.stream.lastErr ? ' · ' + escapeHtml(String(h.stream.lastErr).slice(0, 180)) : ''}</li>
<li>Alpaca paper trading: ${!h.broker ? 'not started' : !h.broker.on ? 'off' : (h.broker.halted ? '<b>halted</b> (no new entries) · ' : '') + Object.values(h.broker.accounts).map(a => `<br>&nbsp;&nbsp;<b>${a.name}</b>: ${a.connected ? `<span class="ok">connected</span>${a.info && a.info.number ? ' (…' + a.info.number + ')' : ''} · today ${a.today.plays} plays, ${a.today.fills} fills, ${a.today.skipped} skipped · realized ${a.today.realized >= 0 ? '+' : '−'}$${Math.abs(a.today.realized)} · slippage vs live mid $${a.today.slipVsMidUsd}` : String(a.why || 'not connected').replace(/[<>&]/g, '')}`).join('')}</li>
${pg || '<li>Engine not started</li>'}
<li>Jev news score: ${h.jev.on ? 'on · ' + h.jev.via + (h.jev.lastErr ? ' · last error: ' + String(h.jev.lastErr).replace(/[<>&]/g, '').slice(0, 120) : '') : 'off (no TypeSafe API key)'}</li>
<li>v3 paper trades: ${h.data.v3Trades} (${h.data.v3Open} open) · v2 log entries: ${h.data.v2Paper}</li>
<li>Earnings dates as of ${h.data.earningsAsOf || '–'} · crowd lean as of ${h.data.crowdAsOf || '–'}</li>
<li>Software version ${h.version || '–'} · up ${h.uptimeMin} min</li></ul>
<p class="mut">The copies of the boards running on this server record the paper trades. The pages you open here show everything live and play the alerts, but never record trades themselves, so you can open them on any device.</p>
</main></body></html>`;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ------------------------------------------------------------------ engine: headless Chromium keeps each board open */
const ENG = {
  browser: null, pages: {}, starting: false,
  status() { const o = {}; for (const [b, x] of Object.entries(this.pages)) o[b] = { ok: !!x.page && !x.page.isClosed(), loadedAgoSec: x.loadedAt ? Math.round((Date.now() - x.loadedAt) / 1000) : null, beatAgoSec: x.beatAt ? Math.round((Date.now() - x.beatAt) / 1000) : null, errors: x.errors || 0, lastError: x.lastError || null }; return { on: CFG.engine, pages: o }; },
  async start() {
    if (!CFG.engine || this.starting) return; this.starting = true;
    try {
      const pw = await import(process.env.PW_MODULE || 'playwright');
      const chromium = pw.chromium || (pw.default && pw.default.chromium);
      this.browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
      this.browser.on('disconnected', () => { log('engine: browser exited, restarting in 10s'); this.browser = null; this.pages = {}; setTimeout(() => this.start(), 10000); });
      for (const b of Object.keys(BOARDS)) await this.open(b);
      log('engine: started');
    } catch (e) { log('engine start failed:', e.message); setTimeout(() => this.start(), 30000); }
    finally { this.starting = false; }
  },
  async open(b) {
    const old = this.pages[b]; if (old && old.page && !old.page.isClosed()) { try { await old.page.close(); } catch (e) { } }
    const st = (this.pages[b] = { errors: 0 });
    const ctx = await this.browser.newContext({ viewport: { width: 1300, height: 900 }, timezoneId: 'America/Chicago' });
    if (process.env.TEST_LIBS) { const libs = JSON.parse(process.env.TEST_LIBS); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => { const u = r.request().url(); for (const k in libs) if (u.endsWith(k)) return r.fulfill({ body: fs.readFileSync(libs[k]), contentType: 'application/javascript' }); return r.fulfill({ body: '' }); }); }
    const page = await ctx.newPage(); st.page = page;
    if (process.env.TEST_CLOCK) { // tests only: run the board on a fast synthetic clock that matches the fake data server
      const [start, speed] = process.env.TEST_CLOCK.split(',').map(Number); const t0 = Date.now() - (ENG.t0 ? Date.now() - ENG.t0 : 0); ENG.t0 = ENG.t0 || Date.now();
      await page.clock.install({ time: start + (Date.now() - ENG.t0) * speed });
      if (speed > 1) { const iv = setInterval(() => { if (page.isClosed()) return clearInterval(iv); page.clock.runFor(Math.round((speed - 1) * 1000)).catch(() => { }); }, 1000); }
    }
    page.on('pageerror', e => { st.errors++; st.lastError = String(e.message).slice(0, 200); if (st.errors <= 20 || st.errors % 100 === 0) log(`engine ${b} page error:`, st.lastError); });
    page.on('crash', () => { log(`engine ${b}: page crashed, reopening`); setTimeout(() => this.open(b).catch(e => log('reopen failed', e.message)), 5000); });
    await page.goto(`http://127.0.0.1:${CFG.port}/${b}?engine=${CFG.engineToken}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    st.loadedAt = Date.now(); st.beatAt = Date.now(); st.loadDay = new Date().toDateString();
  },
  async watchdog() {
    if (!this.browser) return;
    for (const b of Object.keys(BOARDS)) {
      const st = this.pages[b]; if (!st || !st.page || st.page.isClosed()) { await this.open(b).catch(e => log('reopen failed', e.message)); continue; }
      try { await Promise.race([st.page.evaluate(() => document.readyState), new Promise((_, r) => setTimeout(() => r(new Error('no reply')), 20000))]); st.beatAt = Date.now(); }
      catch (e) { log(`engine ${b}: page not responding (${e.message}), reopening`); await this.open(b).catch(x => log('reopen failed', x.message)); continue; }
      // fresh page once a day outside market hours (keeps memory steady)
      const t = ctNow(); if (st.loadDay !== new Date().toDateString() && t.min >= 4 * 60 && t.min < 5 * 60) { log(`engine ${b}: daily refresh`); await this.open(b).catch(x => log('reopen failed', x.message)); }
    }
  },
};
setInterval(() => ENG.watchdog().catch(e => log('watchdog', e.message)), 60000);

/* ------------------------------------------------------------------ updates from GitHub */
const GIT = { head: null };
function git(args) { return new Promise(ok => execFile('git', ['-C', ROOT, ...args], { timeout: 60000 }, (e, out, err) => ok({ e, out: String(out || '').trim(), err: String(err || '').trim() }))); }
async function gitSync() {
  if (!CFG.gitSync || !fs.existsSync(path.join(ROOT, '.git'))) return;
  const before = (await git(['rev-parse', '--short', 'HEAD'])).out; GIT.head = before;
  const pull = await git(['pull', '--ff-only', '-q']); if (pull.e) { log('update check failed:', pull.err.slice(0, 200)); return; }
  const after = (await git(['rev-parse', '--short', 'HEAD'])).out; GIT.head = after;
  loadFeeds();
  if (after !== before) {
    const changed = (await git(['diff', '--name-only', before, after])).out.split('\n');
    log('update pulled', before, '->', after, changed.join(','));
    const code = changed.filter(f => f && !f.startsWith('feeds/'));
    if (code.length) GIT.pending = true;
    if (changed.includes('package.json')) GIT.install = true;
  }
  if (GIT.pending && quietHours()) {
    log('applying update: restarting'); if (GIT.install) await new Promise(ok => execFile('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 300000 }, () => ok()));
    process.exit(0); // systemd starts the new version
  }
}

/* ------------------------------------------------------------------ start */
server.listen(CFG.port, CFG.host, async () => {
  log(`listening on ${CFG.host}:${CFG.port}`);
  if (!CFG.pass) log('WARNING: BOARD_PASSWORD not set: only this server itself can open the boards');
  if (!CFG.massiveKey) log('WARNING: MASSIVE_API_KEY not set: no market data');
  loadFeeds();
  await gitSync().catch(e => log('git', e.message));
  setInterval(() => gitSync().catch(e => log('git', e.message)), 15 * 60000);
  massiveClient().catch(e => log('massive start failed:', e.message));
  streamStart();
  brokerStart();
  ENG.start();
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const b of [...DIRTY]) { try { fs.writeFileSync(dbFile(b), JSON.stringify(DB[b])); } catch (e) { } } process.exit(0); });
