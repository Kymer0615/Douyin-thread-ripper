// A fresh, unsigned-in Chrome profile. This is not a Tampermonkey integration test.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaURL } from '../src/transport.js';

const chromePath = process.env.DTR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const interactive = process.argv.includes('--interactive');
const output = new URL('../artifacts/browser-validation.json', import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'dtr-probe-'));
const chrome = spawn(chromePath, [...(interactive ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let sequence = 0, buffer = '';
const pending = new Map();
const traffic = { mediaResponses: 0, rangedMediaResponses: 0, fetch: 0, xhr: 0, media: 0, other: 0 };
const hosts = new Set();
let exited = false;
chrome.once('exit', () => {
  exited = true;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closed')); }
  pending.clear();
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    if (exited) { reject(new Error('Browser closed')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
chrome.stdio[4].on('data', data => {
  buffer += data.toString();
  while (buffer.includes('\0')) {
    const end = buffer.indexOf('\0');
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const task = pending.get(message.id);
    if (task) {
      clearTimeout(task.timer); pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    } else if (message.method === 'Network.responseReceived') {
      const { response, type } = message.params;
      if (type === 'Media' || /video\//i.test(response.mimeType) || mediaURL(response.url)) {
        traffic.mediaResponses++;
        hosts.add(new URL(response.url).hostname);
        if (response.status === 206) traffic.rangedMediaResponses++;
        const key = ({ Fetch: 'fetch', XHR: 'xhr', Media: 'media' })[type] || 'other';
        traffic[key]++;
      }
    }
  }
});
chrome.on('error', error => {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
  pending.clear();
});

try {
  const version = await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  const source = await readFile(new URL('../user_scripts/douyin-thread-ripper.user.js', import.meta.url), 'utf8');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (['www.douyin.com','douyin.com'].includes(location.hostname)) {\n${source}\n}`
  }, sessionId);
  const navigation = await send('Page.navigate', { url: 'https://www.douyin.com/' }, sessionId);
  if (interactive) console.log('Chrome is open with the script loaded. Complete any CAPTCHA/login and play a video. Diagnostics save automatically; no copy/paste needed.');
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  const started = Date.now();
  let playingSince = null, lastStatus = '', latest;
  const samples = [];
  do {
    await new Promise(resolve => setTimeout(resolve, interactive ? 5000 : 30000));
    if (exited) break;
    let result;
    try {
      result = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({captcha:/验证码/.test(document.title),panel:!!document.getElementById("douyin-thread-ripper"),report:window.__douyinThreadRipper?.report(),playback:[...document.querySelectorAll("video")].map(v=>({time:v.currentTime,paused:v.paused,readyState:v.readyState}))})',
        returnByValue: true
      }, sessionId);
    } catch (error) { if (exited) break; continue; } // Navigation can replace the execution context.
    const page = JSON.parse(result.result?.value || '{}');
    const previous = samples.at(-1)?.playback || [];
    const advancing = page.playback?.some((v, i) => !v.paused && v.readyState >= 2 && v.time > (previous[i]?.time ?? v.time));
    if (advancing) playingSince ??= Date.now();
    else playingSince = null;
    const accelerated = page.report?.stats.accelerated || 0;
    const status = page.captcha ? 'waiting-for-captcha' : accelerated ? 'parallel-transfers-observed' :
      advancing ? 'playback-without-acceleration' : 'waiting-for-playback';
    samples.push({ elapsedSeconds: Math.round((Date.now() - started) / 1000), status,
      report: page.report, playback: page.playback });
    latest = { date: new Date().toISOString(), browser: version.product,
      note: 'Isolated Chrome profile with CDP injection; not a Tampermonkey integration test or speedup benchmark.',
      status, navigationError: navigation.errorText || null, traffic, mediaHosts: [...hosts], page, samples };
    await writeFile(output, JSON.stringify(latest, null, 2) + '\n');
    if (status !== lastStatus) { console.log(`Status: ${status}; accelerated ranges: ${accelerated}. Report: ${output.pathname}`); lastStatus = status; }
    if (playingSince && Date.now() - playingSince >= 30000) break;
  } while (interactive && Date.now() - started < 10 * 60 * 1000);
  if (latest) console.log(JSON.stringify({ status: latest.status, traffic, report: output.pathname }, null, 2));
} finally {
  const hardStop = setTimeout(() => chrome.kill('SIGKILL'), 5000);
  chrome.kill('SIGTERM');
  await new Promise(resolve => { if (exited || chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  clearTimeout(hardStop);
  await rm(profile, { recursive: true, force: true });
}
