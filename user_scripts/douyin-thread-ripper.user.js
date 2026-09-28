// ==UserScript==
// @name         Douyin Thread Ripper (Experimental)
// @name:zh-CN    抖音线程撕裂者（实验版）
// @namespace    https://github.com/Kymer0615/Douyin-thread-ripper
// @version      0.1.3
// @description  Experimental concurrent media range downloads for Douyin. An inspired extension of MrTangLuyao's Bilibili-thread-ripper.
// @description:zh-CN  受 Bilibili-thread-ripper 启发的抖音扩展项目，实验性并发下载视频字节范围。
// @author       Douyin-thread-ripper contributors
// @license      MIT
// @homepageURL  https://github.com/Kymer0615/Douyin-thread-ripper
// @supportURL   https://github.com/Kymer0615/Douyin-thread-ripper/issues
// @match        https://www.douyin.com/*
// @match        https://douyin.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

// Inspired extension of https://github.com/MrTangLuyao/Bilibili-thread-ripper
// Independent, unofficial implementation. No upstream endorsement implied.
// Experimental: live Douyin compatibility and performance are not yet verified.

/*
MIT License

Copyright (c) 2026 Douyin-thread-ripper contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(() => {
'use strict';
// Independently implemented; inspired by MrTangLuyao/Bilibili-thread-ripper.
const LIMITS = Object.freeze({ min: 128 * 1024, max: 8 * 1024 * 1024, probe: 16 * 1024 });

function mediaURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (/(^|\.)douyinvod\.com$/i.test(url.hostname) || url.hostname === 'v3-dy-o.zjcdn.com');
  } catch { return false; }
}

function parseRange(value) {
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

function createTransport(nativeFetch, options = {}) {
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

// Keep later page wrappers in the call chain, including wrappers retaining old fetch.
function installFetchHook(root, transport) {
  let current;
  let getter;
  const stats = { assignments: 0, recoveries: 0, calls: 0, installFailures: 0 };
  function wrap(downstream) {
    if (typeof downstream !== 'function') return downstream;
    function wrapped(input, init) {
      const dispatch = (value, options) => Reflect.apply(downstream, root, [value, options]);
      // Old references may still be used by a page wrapper, even asynchronously.
      // Only the current outer layer accelerates; old layers pass through.
      if (current !== wrapped) return dispatch(input, init);
      stats.calls++;
      return transport.fetch(input, init, dispatch);
    }
    return wrapped;
  }
  function install(value) {
    current = wrap(value);
    getter = () => current;
    try {
      Object.defineProperty(root, 'fetch', {
        configurable: true, enumerable: true, get: getter,
        set(value) {
          if (value === current) return;
          stats.assignments++;
          current = wrap(value);
        }
      });
    } catch {
      stats.installFailures++;
      // A nonconfigurable writable property can still accept a plain wrapper.
      try { root.fetch = current; } catch { /* report unavailable hook */ }
    }
  }
  install(root.fetch);
  return {
    check() {
      if (root.fetch === current) return;
      const value = root.fetch;
      if (typeof value !== 'function') return;
      stats.recoveries++;
      install(value);
    },
    report() {
      return { ...stats, installed: typeof current === 'function' && root.fetch === current,
        assignmentTracking: Object.getOwnPropertyDescriptor(root, 'fetch')?.get === getter };
    }
  };
}

