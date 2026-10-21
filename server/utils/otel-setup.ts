/**
 * OpenTelemetry Instrumentation Setup
 *
 * Provides distributed tracing, metrics reporting, and log correlation for the WRFCoin
 * backend services. The implementation gracefully handles missing dependencies so the server
 * can boot in environments where OpenTelemetry packages are not installed.
 */

import { appLogger } from './logger.js';

// Configuration from environment variables
const OTEL_CONFIG = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'wrfcoin-backend',
  serviceVersion: process.env.npm_package_version || '1.0.0',
  environment: process.env.NODE_ENV || 'development',
  traceExporterUrl:
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
  metricsExporterUrl:
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
  prometheusPort: parseInt(process.env.PROMETHEUS_METRICS_PORT || '9464', 10),
  enabled: process.env.OTEL_ENABLED !== 'false',
  debugEnabled: process.env.OTEL_DEBUG === 'true',
};

interface OpenTelemetryDependencies {
  NodeSDK: any;
  BatchSpanProcessor: any;
  getNodeAutoInstrumentations: any;
  OTLPTraceExporter: any;
  OTLPMetricExporter: any;
  PrometheusExporter: any;
  PeriodicExportingMetricReader: any;
  Resource: any;
  semanticAttributes: {
    SEMRESATTRS_SERVICE_NAME: string;
    SEMRESATTRS_SERVICE_VERSION: string;
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: string;
  };
  diag: any;
  DiagConsoleLogger: any;
  DiagLogLevel: any;
}

let sdk: any = null;
let initializationPromise: Promise<any> | null = null;
let initializationState:
  | 'idle'
  | 'disabled'
  | 'initializing'
  | 'initialized'
  | 'skipped_missing_dependencies'
  | 'failed' = 'idle';
let dependencyLoader: () => Promise<OpenTelemetryDependencies> = loadOtelDependencies;
let registeredShutdownHandler: (() => Promise<void>) | null = null;

async function loadOtelDependencies(): Promise<OpenTelemetryDependencies> {
  const [
    { NodeSDK },
    { BatchSpanProcessor },
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PrometheusExporter },
    { PeriodicExportingMetricReader },
    resourceModule,
    semanticConventions,
    { diag, DiagConsoleLogger, DiagLogLevel },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/exporter-prometheus'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/api'),
  ]);

  const Resource =
    (resourceModule as any).Resource || (resourceModule as any).default?.Resource || resourceModule;
  const {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  } = semanticConventions;

  return {
    NodeSDK,
    BatchSpanProcessor,
    getNodeAutoInstrumentations,
    OTLPTraceExporter,
    OTLPMetricExporter,
    PrometheusExporter,
    PeriodicExportingMetricReader,
    Resource,
    semanticAttributes: {
      SEMRESATTRS_SERVICE_NAME,
      SEMRESATTRS_SERVICE_VERSION,
      SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
    },
    diag,
    DiagConsoleLogger,
    DiagLogLevel,
  };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMissingDependencyError(error: unknown): boolean {
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const code = getErrorCode(current);
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      return true;
    }

    const message = getErrorMessage(current);
    if (/Cannot find (package|module)/i.test(message)) {
      return true;
    }

    if (typeof current === 'object' && current !== null && 'cause' in current) {
      queue.push((current as { cause?: unknown }).cause);
    }
  }

  return false;
}

function unregisterShutdownHandler(): void {
  if (!registeredShutdownHandler) {
    return;
  }

  process.off('SIGTERM', registeredShutdownHandler);
  process.off('SIGINT', registeredShutdownHandler);
  registeredShutdownHandler = null;
}

function registerShutdownHandler(): void {
  if (registeredShutdownHandler) {
    return;
  }

  registeredShutdownHandler = async () => {
    await shutdownOTel();
  };

  process.once('SIGTERM', registeredShutdownHandler);
  process.once('SIGINT', registeredShutdownHandler);
}

/**
 * Initialize OpenTelemetry instrumentation
 * Call this at the very start of your application before other imports
 */
