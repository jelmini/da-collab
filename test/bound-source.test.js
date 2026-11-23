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
import {
  BOUND_SOURCE_ETAG, BOUND_SOURCE_INSTANCE, BOUND_SOURCE_MODE, fetchBoundSource,
  SOURCE_COLLABORATION, SOURCE_CONTENT_PROFILE,
} from '../src/bound-source.js';
import edge, { DocRoom } from '../src/edge.js';
import {
  getYDoc, invalidateFromAdmin, messageFlushRequest, messageFlushResponse, persistence, setYDoc,
} from '../src/shareddoc.js';

const origin = 'http://localhost:38177';
const da = `${origin}/source/demo/work/page.html`;
const h6 = `${origin}/demo/sites/work/source/page.html`;
const legacy = `${origin}/source/demo/legacy/page.html`;
const branch = `${origin}/source/DEMO/Work~pilot/Page.HTML`;
const escapedLegacyBranch = branch.replace('~', '%7E');
const draftDA = `${origin}/source/demo/work~draft/page.html`;
const draftH6 = `${origin}/demo/sites/work~draft/source/page.html`;
const draftMixed = `${origin}/source/DEMO/Work~draft/Page.HTML`;
const draftMixedDoc = `${origin}/source/demo/work~draft/Page.HTML`;
const draftEscaped = draftDA.replace('~', '%7E');
const percentDA = draftDA.replace('page.html', '100%25.html');
const upperUnicodeDA = draftDA.replace('page.html', '%C3%89dition.html');
const siblingDA = `${origin}/source/demo/work~sibling/page.html`;
const siblingH6 = `${origin}/demo/sites/work~sibling/source/page.html`;
const firstInstance = 'fd0138c3-f818-4fce-b059-25e001923e28';
const nextInstance = 'd56bee98-aac5-4118-8c2e-b916e0c518c2';
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

function sourceHeaders(source, showMode, overrides = {}) {
  const headers = new Headers();
  if (source.etag !== null) {
    headers.set('ETag', source.etag);
  }
  if (showMode && source.hint !== null) {
    headers.set('X-DA-Source-Mode', source.hint);
    if (source.hint === 'helix6') {
      headers.set(SOURCE_CONTENT_PROFILE, 'native-da');
      headers.set(SOURCE_COLLABORATION, 'true');
    }
  }
  if (source.unavailable !== undefined) {
    headers.set('X-DA-Source-Unavailable', source.unavailable);
  }
  if (source.branch) {
    headers.set('Content-Branch', source.branch);
    headers.set('Branch-Revision', source.revision);
    if (source.instance !== undefined) {
      headers.set('X-DA-Branch-Instance', source.instance);
    }
  }
  Object.entries(overrides).forEach(([name, value]) => {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  });
  return headers;
}

