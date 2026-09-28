import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, mediaURL, parseRange, LIMITS } from '../src/transport.js';

const SIZE = 1024 * 1024;
const data = Uint8Array.from({ length: SIZE * 2 }, (_, i) => (i * 31 + Math.floor(i / 251)) % 256);
const url = 'https://v3-example.douyinvod.com/video/tos/cn/example/?token=secret';
const headers = { Range: `bytes=0-${SIZE - 1}` };

function fixture({ mutate, delay = 2 } = {}) {
  const calls = [];
  let active = 0, peak = 0, cancelledBodies = 0;
  async function native(input, init) {
    const request = input instanceof Request && !init ? input : new Request(input, init);
    const range = parseRange(request.headers.get('Range'));
    const call = { request, range, index: calls.length };
    calls.push(call);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(request.signal.reason); };
        const timer = setTimeout(() => {
          request.signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay + (range?.start === LIMITS.probe ? 10 : 0));
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      });
      const start = range?.start || 0, end = range?.end ?? data.length - 1;
      const spec = {
        status: range ? 206 : 200,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Type': 'video/mp4', 'ETag': '"stable"', 'Content-Length': String(end - start + 1)
        },
        body: data.slice(start, end + 1)
      };
      mutate?.(spec, call);
      const body = new ReadableStream({
        start(controller) { controller.enqueue(spec.body); },
        pull(controller) { controller.close(); },
        cancel() { cancelledBodies++; }
      });
      const response = new Response(body, spec);
      Object.defineProperties(response, { url: { value: url }, type: { value: 'cors' }, redirected: { value: true } });
      return response;
    } finally { active--; }
  }
  return { native, calls, get peak() { return peak; }, get cancelledBodies() { return cancelledBodies; } };
}

test('only exact Douyin VOD domains are eligible', () => {
  assert.equal(mediaURL(url), true);
  assert.equal(mediaURL('https://v3-dy-o.zjcdn.com/video/tos/cn/example'), true);
  for (const value of ['https://douyinvod.com.attacker.test/video.mp4', 'https://fakedouyinvod.com/a',
    'https://v3-dy-o.zjcdn.com.attacker.test/a', 'https://other.zjcdn.com/a',
    'https://vc-gate-edge.ndcpp.com/a', 'https://mon.zijieapi.com/a',
    'http://v3.douyinvod.com/a', 'https://user:pass@v3.douyinvod.com/a', 'blob:https://www.douyin.com/a', 'invalid']) {
    assert.equal(mediaURL(value), false, value);
  }
});

test('reported zjcdn host reaches parallel downloader without changing signed URL', async () => {
  const server = fixture();
  const transport = createTransport(server.native);
  const media = 'https://v3-dy-o.zjcdn.com/video/tos/cn/example?signature=secret';
  const response = await transport.fetch(media, { headers });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, SIZE));
  assert.equal(transport.stats.accelerated, 1);
  assert.equal(transport.stats.rangeKinds.bounded, 1);
  assert.ok(server.calls.every(call => call.request.url === media));
});

test('skip diagnostics distinguish missing, open-ended and small ranges without leaking headers', async () => {
  const transport = createTransport(async () => new Response('native', { headers: { 'Content-Type': 'video/mp4' } }));
  for (const value of [null, 'bytes=0-', 'bytes=0-1023']) {
    const response = await transport.fetch(url, { headers: value ? { Range: value } : {} });
    assert.equal(await response.text(), 'native');
  }
  assert.deepEqual(transport.stats.skipReasons, { 'range-missing': 1, 'range-open-ended': 1, 'range-too-small': 1 });
  assert.equal(transport.stats.lastResponse.strongETagVisible, false);
  assert.equal(transport.stats.lastResponse.contentRangeVisible, false);
  assert.equal(JSON.stringify(transport.stats).includes('secret'), false);
});

test('only bounded single ranges with safe integers are parsed', () => {
  assert.deepEqual(parseRange('bytes=10-20'), { start: 10, end: 20, length: 11 });
  for (const value of [null, 'bytes=1-', 'bytes=-12', 'bytes=2-1', 'bytes=1-2,3-4', 'bytes=0-9007199254740991']) {
    assert.equal(parseRange(value), null);
  }
});

