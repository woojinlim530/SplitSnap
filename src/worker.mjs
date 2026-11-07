import { DurableObject } from 'cloudflare:workers';
import { calculate } from './engine.mjs';
import { parseReceipt } from './gemini.mjs';
import { error, integer, text, clientSession, active, editItem, importReceipt, modifyClaim } from './core.mjs';
import { uid, makeToken, hashToken, authenticateHashed, touchExpiry, createSession } from './session.mjs';
import { receiptCompatibility } from './merchant.mjs';
import { normalize } from './gemini.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

function send(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

async function readJson(request, maxLength = 5_000_000) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxLength) error(413, 'Request is too large');
  const body = await request.text();
  if (new TextEncoder().encode(body).length > maxLength) error(413, 'Request is too large');
  try { return JSON.parse(body || '{}'); }
  catch { error(400, 'Invalid JSON'); }
}

function tokenFrom(request) {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function fail(e) {
  return send(e?.status || 500, { error: e?.status ? e.message : 'Internal server error' });
}

async function digestForRequest(request) {
  const token = tokenFrom(request);
  if (token.length < 32 || token.length > 200) error(401, 'Join this session or restore your access token');
  return hashToken(token);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = request.method;
      if (pathname === '/api/health' && method === 'GET') {
        return send(200, { ok: true, geminiConfigured: Boolean(env.GEMINI_API_KEY), time: new Date().toISOString(), platform: 'cloudflare-workers' });
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        const createAllowed = await env.CREATE_RATE?.limit({ key: request.headers.get('cf-connecting-ip') || 'local' });
        if (createAllowed?.success === false) error(429, 'Too many new sessions. Try again later');
        const body = await readJson(request, 10_000);
        const id = uid();
        const stub = env.SESSIONS.getByName(id);
        return stub.fetch(new Request('https://internal/__init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: text(body.title || 'Dinner Split', 80), hostName: text(body.hostName || 'Host', 40), demo: Boolean(body.demo) }) }));
      }
      const match = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/i);
      if (match && uuidPattern.test(match[1])) {
        const stub = env.SESSIONS.getByName(match[1].toLowerCase());
        if (match[2] === 'parse' && method === 'POST') {
          const verified = await stub.fetch(new Request('https://internal/__host', { method: 'GET', headers: { authorization: request.headers.get('authorization') || '' } }));
          if (!verified.ok) return verified;
          const sessionLimit = await env.RECEIPT_RATE?.limit({ key: match[1] });
          if (sessionLimit?.success === false) error(429, 'Too many receipt scans for this session');
          const globalLimit = await env.AI_GLOBAL_RATE?.limit({ key: 'all' });
          if (globalLimit?.success === false) error(429, 'AI scanning is temporarily busy. Try manual entry');
          const body = await readJson(request, 14_000_000);
          const receipt = await parseReceipt(body, env);
          const bytes = new TextEncoder().encode(body.data || '');
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const fingerprint = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
          return send(200, { receipt, fingerprint });
        }
        return stub.fetch(request);
      }
      if (pathname.startsWith('/api/')) return send(404, { error: 'Unknown endpoint' });
      return env.ASSETS.fetch(request);
    } catch (e) {
      return fail(e);
    }
  }
};

