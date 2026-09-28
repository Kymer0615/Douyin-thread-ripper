# Changelog

## 0.1.3 — Unreleased small-range compatibility update

- Lower candidate range size from 512 KiB to 128 KiB and probe size from 128 KiB to 16 KiB. Use fewer connections for smaller ranges.
- Permit missing/weak ETags; still compare all visible ETags and Last-Modified values, final URLs, total sizes and media types. Require exact byte positions and lengths. Without a strong validator, an undetectable same-size resource change remains possible.
- Record recent request sizes, successful transfers without strong validators, and probe responses independently of native fallback responses.
- All 29 automated tests pass. Live speedup remains unverified.

## 0.1.2 — Unreleased CDN compatibility fix

- Admit `v3-dy-o.zjcdn.com`, observed in the user's live fetch diagnostics; retain range, media type and validator checks.
- Report skipped-request reasons, request range categories, and response validation-header availability without signed URLs or raw header values.
- Add regression coverage for this host and diagnostic categories; all 27 tests pass. Live acceleration is still pending verification.

## 0.1.1 — Unreleased compatibility fix

- Track later fetch assignments and recover configurable property replacements while preserving the page's wrappers.
- Avoid recursive interception when page wrappers retain earlier fetch references, including asynchronous wrappers.
- Add hook-call/replacement counters and resource counts by hostname and transport, without recording paths, query strings or headers.
- Add four hook regression tests; all 25 automated checks pass. Live acceleration remains unverified.

## 0.1.0 — Unreleased experimental prototype

- Independent Douyin userscript inspired by MrTangLuyao/Bilibili-thread-ripper, with visible attribution.
- Concurrent bounded fetch-range downloads with strong validators, cancellation, host cooldown and native fallback.
- Chinese settings panel and diagnostics without signed URLs or credentials.
- Dependency-free build, automated transport tests and live validation/publication checklist.
- Live Douyin compatibility and speedup remain unverified; no public release submitted.
