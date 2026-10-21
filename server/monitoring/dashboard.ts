import { cacheManager } from '../middleware/cache-performance.js';

// backend#1224: request paths are attacker-chosen; never interpolate them raw.
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface DashboardMetrics {
  performance: {
    avgResponseTime: number;
    totalRequests: number;
    requestsPerSecond: number;
    errorRate: number;
    uptime: number;
  };
  cache: {
    hitRate: number;
    missRate: number;
    totalHits: number;
    totalMisses: number;
    redisConnected: boolean;
    memoryCacheSize: number;
    memoryCacheMaxSize: number;
  };
  system: {
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
    timestamp: number;
  };
  endpoints: Array<{
    path: string;
    avgResponseTime: number;
    requestCount: number;
    errorCount: number;
    cacheHitRate: number;
  }>;
}

class MonitoringDashboard {
  private startTime: number;
  private endpointMetrics: Map<
    string,
    {
      totalTime: number;
      requestCount: number;
      errorCount: number;
      cacheHits: number;
      lastUpdated: number;
    }
  > = new Map();

  constructor() {
    this.startTime = Date.now();
  }

  recordRequest(
    endpoint: string,
    responseTime: number,
    isError: boolean = false,
    isCacheHit: boolean = false
  ): void {
    const current = this.endpointMetrics.get(endpoint) || {
      totalTime: 0,
      requestCount: 0,
      errorCount: 0,
      cacheHits: 0,
      lastUpdated: Date.now(),
    };

    current.totalTime += responseTime;
    current.requestCount += 1;
    current.errorCount += isError ? 1 : 0;
    current.cacheHits += isCacheHit ? 1 : 0;
    current.lastUpdated = Date.now();

    this.endpointMetrics.set(endpoint, current);
  }

