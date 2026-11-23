/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import {
  aem2doc, doc2aem, json2doc, doc2json,
} from '@adobe/da-parser';
import debounce from './debounce.js';
import {
  HELIX6, LEGACY, fetchBoundSource, fetchBoundTransport, hasStrongEtag, readBoundAdmission,
  readBoundSourceHead, readBoundSourceMode, readBranchSourceBaseline, resolveBoundSource,
  sourceError,
} from './bound-source.js';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

/**
 * Convert a da-admin source path to the Helix path format.
 *
 * da-admin paths look like `/source/{org}/{site}/{rest}`; the equivalent Helix
 * path is `/{org}/sites/{site}/source/{rest}`. Paths already in Helix format
 * (`/{org}/sites/{site}/source/...`) and paths that don't match the da-admin
 * source shape are returned unchanged.
 * @param {string} pathname - the URL pathname (leading slash included)
 */
export const toHelixPath = (pathname) => {
  const segs = pathname.split('/').filter(Boolean);
  // Already Helix format: {org}/sites/{site}/source/...
  if (segs[1] === 'sites' && segs[3] === 'source') {
    return pathname;
  }
  // da-admin format: source/{org}/{site}/{rest}
  if (segs[0] === 'source' && segs.length >= 3) {
    const [, org, site, ...rest] = segs;
    return `/${org}/sites/${site}/source/${rest.join('/')}`;
  }
  return pathname;
};

/**
 * Manual local-testing override. Normal deployments leave IS_HELIX unset.
 * 'false' forces da-admin without rewriting URLs; 'true' and 'local' force
 * Helix at api.aem.live and localhost:3000, respectively.
 * @param {object} [env] - the worker environment
 * @returns {{
 *   isHelix: boolean,
 *   rewriteUrl: (url: string) => string,
 * } | undefined}
 */
function getLocalTestBackendOverride(env) {
  if (env?.IS_HELIX === undefined) {
    return undefined;
  }
  const mode = String(env.IS_HELIX);
  let substituteOrigin;
  if (mode === 'true') {
    substituteOrigin = 'https://api.aem.live';
  } else if (mode === 'local') {
    substituteOrigin = 'http://localhost:3000';
  }

  return {
    isHelix: substituteOrigin !== undefined,
    rewriteUrl: (url) => {
      if (!substituteOrigin) {
        return url;
      }
      const u = new URL(url);
      const t = `${substituteOrigin}${toHelixPath(u.pathname)}${u.search}`;
      return t;
    },
  };
}

/**
 * True for Helix documents, using the URL unless a local-testing override is set.
 * @param {string} docName - the document URL
 * @param {object} [env] - the worker environment (may carry `IS_HELIX`)
 */
export const isHelixDoc = (docName, env) => !env?.boundMode
  && (getLocalTestBackendOverride(env)?.isHelix ?? docName.startsWith('https://api.aem.live/'))
  && !resolveBoundSource(docName, env)?.branch;

function boundBackend(env) {
  return (url, opts) => {
    const target = resolveBoundSource(url, env);
    if (!target || target.canonical !== url) {
      throw sourceError(503, 'Invalid bound Source room');
    }
    return fetchBoundSource(env, env.boundMode === HELIX6 ? target.helix : target.canonical, opts);
  };
}

/**
 * Resolve the content backend for a document.
 *
 * Documents under https://api.aem.live live in Helix and are reached over the
 * public internet (the global fetch); everything else is read and written
 * through the da-admin service binding.
 *
 * @param {string} docName - the document URL
 * @param {object} env - the worker environment; provides the da-admin service
 *   binding (`env.daadmin`) and optional local-testing backend configuration.
 * @returns {{
 *   fetch: (url: string, opts?: object) => Promise<Response>,
 *   putReqData: (content: string, mimeType: string) => { body: *, size: number, headers: object },
 * }}
 */
export function getBackend(docName, env) {
  const localTestOverride = getLocalTestBackendOverride(env);
  const isHelix = isHelixDoc(docName, env);
  const qualifiedDA = !env?.boundMode && resolveBoundSource(docName, env)?.branch;
  let fetch = boundBackend(env);
  if (qualifiedDA) {
    fetch = (url, opts) => fetchBoundTransport(env.daadmin, url, opts);
  } else if (!env?.boundMode) {
    fetch = (url, opts) => (isHelix ? globalThis : env.daadmin)
      .fetch(localTestOverride?.rewriteUrl(url) ?? url, opts);
  }

  return {
    // A fetch that already knows where to go.
    fetch,

    // Build the body (and any body-specific headers) for a content PUT.
    // Helix takes the raw content with an explicit Content-Type; da-admin takes
    // multipart form-data with a `data` part (its boundary header is implicit).
    putReqData: (content, mimeType) => {
      if (isHelix || env?.boundMode === HELIX6) {
        return { body: content, size: content.length, headers: { 'Content-Type': mimeType } };
      }
      const blob = new Blob([content], { type: mimeType });
      const formData = new FormData();
      formData.append('data', blob);
      return { body: formData, size: blob.size, headers: {} };
    },
  };
}

/**
 * Returns true for Cloudflare platform events that are expected during normal operation
 * (deployments, DO live migrations) and should not be treated as errors.
 * @param {Error} err
 */
export const isExpectedPlatformEvent = (err) => {
  const msg = err?.message ?? '';
  return msg.includes('This script has been upgraded')
    || msg.includes('cannot access storage because object has moved to a different machine');
};

export const logError = (err, ...args) => {
  // eslint-disable-next-line no-console
  (isExpectedPlatformEvent(err) ? console.log : console.error)(...args);
};

// disable gc when using snapshots!
const gcEnabled = false;

// The local cache of ydocs
const docs = new Map();
const sourceStorageTails = new WeakMap();
const sourcePurgeRetries = new WeakSet();
const discardingRooms = new Map();
const retiredConnections = new WeakSet();
const boundLastCloses = new WeakMap();
const freshHibernationConnections = new WeakSet();
const pendingFlushReplies = new WeakMap();

const messageSync = 0;
const messageAwareness = 1;
export const messageFlushRequest = 2;
export const messageFlushResponse = 3;
const ERROR_ORIGIN = Symbol('error-notification');
const FENCED_SOURCE_ETAG = 'fencedSourceEtag';
const FENCED_SOURCE_SESSION = 'fencedSourceSession';
const FENCED_SOURCE_MODE = 'fencedSourceMode';
const FENCED_SOURCE_INSTANCE = 'fencedSourceInstance';
const RELOAD_CLOSE = { code: 4412, reason: 'reload required' };
const MAX_STORAGE_KEYS = 128;
const MAX_STORAGE_VALUE_SIZE = 131072;

/**
 * Write the `lastsync` marker to Durable Object storage, guarded against the
 * 128 KiB per-value cap. Cloudflare DO storage throws `RangeError` for any
 * value larger than `MAX_STORAGE_VALUE_SIZE` — that is platform-deterministic,
 * so we skip the write at `console.log` level rather than surfacing it as
 * `console.error` noise. The absence of `lastsync` already triggers the
 * documented da-admin restore fallback on DO restart, so skipping is safe.
 */
export const safePutLastsync = async (storage, value, docName, context) => {
  if (!storage?.put) {
    return;
  }
  if (value.length > MAX_STORAGE_VALUE_SIZE) {
    // eslint-disable-next-line no-console
    console.log(`[docroom] Skipping lastsync marker (${context}) - content exceeds DO value cap`, docName, `${value.length}b`);
    return;
  }
  try {
    await storage.put('lastsync', value);
  } catch (storageErr) {
    // non-fatal: worst case the restore falls back to da-admin
    logError(storageErr, `[docroom] Failed to write lastsync (${context})`, storageErr);
  }
};
// Matches da-admin EMPTY_DOC_SIZE — the byte-length of doc2aem(empty ydoc).
// PUTs at or below this size are the deterministic empty stub; allowing one
// through when no client edit happened silently overwrites real customer content
// (and triggers da-admin's Restore Point fallback).
const EMPTY_DOC_SIZE = 83;

function getDocType(docName) {
  if (docName.endsWith('.json')) {
    return 'json';
  }
  if (docName.endsWith('.html')) {
    return 'html';
  }
  return 'html'; // default
}

function isBranchSource(docName) {
  const { pathname } = new URL(docName, 'https://admin.da.live');
  return /^\/(?:api\/)?source\/[^/]+\/[^/]*(?:~|%7e)/i.test(pathname);
}

const isFencedSource = (ydoc, docName = ydoc.name ?? '') => !isHelixDoc(docName, ydoc)
  && (ydoc.boundMode === HELIX6 || ydoc.sourceFenced || isBranchSource(docName));

const hasSourceValidator = (etag) => typeof etag === 'string' && etag !== '' && etag !== '*';
const hasRoomValidator = (ydoc, etag) => (ydoc.boundMode === HELIX6
  ? hasStrongEtag(etag) : hasSourceValidator(etag));

function removeRoom(doc) {
  if (docs.get(doc.name) === doc) {
    docs.delete(doc.name);
  }
  if (!doc.isDestroyed) {
    doc.destroy();
  }
}

