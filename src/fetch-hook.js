// Keep later page wrappers in the call chain, including wrappers retaining old fetch.
export function installFetchHook(root, transport) {
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
