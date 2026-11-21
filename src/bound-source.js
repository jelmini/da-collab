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

export const BOUND_SOURCE_MODE = 'X-Collab-Bound-Source-Mode';
export const HELIX6 = 'helix6';
export const LEGACY = 'legacy';
const DA_SOURCE_PATH = /^\/source\/([^/]+)\/([^/]+)\/(.+)$/;
const HELIX_SOURCE_PATH = /^\/([^/]+)\/sites\/([^/]+)\/source\/(.+)$/;
const SCOPE = /^[a-z0-9_-]+$/;
const HOSTED_BACKENDS = new Set([
  'admin.da.live', 'admin.da.page', 'stage-admin.da.live', 'api.aem.live',
]);

export function sourceError(status, message) {
  return Object.assign(new Error(message), { status });
}

function configuredOrigin(env) {
  const origin = env?.DA_RS_ORIGIN;
  if (origin === undefined) {
    return undefined;
  }
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  if (url?.origin !== origin || !/^https?:\/\//.test(origin)
    || HOSTED_BACKENDS.has(url.hostname.replace(/\.$/, ''))) {
    throw sourceError(503, 'Invalid or reserved DA_RS_ORIGIN');
  }
  return origin;
}

function decodeSegment(raw) {
  let segment;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    throw sourceError(400, 'Malformed bound Source path');
  }
  // Reject empty, ambiguous and non-document path segments before forwarding auth.
  // eslint-disable-next-line no-control-regex
  if (!segment || /[/\\%?#\u0000-\u001f\u007f]/.test(segment)
    || ['.', '..', '.versions', '.history'].includes(segment.toLowerCase())) {
    throw sourceError(400, 'Invalid bound Source path');
  }
  return segment;
}

function foldDocumentPath(document) {
  const folded = document.toLowerCase();
  // Java Locale.ROOT and JS use different context rules for non-ASCII case
  // conversion (e.g. final sigma). Until we have a server canonical path on
  // both HEAD aliases, do not admit variants we cannot key unambiguously.
  if (/[\p{Lu}\p{Lt}]/u.test(document.replace(/[A-Z]/g, ''))
    || folded !== document.replace(/[A-Z]/g, (ascii) => ascii.toLowerCase())) {
    throw sourceError(400, 'Use lowercase Unicode in bound Source document paths');
  }
  return folded;
}

const encodeDocumentPath = (document) => document.split('/').map(encodeURIComponent).join('/');

/** Resolve the two document aliases on the one explicitly configured origin. */
export function resolveBoundSource(docName, env) {
  const origin = configuredOrigin(env);
  if (!origin || !URL.canParse(docName) || new URL(docName).origin !== origin) {
    return undefined;
  }
  // Use the raw path, not URL.pathname (which removes dot segments).
  if (!docName.startsWith(`${origin}/`) || /[?#]/.test(docName)) {
    throw sourceError(400, 'Invalid bound Source URL');
  }
  const path = docName.slice(origin.length);
  const da = DA_SOURCE_PATH.exec(path);
  const h6 = da ? undefined : HELIX_SOURCE_PATH.exec(path);
  if (!da && !h6) {
    throw sourceError(400, 'Expected a bound Source document');
  }
  const [, rawOrg, rawSite, rawDoc] = da ?? h6;
  const site = decodeSegment(rawSite);
  if (site.includes('~')) {
    if (da) {
      return undefined; // Qualified DA rooms keep their original key and transport.
    }
    throw sourceError(422, 'Bound Helix 6 Source does not support branches');
  }
  const requestedOrg = decodeSegment(rawOrg);
  const org = requestedOrg.toLowerCase();
  const canonicalSite = site.toLowerCase();
  if (!SCOPE.test(org) || !SCOPE.test(canonicalSite)
    || (h6 && (org !== rawOrg || canonicalSite !== rawSite))) {
    throw sourceError(400, 'Invalid bound Source scope');
  }
  const document = rawDoc.split('/').map(decodeSegment).join('/');
  const canonicalPath = encodeDocumentPath(foldDocumentPath(document));
  const canonical = `${origin}/source/${org}/${canonicalSite}/${canonicalPath}`;
  const helix = `${origin}/${org}/sites/${canonicalSite}/source/${canonicalPath}`;
  const requestedPath = encodeDocumentPath(document);
  const requested = h6 ? `${origin}/${rawOrg}/sites/${rawSite}/source/${requestedPath}`
    : `${origin}/source/${encodeURIComponent(requestedOrg)}/${encodeURIComponent(site)}/${requestedPath}`;
  return {
    canonical, helix, requested, isHelixAlias: !!h6,
  };
}

export const isHelixSourcePath = ({ pathname }) => !DA_SOURCE_PATH.test(pathname)
  && HELIX_SOURCE_PATH.test(pathname);

/** Do not follow redirects, expose binding errors, or fall back to another backend. */
export async function fetchBoundSource(env, url, opts) {
  if (!env.dars?.fetch) {
    throw sourceError(503, 'Missing dars service binding');
  }
  let response;
  try {
    // Workerd service-binding RPC accepts manual, not error, for this request.
    response = await env.dars.fetch(url, { ...opts, redirect: 'manual' });
  } catch {
    throw sourceError(503, 'Bound Source request failed');
  }
  if (response.redirected || response.type === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    throw sourceError(503, 'Unexpected redirect from bound Source');
  }
  return response;
}

export function readBoundSourceMode(headers, isHelixAlias) {
  if (headers.has('X-DA-Source-Unavailable')) {
    throw sourceError(503, 'Bound Source transport unavailable');
  }
  const mode = headers.get('X-DA-Source-Mode');
  if (mode === HELIX6) {
    return HELIX6;
  }
  if (mode === null && !isHelixAlias) {
    return LEGACY;
  }
  throw sourceError(503, 'Invalid bound Source mode hint');
}

// RFC 9110 entity-tag grammar, without W/. Preserve the literal quoted value.
export const hasStrongEtag = (etag) => typeof etag === 'string'
  && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag);