/**
 * Close the WebSocket connection for a document. If there are no connections left, remove
 * the ydoc from the local cache map.
 * @param {ydoc} doc - the ydoc to close the connection for.
 * @param {WebSocket} conn - the websocket connection to close.
 * @param {boolean} skipSave - skip flushing stale or re-entrant saves.
 * @param {object} [closeOptions] - optional WebSocket close code and reason.
 */
export const closeConn = async (doc, conn, skipSave = false, closeOptions = undefined) => {
  try {
    if (doc.conns.has(conn)) {
      const controlledIds = doc.conns.get(conn);
      retiredConnections.add(conn);
      doc.conns.delete(conn);
      try {
        awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);
        /* c8 ignore start */
      } catch (err) {
        // we can ignore an exception here, closing the connection will remove the awareness states
        logError(err, '[docroom] Error while removing awareness states', err);
        /* c8 ignore end */
      }

      if (doc.conns.size === 0) {
        // Keep the departing grant private to this room's final flush. It is not
        // a connected peer, and cannot authorize a save after a new peer joins.
        const lastClose = doc.boundMode === HELIX6
          ? { id: Symbol('final flush'), auth: conn.readOnly === true ? undefined : conn.auth }
          : undefined;
        if (lastClose) {
          boundLastCloses.set(doc, lastClose.id);
        }
        // External changes must discard pending edits. Re-entrant closes from
        // persistence.update must also skip flushing to avoid awaiting their own save.
        if (doc.flushSave && !skipSave && !doc.discardPendingChanges) {
          // eslint-disable-next-line no-console
          console.log('[docroom] Flushing pending save on last connection close', doc.name);
          try {
            await doc.flushSave(lastClose);
          } catch (err) {
            logError(err, '[docroom] Failed to flush on last connection close', doc.name, err);
          }
        }
        if (doc.conns.size === 0 && (!lastClose || boundLastCloses.get(doc) === lastClose.id)) {
          boundLastCloses.delete(doc);
          const duration = conn.connectedAt ? Date.now() - conn.connectedAt : 0;
          // eslint-disable-next-line no-console
          console.log('[docroom] Last connection closed', doc.name, `duration: ${duration}ms`, `unsaved: ${!!doc.hasClientChanged}`);
          removeRoom(doc);
        }
      }
    }
    const options = closeOptions ?? doc.reloadCloseOptions;
    if (options) {
      conn.close(options.code, options.reason);
    } else {
      conn.close();
    }
  } catch (e) {
    /* c8 ignore start */
    // we can ignore an exception here, connection will be closed anyway
    logError(e, '[docroom] Error while closing connection', e);
    /* c8 ignore end */
  }
};

const send = (doc, conn, m) => {
  try {
    if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
      closeConn(doc, conn);
      return;
    }
    conn.send(m, (err) => err != null && closeConn(doc, conn));
  } catch (e) {
    logError(e, '[docroom] Error while sending message', e);
    closeConn(doc, conn);
  }
};

/**
 * Read the ydoc document state from durable object persistent storage. The format is as
 * in storeState function.
 * @param {string} docName - The document name
 * @param {TransactionalStorage} storage - The worker transactional storage
 * @param {boolean} clearOnMismatch - Whether to clear storage for a mismatched document name.
 * @returns {Promise<Uint8Array | undefined>} - The stored state or undefined if not found
 */
export const readState = async (docName, storage, clearOnMismatch = true) => {
  const storedDoc = await storage.get('doc');
  if (storedDoc === undefined) {
    // eslint-disable-next-line no-console
    console.log('[docroom] No stored doc in persistence');
    return undefined;
  }

  if (storedDoc !== docName) {
    // eslint-disable-next-line no-console
    console.log('[docroom] Docname mismatch in persistence. Expected:', docName, 'found:', storedDoc);
    if (clearOnMismatch) {
      await storage.deleteAll();
    }
    return undefined;
  }

  const docstore = await storage.get('docstore');
  if (docstore !== undefined) {
    // eslint-disable-next-line no-console
    console.log('[docroom] Document found in persistence');
    return docstore;
  }

  const chunkCount = await storage.get('chunks');
  if (chunkCount === undefined) {
    return undefined;
  }

  const chunkKeys = Array.from({ length: chunkCount }, (_, i) => `chunk_${i}`);
  const chunksMap = await storage.get(chunkKeys);

  const data = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = chunksMap.get(`chunk_${i}`);

    // Note cannot use the spread operator here, as that goes via the stack and may lead to
    // stack overflow.
    for (let j = 0; j < chunk.length; j += 1) {
      data.push(chunk[j]);
    }
  }
  // eslint-disable-next-line no-console
  console.log('[docroom] Document data read');
  return new Uint8Array(data);
};

/**
 * Store the document in durable object persistent storage. The document is stored as one or
 * more byte arrays. Durable persistent storage is tied to each durable object, so the storage only
 * applies to the current document.
 * The durable object storage saves an object (keys and values) but there is a limit to the size
 * of the values. So if the state is too large, it is split into chunks.
 * The layout of the stored object is as follows:
 * a. State size less than max storage value size:
 *    serialized.doc = document name
 *    serialized.docstore = state of the document
 * b. State size greater than max storage value size:
 *    serialized.doc = document name
 *    serialized.chunks = number of chunks
 *    serialized.chunk_0 = first chunk
 *    ...
 *    serialized.chunk_n = last chunk, where n = chunks - 1
 * @param {string} docName - The document name
 * @param {Uint8Array} state - The Yjs document state, as produced by Y.encodeStateAsUpdate()
 * @param {TransactionalStorage} storage - The worker transactional storage
 * @param {number} chunkSize - The chunk size
 * @param {string|null} [sourceEtag] - Exact Source validator for this snapshot (null = unverified).
 * @param {string} [sourceSession] - Socket continuity identity for a fenced snapshot.
 * @param {string} [sourceMode] - Bound transport used to create a fenced snapshot.
 * @param {string} [sourceInstance] - Qualified H6 branch incarnation of this snapshot.
 */
export const storeState = async (
  docName,
  state,
  storage,
  chunkSize = MAX_STORAGE_VALUE_SIZE,
  sourceEtag = undefined,
  sourceSession = undefined,
  sourceMode = undefined,
  sourceInstance = undefined,
) => {
  const oldChunkCount = await storage.get('chunks');

  let serialized;
  if (state.byteLength < chunkSize) {
    serialized = { docstore: state };
    if (oldChunkCount !== undefined) {
      const staleKeys = ['chunks', ...Array.from({ length: oldChunkCount }, (_, i) => `chunk_${i}`)];
      await storage.delete(staleKeys);
    }
  } else {
    serialized = {};
    let j = 0;
    for (let i = 0; i < state.length; i += chunkSize, j += 1) {
      serialized[`chunk_${j}`] = state.slice(i, i + chunkSize);
    }

    // Keep the validator and session identity atomic with the snapshot.
    const maxChunks = MAX_STORAGE_KEYS - (sourceEtag === undefined ? 1 : 3)
      - Number(sourceSession !== undefined) - Number(sourceMode !== undefined)
      - Number(sourceInstance !== undefined);
    if (j > maxChunks) {
      // eslint-disable-next-line no-console
      console.error('[docroom] Object too big for worker storage', docName, j, MAX_STORAGE_KEYS);
      throw new Error('Object too big for worker storage');
    }

    serialized.chunks = j;
    await storage.delete('docstore');
    if (oldChunkCount !== undefined && oldChunkCount > j) {
      const extraKeys = Array.from({ length: oldChunkCount - j }, (_, i) => `chunk_${j + i}`);
      await storage.delete(extraKeys);
    }
  }
  serialized.doc = docName;
  if (sourceEtag !== undefined) {
    serialized[FENCED_SOURCE_ETAG] = sourceEtag;
  }
  if (sourceSession !== undefined) {
    serialized[FENCED_SOURCE_SESSION] = sourceSession;
  }
  if (sourceMode !== undefined) {
    serialized[FENCED_SOURCE_MODE] = sourceMode;
  }
  if (sourceInstance !== undefined) {
    serialized[FENCED_SOURCE_INSTANCE] = sourceInstance;
  }

  await storage.put(serialized);
};

// Serialize Source snapshots and invalidation markers for this DO.
function queueSourceStorage(ydoc, operation) {
  const { storage, name } = ydoc;
  const previous = sourceStorageTails.get(storage) ?? Promise.resolve();
  const next = previous.then(operation);
  sourceStorageTails.set(storage, next.catch((err) => {
    logError(err, '[docroom] Failed to persist Source state', name, err);
  }));
  return next;
}

function storeSourceState(ydoc, docName = ydoc.name) {
  return queueSourceStorage(ydoc, () => {
    if (docs.get(docName) === ydoc && !ydoc.discardPendingChanges) {
      let sourceEtag;
      if (isFencedSource(ydoc, docName)) {
        if (ydoc.etagUnverified) {
          return undefined;
        }
        sourceEtag = ydoc.etag;
      }
      const state = Y.encodeStateAsUpdate(ydoc);
      return storeState(
        docName,
        state,
        ydoc.storage,
        undefined,
        sourceEtag,
        ydoc.sourceSession,
        sourceEtag === undefined ? undefined : ydoc.boundMode,
        ydoc.sourceInstance,
      );
    }
    return undefined;
  });
}

