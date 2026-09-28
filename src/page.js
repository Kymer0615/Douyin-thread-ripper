(() => {
  'use strict';
  if (window.__douyinThreadRipper) return;
  const VERSION = '__DTR_VERSION__';
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