  getDashboardMetrics(): DashboardMetrics {
    const cacheMetrics = cacheManager.getMetrics();
    const healthStatus = cacheManager.getHealthStatus();

    // Calculate overall metrics
    let totalRequests = 0;
    let totalResponseTime = 0;
    let totalErrors = 0;
    let totalCacheHits = 0;

    this.endpointMetrics.forEach(metric => {
      totalRequests += metric.requestCount;
      totalResponseTime += metric.totalTime;
      totalErrors += metric.errorCount;
      totalCacheHits += metric.cacheHits;
    });

    const avgResponseTime =
      totalRequests > 0 ? totalResponseTime / totalRequests : 0;
    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
    const uptime = Date.now() - this.startTime;
    const requestsPerSecond =
      totalRequests > 0 ? totalRequests / (uptime / 1000) : 0;

    // Prepare endpoint metrics
    const endpoints = Array.from(this.endpointMetrics.entries()).map(
      ([path, metric]) => ({
        path,
        avgResponseTime:
          metric.requestCount > 0 ? metric.totalTime / metric.requestCount : 0,
        requestCount: metric.requestCount,
        errorCount: metric.errorCount,
        cacheHitRate:
          metric.requestCount > 0 ? metric.cacheHits / metric.requestCount : 0,
      })
    );

    return {
      performance: {
        avgResponseTime,
        totalRequests,
        requestsPerSecond,
        errorRate,
        uptime,
      },
      cache: {
        hitRate:
          cacheMetrics.cacheHits /
            (cacheMetrics.cacheHits + cacheMetrics.cacheMisses) || 0,
        missRate:
          cacheMetrics.cacheMisses /
            (cacheMetrics.cacheHits + cacheMetrics.cacheMisses) || 0,
        totalHits: cacheMetrics.cacheHits,
        totalMisses: cacheMetrics.cacheMisses,
        redisConnected: cacheMetrics.cacheInfo.redis.connected,
        memoryCacheSize: cacheMetrics.cacheInfo.memoryCache.size,
        memoryCacheMaxSize: cacheMetrics.cacheInfo.memoryCache.maxSize,
      },
      system: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        timestamp: Date.now(),
      },
      endpoints: endpoints.sort((a, b) => b.requestCount - a.requestCount),
    };
  }

  generateHTMLDashboard(): string {
    const metrics = this.getDashboardMetrics();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WRFCoin API Performance Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #333;
            line-height: 1.6;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
            text-align: center;
        }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header p { font-size: 1.2em; opacity: 0.9; }
        
        .grid { display: grid; gap: 20px; }
        .grid-2 { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
        .grid-3 { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
        .grid-4 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
        
        .card {
            background: white;
            border-radius: 10px;
            padding: 25px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
            border: 1px solid #e1e8ed;
        }
        
        .card h3 { 
            color: #2c3e50;
            margin-bottom: 20px;
            font-size: 1.3em;
            display: flex;
            align-items: center;
        }
        
        .card h3::before {
            content: '';
            width: 4px;
            height: 20px;
            background: #3498db;
            margin-right: 10px;
            border-radius: 2px;
        }
        
        .metric { margin-bottom: 15px; }
        .metric-label { 
            font-weight: 600;
            color: #7f8c8d;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .metric-value { 
            font-size: 1.8em;
            font-weight: 700;
            color: #2c3e50;
        }
        
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .status-online { background: #27ae60; }
        .status-offline { background: #e74c3c; }
        
        .progress-bar {
            width: 100%;
            height: 8px;
            background: #ecf0f1;
            border-radius: 4px;
            overflow: hidden;
            margin-top: 5px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3498db, #2ecc71);
            transition: width 0.3s ease;
        }
        
        .endpoint-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        .endpoint-table th,
        .endpoint-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ecf0f1;
        }
        .endpoint-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
        }
        
        .performance-badge {
            padding: 4px 8px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: 600;
        }
        .badge-excellent { background: #d5f4e6; color: #27ae60; }
        .badge-good { background: #fef9e7; color: #f39c12; }
        .badge-poor { background: #fadbd8; color: #e74c3c; }
        
        .refresh-note {
            text-align: center;
            color: #7f8c8d;
            font-style: italic;
            margin-top: 30px;
        }
        
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .header { padding: 20px; }
            .header h1 { font-size: 2em; }
            .metric-value { font-size: 1.4em; }
        }
    </style>
    <script>
        // Auto-refresh every 30 seconds
        setTimeout(() => window.location.reload(), 30000);
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 WRFCoin API Performance Dashboard</h1>
            <p>Real-time monitoring of API performance, caching, and system metrics</p>
        </div>

        <!-- Performance Overview -->
        <div class="grid grid-4">
            <div class="card">
                <h3>Response Time</h3>
                <div class="metric">
                    <div class="metric-label">Average</div>
                    <div class="metric-value">${metrics.performance.avgResponseTime.toFixed(1)}ms</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${Math.min(100, 100 - metrics.performance.avgResponseTime)}%"></div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h3>Throughput</h3>
                <div class="metric">
                    <div class="metric-label">Requests/Second</div>
                    <div class="metric-value">${metrics.performance.requestsPerSecond.toFixed(1)}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Total Requests</div>
                    <div class="metric-value">${metrics.performance.totalRequests.toLocaleString()}</div>
                </div>
            </div>
            
            <div class="card">
                <h3>Error Rate</h3>
                <div class="metric">
                    <div class="metric-label">Errors</div>
                    <div class="metric-value">${(metrics.performance.errorRate * 100).toFixed(2)}%</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${Math.max(0, 100 - metrics.performance.errorRate * 100)}%; background: ${metrics.performance.errorRate < 0.01 ? '#27ae60' : '#e74c3c'}"></div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h3>Uptime</h3>
                <div class="metric">
                    <div class="metric-label">Duration</div>
                    <div class="metric-value">${Math.floor(metrics.performance.uptime / 60000)}m</div>
                </div>
            </div>
        </div>

        <!-- Cache Performance -->
        <div class="grid grid-2" style="margin-top: 30px;">
            <div class="card">
                <h3>Cache Performance</h3>
                <div class="metric">
                    <div class="metric-label">Hit Rate</div>
                    <div class="metric-value">${(metrics.cache.hitRate * 100).toFixed(1)}%</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${metrics.cache.hitRate * 100}%"></div>
                    </div>
                </div>
                <div class="metric">
                    <div class="metric-label">Cache Hits</div>
                    <div class="metric-value">${metrics.cache.totalHits.toLocaleString()}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Cache Misses</div>
                    <div class="metric-value">${metrics.cache.totalMisses.toLocaleString()}</div>
                </div>
            </div>
            
            <div class="card">
                <h3>Cache Status</h3>
                <div class="metric">
                    <div class="metric-label">Redis Connection</div>
                    <div class="metric-value">
                        <span class="status-indicator ${metrics.cache.redisConnected ? 'status-online' : 'status-offline'}"></span>
                        ${metrics.cache.redisConnected ? 'Connected' : 'Disconnected'}
                    </div>
                </div>
                <div class="metric">
                    <div class="metric-label">Memory Cache</div>
                    <div class="metric-value">${metrics.cache.memoryCacheSize}/${metrics.cache.memoryCacheMaxSize}</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${(metrics.cache.memoryCacheSize / metrics.cache.memoryCacheMaxSize) * 100}%"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- System Metrics -->
        <div class="grid grid-3" style="margin-top: 30px;">
            <div class="card">
                <h3>Memory Usage</h3>
                <div class="metric">
                    <div class="metric-label">Heap Used</div>
                    <div class="metric-value">${(metrics.system.memoryUsage.heapUsed / 1024 / 1024).toFixed(1)}MB</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Heap Total</div>
                    <div class="metric-value">${(metrics.system.memoryUsage.heapTotal / 1024 / 1024).toFixed(1)}MB</div>
                </div>
            </div>
            
            <div class="card">
                <h3>Performance Target</h3>
                <div class="metric">
                    <div class="metric-label">Sub-100ms Goal</div>
                    <div class="metric-value">
                        <span class="performance-badge ${metrics.performance.avgResponseTime < 100 ? 'badge-excellent' : metrics.performance.avgResponseTime < 200 ? 'badge-good' : 'badge-poor'}">
                            ${metrics.performance.avgResponseTime < 100 ? '✅ ACHIEVED' : metrics.performance.avgResponseTime < 200 ? '⚠️ CLOSE' : '❌ NEEDS WORK'}
                        </span>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h3>Cache Efficiency</h3>
                <div class="metric">
                    <div class="metric-label">Performance Gain</div>
                    <div class="metric-value">
                        <span class="performance-badge ${metrics.cache.hitRate > 0.7 ? 'badge-excellent' : metrics.cache.hitRate > 0.4 ? 'badge-good' : 'badge-poor'}">
                            ${metrics.cache.hitRate > 0.7 ? '🚀 EXCELLENT' : metrics.cache.hitRate > 0.4 ? '📈 GOOD' : '📉 NEEDS IMPROVEMENT'}
                        </span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Endpoint Performance -->
        <div class="card" style="margin-top: 30px;">
            <h3>Endpoint Performance</h3>
            <table class="endpoint-table">
                <thead>
                    <tr>
                        <th>Endpoint</th>
                        <th>Avg Response Time</th>
                        <th>Requests</th>
                        <th>Errors</th>
                        <th>Cache Hit Rate</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${metrics.endpoints
                      .map(
                        endpoint => `
                        <tr>
                            <td><code>${escapeHtml(endpoint.path)}</code></td>
                            <td>${endpoint.avgResponseTime.toFixed(1)}ms</td>
                            <td>${endpoint.requestCount.toLocaleString()}</td>
                            <td>${endpoint.errorCount}</td>
                            <td>${(endpoint.cacheHitRate * 100).toFixed(1)}%</td>
                            <td>
                                <span class="performance-badge ${endpoint.avgResponseTime < 50 ? 'badge-excellent' : endpoint.avgResponseTime < 100 ? 'badge-good' : 'badge-poor'}">
                                    ${endpoint.avgResponseTime < 50 ? 'Excellent' : endpoint.avgResponseTime < 100 ? 'Good' : 'Slow'}
                                </span>
                            </td>
                        </tr>
                    `
                      )
                      .join('')}
                </tbody>
            </table>
        </div>

        <div class="refresh-note">
            <p>📊 Dashboard auto-refreshes every 30 seconds • Last updated: ${new Date().toLocaleTimeString()}</p>
        </div>
    </div>
</body>
</html>
    `;
  }

  reset(): void {
    this.endpointMetrics.clear();
    this.startTime = Date.now();
  }
}

export const monitoringDashboard = new MonitoringDashboard();
export { MonitoringDashboard, DashboardMetrics };
