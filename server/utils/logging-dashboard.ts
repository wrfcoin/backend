/**
 * Logging Dashboard and Monitoring Integration - Task 67.4
 *
 * Real-time dashboard for monitoring logging infrastructure, performance
 * metrics, security events, and system health for the WRFCoin platform.
 */

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  logMonitor,
  alertManager,
  LogAnalyzer,
  LogMetrics,
} from './log-analyzer.js';
import { appLogger, performanceLogger, securityLogger } from './logger.js';

// Dashboard data aggregator
export class LoggingDashboard {
  private static instance: LoggingDashboard;
  private dashboardData: any = {};
  private updateInterval: NodeJS.Timeout;

  private constructor() {
    // Update dashboard data every 10 seconds
    this.updateInterval = setInterval(() => {
      this.updateDashboardData();
    }, 10000);

    // Set up real-time event listeners
    this.setupEventListeners();
  }

  static getInstance(): LoggingDashboard {
    if (!LoggingDashboard.instance) {
      LoggingDashboard.instance = new LoggingDashboard();
    }
    return LoggingDashboard.instance;
  }

  private setupEventListeners(): void {
    // Listen to log monitor events
    logMonitor.on('metricsUpdate', (metrics: LogMetrics) => {
      this.dashboardData.realTimeMetrics = metrics;
      this.dashboardData.lastUpdate = new Date().toISOString();
    });

    logMonitor.on('alert', (alert: any) => {
      if (!this.dashboardData.recentAlerts) {
        this.dashboardData.recentAlerts = [];
      }
      this.dashboardData.recentAlerts.unshift(alert);
      // Keep only last 50 alerts
      if (this.dashboardData.recentAlerts.length > 50) {
        this.dashboardData.recentAlerts = this.dashboardData.recentAlerts.slice(
          0,
          50
        );
      }
    });
  }

  private async updateDashboardData(): Promise<void> {
    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // System metrics
      this.dashboardData.systemMetrics = {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        nodeVersion: process.version,
        platform: process.platform,
        timestamp: now.toISOString(),
      };

      // Log file sizes and status
      this.dashboardData.logFiles = await this.getLogFileStatus();

      // Alert statistics
      this.dashboardData.alertStats = alertManager.getAlertStatistics();

      // Service health (simplified)
      this.dashboardData.serviceHealth = {
        logging: true,
        monitoring: true,
        security: true,
        performance: true,
        graphql: true,
      };

      // Performance trends (last hour)
      this.dashboardData.performanceTrends = await this.getPerformanceTrends(
        oneHourAgo,
        now
      );
    } catch (error) {
      appLogger.error('Failed to update dashboard data', {
        error: (error as Error).message,
      });
    }
  }

  private async getLogFileStatus(): Promise<any> {
    const logsDir = path.join(process.cwd(), 'logs');
    const logFiles = [
      'combined.log',
      'error.log',
      'performance.log',
      'security.log',
      'graphql.log',
      'crosschain.log',
      'iot.log',
      'weather.log',
    ];

    const fileStats: any = {};

    for (const filename of logFiles) {
      const filepath = path.join(logsDir, filename);
      try {
        if (fs.existsSync(filepath)) {
          const stats = fs.statSync(filepath);
          fileStats[filename] = {
            size: stats.size,
            sizeMB: (stats.size / 1024 / 1024).toFixed(2),
            lastModified: stats.mtime.toISOString(),
            exists: true,
          };
        } else {
          fileStats[filename] = {
            exists: false,
          };
        }
      } catch (error) {
        fileStats[filename] = {
          exists: false,
          error: (error as Error).message,
        };
      }
    }

    return fileStats;
  }

  private async getPerformanceTrends(
    startTime: Date,
    endTime: Date
  ): Promise<any> {
    // This would normally read from a time-series database
    // For now, return simulated data
    return {
      avgResponseTime: 150,
      p95ResponseTime: 300,
      errorRate: 2.1,
      requestsPerSecond: 45,
      memoryTrend: 'stable',
      cpuTrend: 'stable',
      timeRange: {
        start: startTime.toISOString(),
        end: endTime.toISOString(),
      },
    };
  }

  getDashboardData(): any {
    return {
      ...this.dashboardData,
      generatedAt: new Date().toISOString(),
    };
  }

  cleanup(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
  }
}

