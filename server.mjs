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
  jevModel: process.env.JEV_MODEL || 'claude-haiku-5-5',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  engine: process.env.ENGINE !== 'off',
  engineToken: process.env.ENGINE_TOKEN || crypto.randomBytes(18).toString('hex'),
  gitSync: process.env.GIT_SYNC !== 'off',
};
const BOARDS = {
  v3: { file: 'boards/v3.html', title: 'Conviction Board v3', engineOnly: ['v3trades', 'v3signals'] },
  v2: { file: 'boards/v2.html', title: 'Conviction Engine v2', engineOnly: ['paper', 'real'] },
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
  M.connecting = (async () => {
    const env = { ...process.env, MASSIVE_API_KEY: CFG.massiveKey, HOME: process.env.HOME || '/root' };
    const transport = new StdioClientTransport({ command: CFG.massiveCmd, args: CFG.massiveArgs, env, stderr: 'pipe' });
    const c = new Client({ name: 'conviction-cloud', version: '1.0.0' });
    transport.onclose = () => { if (M.client === c) { M.client = null; log('massive: connection closed, will reconnect on next call'); } };
    await c.connect(transport);
    try { transport.stderr && transport.stderr.on('data', d => { const s = String(d).trim(); if (s) log('massive:', s.slice(0, 300)); }); } catch (e) { }
    M.client = c; log('massive: connected');
    return c;
  })();
  try { return await M.connecting; } finally { M.connecting = null; }
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

/* ------------------------------------------------------------------ Jev (optional: news read by Claude through the API) */
const JEV = { calls: 0, lastErr: null };
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
  if (!CFG.anthropicKey) throw { code: 'server_not_connected', message: 'Jev news score is off on the server (no Anthropic API key set).' };
  JEV.calls++;
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
  for (const b of Object.keys(BOARDS)) { const f = path.join(dir, `db-${b}-${d}.json`); if (!fs.existsSync(f) && DB[b]) fs.writeFileSync(f, JSON.stringify(DB[b])); }
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

/* ------------------------------------------------------------------ http */
const SHIM = fs.readFileSync(path.join(ROOT, 'shim.js'), 'utf8');
function boardHtml(board, engine) {
  const raw = fs.readFileSync(path.join(ROOT, BOARDS[board].file), 'utf8');
  const inject = `<script>window.__CC=${JSON.stringify({ board, engine: !!engine, token: engine ? CFG.engineToken : null })};</script><script>${SHIM}</script>`;
  const i = raw.search(/<script[\s>]/i);
  const body = i >= 0 ? raw.slice(0, i) + inject + raw.slice(i) : inject + raw;
  return /^\s*<!doctype/i.test(body) ? body : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + body + '</body></html>';
}
function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function authed(req) {
  if (isLocal(req)) return true;
  if (!CFG.pass) return false;
  const h = req.headers.authorization || ''; if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':'); const p = rest.join(':');
  const eq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const a = eq(u, CFG.user), b = eq(p, CFG.pass); return a && b;
}
function isEngine(req) { return isLocal(req) && req.headers['x-engine'] === CFG.engineToken; }
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
function readBody(req) { return new Promise((ok, bad) => { let s = ''; req.on('data', d => { s += d; if (s.length > 5e6) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); }); }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/healthz') return send(res, 200, { ok: true });
    if (!authed(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Conviction boards"', 'content-type': 'text/plain' }); return res.end('Sign in with your board user name and password.'); }
    const p = u.pathname;
    if (p === '/' ) return send(res, 200, indexPage(), 'text/html; charset=utf-8');
    const bm = /^\/(v2|v3)\/?$/.exec(p);
    if (bm) { const engine = isLocal(req) && u.searchParams.get('engine') === CFG.engineToken; return send(res, 200, boardHtml(bm[1], engine), 'text/html; charset=utf-8'); }
    if (p === '/api/health') return send(res, 200, health());
    if (p === '/api/mcp' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        let r;
        if (b.server === 'host:massive' && b.tool === 'call_api') r = await callMassive(b.input || {});
        else if (b.server === 'host:evaluate' && b.tool === 'evaluate') r = await callJev(b.input || {});
        else throw { code: 'server_not_connected', message: `${b.server} is not available on the cloud server` };
        return send(res, 200, { result: r });
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
    jev: { on: !!CFG.anthropicKey, calls: JEV.calls, lastErr: JEV.lastErr },
    engine: ENG.status(),
    data: { v3Trades: Object.keys(v3.v3trades || {}).length, v3Open: open3, v2Paper: Object.keys(v2.paper || {}).length, earningsAsOf: ((v3.v3earn || {}).next || {}).asOf || null, crowdAsOf: ((v3.v3earn || {}).crowd || {}).asOf || null },
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
${pg || '<li>Engine not started</li>'}
<li>Jev news score: ${h.jev.on ? 'on' : 'off (no Anthropic API key)'}</li>
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
  ENG.start();
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const b of [...DIRTY]) { try { fs.writeFileSync(dbFile(b), JSON.stringify(DB[b])); } catch (e) { } } process.exit(0); });