test('concurrent, out-of-order chunks reconstruct exact bytes and response metadata', async () => {
  const server = fixture();
  const transport = createTransport(server.native);
  const response = await transport.fetch(url, { headers, credentials: 'include', referrerPolicy: 'no-referrer' });
  assert.equal(response.status, 206);
  assert.equal(response.url, url);
  assert.equal(response.type, 'cors');
  assert.equal(response.redirected, true);
  assert.equal(response.headers.get('Content-Range'), `bytes 0-${SIZE - 1}/${data.length}`);
  assert.equal(response.headers.get('Content-Length'), String(SIZE));
  const clone = response.clone();
  assert.equal(clone.url, url);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, SIZE));
  assert.deepEqual(new Uint8Array(await clone.arrayBuffer()), data.slice(0, SIZE));
  assert.equal(server.calls.length, 5);
  assert.ok(server.peak > 1 && server.peak <= 4);
  for (const call of server.calls) {
    assert.equal(call.request.url, url);
    assert.equal(call.request.credentials, 'include');
    assert.equal(call.request.referrerPolicy, 'no-referrer');
  }
  assert.equal(transport.stats.accelerated, 1);
  assert.equal(transport.stats.active, 0);
  assert.equal(transport.stats.jobs, 0);
});

test('nonzero uneven ranges are contiguous with no duplicate bytes', async () => {
  const server = fixture();
  const transport = createTransport(server.native, { settings: { enabled: true, concurrency: 6 } });
  const start = 123, end = start + SIZE + 7;
  const response = await transport.fetch(new Request(url, { headers: { Range: `bytes=${start}-${end}` } }));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(start, end + 1));
  const ranges = server.calls.map(call => call.range).sort((a, b) => a.start - b.start);
  assert.equal(ranges[0].start, start);
  assert.equal(ranges.at(-1).end, end);
  ranges.slice(1).forEach((range, i) => assert.equal(range.start, ranges[i].end + 1));
});

for (const [name, mutate, failure] of [
  ['ignored range', s => { s.status = 200; }, 'range-not-supported'],
  ['incorrect range', s => { s.headers['Content-Range'] = `bytes 1-131072/${data.length}`; }, 'invalid-content-range'],
  ['hidden range header', s => { delete s.headers['Content-Range']; }, 'invalid-content-range'],
  ['unknown total', s => { s.headers['Content-Range'] = 'bytes 0-131071/*'; }, 'invalid-content-range'],
  ['encoded body', s => { s.headers['Content-Encoding'] = 'gzip'; }, 'encoded-range'],
  ['HTML instead of video', s => { s.headers['Content-Type'] = 'text/html'; }, 'unsupported-media'],
  ['truncated body', s => { s.body = s.body.slice(0, -1); }, 'body-too-short'],
  ['oversized body', s => { s.body = new Uint8Array(s.body.length + 1); }, 'body-too-long']
]) {
  test(`${name}: discards probe and retries the original request once`, async () => {
    const server = fixture({ mutate(spec, call) { if (call.index === 0) mutate(spec); } });
    const transport = createTransport(server.native);
    const response = await transport.fetch(url, { headers });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, SIZE));
    assert.equal(server.calls.length, 2);
    assert.equal(server.calls[1].request.headers.get('Range'), headers.Range);
    assert.equal(transport.stats.lastFailure, failure);
    assert.equal(transport.stats.accelerated, 0);
    assert.equal(transport.stats.fallbacks, 1);
    await transport.fetch(url, { headers });
    assert.equal(server.calls.length, 3, 'host cooldown skips repeated probes');
  });
}

test('changed representation in a parallel chunk cancels siblings before fallback', async () => {
  const server = fixture({ mutate(spec, call) { if (call.index === 2) spec.headers.ETag = '"changed"'; } });
  const transport = createTransport(server.native);
  const response = await transport.fetch(url, { headers });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, SIZE));
  assert.equal(transport.stats.lastFailure, 'representation-changed');
  assert.equal(transport.stats.active, 0);
  assert.equal(transport.stats.accelerated, 0);
});

test('small MP4 ranges with CORS-hidden validators are assembled and counted', async () => {
  const server = fixture({ mutate(spec) { delete spec.headers.ETag; } });
  const transport = createTransport(server.native);
  const length = 192 * 1024;
  const response = await transport.fetch(url, { headers: { Range: `bytes=0-${length - 1}` } });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.slice(0, length));
  assert.equal(transport.stats.accelerated, 1);
  assert.equal(transport.stats.withoutStrongValidator, 1);
  assert.equal(server.calls[0].range.length, 16 * 1024);
  assert.equal(server.calls.length, 3);
  assert.deepEqual(transport.stats.rangeBytes, { min: length, max: length, recent: [length] });
  assert.equal(transport.stats.lastProbeResponse.strongETagVisible, false);
});

