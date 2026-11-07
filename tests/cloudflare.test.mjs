import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const original = path.resolve('src/worker.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'splitsnap-workers-test-'));
fs.cpSync(path.resolve('src'), path.join(temp, 'src'), { recursive: true });
const file = path.join(temp, 'src', 'worker.mjs');
fs.writeFileSync(file, fs.readFileSync(original, 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'));
const { default: worker, SplitSession } = await import(pathToFileURL(file).href);
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

function fakeContext() {
  let payload = null;
  const sockets = new Set();
  let alarm = null;
  return {
    storage: {
      sql: {
        exec(sql, ...values) {
          const statement = sql.trim().toUpperCase();
          if (statement.startsWith('SELECT')) return { toArray: () => payload ? [{ payload }] : [] };
          if (statement.startsWith('INSERT')) { payload = values[0] === 'session' ? values[1] : values[0]; return { toArray: () => [] }; }
          if (statement.startsWith('DELETE')) { payload = null; return { toArray: () => [] }; }
          return { toArray: () => [] };
        }
      },
      setAlarm(value) { alarm = value; },
      deleteAlarm() { alarm = null; },
      get alarm() { return alarm; }
    },
    getWebSockets() { return [...sockets]; },
    acceptWebSocket(socket) { sockets.add(socket); }
  };
}

function fakeEnv() {
  const instances = new Map();
  const env = {
    GEMINI_API_KEY: '',
    GEMINI_MODEL: 'gemini-3.8-flash',
    ASSETS: { fetch: async () => new Response('static works') },
    SESSIONS: {
      getByName(id) {
        if (!instances.has(id)) {
          const object = new SplitSession(fakeContext(), env);
          instances.set(id, { instance: object });
        }
        return { fetch: request => instances.get(id).instance.fetch(request) };
      }
    },
    instances
  };
  return env;
}

async function req(env, method, route, data, token = '') {
  const request = new Request(`https://splitsnap.example${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, data: await response.json() };
}

class Socket {
  constructor() { this.messages = []; this.attachment = null; this.closed = false; }
  send(msg) { this.messages.push(JSON.parse(msg)); }
  close() { this.closed = true; }
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value) { this.attachment = value; }
}

test('Workers session persistence and collaboration through DO SQLite interface', async () => {
  const env = fakeEnv();
  assert.equal((await req(env, 'GET', '/api/health')).data.platform, 'cloudflare-workers');
  const start = await req(env, 'POST', '/api/sessions', { title:'Dinner',hostName:'Alex',demo:true });
  assert.equal(start.status,201);
  const { token:hostToken,participantId:hostId } = start.data;
  const id = start.data.session.id;
  assert.equal(start.data.session.summary.totalCents,8436);
  const person1 = await req(env,'POST',`/api/sessions/${id}/join`,{name:'Jamie'});
  const person2 = await req(env,'POST',`/api/sessions/${id}/join`,{name:'Chris'});
  assert.equal(person1.status,201);
  assert.equal(person2.status,201);
  const jamieId = person1.data.participantId;
  const chrisId = person2.data.participantId;
  assert.equal((await req(env,'GET',`/api/sessions/${id}/public`)).data.count,3);
  const denied = await req(env,'POST',`/api/sessions/${id}/items`,{name:'Hacked',quantity:1,amountCents:200},person1.data.token);
  assert.equal(denied.status,403);
  const unauthorizedParse = await req(env,'POST',`/api/sessions/${id}/parse`,{data:'abc',mimeType:'image/jpeg'},person1.data.token);
  assert.equal(unauthorizedParse.status,403);
  const withoutKey = await req(env,'POST',`/api/sessions/${id}/parse`,{data:'abc',mimeType:'image/jpeg'},hostToken);
  assert.equal(withoutKey.status,503);
  const object = env.instances.get(id).instance;
  const socket = new Socket();
  object.ctx.acceptWebSocket(socket);
  await object.webSocketMessage(socket, JSON.stringify({type:'auth',token:person1.data.token}));
  assert.equal(socket.messages[0].type,'ready');
  const unknownSocket = new Socket();
  object.ctx.acceptWebSocket(unknownSocket);
  await object.webSocketMessage(unknownSocket, JSON.stringify({type:'auth',token:'Z'.repeat(43)}));
  assert.equal(unknownSocket.closed,true);
  const menu = start.data.session.items;
  const idOf = name => menu.find(i=>i.name===name).id;
  const claim = (token, name, op, targetId) => req(env,'POST',`/api/sessions/${id}/claims`,{itemId:idOf(name),op,targetId},token);
  const testClaims = [
    [hostToken,'HH Manna Burger','plus',hostId],
    [person1.data.token,'HH Manna Burger','plus',jamieId],
    [person1.data.token,'12oz Superflux','toggle',jamieId],
    [person2.data.token,'BC Beer','toggle',chrisId],
    [hostToken,'HH Onion Rings','toggle',hostId],
    [person1.data.token,'HH Onion Rings','toggle',jamieId],
    [person2.data.token,'HH Onion Rings','toggle',chrisId],
    [person2.data.token,'Modelo HH','toggle',chrisId],
    [hostToken,'HH Pretzel Bites','toggle',hostId],
    [person1.data.token,'12oz Dino Sour','plus',jamieId],
    [person2.data.token,'12oz Dino Sour','plus',chrisId]
  ];
  for (const args of testClaims) assert.equal((await claim(...args)).status,200);
  assert.ok(socket.messages.some(x=>x.type==='update'));
  const live = await req(env,'GET',`/api/sessions/${id}`,undefined,hostToken);
  assert.equal(live.data.session.summary.canFinalize,true,live.data.session.summary.errors.join(' | '));
  assert.equal(live.data.session.summary.totalCents,8436);
  assert.equal((await req(env,'POST',`/api/sessions/${id}/finalize`,{},hostToken)).status,200);
  assert.equal((await claim(person1.data.token,'12oz Superflux','toggle',jamieId)).status,409);
  const settled = await req(env,'GET',`/api/sessions/${id}`,undefined,hostToken);
  assert.equal(settled.data.session.status,'finalized');
  const debt = settled.data.session.summary.payments.find(p=>p.participantId===jamieId).outstandingCents;
  const record = await req(env,'POST',`/api/sessions/${id}/payments`,{participantId:jamieId,amountCents:100},hostToken);
  assert.equal(record.status,201);
  assert.equal((await req(env,'POST',`/api/sessions/${id}/reopen`,{},hostToken)).status,409);
  const again = await req(env,'GET',`/api/sessions/${id}`,undefined,hostToken);
  assert.equal(again.data.session.summary.payments.find(p=>p.participantId===jamieId).outstandingCents,debt-100);
  const jamieView = await req(env, 'GET', `/api/sessions/${id}`, undefined, person1.data.token);
  const chrisView = await req(env, 'GET', `/api/sessions/${id}`, undefined, person2.data.token);
  assert.equal(jamieView.status, 200);
  assert.equal(chrisView.status, 200);
  assert.equal(jamieView.data.session.summary.totalCents, 8436);
  assert.equal(chrisView.data.session.summary.totalCents, 8436);
  assert.equal(jamieView.data.session.summary.people.length, 3);
  assert.equal(chrisView.data.session.summary.people.length, 3);
  assert.deepEqual(jamieView.data.session.summary.payments.map(p => p.participantId), [jamieId]);
  assert.deepEqual(chrisView.data.session.summary.payments.map(p => p.participantId), [chrisId]);
  assert.equal(jamieView.data.session.summary.payments[0].paidCents, 100);
  assert.equal(chrisView.data.session.summary.payments[0].paidCents, 0);
  assert.equal(chrisView.data.session.payments.length, 0);
  assert.equal(jamieView.data.session.payments.length, 1);
  assert.equal(chrisView.data.session.summary.outstandingCents, undefined);
  assert.equal(jamieView.data.session.summary.outstandingCents, undefined);
  assert.equal(again.data.session.summary.payments.length, 3);
  assert.equal(again.data.session.payments.length, 1);
  assert.equal((await req(env,'DELETE',`/api/sessions/${id}/payments/${record.data.event.id}`,undefined,hostToken)).status,200);
  assert.equal((await req(env,'POST',`/api/sessions/${id}/reopen`,{},hostToken)).status,200);
  assert.ok(object.ctx.storage.alarm > Date.now());
  assert.equal((await req(env,'DELETE',`/api/sessions/${id}`,undefined,person1.data.token)).status,403);
  assert.equal((await req(env,'DELETE',`/api/sessions/${id}`,undefined,hostToken)).status,200);
  assert.equal((await req(env,'GET',`/api/sessions/${id}`,undefined,hostToken)).status,404);
});

test('Workers API prevents receipts from different restaurants from being merged', async () => {
  const env = fakeEnv();
  const created = await req(env, 'POST', '/api/sessions', { title: 'Restaurant A', hostName: 'Alex' });
  assert.equal(created.status, 201);
  const { token } = created.data;
  const id = created.data.session.id;
  const route = `/api/sessions/${id}/receipts`;
  const first = { kind: 'itemized', merchant: 'Gobong88', items: [{ name: 'Pizza', quantity: 1, amountCents: 10000, discountCents: 0, taxCategory: 'food' }], taxes: [], orderDiscountCents: 0, preTipTotalCents: 10000, tipCents: null, finalTotalCents: 10000 };
  const same = { kind: 'payment', merchant: 'Gobong (Burnaby)', items: [], taxes: [], orderDiscountCents: 0, preTipTotalCents: 10000, tipCents: 2000, finalTotalCents: 12000 };
  const other = { ...same, merchant: 'Busan Daeji Gukbap', finalTotalCents: 14007 };
  assert.equal((await req(env, 'POST', route, { receipt: first }, token)).status, 201);
  const checked = await req(env, 'POST', `${route}/check`, { receipt: other }, token);
  assert.equal(checked.status, 200);
  assert.equal(checked.data.compatibility.status, 'blocked');
  const rejected = await req(env, 'POST', route, { receipt: other }, token);
  assert.equal(rejected.status, 409);
  assert.match(rejected.data.error, /Different restaurant/);
  const before = await req(env, 'GET', `/api/sessions/${id}`, undefined, token);
  assert.equal(before.data.session.receipts.length, 1);
  assert.equal(before.data.session.summary.totalCents, 10000);
  const match = await req(env, 'POST', `${route}/check`, { receipt: same }, token);
  assert.equal(match.data.compatibility.status, 'ready');
  assert.equal((await req(env, 'POST', route, { receipt: same }, token)).status, 201);
  const after = await req(env, 'GET', `/api/sessions/${id}`, undefined, token);
  assert.equal(after.data.session.receipts.length, 2);
  assert.equal(after.data.session.summary.totalCents, 12000);
});