// Dashboard API endpoints
export function createDashboardEndpoints() {
  const dashboard = LoggingDashboard.getInstance();

  return {
    // Main dashboard data
    getDashboard: (req: Request, res: Response) => {
      try {
        const dashboardData = dashboard.getDashboardData();
        res.json({
          status: 'success',
          data: dashboardData,
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get dashboard data',
          error: (error as Error).message,
        });
      }
    },

    // Real-time metrics
    getMetrics: (req: Request, res: Response) => {
      try {
        const dashboardData = dashboard.getDashboardData();
        res.json({
          status: 'success',
          data: {
            realTimeMetrics: dashboardData.realTimeMetrics || {},
            systemMetrics: dashboardData.systemMetrics || {},
            performanceTrends: dashboardData.performanceTrends || {},
          },
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get metrics',
          error: (error as Error).message,
        });
      }
    },

    // Alerts endpoint
    getAlerts: (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string, 10) || 50;
        const alerts = alertManager.getRecentAlerts(limit);
        const stats = alertManager.getAlertStatistics();

        res.json({
          status: 'success',
          data: {
            alerts,
            statistics: stats,
          },
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get alerts',
          error: (error as Error).message,
        });
      }
    },

    // Log analysis endpoint
    getLogAnalysis: async (req: Request, res: Response) => {
      try {
        const hours = parseInt(req.query.hours as string, 10) || 1;
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

        const report = await LogAnalyzer.generateReport(
          path.join(process.cwd(), 'logs'),
          { start: startTime, end: endTime }
        );

        res.json({
          status: 'success',
          data: {
            report,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
              hours,
            },
          },
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to generate log analysis',
          error: (error as Error).message,
        });
      }
    },

    // System health endpoint
    getHealth: (req: Request, res: Response) => {
      try {
        const dashboardData = dashboard.getDashboardData();
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          services: dashboardData.serviceHealth || {},
          logFiles: dashboardData.logFiles || {},
          alerts: dashboardData.alertStats || {},
          memory: process.memoryUsage(),
        };

        // Check if any critical issues exist
        const hasErrors = dashboardData.alertStats?.alertsLastHour > 10;
        const memoryHigh = process.memoryUsage().heapUsed > 512 * 1024 * 1024; // 512MB

        if (hasErrors || memoryHigh) {
          health.status = 'degraded';
          res.status(206);
        }

        res.json(health);
      } catch (error) {
        res.status(500).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: (error as Error).message,
        });
      }
    },

    // Configuration endpoint
    getConfiguration: (req: Request, res: Response) => {
      try {
        const config = {
          environment: process.env.NODE_ENV || 'development',
          logLevel: process.env.LOG_LEVEL || 'info',
          features: {
            correlationTracking: true,
            performanceMonitoring: true,
            securityLogging: true,
            graphqlLogging: true,
            realTimeAnalysis: true,
            alerting: true,
            prometheus: true,
          },
          thresholds: {
            errorRate: 5.0,
            responseTime: 1000,
            memoryUsage: 512,
            securityEvents: 10,
          },
          logFiles: [
            'combined.log',
            'error.log',
            'performance.log',
            'security.log',
            'graphql.log',
            'crosschain.log',
            'iot.log',
            'weather.log',
          ],
        };

        res.json({
          status: 'success',
          data: config,
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get configuration',
          error: (error as Error).message,
        });
      }
    },
  };
}

