/**
 * Enumerates the GET routes of an express 4 app (recursing through mounted routers) as
 * templates such as /projects/:projectId/private. Mount shapes it cannot represent faithfully
 * (regexp mounts, optional params, custom regexps) are reported as `unsupported` entries
 * instead of being turned into malformed URLs. Used by route-inventory-preload.cjs and unit
 * tested against real mounted routers (anonymous-get-walker-h11.test.ts).
 */
const META = /[()[\]?+^$\\|]/;

/** The URL templates one router layer is mounted at, or null when the shape is not supported. */
function mountTemplates(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return [''];
  const keys = (layer.keys || []).map((k) => k.name);
  if (layer.keys && layer.keys.some((k) => k.optional)) return null;
  let keyIndex = 0;
  const alternatives = layer.regexp.source.split(/\|(?=\^\\\/)/); // arrays of paths: ^\/a\/?(?=\/|$)|^\/b\/?(?=\/|$)
  const out = [];
  for (const alt of alternatives) {
    let s = alt.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '');
    s = s.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => `/:${keys[keyIndex++] ?? 'param'}`);
    s = s.replace(/\\\/\(\.\*\)/g, () => { keyIndex += 1; return '/*'; });
    s = s.replace(/\\\//g, '/').replace(/\\\./g, '.');
    if (META.test(s.replace(/\*/g, ''))) return null;
    out.push(s);
  }
  return out;
}

/** Expands `/x/:id?` into `/x` and `/x/:id`; null for anything else the walker cannot represent. */
function expandRoutePath(p) {
  if (typeof p !== 'string') return null;
  const optional = /\/:[A-Za-z0-9_]+\?/g;
  let variants = [p];
  for (const m of p.match(optional) ?? []) {
    variants = variants.flatMap((v) => [v.replace(m, ''), v.replace(m, m.slice(0, -1))]);
  }
  variants = variants.map((v) => v || '/');
  return variants.some((v) => /[()[\]+^$\\|?]/.test(v)) ? null : [...new Set(variants)];
}

/**
 * express 4 hides a mounted sub-app behind a `mounted_app` closure. Record the sub-app on the layer
 * when it is mounted (call once, before any app code runs); the walker follows the record and
 * reports an unrecorded mounted_app as unsupported instead of dropping it.
 */
function installMountTracking(express) {
  const app = express.application;
  if (app.__h11MountTracking) return;
  const original = app.use;
  app.use = function trackedUse(...args) {
    const before = this._router ? this._router.stack.length : 0;
    const result = original.apply(this, args);
    const stack = this._router.stack;
    const subApps = args.filter((a) => typeof a === 'function' && typeof a.handle === 'function' && typeof a.set === 'function');
    const added = stack.slice(before).filter((l) => l.name === 'mounted_app');
    added.forEach((layer, i) => { if (subApps[i]) layer.handle.__h11SubApp = subApps[i]; });
    return result;
  };
  app.__h11MountTracking = true;
}

function walk(stack, prefixes, out) {
  for (const layer of stack) {
    if (layer.route) {
      if (layer.route.methods && (layer.route.methods.get || layer.route.methods._all)) {
        const declared = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const declaredPath of declared) {
          const expanded = expandRoutePath(declaredPath);
          if (expanded === null) {
            out.push({ kind: 'unsupported', path: `${prefixes[0] ?? ''}<route ${String(declaredPath)}>` });
            continue;
          }
          for (const p of expanded) for (const prefix of prefixes) out.push({ kind: layer.route.methods.get ? 'get' : 'all', path: `${prefix}${p}` || '/' });
        }
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const mounts = mountTemplates(layer);
      if (mounts === null) {
        out.push({ kind: 'unsupported', path: `${prefixes[0] ?? ''}<mount ${layer.regexp.source}>` });
        continue;
      }
      walk(layer.handle.stack, prefixes.flatMap((prefix) => mounts.map((m) => prefix + m)), out);
    } else if (layer.name === 'mounted_app') {
      const mounts = mountTemplates(layer);
      const sub = layer.handle && layer.handle.__h11SubApp;
      if (mounts === null || !sub || !sub._router) {
        out.push({ kind: 'unsupported', path: `${prefixes[0] ?? ''}<sub-app ${layer.regexp ? layer.regexp.source : ''}>` });
        continue;
      }
      walk(sub._router.stack, prefixes.flatMap((prefix) => mounts.map((m) => prefix + m)), out);
    } else if (layer.regexp && !layer.regexp.fast_slash) {
      const mounts = mountTemplates(layer);
      if (mounts === null) out.push({ kind: 'unsupported', path: `${prefixes[0] ?? ''}<use ${layer.regexp.source}>` });
      else for (const prefix of prefixes) for (const m of mounts) out.push({ kind: 'use', path: `${prefix}${m}` || '/', handler: layer.name || 'anonymous' });
    }
  }
}

function enumerateGetRoutes(app) {
  const out = [];
  walk(app._router.stack, [''], out);
  return out;
}

module.exports = { enumerateGetRoutes, mountTemplates, installMountTracking };
