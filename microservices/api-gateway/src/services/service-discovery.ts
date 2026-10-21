import axios from 'axios';
import { serviceConfig, ServiceConfig } from './service-config.js';

export interface ServiceHealthStatus {
  name: string;
  url: string;
  healthy: boolean;
}

export class ServiceDiscovery {
  private serviceHealth: Map<string, boolean> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHealthChecks();
  }

  private startHealthChecks() {
    // Initial health check
    this.checkAllServices();

    // Periodic health checks every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.checkAllServices();
    }, 30000);
  }

  private async checkAllServices() {
    for (const [serviceName, config] of Object.entries(serviceConfig)) {
      try {
        const response = await axios.get(`${config.url}${config.healthPath}`, {
          timeout: config.timeout,
        });

        const isHealthy = response.status === 200;
        this.serviceHealth.set(serviceName, isHealthy);

        if (!isHealthy) {
          console.warn(`Service ${serviceName} health check failed`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        console.error(`Service ${serviceName} is unhealthy:`, errorMessage);
        this.serviceHealth.set(serviceName, false);
      }
    }
  }

  public isServiceHealthy(serviceName: string): boolean {
    return this.serviceHealth.get(serviceName) || false;
  }

  public getServiceUrl(serviceName: string): string | null {
    const config = serviceConfig[serviceName];
    if (!config || !this.isServiceHealthy(serviceName)) {
      return null;
    }
    return config.url;
  }

  public getHealthStatus(): Record<string, ServiceHealthStatus> {
    const status: Record<string, ServiceHealthStatus> = {};

    for (const [serviceName, config] of Object.entries(serviceConfig)) {
      status[serviceName] = {
        name: config.name,
        url: config.url,
        healthy: this.isServiceHealthy(serviceName),
      };
    }

    return status;
  }

  public stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
