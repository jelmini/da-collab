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
import * as decoding from 'lib0/decoding.js';
import * as encoding from 'lib0/encoding.js';
import * as syncProtocol from 'y-protocols/sync.js';
import * as Y from 'yjs';
import { aem2doc, doc2aem } from '@adobe/da-parser';
import edge, { DocRoom } from '../src/edge.js';
import {
  closeConn, getYDoc, handleWebSocketMessage, invalidateFromAdmin, messageFlushRequest,
  messageFlushResponse, messageListener, setYDoc, storeState,
} from '../src/shareddoc.js';

const bare = 'https://admin.da.live/source/org/site/fence.html';
const qualified = bare.replace('/site/', '/site~pilot/');
const original = '\n<body>\n  <header></header>\n'
  + '  <main><div><p>Initial Source content for editing</p></div></main>\n  <footer></footer>\n</body>\n';
const flushMessage = Uint8Array.of(messageFlushRequest);
const fencedBaseline = 'fencedSourceEtag';

function makeStorage() {
  const data = new Map();
  return {
    get: async (key) => (Array.isArray(key) ? new Map(key.map((k) => [k, data.get(k)]))
      : data.get(key)),
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

function makeConn() {
  const acks = [];
  return {
    acks,
    auth: 'Bearer test',
    readyState: 1,
    close(code, reason) {
      this.readyState = 3;
      this.closeCode = code;
      this.closeReason = reason;
    },
    send(bytes) {
      assert.equal(this.readyState, 1);
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) === messageFlushResponse) {
        acks.push(decoding.readVarUint(decoder));
        if (acks.at(-1) === 0) {
          this.flushError = decoding.readVarString(decoder);
        }
      }
    },
  };
}

function makeSource(initialEtag, storage = makeStorage()) {
  const source = {
    etag: initialEtag, content: original, writes: [], reads: [], put: undefined, storage,
  };
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      const request = {
        url,
        headers: opts.headers,
        content: await opts.body.get('data').text(),
      };
      source.writes.push(request);
      return source.put(request);
    }
    source.reads.push(url);
    const headers = new Headers();
    if (source.etag) {
      headers.set('ETag', source.etag);
    }
    if (source.contentBranch) {
      headers.set('Content-Branch', source.contentBranch);
    }
    return new Response(source.content, { headers });
  };
  source.env = { daadmin: { fetch } };
  source.join = async (name = qualified, conn = makeConn()) => {
    const doc = await getYDoc(name, conn, source.env, storage);
    return { doc, conn };
  };
  return source;
}

function edit(doc, text) {
  doc.hasClientChanged = true;
  doc.transact(() => {
    const fragment = doc.getXmlFragment('prosemirror');
    fragment.delete(0, fragment.length);
    aem2doc(`<main><div><p>${text}</p></div></main>`, doc);
  });
}

function replay(doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0); // messageSync
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(encoder);
}

function makeHibernatingConn(docName, attachment = {}) {
  const conn = makeConn();
  let stored = {
    docName, auth: conn.auth, authActions: 'read,write', ...attachment,
  };
  const sent = [];
  return {
    ...conn,
    sent,
    deserializeAttachment: () => structuredClone(stored),
    serializeAttachment(data) { stored = structuredClone(data); },
    send(bytes) {
      sent.push(bytes);
      conn.send.call(this, bytes);
    },
  };
}

function evictRoom(doc) {
  const rooms = setYDoc(doc.name, doc);
  rooms.delete(doc.name);
  doc.conns.clear();
  doc.destroy();
}

function browserEdit(doc, text) {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  edit(client, text);
  const message = replay(client);
  client.destroy();
  return message;
}

