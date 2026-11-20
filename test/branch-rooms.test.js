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
import * as encoding from 'lib0/encoding.js';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import { aem2doc, doc2aem } from '@adobe/da-parser';
import edge, { DocRoom } from '../src/edge.js';
import { getYDoc, invalidateFromAdmin } from '../src/shareddoc.js';

const origin = 'https://admin.da.live/source/roomtest';
const main = `${origin}/site/page.html`;
const branch = `${origin}/site~b/page.html`;
const other = `${origin}/site~c/page.html`;
const legacy = `${origin}/legacy/page.html`;
const html = (text) => `\n<body>\n  <header></header>\n  <main><div><p>${text}</p></div></main>\n  <footer></footer>\n</body>\n`;

function storage() {
  const data = new Map();
  return {
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
    deleteAll: async () => data.clear(),
  };
}

function socket() {
  let attachment;
  return {
    readyState: 1,
    sent: [],
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); },
    send(value) { this.sent.push(value); },
    close(code, reason) {
      this.readyState = 3;
      this.closeCode = code;
      this.closeReason = reason;
    },
  };
}

function makeHarness() {
  const entries = new Map([
    [main, { body: html('Main initial'), etag: '"main-1"', branch: 'main' }],
    [branch, { body: html('Branch b initial'), etag: '"b-1"', branch: 'b' }],
    [other, { body: html('Branch c initial'), etag: '"c-1"', branch: 'c' }],
    [legacy, { body: html('Legacy initial'), etag: '"legacy-1"' }],
  ]);
  const writes = [];
  const rooms = new Map();
  let delay;
  const env = {
    daadmin: {
      async fetch(url, opts = {}) {
        const entry = entries.get(String(url));
        assert(entry, `Unexpected Source URL ${url}`);
        if (opts.method === 'HEAD') {
          return new Response(null, { headers: { 'X-da-actions': 'actions=read,write' } });
        }
        if (opts.method !== 'PUT') {
          const headers = { ETag: entry.etag };
          if (entry.branch) {
            headers['Content-Branch'] = entry.branch;
          }
          return new Response(entry.body, { headers });
        }
        const write = { url: String(url), match: opts.headers.get('If-Match'), body: await opts.body.get('data').text() };
        writes.push(write);
        if (delay) {
          const current = delay;
          delay = undefined;
          current.started.resolve();
          await current.release.promise;
        }
        if (write.match !== '*' && write.match !== entry.etag) {
          write.status = 412;
          return new Response(null, { status: 412 });
        }
        entry.body = write.body;
        entry.etag = `"saved-${writes.length}"`;
        write.status = 200;
        return new Response(null, { headers: { ETag: entry.etag } });
      },
    },
  };
  env.rooms = {
    idFromName: (name) => name,
    get(name) {
      if (!rooms.has(name)) {
        const ctx = {
          storage: storage(),
          accepted: [],
          pending: [],
          acceptWebSocket(ws) { this.accepted.push(ws); },
          waitUntil(promise) { this.pending.push(promise); },
        };
        const room = new DocRoom(ctx, env);
        rooms.set(name, { room, ctx });
      }
      const { room } = rooms.get(name);
      return { fetch: (request) => room.fetch(request, undefined, 200) };
    },
  };
  return {
    entries,
    writes,
    rooms,
    env,
    delayNextWrite() {
      delay = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      return delay;
    },
    async connect(name) {
      const response = await edge.fetch(new Request(`https://collab.example/${name}?Authorization=Bearer%20test`, {
        headers: { Upgrade: 'websocket' },
      }), env);
      assert.equal(response.status, 200);
      const { room, ctx } = rooms.get(name);
      const conn = ctx.accepted.at(-1);
      await ctx.pending[ctx.pending.length - 1];
      const doc = await getYDoc(name, conn, env, ctx.storage, undefined, ctx);
      return {
        room, ctx, conn, doc,
      };
    },
    async invalidate(name) {
      const url = new URL('https://collab.example/api/v1/syncadmin');
      url.searchParams.set('doc', name);
      return edge.fetch(new Request(url, { method: 'POST' }), env);
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
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client));
  client.destroy();
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(clientId, name) {
  const client = new Y.Doc();
  client.clientID = clientId;
  const awareness = new awarenessProtocol.Awareness(client);
  awareness.setLocalState({ user: { name } });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]);
  encoding.writeVarUint8Array(encoder, update);
  const message = encoding.toUint8Array(encoder);
  awareness.destroy();
  client.destroy();
  return message;
}