function purgeSourceState(ydoc) {
  const { storage } = ydoc;
  return queueSourceStorage(ydoc, async () => {
    // Null records durable opt-in but cannot authorize any stored Yjs state.
    // If even this write fails, retry before trusting a snapshot in this isolate.
    sourcePurgeRetries.add(storage);
    await storage.put(FENCED_SOURCE_ETAG, null);
    const chunks = await storage.get('chunks');
    await storage.delete([
      'doc', 'docstore', 'chunks', 'lastsync', FENCED_SOURCE_SESSION, FENCED_SOURCE_MODE,
      FENCED_SOURCE_INSTANCE,
    ]);
    if (chunks) {
      await storage.delete(Array.from({ length: chunks }, (_, i) => `chunk_${i}`));
    }
    sourcePurgeRetries.delete(storage);
  });
}

async function readSourceBaseline(ydoc, docName, storage) {
  try {
    return await storage.get(FENCED_SOURCE_ETAG);
  } catch (error) {
    if (isFencedSource(ydoc, docName) || !storage.list) {
      throw error;
    }
    // Legacy storage recovery can continue if another read establishes whether a marker exists.
    const markers = await storage.list({ prefix: FENCED_SOURCE_ETAG, limit: 1 });
    return markers.get(FENCED_SOURCE_ETAG);
  }
}

export const showError = (ydoc, err) => {
  try {
    const em = ydoc.getMap('error');

    // Perform the change in a transaction to avoid seeing a partial error
    ydoc.transact(() => {
      em.set('timestamp', Date.now());
      em.set('message', err.message);
      if (ydoc.sendStackTraces) {
        em.set('stack', err.stack);
      }
    }, ERROR_ORIGIN);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[docroom] Error while showing error', e, err);
  }
};

function discardRoom(ydoc, error) {
  const { name, storage } = ydoc;
  const fencedSource = isFencedSource(ydoc);
  const notification = error ?? (fencedSource
    ? new Error('Room invalidated; reload the document') : undefined);
  // Fence synchronously before broadcasting anything: send() can re-enter closeConn.
  // The promise covers storage and socket close, never the active Source save.
  // eslint-disable-next-line no-param-reassign
  ydoc.discardPendingChanges = true;
  boundLastCloses.delete(ydoc);
  ydoc.cancelSave?.();
  if (fencedSource) {
    // eslint-disable-next-line no-param-reassign
    ydoc.lastSaveError = notification;
    // Also use 4412 if sending the error re-enters closeConn.
    // eslint-disable-next-line no-param-reassign
    ydoc.reloadCloseOptions = RELOAD_CLOSE;
  }
  ydoc.conns.forEach((_, conn) => retiredConnections.add(conn));
  const cleanup = Promise.resolve().then(async () => {
    try {
      if (fencedSource && storage?.put) {
        await purgeSourceState(ydoc);
      } else if (error && !isHelixDoc(name, ydoc) && storage?.deleteAll) {
        // Legacy DA reports deletion as 412; leave its close behavior unchanged.
        await queueSourceStorage(ydoc, () => storage.deleteAll());
      } else {
        await storage?.delete?.('lastsync');
      }
    } finally {
      if (discardingRooms.get(name) === cleanup) {
        discardingRooms.delete(name);
      }
    }
  });
  discardingRooms.set(name, cleanup);
  if (notification) {
    showError(ydoc, notification);
  }
  if (ydoc.lastSaveError) {
    pendingFlushReplies.get(ydoc)?.forEach((reply) => reply(ydoc.lastSaveError));
  }
  // skipSave means closeConn never awaits this save or the storage queue.
  const closing = Array.from(ydoc.conns.keys(), (conn) => closeConn(ydoc, conn, true));
  removeRoom(ydoc);
  return Promise.all([cleanup, ...closing]);
}

/**
 * Invalidate the worker storage for the document, which will ensure that when accessed
 * the worker will fetch the latest version of the document from the da-admin.
 * Invalidation is implemented by closing all client connections to the doc, which will
 * cause it to be reinitialised when accessed.
 * @param {string} docName - The name of the document
 * @param {boolean} discardPendingChanges - cancel pending saves instead of flushing them.
 *   Fenced Source rooms always discard on an external invalidation.
 * @returns true if the document was found and invalidated, false otherwise.
 */
export const invalidateFromAdmin = async (docName, discardPendingChanges = false) => {
  // eslint-disable-next-line no-console
  console.log('[worker] Invalidate document cache', docName);
  const ydoc = docs.get(docName);
  if (ydoc) {
    if (discardPendingChanges || isFencedSource(ydoc)) {
      await discardRoom(ydoc);
      return true;
    }
    // Await all closeConn calls so that flushSave + docs.delete complete before
    // this function returns. Without this, an editor that reconnects during the
    // flushSave window finds the stale ydoc still in `docs` and reuses it
    // instead of creating a fresh one that loads the new da-admin content.
    await Promise.all(Array.from(ydoc.conns.keys(), (c) => closeConn(ydoc, c)));
    return true;
  } else {
    // eslint-disable-next-line no-console
    console.log('[worker] Document not found', docName);
  }
  return false;
};

/** Invalidate a room even when it is asleep. A wake may invalidate only its own session. */
export async function invalidateBoundFromAdmin(docName, ctx, sourceSession) {
  const doc = docs.get(docName);
  let retired = false;
  for (const conn of ctx?.getWebSockets?.() ?? []) {
    const attachment = conn.deserializeAttachment();
    if (attachment?.docName === docName
      && (!sourceSession || attachment.sourceSession === sourceSession)
      && (attachment.boundMode === HELIX6 || attachment.sourceSession)
      && !retiredConnections.has(conn) && !doc?.conns.has(conn)) {
      retiredConnections.add(conn);
      retired = true;
      try {
        conn.close(RELOAD_CLOSE.code, RELOAD_CLOSE.reason);
      } catch { /* already closed */ }
    }
  }
  const { storage } = ctx ?? {};
  if (doc || !storage) {
    if (sourceSession && doc?.sourceSession !== sourceSession) {
      return retired;
    }
    return (await invalidateFromAdmin(docName)) || retired;
  }
  const discarding = discardingRooms.get(docName);
  if (discarding) {
    await discarding;
    return true;
  }
  const cleanup = Promise.resolve().then(async () => {
    await sourceStorageTails.get(storage);
    if (sourceSession && (await storage.get(FENCED_SOURCE_SESSION)) !== sourceSession) {
      return retired;
    }
    if (retired || (await storage.get(FENCED_SOURCE_ETAG)) !== undefined) {
      await purgeSourceState({ name: docName, storage });
      return true;
    }
    return false;
  }).finally(() => {
    if (discardingRooms.get(docName) === cleanup) {
      discardingRooms.delete(docName);
    }
  });
  discardingRooms.set(docName, cleanup);
  return cleanup;
}

const normalizeEtag = (etag) => (etag ? etag.replace(/^W\//, '') : null);

async function getHelixEtagBaseline(backend, docName, opts, initialResponse) {
  let response = initialResponse;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const etag = normalizeEtag(response.headers.get('etag'));
      if (!response.ok || etag) {
        return { response, etag };
      }

      // Without a GET validator, bracket a fresh read with matching HEAD tags.
      // Adopting a HEAD tag for an earlier body could authorize a stale overwrite.
      // eslint-disable-next-line no-await-in-loop
      const before = await backend.fetch(docName, { ...opts, method: 'HEAD' });
      const beforeEtag = normalizeEtag(before.headers.get('etag'));
      before.body?.cancel();
      if (!before.ok) {
        response.body?.cancel();
        return { response: before, etag: null };
      }
      if (!beforeEtag) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      const reloaded = await backend.fetch(docName, opts);
      response.body?.cancel();
      response = reloaded;
      const reloadedEtag = normalizeEtag(response.headers.get('etag'));
      if (!response.ok || reloadedEtag) {
        return { response, etag: reloadedEtag };
      }

      // eslint-disable-next-line no-await-in-loop
      const after = await backend.fetch(docName, { ...opts, method: 'HEAD' });
      const afterEtag = normalizeEtag(after.headers.get('etag'));
      after.body?.cancel();
      if (!after.ok) {
        response.body?.cancel();
        return { response: after, etag: null };
      }
      if (afterEtag === beforeEtag) {
        return { response, etag: afterEtag };
      }
    }
    // eslint-disable-next-line no-console
    console.warn('[docroom] Helix ETag baseline unavailable or unstable; protected saves require a reload', docName);
    return { response, etag: null };
  } catch (error) {
    response.body?.cancel();
    throw error;
  }
}

function readRoomBranchEtag(ydoc, headers) {
  readBoundSourceMode(headers, true);
  const { instance, etag } = readBranchSourceBaseline(headers, ydoc.boundBranch);
  if (instance !== ydoc.sourceInstance) {
    throw sourceError(412, 'Bound Source branch instance changed');
  }
  return etag;
}

const isBranchUnavailable = (status) => status === 404 || status === 422;

