# Douyin Thread Ripper · 抖音线程撕裂者

**An inspired extension of [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper), adapted for Douyin (抖音).** This is an independent, unofficial implementation of its concurrent byte-range download idea, with no upstream affiliation or endorsement.

**本项目是受 Bilibili-thread-ripper 启发、面向抖音的扩展项目。** 感谢原作者 MrTangLuyao 和原项目贡献者提供的思路。

## Status: experimental; live parallel transfers observed, speedup unmeasured

Version 0.1.3 is an installable Tampermonkey prototype. A user-session report shows two successful parallel range downloads totaling 1,212,084 bytes, with four connections at peak and no fallbacks. Both completed without an exposed strong ETag. This confirms that the fetch adapter handled some live requests; it does not establish faster playback or full-site compatibility.

The same report shows the currently playing video using a direct HTTPS source, which is outside this adapter's coverage, alongside XHR/video traffic on other CDN hosts. Its approximately 69 seconds of buffer cannot be attributed to the script. Local checks pass all 29 automated tests. Public release remains pending the [compatibility and performance checklist](docs/VALIDATION.md).

The first adapter handles page-level `fetch` requests to HTTPS `douyinvod.com` media hosts and the observed `v3-dy-o.zjcdn.com` host with explicit `Range: bytes=start-end` headers. It probes 16 KiB, then downloads the remaining parts concurrently, checks their ranges, total sizes, media types and any visible validators, and returns the assembled response to the existing player. Signed URLs and request credentials are preserved. Failed acceleration falls back to the original request and pauses acceleration for that host for 60 seconds.

## Try locally with Tampermonkey

For an automated first playback check, run `npm run validate:browser`. This opens an isolated Chrome window, injects the script automatically and writes diagnostics to `artifacts/browser-validation.json` every five seconds. Complete any CAPTCHA/login in that window and play a video. The session ends after 30 seconds of observed advancing playback or ten minutes. No manual script installation or diagnostic copying is needed for this probe. It uses Chrome debugging injection; separately testing the actual Tampermonkey installation remains part of the release checklist.

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable userscript execution for your browser.
2. Open [`user_scripts/douyin-thread-ripper.user.js`](user_scripts/douyin-thread-ripper.user.js), copy the entire file, and paste it into a new Tampermonkey script. Save it.
3. Reload `https://www.douyin.com/`, play a video, and open the **DTR · 实验版** panel near the bottom right.
4. Check **并发成功** (successful parallel requests). A visible panel alone does not prove acceleration. Zero means no successful takeover has occurred.
5. Use **导出诊断** to copy a report, or run `window.__douyinThreadRipper.report()` in the page console. Report data contains counts, settings and playback state, without media URLs, cookies or headers.

Use the panel switch to compare enabled/disabled playback. Settings are stored locally on the Douyin origin; refresh between benchmark runs. The connection setting limits this script's transfers, not Douyin's other downloads. Disabling cancels ongoing acceleration and retries the player's original request.

## Current limits

- Only bounded fetch ranges between 128 KiB and 8 MiB are candidates; small, open-ended, full-file and oversized requests pass through.
- CDN responses need status 206, exact `Content-Range`, a known total size, MP4/octet-stream content type, and consistent visible `ETag`/`Last-Modified` values. `Content-Range` must be visible through CORS. A strong ETag is optional: without one, matching positions, lengths and metadata cannot rule out a same-size resource change. Such successful transfers are counted in `withoutStrongValidator`.
- Direct `<video src>` downloads, XMLHttpRequest, worker downloads, live streams, HLS, DASH-specific adapters and other CDN domains are not accelerated. No player replacement or CDN host rewriting is implemented.
- The entire requested range is buffered before returning it. This adds latency and transient memory use, and can be slower on a healthy connection. The first probe is sequential. Failed attempts also consume some extra traffic.
- Page-context injection, Douyin's actual player transport and CDN response headers still require browser verification. The implementation follows a possible integration route suggested by [ByteDance's public xgplayer loader](https://github.com/bytedance/xgplayer/blob/main/packages/xgplayer-streaming-shared/src/net/index.js); that source is not proof of Douyin's deployed configuration.
- Request metadata is preserved where practical, but synthesized response objects and full-range buffering are observable by the page.

There are no external runtime dependencies, privileged cross-origin requests or telemetry services. The script operates on requests the page already makes.

## Development

Node.js 20 or newer; no packages need installing.

```sh
npm run build   # regenerate the installable userscript from src/
npm test        # automated transport tests
npm run check   # build, syntax check and tests
```

Edit `src/transport.js` for downloading and `src/page.js` for the page hook, settings and diagnostics. The build is deterministic. Version metadata comes from `package.json`. Do not edit the generated userscript directly.

## Publication

Tampermonkey runs userscripts; its [userscript directory](https://www.tampermonkey.net/scripts.php) points to hosts such as Greasy Fork, OpenUserJS and GitHub. The proposed public distribution is **Greasy Fork plus this GitHub repository**, after live validation passes. No public installation URL or automatic update URL is advertised yet.

See [publication steps](docs/PUBLISHING.md) and [validation record](docs/VALIDATION.md). No listing has been submitted and no live speedup is claimed.

## Attribution and license

The project name and design are explicitly inspired by [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper), by MrTangLuyao and its contributors. This repository's implementation was written independently; no upstream source files are vendored. See [NOTICE.md](NOTICE.md). This project's code is [MIT licensed](LICENSE).