export async function initializeOTel(): Promise<any> {
  if (!OTEL_CONFIG.enabled) {
    initializationState = 'disabled';
    return null;
  }

  appLogger.info('OpenTelemetry is enabled — resolving exporter endpoints', {
    traceExporterUrl: OTEL_CONFIG.traceExporterUrl,
    metricsExporterUrl: OTEL_CONFIG.metricsExporterUrl,
    prometheusPort: OTEL_CONFIG.prometheusPort,
  });

  if (sdk) {
    return sdk;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  if (
    initializationState === 'skipped_missing_dependencies' ||
    initializationState === 'failed'
  ) {
    return null;
  }

  initializationState = 'initializing';
  initializationPromise = (async () => {
    try {
      const deps = await dependencyLoader();

      if (OTEL_CONFIG.debugEnabled) {
        deps.diag.setLogger(new deps.DiagConsoleLogger(), deps.DiagLogLevel.DEBUG);
      }

      const resource = new deps.Resource({
        [deps.semanticAttributes.SEMRESATTRS_SERVICE_NAME]: OTEL_CONFIG.serviceName,
        [deps.semanticAttributes.SEMRESATTRS_SERVICE_VERSION]: OTEL_CONFIG.serviceVersion,
        [deps.semanticAttributes.SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: OTEL_CONFIG.environment,
      });

      const traceExporter = new deps.OTLPTraceExporter({
        url: OTEL_CONFIG.traceExporterUrl,
        headers: {},
      });

      const prometheusExporter = new deps.PrometheusExporter({
        port: OTEL_CONFIG.prometheusPort,
        preventServerStart: false,
      });
      void prometheusExporter;

      const otlpMetricExporter = new deps.OTLPMetricExporter({
        url: OTEL_CONFIG.metricsExporterUrl,
        headers: {},
      });

      const metricReader = new deps.PeriodicExportingMetricReader({
        exporter: otlpMetricExporter,
        exportIntervalMillis: 60_000,
      });

      sdk = new deps.NodeSDK({
        resource,
        spanProcessor: new deps.BatchSpanProcessor(traceExporter),
        metricReader,
        instrumentations: [
          deps.getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-http': {
              ignoreIncomingRequestHook: request =>
                request.url?.includes('/health') || request.url?.includes('/ready'),
            },
            '@opentelemetry/instrumentation-express': {
              enabled: true,
            },
            '@opentelemetry/instrumentation-pg': {
              enabled: true,
              enhancedDatabaseReporting: true,
            },
            '@opentelemetry/instrumentation-redis': {
              enabled: true,
            },
            '@opentelemetry/instrumentation-graphql': {
              enabled: true,
              mergeItems: true,
              depth: 3,
            },
            '@opentelemetry/instrumentation-fs': {
              enabled: false,
            },
            '@opentelemetry/instrumentation-dns': {
              enabled: false,
            },
          }),
        ],
      });

      await sdk.start();
      registerShutdownHandler();
      initializationState = 'initialized';

      appLogger.info('OpenTelemetry instrumentation initialized', {
        serviceName: OTEL_CONFIG.serviceName,
        serviceVersion: OTEL_CONFIG.serviceVersion,
        environment: OTEL_CONFIG.environment,
        traceExporterUrl: OTEL_CONFIG.traceExporterUrl,
        prometheusPort: OTEL_CONFIG.prometheusPort,
      });

      return sdk;
    } catch (error) {
      sdk = null;

      if (isMissingDependencyError(error)) {
        initializationState = 'skipped_missing_dependencies';
        appLogger.info('OpenTelemetry dependencies unavailable; skipping instrumentation', {
          error: getErrorMessage(error),
        });
        return null;
      }

      initializationState = 'failed';
      appLogger.warn('OpenTelemetry initialization skipped after startup error', { error });
      return null;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

/**
 * Shutdown the OpenTelemetry SDK gracefully
 */
export async function shutdownOTel(): Promise<void> {
  unregisterShutdownHandler();

  if (sdk) {
    try {
      await sdk.shutdown();
      sdk = null;
      initializationState = OTEL_CONFIG.enabled ? 'idle' : 'disabled';
      appLogger.info('OpenTelemetry SDK shut down successfully');
    } catch (error) {
      appLogger.error('Error shutting down OpenTelemetry SDK', { error });
      throw error;
    }
  } else if (initializationState === 'initialized') {
    initializationState = OTEL_CONFIG.enabled ? 'idle' : 'disabled';
  }
}

/**
 * Check if OpenTelemetry is enabled
 */
export function isOTelEnabled(): boolean {
  return OTEL_CONFIG.enabled && sdk !== null;
}

export function getOTelInitializationState(): typeof initializationState {
  return initializationState;
}

export function __setOTelDependencyLoaderForTests(
  loader: (() => Promise<OpenTelemetryDependencies>) | null
): void {
  dependencyLoader = loader || loadOtelDependencies;
}

export function __resetOTelForTests(): void {
  unregisterShutdownHandler();
  sdk = null;
  initializationPromise = null;
  initializationState = 'idle';
  dependencyLoader = loadOtelDependencies;
}

/**
 * Get OpenTelemetry configuration for inspection
 */
export function getOTelConfig(): typeof OTEL_CONFIG {
  return { ...OTEL_CONFIG };
}

export { sdk, OTEL_CONFIG };
