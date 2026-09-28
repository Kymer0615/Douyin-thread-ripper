import test from 'node:test';
import assert from 'node:assert/strict';
import { installFetchHook } from '../src/fetch-hook.js';

function fixture() {
  const calls = [];
  const root = { fetch(input, init) { calls.push({ input, init, receiver: this }); return Promise.resolve(input); } };
  let intercepted = 0;
  const transport = { fetch(input, init, dispatch) { intercepted++; return dispatch(input, init); } };
  const hook = installFetchHook(root, transport);
  return { root, hook, calls, get intercepted() { return intercepted; } };
}

test('later assignments retain page behavior and only intercept once', async () => {
  const f = fixture();
  const old = f.root.fetch;
  f.root.fetch = (input, init) => old(input + '/page', init);
  const init = { credentials: 'include' };
  assert.equal(await f.root.fetch('video', init), 'video/page');
  assert.equal(f.intercepted, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].receiver, f.root);
  assert.equal(f.calls[0].init, init);
  assert.equal(f.hook.report().installed, true);
  assert.equal(f.hook.report().assignments, 1);
});

test('asynchronous page wrapper chains do not recurse or duplicate acceleration', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    const old = f.root.fetch;
    f.root.fetch = async (input, init) => { await Promise.resolve(); return old(input + 'x', init); };
  }
  assert.equal(await f.root.fetch('a'), 'axxxxx');
  assert.equal(f.intercepted, 1);
  assert.equal(f.calls.length, 1);
});

test('defineProperty replacement can be recovered while preserving captured hook', async () => {
  const f = fixture();
  const old = f.root.fetch;
  Object.defineProperty(f.root, 'fetch', { value: input => old(input + 'x'), configurable: true, writable: true });
  assert.equal(f.hook.report().installed, false);
  f.hook.check();
  assert.equal(await f.root.fetch('a'), 'ax');
  assert.equal(f.intercepted, 1);
  assert.equal(f.hook.report().recoveries, 1);
});

test('self-assignment is ignored; immutable fetch reports failure without breaking it', async () => {
  const f = fixture();
  f.root.fetch = f.root.fetch;
  assert.equal(f.hook.report().assignments, 0);
  const root = {};
  Object.defineProperty(root, 'fetch', { value: () => 'native', configurable: false });
  const hook = installFetchHook(root, {});
  assert.equal(hook.report().installed, false);
  assert.equal(root.fetch(), 'native');
});
