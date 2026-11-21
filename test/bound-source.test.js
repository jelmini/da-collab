/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import * as sync from 'y-protocols/sync.js';
import * as awareness from 'y-protocols/awareness.js';
import { aem2doc, doc2aem } from '@adobe/da-parser';
import { BOUND_SOURCE_MODE, fetchBoundSource } from '../src/bound-source.js';
import edge, { DocRoom } from '../src/edge.js';
import {
  getYDoc, invalidateFromAdmin, messageFlushRequest, messageFlushResponse, persistence, setYDoc,
} from '../src/shareddoc.js';

const origin = 'http://localhost:38177';
const da = `${origin}/source/demo/work/page.html`;
const h6 = `${origin}/demo/sites/work/source/page.html`;
const legacy = `${origin}/source/demo/legacy/page.html`;
const branch = `${origin}/source/DEMO/Work~pilot/Page.HTML`;
const token = 'Bearer fixture-writer';
const html = (text) => `<body><header></header><main><div><p>${text}</p></div></main><footer></footer></body>`;

function socket(initialAttachment) {
  let attachment = initialAttachment;
  return {
    readyState: 1,
    sent: [],
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); },
    send(value) { this.sent.push(value); },
    close(code) {
      this.closeCode = code;
      this.readyState = 3;
    },
  };
}

function fixture(aliases = { da, h6, legacy }) {
  const source = {
    etag: '"r1"', body: html('Initial Source contents'), hint: 'helix6',
  };
  const calls = [];
  const rooms = new Map();
  const roomRequests = [];
  const env = {
    DA_RS_ORIGIN: origin,
    COLLAB_SHARED_SECRET: 'fixture-secret',
    IS_HELIX: 'local', // The bound transport must ignore the test override.
    daadmin: { fetch() { assert.fail('Unexpected daadmin fetch'); } },
  };
  env.dars = {
    async fetch(url, opts) {
      assert(Object.values(aliases).includes(url), `Unexpected bound URL: ${url}`);
      assert.equal(opts.redirect, 'manual');
      const headers = new Headers(opts.headers);
      const call = {
        url, method: opts.method, headers, body: opts.body,
      };
      calls.push(call);
      const { etag } = source;
      const responseHeaders = {};
      if (etag !== null) {
        responseHeaders.ETag = etag;
      }
      if (url !== aliases.legacy && source.hint !== null) {
        responseHeaders['X-DA-Source-Mode'] = source.hint;
      }
      if (source.unavailable !== undefined) {
        responseHeaders['X-DA-Source-Unavailable'] = source.unavailable;
      }
      if (opts.method === 'HEAD') {
        responseHeaders['X-da-actions'] = headers.get('Authorization') === 'Bearer fixture-reader'
          ? '/work/page.html=read' : '/work/page.html=read,write';
        return new Response(null, { status: source.headStatus ?? 200, headers: responseHeaders });
      }
      if (opts.method === 'GET') {
        const { body, holdGet } = source;
        if (holdGet) {
          source.holdGet = undefined;
          holdGet.started.resolve();
          await holdGet.release.promise;
        }
        return new Response(body, { headers: responseHeaders });
      }
      if (source.requireWriter && headers.get('Authorization') !== token) {
        call.status = 403;
        return new Response(null, { status: call.status });
      }
      const { holdPut } = source;
      if (holdPut) {
        source.holdPut = undefined;
        holdPut.started.resolve();
        await holdPut.release.promise;
      }
      const match = headers.get('If-Match');
      if (match !== '*' && match !== source.etag) {
        call.status = 412;
        return new Response(null, { status: call.status });
      }
      source.body = url === aliases.legacy ? await opts.body.get('data').text() : opts.body;
      source.etag = `"r${calls.filter((c) => c.method === 'PUT').length + 1}"`;
      call.status = 201;
      return new Response(null, {
        status: call.status, headers: { ETag: source.putEtag ?? source.etag },
      });
    },
  };
  env.rooms = {
    idFromName: (name) => name,
    get(name) {
      if (!rooms.has(name)) {
        const data = new Map();
        const ctx = {
          storage: {
            get: async (key) => (Array.isArray(key)
              ? new Map(key.map((k) => [k, data.get(k)])) : data.get(key)),
            put: async (key, value) => {
              if (typeof key === 'string') {
                data.set(key, value);
              } else {
                Object.entries(key).forEach(([k, v]) => data.set(k, v));
              }
            },
            delete: async (key) => [].concat(key).forEach((k) => data.delete(k)),
          },
          pending: [],
          accepted: [],
          acceptWebSocket(ws) { this.accepted.push(ws); },
          getWebSockets() { return this.accepted.filter((ws) => ws.readyState === 1); },
          waitUntil(promise) { this.pending.push(promise); },
        };
        rooms.set(name, { ctx, room: new DocRoom(ctx, env) });
      }
      return {
        fetch(request) {
          roomRequests.push({ name, request });
          return rooms.get(name).room.fetch(request, undefined, 200);
        },
      };
    },
  };
  return {
    source,
    env,
    calls,
    rooms,
    roomRequests,
    open(target, authorization = token, headers = {}, params = '') {
      const query = `?Authorization=${encodeURIComponent(authorization)}${params}`;
      return edge.fetch(new Request(`https://collab.example/${target}${query}`, {
        headers: { Upgrade: 'websocket', ...headers },
      }), env);
    },
    async connect(target = da, ...args) {
      assert.equal((await this.open(target, ...args)).status, 200);
      const { name } = roomRequests.at(-1);
      const { ctx, room } = rooms.get(name);
      const conn = ctx.accepted.at(-1);
      await Promise.all(ctx.pending);
      const doc = await getYDoc(name, conn, env, ctx.storage, undefined, ctx);
      return {
        ctx, room, conn, doc,
      };
    },
    notify(target, api = 'syncadmin', auth = 'token fixture-secret', method = 'POST') {
      const url = new URL(`https://collab.example/api/v1/${api}`);
      url.searchParams.set('doc', target);
      return edge.fetch(new Request(url, { method, headers: { Authorization: auth } }), env);
    },
    hold(request) {
      const hold = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      source[`hold${request}`] = hold;
      return hold;
    },
  };
}

