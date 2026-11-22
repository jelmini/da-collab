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
export const BOUND_SOURCE_INSTANCE = 'X-Collab-Bound-Source-Instance';
export const BOUND_SOURCE_ETAG = 'X-Collab-Bound-Source-Etag';
export const HELIX6 = 'helix6';
export const LEGACY = 'legacy';
const DA_SOURCE_PATH = /^\/source\/([^/]+)\/([^/]+)\/(.+)$/;
const HELIX_SOURCE_PATH = /^\/([^/]+)\/sites\/([^/]+)\/source\/(.+)$/;
const SCOPE = /^[a-z0-9_-]+$/;
const BRANCH = /^[a-z0-9]{1,8}$/;
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

const isHelixDocumentSegment = (segment) => !/[%?#]/.test(segment)
  && !['.versions', '.history'].includes(segment.toLowerCase());

function decodeSegment(raw, qualifiedDA = false) {
  let segment;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    throw sourceError(400, 'Malformed bound Source path');
  }
  // DA allows literal percent signs but rejects ambiguous double encoding.
  // eslint-disable-next-line no-control-regex
  if (!segment || /[/\\\u0000-\u001f\u007f]/.test(segment) || segment === '.' || segment === '..'
    || (qualifiedDA ? /%[0-9a-f]{2}/i.test(segment) : !isHelixDocumentSegment(segment))) {
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
    return undefined;
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
  const [base, branch, ...extra] = site.split('~');
  const requestedOrg = decodeSegment(rawOrg);
  const org = requestedOrg.toLowerCase();
  const canonicalSite = `${base.toLowerCase()}${branch === undefined ? '' : `~${branch}`}`;
  const canonicalScope = org === rawOrg && canonicalSite === rawSite;
  if (!SCOPE.test(org) || !SCOPE.test(base.toLowerCase())
    || (h6 && !canonicalScope)
    || (branch !== undefined && (extra.length || !BRANCH.test(branch) || path.includes(';')))) {
    throw sourceError(400, 'Invalid bound Source scope');
  }
  if (branch === 'main') {
    throw sourceError(404, 'No such bound Source branch');
  }
  const qualifiedDA = !!(da && branch);
  const segments = rawDoc.split('/').map((part) => decodeSegment(part, qualifiedDA));
  const document = segments.join('/');
  const folded = foldDocumentPath(document);
  if (qualifiedDA && (!canonicalScope || folded === undefined
    || !segments.every(isHelixDocumentSegment))) {
    // Authorize the literal DA alias, but never synthesize an ambiguous H6 room.
    return { requested: docName, branch, isHelixAlias: false };
  }
  if (folded === undefined) {
    throw sourceError(400, 'Use lowercase Unicode in bound Source document paths');
  }
  const canonicalPath = encodeDocumentPath(folded);
  const canonical = `${origin}/source/${org}/${canonicalSite}/${canonicalPath}`;
  const helix = `${origin}/${org}/sites/${canonicalSite}/source/${canonicalPath}`;
  const requestedPath = encodeDocumentPath(document);
  const requested = h6 ? `${origin}/${rawOrg}/sites/${rawSite}/source/${requestedPath}`
    : `${origin}/source/${encodeURIComponent(requestedOrg)}/${encodeURIComponent(site)}/${requestedPath}`;
  return {
    // Preserve the old DA alias for authorization (including escaped suffixes).
    // It still goes through the bound mode check, never straight to old DA.
    canonical,
    helix,
    requested: qualifiedDA ? docName : requested,
    isHelixAlias: !!h6,
    branch,
  };
}

export const isHelixSourcePath = ({ pathname }) => !DA_SOURCE_PATH.test(pathname)
  && HELIX_SOURCE_PATH.test(pathname);

/** Do not follow redirects, expose binding errors, or fall back to another backend. */
export async function fetchBoundTransport(binding, url, opts) {
  if (!binding?.fetch) {
    throw sourceError(503, 'Missing bound Source service binding');
  }
  let response;
  try {
    // Workerd service-binding RPC accepts manual, not error, for this request.
    response = await binding.fetch(url, { ...opts, redirect: 'manual' });
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

export async function fetchBoundSource(env, url, opts) {
  return fetchBoundTransport(env.dars, url, opts);
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

export const hasBranchInstance = (value) => typeof value === 'string'
  && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);

/** Qualified H6 responses must identify the same branch, not just the same path. */
export function readBranchSourceBaseline(headers, branch) {
  const instance = headers.get('X-DA-Branch-Instance');
  const etag = headers.get('ETag');
  if (headers.get('Content-Branch') !== branch || !hasBranchInstance(instance)
    || !hasStrongEtag(etag)) {
    throw sourceError(503, 'Invalid bound Source branch baseline');
  }
  return { instance, etag };
}

export function readBoundAdmission(headers, target) {
  const mode = readBoundSourceMode(headers, target.isHelixAlias);
  if (target.branch && mode === HELIX6) {
    return { mode, ...readBranchSourceBaseline(headers, target.branch) };
  }
  if (target.branch && headers.has('X-DA-Branch-Instance')) {
    throw sourceError(503, 'Bound Source branch instance without a Source mode');
  }
  return { mode };
}

export async function readBoundBranchHead(target, env, auth) {
  const headers = auth ? new Headers({ Authorization: auth }) : undefined;
  const response = await fetchBoundSource(env, target.requested, { method: 'HEAD', headers });
  await response.text();
  if (!response.ok) {
    throw sourceError(response.status, 'Unable to revalidate bound Source branch');
  }
  if (response.headers.get('X-DA-Source-Unavailable') === 'true') {
    return { unavailable: true };
  }
  return {
    ...readBoundAdmission(response.headers, target),
    authActions: response.headers.get('X-da-actions')?.split('=')[1] ?? '',
  };
}
