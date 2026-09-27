"use strict";

// Bundled, trusted features. Private factory scopes work in Electron and
// Pocket without a bundler or file:// ES-module exceptions in browser tests.
const NeoPlugins = (() => {
  const definitions = new Map();
  const active = new Map();
  let adapter;
  let transitioning = Promise.resolve();
  function define(id, descriptor, create) {
    if (definitions.has(id)) throw new Error(`Duplicate plugin: ${id}`);
    definitions.set(id, { id, scope: "author", ...descriptor, create });
  }
  function available(p) {
    return (p.requires || []).every((key) => adapter.capabilities[key]);
  }
  function enabled(id) {
    const p = definitions.get(id);
    return !!p && available(p) && adapter.enabled(p);
  }
  function invoke(instance, method, args) {
    try { return instance.api[method]?.(...args); }
    catch (error) { adapter.report(error); }
  }
  function notify(event, ...args) {
    for (const instance of active.values()) {
      const result = invoke(instance, event, args);
      if (result?.catch) result.catch(adapter.report);
    }
  }
  async function dispose(id) {
    const instance = active.get(id);
    if (!instance) return;
    // Do not discard in-memory plugin data until its writes have landed.
    await instance.context.flush();
    active.delete(id);
    try { await instance.api.dispose?.(); }
    finally { await instance.context.close(); }
  }
  function reconcile() {
    const run = async () => {
      for (const [id, instance] of active) {
        const p = definitions.get(id);
        if (!enabled(id) || instance.key !== adapter.contextKey(p)) await dispose(id);
      }
      for (const p of definitions.values()) {
        if (!enabled(p.id) || active.has(p.id)) continue;
        const context = adapter.context(p);
        try {
          const api = await p.create(context);
          active.set(p.id, { key: adapter.contextKey(p), context, api: api || {} });
        } catch (error) { await context.close(); adapter.report(error); }
      }
      notify("refresh");
    };
    transitioning = transitioning.then(run, run);
    return transitioning;
  }
  async function setEnabled(id, value) {
    const p = definitions.get(id);
    if (!p || !available(p)) return;
    await adapter.setEnabled(p, value);
    await reconcile();
    adapter.refreshViews();
  }
  return {
    define, enabled, reconcile, notify, setEnabled,
    configure(value) { adapter = value; },
    list: () => [...definitions.values()].map((p) => ({ ...p, available: available(p), enabled: enabled(p.id) })),
    call(id, method, ...args) { return active.get(id)?.api[method]?.(...args); },
    contribute(method, ...args) {
      const items = [...active.values()].map((p) => invoke(p, method, args)).filter(Boolean);
      return { save: () => Promise.all(items.map((p) => p.save?.())), dispose: () => items.forEach((p) => p.dispose?.()) };
    },
    async closeBook() {
      await transitioning;
      for (const [id] of active) if (definitions.get(id).bookScoped) await dispose(id);
      notify("bookClosed");
    },
    async flush() {
      await Promise.all([...active.values()].map((p) => p.context.flush()));
    },
    render(slot, ...args) {
      for (const p of active.values()) if (invoke(p, slot, args)) return true;
      return false;
    }
  };
})();