async function isBranchModeMismatch(response) {
  if (response.status !== 409) {
    return false;
  }
  try {
    const payload = await response.json();
    return payload?.error?.code === 'SOURCE_MODE_MISMATCH';
  } catch {
    return false;
  }
}

export const persistence = {
  closeConn,

  /**
   * Get the document from its backend.
   * @param {string} docName - The document name
   * @param {string} auth - The authorization header
   * @param {WSSharedDoc} ydoc - the ydoc; provides the da-admin service binding
   *   (`ydoc.daadmin`). Store the exact Source ETag, or the normalized Helix ETag.
   * @returns {Promise<string>} - The content of the document
   * @throws {Error} - If the document cannot be retrieved (including 404)
   */
  get: async (docName, auth, ydoc) => {
    const docType = getDocType(docName);
    const initalOpts = ydoc.boundMode ? { method: 'GET' } : {};
    if (auth) {
      initalOpts.headers = new Headers({ Authorization: auth });
    }

    const backend = getBackend(docName, ydoc);
    const isHelix = isHelixDoc(docName, ydoc);
    let initialReq = await backend.fetch(docName, initalOpts);
    let etag;
    if (ydoc.sourceInstance) {
      try {
        if (initialReq.ok) {
          const baseline = readBoundAdmission(initialReq.headers, {
            branch: ydoc.boundBranch, isHelixAlias: true,
          });
          if (baseline.instance !== ydoc.sourceInstance
            || baseline.etag !== ydoc.sourceAdmissionEtag) {
            throw sourceError(412, 'Bound Source branch validator changed');
          }
        } else if (isBranchUnavailable(initialReq.status)
          || (await isBranchModeMismatch(initialReq))) {
          throw sourceError(412, 'Bound Source branch became unavailable');
        }
      } catch {
        if (!initialReq.bodyUsed) {
          initialReq.body?.cancel();
        }
        throw sourceError(412, 'Bound Source branch changed during load; reload the document');
      }
    } else if ((ydoc.boundMode || ydoc.boundBranch) && initialReq.ok) {
      try {
        const { mode } = readBoundAdmission(initialReq.headers, {
          branch: ydoc.boundBranch, isHelixAlias: ydoc.boundMode === HELIX6,
        });
        if (mode !== (ydoc.boundMode ?? LEGACY)) {
          throw sourceError(412, 'Bound Source mode changed; reload the document');
        }
        if (mode === HELIX6 && !hasStrongEtag(initialReq.headers.get('etag'))) {
          throw sourceError(503, 'Bound Source GET did not return a strong ETag');
        }
      } catch (error) {
        initialReq.body?.cancel();
        if (ydoc.boundBranch) {
          throw sourceError(412, 'Bound Source branch changed during DA load; reload the document');
        }
        throw error;
      }
    }
    if (isHelix && initialReq.ok) {
      const baseline = await getHelixEtagBaseline(backend, docName, initalOpts, initialReq);
      ({ response: initialReq, etag } = baseline);
      // eslint-disable-next-line no-param-reassign
      ydoc.etagUnverified = !etag;
    }
    if (initialReq.ok) {
      if (isHelix) {
        // eslint-disable-next-line no-param-reassign
        ydoc.etag = etag;
      } else {
        const sourceEtag = initialReq.headers.get('etag');
        // ETags alone do not distinguish legacy DA and branching-enabled Source.
        // eslint-disable-next-line no-param-reassign
        ydoc.sourceFenced = isFencedSource(ydoc, docName) || initialReq.headers.has('Content-Branch');
        // eslint-disable-next-line no-param-reassign
        ydoc.etagUnverified = ydoc.sourceFenced && !hasRoomValidator(ydoc, sourceEtag);
        // eslint-disable-next-line no-param-reassign
        ydoc.etag = sourceEtag;
      }
      return docType === 'json' ? initialReq.json() : initialReq.text();
    } else {
      const msg = ydoc.boundMode
        ? `[docroom] Unable to get resource from bound Source: ${initialReq.status}`
        : `[docroom] Unable to get resource from da-admin: ${initialReq.status} - ${initialReq.statusText}`;
      // 401/403 are auth/ACL outcomes the worker cannot bypass — operational
      // noise, not service errors. Mirror persistence.update's PUT demotion so
      // the error stream stays a real-signal channel (see #135).
      if (initialReq.status === 401) {
        // eslint-disable-next-line no-console
        console.warn(msg);
      } else if (initialReq.status === 403) {
        // eslint-disable-next-line no-console
        console.log(msg);
      } else {
        // eslint-disable-next-line no-console
        console.error(msg);
      }
      const err = new Error(`unable to get resource - status: ${initialReq.status}`);
      err.status = initialReq.status;
      throw err;
    }
  },

  /**
   * Store the content in its backend.
   * @param {WSSharedDoc} ydoc - The Yjs document, which among other things contains the service
   * binding to da-admin.
   * @param {string} content - The content to store
   * @param {string} [closingAuth] - Verified grant for a bound H6 final flush only.
   * @returns {Promise<object>} The response from the backend.
   */
  put: async (ydoc, content, closingAuth) => {
    const backend = getBackend(ydoc.name, ydoc);
    const isHelix = isHelixDoc(ydoc.name, ydoc);
    const mimeType = getDocType(ydoc.name) === 'json' ? 'application/json' : 'text/html';
    const { body: putBody, size: bodySize, headers: bodyHeaders } = backend
      .putReqData(content, mimeType);

    const opts = { method: isHelix ? 'POST' : 'PUT', body: putBody };
    const keys = Array.from(ydoc.conns.keys());
    const allReadOnly = keys.length > 0 && keys.every((con) => con.readOnly === true);
    if (allReadOnly) {
      // eslint-disable-next-line no-console
      console.log('[docroom] All connections are read only, not storing');
      return { ok: true };
    }

    const storedEtag = isHelix ? normalizeEtag(ydoc.etag) : ydoc.etag;
    const legacy = !isHelix && !isFencedSource(ydoc);
    if (!legacy && (!hasRoomValidator(ydoc, storedEtag) || ydoc.etagUnverified)) {
      throw new Error(`Cannot save ${isHelix ? 'Helix' : 'Source'} document without a verified ETag; reload the document`);
    }
    const headers = {
      'If-Match': legacy ? '*' : storedEtag,
      'X-DA-Initiator': 'collab',
      ...bodyHeaders,
    };

    const auth = keys
      .filter((con) => con.readOnly !== true)
      .map((con) => con.auth);

    if (ydoc.boundMode === HELIX6 && keys.length === 0) {
      if (!closingAuth) {
        throw new Error('Cannot save bound Source without an authorized writer');
      }
      auth.push(closingAuth);
    }

    if (auth.length > 0) {
      if (isHelix) {
        // eslint-disable-next-line prefer-destructuring
        headers.Authorization = auth[0];
      } else {
        headers.Authorization = [...new Set(auth)].join(',');
      }
    }

    opts.headers = new Headers(headers);

    if (bodySize <= EMPTY_DOC_SIZE) {
      // eslint-disable-next-line no-console
      console.warn('[docroom] Writing back an empty document', ydoc.name, bodySize);
    }

    const trackPut = isHelix || ydoc.sourceInstance;
    if (trackPut) {
      // Any HEAD overlapping a write is too old to invalidate this session.
      // eslint-disable-next-line no-param-reassign
      ydoc.saveGeneration = (ydoc.saveGeneration ?? 0) + 1;
      // eslint-disable-next-line no-param-reassign
      ydoc.pendingPuts = (ydoc.pendingPuts ?? 0) + 1;
    }
    const cached = docs.get(ydoc.name) === ydoc;
    let response;
    try {
      response = await backend.fetch(ydoc.name, opts);
    } finally {
      if (trackPut) {
        // eslint-disable-next-line no-param-reassign
        ydoc.pendingPuts -= 1;
      }
    }
    const {
      ok, status, statusText, body, headers: respHeaders,
    } = response;

    let branchConflict = false;
    if (ydoc.sourceInstance && !ydoc.discardPendingChanges) {
      if (ok) {
        try {
          // A qualified PUT must advance the exact strong validator used for If-Match.
          branchConflict = readRoomBranchEtag(ydoc, respHeaders) === storedEtag;
        } catch {
          branchConflict = true;
        }
      } else {
        branchConflict = isBranchUnavailable(status) || (await isBranchModeMismatch(response));
      }
    }
    const stillCurrent = !ydoc.discardPendingChanges && (!cached || docs.get(ydoc.name) === ydoc);
    if (ok && stillCurrent && !legacy && !branchConflict) {
      const etag = respHeaders.get('etag');
      if (isHelix || hasRoomValidator(ydoc, etag)) {
        // eslint-disable-next-line no-param-reassign
        ydoc.etag = isHelix ? normalizeEtag(etag) : etag;
      }
      // A missing validator after a protected write is not evidence of a legacy backend.
      // eslint-disable-next-line no-param-reassign
      ydoc.etagUnverified = !hasRoomValidator(ydoc, etag);
      if (ydoc.etagUnverified) {
        // eslint-disable-next-line no-console
        console.warn(`[docroom] ${isHelix ? 'Helix' : 'Source'} save response missing ETag; protected saves require a reload`, ydoc.name);
      }
    }

    if (body && !response.bodyUsed) {
      // tell CloudFlare to consider the request as completed
      body.cancel();
    }

    return {
      ok: ok && !branchConflict,
      status: branchConflict ? 412 : status,
      statusText: ydoc.boundMode ? '' : statusText,
    };
  },

  /**
   * Issue a HEAD request to Helix and compare the document's current ETag
   * against the one stored on the ydoc (`ydoc.etag`). Ignore obsolete responses
   * and retry failed requests on the next polling interval.
   * @param {WSSharedDoc} ydoc - the ydoc holding the last known ETag.
   */
  checkEtag: async (ydoc) => {
    if (!isHelixDoc(ydoc.name, ydoc)
      || ydoc.isDestroyed || ydoc !== docs.get(ydoc.name) || ydoc.conns.size === 0
      || ydoc.etagCheckAbortController || ydoc.pendingPuts > 0) {
      return;
    }
    const { etag, saveGeneration } = ydoc;
    const controller = new AbortController();
    // eslint-disable-next-line no-param-reassign
    ydoc.etagCheckAbortController = controller;
    try {
      const backend = getBackend(ydoc.name, ydoc);
      const auth = Array.from(ydoc.conns.keys())
        .map((con) => con.auth || '');
      const authorizations = [...new Set(auth)];
      let res;
      for (const authorization of authorizations) {
        if (ydoc.isDestroyed || controller.signal.aborted
          || ydoc !== docs.get(ydoc.name) || ydoc.conns.size === 0) {
          return;
        }
        const tokenIsActive = Array.from(ydoc.conns.keys())
          .some((con) => (con.auth || '') === authorization);
        if (tokenIsActive) {
          const opts = { method: 'HEAD', signal: controller.signal };
          if (authorization) {
            opts.headers = new Headers({ Authorization: authorization });
          }
          // eslint-disable-next-line no-await-in-loop
          res = await backend.fetch(ydoc.name, opts);
          res.body?.cancel();
          if (ydoc.isDestroyed || controller.signal.aborted
            || ydoc !== docs.get(ydoc.name) || ydoc.conns.size === 0
            || ydoc.etag !== etag || ydoc.saveGeneration !== saveGeneration) {
            return;
          }
          if (res.status === 401 || res.status === 403) {
            const reason = res.status === 401 ? 'unauthorized' : 'forbidden';
            const code = res.status === 401 ? 4401 : 4403;
            // eslint-disable-next-line no-console
            console.warn('[docroom] Etag HEAD authorization failed; reconnecting affected clients', ydoc.name, res.status);
            const rejected = Array.from(ydoc.conns.keys())
              .filter((con) => (con.auth || '') === authorization);
            // Skip flushing with rejected credentials; keep stored pending edits.
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(rejected.map((con) => closeConn(ydoc, con, true, { code, reason })));
            res = undefined;
          } else {
            break;
          }
        }
      }
      if (!res) {
        return;
      }
      if (res.status === 404 || res.status === 410) {
        await invalidateFromAdmin(ydoc.name, true);
        return;
      }
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[docroom] Etag HEAD failed: ${res.status} - ${res.statusText}`, ydoc.name);
        return;
      }
      const currentEtag = normalizeEtag(res.headers.get('etag'));
      if (!currentEtag) {
        // eslint-disable-next-line no-console
        console.warn('[docroom] Etag HEAD response missing ETag', ydoc.name);
        return;
      }
      const storedEtag = normalizeEtag(etag);
      if (!storedEtag) {
        // A HEAD-only baseline is useful for polling, but must not authorize
        // writes to content loaded or saved without a matching validator.
        // eslint-disable-next-line no-param-reassign
        ydoc.etag = currentEtag;
        // eslint-disable-next-line no-param-reassign
        ydoc.etagUnverified = true;
        return;
      }
      if (currentEtag !== storedEtag) {
        // eslint-disable-next-line no-console
        console.log('[docroom] Etag check', ydoc.name, `stored=${etag}`, `current=${currentEtag}`, 'same=false');
        await invalidateFromAdmin(ydoc.name, true);
      }
    } catch (err) {
      if (!controller.signal.aborted || err !== controller.signal.reason) {
        logError(err, '[docroom] Etag check failed', ydoc.name, err);
      }
    } finally {
      // eslint-disable-next-line no-param-reassign
      delete ydoc.etagCheckAbortController;
    }
  },

  /**
   * An update to the document has been received. Store it in da-admin.
   * @param {WSSharedDoc} ydoc - the ydoc that has been updated.
   * @param {string} current - the current content of the document previously
   * obtained from da-admin
   * @param {string} docName - the name of the document
   * @param {string} [closingAuth] - Verified grant for a bound H6 final flush only.
   * @returns {Promise<string>} - the new content of the document in da-admin.
   */
  update: async (ydoc, current, docName, closingAuth) => {
    const docType = getDocType(docName);
    const name = ydoc.name ?? docName;
    const cached = docs.get(name) === ydoc;
    const roomIsCurrent = () => !ydoc.discardPendingChanges && !ydoc.isDestroyed
      && (!cached || docs.get(name) === ydoc);
    const complete = (value) => {
      if (roomIsCurrent()) {
        // eslint-disable-next-line no-param-reassign
        ydoc.lastSaveError = null;
      }
      return value;
    };
    let closeAll = false;
    try {
      if (!roomIsCurrent()) {
        throw new Error('Room invalidated before saving; reload the document');
      }
      const content = docType === 'json' ? doc2json(ydoc) : doc2aem(ydoc);

      // Never overwrite real content with the deterministic empty stub when no
      // client edit produced it. Defends customer content against COR-31:
      // bindState fallbacks, awareness/storage-only updates, or transient
      // server-side transacts can otherwise debounce a stub PUT through.
      if (!ydoc.hasClientChanged && content.length <= EMPTY_DOC_SIZE) {
        // eslint-disable-next-line no-console
        console.log('[docroom] Skipping empty-stub PUT - no client edit', docName, content.length);
        return complete(current);
      }

      if (current !== content) {
        // Only store the document if it was actually changed.
        const { ok, status, statusText } = await persistence.put(ydoc, content, closingAuth);
        if (!roomIsCurrent()) {
          throw new Error('Room invalidated before the save completed; reload the document');
        }

        if (ok && ydoc.boundMode === HELIX6 && ydoc.etagUnverified) {
          const error = new Error('Bound Source save did not return a strong ETag; reload the document');
          if (cached) {
            await discardRoom(ydoc, error);
          }
          throw error;
        }

        if (!ok) {
          if (status === 412) {
            const backend = isHelixDoc(name, ydoc) ? 'Helix' : 'Source';
            const conflict = new Error(`412 - ${backend} document changed externally; reloading the document`);
            // eslint-disable-next-line no-param-reassign
            ydoc.lastSaveError = conflict;
            // eslint-disable-next-line no-console
            console.warn(`[docroom] ${backend} version conflict`, docName, conflict.message);
            if (docs.get(name) === ydoc) {
              await discardRoom(ydoc, conflict);
            }
            return current;
          }
          closeAll = (status === 401 || status === 403);
          throw new Error(`${status} - ${statusText}`);
        }

        // eslint-disable-next-line no-console
        console.log('[docroom] Saved to da-admin', docName, `${content.length}b`);
        // Record what we just PUT so that on DO restart we can tell whether
        // CF storage is ahead of da-admin (safe to use) vs. da-admin was
        // externally modified (must use da-admin).
        if (isFencedSource(ydoc) && ydoc.storage?.put && cached) {
          if (ydoc.etagUnverified) {
            await purgeSourceState(ydoc);
          } else {
            await storeSourceState(ydoc);
          }
        } else {
          await safePutLastsync(ydoc.storage, content, docName, 'after da-admin PUT');
        }
        return complete(content);
      }
      return complete(current);
    } catch (err) {
      if (!roomIsCurrent()) {
        // eslint-disable-next-line no-param-reassign
        ydoc.lastSaveError ??= err;
        return current;
      }
      // eslint-disable-next-line no-param-reassign
      ydoc.lastSaveError = err;
      if (err?.message?.startsWith('401')) {
        // eslint-disable-next-line no-console
        console.warn('[docroom] Failed to update document', docName, err.message);
      } else if (err?.message?.startsWith('403')) {
        // eslint-disable-next-line no-console
        console.log('[docroom] Failed to update document', docName, err.message);
      } else {
        // eslint-disable-next-line no-console
        console.error('[docroom] Failed to update document', docName, err);
      }
      showError(ydoc, err);
      if (closeAll) {
        pendingFlushReplies.get(ydoc)?.forEach((reply) => reply(err));
      }
    }
    if (closeAll) {
      // We had an unauthorized from da-admin - lets reset the connections.
      // Pass skipSave=true so closeConn skips flushSave here; the outer
      // save already handled (or failed to handle) persistence.
      for (const con of Array.from(ydoc.conns.keys())) {
        // eslint-disable-next-line no-await-in-loop
        await persistence.closeConn(ydoc, con, true);
      }
    }
    return current;
  },

  /**
   * Bind the Ydoc to the persistence layer.
   * @param {string} docName - the name of the document
   * @param {WSSharedDoc} ydoc - the new ydoc to be bound
   * @param {WebSocket} conn - the websocket connection
   * @param {TransactionalStorage} storage - the worker transactional storage object
   */
  bindState: async (docName, ydoc, conn, storage, ctx) => {
    const docType = getDocType(docName);
    const isHelix = isHelixDoc(docName, ydoc);
    let timingReadStateDuration;

    // Store storage reference for later use in persistence.update
    // eslint-disable-next-line no-param-reassign
    ydoc.storage = storage;

    let current;
    let restored = false; // True if restored from worker storage
    let restoredSession;
    let freshRoom = false;
    let restoreAfterDelay;
    let restoreError;
    let backendRestored = false;
    const cached = docs.get(docName) === ydoc;

    // Get document from da-admin (throws on error including 404)
    const timingBeforeDaAdminGet = Date.now();
    current = await persistence.get(docName, conn.auth, ydoc);
    const timingDaAdminGetDuration = Date.now() - timingBeforeDaAdminGet;
    const roomIsCurrent = () => !ydoc.discardPendingChanges && !ydoc.isDestroyed
      && (!cached || docs.get(docName) === ydoc);
    if (!roomIsCurrent()) {
      return new Map();
    }

    let sourceEtag;
    if (!isHelix) {
      await sourceStorageTails.get(storage);
      if (!roomIsCurrent()) {
        return new Map();
      }
      if (sourcePurgeRetries.has(storage)) {
        await purgeSourceState(ydoc);
      }
      // Failing to read the opt-in marker must not silently select wildcard mode.
      sourceEtag = await readSourceBaseline(ydoc, docName, storage);
      if (sourceEtag !== undefined) {
        // eslint-disable-next-line no-param-reassign
        ydoc.sourceFenced = true;
        // eslint-disable-next-line no-param-reassign
        ydoc.etagUnverified = !hasRoomValidator(ydoc, ydoc.etag);
      }
    }
    const fencedSource = isFencedSource(ydoc, docName);
    const requiresSourceRestore = isHelix || fencedSource;

    // Read the stored state from internal worker storage (snapshot errors are non-fatal).
    try {
      const timingBeforeReadState = Date.now();
      const verifiedSnapshot = hasRoomValidator(ydoc, sourceEtag) && sourceEtag === ydoc.etag
        && !ydoc.etagUnverified
        && (!(ydoc.boundMode || ydoc.boundBranch)
          || (await storage.get(FENCED_SOURCE_MODE)) === ydoc.boundMode)
        && (!ydoc.boundBranch
          || (await storage.get(FENCED_SOURCE_INSTANCE)) === ydoc.sourceInstance);
      const stored = !fencedSource || verifiedSnapshot
        ? await readState(docName, storage, !fencedSource) : undefined;
      if (!roomIsCurrent()) {
        return new Map();
      }
      timingReadStateDuration = Date.now() - timingBeforeReadState;
      if (isHelix && !stored?.length) {
        const [storedDoc, lastSynced] = await Promise.all([
          storage.get('doc'), storage.get('lastsync'),
        ]);
        freshRoom = storedDoc === undefined && lastSynced === undefined;
      }

      if (stored && stored.length > 0) {
        if (fencedSource) {
          restoredSession = await storage.get(FENCED_SOURCE_SESSION);
          if (!roomIsCurrent()) {
            return new Map();
          }
        }
        Y.applyUpdate(ydoc, stored);

        // The exact Source validator proves which revision pending edits were based on.
        // For Helix and legacy DA, retain their existing content-based anchor. Avoid
        // serializing cached Yjs here: malformed state can block the event loop.
        const validSnapshot = fencedSource || await storage.get('lastsync') === current;
        if (validSnapshot) {
          restored = true;
          // eslint-disable-next-line no-console
          console.log('[docroom] Restored from worker persistence', docName, '(matches backend baseline)');
        }
      }
    } catch (error) {
      if (!roomIsCurrent()) {
        return new Map();
      }
      logError(error, '[docroom] Problem restoring state from worker storage', error);
      if (!isExpectedPlatformEvent(error)) {
        showError(ydoc, error);
      }
    }
    if (!roomIsCurrent()) {
      return new Map();
    }
    if (fencedSource) {
      // Reuse an identity only if the corresponding Yjs snapshot was verified and applied.
      const resume = restored && typeof restoredSession === 'string' && restoredSession !== '';
      // eslint-disable-next-line no-param-reassign
      ydoc.sourceSession = resume ? restoredSession : crypto.randomUUID();
      if (restored && !resume) {
        await storeSourceState(ydoc, docName);
      }
    }
    if (!restored && (current || requiresSourceRestore)) {
      // The doc was not restored from worker persistence, so read it from da-admin.
      if (fencedSource) {
        await purgeSourceState(ydoc);
      } else if (!requiresSourceRestore && storage.deleteAll) {
        await storage.deleteAll();
      }
      // eslint-disable-next-line no-console
      console.log('[docroom] Could not be restored, trying to restore from da-admin', docName);

      // Legacy DA preserves client-first restores (e.g. a replaced image FPO).
      // Fenced Source clients instead replace their Y.Doc on 4412.
      const svBefore = Y.encodeStateVector(ydoc);

      const restoreFromBackend = async () => {
        if (ydoc === docs.get(docName) && !ydoc.isDestroyed && !ydoc.discardPendingChanges) {
          const svAfter = Y.encodeStateVector(ydoc);
          const clientHasUpdated = svBefore.length !== svAfter.length
            || svBefore.some((v, i) => v !== svAfter[i]);
          if (clientHasUpdated && !requiresSourceRestore) {
            // eslint-disable-next-line no-console
            console.log('[docroom] Skipping da-admin reload: client state received', docName);
          } else {
            try {
              ydoc.transact(() => {
                if (docType === 'json') {
                  // Clear JSON structure
                  const ysheets = ydoc.getArray('sheets');
                  if (ysheets.length > 0) {
                    ysheets.delete(0, ysheets.length);
                  }
                  // restore from da-admin
                  json2doc(current, ydoc);
                } else {
                  // Clear HTML structure
                  const rootType = ydoc.getXmlFragment('prosemirror');
                  rootType.delete(0, rootType.length);
                  // clear all maps
                  ydoc.share.forEach((type) => {
                    if (type instanceof Y.Map) {
                      type.clear();
                    }
                  });
                  // Restore from da-admin
                  aem2doc(current, ydoc);
                }
              });
              if (requiresSourceRestore) {
                backendRestored = true;
                if (isHelix) {
                  await storeState(docName, Y.encodeStateAsUpdate(ydoc), storage);
                } else {
                  await storeSourceState(ydoc, docName);
                }
              }
              if (ydoc !== docs.get(docName) || ydoc.discardPendingChanges) {
                return;
              }

              // eslint-disable-next-line no-console
              console.log('[docroom] Restored from da-admin', docName, docType);
            } catch (error) {
              logError(error, '[docroom] Problem restoring state from da-admin', docName, error, current);
              if (!isExpectedPlatformEvent(error)) {
                showError(ydoc, error);
              }
              if (requiresSourceRestore) {
                restoreError = error;
                // eslint-disable-next-line no-param-reassign
                ydoc.lastSaveError = error;
                // eslint-disable-next-line no-param-reassign
                ydoc.etagUnverified = true;
              }
              return;
            }
          }

          if (!isFencedSource(ydoc, docName)) {
            // Legacy DA also anchors its intentional client-first continuation.
            await safePutLastsync(storage, current, docName, 'after da-admin fetch');
          }
        }
      };

      if (fencedSource || (isHelix && freshRoom)) {
        await restoreFromBackend();
        if (ydoc.boundMode === HELIX6 && restoreError) {
          throw restoreError;
        }
      } else {
        restoreAfterDelay = new Promise((resolve) => {
          setTimeout(resolve, 1000);
        }).then(restoreFromBackend);
        if (ctx?.waitUntil) {
          ctx.waitUntil(restoreAfterDelay);
        } else {
          restoreAfterDelay.catch(() => {});
        }
      }
    }

    ydoc.on('update', async () => {
      // Whenever we receive an update on the document store it in the local storage
      if (ydoc === docs.get(docName) && !ydoc.discardPendingChanges
        && !(requiresSourceRestore && restoreAfterDelay && !backendRestored)) {
        try {
          if (!isHelix) {
            await storeSourceState(ydoc, docName);
          } else {
            await storeState(docName, Y.encodeStateAsUpdate(ydoc), storage);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[docroom] Failed to persist state to storage', docName, err);
        }
      }
    });

    let savingPromise = null;
    const canSave = (lastClose) => ydoc.boundMode !== HELIX6 || (lastClose
      ? boundLastCloses.get(ydoc) === lastClose.id : ydoc.conns.size > 0);
    const saveToAdmin = (lastClose) => {
      if (savingPromise) {
        return savingPromise;
      }
      if ((!current && !requiresSourceRestore)
        || ydoc.discardPendingChanges || ydoc !== docs.get(docName) || !canSave(lastClose)) {
        return undefined;
      }
      savingPromise = Promise.resolve().then(async () => {
        if (requiresSourceRestore && restoreAfterDelay) {
          await restoreAfterDelay;
        }
        // Recheck after yielding: a new peer can supersede a queued final flush.
        if (restoreError || ydoc.discardPendingChanges || ydoc !== docs.get(docName)
          || !canSave(lastClose)) {
          return;
        }
        current = await persistence.update(ydoc, current, docName, lastClose?.auth);
        if (!ydoc.lastSaveError) {
          // eslint-disable-next-line no-param-reassign
          ydoc.hasClientChanged = false;
        }
      }).finally(() => {
        savingPromise = null;
      });
      return savingPromise;
    };

    const debouncedSave = debounce(() => saveToAdmin(), 2000, { maxWait: 10000 });
    ydoc.on('update', (update, origin) => {
      if (origin !== ERROR_ORIGIN) {
        debouncedSave(update, origin);
      }
    });

    ydoc.flushSave = async (lastClose) => {
      debouncedSave.cancel();
      // If a save is already in flight, wait for it to complete before
      // starting a new one — ensures the ack is not sent before the PUT finishes.
      if (savingPromise) {
        await savingPromise;
        if (ydoc.lastSaveError) {
          throw ydoc.lastSaveError;
        }
      }
      await saveToAdmin(lastClose);
      if (ydoc.lastSaveError) {
        throw ydoc.lastSaveError;
      }
    };

    ydoc.cancelSave = () => {
      debouncedSave.cancel();
    };

    // Periodically (every 5s) verify the document's ETag still matches the one we
    // last saw on get/put, logging the result. Cleared in WSSharedDoc.destroy.
    // Only Helix uses polling; Source relies on conditional PUT and syncadmin.
    if (!ydoc.etagCheckInterval && isHelixDoc(docName, ydoc)
      && !ydoc.isDestroyed && ydoc === docs.get(docName) && ydoc.conns.size > 0) {
      // eslint-disable-next-line no-param-reassign
      ydoc.etagCheckInterval = setInterval(() => {
        if (ydoc === docs.get(docName)) {
          persistence.checkEtag(ydoc);
        }
      }, 5000);
    }

    const timingMap = new Map();
    timingMap.set('timingReadStateDuration', timingReadStateDuration);
    timingMap.set('timingDaAdminGetDuration', timingDaAdminGetDuration);
    return timingMap;
  },
};

export const updateHandler = (update, _origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

/**
 * Our specialisation of the YDoc.
 */
export class WSSharedDoc extends Y.Doc {
  /**
   * Controls if showError should send stack traces
   * @type {boolean}
   */
  sendStackTraces = false;

  constructor(name) {
    super({ gc: gcEnabled });
    this.name = name;
    this.conns = new Map();
    // Flipped by messageListener whenever a sync message advances the state
    // vector. Gates the empty-stub PUT guard in persistence.update — see COR-31.
    this.hasClientChanged = false;
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs = (this.conns.get(conn));
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => {
            connControlledIDs.add(clientID);
          });
          removed.forEach((clientID) => {
            connControlledIDs.delete(clientID);
          });
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol
        .encodeAwarenessUpdate(this.awareness, changedClients));
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on('update', awarenessChangeHandler);
    this.on('update', updateHandler);
  }

  destroy() {
    this.cancelSave?.();
    clearInterval(this.etagCheckInterval);
    this.etagCheckAbortController?.abort();
    super.destroy();
    this.awareness.destroy();
  }
}

function rejectWake(conn) {
  if (!retiredConnections.has(conn)) {
    retiredConnections.add(conn);
    try {
      conn.close(RELOAD_CLOSE.code, RELOAD_CLOSE.reason);
    } catch { /* already closed */ }
  }
  return undefined;
}

function matchesBranchAdmission(doc, admission) {
  return (doc.boundMode ?? LEGACY) === admission.mode && doc.sourceInstance === admission.instance
    && (!admission.instance || (!doc.etagUnverified && doc.etag === admission.etag));
}

async function retireObsoleteBranchRoom(doc, target, env, auth) {
  if (doc.pendingPuts > 0) {
    return;
  }
  const generation = doc.saveGeneration;
  let latest;
  try {
    latest = await readBoundSourceHead(target, env, auth);
  } catch {
    return; // A failed or unauthorized check isn't evidence against the current room.
  }
  // Do not let a late HEAD retire a successor or race an acknowledged PUT.
  if (docs.get(doc.name) === doc && !doc.discardPendingChanges && doc.saveGeneration === generation
    && !matchesBranchAdmission(doc, latest)) {
    await discardRoom(doc);
  }
}

async function revalidateWakingBoundSource(docName, target, env, conn, ctx, attached) {
  let latest;
  try {
    latest = await readBoundSourceHead(target, env, conn.auth);
  } catch {
    // Pre-H6 DA attachments carry no mode. An unavailable trusted classifier
    // cannot distinguish an ordinary branch from one that now requires H6.
    return rejectWake(conn);
  }
  const { boundMode, sourceInstance, sourceSession } = attached ?? {};
  if (latest.unavailable || latest.mode !== (boundMode ?? LEGACY)
    || latest.instance !== sourceInstance) {
    rejectWake(conn);
    // Re-enabling the gate need not change the item ETag. Retire the observed
    // session, but never a newer one opened while HEAD was in flight.
    if (sourceSession) {
      await invalidateBoundFromAdmin(docName, ctx, sourceSession);
    }
    return undefined;
  }
  if (!latest.authActions.split(',').includes('write')) {
    // Never broaden the authorizations attached to the socket.
    // eslint-disable-next-line no-param-reassign
    conn.readOnly = true;
  }
  return latest;
}

function registerConnection(doc, conn) {
  boundLastCloses.delete(doc);
  doc.conns.set(conn, new Set());
  // eslint-disable-next-line no-param-reassign
  doc.hadConnection = true;
}

function finishBranchJoin(doc) {
  // Admission owns only rooms that never had a peer. Once a peer joins,
  // closeConn owns empty-room cleanup, including a legacy last-close save.
  // removeRoom checks the cache identity before dropping its entry.
  doc.pendingBranchJoins -= 1;
  if (!doc.pendingBranchJoins && !doc.hadConnection && !doc.conns.size) {
    removeRoom(doc);
  }
}

/**
 *
 * @param {string} docname - The name of the document
 * @param {WebSocket} conn - the WebSocket connection being initiated
 * @param {object} env - the durable object environment object
 * @param {TransactionalStorage} storage - the durable object storage object
 * @param {Map} [timingData] - optional map to receive bindState timing measurements
 * @param {boolean} gc - whether garbage collection is enabled
 * @param {boolean} waking - Admit a socket restored by the Hibernation API.
 * @returns The shared document, or undefined if a waking socket must reload.
 */
export const getYDoc = async (
  docname,
  conn,
  env,
  storage,
  timingData,
  ctx,
  gc = true,
  waking = false,
) => {
  if (waking && retiredConnections.has(conn)) {
    return undefined;
  }
  const target = resolveBoundSource(docname, env);
  const branch = target?.branch;
  const resuming = waking && !freshHibernationConnections.has(conn);
  const attachment = resuming ? conn.deserializeAttachment?.() : undefined;
  let admission = {
    mode: conn.boundMode ?? LEGACY, instance: conn.sourceInstance, etag: conn.sourceAdmissionEtag,
  };
  // An unregistered hibernated socket did not come through the edge's fresh HEAD.
  if (target && (branch || conn.boundMode === HELIX6)
    && resuming && !docs.get(docname)?.conns.has(conn)) {
    admission = await revalidateWakingBoundSource(docname, target, env, conn, ctx, attachment);
    if (!admission) {
      return undefined;
    }
  }
  while (discardingRooms.has(docname)) {
    // eslint-disable-next-line no-await-in-loop
    await discardingRooms.get(docname);
  }
  if (retiredConnections.has(conn) || (branch && conn.readyState > wsReadyStateOpen)) {
    if (waking) {
      return undefined;
    }
    throw sourceError(412, 'Connection invalidated; reconnect to reload the document');
  }
  let doc = docs.get(docname);
  if (doc === undefined) {
    // The doc is not yet in the cache, create a new one.
    doc = new WSSharedDoc(docname);
    doc.boundMode = conn.boundMode;
    doc.boundBranch = branch;
    doc.sourceInstance = admission.instance;
    doc.sourceAdmissionEtag = admission.etag;
    doc.DA_RS_ORIGIN = env.DA_RS_ORIGIN;
    doc.dars = env.dars;
    doc.gc = gc;
    doc.sendStackTraces = String(env.RETURN_STACK_TRACES) === 'true';
    docs.set(docname, doc);
  }

  if (!branch && doc.boundMode !== conn.boundMode) {
    if (!waking) {
      throw sourceError(412, 'Bound Source room transport changed; reload the document');
    }
    return rejectWake(conn);
  }

  // Carry the da-admin binding and local override before selecting wake admission.
  doc.daadmin = env.daadmin;
  doc.IS_HELIX = env.IS_HELIX;

  const awaitingWake = resuming && !doc.conns.has(conn)
    && (!isHelixDoc(docname, doc) || !!attachment?.sourceSession);
  const needsBranchAdmission = branch && (conn.sourceInstance || doc.sourceInstance);
  const awaitingAdmission = awaitingWake || (needsBranchAdmission && !doc.conns.has(conn));
  const requiresContinuity = () => isFencedSource(doc) || !!attachment?.sourceSession;
  const trackBranchJoin = branch && awaitingAdmission;
  if (trackBranchJoin) {
    doc.pendingBranchJoins = (doc.pendingBranchJoins ?? 0) + 1;
  }

  // Do not register an unchecked socket: restoring Yjs can broadcast updates.
  if (!awaitingAdmission && !doc.conns.has(conn)) {
    registerConnection(doc, conn);
  }

  const uniqueConnections = new Set(doc.conns.keys().toArray().map((c) => c.auth || 'none'));
  // eslint-disable-next-line no-console
  console.log(`[docroom] Getting ydoc ${docname}`, `Connections (unique / total): ${uniqueConnections.size} / ${doc.conns.size}`);

  if (!doc.promise) {
    // The doc is not yet bound to the persistence layer, do so now. The promise will be resolved
    // when bound.
    doc.promise = persistence.bindState(docname, doc, conn, storage, ctx);
  }

  try {
    try {
      const timings = await doc.promise;
      if (doc.discardPendingChanges) {
        throw sourceError(412, 'Room invalidated while loading; reload the document');
      }
      if (timingData) {
        timings.forEach((v, k) => timingData.set(k, v));
      }
    } catch (e) {
      // Do not let destroy's awareness broadcast try to send to this socket.
      doc.conns.delete(conn);
      removeRoom(doc);
      if ((waking && branch) || (awaitingWake && requiresContinuity())) {
        return rejectWake(conn);
      }
      throw e;
    }
    if (awaitingAdmission) {
      if (retiredConnections.has(conn) || (branch && conn.readyState > wsReadyStateOpen)
        || doc.isDestroyed || docs.get(docname) !== doc) {
        if (waking) {
          return rejectWake(conn);
        }
        throw sourceError(412, 'Room invalidated during admission; reload the document');
      }
      if (branch && !matchesBranchAdmission(doc, admission)) {
        await retireObsoleteBranchRoom(doc, target, env, conn.auth);
        if (waking) {
          return rejectWake(conn);
        }
        throw sourceError(412, 'Bound Source branch room changed; reload the document');
      }
      if (awaitingWake && requiresContinuity() && (!doc.sourceSession || doc.etagUnverified
        || attachment?.sourceSession !== doc.sourceSession)) {
        return rejectWake(conn);
      }
      if (!doc.conns.has(conn)) {
        registerConnection(doc, conn);
      }
    }
    return doc;
  } finally {
    if (trackBranchJoin) {
      finishBranchJoin(doc);
    }
  }
};

// For testing
export const setYDoc = (docname, ydoc) => docs.set(docname, ydoc);

// This read sync message handles readonly connections
const readSyncMessage = (decoder, encoder, doc, readOnly, transactionOrigin) => {
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case syncProtocol.messageYjsSyncStep1:
      syncProtocol.readSyncStep1(decoder, encoder, doc);
      break;
    case syncProtocol.messageYjsSyncStep2:
      if (!readOnly) {
        syncProtocol.readSyncStep2(decoder, doc, transactionOrigin);
      }
      break;
    case syncProtocol.messageYjsUpdate:
      if (!readOnly) {
        syncProtocol.readUpdate(decoder, doc, transactionOrigin);
      }
      break;
    default:
      throw new Error('Unknown message type');
  }
  return messageType;
};

export const messageListener = async (conn, doc, message) => {
  let messageType;
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    messageType = decoding.readVarUint(decoder);
    if (doc.discardPendingChanges && messageType !== messageFlushRequest) {
      return;
    }
    switch (messageType) {
      case messageSync: {
        encoding.writeVarUint(encoder, messageSync);
        const onChange = () => {
          doc.hasClientChanged = true;
        };
        doc.on('update', onChange);
        readSyncMessage(decoder, encoder, doc, conn.readOnly);
        doc.off('update', onChange);

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol
          .applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      }
      case messageFlushRequest: {
        const replies = pendingFlushReplies.get(doc) ?? new Set();
        pendingFlushReplies.set(doc, replies);
        const reply = (error) => {
          if (!replies.delete(reply)) {
            return;
          }
          const ackEncoder = encoding.createEncoder();
          encoding.writeVarUint(ackEncoder, messageFlushResponse);
          encoding.writeVarUint(ackEncoder, error ? 0 : 1);
          if (error) {
            encoding.writeVarString(ackEncoder, error.message || 'flush failed');
          }
          send(doc, conn, encoding.toUint8Array(ackEncoder));
        };
        replies.add(reply);
        try {
          if (doc.flushSave) {
            await doc.flushSave();
          }
          reply();
        } catch (flushErr) {
          logError(flushErr, '[docroom] flushSave failed', flushErr);
          reply(flushErr);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logError(err, '[docroom] messageListener - Message', err.stack, err);
    if (!isExpectedPlatformEvent(err)) {
      showError(doc, err);
    }
  }
};

function sendInitialState(doc, conn) {
  try {
    // send sync step 1
    let encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol
        .encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
      send(doc, conn, encoding.toUint8Array(encoder));
    }
  } catch (err) {
    logError(err, '[docroom] Error while setting up WSConnection', doc.name, err);
  }
}

/**
 * Called when a new (Yjs) WebSocket connection is being established.
 * @param {WebSocket} conn - The WebSocket connection
 * @param {string} docName - The name of the document
 * @param {object} env - The durable object environment object
 * @param {TransactionalStorage} storage - The worker transactional storage object
 * @param {boolean} hibernation - When true, skip event listener registration (CF Hibernation API
 *   handles message/close routing via class methods instead of addEventListener).
 * @returns {Promise<void>} - The return value of this
 */
export const setupWSConnection = async (conn, docName, env, storage, ctx, hibernation = false) => {
  const timingData = new Map();

  // eslint-disable-next-line no-param-reassign
  conn.binaryType = 'arraybuffer';
  // eslint-disable-next-line no-param-reassign
  conn.connectedAt = Date.now();

  if (hibernation) {
    // This entry point comes from edge.initSession, not a waking message.
    freshHibernationConnections.add(conn);
  } else {
    // Register close listener BEFORE any async operation so cleanup always fires,
    // even if the client disconnects while the document is still loading.
    conn.addEventListener('close', () => {
      const doc = docs.get(docName);
      if (doc) {
        closeConn(doc, conn);
      }
    });
  }

  // get doc, initialize if it does not exist yet
  const doc = await getYDoc(docName, conn, env, storage, timingData, ctx, true).finally(() => {
    freshHibernationConnections.delete(conn);
  });

  if (hibernation) {
    if (doc.sourceSession && !retiredConnections.has(conn)) {
      const attachment = conn.deserializeAttachment?.();
      if (attachment) {
        conn.serializeAttachment({ ...attachment, sourceSession: doc.sourceSession });
      }
    }
  } else {
    // listen and reply to events
    conn.addEventListener('message', (message) => messageListener(conn, doc, new Uint8Array(message.data)));
  }

  sendInitialState(doc, conn);
  return timingData;
};

/**
 * Handle an incoming WebSocket message from the Cloudflare Hibernation API.
 * Re-establishes the Yjs session if the DO was hibernated (doc not in memory).
 * @param {WebSocket} conn - The WebSocket connection
 * @param {string} docName - The document name
 * @param {object} env - The durable object environment
 * @param {TransactionalStorage} storage - The durable object storage
 * @param {ArrayBuffer|string} message - The raw message from the WebSocket
 */
export const handleWebSocketMessage = async (conn, docName, env, storage, message, ctx) => {
  if (retiredConnections.has(conn)) {
    return;
  }
  const cached = docs.get(docName);
  // Check every unregistered socket, even when a different socket already rehydrated the room.
  const alreadyAdmitted = cached?.conns.has(conn);
  const doc = alreadyAdmitted ? cached
    : await getYDoc(docName, conn, env, storage, undefined, ctx, true, true);
  if (alreadyAdmitted && doc.promise) {
    try {
      await doc.promise;
    } catch (error) {
      if (!doc.boundBranch) {
        throw error;
      }
      return; // A fresh qualified DA session closes from initSession on bind failure.
    }
  }
  if (doc && doc === docs.get(docName) && !doc.isDestroyed && !retiredConnections.has(conn)) {
    if (!cached) {
      // The room was hibernating. Send sync only after admitting the socket.
      // eslint-disable-next-line no-param-reassign
      conn.binaryType = 'arraybuffer';
      // eslint-disable-next-line no-param-reassign
      conn.connectedAt = Date.now();
      sendInitialState(doc, conn);
    }
    await messageListener(conn, doc, new Uint8Array(message));
  }
};

/**
 * Handle a WebSocket close event from the Cloudflare Hibernation API.
 * @param {WebSocket} conn - The WebSocket connection
 * @param {string} docName - The document name
 */
export const handleWebSocketClose = async (conn, docName) => {
  if (conn.sourceInstance) {
    retiredConnections.add(conn); // Qualified admission does not register until verified.
  }
  const doc = docs.get(docName);
  if (doc) {
    await closeConn(doc, conn);
  }
};
