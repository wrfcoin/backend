import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { Request, Response } from 'express';
import { ServiceDiscovery } from '../services/service-discovery.js';
import { appLogger } from '../../../../server/utils/logger.js';

export function createServiceProxy(
  serviceName: string,
  serviceDiscovery: ServiceDiscovery
) {
  const proxyOptions: Options = {
    target: '', // Will be set dynamically
    changeOrigin: true,
    router: (req: Request) => {
      const serviceUrl = serviceDiscovery.getServiceUrl(serviceName);
      if (!serviceUrl) {
        throw new Error(`Service ${serviceName} is not available`);
      }
      return serviceUrl;
    },
    onError: (err: Error, req: Request, res: Response) => {
      appLogger.error(`Proxy error for ${serviceName}`, {
        operation: 'proxy:error',
        serviceName,
        error: { name: err.name, message: err.message },
      });
      if (!res.headersSent) {
        res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: `Service ${serviceName} is currently unavailable`,
            details: err.message,
          },
          timestamp: new Date().toISOString(),
        });
      }
    },
    onProxyReq: (proxyReq, req: Request, res: Response) => {
      appLogger.debug(`Proxying request to ${serviceName}`, {
        operation: 'proxy:request',
        method: req.method,
        path: req.path,
        serviceName,
      });
    },
  };

  return createProxyMiddleware(proxyOptions);
}