function editMessage(doc, text) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  client.transact(() => {
    const fragment = client.getXmlFragment('prosemirror');
    fragment.delete(0, fragment.length);
    aem2doc(`<main><div><p>${text}</p></div></main>`, client);
  });
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 0);
  sync.writeUpdate(out, Y.encodeStateAsUpdate(client));
  client.destroy();
  return encoding.toUint8Array(out);
}

function awarenessMessage() {
  const client = new Y.Doc();
  client.clientID = 32013;
  const state = new awareness.Awareness(client);
  state.setLocalState({ user: { name: 'Alias editor' } });
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 1);
  encoding.writeVarUint8Array(out, awareness.encodeAwarenessUpdate(state, [client.clientID]));
  state.destroy();
  client.destroy();
  return encoding.toUint8Array(out);
}

function evict(doc) {
  setYDoc(doc.name, doc).delete(doc.name);
  doc.conns.clear();
  doc.destroy();
}

function flush(room, conn) {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, messageFlushRequest);
  return room.webSocketMessage(conn, encoding.toUint8Array(out));
}

function replies(conn) {
  return conn.sent.flatMap((bytes) => {
    const inMessage = decoding.createDecoder(bytes);
    if (decoding.readVarUint(inMessage) !== messageFlushResponse) {
      return [];
    }
    return [decoding.readVarUint(inMessage)];
  });
}

