// Independently implemented; inspired by MrTangLuyao/Bilibili-thread-ripper.
export const LIMITS = Object.freeze({ min: 128 * 1024, max: 8 * 1024 * 1024, probe: 16 * 1024 });

export function mediaURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (/(^|\.)douyinvod\.com$/i.test(url.hostname) || url.hostname === 'v3-dy-o.zjcdn.com');
  } catch { return false; }
}

export function parseRange(value) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value || '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start &&
    Number.isSafeInteger(end - start + 1) ? { start, end, length: end - start + 1 } : null;
}

function contentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '');
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total ?
    { start, end, total } : null;
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }

async function readBounded(response, length) {
  if (!response.body) fail('missing-body');
  const reader = response.body.getReader();
  const result = new Uint8Array(length);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > length) fail('body-too-long');
      result.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== length) fail('body-too-short');
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function withMetadata(response, original) {
  // A constructed Response otherwise loses the final URL/type, including on clone().
  Object.defineProperties(response, {
    url: { value: original.url }, type: { value: original.type },
    redirected: { value: original.redirected },
    clone: { value() { return withMetadata(Response.prototype.clone.call(this), original); } }
  });
  return response;
}

export function createTransport(nativeFetch, options = {}) {
  const settings = options.settings || { enabled: true, concurrency: 4 };
  const stats = {
    candidates: 0, accelerated: 0, bytes: 0, fallbacks: 0, cancelled: 0,
    skipped: 0, active: 0, peak: 0, jobs: 0, lastFailure: null,
    skipReasons: {}, rangeKinds: {}, lastResponse: null, lastProbeResponse: null,
    rangeBytes: { min: null, max: null, recent: [] }, withoutStrongValidator: 0
  };
  const controllers = new Set();
  const cooldown = new Map();
  const timeoutMs = options.timeoutMs ?? 8000;
  let reserved = 0;

  function observeResponse(response, stage) {
    if (!response?.headers?.get) return;
    const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    stats.lastResponse = {
      stage, status: response.status,
      contentType: ['video/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(mime) ? mime : mime ? 'other' : 'missing',
      contentRangeVisible: response.headers.has('Content-Range'),
      contentRangeValid: !!contentRange(response.headers.get('Content-Range')),
      strongETagVisible: /^"[^"\r\n]*"$/.test(response.headers.get('ETag') || '')
    };
    if (stage === 'probe-or-chunk') stats.lastProbeResponse = { ...stats.lastResponse };
  }
  async function passthrough(input, init, dispatch) {
    const response = await dispatch(input, init);
    observeResponse(response, 'native');
    return response;
  }

  async function accelerate(request, range, slots, dispatch) {
    const controller = new AbortController();
    const signal = controller.signal;
    controllers.add(controller);
    const onAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new DOMException('Range timeout', 'TimeoutError')), timeoutMs);
    let reference;
    async function piece(start, end) {
      const headers = new Headers(request.headers);
      headers.set('Range', `bytes=${start}-${end}`);
      stats.active++;
      stats.peak = Math.max(stats.peak, stats.active);
      let response;
      try {
        response = await dispatch(new Request(request, {
          headers, signal, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
          mode: request.mode, credentials: request.credentials, cache: request.cache,
          redirect: request.redirect, integrity: request.integrity, keepalive: request.keepalive
        }));
        observeResponse(response, 'probe-or-chunk');
        if (response.status !== 206) fail('range-not-supported');
        const actual = contentRange(response.headers.get('Content-Range'));
        if (!actual || actual.start !== start || actual.end !== end) fail('invalid-content-range');
        const encoding = response.headers.get('Content-Encoding');
        if (encoding && encoding !== 'identity') fail('encoded-range');
        const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
        if (!['video/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) fail('unsupported-media');
        const etag = response.headers.get('ETag');
        const modified = response.headers.get('Last-Modified');
        // Some Douyin CDNs do not expose ETag through CORS. Keep checking every
        // visible validator, but absent validators cannot prove version identity.
        if (reference && (actual.total !== reference.total || etag !== reference.etag ||
            modified !== reference.modified || mime !== reference.mime || response.url !== reference.response.url)) {
          fail('representation-changed');
        }
        if (!reference) reference = { total: actual.total, etag, modified, mime, response };
        return await readBounded(response, end - start + 1);
      } catch (error) {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        throw error;
      } finally { stats.active--; }
    }

    let tasks = [];
    try {
      // Probe one small range before committing to parallel transfers.
      const firstEnd = range.start + LIMITS.probe - 1;
      const first = await piece(range.start, firstEnd);
      if (range.end >= reference.total) fail('range-past-end');
      const remaining = range.end - firstEnd;
      const chunk = Math.ceil(remaining / slots);
      const spans = [];
      for (let start = firstEnd + 1; start <= range.end; start += chunk) {
        spans.push({ start, end: Math.min(range.end, start + chunk - 1) });
      }
      tasks = spans.map(({ start, end }) => piece(start, end));
      const chunks = await Promise.all(tasks);
      signal.throwIfAborted();
      const result = new Uint8Array(range.length);
      result.set(first);
      chunks.forEach((bytes, i) => result.set(bytes, spans[i].start - range.start));
      const headers = new Headers(reference.response.headers);
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${reference.total}`);
      headers.set('Content-Length', String(result.byteLength));
      // These describe a transfer or individual chunk, not the assembled response.
      for (const key of ['Content-Encoding', 'Transfer-Encoding', 'Content-MD5', 'Digest', 'Content-Digest']) headers.delete(key);
      stats.accelerated++;
      if (!/^"[^"\r\n]*"$/.test(reference.etag || '')) stats.withoutStrongValidator++;
      stats.bytes += result.byteLength;
      return withMetadata(new Response(result, { status: 206, statusText: 'Partial Content', headers }), reference.response);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await Promise.allSettled(tasks);
      request.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  }

  async function fetchHook(input, init, dispatch = nativeFetch) {
    if (!settings.enabled) return dispatch(input, init);
    // Preserve native input validation and leave non-media requests untouched.
    let request;
    try {
      const url = input instanceof Request ? input.url : new URL(input, globalThis.location?.href).href;
      if (!mediaURL(url)) return dispatch(input, init);
      request = new Request(input, init);
    } catch { return dispatch(input, init); }
    stats.candidates++;
    const rangeHeader = request.headers.get('Range');
    const range = parseRange(rangeHeader);
    const kind = range ? 'bounded' : rangeHeader === null ? 'missing' :
      /^bytes=\d+-$/.test(rangeHeader) ? 'open-ended' : /^bytes=-\d+$/.test(rangeHeader) ? 'suffix' :
      rangeHeader.includes(',') ? 'multiple' : 'invalid';
    stats.rangeKinds[kind] = (stats.rangeKinds[kind] || 0) + 1;
    if (range) {
      stats.rangeBytes.min = Math.min(stats.rangeBytes.min ?? range.length, range.length);
      stats.rangeBytes.max = Math.max(stats.rangeBytes.max ?? range.length, range.length);
      stats.rangeBytes.recent.push(range.length);
      if (stats.rangeBytes.recent.length > 16) stats.rangeBytes.recent.shift();
    }
    const host = new URL(request.url).hostname;
    const limit = [2, 4, 6].includes(settings.concurrency) ? settings.concurrency : 4;
    const slots = Math.min(limit - reserved, range ? Math.max(2, Math.floor((range.length - LIMITS.probe) / (64 * 1024))) : limit);
    const skip = request.method !== 'GET' ? 'method' : request.mode === 'no-cors' ? 'no-cors' :
      request.integrity ? 'integrity' : request.headers.has('If-Range') || request.headers.has('If-None-Match') ? 'conditional' :
      !range ? `range-${kind}` : range.length < LIMITS.min ? 'range-too-small' :
      range.length > LIMITS.max ? 'range-too-large' : slots < 2 ? 'concurrency-limit' :
      (cooldown.get(host) || 0) > Date.now() ? 'host-cooldown' : null;
    if (skip) {
      stats.skipped++;
      stats.skipReasons[skip] = (stats.skipReasons[skip] || 0) + 1;
      return passthrough(input, init, dispatch);
    }
    request.signal.throwIfAborted();
    reserved += slots;
    stats.jobs++;
    try {
      return await accelerate(request, range, slots, dispatch);
    } catch (error) {
      if (request.signal.aborted) { stats.cancelled++; throw request.signal.reason; }
      stats.fallbacks++;
      // Never include signed URLs, exception messages, or headers in diagnostics.
      stats.lastFailure = typeof error.code === 'string' ? error.code :
        (error.name === 'TimeoutError' ? 'timeout' : 'network-or-abort');
      cooldown.set(host, Date.now() + 60000);
      if (cooldown.size > 100) cooldown.delete(cooldown.keys().next().value);
    } finally { reserved -= slots; stats.jobs--; }
    return passthrough(input, init, dispatch);
  }

  return {
    fetch: fetchHook, stats,
    cancel() { for (const controller of controllers) controller.abort(); }
  };
}