describe('Source persistence fencing', () => {
  afterEach(async () => {
    await Promise.all([invalidateFromAdmin(qualified, true), invalidateFromAdmin(bare, true)]);
  });

  for (const freshFirst of [false, true]) {
    it(`rejects both stale woken sockets before sync (${freshFirst ? 'fresh' : 'old'} starts GET)`, async () => {
      const name = freshFirst ? bare : qualified;
      const source = makeSource('"E1"');
      if (freshFirst) {
        source.contentBranch = 'main';
      }
      const room = new DocRoom({ storage: source.storage }, source.env);
      const originalA = makeHibernatingConn(name);
      const originalB = makeHibernatingConn(name);
      await Promise.all([
        room.initSession(originalA, name), room.initSession(originalB, name),
      ]);
      const { doc } = await source.join(name, originalA);
      const attachmentA = originalA.deserializeAttachment();
      const attachmentB = originalB.deserializeAttachment();
      assert.equal(attachmentA.sourceSession, attachmentB.sourceSession);
      assert(attachmentA.sourceSession);
      assert.equal(attachmentA.docName, name);
      assert.equal(attachmentA.auth, originalA.auth);
      assert.equal(attachmentA.authActions, 'read,write');
      const staleEdit = browserEdit(doc, 'Stale browser update must not be applied');
      evictRoom(doc);

      source.etag = '"E2"';
      source.content = original.replace('Initial Source content for editing', 'Changed during sleep');
      const invalidated = await room.fetch(new Request(`${name}?api=syncAdmin`));
      assert.equal(invalidated.status, 404);
      const wakeA = makeHibernatingConn(name, attachmentA);
      const wakeB = makeHibernatingConn(name, attachmentB);
      const fresh = makeHibernatingConn(name);
      const reading = Promise.withResolvers();
      const release = Promise.withResolvers();
      const { fetch } = source.env.daadmin;
      source.env.daadmin.fetch = async (...args) => {
        reading.resolve();
        await release.promise;
        return fetch(...args);
      };
      const first = freshFirst ? room.initSession(fresh, name)
        : room.webSocketMessage(wakeA, staleEdit);
      await reading.promise;
      const second = freshFirst ? room.webSocketMessage(wakeA, staleEdit)
        : room.initSession(fresh, name);
      const third = freshFirst ? undefined : room.webSocketMessage(wakeB, staleEdit);
      release.resolve();
      await Promise.all([first, second, third]);
      if (freshFirst) {
        await room.webSocketMessage(wakeB, staleEdit); // Also test arrival after the new sync.
      }

      assert.deepEqual([wakeA.closeCode, wakeB.closeCode], [4412, 4412]);
      assert.deepEqual([wakeA.sent, wakeB.sent], [[], []]);
      assert.equal(fresh.readyState, 1);
      assert(fresh.sent.length > 0);
      const { doc: replacement } = await source.join(name, fresh);
      assert(!replacement.conns.has(wakeA) && !replacement.conns.has(wakeB));
      assert.notEqual(fresh.deserializeAttachment().sourceSession, attachmentA.sourceSession);
      assert.equal(doc2aem(replacement), source.content);
      assert.deepEqual(source.writes, []);

      source.put = () => new Response(null, { headers: { ETag: '"E3"' } });
      await room.webSocketMessage(fresh, browserEdit(replacement, 'Fresh editor update'));
      await room.webSocketMessage(fresh, flushMessage);
      assert.deepEqual(fresh.acks, [1]);
      assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['"E2"']);
    });
  }

  it('resumes a verified fenced snapshot after its validator advanced within the same session', async () => {
    const source = makeSource('"E1"');
    const room = new DocRoom({ storage: source.storage }, source.env);
    const conn = makeHibernatingConn(qualified);
    await room.initSession(conn, qualified);
    const { doc } = await source.join(qualified, conn);
    const attachment = conn.deserializeAttachment();
    assert(attachment.sourceSession);
    source.put = ({ content }) => {
      source.content = content;
      source.etag = source.etag === '"E1"' ? '"E2"' : '"E3"';
      return new Response(null, { headers: { ETag: source.etag } });
    };
    await room.webSocketMessage(conn, browserEdit(doc, 'Change saved before sleep'));
    await room.webSocketMessage(conn, flushMessage);
    const nextEdit = browserEdit(doc, 'Change from resumed editor');
    evictRoom(doc);

    const resumed = makeHibernatingConn(qualified, attachment);
    await room.webSocketMessage(resumed, nextEdit);
    await room.webSocketMessage(resumed, flushMessage);
    assert.equal(resumed.readyState, 1);
    assert.deepEqual(resumed.acks, [1]);
    assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['"E1"', '"E2"']);
    assert.match(source.content, /Change from resumed editor/);
    assert.equal(await source.storage.get('fencedSourceSession'), attachment.sourceSession);

    const unproven = makeHibernatingConn(qualified); // Same ETag does not prove socket continuity.
    await room.webSocketMessage(unproven, nextEdit);
    assert.equal(unproven.closeCode, 4412);
    assert.deepEqual(unproven.sent, []);
  });

  it('resumes an ordinary legacy woken socket without a session identity', async () => {
    const source = makeSource('"legacy"');
    const stored = new Y.Doc();
    aem2doc(original, stored);
    await storeState(bare, Y.encodeStateAsUpdate(stored), source.storage);
    await source.storage.put('lastsync', original);
    const message = browserEdit(stored, 'Legacy editor woke up');
    stored.destroy();
    source.put = () => new Response(null, { headers: { ETag: '"legacy-saved"' } });

    const room = new DocRoom({ storage: source.storage }, source.env);
    const woken = makeHibernatingConn(bare);
    await room.webSocketMessage(woken, message);
    await room.webSocketMessage(woken, flushMessage);
    assert.equal(woken.readyState, 1);
    assert.deepEqual(woken.acks, [1]);
    assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['*']);
    assert.equal(woken.deserializeAttachment().sourceSession, undefined);
  });

  it('uses a fallback marker lookup only for an unclassified legacy join', async () => {
    const source = makeSource('"legacy"');
    const { storage } = source;
    const stored = new Y.Doc();
    aem2doc(original, stored);
    await storeState(bare, Y.encodeStateAsUpdate(stored), storage);
    await storage.put('lastsync', original);
    stored.destroy();
    const { get } = storage;
    storage.get = async (key) => {
      if (key === fencedBaseline) {
        throw new Error('marker get unavailable');
      }
      return get(key);
    };
    const lists = [];
    storage.list = async (options) => {
      lists.push(options);
      return new Map();
    };
    const { doc } = await source.join(bare);
    edit(doc, 'Legacy remains writable');
    source.put = () => new Response(null);
    await doc.flushSave();
    assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['*']);

    await assert.rejects(() => source.join(qualified), /marker get unavailable/);
    assert.deepEqual(lists, [{ prefix: fencedBaseline, limit: 1 }]);
  });

  it('uses the exact validator from GET and then each successful PUT', async () => {
    const source = makeSource('W/"loaded"');
    const { doc } = await source.join();
    source.put = ({ content }) => {
      source.content = content;
      source.etag = `W/"saved-${source.writes.length}"`;
      return new Response(null, { headers: { ETag: source.etag } });
    };
    edit(doc, 'First local edit');
    await doc.flushSave();
    edit(doc, 'Next local edit');
    await doc.flushSave();

    assert.deepEqual(source.reads, [qualified]);
    assert.deepEqual(source.writes.map(({ url, headers }) => [url, headers.get('If-Match')]), [
      [qualified, 'W/"loaded"'], [qualified, 'W/"saved-1"'],
    ]);
    assert.equal(doc.etag, 'W/"saved-2"');
    assert.equal(await source.storage.get(fencedBaseline), 'W/"saved-2"');
  });

  for (const legacyEtag of [null, '"legacy"']) {
    it(`keeps legacy recovery and wildcard PUT with ETag ${legacyEtag}`, async () => {
      const source = makeSource(legacyEtag);
      const { storage } = source;
      const stored = new Y.Doc();
      edit(stored, 'Pending legacy state from an untagged snapshot');
      await storeState(bare, Y.encodeStateAsUpdate(stored), storage);
      await storage.put('lastsync', original);
      stored.destroy();
      source.put = () => new Response(null, {
        headers: legacyEtag ? { ETag: '"legacy-saved"' } : {},
      });
      const { doc, conn } = await source.join(bare);
      assert.match(doc2aem(doc), /Pending legacy state from an untagged snapshot/);
      await messageListener(conn, doc, flushMessage);

      assert.deepEqual(conn.acks, [1]);
      assert.equal(source.writes.length, 1);
      const [{ url, headers, content }] = source.writes;
      assert.equal(url, bare);
      assert.equal(headers.get('If-Match'), '*');
      assert.equal(headers.get('X-DA-Initiator'), 'collab');
      assert.equal(headers.get('Content-Type'), null);
      assert.equal(await storage.get('lastsync'), content);
      assert.equal(await storage.get(fencedBaseline), undefined);

      edit(doc, 'Legacy edit flushed on admin invalidation');
      assert.equal(await invalidateFromAdmin(bare), true);
      assert.equal(source.writes.length, 2);
      assert.equal(source.writes[1].headers.get('If-Match'), '*');
      assert.equal(conn.readyState, 3);
      assert.equal(conn.closeCode, undefined);
    });
  }

  for (const [label, name] of [['qualified branch', qualified], ['bare main', bare]]) {
    it(`does not use a wildcard when a ${label} GET omits its ETag`, async () => {
      const source = makeSource(null);
      if (name === bare) {
        source.contentBranch = 'main';
      }
      const { doc, conn } = await source.join(name);
      edit(doc, 'Must not be sent');
      await messageListener(conn, doc, flushMessage);
      assert.deepEqual(conn.acks, [0]);
      assert.match(conn.flushError, /without a verified ETag/);
      assert.deepEqual(source.writes, []);
      assert.equal(await source.storage.get('docstore'), undefined);
    });
  }

  it('never downgrades a fenced bare room when a successful PUT and the following GET omit ETags', async () => {
    const source = makeSource('"loaded"');
    source.contentBranch = 'main';
    source.put = ({ content }) => {
      source.etag = null;
      source.contentBranch = undefined;
      source.content = content;
      return new Response(null);
    };
    const { doc, conn } = await source.join(bare);
    edit(doc, 'Accepted despite missing response ETag');
    await doc.flushSave();
    edit(doc, 'Unfenced write must not be sent');
    await assert.rejects(doc.flushSave(), /without a verified ETag/);
    await closeConn(doc, conn, true); // Simulate eviction without an admin notification.

    const reopened = await source.join(bare);
    await reopened.doc.flushSave(); // Wait for Source restoration.
    assert.match(doc2aem(reopened.doc), /Accepted despite missing response ETag/);
    edit(reopened.doc, 'Must also not be sent after restart');
    await assert.rejects(reopened.doc.flushSave(), /without a verified ETag/);
    assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['"loaded"']);
    assert.equal(await source.storage.get(fencedBaseline), null);
    assert.equal(await source.storage.get('docstore'), undefined);
  });

  for (const [api, status] of [['syncAdmin', 200], ['deleteAdmin', 204]]) {
    it(`${api} sends 4412 to fenced bare main without invalidating the branch`, async () => {
      const main = makeSource('"main"');
      main.contentBranch = 'main';
      const { doc, conn } = await main.join(bare);
      const branch = await makeSource('"branch"').join();
      main.put = () => new Response(null, { headers: { ETag: '"saved-main"' } });
      edit(doc, 'Main opted in through Content-Branch');
      await doc.flushSave();
      assert.equal(main.writes[0].headers.get('If-Match'), '"main"');
      assert.equal(doc.etag, '"saved-main"');
      edit(doc, 'Pending changes that must be discarded');

      const response = await new DocRoom({}).fetch(new Request(`${bare}?api=${api}`));
      assert.equal(response.status, status);
      assert.equal(conn.closeCode, 4412);
      assert.equal(conn.closeReason, 'reload required');
      assert.match(doc.getMap('error').get('message'), /invalidated; reload/);
      assert.equal(branch.conn.readyState, 1);
      assert.equal(branch.conn.closeCode, undefined);
      assert.equal(main.writes.length, 1);
      assert.equal(await main.storage.get('docstore'), undefined);
      await assert.rejects(doc.flushSave(), /invalidated/);
    });
  }

  for (const baseline of ['"same"', '"old"', undefined]) {
    it(`restart reuses pending Yjs only with a matching Source ETag (cached: ${baseline})`, async () => {
      const source = makeSource('"same"');
      const stored = new Y.Doc();
      edit(stored, 'Pending edits cached before restart');
      const state = Y.encodeStateAsUpdate(stored);
      await storeState(qualified, state, source.storage, undefined, baseline);
      await source.storage.put('lastsync', original); // Even identical bytes do not prove provenance.
      stored.destroy();
      const { doc } = await source.join();

      source.put = ({ content, headers }) => {
        assert.equal(headers.get('If-Match'), '"same"');
        source.content = content;
        return new Response(null, { headers: { ETag: '"saved"' } });
      };
      await doc.flushSave();
      if (baseline === source.etag) {
        assert.equal(source.writes.length, 1);
        assert.match(source.content, /Pending edits cached/);
      } else {
        assert.equal(source.writes.length, 0);
        assert.equal(doc2aem(doc), original);
        assert.equal(await source.storage.get(fencedBaseline), source.etag);
        assert.notDeepEqual(await source.storage.get('docstore'), state);
      }
    });
  }

  it('returns a negative flush acknowledgement after Source failure and a positive ack after recovery', async () => {
    const source = makeSource('"loaded"');
    const { doc, conn } = await source.join();
    source.put = () => new Response(null, { status: 503, statusText: 'Unavailable' });
    edit(doc, 'Edit survives a temporary failure');
    await messageListener(conn, doc, flushMessage);
    assert.deepEqual(conn.acks, [0]);
    assert.match(conn.flushError, /503/);
    assert.equal(conn.readyState, 1);
    assert.equal(doc.etag, '"loaded"');

    source.put = () => new Response(null, { headers: { ETag: '"saved"' } });
    await messageListener(conn, doc, flushMessage);
    assert.deepEqual(conn.acks, [0, 1]);
    assert.deepEqual(source.writes.map(({ headers }) => headers.get('If-Match')), ['"loaded"', '"loaded"']);
  });

  it('acknowledges a no-op after reverting the edit that failed with 503', async () => {
    const source = makeSource('"loaded"');
    const { doc, conn } = await source.join();
    source.put = () => new Response(null, { status: 503, statusText: 'Unavailable' });
    edit(doc, 'Edit that failed to persist');
    await messageListener(conn, doc, flushMessage);
    assert.deepEqual(conn.acks, [0]);
    assert.match(conn.flushError, /503/);

    edit(doc, 'Initial Source content for editing');
    assert.equal(doc2aem(doc), original);
    await messageListener(conn, doc, flushMessage);
    assert.deepEqual(conn.acks, [0, 1]);
    assert.equal(doc.lastSaveError, null);
    assert.equal(source.writes.length, 1);
  });

  it('412 signals clients, discards pending state, and reopens from Source', async () => {
    const source = makeSource('"loaded"');
    const { doc, conn } = await source.join();
    const peer = await source.join();
    assert.equal(peer.doc, doc);
    edit(doc, 'Obsolete editor changes');
    source.etag = '"external"';
    source.content = original.replace('Initial Source content for editing', 'Externally replaced');
    source.put = ({ headers }) => {
      assert.notEqual(headers.get('If-Match'), source.etag);
      return new Response(null, { status: 412 });
    };

    await messageListener(conn, doc, flushMessage);
    assert.deepEqual(conn.acks, [0]);
    assert.match(conn.flushError, /412.*changed externally/);
    assert.match(doc.getMap('error').get('message'), /412/);
    assert.equal(conn.readyState, 3);
    assert.equal(peer.conn.readyState, 3);
    assert.equal(conn.closeCode, 4412);
    assert.equal(peer.conn.closeCode, 4412);
    assert.equal(conn.closeReason, 'reload required');
    assert.equal(await source.storage.get(fencedBaseline), null);
    assert.equal(await source.storage.get('docstore'), undefined);
    assert.equal(await source.storage.get('lastsync'), undefined);
    const fresh = await source.join();
    assert.notEqual(fresh.doc, doc);
    await fresh.doc.flushSave();
    assert.equal(doc2aem(fresh.doc), source.content);
    assert.equal(source.writes.length, 1);
  });

  it('discards on 412 even if the save started while closing the last socket', async () => {
    const source = makeSource('"loaded"');
    const { doc, conn } = await source.join();
    edit(doc, 'Edit flushed by last close');
    source.etag = '"external"';
    source.put = () => new Response(null, { status: 412 });

    await closeConn(doc, conn);
    assert.equal(doc.discardPendingChanges, true);
    assert(doc.isDestroyed);
    await assert.rejects(doc.flushSave(), /412/);
    assert.equal(await source.storage.get(fencedBaseline), null);
    assert.equal(source.writes.length, 1);
    const fresh = await source.join();
    assert.notEqual(fresh.doc, doc);
  });

  for (const lateStatus of [200, 412]) {
    it(`does not let a delayed ${lateStatus} touch the room or validator after syncadmin`, async () => {
      const source = makeSource('"loaded"');
      const { doc, conn } = await source.join();
      const putStarted = Promise.withResolvers();
      const settlePut = Promise.withResolvers();
      source.put = (request) => {
        putStarted.resolve(request);
        return settlePut.promise;
      };
      edit(doc, 'Old delayed edit');
      const oldFlush = messageListener(conn, doc, flushMessage);
      try {
        const { headers } = await putStarted.promise;
        assert.equal(headers.get('If-Match'), '"loaded"');
        source.etag = '"external"';
        source.content = original.replace('Initial Source content for editing', 'Synced Source content');
        assert.equal(await invalidateFromAdmin(qualified), true);
        assert.deepEqual(conn.acks, [0]);
        assert.equal(conn.readyState, 3);
        assert.equal(conn.closeCode, 4412);
        // A hibernation message queued on an obsolete socket must not join its successor.
        await handleWebSocketMessage(conn, qualified, source.env, source.storage, replay(doc));
        const fresh = await source.join();
        await fresh.doc.flushSave();
        settlePut.resolve(new Response(null, { status: lateStatus, headers: { ETag: '"obsolete"' } }));
        await oldFlush;
        await assert.rejects(doc.flushSave(), /invalidated/);
        assert.equal(doc.etag, '"loaded"');
        assert.equal(await source.storage.get(fencedBaseline), '"external"');
        assert.equal((await source.join()).doc, fresh.doc);
        assert.equal(fresh.conn.readyState, 1);
        assert(!fresh.doc.conns.has(conn));
        assert.equal(doc2aem(fresh.doc), source.content);
        assert.deepEqual(source.writes.map((write) => write.headers.get('If-Match')), ['"loaded"']);
      } finally {
        settlePut.resolve(new Response(null, { status: 412 }));
        await oldFlush;
      }
    });
  }

  it('does not delete a replacement room when an obsolete GET finally returns', async () => {
    const source = makeSource('"external"');
    const firstGet = Promise.withResolvers();
    const { fetch } = source.env.daadmin;
    source.env.daadmin.fetch = () => firstGet.promise;
    const loading = source.join();
    const rejected = assert.rejects(loading, /invalidated while loading/);
    try {
      assert.equal(await invalidateFromAdmin(qualified), true);
      source.env.daadmin.fetch = fetch;
      const fresh = await source.join();
      firstGet.resolve(new Response(original, { headers: { ETag: '"obsolete"' } }));
      await rejected;
      assert.equal((await source.join()).doc, fresh.doc);
      assert.equal(fresh.doc.etag, '"external"');
    } finally {
      firstGet.resolve(new Response(original));
      await rejected;
    }
  });

  it('uses distinct existing path-based room keys for tilde-qualified and bare sites', async () => {
    const names = [];
    const routed = [];
    const env = {
      daadmin: { fetch: async () => new Response(null) },
      rooms: {
        idFromName: (name) => {
          names.push(name);
          return name;
        },
        get: (id) => ({
          fetch: (req) => {
            routed.push([id, req.url, req.headers.get('X-collab-room')]);
            return new Response(null, { status: 204 });
          },
        }),
      },
    };
    const main = await edge.fetch(new Request(`https://collab.da.live/${bare}?Authorization=one`), env);
    const branch = await edge.fetch(new Request(`https://collab.da.live/${qualified}?Authorization=two`), env);
    assert.equal(main.status, 204);
    assert.equal(branch.status, 204);
    assert.deepEqual(names, [bare, qualified]);
    assert.deepEqual(routed, [[bare, bare, bare], [qualified, qualified, qualified]]);
  });

  it('waits out a queued durable snapshot before a replacement room reads Source state', async () => {
    const source = makeSource('"loaded"');
    const { doc, conn } = await source.join();
    const writing = Promise.withResolvers();
    const releaseSnapshot = Promise.withResolvers();
    const { put } = source.storage;
    source.storage.put = async (key, value) => {
      if (key.docstore && key[fencedBaseline] === '"loaded"') {
        writing.resolve();
        await releaseSnapshot.promise;
      }
      await put(key, value);
    };
    // Same Source bytes and ETag, but syncadmin explicitly discards pending edits.
    edit(doc, 'Old pending state is still writing to durable storage');
    await writing.promise;
    const invalidating = invalidateFromAdmin(qualified);
    const joining = source.join();
    assert.equal(conn.readyState, 3);
    await Promise.resolve();
    assert.deepEqual(source.reads, [qualified]);
    releaseSnapshot.resolve();
    await invalidating;
    const { doc: fresh } = await joining;
    await fresh.flushSave();
    assert.equal(doc2aem(fresh), original);
    assert.deepEqual(source.writes, []);
  });

  it('fails closed until an interrupted durable discard can be retried', async () => {
    const source = makeSource('"same"');
    source.contentBranch = 'main';
    const stored = new Y.Doc();
    edit(stored, 'Pending state at an unchanged Source revision');
    const snapshot = Y.encodeStateAsUpdate(stored);
    await storeState(bare, snapshot, source.storage, undefined, source.etag);
    stored.destroy();
    const { doc, conn } = await source.join(bare);
    assert.match(doc2aem(doc), /Pending state/);

    const { put } = source.storage;
    source.storage.put = async (key, value) => {
      if (key === fencedBaseline && value === null) {
        throw new Error('marker write unavailable');
      }
      await put(key, value);
    };
    await assert.rejects(invalidateFromAdmin(bare), /marker write unavailable/);
    assert.equal(conn.closeCode, 4412);
    source.contentBranch = undefined;
    await assert.rejects(source.join(bare), /marker write unavailable/);

    source.storage.put = put;
    const recovered = await source.join(bare);
    assert.equal(doc2aem(recovered.doc), original);
    assert.notDeepEqual(await source.storage.get('docstore'), snapshot);
    assert.deepEqual(source.writes, []);
  });
});
