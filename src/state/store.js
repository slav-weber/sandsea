/**
 * Minimal reactive store: shallow key→value map with per-key subscriptions
 * and a global subscriber. No magic, no proxies — explicit `set(key, value)`.
 */
export function createStore(initial) {
  const state = { ...initial };
  const keySubs = new Map();
  const globalSubs = new Set();

  function get(key) {
    return key == null ? state : state[key];
  }

  function set(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    const subs = keySubs.get(key);
    if (subs) for (const fn of subs) fn(value, key);
    for (const fn of globalSubs) fn(key, value);
  }

  function patch(partial) {
    for (const k of Object.keys(partial)) set(k, partial[k]);
  }

  function subscribe(key, fn) {
    if (typeof key === 'function') {
      globalSubs.add(key);
      return () => globalSubs.delete(key);
    }
    let subs = keySubs.get(key);
    if (!subs) {
      subs = new Set();
      keySubs.set(key, subs);
    }
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function subscribeMany(keys, fn) {
    const unsubs = keys.map((k) => subscribe(k, fn));
    return () => unsubs.forEach((u) => u());
  }

  return { get, set, patch, subscribe, subscribeMany };
}
