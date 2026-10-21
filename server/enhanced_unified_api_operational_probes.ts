// create-health-middleware.js is CJS; import the .cjs shim for ESM compatibility.
import _healthMwMod from './middleware/create-health-middleware.js';
type HealthMiddlewareResult = {
  router: import('express').Router;
  state: { draining: boolean };
  markDraining(): void;
  clearDraining(): void;
  evaluateDependencies: () => Promise<Record<string, { status: string; critical?: boolean; [k: string]: unknown }>>;
  healthHandler: import('express').RequestHandler;
  readinessHandler: import('express').RequestHandler;
  livenessHandler: import('express').RequestHandler;
};
const { createHealthMiddleware, sendProbe } = _healthMwMod as {
  createHealthMiddleware: (...args: unknown[]) => HealthMiddlewareResult;
  sendProbe: (req: any, res: any, statusCode: number, body: Record<string, unknown>) => void;
};

export interface EnhancedApiProbeState {
  draining: boolean;
}

export interface EnhancedApiCacheHealth {
  status?: string;
}

export interface SafeMountStatusDetail {
  mountPath: string;
  modulePath: string;
  reason?: string;
}

export interface SafeMountReadinessState {
  requiredMissing: SafeMountStatusDetail[];
  optionalMissing: SafeMountStatusDetail[];
}

export interface Core4ReadinessResult {
  status?: string;
  readinessStatus?: string | null;
  reachable?: boolean;
  url?: string;
  httpStatus?: number | null;
  lastError?: string | null;
}

export interface EnhancedApiOperationalProbeOptions {
  state: EnhancedApiProbeState;
  getCacheHealthStatus: () => EnhancedApiCacheHealth | Promise<EnhancedApiCacheHealth>;
  /**
   * #758: optional core4 readiness probe. When supplied, readiness (`/api/ready`)
   * gates on core4 returning ready from `/readyz`, so the API does not report a
   * false GO while the chain is not launch-ready. Liveness (`/api/live`) and the
   * top-level `/health` endpoint are intentionally NOT gated on this, so a
   * not-ready chain does not flap container liveness/restarts.
   */
  probeCore4Readiness?: () => Core4ReadinessResult | Promise<Core4ReadinessResult>;

  /**
   * #950: safeMount inventory from the live startup path. Required misses must
   * fail /api/ready while optional misses remain visible but non-blocking.
   */
  safeMountReadiness?:
    | SafeMountReadinessState
    | (() => SafeMountReadinessState | Promise<SafeMountReadinessState>);
}

function mapCacheDependency(cacheHealth: EnhancedApiCacheHealth) {
  const sourceStatus =
    typeof cacheHealth?.status === 'string' ? cacheHealth.status : 'unknown';

  return {
    status:
      sourceStatus === 'healthy'
        ? 'up'
        : sourceStatus === 'degraded'
          ? 'degraded'
          : 'down',
    sourceStatus,
    details: cacheHealth ?? {},
  };
}

function mapCore4Dependency(result: Core4ReadinessResult) {
  const ready = result?.status === 'up';
  return {
    // `up` only when core4 reports ready; otherwise `down` so the readiness
    // dependency (critical) flips /api/ready to not_ready.
    status: ready ? 'up' : 'down',
    readinessStatus: result?.readinessStatus ?? null,
    reachable: result?.reachable ?? false,
    url: result?.url,
    httpStatus: result?.httpStatus ?? null,
    error: ready ? undefined : result?.lastError ?? 'core4 not ready',
  };
}

export function createEnhancedApiOperationalProbes(
  options: EnhancedApiOperationalProbeOptions
) {
  const {
    state,
    getCacheHealthStatus,
    probeCore4Readiness,
    safeMountReadiness,
  } = options;

  // Cache is a soft dependency (#812): degraded/absent cache must not gate
  // /health. critical:false means the middleware still reports cache status in
  // the payload but does not flip the HTTP status to 503.
  const dependencies: Record<string, unknown> = {
    cache: {
      critical: false,
      check: async () => mapCacheDependency(await getCacheHealthStatus()),
    },
  };

  // #758: gate readiness — but NOT liveness/health — on core4 /readyz.
  // The shared middleware applies critical deps to both /health and /ready,
  // which would couple core4 not-ready into liveness. To keep /health as
  // liveness, core4 is registered as a NON-critical dependency here (so it
  // surfaces in both payloads for observability) and the readiness handler is
  // overridden below to treat it as a hard gate for /api/ready only.
  if (typeof probeCore4Readiness === 'function') {
    dependencies.core4 = {
      critical: false,
      check: async () => mapCore4Dependency(await probeCore4Readiness()),
    };
  }

  dependencies.safeMounts = {
    critical: false,
    check: async () => {
      const state =
        typeof safeMountReadiness === 'function'
          ? await safeMountReadiness()
          : safeMountReadiness;

      const requiredMissing =
        state && Array.isArray(state.requiredMissing)
          ? state.requiredMissing
          : [];
      const optionalMissing =
        state && Array.isArray(state.optionalMissing)
          ? state.optionalMissing
          : [];

      if (requiredMissing.length > 0) {
        return {
          status: 'down',
          requiredMissing,
          optionalMissing,
          details: {
            requiredMissingCount: requiredMissing.length,
            optionalMissingCount: optionalMissing.length,
          },
          error: 'required safeMount route(s) were not loaded',
        };
      }

      return {
        status: optionalMissing.length > 0 ? 'degraded' : 'up',
        requiredMissing,
        optionalMissing,
        details: {
          requiredMissingCount: requiredMissing.length,
          optionalMissingCount: optionalMissing.length,
        },
      };
    },
  };

  const middleware = createHealthMiddleware(
    'enhanced-unified-api-optimized',
    dependencies,
    { state }
  );

  const hasSafeMountReadiness = safeMountReadiness !== undefined;
  if (typeof probeCore4Readiness === 'function' || hasSafeMountReadiness) {
    // #758: core4 readiness is a hard gate for /api/ready only. /health keeps
    // treating core4 as non-critical (liveness preserved). Define the gated
    // handler once and use it for both the route and the exposed method so
    // direct-call test harnesses see the same behaviour as HTTP traffic.
    const gatedReadinessHandler = async (req: any, res: any) => {
      const deps = await middleware.evaluateDependencies();
      const criticalUnavailable = Object.values(deps).some(
        (dep: any) => dep.critical && dep.status !== 'up'
      );
      const core4NotReady =
        typeof probeCore4Readiness === 'function'
          ? !!(deps.core4 && deps.core4.status !== 'up')
          : false;
      const safeMountMissing =
        hasSafeMountReadiness &&
        Array.isArray((deps as any).safeMounts?.requiredMissing) &&
        (deps as any).safeMounts.requiredMissing.length > 0;
      const ready =
        !state.draining && !criticalUnavailable && !core4NotReady && !safeMountMissing;

      // backend#1224: safeMount module paths and errors are operator detail.
      sendProbe(req, res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        service: 'enhanced-unified-api-optimized',
        timestamp: new Date().toISOString(),
        draining: state.draining,
        dependencies: deps,
      });
    };

    // Replace the readiness route registered by createHealthMiddleware.
    middleware.router.stack = middleware.router.stack.filter(
      (layer: any) => !(layer.route && layer.route.path === '/ready')
    );
    middleware.router.get('/ready', gatedReadinessHandler);
    middleware.readinessHandler = gatedReadinessHandler;
  }

  return middleware;
}