function fixture(aliases = { da, h6, legacy }, extraSources = {}) {
  const source = {
    etag: '"r1"', body: html('Initial Source contents'), hint: 'helix6',
  };
  const calls = [];
  const rooms = new Map();
  const roomRequests = [];
  const roomLookups = [];
  const env = {
    DA_RS_ORIGIN: origin,
    COLLAB_SHARED_SECRET: 'fixture-secret',
    IS_HELIX: 'local', // The bound transport must ignore the test override.
    daadmin: { fetch() { assert.fail('Unexpected daadmin fetch'); } },
  };
  env.dars = {
    async fetch(url, opts) {
      assert(Object.values(aliases).includes(url), `Unexpected bound URL: ${url}`);
      const request = new Request(url, opts);
      assert.equal(request.redirect, 'manual');
      const { headers, method } = request;
      const entry = extraSources[url] ?? source;
      const call = {
        url, method, headers, body: opts.body,
      };
      calls.push(call);
      const showMode = url !== aliases.legacy;
      if (method === 'HEAD') {
        const responseHeaders = sourceHeaders(entry, showMode, entry.headHeaders);
        const fixtureActions = headers.get('Authorization') === 'Bearer fixture-reader'
          ? 'read' : 'read,write';
        responseHeaders.set('X-da-actions', `/work/page.html=${entry.headActions ?? fixtureActions}`);
        const { holdHead, headStatus } = entry;
        if (holdHead) {
          entry.holdHead = undefined;
          holdHead.started.resolve();
          await holdHead.release.promise;
        }
        return new Response(null, { status: headStatus ?? 200, headers: responseHeaders });
      }
      if (method === 'GET') {
        const responseHeaders = sourceHeaders(entry, showMode, entry.getHeaders);
        const { body, holdGet } = entry;
        if (holdGet) {
          entry.holdGet = undefined;
          holdGet.started.resolve();
          await holdGet.release.promise;
        }
        return new Response(body, { headers: responseHeaders });
      }
      if (entry.requireWriter && headers.get('Authorization') !== token) {
        call.status = 403;
        return new Response(null, { status: call.status });
      }
      const { holdPut } = entry;
      if (holdPut) {
        entry.holdPut = undefined;
        holdPut.started.resolve();
        await holdPut.release.promise;
      }
      const match = headers.get('If-Match');
      if (entry.putStatus) {
        call.status = entry.putStatus;
        return entry.putError ? Response.json({ error: { code: entry.putError } }, {
          status: call.status,
        }) : new Response(null, { status: call.status });
      }
      if (match !== '*' && match !== entry.etag) {
        call.status = 412;
        return new Response(null, { status: call.status });
      }
      entry.body = url === aliases.legacy ? await opts.body.get('data').text() : opts.body;
      if (entry.branch) {
        entry.revision += 1;
        entry.etag = `"${entry.branch}-item:${entry.revision}"`;
      } else {
        entry.etag = `"r${calls.filter((c) => c.method === 'PUT').length + 1}"`;
      }
      call.status = 201;
      const putHeaders = entry.branch
        ? sourceHeaders(entry, true, entry.putHeaders) : new Headers({ ETag: entry.etag });
      if (entry.putEtag != null) {
        putHeaders.set('ETag', entry.putEtag);
      }
      return new Response(null, {
        status: call.status, headers: putHeaders,
      });
    },
  };
  env.rooms = {
    idFromName(name) {
      roomLookups.push(['idFromName', name]);
      return name;
    },
    get(name) {
      roomLookups.push(['get', name]);
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
    roomLookups,
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

function branchFixture() {
  const sibling = {
    branch: 'sibling',
    revision: 1,
    instance: nextInstance,
    hint: 'helix6',
    etag: '"sibling-item:1"',
    body: html('Sibling content'),
  };
  const defaultSource = { hint: 'helix6', etag: '"default-item:1"', body: html('Default content') };
  const f = fixture({
    da,
    h6,
    draftDA,
    draftH6,
    draftMixed,
    draftMixedDoc,
    draftEscaped,
    siblingDA,
    siblingH6,
    percentDA,
    upperUnicodeDA,
  }, {
    [da]: defaultSource, [h6]: defaultSource, [siblingDA]: sibling, [siblingH6]: sibling,
  });
  Object.assign(f.source, {
    branch: 'draft', revision: 1, instance: firstInstance, etag: '"draft-item:1"',
  });
  return f;
}

function useLegacyBranchBackend(f) {
  const requests = [];
  f.env.daadmin.fetch = (url, opts) => {
    const request = new Request(url, opts);
    requests.push(request);
    assert.equal(request.redirect, 'manual');
    const isGet = request.method === 'GET';
    return new Response(isGet ? html('Ordinary branch content') : null, {
      status: request.method === 'PUT' ? 201 : 200,
      headers: {
        ETag: '"legacy-branch"',
        'Content-Branch': 'draft',
        'X-da-actions': `/work/page.html=${f.source.legacyActions ?? 'read,write'}`,
      },
    });
  };
  return requests;
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
    await Promise.all([da, legacy, branch, escapedLegacyBranch, draftDA, siblingDA,
      percentDA, upperUnicodeDA]
      .map((name) => invalidateFromAdmin(name, true)));
  });

  for (const [kind, file, representation] of [
    ['page', 'page.html', { ETag: null, 'Content-Type': 'text/html' }],
    ['sheet', 'offers.json', {
      ETag: '"sheet-bytes"', 'Content-Type': 'application/json', 'Content-Length': '246',
    }],
  ]) {
    it(`denies imported ${kind} HEAD metadata on both aliases before room lookup`, async () => {
      const daAlias = da.replace('page.html', file);
      const direct = h6.replace('page.html', file);
      const f = fixture({ da: daAlias, h6: direct });
      f.source.headHeaders = {
        ...representation,
        'X-DA-Source-Kind': kind,
        [SOURCE_CONTENT_PROFILE]: 'aem-import',
        [SOURCE_COLLABORATION]: 'false',
      };
      const spoofed = { [SOURCE_CONTENT_PROFILE]: 'native-da', [SOURCE_COLLABORATION]: 'true' };
      assert.equal((await f.open(direct, token, spoofed)).status, 403);
      assert.equal((await f.open(daAlias, token, spoofed)).status, 403);
      assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
        ['HEAD', direct], ['HEAD', daAlias],
      ]);
      assert.deepEqual(f.roomLookups, []);
    });
  }

  for (const [profile, collaboration, status] of [
    [null, null, 503],
    [null, 'true', 503],
    [null, 'false', 503],
    ['native-da', null, 503],
    ['native-da', 'false', 403],
    ['aem-import', null, 503],
    ['aem-import', 'true', 503],
    ['aem-import', 'false', 403],
    ['', 'true', 503],
    ['unknown', 'true', 503],
    ['Native-DA', 'true', 503],
    ['native-da, native-da', 'true', 503],
    ['native-da', 'TRUE', 503],
    ['native-da', '', 503],
    ['native-da', 'true, false', 503],
  ]) {
    it(`denies bound H6 profile=${profile}, collaboration=${collaboration}`, async () => {
      const f = branchFixture();
      const headers = {
        [SOURCE_CONTENT_PROFILE]: profile, [SOURCE_COLLABORATION]: collaboration,
      };
      f.source.headHeaders = headers;
      assert.equal((await f.open(draftDA)).status, status);
      assert.equal((await f.open(draftH6)).status, status);
      assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
        ['HEAD', draftDA], ['HEAD', draftH6],
      ]);
      assert.deepEqual(f.roomLookups, []);
    });
  }

  it('does not treat an imported, mode-stripped DA alias as genuine legacy', async () => {
    const f = fixture();
    f.source.headHeaders = {
      'X-DA-Source-Mode': null,
      [SOURCE_CONTENT_PROFILE]: 'aem-import',
      [SOURCE_COLLABORATION]: 'false',
    };
    assert.equal((await f.open(da)).status, 403);
    assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [['HEAD', da]]);
    assert.deepEqual(f.roomLookups, []);
  });

  it('preserves qualified imported unsupported-branch responses without trying Default', async () => {
    const f = branchFixture();
    f.source.headStatus = 422;
    f.source.headHeaders = {
      [SOURCE_CONTENT_PROFILE]: 'aem-import', [SOURCE_COLLABORATION]: 'false',
    };
    assert.equal((await f.open(draftDA)).status, 422);
    assert.equal((await f.open(draftH6)).status, 422);
    assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
      ['HEAD', draftDA], ['HEAD', draftH6],
    ]);
    assert.deepEqual(f.roomLookups, []);
  });

  it('does not replay a waking bare H6 socket into a cached room when collaboration is disabled', async () => {
    const f = fixture();
    const { conn, doc, room } = await f.connect(h6);
    const waking = socket(conn.deserializeAttachment());
    f.source.headHeaders = { [SOURCE_COLLABORATION]: 'false' };
    await room.webSocketMessage(waking, editMessage(doc, 'Stale replay into a cached room'));
    assert.equal(waking.closeCode, 4412);
    assert.deepEqual(waking.sent, []);
    assert.doesNotMatch(doc2aem(doc), /Stale replay/);
    assert.deepEqual(f.calls.map(({ method, url }) => [method, url]), [
      ['HEAD', h6], ['GET', h6], ['HEAD', da],
    ]);
  });

  it('authorizes both aliases, shares room and awareness, and flushes raw PUT with exact GET and PUT ETags', async () => {
    const f = fixture();
    const first = await f.connect(da);
    const second = await f.connect(h6, 'Bearer fixture-reader', {
      [BOUND_SOURCE_MODE]: 'legacy',
      'X-auth-actions': 'write',
      'X-collab-room': `${origin}/source/demo/work/spoof.html`,
      [SOURCE_CONTENT_PROFILE]: 'aem-import',
      [SOURCE_COLLABORATION]: 'false',
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
    const forwarded = f.roomRequests.at(-1).request.headers;
    assert.equal(forwarded.get(SOURCE_CONTENT_PROFILE), 'native-da');
    assert.equal(forwarded.get(SOURCE_COLLABORATION), 'true');
    assert.equal(f.calls[2].headers.get(SOURCE_CONTENT_PROFILE), null);
    assert.equal(f.calls[2].headers.get(SOURCE_COLLABORATION), null);
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
    assert.equal((await f.open(h6.replace('/work/', '/work~main/'))).status, 404);
    assert.equal((await f.open(h6.replace('/work/', '/work~Draft/'))).status, 400);
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
    const qualifiedSource = { hint: null, etag: '"branch"' };
    const f = fixture({
      da, h6, legacy, branch, escapedLegacyBranch,
    }, { [branch]: qualifiedSource, [escapedLegacyBranch]: qualifiedSource });
    const control = await f.connect(legacy, token, {
      [SOURCE_CONTENT_PROFILE]: 'native-da', [SOURCE_COLLABORATION]: 'true',
    });
    await Promise.all(control.ctx.pending);
    assert.equal(control.conn.deserializeAttachment().boundMode, 'legacy');
    const forwarded = f.roomRequests.at(-1).request.headers;
    assert.equal(forwarded.get(SOURCE_CONTENT_PROFILE), null);
    assert.equal(forwarded.get(SOURCE_COLLABORATION), null);
    await control.room.webSocketMessage(control.conn, editMessage(control.doc, 'Unmarked control edit'));
    await flush(control.room, control.conn);
    const write = f.calls.at(-1);
    assert.equal(write.url, legacy);
    assert.equal(write.headers.get('If-Match'), '*');
    assert(write.body instanceof FormData);
    assert.equal(await control.ctx.storage.get('fencedSourceEtag'), undefined);
    assert.deepEqual(replies(control.conn), [1]);

    const qualifiedCalls = [];
    f.env.daadmin.fetch = (url, opts) => {
      assert.equal(opts.redirect, 'manual');
      qualifiedCalls.push({ url, ...opts });
      const headers = {
        ETag: '"branch"', 'Content-Branch': 'pilot', 'X-da-actions': '/work/page.html=read,write',
      };
      return new Response(opts.method === 'HEAD' ? null : html('Branch control'), { headers });
    };
    const old = await f.connect(branch);
    assert.equal(old.conn.deserializeAttachment().docName, branch);
    assert.equal(old.conn.deserializeAttachment().boundMode, undefined);
    await old.room.webSocketMessage(old.conn, editMessage(old.doc, 'Ordinary qualified DA edit'));
    await flush(old.room, old.conn);
    assert.deepEqual(qualifiedCalls.map(({ url, method }) => [url, method]), [
      [branch, 'HEAD'], [branch, undefined], [branch, 'PUT'],
    ]);
    assert(qualifiedCalls.at(-1).body instanceof FormData);
    assert.equal(qualifiedCalls.at(-1).headers.get('If-Match'), '"branch"');
    assert.deepEqual(f.calls.filter(({ url }) => url === branch).map(({ method }) => method), ['HEAD']);
    const escaped = await f.connect(escapedLegacyBranch);
    assert.equal(escaped.conn.deserializeAttachment().docName, escapedLegacyBranch);
    assert.equal(escaped.conn.deserializeAttachment().boundMode, undefined);
  });

  for (const name of [percentDA, upperUnicodeDA]) {
    it(`keeps the exact DA-only room, requests and notices for ${new URL(name).pathname}`, async () => {
      const f = branchFixture();
      const legacyRequests = useLegacyBranchBackend(f);
      assert.equal((await f.open(name)).status, 400); // Marked: cannot join a safe H6 room.
      assert.equal(legacyRequests.length, 0);
      assert.equal(f.rooms.size, 0);

      Object.assign(f.source, { hint: null, instance: undefined, unavailable: 'true' });
      assert.equal((await f.open(name)).status, 503); // Marked, but gated off.
      assert.equal(legacyRequests.length, 0);
      f.source.unavailable = undefined;
      const old = await f.connect(name);
      assert.deepEqual([...f.rooms.keys()], [name]);
      assert.equal(old.conn.deserializeAttachment().docName, name);
      assert.equal(old.conn.deserializeAttachment().boundMode, undefined);
      await old.room.webSocketMessage(old.conn, editMessage(old.doc, 'DA-only name edit'));
      await flush(old.room, old.conn);
      assert.deepEqual(replies(old.conn), [1]);
      assert.deepEqual(legacyRequests.map((req) => [req.url, req.method, req.headers.get('Authorization')]), [
        [name, 'HEAD', token], [name, 'GET', token], [name, 'PUT', token],
      ]);
      const put = legacyRequests.at(-1);
      assert.equal(put.headers.get('If-Match'), '"legacy-branch"');
      const form = await put.formData();
      assert.match(await form.get('data').text(), /DA-only name edit/);
      assert.deepEqual(f.calls.map(({ url, method, headers }) => [url, method, headers.get('Authorization')]), [
        [name, 'HEAD', token], [name, 'HEAD', token], [name, 'HEAD', token],
      ]);

      assert.equal((await f.notify(name, 'deleteadmin')).status, 204);
      assert.equal(f.roomRequests.at(-1).name, name);
      assert.equal(old.conn.closeCode, 4412);
      assert.equal(f.calls.length, 3);
      assert.equal(legacyRequests.length, 3);
    });
  }

  it('uses legacy backend permissions, not the classifier or browser headers, for a fresh DA join', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined, legacyActions: 'read' });
    const legacyRequests = useLegacyBranchBackend(f);
    const opened = await f.connect(percentDA, token, { 'X-auth-actions': 'write' });
    assert.equal(opened.conn.readOnly, true);
    await opened.room.webSocketMessage(opened.conn, editMessage(opened.doc, 'Forbidden DA edit'));
    await flush(opened.room, opened.conn);
    assert.doesNotMatch(doc2aem(opened.doc), /Forbidden DA edit/);
    assert.deepEqual(legacyRequests.map((req) => req.method), ['HEAD', 'GET']);
  });

  it('does not follow credentials redirects from either HEAD for a DA-only branch', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined });
    const trustedFetch = f.env.dars.fetch;
    const redirected = [];
    const redirect = (url, opts) => {
      redirected.push(new Request(url, opts));
      return new Response(null, { status: 307, headers: { Location: 'https://off-origin.example/' } });
    };
    f.env.dars.fetch = redirect;
    assert.equal((await f.open(percentDA)).status, 503);
    f.env.dars.fetch = trustedFetch;
    f.env.daadmin.fetch = redirect;
    assert.equal((await f.open(percentDA)).status, 503);
    assert.deepEqual(redirected.map((req) => [req.url, req.redirect, req.headers.get('Authorization')]), [
      [percentDA, 'manual', token], [percentDA, 'manual', token],
    ]);
    assert.equal(f.rooms.size, 0);
  });

  it('replays a pre-H6 DA attachment only after an authorized trusted HEAD and DA restore', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined });
    const legacyRequests = useLegacyBranchBackend(f);
    const first = await f.connect(percentDA);
    // Pre-H6 attachments contain the DA room/session and grant, but no bound metadata.
    const attachment = first.conn.deserializeAttachment();
    assert.deepEqual(Object.keys(attachment).sort(), ['auth', 'authActions', 'docName', 'sourceSession']);
    const edit = editMessage(first.doc, 'Ordinary DA wake edit');
    evict(first.doc);
    const denied = socket(attachment);
    const room = new DocRoom(first.ctx, f.env);
    const trustedFetch = f.env.dars.fetch;
    delete f.env.dars;
    await room.webSocketMessage(denied, edit);
    assert.equal(denied.closeCode, 4412);
    assert.deepEqual(denied.sent, []);
    assert.equal(legacyRequests.length, 2);
    f.env.dars = { fetch: trustedFetch };

    const woken = socket(attachment);
    const head = f.hold('Head');
    const wake = room.webSocketMessage(woken, edit);
    await head.started.promise;
    assert.deepEqual(woken.sent, []);
    assert.equal(legacyRequests.length, 2);
    head.release.resolve();
    await wake;
    await flush(room, woken);
    assert.deepEqual(replies(woken), [1]);
    assert.equal(legacyRequests.at(-1).url, percentDA);
    assert.equal(legacyRequests.at(-1).headers.get('If-Match'), '"legacy-branch"');
    assert.deepEqual(f.calls.map(({ url, method, headers }) => [url, method, headers.get('Authorization')]), [
      [percentDA, 'HEAD', token], [percentDA, 'HEAD', token],
    ]);
  });

  it('rejects an obsolete DA wake without interrupting the last-close flush before PUT', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined });
    const legacyRequests = useLegacyBranchBackend(f);
    const { room, conn, doc } = await f.connect(draftDA);
    const stale = socket({
      ...conn.deserializeAttachment(), sourceSession: 'retired-session', auth: 'Bearer old-writer',
    });
    const staleUpdate = editMessage(doc, 'Obsolete wake edit');
    await room.webSocketMessage(conn, editMessage(doc, 'Last writer edit'));
    const save = doc.flushSave;
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    doc.flushSave = async (...args) => {
      started.resolve();
      await release.promise;
      return save(...args);
    };
    const closing = room.webSocketClose(conn);
    try {
      await started.promise;
      assert.equal(doc.conns.size, 0);
      await room.webSocketMessage(stale, staleUpdate);
      assert.equal(stale.closeCode, 4412);
      assert.deepEqual(stale.sent, []);
      assert.deepEqual(legacyRequests.map(({ method }) => method), ['HEAD', 'GET']);
      assert.equal(doc.isDestroyed, false, 'the closing writer still owns the room');
    } finally {
      release.resolve();
      await closing;
    }
    assert.deepEqual(legacyRequests.map(({ method }) => method), ['HEAD', 'GET', 'PUT']);
    const put = legacyRequests.at(-1);
    assert.equal(put.headers.get('If-Match'), '"legacy-branch"');
    assert.equal(put.headers.get('Authorization'), null);
    const form = await put.formData();
    const content = await form.get('data').text();
    assert.match(content, /Last writer edit/);
    assert.doesNotMatch(content, /Obsolete wake edit/);
    assert.equal(doc.isDestroyed, true);
  });

  for (const oldMarked of [true, false]) {
    it(`does not replay an old ${oldMarked ? 'H6' : 'DA'} attachment on a qualified mode change`, async () => {
      const f = branchFixture();
      const legacyRequests = useLegacyBranchBackend(f);
      if (!oldMarked) {
        Object.assign(f.source, { hint: null, instance: undefined });
      }
      const first = await f.connect(draftDA);
      const edit = editMessage(first.doc, 'Edit saved in a different Source mode');
      const woken = socket(first.conn.deserializeAttachment());
      evict(first.doc);
      Object.assign(f.source, oldMarked ? { hint: null, instance: undefined }
        : { hint: 'helix6', instance: firstInstance });
      const count = f.calls.length;
      const legacyCount = legacyRequests.length;
      await new DocRoom(first.ctx, f.env).webSocketMessage(woken, edit);
      assert.equal(woken.closeCode, 4412);
      assert.deepEqual(woken.sent, []);
      assert.equal(legacyRequests.length, legacyCount);
      assert.deepEqual(f.calls.slice(count).map(({ method }) => method), ['HEAD']);
      assert.equal(await first.ctx.storage.get('fencedSourceEtag'), null);
    });
  }

  it('does not replay an old DA attachment if its DA GET changes mode after the wake HEAD', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined });
    useLegacyBranchBackend(f);
    const first = await f.connect(draftDA);
    const edit = editMessage(first.doc, 'DA replay after marking');
    const stale = socket(first.conn.deserializeAttachment());
    evict(first.doc);
    f.env.daadmin.fetch = () => new Response(html('Now requires H6'), {
      headers: { 'X-DA-Source-Unavailable': 'true' },
    });
    await new DocRoom(first.ctx, f.env).webSocketMessage(stale, edit);
    assert.equal(stale.closeCode, 4412);
    assert.deepEqual(stale.sent, []);
    assert.deepEqual(f.calls.map(({ method }) => method), ['HEAD', 'HEAD']);
  });

  it('narrows a pre-H6 attachment to read-only when its authorized wake HEAD no longer grants write', async () => {
    const f = branchFixture();
    Object.assign(f.source, { hint: null, instance: undefined });
    const legacyRequests = useLegacyBranchBackend(f);
    const first = await f.connect(draftDA);
    const edit = editMessage(first.doc, 'Revoked DA write');
    const woken = socket(first.conn.deserializeAttachment());
    evict(first.doc);
    f.source.headActions = 'read';
    const room = new DocRoom(first.ctx, f.env);
    await room.webSocketMessage(woken, edit);
    await flush(room, woken);
    assert.equal(woken.readOnly, true);
    assert.equal(woken.readyState, 1);
    assert.deepEqual(legacyRequests.map((req) => req.method), ['HEAD', 'GET', 'GET']);
  });

  it('keeps the original 1011 initialization close for hosted DA and public Helix HTTP 412s', async () => {
    const f = fixture();
    const originalBind = persistence.bindState;
    try {
      persistence.bindState = async () => {
        throw Object.assign(new Error('Precondition failed'), { status: 412 });
      };
      const room = new DocRoom({}, f.env);
      const hostedDA = socket();
      const publicH6 = socket();
      await Promise.all([
        room.initSession(hostedDA, 'https://admin.da.live/source/demo/work~draft/page.html'),
        room.initSession(publicH6, 'https://api.aem.live/demo/sites/work/source/page.html'),
      ]);
      assert.equal(hostedDA.closeCode, 1011);
      assert.equal(publicH6.closeCode, 1011);
    } finally {
      persistence.bindState = originalBind;
    }
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

  it('authorizes both qualified aliases and uses the qualified DA key and exact raw H6 validators', async () => {
    const f = branchFixture();
    const writer = await f.connect(draftMixedDoc, token, {
      [BOUND_SOURCE_MODE]: 'legacy',
      [BOUND_SOURCE_INSTANCE]: nextInstance,
      [BOUND_SOURCE_ETAG]: '"forged"',
      'Content-Branch': 'sibling',
      'X-DA-Branch-Instance': nextInstance,
    });
    const readerToken = 'Bearer fixture-reader';
    const reader = await f.connect(draftH6, readerToken);
    assert.equal(reader.doc, writer.doc);
    assert.deepEqual([...f.rooms.keys()], [draftDA]);
    assert.deepEqual(f.calls.map(({ method, url, headers }) => [method, url, headers.get('Authorization')]), [
      ['HEAD', draftMixedDoc, token], ['GET', draftH6, token], ['HEAD', draftH6, readerToken],
    ]);
    assert.equal(reader.conn.readOnly, true);
    assert.equal(writer.conn.deserializeAttachment().sourceInstance, firstInstance);
    assert.equal(f.roomRequests[0].request.headers.get(BOUND_SOURCE_ETAG), '"draft-item:1"');
    assert.equal(f.roomRequests[0].request.headers.get('X-DA-Branch-Instance'), null);
    assert.equal(await writer.ctx.storage.get('fencedSourceInstance'), firstInstance);

    await reader.room.webSocketMessage(reader.conn, editMessage(writer.doc, 'Denied branch edit'));
    assert.doesNotMatch(doc2aem(writer.doc), /Denied branch edit/);
    await writer.room.webSocketMessage(writer.conn, editMessage(writer.doc, 'Qualified raw edit'));
    await flush(writer.room, writer.conn);
    assert.deepEqual(replies(writer.conn), [1]);
    const firstWrite = f.calls.at(-1);
    assert.equal(firstWrite.status, 201);
    assert.equal(firstWrite.url, draftH6);
    assert.equal(firstWrite.headers.get('If-Match'), '"draft-item:1"');
    assert.equal(firstWrite.headers.get('Content-Type'), 'text/html');
    assert.equal(firstWrite.headers.get('X-DA-Initiator'), 'collab');
    assert.equal(firstWrite.headers.get('Authorization'), token);
    assert.match(firstWrite.body, /Qualified raw edit/);

    await reader.room.webSocketClose(reader.conn);
    f.source.requireWriter = true;
    await writer.room.webSocketMessage(writer.conn, editMessage(writer.doc, 'Qualified final edit'));
    await writer.room.webSocketClose(writer.conn);
    assert.equal(f.calls.at(-1).headers.get('If-Match'), '"draft-item:2"');
    assert.equal(f.calls.at(-1).headers.get('Authorization'), token);
    assert.equal(await writer.ctx.storage.get('fencedSourceEtag'), '"draft-item:3"');
    assert.match(f.source.body, /Qualified final edit/);
  });

  it('rejects qualified routes with bad selectors and refuses gate-off downgrade on DA aliases', async () => {
    const f = branchFixture();
    f.source.hint = null;
    f.source.unavailable = 'true';
    let oldBackendCalls = 0;
    f.env.daadmin.fetch = () => {
      oldBackendCalls += 1;
      return new Response(null);
    };
    assert.equal((await f.open(draftDA)).status, 503);
    assert.equal((await f.open(draftMixed)).status, 503);
    assert.equal((await f.open(draftEscaped)).status, 503);
    assert.deepEqual(f.calls.map(({ url, method }) => [url, method]), [
      [draftDA, 'HEAD'], [draftMixed, 'HEAD'], [draftEscaped, 'HEAD'],
    ]);
    f.source.headStatus = 422;
    assert.equal((await f.open(draftH6)).status, 422);
    Object.assign(f.source, { unavailable: undefined, hint: 'helix6', headStatus: 200 });
    assert.equal((await f.open(draftEscaped)).status, 400);
    assert.equal((await f.open(draftMixed)).status, 400);
    const count = f.calls.length;
    assert.equal((await f.open(draftH6, token, {}, '&contentBranch=draft')).status, 422);
    assert.equal((await f.open(draftH6.replace('~draft', '~%64raft'))).status, 400);
    assert.equal((await f.open(draftDA.replace('/source/', '/api/source/'))).status, 400);
    assert.equal((await f.open(draftDA.replace('~draft', ';name=work~draft'))).status, 400);
    assert.equal(f.calls.length, count);
    assert.equal(oldBackendCalls, 0);
    assert.equal(f.rooms.size, 0);
  });

  for (const [header, value] of [
    ['Content-Branch', 'sibling'],
    ['Content-Branch', 'Draft'],
    ['Content-Branch', null],
    ['X-DA-Branch-Instance', 'revision-1'],
    ['X-DA-Branch-Instance', null],
    ['ETag', 'W/"draft-item:1"'],
    ['X-DA-Source-Mode', null],
    ['X-DA-Source-Mode', 'helix6, legacy'],
  ]) {
    it(`rejects qualified HEAD with ${header}: ${value} before room admission`, async () => {
      const f = branchFixture();
      f.source.headHeaders = { [header]: value };
      assert.equal((await f.open(draftDA)).status, 503);
      assert.equal(f.rooms.size, 0);
    });
  }

  for (const [header, value] of [
    ['Content-Branch', 'sibling'],
    ['X-DA-Branch-Instance', nextInstance],
    ['X-DA-Source-Mode', null],
    [SOURCE_CONTENT_PROFILE, null],
    [SOURCE_COLLABORATION, 'false'],
    ['ETag', '"draft-item:2"'],
    ['ETag', 'W/"draft-item:1"'],
  ]) {
    it(`rejects a qualified HEAD/GET race with GET ${header}: ${value}`, async () => {
      const f = branchFixture();
      f.source.getHeaders = { [header]: value };
      assert.equal((await f.open(draftDA)).status, 200);
      const { ctx } = f.rooms.get(draftDA);
      await Promise.all(ctx.pending);
      assert.equal(ctx.accepted[0].closeCode, 4412);
      assert.deepEqual(ctx.accepted[0].sent, []);
      assert.equal(await ctx.storage.get('docstore'), undefined);
      f.source.getHeaders = undefined;
      const fresh = await f.connect(draftH6);
      assert.equal(fresh.conn.readyState, 1);
      assert.equal(fresh.doc.etag, '"draft-item:1"');
    });
  }

  for (const [header, value] of [
    ['Content-Branch', 'sibling'],
    ['Content-Branch', null],
    ['X-DA-Branch-Instance', nextInstance],
    ['X-DA-Branch-Instance', null],
    ['X-DA-Source-Mode', null],
    ['X-DA-Source-Mode', 'legacy'],
    ['ETag', null],
    ['ETag', 'W/"draft-item:2"'],
    ['ETag', '"draft-item:1"'],
  ]) {
    it(`does not acknowledge a qualified 201 with PUT ${header}: ${value}`, async () => {
      const f = branchFixture();
      const {
        room, conn, doc, ctx,
      } = await f.connect(draftH6);
      f.source.putHeaders = { [header]: value };
      await room.webSocketMessage(conn, editMessage(doc, 'Unverifiable save'));
      await flush(room, conn);
      assert.equal(f.calls.at(-1).status, 201);
      assert.equal(f.calls.at(-1).headers.get('If-Match'), '"draft-item:1"');
      assert.deepEqual(replies(conn), [0]);
      assert.equal(conn.closeCode, 4412);
      assert.equal(await ctx.storage.get('fencedSourceEtag'), null);
      assert.equal(await ctx.storage.get('fencedSourceInstance'), undefined);
      assert.equal(await ctx.storage.get('docstore'), undefined);
    });
  }

  it('never follows a qualified credential redirect after authorized HEAD', async () => {
    const f = branchFixture();
    const first = await f.connect(draftDA);
    const requests = [];
    f.env.dars.fetch = (url, opts) => {
      requests.push(new Request(url, opts));
      return new Response(null, { status: 307, headers: { Location: 'https://off-origin.example/' } });
    };
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Redirected write'));
    await flush(first.room, first.conn);
    assert.deepEqual(requests.map((r) => [r.method, r.url, r.redirect, r.headers.get('Authorization')]), [
      ['PUT', draftH6, 'manual', token],
    ]);
    assert.deepEqual(replies(first.conn), [0]);
    await f.notify(draftDA);
  });

  it('verifies HEAD and GET before replaying a qualified woken socket', async () => {
    const f = branchFixture();
    const first = await f.connect(draftDA);
    // Mocha simulates eviction: a new DocRoom and WebSocket wrapper use the
    // saved storage and serialized attachment, without an in-memory Y.Doc.
    // This calls production webSocketMessage, not a Workerd hibernation cycle.
    const woken = socket(first.conn.deserializeAttachment());
    const edit = editMessage(first.doc, 'Qualified edit after wake');
    evict(first.doc);
    const wakingRoom = new DocRoom(first.ctx, f.env);
    const head = f.hold('Head');
    const get = f.hold('Get');
    const waking = wakingRoom.webSocketMessage(woken, edit);
    await head.started.promise;
    assert.deepEqual(woken.sent, []);
    assert.deepEqual(f.calls.slice(2).map(({ method }) => method), ['HEAD']);
    head.release.resolve();
    await get.started.promise;
    assert.deepEqual(woken.sent, []);
    get.release.resolve();
    await waking;
    assert.deepEqual(f.calls.slice(2).map(({ method, url }) => [method, url]), [
      ['HEAD', draftDA], ['GET', draftH6],
    ]);
    await flush(wakingRoom, woken);
    assert.deepEqual(replies(woken), [1]);
    assert.match(f.source.body, /Qualified edit after wake/);
  });

  for (const stale of ['instance', 'etag']) {
    it(`retires qualified snapshot and attachments on changed ${stale} without replay`, async () => {
      const f = branchFixture();
      const first = await f.connect(draftH6);
      const attachment = first.conn.deserializeAttachment();
      const oldUpdate = editMessage(first.doc, 'Replay from the stale room');
      evict(first.doc);
      // For the instance case deliberately keep the ETag equal, so this test
      // proves the incarnation check rather than relying on unique server tags.
      if (stale === 'instance') {
        f.source.instance = nextInstance;
      } else {
        f.source.etag = '"draft-external:2"';
      }
      f.source.body = html('Current qualified baseline');
      const wakingRoom = new DocRoom(first.ctx, f.env);
      const cold = socket(attachment);
      await wakingRoom.webSocketMessage(cold, oldUpdate);
      assert.equal(cold.closeCode, 4412);
      assert.deepEqual(cold.sent, []);

      const callsBeforeFresh = f.calls.length;
      f.rooms.get(draftDA).room = wakingRoom;
      const fresh = await f.connect(draftDA);
      assert.deepEqual(f.calls.slice(callsBeforeFresh).map(({ method }) => method), ['HEAD', 'GET']);
      const warm = socket(attachment);
      await wakingRoom.webSocketMessage(warm, oldUpdate);
      assert.equal(warm.closeCode, 4412);
      assert.deepEqual(warm.sent, []);
      assert.notEqual(fresh.conn.deserializeAttachment().sourceSession, attachment.sourceSession);
      assert.equal(await fresh.ctx.storage.get('fencedSourceInstance'), f.source.instance);
      assert.match(doc2aem(fresh.doc), /Current qualified baseline/);
      assert.doesNotMatch(doc2aem(fresh.doc), /Replay from the stale room/);
      assert(f.calls.every(({ method }) => method !== 'PUT'));
    });
  }

  it('keeps a fresh qualified join while rejecting a concurrent stale wake on the same load', async () => {
    const f = branchFixture();
    const first = await f.connect(draftH6);
    const stale = socket(first.conn.deserializeAttachment());
    const edit = editMessage(first.doc, 'Stale concurrent replay');
    evict(first.doc);
    Object.assign(f.source, { etag: '"external:2"', body: html('Current branch bytes') });
    const hold = f.hold('Get');
    const wake = new DocRoom(first.ctx, f.env).webSocketMessage(stale, edit);
    await hold.started.promise;
    assert.equal((await f.open(draftDA)).status, 200);
    const conn = first.ctx.accepted.at(-1);
    const joining = first.ctx.pending.at(-1);
    hold.release.resolve();
    await Promise.all([wake, joining]);
    assert.equal(stale.closeCode, 4412);
    assert.deepEqual(stale.sent, []);
    assert.equal(conn.readyState, 1);
    const doc = await getYDoc(draftDA, conn, f.env, first.ctx.storage, undefined, first.ctx);
    assert.match(doc2aem(doc), /Current branch bytes/);
    assert.doesNotMatch(doc2aem(doc), /Stale concurrent replay/);
    assert.equal(f.calls.filter(({ method }) => method === 'GET').length, 2);
  });

  it('retires a gated-off wake session even if an unchanged baseline becomes available again', async () => {
    const f = branchFixture();
    const first = await f.connect(draftH6);
    const attachment = first.conn.deserializeAttachment();
    const edit = editMessage(first.doc, 'Old session after reenable');
    evict(first.doc);
    f.source.unavailable = 'true';
    f.source.hint = null;
    const count = f.calls.length;
    const denied = socket(attachment);
    await first.room.webSocketMessage(denied, edit);
    assert.deepEqual(f.calls.slice(count).map(({ method }) => method), ['HEAD']);
    assert.equal(denied.closeCode, 4412);
    assert.deepEqual(denied.sent, []);
    assert.equal(await first.ctx.storage.get('fencedSourceEtag'), null);
    assert.equal(await first.ctx.storage.get('fencedSourceInstance'), undefined);

    f.source.hint = 'helix6';
    f.source.unavailable = undefined;
    const fresh = await f.connect(draftDA);
    const stale = socket(attachment);
    await first.room.webSocketMessage(stale, edit);
    assert.equal(stale.closeCode, 4412);
    assert.deepEqual(stale.sent, []);
    assert.doesNotMatch(doc2aem(fresh.doc), /Old session after reenable/);
  });

  it('reloads an active qualified room when the H6 PUT is refused after gate disable', async () => {
    const f = branchFixture();
    const first = await f.connect(draftDA);
    f.source.hint = null;
    f.source.unavailable = 'true';
    f.source.putStatus = 422;
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Edit after gate disable'));
    await flush(first.room, first.conn);
    assert.equal(f.calls.at(-1).url, draftH6);
    assert.equal(f.calls.at(-1).status, 422);
    assert.deepEqual(replies(first.conn), [0]);
    assert.equal(first.conn.closeCode, 4412);
    assert.equal(await first.ctx.storage.get('fencedSourceInstance'), undefined);
    assert.doesNotMatch(f.source.body, /Edit after gate disable/);
  });

  it('keeps a sync conflict retryable, but reloads on a 409 Source mode mismatch', async () => {
    const f = branchFixture();
    const first = await f.connect(draftDA);
    f.source.putStatus = 409;
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Edit during active sync'));
    await flush(first.room, first.conn);
    assert.equal(first.conn.readyState, 1);
    assert.deepEqual(replies(first.conn), [0]);
    assert.equal(await first.ctx.storage.get('fencedSourceInstance'), firstInstance);

    f.source.putError = 'SOURCE_MODE_MISMATCH';
    await flush(first.room, first.conn);
    assert.equal(first.conn.closeCode, 4412);
    assert.deepEqual(replies(first.conn), [0, 0]);
    assert.equal(await first.ctx.storage.get('fencedSourceInstance'), undefined);
  });

  it('deletes a hibernating qualified room without HEAD and never replays its attachment', async () => {
    const f = branchFixture();
    const first = await f.connect(draftH6);
    const attachment = first.conn.deserializeAttachment();
    const edit = editMessage(first.doc, 'Old deleted room state');
    evict(first.doc);
    f.source.headStatus = 404;
    const count = f.calls.length;
    assert.equal((await f.notify(draftDA, 'deleteadmin')).status, 204);
    assert.equal(first.conn.closeCode, 4412);
    assert.equal(await first.ctx.storage.get('fencedSourceInstance'), undefined);
    assert.equal(f.calls.length, count);
    const woken = socket(attachment);
    await first.room.webSocketMessage(woken, edit);
    assert.equal(woken.closeCode, 4412);
    assert.deepEqual(woken.sent, []);
    assert.deepEqual(f.calls.slice(count).map(({ method }) => method), ['HEAD']);
  });

  it('does not let a late admission HEAD retire a room that already saved a new validator', async () => {
    const f = branchFixture();
    const first = await f.connect(draftH6);
    const hold = f.hold('Head');
    const joining = f.open(draftDA);
    await hold.started.promise;
    await first.room.webSocketMessage(first.conn, editMessage(first.doc, 'Newer room save'));
    await flush(first.room, first.conn);
    hold.release.resolve();
    assert.equal((await joining).status, 200);
    await Promise.all(first.ctx.pending);
    assert.equal(first.ctx.accepted.at(-1).closeCode, 4412);
    assert.equal(first.conn.readyState, 1);
    const retry = await f.connect(draftDA);
    assert.equal(retry.doc, first.doc);
    assert.equal(first.doc.etag, '"draft-item:2"');
  });

  it('coalesces canonical notices, isolates other rooms, and fences a late PUT across branch reuse', async () => {
    const f = branchFixture();
    const first = await f.connect(draftH6);
    const draft = await f.connect(draftDA);
    const main = await f.connect(h6);
    const sibling = await f.connect(siblingH6);
    const hold = f.hold('Put');
    await draft.room.webSocketMessage(draft.conn, editMessage(draft.doc, 'Stale branch save'));
    const saving = flush(draft.room, draft.conn);
    await hold.started.promise;
    const oldPut = f.calls.at(-1);
    const count = f.calls.length;
    f.source.headStatus = 404;
    const notices = await Promise.all([f.notify(draftDA, 'deleteadmin'), f.notify(draftDA)]);
    assert.deepEqual(notices.map(({ status }) => status), [204, 200]);
    assert.equal(f.calls.length, count);
    assert.equal(f.roomRequests.at(-1).name, draftDA);
    assert.equal(draft.conn.closeCode, 4412);
    assert.equal(first.conn.closeCode, 4412);
    assert.equal(main.conn.readyState, 1);
    assert.equal(sibling.conn.readyState, 1);

    Object.assign(f.source, {
      headStatus: 200, instance: nextInstance, etag: '"recreated:1"', body: html('Recreated branch'),
    });
    const retry = await f.connect(draftH6);
    hold.release.resolve();
    await saving;
    assert.equal(oldPut.status, 412);
    assert.deepEqual(replies(draft.conn), [0]);
    assert.equal(retry.conn.readyState, 1);
    assert.match(doc2aem(retry.doc), /Recreated branch/);
    await retry.room.webSocketMessage(retry.conn, editMessage(retry.doc, 'Recreated branch edit'));
    await flush(retry.room, retry.conn);
    assert.equal(f.calls.at(-1).headers.get('If-Match'), '"recreated:1"');
    assert.deepEqual(replies(retry.conn), [1]);
    assert.match(f.source.body, /Recreated branch edit/);
    assert.equal(await main.ctx.storage.get('fencedSourceEtag'), '"default-item:1"');
    assert.equal(await sibling.ctx.storage.get('fencedSourceEtag'), '"sibling-item:1"');
  });
});