describe('branch rooms through Worker and DocRoom', () => {
  let originalPair;
  beforeEach(() => {
    originalPair = DocRoom.newWebSocketPair;
    DocRoom.newWebSocketPair = () => [{}, socket()];
  });
  afterEach(async () => {
    DocRoom.newWebSocketPair = originalPair;
    await Promise.all([main, branch, other, legacy].map((name) => invalidateFromAdmin(name, true)));
  });

  it('isolates main and two branches in room state, awareness, and Source writes', async () => {
    const h = makeHarness();
    const a = await h.connect(main);
    const b = await h.connect(branch);
    const c = await h.connect(other);
    const b2 = await h.connect(branch);
    assert.equal(h.rooms.size, 3);
    assert.notEqual(a.doc, b.doc);
    assert.notEqual(b.doc, c.doc);
    assert.equal(b.doc, b2.doc);
    assert.deepEqual(
      [a.conn, b.conn, c.conn].map((conn) => conn.deserializeAttachment().docName),
      [main, branch, other],
    );

    await b.room.webSocketMessage(b.conn, awarenessMessage(32101, 'editor b'));
    await c.room.webSocketMessage(c.conn, awarenessMessage(32102, 'editor c'));
    assert.equal(b.doc.awareness.getStates().get(32101).user.name, 'editor b');
    assert.equal(c.doc.awareness.getStates().get(32102).user.name, 'editor c');
    assert(!a.doc.awareness.getStates().has(32101));
    assert(!c.doc.awareness.getStates().has(32101));
    assert(!b.doc.awareness.getStates().has(32102));

    await a.room.webSocketMessage(a.conn, editMessage(a.doc, 'Only main changed'));
    await b.room.webSocketMessage(b.conn, editMessage(b.doc, 'Only branch b changed'));
    await c.room.webSocketMessage(c.conn, editMessage(c.doc, 'Only branch c changed'));
    await Promise.all([a.doc.flushSave(), b.doc.flushSave(), c.doc.flushSave()]);
    assert.match(doc2aem(b.doc), /Only branch b changed/);
    assert.match(doc2aem(c.doc), /Only branch c changed/);
    assert.match(doc2aem(a.doc), /Only main changed/);
    assert.match(h.entries.get(branch).body, /Only branch b changed/);
    assert.match(h.entries.get(other).body, /Only branch c changed/);
    assert.match(h.entries.get(main).body, /Only main changed/);
    assert.doesNotMatch(h.entries.get(branch).body, /Only branch c changed|Only main changed/);
    assert.doesNotMatch(h.entries.get(other).body, /Only branch b changed|Only main changed/);
    assert.deepEqual(h.writes.map(({ url, match }) => [url, match]).sort(), [
      [main, '"main-1"'], [branch, '"b-1"'], [other, '"c-1"'],
    ].sort());

    const response = await h.invalidate(branch);
    assert.equal(response.status, 200);
    assert.equal(b.conn.closeCode, 4412);
    assert.equal(b2.conn.closeCode, 4412);
    assert.equal(b.conn.closeReason, 'reload required');
    assert.match(b.doc.getMap('error').get('message'), /invalidated; reload/);
    assert.equal(a.conn.readyState, 1);
    assert.equal(c.conn.readyState, 1);
    assert.match(doc2aem(c.doc), /Only branch c changed/);
  });

  it('rejects a delayed pre-publish PUT after invalidation and reloads the published bytes', async () => {
    const h = makeHarness();
    const a = await h.connect(main);
    const b = await h.connect(branch);
    await a.room.webSocketMessage(a.conn, editMessage(a.doc, 'Old delayed edit'));
    const delay = h.delayNextWrite();
    const saving = a.doc.flushSave();
    await delay.started.promise;
    h.entries.get(main).body = html('Published content');
    h.entries.get(main).etag = '"published"';
    const response = await h.invalidate(main);
    assert.equal(response.status, 200);
    assert.equal(a.conn.closeCode, 4412);
    assert.equal(b.conn.readyState, 1);
    delay.release.resolve();
    await assert.rejects(saving);
    assert.equal(h.writes[0].match, '"main-1"');
    assert.equal(h.writes[0].status, 412);
    assert.equal(h.entries.get(main).body, html('Published content'));

    const reloaded = await h.connect(main);
    assert.notEqual(reloaded.doc, a.doc);
    assert.match(doc2aem(reloaded.doc), /Published content/);
    assert.doesNotMatch(doc2aem(reloaded.doc), /Old delayed edit/);
    await reloaded.doc.flushSave();
    assert.equal(h.entries.get(main).body, html('Published content'));
    assert.equal(h.writes.length, 1);
  });

  it('keeps wildcard writes and legacy close behavior when an ETag alone is present', async () => {
    const h = makeHarness();
    const room = await h.connect(legacy);
    await Promise.all(room.ctx.pending); // Wait for legacy delayed Source restoration.
    await room.room.webSocketMessage(room.conn, editMessage(room.doc, 'Legacy edit'));
    await room.doc.flushSave();
    assert.equal(h.writes[0].match, '*');
    assert.match(h.entries.get(legacy).body, /Legacy edit/);
    assert.equal((await h.invalidate(legacy)).status, 200);
    assert.notEqual(room.conn.closeCode, 4412);
  });
});
