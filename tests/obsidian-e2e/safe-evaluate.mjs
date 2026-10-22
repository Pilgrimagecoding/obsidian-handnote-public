// R16 (see docs/RELEASE_READINESS_AUDIT.md): when page.evaluate returns an Obsidian object (a
// TFile from vault.create, a leaf, a view …), Playwright serialises it in its own isolated world
// and walks the whole object graph: app → window → require cache → Electron's lazy module getters.
// After a settings tab with a SecretComponent (core Keychain tab or HandNote's) has been opened,
// that walk reaches Electron's `nativeImage` getter, which calls process._linkedBinding from a
// context without a Node environment, and the renderer segfaults in
// node::binding::GetLinkedBinding. The crash needs no plugin at all (core Keychain tab + a returned
// TFile, HandNote disabled). Users never run this code path; the tests must not either.
//
// guardEvaluate(page) makes page.evaluate return only plain data: primitives, arrays and plain
// objects that survive JSON; anything else comes back as a short "[ClassName]" string.
export function guardEvaluate(page) {
  const orig = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => {
    if (typeof fn !== 'function') return orig(fn, arg);
    return orig(
      async ([src, arg]) => {
        const f = (0, eval)(`(${src})`);
        const v = await f(arg);
        if (v === null || v === undefined || typeof v !== 'object') return typeof v === 'function' ? '[function]' : v;
        const proto = Object.getPrototypeOf(v);
        if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return `[${v.constructor?.name ?? 'object'}]`;
        try {
          return JSON.parse(JSON.stringify(v));
        } catch {
          return `[unserialisable ${Array.isArray(v) ? 'array' : 'object'}]`;
        }
      },
      [fn.toString(), arg],
    );
  };
  return page;
}
