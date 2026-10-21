// Backend -> core4 node transport that carries NO Sec-Fetch-* header (#1395).
//
// Node's global fetch (undici) always sends `sec-fetch-mode: cors`. core4's
// Origin guard (#2136) treats any Sec-Fetch-* header as browser-originated and
// refuses an `admin`-classified method (ApiRole::Operator) without an
// allowlisted Origin (403 ORIGIN_REQUIRED). Server-to-server calls to admin
// methods therefore go through node:http / node:https, which sends only the
// headers it is given.
import http from 'node:http';
import https from 'node:https';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Normalize every HeadersInit form (record, Headers, [k, v] tuples) to a plain object. */
function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  let pairs;
  if (Array.isArray(headers)) pairs = headers;
  else if (typeof headers.entries === 'function') pairs = [...headers.entries()];
  else pairs = Object.entries(headers);
  for (const pair of pairs) {
    const [k, v] = pair;
    if (v === undefined || v === null) continue;
    if (/^sec-fetch-/i.test(String(k))) continue;
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function once(target, method, headers, body, signal) {
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('node response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ res, raw: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    signal?.addEventListener('abort', () => req.destroy(abortError()), { once: true });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Minimal fetch-compatible request over node:http(s): resolves to
 * { ok, status, headers, text(), json() }.
 *
 * - Never sends a Sec-Fetch-* header (caller-supplied ones are dropped; every
 *   redirect hop keeps the rule).
 * - Follows up to MAX_REDIRECTS redirects: 303 (and 301/302 on POST) become GET
 *   with no body, 307/308 keep method and body; Authorization is stripped when
 *   the origin changes.
 * - Asks for `Accept-Encoding: identity` and refuses an encoded response with a
 *   fixed safe error rather than parsing compressed bytes.
 */
export async function nodeHttpFetch(url, init = {}) {
  let target = new URL(String(url));
  let method = String(init.method || 'GET').toUpperCase();
  let headers = normalizeHeaders(init.headers);
  if (!('accept-encoding' in headers)) headers['accept-encoding'] = 'identity';
  let body = init.body === undefined || init.body === null ? undefined : init.body;

  for (let hop = 0; ; hop += 1) {
    const h = { ...headers };
    delete h['content-length'];
    if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    const { res, raw } = await once(target, method, h, body, init.signal);
    const status = res.statusCode || 0;
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      // Bounded scanners count each physical GET; they must not follow hidden extra hops.
      if (init.redirect === 'error') throw new Error('node redirect refused');
      if (hop >= MAX_REDIRECTS) throw new Error('node response exceeded the redirect limit');
      const next = new URL(location, target);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error('node redirect to an unsupported protocol');
      }
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      if (next.origin !== target.origin) delete headers.authorization;
      target = next;
      continue;
    }
    const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
    const encoded = encoding !== '' && encoding !== 'identity';
    const text = raw.toString('utf8');
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(
        Object.entries(res.headers).flatMap(([k, v]) =>
          v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]]
        )
      ),
      text: async () => {
        if (encoded) throw new Error('node response has an unsupported content-encoding');
        return text;
      },
      json: async () => {
        if (encoded) throw new Error('node response has an unsupported content-encoding');
        return JSON.parse(text);
      },
    };
  }
}
