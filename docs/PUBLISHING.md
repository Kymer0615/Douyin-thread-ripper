# Publishing for Tampermonkey

The user requested publication once the script is proven to work. That condition is not yet met. Complete `VALIDATION.md` before publishing a release or submitting a listing.

1. Fix any unsupported common Douyin playback path revealed by live testing. Attach redacted diagnostics and repeat tests after changes.
2. Record the browser/Tampermonkey versions, compatibility results, and alternating performance trials. Document regressions and limit claims accordingly.
3. Update the version in `package.json`, changelog, status language, and listing text to reflect actual results. Keep upstream attribution in the README, script metadata and settings panel.
4. Run `npm run check`. Inspect the generated `user_scripts/douyin-thread-ripper.user.js`, metadata scope and permissions. Include the MIT notice in the distributed file.
5. Publish the validated GitHub commit/release to the configured repository, and submit the generated userscript to Greasy Fork using the owner's account. Account access will be needed for the listing.
6. Use Greasy Fork's assigned installation/update URL for that distribution. If also offering GitHub automatic updates, configure stable raw URLs after the release branch and workflow are established. Avoid competing update channels for the same installation.
7. Install from the actual public listing in a fresh browser profile and repeat a playback smoke check. Add verified installation links to README.

## Draft listing text

**Name:** Douyin Thread Ripper / 抖音线程撕裂者

**Attribution:** An inspired extension of MrTangLuyao's Bilibili-thread-ripper for Douyin. Independent and unofficial. Original project: https://github.com/MrTangLuyao/Bilibili-thread-ripper

**Description:** Concurrent byte-range downloading for supported Douyin web video requests. Keeps Douyin's existing player, validates chunks before returning them, and falls back to the original request if acceleration fails. Includes enable/disable controls and local diagnostics. No telemetry.

**Compatibility:** Fill in verified browser versions, supported transports and measured limitations from `VALIDATION.md` before submission. Do not advertise a general speedup without evidence.
