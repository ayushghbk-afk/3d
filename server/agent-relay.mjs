// Web 3D Studio — Agent Relay (zero dependencies, Node 20+).
//
// Gives external AI agents a real HTTP API for the in-browser Agent API:
// the browser long-polls this server for queued calls, executes them against
// the open (or headless) project, and posts results back.
//
//   npm run agent-relay                       # http://127.0.0.1:8787
//   npm run agent-relay -- --port 8787 --token my-secret
//   AGENT_RELAY_TOKEN=my-secret node server/agent-relay.mjs
//
// Then in the app: open a project → ✨ AI → Agent API → enable, paste the
// relay URL + token → Connect. External agents call:
//
//   curl http://127.0.0.1:8787/v1/call -H 'Authorization: Bearer TOKEN' \
//     -H 'Content-Type: application/json' -d '{"method":"project.list"}'
//
// SECURITY: binds to localhost by default. Only bind 0.0.0.0 / expose it
// publicly if you understand the token is the only protection.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const VERSION = '1.0.0';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_QUEUE = 100;
const QUEUE_HOLD_MS = 28000;
const MIN_CALL_TIMEOUT = 5000;
const MAX_CALL_TIMEOUT = 300000;

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return fallback;
  const a = args[i];
  if (a.includes('=')) return a.slice(name.length + 1);
  return args[i + 1] ?? fallback;
}

const PORT = Number(argValue('--port', process.env.AGENT_RELAY_PORT || '8787')) || 8787;
const HOST = argValue('--host', process.env.AGENT_RELAY_HOST || '127.0.0.1');
const CORS = argValue('--cors', process.env.AGENT_RELAY_CORS || '*');
let TOKEN = argValue('--token', process.env.AGENT_RELAY_TOKEN || '');
let generatedToken = false;
if (!TOKEN) {
  TOKEN = randomBytes(24).toString('hex');
  generatedToken = true;
}

const startedAt = Date.now();
let callSeq = 0;
/** callId -> { method, params, res, timer, createdAt } (waiting external agent) */
const waiting = new Map();
/** queued calls not yet picked up by the browser */
const queue = [];
/** clients waiting on long-poll */
const pollers = new Set();
let lastBrowserSeen = 0;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CORS,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body exceeds 8MB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7) === TOKEN;
  const q = url.searchParams.get('token');
  return !!q && q === TOKEN;
}

function drainPollers() {
  if (!queue.length || !pollers.size) return;
  // Hand every queued call to the oldest poller (single browser expected,
  // but multiple browsers just share the work).
  const batch = queue.splice(0, queue.length);
  const first = pollers.values().next().value;
  pollers.delete(first);
  clearTimeout(first.timer);
  send(first.res, 200, { calls: batch.map(({ callId, method, params }) => ({ callId, method, params })) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      if (!authorized(req, url)) {
        send(res, 401, { ok: false, error: { code: 'AUTH_INVALID', message: 'Invalid relay token.' } });
        return;
      }
      send(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        browserConnected: Date.now() - lastBrowserSeen < 45000,
        pendingCalls: queue.length + waiting.size,
      });
      return;
    }

    if (url.pathname === '/v1/call' && req.method === 'POST') {
      if (!authorized(req, url)) {
        send(res, 401, { ok: false, error: { code: 'AUTH_INVALID', message: 'Invalid relay token.' } });
        return;
      }
      const body = await readBody(req);
      const method = body?.method;
      if (typeof method !== 'string' || !method) {
        send(res, 400, { ok: false, error: { code: 'VALIDATION', message: 'Body needs {method, params?}.' } });
        return;
      }
      if (queue.length + waiting.size >= MAX_QUEUE) {
        send(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Relay queue is full, retry shortly.' } });
        return;
      }
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const timeoutMs = Math.max(
        MIN_CALL_TIMEOUT,
        Math.min(MAX_CALL_TIMEOUT, Number(body.timeoutMs) || 60000),
      );
      const callId = `call-${Date.now().toString(36)}-${++callSeq}`;
      const entry = { callId, method, params, res, createdAt: Date.now(), done: false };
      entry.timer = setTimeout(() => {
        if (entry.done) return;
        entry.done = true;
        waiting.delete(callId);
        const qi = queue.findIndex((q) => q.callId === callId);
        if (qi !== -1) queue.splice(qi, 1);
        send(res, 200, {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: 'No result from the browser in time. Is the app open with the relay connected?',
          },
        });
      }, timeoutMs);
      // Node holds `res` open (long-poll); never time out the socket first.
      req.setTimeout(0);
      res.setTimeout(0);
      waiting.set(callId, entry);
      queue.push({ callId, method, params });
      drainPollers();
      return; // response sent later by /v1/result or the timeout above
    }

    if (url.pathname === '/v1/queue' && req.method === 'GET') {
      if (!authorized(req, url)) {
        send(res, 401, { ok: false, error: { code: 'AUTH_INVALID', message: 'Invalid relay token.' } });
        return;
      }
      lastBrowserSeen = Date.now();
      if (queue.length) {
        const batch = queue.splice(0, queue.length);
        send(res, 200, { calls: batch.map(({ callId, method, params }) => ({ callId, method, params })) });
        return;
      }
      // Long-poll: hold until a call arrives or the hold window expires.
      const poller = { res };
      pollers.add(poller);
      poller.timer = setTimeout(() => {
        pollers.delete(poller);
        send(res, 200, { calls: [] });
      }, QUEUE_HOLD_MS);
      req.on('close', () => {
        if (pollers.has(poller)) {
          pollers.delete(poller);
          clearTimeout(poller.timer);
        }
      });
      return;
    }

    if (url.pathname === '/v1/result' && req.method === 'POST') {
      if (!authorized(req, url)) {
        send(res, 401, { ok: false, error: { code: 'AUTH_INVALID', message: 'Invalid relay token.' } });
        return;
      }
      lastBrowserSeen = Date.now();
      const body = await readBody(req);
      const entry = waiting.get(body?.callId);
      if (!entry || entry.done) {
        send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown or expired callId.' } });
        return;
      }
      entry.done = true;
      clearTimeout(entry.timer);
      waiting.delete(body.callId);
      const ok = body.ok === true;
      send(entry.res, 200, ok ? { ok: true, result: body.result ?? null } : { ok: false, error: body.error ?? { code: 'INTERNAL', message: 'Agent call failed.' } });
      send(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': CORS });
      res.end(`Web 3D Studio Agent Relay v${VERSION}\nGET  /v1/health\nPOST /v1/call   {method, params?, timeoutMs?}\n`);
      return;
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `Unknown route ${url.pathname}.` } });
  } catch (e) {
    try {
      send(res, 400, { ok: false, error: { code: 'VALIDATION', message: e.message || 'Bad request.' } });
    } catch {
      /* socket already gone */
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Web 3D Studio Agent Relay v${VERSION}`);
  console.log(`  Listening on http://${HOST}:${PORT}`);
  console.log(`  Token: ${TOKEN}${generatedToken ? '  (generated — set AGENT_RELAY_TOKEN to pin it)' : ''}`);
  console.log(`\n  In the app: open a project → ✨ AI → Agent API → enable, then`);
  console.log(`  Relay URL: http://${HOST}:${PORT}   + paste the token above → Connect.\n`);
});
