# Live validation record

Release state: **PENDING — live parallel fetch transfers observed; broader playback compatibility and performance comparison remain incomplete.**

Automated transport tests use synthetic MP4-shaped byte responses. They validate transport behavior, not playable media, CORS behavior, userscript injection or live site compatibility.

## Record the environment

Date, commit/version, operating system, browser/version, Tampermonkey/version, country/ISP, login state, and video IDs. Do not publish cookies or signed CDN URLs. Record the public page URL only when appropriate.

## Compatibility gate

- [ ] Install the generated script and confirm the panel appears after a hard reload.
- [x] Confirm `fetchHookInstalled: true` in the diagnostic report.
- [ ] On actual playback, `stats.accelerated` increases; corroborate with concurrent 206 range requests in DevTools. Do not count the panel, candidate requests or native buffering as proof.
- [ ] Check startup, seek, pause/resume, mute/volume, speed, quality selection, fullscreen, looping, feed swipes, back/forward and SPA navigation. Observe for at least ten minutes, including long videos and rapid swipes.
- [ ] Confirm failed/expired requests recover and swiping does not leave script transfers running indefinitely (eight-second deadline).
- [ ] Disable the script and confirm subsequent requests use native playback.
- [ ] Record which paths do not accelerate: native video, XHR, workers, live or CDN headers hidden by CORS. If the common playback path is unsupported, add an adapter before declaring support.

If successful parallel requests stay at zero, export diagnostics and inspect one media request's initiator, hostname, Range, status, Content-Type, Content-Range and whether ETag is exposed. Share redacted header names/values and transport type, not a full HAR containing credentials. This evidence determines the next adapter; do not guess a private API or change signed hosts.

## Performance gate

Use the same video IDs, quality, connection and account for alternating enabled/disabled runs. Disable the browser cache consistently, control other traffic and refresh between runs. Run at least five trials per condition on both short and long videos. Separate warm-cache results from cold-cache results.

| Video / duration / quality | Condition | Startup ms | Rebuffer count | Rebuffer duration ms | Downloaded bytes | Successful ranges |
| --- | --- | --- | --- | --- | --- | --- |
| Pending | Disabled | — | — | — | — | — |
| Pending | Enabled | — | — | — | — | — |

Record medians and individual trials. The report's `waiting` event count is only a diagnostic hint; it includes startup/seeking and is not a rebuffer duration measurement. Accept only if the intended slow-network cases improve with no substantial startup, correctness, traffic or memory regression. Narrow public compatibility claims to the browsers and playback paths actually tested.

## Evidence

- User-supplied 0.1.3 report: hook installed, eight assignments handled, 25 intercepted calls; 14 media candidates, two successful parallel transfers totaling 1,212,084 bytes, peak four connections, zero fallbacks, one caller cancellation. Eight small-range skips and three concurrency skips. Both successful transfers lacked a visible strong validator. This is the first observed live success of the fetch transport; consumption of those specific bytes by the active video is not established by the report.
- The same report's active video uses HTTPS directly (readyState 4, approximately 69.2 seconds buffered); a paused blob video has approximately 11.2 seconds buffered. Additional XHR/direct-video traffic appears on `v5-dy-ov-experiment.zjcdn.com` and `v5-hl-mly-ov.zjcdn.com`. Those transports remain outside the current adapter. Buffering on the active native video is not evidence of script speedup. Exact browser/Tampermonkey versions, public video IDs and enabled/disabled comparisons remain pending.

- User-supplied 0.1.2 report: eight bounded media candidates, six ranges below 512 KiB, one concurrency skip and one caller cancellation. No completed acceleration or fallback. The latest native MP4 response was 206 with valid Content-Range but no visible strong ETag. Version 0.1.3 reduces the minimum range/probe sizes and tolerates unexposed validators, with consistency checks and explicit diagnostic counts. All 29 local tests pass; live retest pending.
- User-supplied 0.1.1 report: fetch hook installed, eight assignments handled, 29 intercepted calls; 16 resource entries for fetch on `v3-dy-o.zjcdn.com`, with zero eligible candidates. The host was absent from the filter. Version 0.1.2 adds this exact hostname; all 27 local tests pass. The report did not contain range or response-header information, so actual acceleration remains unverified.
- User-supplied 0.1.0 report: blob video playing with readyState 4 and approximately 5.39 seconds buffered; `fetchHookInstalled: false`; zero candidates and accelerated requests. This does not identify whether playback uses XHR, a worker, an unrecognized CDN, or a replaced fetch path.
- 0.1.1 local check: `npm run check` passes all 25 tests, including four fetch-wrapper regression tests. User-session retest pending.
- Automated check (2026-09-28, local 0.1.0): `npm run check` passed; generated userscript syntax valid; 21 transport tests passed. Re-run for the final release commit.
- Isolated browser probe (2026-09-28): Chrome/154.0.8037.57, fresh headless profile, document-start injection through CDP. Douyin navigated to **验证码中间页** (CAPTCHA intermediary page). The panel appeared and `fetchHookInstalled` was true. Zero media responses, zero candidates, zero accelerated requests, and no video elements were observed. No CAPTCHA bypass was attempted. This checks page-context startup only and does not verify Tampermonkey injection or playback.
- Chrome/Chromium with Tampermonkey in the user's normal session: diagnostic reports received through 0.1.3; successful parallel fetch transfers observed. Full compatibility checks and exact environment versions remain pending.
- Playback comparison: pending.
- Public publication: pending.

To repeat the isolated probe on macOS, run `node scripts/browser-probe.mjs`. It launches installed Chrome with a temporary profile, observes the public homepage for 30 seconds, prints a report without signed media URLs, and removes the temporary profile. Set `DTR_CHROME_PATH` to use another Chrome executable. It does not install Tampermonkey or access your regular browser profile.