export class SplitSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS session_data (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }

  read() {
    const row = this.ctx.storage.sql.exec("SELECT payload FROM session_data WHERE id = 'session'").toArray()[0];
    if (!row) return null;
    const session = JSON.parse(row.payload);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.clear();
      return null;
    }
    return session;
  }

  write(session) {
    touchExpiry(session);
    session.revision += 1;
    this.ctx.storage.sql.exec('INSERT INTO session_data (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', 'session', JSON.stringify(session));
    this.ctx.storage.setAlarm(Date.parse(session.expiresAt));
    this.broadcast();
  }

  clear() {
    this.ctx.storage.sql.exec("DELETE FROM session_data WHERE id = 'session'");
    this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'Session ended'); } catch {}
    }
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      if (!ws.deserializeAttachment()?.participantId) continue;
      try { ws.send(JSON.stringify({ type: 'update' })); } catch {}
    }
  }

  async alarm() {
    const session = this.read();
    if (session) this.ctx.storage.setAlarm(Date.parse(session.expiresAt));
  }

  async fetch(request) {
    try {
      const pathname = new URL(request.url).pathname;
      const method = request.method;
      if (pathname === '/__init' && method === 'POST') {
        if (this.read()) error(409, 'Session already exists');
        const body = await readJson(request, 10_000);
        if (!uuidPattern.test(body.id)) error(400, 'Invalid session ID');
        const created = await createSession({ providedId: body.id, title: body.title, hostName: body.hostName, demo: body.demo });
        this.write(created.session);
        return send(201, { session: clientSession(created.session, created.session.participants.find(p => p.id === created.session.hostId)), token: created.token, participantId: created.session.hostId });
      }
      if (pathname.endsWith('/stream') && method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const session = this.read();
        if (!session) error(404, 'Session not found or has expired');
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (pathname === '/__host' && method === 'GET') {
        const digest = await digestForRequest(request);
        const session = this.read();
        if (!session) error(404, 'Session not found or has expired');
        const actor = authenticateHashed(session, digest);
        if (!actor) error(401, 'Invalid session access token');
        if (actor.role !== 'host') error(403, 'Only the Host can perform this action');
        if (session.status !== 'active') error(409, 'The bill is finalized. Host must reopen it before editing');
        return send(200, { ok: true });
      }
      const action = pathname.match(/^\/api\/sessions\/[0-9a-f-]{36}(?:\/(.*))?$/i)?.[1] || '';
      if (action === 'public' && method === 'GET') {
        const s = this.read();
        if (!s) error(404, 'Session not found or has expired');
        return send(200, { id: s.id, title: s.title, status: s.status, count: s.participants.length, expiresAt: s.expiresAt });
      }
      if (action === 'join' && method === 'POST') {
        const body = await readJson(request, 10_000);
        const name = text(body.name, 40);
        const token = makeToken();
        const digest = await hashToken(token);
        const s = this.read();
        if (!s) error(404, 'Session not found or has expired');
        if (s.status === 'finalized') error(409, 'This session is already finalized');
        if (s.participants.length >= 30) error(409, 'Session is full');
        const person = { id: uid(), name, role: 'participant', tokenHash: digest, createdAt: new Date().toISOString() };
        s.participants.push(person);
        this.write(s);
        return send(201, { token, participantId: person.id, session: clientSession(s, person) });
      }
      const digest = await digestForRequest(request);
      let body;
      if (['POST', 'PUT', 'PATCH'].includes(method)) body = await readJson(request);
      const s = this.read();
      if (!s) error(404, 'Session not found or has expired');
      const actor = authenticateHashed(s, digest);
      if (!actor) error(401, 'Join this session or restore your access token');
      const requireHost = () => { if (actor.role !== 'host') error(403, 'Only the Host can perform this action'); };
      const commit = () => { this.write(s); return send(200, { ok: true }); };
      if (!action && method === 'GET') return send(200, { session: clientSession(s, actor), actorId: actor.id, role: actor.role });
      if (action === 'items' && method === 'POST') {
        requireHost();
        active(s);
        const item = { id: uid(), name: '', nameOriginal: '', quantity: 1, amountCents: 0, discountCents: 0, taxCategory: 'food', groups: [] };
        editItem(item, body);
        if (!item.name) error(400, 'Missing item name');
        item.nameOriginal = item.name;
        s.items.push(item);
        this.write(s);
        return send(201, { item });
      }
      if (action.startsWith('items/') && ['PATCH', 'DELETE'].includes(method)) {
        requireHost();
        active(s);
        const id = action.split('/')[1];
        const item = s.items.find(x => x.id === id);
        if (!item) error(404, 'Item not found');
        if (method === 'PATCH') editItem(item, body);
        else s.items = s.items.filter(x => x.id !== id);
        return commit();
      }
      if (action === 'claims' && method === 'POST') {
        active(s);
        modifyClaim(s, actor, body);
        return commit();
      }
      if (action === 'charges' && method === 'PUT') {
        requireHost();
        active(s);
        if (!Array.isArray(body.taxes) || body.taxes.length > 20) error(400, 'Invalid taxes');
        s.taxes = body.taxes.map(x => {
          if (!['all', 'food', 'alcohol', 'beverage', 'other', 'unknown'].includes(x.category)) error(400, 'Invalid tax category');
          return { id: typeof x.id === 'string' ? x.id : uid(), label: text(x.label, 100), amountCents: integer(x.amountCents), category: x.category };
        });
        s.orderDiscountCents = integer(body.orderDiscountCents);
        s.tipCents = integer(body.tipCents);
        s.tipVerified = Boolean(body.tipVerified);
        s.verifiedTotalCents = body.verifiedTotalCents == null ? null : integer(body.verifiedTotalCents);
        return commit();
      }
      if (action === 'receipts/check' && method === 'POST') {
        requireHost();
        active(s);
        return send(200, { compatibility: receiptCompatibility(s, normalize(body.receipt || {})) });
      }
      if (action === 'receipts' && method === 'POST') {
        requireHost();
        active(s);
        const warning = importReceipt(s, body.receipt, typeof body.fingerprint === 'string' ? body.fingerprint : null, body.merchantConfirmed === true);
        this.write(s);
        return send(201, { ok: true, warning });
      }
      if (action === 'finalize' && method === 'POST') {
        requireHost();
        active(s);
        const summary = calculate(s);
        if (!summary.canFinalize) error(409, summary.errors.join(' | '));
        s.settlements = summary.people.map(p => ({ participantId: p.id, amountCents: p.totalCents, foodCents: p.foodCents, taxCents: p.taxCents, tipCents: p.tipCents }));
        s.status = 'finalized';
        return commit();
      }
      if (action === 'reopen' && method === 'POST') {
        requireHost();
        if (s.status !== 'finalized') error(409, 'The session is not finalized');
        if (s.payments.length) error(409, 'Undo recorded payments before reopening the bill');
        s.status = 'active';
        s.settlements = [];
        return commit();
      }
      if (action === 'payments' && method === 'POST') {
        requireHost();
        if (s.status !== 'finalized') error(409, 'Finalize the bill before recording payments');
        const settlement = s.settlements.find(x => x.participantId === body.participantId);
        if (!settlement || settlement.participantId === s.hostId) error(400, 'Invalid payer');
        const amountCents = integer(body.amountCents, 1);
        const paid = s.payments.filter(x => x.participantId === body.participantId).reduce((sum, x) => sum + x.amountCents, 0);
        if (amountCents > settlement.amountCents - paid) error(409, 'Payment exceeds outstanding balance');
        const event = { id: uid(), participantId: settlement.participantId, amountCents, createdAt: new Date().toISOString() };
        s.payments.push(event);
        this.write(s);
        return send(201, { event });
      }
      if (action.startsWith('payments/') && method === 'DELETE') {
        requireHost();
        if (!s.payments.some(x => x.id === action.split('/')[1])) error(404, 'Payment not found');
        s.payments = s.payments.filter(x => x.id !== action.split('/')[1]);
        return commit();
      }
      if (!action && method === 'DELETE') {
        requireHost();
        this.clear();
        return send(200, { ok: true });
      }
      error(404, 'Unknown endpoint');
    } catch (e) {
      return fail(e);
    }
  }

  async webSocketMessage(socket, raw) {
    try {
      if (typeof raw !== 'string' || raw.length > 500) { socket.close(1008, 'Invalid message'); return; }
      const message = JSON.parse(raw);
      if (message.type === 'ping' && socket.deserializeAttachment()?.participantId) {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (message.type !== 'auth' || socket.deserializeAttachment()?.participantId || typeof message.token !== 'string' || message.token.length < 32 || message.token.length > 200) {
        socket.close(1008, 'Invalid authorization');
        return;
      }
      const digest = await hashToken(message.token);
      const s = this.read();
      const person = authenticateHashed(s, digest);
      if (!person) { socket.close(1008, 'Invalid session token'); return; }
      socket.serializeAttachment({ participantId: person.id });
      socket.send(JSON.stringify({ type: 'ready', revision: s.revision }));
    } catch {
      try { socket.close(1008, 'Invalid message'); } catch {}
    }
  }

  webSocketClose() {}

  webSocketError() {}
}