(() => {
  'use strict';
  if (window.__douyinThreadRipper) return;
  const VERSION = '0.1.3';
  const STORAGE = 'douyin-thread-ripper.settings.v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE)) || {}; } catch { /* storage may be blocked */ }
  const settings = { enabled: saved.enabled !== false, concurrency: [2, 4, 6].includes(saved.concurrency) ? saved.concurrency : 4 };
  const nativeFetch = window.fetch.bind(window);
  const transport = createTransport(nativeFetch, { settings });
  const hook = installFetchHook(window, transport);
  setInterval(() => hook.check(), 1000);
  const observed = { fetch: 0, xmlhttprequest: 0, video: 0, other: 0, waiting: 0, playing: 0 };
  const resourceHosts = new Map();
  let observerSupported = false;
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        // Observe other CDN/transport paths without collecting paths or query strings.
        if (['fetch', 'xmlhttprequest', 'video'].includes(entry.initiatorType)) {
          try {
            const host = new URL(entry.name).hostname;
            if (host && (resourceHosts.has(host) || resourceHosts.size < 32)) {
              const counts = resourceHosts.get(host) || { host, fetch: 0, xmlhttprequest: 0, video: 0 };
              counts[entry.initiatorType]++;
              resourceHosts.set(host, counts);
            }
          } catch { /* blob and non-URL resource entries */ }
        }
        if (mediaURL(entry.name)) {
          const key = ['fetch', 'xmlhttprequest', 'video'].includes(entry.initiatorType) ? entry.initiatorType : 'other';
          observed[key]++;
        }
      }
    }).observe({ type: 'resource', buffered: true });
    observerSupported = true;
  } catch { /* optional diagnostics */ }
  for (const event of ['waiting', 'playing']) document.addEventListener(event, e => {
    if (e.target instanceof HTMLVideoElement) observed[event]++;
  }, true);

  function report() {
    return {
      version: VERSION, experimental: true, fetchHookInstalled: hook.report().installed,
      hook: hook.report(), resourceObserverSupported: observerSupported,
      resourceHosts: [...resourceHosts.values()].map(counts => ({ ...counts })),
      settings: { ...settings }, stats: { ...transport.stats }, observed: { ...observed },
      videos: [...document.querySelectorAll('video')].map(video => ({
        source: video.currentSrc.startsWith('blob:') ? 'blob' : video.currentSrc.startsWith('https:') ? 'https' : 'other',
        paused: video.paused, readyState: video.readyState,
        bufferedSeconds: Array.from({ length: video.buffered.length }, (_, i) =>
          Math.max(0, video.buffered.end(i) - Math.max(video.currentTime, video.buffered.start(i))))
          .reduce((a, b) => a + b, 0)
      }))
    };
  }
  Object.defineProperty(window, '__douyinThreadRipper', { value: Object.freeze({ report }) });

  function mount() {
    if (!document.body) return;
    const host = document.createElement('div');
    host.id = 'douyin-thread-ripper';
    host.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483647;color-scheme:dark';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { font:13px/1.6 system-ui,sans-serif; color:#eee }
      details { background:#171820; border:1px solid #565966; border-radius:10px; padding:10px 14px; max-width:310px; box-shadow:0 4px 20px #0006 }
      summary,button,input,select { cursor:pointer } summary { font-weight:700 }
      p { margin:8px 0 } button,select { font:inherit; padding:4px 8px; background:#303341; color:#fff; border:1px solid #777; border-radius:4px }
      label { display:block; margin:8px 0 } a { color:#91caff } textarea { width:280px; height:100px } small { color:#bbb }
    </style><details><summary>DTR · 实验版</summary>
      <p>抖音线程撕裂者 · ${VERSION}</p>
      <label><input type="checkbox" id="enabled"> 启用并发下载</label>
      <label>最大连接数 <select id="threads"><option>2</option><option>4</option><option>6</option></select></label>
      <p id="status" aria-live="polite"></p>
      <p><small>仅支持可校验的 fetch 字节范围请求。成功计数不代表速度提升。</small></p>
      <button id="report" type="button">导出诊断</button>
      <p id="notice"></p><textarea hidden aria-label="诊断信息" readonly></textarea>
      <p><small>Inspired extension of <a href="https://github.com/MrTangLuyao/Bilibili-thread-ripper" target="_blank" rel="noopener noreferrer">Bilibili-thread-ripper</a> · 独立、非官方</small></p>
    </details>`;
    const enabled = root.querySelector('#enabled'), threads = root.querySelector('#threads');
    enabled.checked = settings.enabled;
    threads.value = String(settings.concurrency);
    const notice = root.querySelector('#notice');
    function save() {
      settings.enabled = enabled.checked;
      settings.concurrency = Number(threads.value);
      if (!settings.enabled) transport.cancel();
      try { localStorage.setItem(STORAGE, JSON.stringify(settings)); }
      catch { notice.textContent = '设置仅在当前页面生效（无法保存）。'; }
      render();
    }
    enabled.addEventListener('change', save);
    threads.addEventListener('change', save);
    root.querySelector('#report').addEventListener('click', async () => {
      const text = JSON.stringify(report(), null, 2);
      try { await navigator.clipboard.writeText(text); notice.textContent = '诊断已复制（不含视频链接或 Cookie）。'; }
      catch {
        const area = root.querySelector('textarea');
        area.hidden = false; area.value = text; area.select();
        notice.textContent = '请手动复制诊断信息。';
      }
    });
    function render() {
      const s = transport.stats;
      root.querySelector('#status').textContent = !settings.enabled ? '已关闭，新请求使用原生下载。' :
        !hook.report().installed ? 'fetch 钩子不可用，请导出诊断。' :
        `并发成功 ${s.accelerated} · 活跃连接 ${s.active} · 回退 ${s.fallbacks} · 跳过 ${s.skipped}` +
        (s.accelerated === 0 ? '。尚未确认接管视频下载。' : '') +
        (s.lastFailure ? `（${s.lastFailure}）` : '');
    }
    document.body.append(host);
    render();
    setInterval(render, 1000);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();

})();