describe('Helix 6 Source on the configured da-rs binding', () => {
  let originalPair;

  beforeEach(() => {
    originalPair = DocRoom.newWebSocketPair;
    DocRoom.newWebSocketPair = () => [{}, socket()];
  });

  afterEach(async () => {
    DocRoom.newWebSocketPair = originalPair;
    await Promise.all([da, legacy, branch].map((name) => invalidateFromAdmin(name, true)));
  });

  it('authorizes both aliases, shares room and awareness, and flushes raw PUT with exact GET and PUT ETags', async () => {
    const f = fixture();
    const first = await f.connect(da);
    const second = await f.connect(h6, 'Bearer fixture-reader', {
      [BOUND_SOURCE_MODE]: 'legacy',
      'X-auth-actions': 'write',
      'X-collab-room': `${origin}/source/demo/work/spoof.html`,
      Authorization: 'Bearer unrelated',
    });
    assert.equal(first.doc, second.doc);
    assert.equal(f.rooms.size, 1);
    assert.equal(second.conn.auth, 'Bearer fixture-reader');
    assert.equal(second.conn.readOnly, true);
    const attachment = second.conn.deserializeAttachment();
    assert.equal(attachment.boundMode, 'helix6');
    assert.equal(attachment.docName, da);
    assert.equal(attachment.sourceSession, first.conn.deserializeAttachment().sourceSession);
    assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
      ['HEAD', da], ['GET', h6], ['HEAD', h6],
    ]);
    assert(f.roomRequests.every(({ request }) => request.url === da));
    assert.equal(f.calls[0].headers.get('Authorization'), token);
    assert.equal(f.calls[2].headers.get('Authorization'), 'Bearer fixture-reader');
    await second.room.webSocketMessage(second.conn, awarenessMessage());
    assert.equal(first.doc.awareness.getStates().get(32013).user.name, 'Alias editor');
    await second.room.webSocketMessage(second.conn, editMessage(first.doc, 'Forbidden write'));
    assert.doesNotMatch(doc2aem(first.doc), /Forbidden write/);

    for (const [i, text] of ['First real edit', 'Second real edit'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      await first.room.webSocketMessage(first.conn, editMessage(first.doc, text));
      // eslint-disable-next-line no-await-in-loop
      await flush(first.room, first.conn);
      const write = f.calls.at(-1);
      assert.equal(write.url, h6);
      assert.equal(write.method, 'PUT');
      assert.equal(write.headers.get('If-Match'), `"r${i + 1}"`);
      assert.equal(write.headers.get('Content-Type'), 'text/html');
      assert.equal(write.headers.get('X-DA-Initiator'), 'collab');
      assert.equal(write.headers.get('Authorization'), token);
      assert.equal(typeof write.body, 'string');
      assert(write.body.includes(text));
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await first.ctx.storage.get('fencedSourceEtag'), `"r${i + 2}"`);
    }
    assert.deepEqual(replies(first.conn), [1, 1]);
  });

  it('rejects unavailable, malformed or missing required mode hints before resolving a room', async () => {
    const f = fixture();
    f.source.unavailable = 'true';
    assert.equal((await f.open(da)).status, 503);
    f.source.unavailable = undefined;
    f.source.hint = 'helix6, legacy';
    assert.equal((await f.open(da)).status, 503);
    f.source.hint = null;
    assert.equal((await f.open(h6)).status, 503);
    f.source.hint = 'helix6';
    f.source.headStatus = 404;
    assert.equal((await f.open(h6)).status, 404);
    f.source.headStatus = 200;
    delete f.env.dars;
    assert.equal((await f.open(da)).status, 503);
    assert.equal(f.roomRequests.length, 0);
    assert(f.calls.every(({ method }) => method === 'HEAD'));
  });

  it('does not follow a manually surfaced redirect, expose its Location, or admit the room', async () => {
    const f = fixture();
    const requests = [];
    const location = `${origin}/other-destination`;
    f.env.dars.fetch = async (url, opts) => {
      requests.push([url, opts.method, opts.redirect, opts.headers.get('Authorization')]);
      return new Response(null, {
        status: 307, headers: { Location: location, 'X-DA-Source-Mode': 'helix6' },
      });
    };
    const res = await f.open(h6);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Location'), null);
    assert.deepEqual(requests, [[h6, 'HEAD', 'manual', token]]);
    assert.equal(f.roomRequests.length, 0);
  });

  it('rejects a 304, an already redirected response, and an opaque redirect from the binding', async () => {
    const results = [
      new Response(null, { status: 304 }),
      { redirected: true, status: 200 },
      { type: 'opaqueredirect', status: 0 },
    ];
    await Promise.all(results.map((result) => assert.rejects(
      fetchBoundSource({ dars: { fetch: () => result } }, h6, { method: 'GET' }),
      { status: 503, message: 'Unexpected redirect from bound Source' },
    )));
  });

  it('HEADs the exact mixed-case aliases and uses the lowercase room and Helix 6 write path', async () => {
    const mixedDA = `${origin}/source/DEMO/Work/PaGe.HTML`;
    const mixedH6 = `${origin}/demo/sites/work/source/PAGE.HTML`;
    const f = fixture({
      da, h6, mixedDA, mixedH6,
    });
    const first = await f.connect(mixedDA);
    const second = await f.connect(mixedH6, 'Bearer fixture-reader');
    assert.equal(first.doc, second.doc);
    assert.deepEqual([...f.rooms.keys()], [da]);
    assert.deepEqual(f.calls.map(({ method, url, headers }) => [method, url, headers.get('Authorization')]), [
      ['HEAD', mixedDA, token], ['GET', h6, token], ['HEAD', mixedH6, 'Bearer fixture-reader'],
    ]);
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Mixed-case alias edit'));
    await flush(first.room, first.conn);
    assert.equal(f.calls.at(-1).url, h6);
    assert.equal(f.calls.at(-1).method, 'PUT');
    assert.equal(f.calls.at(-1).headers.get('If-Match'), '"r1"');
    const count = f.calls.length;
    assert.equal((await f.notify(da)).status, 200); // Sender uses the canonical lowercase path.
    assert.equal(f.calls.length, count);
    assert.equal(first.conn.closeCode, 4412);
    assert.equal(second.conn.closeCode, 4412);
  });

  it('rejects non-ASCII case variants and admits already-lowercase Unicode on both aliases', async () => {
    const p = '%CE%BF%CF%82/i%CC%87mage.html'; // ος/i + combining dot above + mage.html.
    const lowerDA = `${origin}/source/demo/work/${p}`;
    const lowerH6 = `${origin}/demo/sites/work/source/${p}`;
    const f = fixture({ da: lowerDA, h6: lowerH6 });
    for (const variant of [
      '%CE%9F%CE%A3/image.html', 'A%CE%A3-B/image.html', 'A%CE%A3%C2%B7B/image.html',
      'assets/%C4%B0mage.html', '%C7%85.html',
    ]) {
      // These may lowercase differently in Java and JS; never send their bearer token.
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await f.open(`${origin}/demo/sites/work/source/${variant}`)).status, 400);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await f.open(`${origin}/source/demo/work/${variant}`)).status, 400);
    }
    assert.equal(f.calls.length, 0);
    try {
      const first = await f.connect(lowerDA);
      const second = await f.connect(lowerH6);
      assert.equal(first.doc, second.doc);
      assert.deepEqual([...f.rooms.keys()], [lowerDA]);
      assert.equal((await f.notify(lowerDA)).status, 200);
      assert.equal(first.conn.closeCode, 4412);
      assert.equal(second.conn.closeCode, 4412);
    } finally {
      await invalidateFromAdmin(lowerDA, true);
    }
  });

  it('validates the exact origin, URL syntax and unsupported branch selectors before forwarding auth', async () => {
    const f = fixture();
    assert.equal((await f.open(h6.replace('38177', '38178'))).status, 404);
    assert.equal((await f.open(h6.replace('localhost', 'user:pass@localhost'))).status, 400);
    assert.equal((await f.open(h6.replace('page.html', '%252fpage.html'))).status, 400);
    assert.equal((await f.open(h6.replace('page.html', 'folder%2Fpage.html'))).status, 400);
    assert.equal((await f.open(h6.replace('page.html', 'page.html/.versions'))).status, 400);
    assert.equal((await f.open(h6.replace('page.html', 'page.html/.Versions'))).status, 400);
    assert.equal((await f.open(da.replace('page.html', '.HISTORY/page.html'))).status, 400);
    assert.equal((await f.open(h6.replace('/demo/', '/Demo/'))).status, 400);
    assert.equal((await f.open(h6.replace('/work/', '/Work/'))).status, 400);
    assert.equal((await f.open(h6.replace('/work/', '/%77ork/'))).status, 400);
    assert.equal((await f.open(h6.replace('/work/', '/work~pilot/'))).status, 422);
    assert.equal((await f.open(h6, token, {}, '&contentBranch=pilot')).status, 422);
    assert.equal((await f.notify(`${h6}?Authorization=fixture-token`)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.roomRequests.length, 0);
  });

  it('keeps unbound legacy DA-prefix URLs and shared-secret GET notifications intact', async () => {
    const target = 'https://admin.da.live/source/sites/mixed/source/Page.HTML';
    const f = fixture();
    delete f.env.DA_RS_ORIGIN;
    delete f.env.IS_HELIX;
    const canonicalBody = new Y.Doc();
    aem2doc(html('Legacy DA prefix'), canonicalBody);
    const body = doc2aem(canonicalBody);
    canonicalBody.destroy();
    const legacyRequests = [];
    f.env.daadmin.fetch = (url, opts) => {
      legacyRequests.push([url, opts.method]);
      return new Response(opts.method === 'HEAD' ? null : body, {
        headers: { 'X-da-actions': '/mixed/source/page.html=read,write' },
      });
    };
    try {
      const { ctx } = await f.connect(target);
      await Promise.all(ctx.pending); // Legacy DA restores asynchronously.
      assert.deepEqual([...f.rooms.keys()], [target]);
      assert.equal((await f.notify(target, 'syncadmin', 'token wrong', 'GET')).status, 401);
      assert.equal((await f.notify(target, 'syncadmin', 'token fixture-secret', 'GET')).status, 200);
      assert.equal(f.roomRequests.at(-1).name, target);
      assert.deepEqual(legacyRequests, [[target, 'HEAD'], [target, undefined]]);
      assert.equal(f.calls.length, 0);
    } finally {
      await invalidateFromAdmin(target, true);
    }
  });

  it('fails closed on malformed or hosted binding configuration', async () => {
    const f = fixture();
    for (const badOrigin of [`${origin}/`, 'https://api.aem.live', 'https://admin.da.live']) {
      f.env.DA_RS_ORIGIN = badOrigin;
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await f.open(da)).status, 503);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await f.notify(da)).status, 503);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.roomRequests.length, 0);
  });

  it('uses the WebSocket protocol token for bound HEAD and GET without forwarding it as a protocol', async () => {
    const f = fixture();
    const response = await f.open(h6, 'Bearer query-token-ignored', {
      'Sec-WebSocket-Protocol': 'yjs, fixture-protocol-token',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'yjs');
    const { ctx } = f.rooms.get(da);
    await Promise.all(ctx.pending);
    assert.deepEqual(f.calls.map(({ method, headers }) => [method, headers.get('Authorization')]), [
      ['HEAD', 'Bearer fixture-protocol-token'], ['GET', 'Bearer fixture-protocol-token'],
    ]);
    assert.equal(f.roomRequests[0].request.headers.get('Sec-WebSocket-Protocol'), 'yjs');
    assert.equal(f.roomRequests[0].request.url, da);
  });

  it('uses IS_HELIX consistently when admitting a socket to a waking ordinary room', async () => {
    const target = 'https://admin.da.live/source/demo/work/unbound.html';
    const f = fixture();
    const originalBind = persistence.bindState;
    try {
      persistence.bindState = async (_name, doc, conn) => {
        // A public Helix restore may notify its already-admitted waking socket.
        assert.equal(doc.conns.has(conn), true);
        return new Map();
      };
      const conn = socket({ docName: target, auth: token, authActions: 'read,write' });
      const room = new DocRoom({}, f.env);
      await room.webSocketMessage(conn, awarenessMessage());
      assert.equal(conn.readyState, 1);
      assert(conn.sent.length > 0);
    } finally {
      persistence.bindState = originalBind;
      await invalidateFromAdmin(target, true);
    }
  });

  it('does not put a query token in a bound URL or a log, including binding errors', async () => {
    const f = fixture();
    const secret = 'private-fixture-token value';
    const logs = [];
    const methods = ['log', 'warn', 'error'];
    const originals = methods.map((key) => console[key]);
    try {
      methods.forEach((key) => {
        console[key] = (...args) => logs.push(args.map(String).join(' '));
      });
      await f.connect(da, secret);
      assert(f.calls.every(({ url }) => !url.includes('Authorization')));
      assert(f.roomRequests.every(({ request }) => !request.url.includes('Authorization')));
      assert(f.calls.every(({ headers }) => headers.get('Authorization') === secret));
      f.env.dars.fetch = () => {
        throw new Error(secret);
      };
      assert.equal((await f.open(h6, secret)).status, 503);
      assert(!logs.some((line) => line.includes('private-fixture-token')));
    } finally {
      methods.forEach((key, i) => {
        console[key] = originals[i];
      });
    }
  });

  it('keeps bound unmarked DA multipart wildcard writes and qualified branch routing separate', async () => {
    const f = fixture();
    const control = await f.connect(legacy);
    await Promise.all(control.ctx.pending);
    assert.equal(control.conn.deserializeAttachment().boundMode, 'legacy');
    await control.room.webSocketMessage(control.conn, editMessage(control.doc, 'Unmarked control edit'));
    await flush(control.room, control.conn);
    const write = f.calls.at(-1);
    assert.equal(write.url, legacy);
    assert.equal(write.headers.get('If-Match'), '*');
    assert(write.body instanceof FormData);
    assert.equal(await control.ctx.storage.get('fencedSourceEtag'), undefined);
    assert.deepEqual(replies(control.conn), [1]);

    delete f.env.IS_HELIX;
    const qualifiedCalls = [];
    f.env.daadmin.fetch = (url, opts) => {
      qualifiedCalls.push([url, opts.method]);
      const headers = {
        ETag: '"branch"', 'Content-Branch': 'pilot', 'X-da-actions': '/work/page.html=read,write',
      };
      return new Response(opts.method === 'HEAD' ? null : html('Branch control'), { headers });
    };
    assert.equal((await f.open(branch)).status, 200);
    const { ctx } = f.rooms.get(branch);
    await Promise.all(ctx.pending);
    assert.equal(ctx.accepted[0].deserializeAttachment().docName, branch);
    assert.equal(ctx.accepted[0].deserializeAttachment().boundMode, undefined);
    assert.deepEqual(qualifiedCalls, [[branch, 'HEAD'], [branch, undefined]]);
  });

  it('rejects a mode change between authorization and GET, and a weak GET validator', async () => {
    const f = fixture();
    const originalFetch = f.env.dars.fetch;
    f.env.dars.fetch = (url, opts) => {
      if (opts.method === 'GET') {
        f.source.hint = 'helix6';
      }
      return originalFetch(url, opts);
    };
    f.source.hint = null;
    assert.equal((await f.open(da)).status, 200);
    const { ctx } = f.rooms.get(da);
    await Promise.all(ctx.pending);
    assert.equal(ctx.accepted[0].closeCode, 4412);
    assert.deepEqual(ctx.accepted[0].sent, []);
    assert.equal(await ctx.storage.get('fencedSourceEtag'), undefined);

    f.source.etag = 'W/"r1"';
    assert.equal((await f.open(h6)).status, 200);
    await Promise.all(ctx.pending);
    assert.equal(ctx.accepted[1].closeCode, 1011);
    assert.deepEqual(ctx.accepted[1].sent, []);
    assert.equal(await ctx.storage.get('fencedSourceEtag'), undefined);
    assert(f.calls.every(({ method }) => method !== 'PUT'));
  });

  it('rejects flush and discards the snapshot when a successful PUT has a malformed ETag', async () => {
    const f = fixture();
    const {
      room, conn, doc, ctx,
    } = await f.connect();
    f.source.putEtag = '"r2", "r3"';
    await room.webSocketMessage(conn, editMessage(doc, 'Write without verified successor'));
    await flush(room, conn);
    assert.equal(f.calls.at(-1).status, 201);
    assert.deepEqual(replies(conn), [0]);
    assert.equal(conn.closeCode, 4412);
    assert.equal(await ctx.storage.get('fencedSourceEtag'), null);
    assert.equal(await ctx.storage.get('docstore'), undefined);
  });

  for (const notifyFirst of [false, true]) {
    it(`discards an in-flight old PUT ${notifyFirst ? 'on admin notice before 412' : 'on 412 without a notice'}`, async () => {
      const f = fixture();
      const first = await f.connect();
      const second = await f.connect(h6);
      const hold = f.hold('Put');
      await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Old Worker edit'));
      const saving = flush(first.room, first.conn);
      await hold.started.promise;
      const oldWrite = f.calls.at(-1);
      assert.equal(oldWrite.headers.get('If-Match'), '"r1"');
      assert.deepEqual(replies(first.conn), []);
      f.source.etag = '"external"';
      f.source.body = html('New external write');
      let fresh;
      if (notifyFirst) {
        const count = f.calls.length;
        assert.equal((await f.notify(h6)).status, 200);
        assert.equal(f.calls.length, count); // No HEAD on admin notices.
        assert.equal(first.conn.closeCode, 4412);
        assert.deepEqual(replies(first.conn), [0]);
        fresh = await f.connect(h6);
      }
      hold.release.resolve();
      await saving;
      assert.equal(oldWrite.status, 412);
      assert.equal(first.conn.closeCode, 4412);
      assert.equal(second.conn.closeCode, 4412);
      assert.deepEqual(replies(first.conn), [0]);
      assert.match(f.source.body, /New external write/);
      fresh ??= await f.connect(da);
      assert.equal(fresh.conn.readyState, 1);
      assert.equal(fresh.doc.etag, '"external"');
      assert.match(doc2aem(fresh.doc), /New external write/);
      assert.equal(await fresh.ctx.storage.get('fencedSourceEtag'), '"external"');
    });
  }

  it('serializes concurrent flushes and fences a second edit with the successor ETag', async () => {
    const f = fixture();
    const first = await f.connect();
    const second = await f.connect(h6);
    const hold = f.hold('Put');
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Edit in flight'));
    const initial = flush(first.room, first.conn);
    await hold.started.promise;
    await second.room.webSocketMessage(second.conn, editMessage(second.doc, 'Edit during first save'));
    const later = flush(second.room, second.conn);
    assert.equal(f.calls.filter(({ method }) => method === 'PUT').length, 1);
    hold.release.resolve();
    await Promise.all([initial, later]);
    const writes = f.calls.filter(({ method }) => method === 'PUT');
    assert.deepEqual(writes.map(({ headers }) => headers.get('If-Match')), ['"r1"', '"r2"']);
    assert.deepEqual(replies(first.conn), [1]);
    assert.deepEqual(replies(second.conn), [1]);
    assert.match(f.source.body, /Edit during first save/);
  });

  it('uses the departing writer grant for the final fenced raw PUT', async () => {
    const f = fixture();
    f.source.requireWriter = true;
    const {
      room, conn, doc, ctx,
    } = await f.connect(h6);
    await room.webSocketMessage(conn, editMessage(doc, 'Final writer edit'));
    await room.webSocketClose(conn);
    const write = f.calls.at(-1);
    assert.equal(write.status, 201);
    assert.equal(write.method, 'PUT');
    assert.equal(write.url, h6);
    assert.equal(write.headers.get('Authorization'), token);
    assert.equal(write.headers.get('If-Match'), '"r1"');
    assert.equal(write.headers.get('Content-Type'), 'text/html');
    assert.equal(typeof write.body, 'string');
    assert.match(f.source.body, /Final writer edit/);
    assert.equal(await ctx.storage.get('fencedSourceEtag'), '"r2"');
    assert.equal(doc.isDestroyed, true);
  });

  it('does not save pending writer data with the last read-only socket grant', async () => {
    const f = fixture();
    f.source.requireWriter = true;
    const writer = await f.connect(da);
    const reader = await f.connect(h6, 'Bearer fixture-reader');
    await writer.room.webSocketMessage(writer.conn, editMessage(writer.doc, 'Pending writer edit'));
    await writer.room.webSocketClose(writer.conn);
    await reader.room.webSocketClose(reader.conn);
    assert(f.calls.every(({ method }) => method !== 'PUT'));
    assert.doesNotMatch(f.source.body, /Pending writer edit/);
    assert.equal(await reader.ctx.storage.get('fencedSourceEtag'), '"r1"');
    await assert.rejects(reader.doc.flushSave(), /without an authorized writer/);
    const fresh = await f.connect(h6);
    await flush(fresh.room, fresh.conn);
    assert.deepEqual(replies(fresh.conn), [1]);
    assert.equal(f.calls.at(-1).headers.get('Authorization'), token);
    assert.match(f.source.body, /Pending writer edit/);
  });

  it('does not reuse a departing writer grant when a reader joins during an in-flight save', async () => {
    const f = fixture();
    f.source.requireWriter = true;
    const writer = await f.connect(da);
    const hold = f.hold('Put');
    await writer.room.webSocketMessage(writer.conn, editMessage(writer.doc, 'First edit in flight'));
    const saving = flush(writer.room, writer.conn);
    await hold.started.promise;
    await writer.room.webSocketMessage(writer.conn, editMessage(writer.doc, 'Second unsaved edit'));
    const closingWriter = writer.room.webSocketClose(writer.conn);
    const reader = await f.connect(h6, 'Bearer fixture-reader');
    const closingReader = reader.room.webSocketClose(reader.conn);
    hold.release.resolve();
    await Promise.all([saving, closingWriter, closingReader]);
    const writes = f.calls.filter(({ method }) => method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].headers.get('Authorization'), token);
    assert.match(f.source.body, /First edit in flight/);
    assert.doesNotMatch(f.source.body, /Second unsaved edit/);
  });

  it('uses the newly admitted writer grant for edits that follow a closing writer PUT', async () => {
    const f = fixture();
    const old = await f.connect(da);
    const hold = f.hold('Put');
    await old.room.webSocketMessage(old.conn, editMessage(old.doc, 'Final edit in flight'));
    const closing = old.room.webSocketClose(old.conn);
    await hold.started.promise;
    const newGrant = 'Bearer next-fixture-writer';
    const fresh = await f.connect(h6, newGrant);
    await fresh.room.webSocketMessage(fresh.conn, editMessage(fresh.doc, 'Next writer edit'));
    const saving = flush(fresh.room, fresh.conn);
    hold.release.resolve();
    await Promise.all([closing, saving]);
    const writes = f.calls.filter(({ method }) => method === 'PUT');
    assert.deepEqual(writes.map(({ headers }) => [headers.get('Authorization'), headers.get('If-Match')]), [
      [token, '"r1"'], [newGrant, '"r2"'],
    ]);
    assert.deepEqual(replies(fresh.conn), [1]);
    assert.match(f.source.body, /Next writer edit/);
  });

  it('discards the snapshot when an authenticated last-close PUT receives 412', async () => {
    const f = fixture();
    f.source.requireWriter = true;
    const { room, conn, doc } = await f.connect(h6);
    await room.webSocketMessage(conn, editMessage(doc, 'Stale final edit'));
    f.source.etag = '"external"';
    f.source.body = html('External write won');
    await room.webSocketClose(conn);
    assert.equal(f.calls.at(-1).status, 412);
    assert.equal(f.calls.at(-1).headers.get('Authorization'), token);
    assert.equal(f.calls.at(-1).headers.get('If-Match'), '"r1"');
    assert.equal(conn.closeCode, 4412);
    assert.equal(await doc.storage.get('fencedSourceEtag'), null);
    await assert.rejects(doc.flushSave(), /412/);
    assert.match(f.source.body, /External write won/);
  });

  it('does not retry a closing writer grant after invalidation and successor admission', async () => {
    const f = fixture();
    f.source.requireWriter = true;
    const old = await f.connect(da);
    const hold = f.hold('Put');
    await old.room.webSocketMessage(old.conn, editMessage(old.doc, 'Old final edit'));
    const closing = old.room.webSocketClose(old.conn);
    await hold.started.promise;
    const oldWrite = f.calls.at(-1);
    assert.equal(oldWrite.headers.get('Authorization'), token);
    assert.equal(oldWrite.headers.get('If-Match'), '"r1"');
    f.source.etag = '"external"';
    f.source.body = html('External write won');
    assert.equal((await f.notify(da)).status, 200);
    const fresh = await f.connect(h6);
    hold.release.resolve();
    await closing;
    assert.equal(oldWrite.status, 412);
    assert.equal(f.calls.filter(({ method }) => method === 'PUT').length, 1);
    assert.equal(old.conn.closeCode, 4412);
    assert.equal(fresh.conn.readyState, 1);
    assert.equal(await fresh.ctx.storage.get('fencedSourceEtag'), '"external"');
    assert.match(doc2aem(fresh.doc), /External write won/);
  });

  it('does not let a GET that finishes after a canonical notice retire the replacement room', async () => {
    const f = fixture();
    const hold = f.hold('Get');
    assert.equal((await f.open(h6)).status, 200);
    await hold.started.promise;
    const { ctx } = f.rooms.get(da);
    const old = ctx.accepted[0];
    f.source.etag = '"new-get"';
    f.source.body = html('Replacement room content');
    assert.equal((await f.notify(da)).status, 200);
    assert.equal(old.closeCode, 4412);
    assert.equal((await f.open(da)).status, 200);
    await ctx.pending.at(-1);
    const fresh = ctx.accepted[1];
    hold.release.resolve();
    await Promise.all(ctx.pending);
    const current = await getYDoc(da, fresh, f.env, ctx.storage, undefined, ctx);
    assert.equal(old.closeCode, 4412);
    assert.equal(fresh.readyState, 1);
    assert.equal(current.etag, '"new-get"');
    assert.match(doc2aem(current), /Replacement room content/);
    assert.equal(await ctx.storage.get('fencedSourceEtag'), '"new-get"');
    assert.equal(f.calls.filter(({ method }) => method === 'GET').length, 2);
  });

  it('checks a woken socket against the snapshot session before any sync or replay', async () => {
    const f = fixture();
    const first = await f.connect();
    const attachment = first.conn.deserializeAttachment();
    const edit = editMessage(first.doc, 'Replay from old session');
    evict(first.doc);
    f.source.etag = '"external"';
    f.source.body = html('New Source after sleep');
    const hold = f.hold('Get');
    const woken = socket(attachment);
    const waking = first.room.webSocketMessage(woken, edit);
    await hold.started.promise;
    const joining = f.connect(h6);
    hold.release.resolve();
    const [fresh] = await Promise.all([joining, waking]);
    assert.deepEqual(woken.sent, []);
    assert.equal(woken.closeCode, 4412);
    assert.notEqual(fresh.conn.deserializeAttachment().sourceSession, attachment.sourceSession);
    assert.match(doc2aem(fresh.doc), /New Source after sleep/);
    assert.doesNotMatch(doc2aem(fresh.doc), /Replay from old session/);
    assert(f.calls.every(({ method }) => method !== 'PUT'));
  });

  it('resumes a matching H6 snapshot with its validator and rejects an older attachment with no mode', async () => {
    const f = fixture();
    const first = await f.connect();
    const attachment = first.conn.deserializeAttachment();
    const edit = editMessage(first.doc, 'Edit after wake');
    evict(first.doc);
    const noMode = socket({ ...attachment, boundMode: undefined });
    const count = f.calls.length;
    await first.room.webSocketMessage(noMode, edit);
    assert.equal(noMode.closeCode, 4412);
    assert.equal(f.calls.length, count);
    const woken = socket(attachment);
    await first.room.webSocketMessage(woken, edit);
    assert.equal(woken.readyState, 1);
    await flush(first.room, woken);
    assert.deepEqual(replies(woken), [1]);
    assert.equal(f.calls.at(-1).headers.get('If-Match'), '"r1"');
    assert.match(f.source.body, /Edit after wake/);
  });

  it('authenticates deleteadmin and invalidates hibernated state without requiring HEAD', async () => {
    const f = fixture();
    const first = await f.connect();
    const attachment = first.conn.deserializeAttachment();
    evict(first.doc);
    const count = f.calls.length;
    assert.equal((await f.notify(da, 'deleteadmin', 'token wrong')).status, 401);
    assert.equal(first.conn.readyState, 1);
    f.source.headStatus = 404; // Already gone on Source.
    assert.equal((await f.notify(da, 'deleteadmin')).status, 204);
    assert.equal(f.calls.length, count);
    assert.equal(first.conn.closeCode, 4412);
    assert.equal(f.roomRequests.at(-1).name, da);
    assert.equal(await first.ctx.storage.get('docstore'), undefined);
    assert.equal(await first.ctx.storage.get('fencedSourceEtag'), null);

    // A queued wake can't reuse even the same ETag after storage invalidation.
    const woken = socket(attachment);
    await flush(first.room, woken);
    assert.equal(woken.closeCode, 4412);
    assert.deepEqual(woken.sent, []);
  });
});
