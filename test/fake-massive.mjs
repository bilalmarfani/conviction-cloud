// Test stand-in for the Massive MCP server: same tool (call_api), synthetic market from the board's test mock.
import fs from 'node:fs'; import vm from 'node:vm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const [start, speed] = (process.env.TEST_CLOCK || '').split(',').map(Number); const t0 = Date.now();
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a){ if(a.length===0) super(FakeDate.now()); else super(...a); } static now(){ return start ? start + (RealDate.now() - t0) * (speed || 1) : RealDate.now(); } }
const win = {};
const ctx = vm.createContext({ window: win, Date: start ? FakeDate : Date, Math, JSON, console, queueMicrotask, setTimeout, Promise, Intl, Infinity, Number, String, Object, Array, Set, Map, parseInt, parseFloat, isFinite });
vm.runInContext(fs.readFileSync(process.env.MOCK_JS, 'utf8'), ctx);
const mock = await win.claude.use('mcp');
let rl = +(process.env.FAKE_RL || 0); const W = [];
const server = new McpServer({ name: 'fake-massive', version: '0.0.1' });
server.tool('call_api', { path: z.string(), params: z.record(z.any()).optional() }, async ({ path, params }) => {
  if (process.env.FAKE_KEYCHECK && process.env.MASSIVE_API_KEY !== 'good-key') return { content: [{ type: 'text', text: 'Error [AUTH]: HTTP 401 — {"status":"ERROR","error":"Unknown API Key"}' }] };
  if (rl) { const n = RealDate.now(); while (W.length && n - W[0] > 60000) W.shift(); if (W.length >= rl) return { content: [{ type: 'text', text: 'Error [RATE_LIMIT]: HTTP 429 — too many' }] }; W.push(n); }
  try { const r = await mock.callTool('host:massive', 'call_api', params ? { path, params } : { path }); return { content: [{ type: 'text', text: r.payload.result }] }; }
  catch (e) { return { content: [{ type: 'text', text: 'Error [NOT_FOUND]: ' + (e.message || e.code) }] }; }
});
await server.connect(new StdioServerTransport());