for (const change of ['total', 'modified', 'etag-appeared']) {
  test(`without a strong validator, a changed ${change} still causes fallback`, async () => {
    const server = fixture({ mutate(spec, call) {
      delete spec.headers.ETag;
      spec.headers['Last-Modified'] = 'Mon, 28 Sep 2026 00:00:00 GMT';
      if (call.index === 2) {
        if (change === 'total') spec.headers['Content-Range'] = spec.headers['Content-Range'].replace(`/${data.length}`, `/${data.length + 1}`);
        if (change === 'modified') spec.headers['Last-Modified'] = 'Tue, 29 Sep 2026 00:00:00 GMT';
        if (change === 'etag-appeared') spec.headers.ETag = '"new"';
      }
    } });
    const transport = createTransport(server.native);
    assert.deepEqual(new Uint8Array(await (await transport.fetch(url, { headers })).arrayBuffer()), data.slice(0, SIZE));
    assert.equal(transport.stats.lastFailure, 'representation-changed');
    assert.equal(transport.stats.accelerated, 0);
    assert.equal(transport.stats.withoutStrongValidator, 0);
    assert.equal(transport.stats.active, 0);
  });
}

test('caller cancellation propagates without fallback', async () => {
  const server = fixture({ delay: 20 });
  const transport = createTransport(server.native);
  const controller = new AbortController();
  const result = transport.fetch(url, { headers, signal: controller.signal });
  controller.abort(new DOMException('Cancelled by caller', 'AbortError'));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(server.calls.length, 1);
  assert.equal(transport.stats.fallbacks, 0);
  assert.equal(transport.stats.active, 0);
});

test('deadline aborts the probe and falls back', async () => {
  const server = fixture({ delay: 20 });
  const transport = createTransport(server.native, { timeoutMs: 5 });
  const response = await transport.fetch(url, { headers });
  assert.equal((await response.arrayBuffer()).byteLength, SIZE);
  assert.equal(transport.stats.fallbacks, 1);
  assert.equal(transport.stats.active, 0);
});

test('disabling cancels acceleration and preserves the player request via fallback', async () => {
  const server = fixture({ delay: 20 });
  const settings = { enabled: true, concurrency: 2 };
  const transport = createTransport(server.native, { settings });
  const result = transport.fetch(url, { headers });
  settings.enabled = false;
  transport.cancel();
  assert.equal((await (await result).arrayBuffer()).byteLength, SIZE);
  assert.equal(transport.stats.active, 0);
});

test('simultaneous player requests do not multiply accelerated concurrency', async () => {
  const server = fixture({ delay: 10 });
  const transport = createTransport(server.native);
  await Promise.all([transport.fetch(url, { headers }), transport.fetch(url, { headers })]);
  assert.equal(transport.stats.accelerated, 1);
  assert.equal(transport.stats.skipped, 1);
  assert.ok(transport.stats.peak <= 4);
});

test('unsupported and disabled requests preserve original input and init', async () => {
  for (const init of [undefined, { method: 'HEAD', headers }, { headers: { Range: 'bytes=0-' } },
    { headers: { Range: 'bytes=0-1023' } }, { headers: { Range: 'bytes=0-99999999' } },
    { headers: { ...headers, 'If-Range': '"old"' } }]) {
    const native = async (input, options) => { assert.equal(input, url); assert.equal(options, init); return 'native'; };
    assert.equal(await createTransport(native).fetch(url, init), 'native');
  }
  const init = { headers };
  const native = async (input, options) => { assert.equal(options, init); return input; };
  assert.equal(await createTransport(native).fetch('https://www.douyin.com/api', init), 'https://www.douyin.com/api');
  assert.equal(await createTransport(native, { settings: { enabled: false } }).fetch(url, init), url);
});

test('diagnostics do not expose request URL or raw network error message', async () => {
  let count = 0;
  const native = async () => {
    if (++count === 1) throw new TypeError(`Cannot fetch ${url}`);
    return new Response('native');
  };
  const transport = createTransport(native);
  await transport.fetch(url, { headers });
  assert.equal(transport.stats.lastFailure, 'network-or-abort');
  assert.equal(JSON.stringify(transport.stats).includes('secret'), false);
});