// HTML dashboard (simple)
export function getHtmlDashboard(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WRFCoin Logging Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .dashboard {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        .card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card h3 {
            margin-top: 0;
            color: #333;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
        }
        .metric-value {
            font-weight: bold;
            color: #0066cc;
        }
        .status-good { color: #28a745; }
        .status-warning { color: #ffc107; }
        .status-error { color: #dc3545; }
        .refresh-button {
            background: #0066cc;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
        }
        .log-files {
            font-family: monospace;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <h1>🚀 WRFCoin Logging Dashboard</h1>
            <p>Real-time monitoring and logging infrastructure status</p>
            <button class="refresh-button" onclick="refreshData()">Refresh Data</button>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>📊 System Metrics</h3>
                <div id="system-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h3>⚡ Performance</h3>
                <div id="performance-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h3>🔒 Security</h3>
                <div id="security-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h3>📁 Log Files</h3>
                <div id="log-files" class="log-files">Loading...</div>
            </div>
            
            <div class="card">
                <h3>🚨 Recent Alerts</h3>
                <div id="alerts">Loading...</div>
            </div>
            
            <div class="card">
                <h3>🌐 Service Health</h3>
                <div id="service-health">Loading...</div>
            </div>
        </div>
    </div>

    <script>
        async function fetchData() {
            try {
                const response = await fetch('/api/logging/dashboard');
                const result = await response.json();
                
                if (result.status === 'success') {
                    updateDashboard(result.data);
                } else {
                    console.error('Failed to fetch dashboard data:', result);
                }
            } catch (error) {
                console.error('Error fetching dashboard data:', error);
            }
        }

        function updateDashboard(data) {
            // Update system metrics
            const systemMetrics = data.systemMetrics || {};
            document.getElementById('system-metrics').innerHTML = \`
                <div class="metric">
                    <span>Uptime:</span>
                    <span class="metric-value">\${formatUptime(systemMetrics.uptime)}</span>
                </div>
                <div class="metric">
                    <span>Memory Usage:</span>
                    <span class="metric-value">\${formatBytes(systemMetrics.memoryUsage?.heapUsed)}</span>
                </div>
                <div class="metric">
                    <span>Node Version:</span>
                    <span class="metric-value">\${systemMetrics.nodeVersion || 'N/A'}</span>
                </div>
            \`;

            // Update performance metrics
            const perfMetrics = data.realTimeMetrics || {};
            document.getElementById('performance-metrics').innerHTML = \`
                <div class="metric">
                    <span>Requests/sec:</span>
                    <span class="metric-value">\${perfMetrics.requestsPerSecond?.toFixed(2) || '0'}</span>
                </div>
                <div class="metric">
                    <span>Avg Response:</span>
                    <span class="metric-value">\${perfMetrics.averageResponseTime?.toFixed(0) || '0'}ms</span>
                </div>
                <div class="metric">
                    <span>Error Rate:</span>
                    <span class="metric-value \${getErrorRateClass(perfMetrics.errorRate)}">\${perfMetrics.errorRate?.toFixed(2) || '0'}%</span>
                </div>
            \`;

            // Update security metrics
            const alertStats = data.alertStats || {};
            document.getElementById('security-metrics').innerHTML = \`
                <div class="metric">
                    <span>Alerts (1h):</span>
                    <span class="metric-value \${getAlertClass(alertStats.alertsLastHour)}">\${alertStats.alertsLastHour || 0}</span>
                </div>
                <div class="metric">
                    <span>Security Events:</span>
                    <span class="metric-value">\${perfMetrics.securityEvents || 0}</span>
                </div>
            \`;

            // Update log files
            const logFiles = data.logFiles || {};
            document.getElementById('log-files').innerHTML = Object.entries(logFiles)
                .map(([name, info]) => \`
                    <div class="metric">
                        <span>\${name}:</span>
                        <span class="metric-value \${info.exists ? 'status-good' : 'status-error'}">
                            \${info.exists ? info.sizeMB + 'MB' : 'Missing'}
                        </span>
                    </div>
                \`).join('');

            // Update service health
            const serviceHealth = data.serviceHealth || {};
            document.getElementById('service-health').innerHTML = Object.entries(serviceHealth)
                .map(([service, healthy]) => \`
                    <div class="metric">
                        <span>\${service}:</span>
                        <span class="metric-value \${healthy ? 'status-good' : 'status-error'}">
                            \${healthy ? '✅ Healthy' : '❌ Down'}
                        </span>
                    </div>
                \`).join('');

            // Update alerts
            const recentAlerts = data.recentAlerts || [];
            document.getElementById('alerts').innerHTML = recentAlerts.length > 0 
                ? recentAlerts.slice(0, 5).map(alert => \`
                    <div style="margin: 5px 0; padding: 5px; border-left: 3px solid \${getAlertColor(alert.severity)};">
                        <strong>\${alert.type}</strong><br>
                        <small>\${alert.message}</small>
                    </div>
                \`).join('')
                : '<div class="status-good">No recent alerts</div>';

            document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
        }

        function formatUptime(seconds) {
            if (!seconds) return 'N/A';
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return \`\${hours}h \${minutes}m\`;
        }

        function formatBytes(bytes) {
            if (!bytes) return 'N/A';
            return (bytes / 1024 / 1024).toFixed(1) + 'MB';
        }

        function getErrorRateClass(rate) {
            if (!rate) return '';
            return rate > 5 ? 'status-error' : rate > 2 ? 'status-warning' : 'status-good';
        }

        function getAlertClass(count) {
            if (!count) return 'status-good';
            return count > 10 ? 'status-error' : count > 5 ? 'status-warning' : 'status-good';
        }

        function getAlertColor(severity) {
            switch(severity) {
                case 'critical': return '#dc3545';
                case 'warning': return '#ffc107';
                default: return '#17a2b8';
            }
        }

        function refreshData() {
            fetchData();
        }

        // Initial load and auto-refresh
        fetchData();
        setInterval(fetchData, 30000); // Refresh every 30 seconds
    </script>
</body>
</html>
  `;
}

// Initialize dashboard
export const dashboardInstance = LoggingDashboard.getInstance();

// Cleanup function
export function cleanupDashboard(): void {
  dashboardInstance.cleanup();
}
