import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const header = `// ==UserScript==
// @name         Douyin Thread Ripper (Experimental)
// @name:zh-CN    抖音线程撕裂者（实验版）
// @namespace    https://github.com/Kymer0615/Douyin-thread-ripper
// @version      ${pkg.version}
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
`;
const source = await readFile(new URL('src/transport.js', root), 'utf8');
const hook = await readFile(new URL('src/fetch-hook.js', root), 'utf8');
const page = await readFile(new URL('src/page.js', root), 'utf8');
const license = await readFile(new URL('LICENSE', root), 'utf8');
await mkdir(new URL('user_scripts/', root), { recursive: true });
await writeFile(new URL('user_scripts/douyin-thread-ripper.user.js', root),
  header + '\n/*\n' + license + '*/\n\n(() => {\n\'use strict\';\n' + source.replace(/^export /gm, '') + '\n' +
  hook.replace(/^export /gm, '') + '\n' + page.replaceAll('__DTR_VERSION__', pkg.version) + '\n})();\n');
console.log(`Built experimental userscript ${pkg.version}`);
