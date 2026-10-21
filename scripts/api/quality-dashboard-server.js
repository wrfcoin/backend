#!/usr/bin/env node

/**
 * Quality Dashboard Server for WRFCoin Platform
 *
 * Provides a real-time web dashboard for monitoring code quality metrics,
 * alerts, and trends across the entire development lifecycle.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const QualityMetricsReporter = require('./quality-metrics-reporter');
const { corsMiddleware } = require('../../shared/middleware/cors-config.js');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

class QualityDashboardServer {
  constructor(port = 8090) {
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.clients = new Set();
    this.config = this.loadDashboardConfig();
    this.metricsHistory = [];
    this.alerts = [];

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.startMetricsCollection();
  }

  /**
   * Load dashboard configuration
   */
  loadDashboardConfig() {
    const configPath = path.join(
      process.cwd(),
      'config',
      'quality-dashboard-config.json'
    );
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    // Default configuration
    return {
      dashboard: {
        title: 'WRFCoin Quality Gates Dashboard',
        refresh_interval: '5m',
      },
      thresholds: {
        quality_score: { critical: 50, warning: 70, good: 85 },
        coverage: { critical: 60, warning: 80, good: 90 },
        lint_issues: { critical: 20, warning: 10, good: 0 },
      },
    };
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));

    // CORS with proper origin validation
    this.app.use(corsMiddleware);
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Dashboard home page
    this.app.get('/', (req, res) => {
      res.send(this.generateDashboardHTML());
    });

    // Get current metrics
    this.app.get('/api/metrics', (req, res) => {
      const latest = this.metricsHistory[this.metricsHistory.length - 1];
      res.json(latest || {});
    });

    // Get metrics history
    this.app.get('/api/metrics/history', (req, res) => {
      const limit = parseInt(req.query.limit) || 100;
      res.json(this.metricsHistory.slice(-limit));
    });

    // Get current alerts
    this.app.get('/api/alerts', (req, res) => {
      res.json(this.alerts);
    });

    // Get quality trends
    this.app.get('/api/trends', (req, res) => {
      res.json(this.calculateTrends());
    });

    // Trigger manual metrics collection
    this.app.post('/api/metrics/collect', async (req, res) => {
      try {
        await this.collectMetrics();
        res.json({ success: true, message: 'Metrics collected successfully' });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        clients: this.clients.size,
      });
    });

    // Prometheus metrics endpoint
    this.app.get('/metrics', (req, res) => {
      res.set('Content-Type', 'text/plain');
      res.send(this.generatePrometheusMetrics());
    });
  }

  /**
   * Setup WebSocket for real-time updates
   */
  setupWebSocket() {
    this.wss.on('connection', ws => {
      logger.info('Dashboard client connected');
      this.clients.add(ws);

      // Send current state to new client
      const latest = this.metricsHistory[this.metricsHistory.length - 1];
      if (latest) {
        ws.send(JSON.stringify({ type: 'metrics', data: latest }));
      }

      ws.on('close', () => {
        logger.info('Dashboard client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', error => {
        logger.error('WebSocket error', { error: error.message });
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Start automatic metrics collection
   */
  startMetricsCollection() {
    // Initial collection
    this.collectMetrics();

    // Set up periodic collection (every 5 minutes)
    setInterval(
      () => {
        this.collectMetrics();
      },
      5 * 60 * 1000
    );
  }

  /**
   * Collect quality metrics
   */
  async collectMetrics() {
    try {
      logger.info('Collecting quality metrics...');

      const reporter = new QualityMetricsReporter();
      const result = await reporter.run();

      const metricsData = {
        ...result.metrics,
        collection_time: new Date().toISOString(),
      };

      // Add to history
      this.metricsHistory.push(metricsData);

      // Keep only last 1000 entries
      if (this.metricsHistory.length > 1000) {
        this.metricsHistory = this.metricsHistory.slice(-1000);
      }

      // Check for alerts
      this.checkAlerts(metricsData);

      // Broadcast to all connected clients
      this.broadcast({ type: 'metrics', data: metricsData });

      logger.info('Metrics collected', { score: `${metricsData.overall_score}/100` });
    } catch (error) {
      logger.error('Error collecting metrics', { error: error.message });
      this.broadcast({ type: 'error', message: 'Failed to collect metrics' });
    }
  }

  /**
   * Check for alert conditions
   */
  checkAlerts(metrics) {
    const newAlerts = [];
    const timestamp = new Date().toISOString();

    // Quality score alerts
    if (metrics.overall_score < this.config.thresholds.quality_score.critical) {
      newAlerts.push({
        id: `quality-critical-${Date.now()}`,
        level: 'critical',
        title: 'Quality Score Critical',
        message: `Quality score ${metrics.overall_score} is below critical threshold`,
        timestamp,
        value: metrics.overall_score,
        threshold: this.config.thresholds.quality_score.critical,
      });
    } else if (
      metrics.overall_score < this.config.thresholds.quality_score.warning
    ) {
      newAlerts.push({
        id: `quality-warning-${Date.now()}`,
        level: 'warning',
        title: 'Quality Score Warning',
        message: `Quality score ${metrics.overall_score} is below warning threshold`,
        timestamp,
        value: metrics.overall_score,
        threshold: this.config.thresholds.quality_score.warning,
      });
    }

    // Coverage alerts
    const jsCoverage = metrics.javascript?.coverage || 0;
    if (jsCoverage < this.config.thresholds.coverage.critical) {
      newAlerts.push({
        id: `coverage-critical-${Date.now()}`,
        level: 'critical',
        title: 'Coverage Critical',
        message: `JavaScript coverage ${jsCoverage}% is below critical threshold`,
        timestamp,
        value: jsCoverage,
        threshold: this.config.thresholds.coverage.critical,
      });
    }

    // Lint issues alerts
    const lintIssues =
      (metrics.javascript?.lint_issues || 0) +
      (metrics.rust?.clippy_warnings || 0) +
      (metrics.contracts?.solhint_issues || 0);

    if (lintIssues > this.config.thresholds.lint_issues.critical) {
      newAlerts.push({
        id: `lint-critical-${Date.now()}`,
        level: 'critical',
        title: 'High Lint Issues',
        message: `Total lint issues ${lintIssues} exceed critical threshold`,
        timestamp,
        value: lintIssues,
        threshold: this.config.thresholds.lint_issues.critical,
      });
    }

    // Security vulnerabilities
    if (metrics.security?.vulnerabilities > 0) {
      newAlerts.push({
        id: `security-critical-${Date.now()}`,
        level: 'critical',
        title: 'Security Vulnerabilities',
        message: `${metrics.security.vulnerabilities} security vulnerabilities detected`,
        timestamp,
        value: metrics.security.vulnerabilities,
        threshold: 0,
      });
    }

    // Add new alerts
    this.alerts.push(...newAlerts);

    // Keep only last 50 alerts
    if (this.alerts.length > 50) {
      this.alerts = this.alerts.slice(-50);
    }

    // Broadcast new alerts
    if (newAlerts.length > 0) {
      this.broadcast({ type: 'alerts', data: newAlerts });
      logger.warn('New alerts triggered', { count: newAlerts.length });
    }
  }

  /**
   * Calculate quality trends
   */
  calculateTrends() {
    if (this.metricsHistory.length < 2) {
      return { trend: 'insufficient_data' };
    }

    const recent = this.metricsHistory.slice(-10);
    const scores = recent.map(m => m.overall_score);

    // Simple linear trend calculation
    const n = scores.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = scores.reduce((a, b) => a + b, 0);
    const sumXY = scores.reduce((sum, score, i) => sum + i * score, 0);
    const sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    return {
      trend: slope > 0.5 ? 'improving' : slope < -0.5 ? 'declining' : 'stable',
      slope: slope,
      current_score: scores[scores.length - 1],
      previous_score: scores[0],
      data_points: n,
    };
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  /**
   * Generate Prometheus metrics format
   */
  generatePrometheusMetrics() {
    const latest = this.metricsHistory[this.metricsHistory.length - 1];
    if (!latest) return '';

    const timestamp = Date.now();

    return `
# HELP wrfcoin_quality_score Overall code quality score
# TYPE wrfcoin_quality_score gauge
wrfcoin_quality_score ${latest.overall_score} ${timestamp}

# HELP wrfcoin_coverage_percentage Code coverage percentage
# TYPE wrfcoin_coverage_percentage gauge
wrfcoin_coverage_percentage{language="javascript"} ${latest.javascript?.coverage || 0} ${timestamp}
wrfcoin_coverage_percentage{language="rust"} ${latest.rust?.coverage || 0} ${timestamp}
wrfcoin_coverage_percentage{language="solidity"} ${latest.contracts?.coverage || 0} ${timestamp}

# HELP wrfcoin_lint_issues Number of linting issues
# TYPE wrfcoin_lint_issues gauge
wrfcoin_lint_issues{language="javascript"} ${latest.javascript?.lint_issues || 0} ${timestamp}
wrfcoin_lint_issues{language="rust"} ${latest.rust?.clippy_warnings || 0} ${timestamp}
wrfcoin_lint_issues{language="solidity"} ${latest.contracts?.solhint_issues || 0} ${timestamp}

# HELP wrfcoin_security_vulnerabilities Number of security vulnerabilities
# TYPE wrfcoin_security_vulnerabilities gauge
wrfcoin_security_vulnerabilities ${latest.security?.vulnerabilities || 0} ${timestamp}

# HELP wrfcoin_alerts_total Total number of active alerts
# TYPE wrfcoin_alerts_total gauge
wrfcoin_alerts_total ${this.alerts.length} ${timestamp}
`.trim();
  }

  /**
   * Generate dashboard HTML
   */
  generateDashboardHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.config.dashboard.title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f5f5f5;
            color: #333;
        }
        .header {
            background: #2c3e50;
            color: white;
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 { font-size: 1.5rem; font-weight: 600; }
        .status { display: flex; align-items: center; gap: 1rem; }
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #27ae60;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        .metric-card {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 4px solid #3498db;
        }
        .metric-card.critical { border-left-color: #e74c3c; }
        .metric-card.warning { border-left-color: #f39c12; }
        .metric-card.good { border-left-color: #27ae60; }
        .metric-title {
            font-size: 0.9rem;
            color: #666;
            margin-bottom: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .metric-value {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }
        .metric-subtitle {
            font-size: 0.8rem;
            color: #888;
        }
        .alerts-section {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 2rem;
        }
        .alert-item {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 1rem;
            border-radius: 6px;
            margin-bottom: 0.5rem;
        }
        .alert-item.critical { background: #fee; border-left: 4px solid #e74c3c; }
        .alert-item.warning { background: #fef5e7; border-left: 4px solid #f39c12; }
        .alert-icon {
            font-size: 1.2rem;
        }
        .alert-content {
            flex: 1;
        }
        .alert-title {
            font-weight: 600;
            margin-bottom: 0.25rem;
        }
        .alert-message {
            font-size: 0.9rem;
            color: #666;
        }
        .refresh-btn {
            background: #3498db;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
        }
        .refresh-btn:hover {
            background: #2980b9;
        }
        .timestamp {
            font-size: 0.8rem;
            color: #888;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${this.config.dashboard.title}</h1>
        <div class="status">
            <div class="status-indicator"></div>
            <span>Live</span>
            <button class="refresh-btn" onclick="refreshMetrics()">Refresh</button>
        </div>
    </div>
    
    <div class="container">
        <div class="metrics-grid" id="metricsGrid">
            <!-- Metrics will be populated by JavaScript -->
        </div>
        
        <div class="alerts-section">
            <h2 style="margin-bottom: 1rem;">Active Alerts</h2>
            <div id="alertsList">
                <!-- Alerts will be populated by JavaScript -->
            </div>
        </div>
    </div>

    <script>
        let ws;
        let currentMetrics = {};
        let currentAlerts = [];

        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
            
            ws.onopen = () => {
                console.log('Connected to quality dashboard');
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                
                if (message.type === 'metrics') {
                    currentMetrics = message.data;
                    updateMetrics();
                } else if (message.type === 'alerts') {
                    currentAlerts.push(...message.data);
                    updateAlerts();
                }
            };
            
            ws.onclose = () => {
                console.log('Disconnected from quality dashboard');
                setTimeout(connectWebSocket, 5000);
            };
        }

        function updateMetrics() {
            const grid = document.getElementById('metricsGrid');
            const score = currentMetrics.overall_score || 0;
            const jsCoverage = currentMetrics.javascript?.coverage || 0;
            const rustCoverage = currentMetrics.rust?.coverage || 0;
            const jsIssues = currentMetrics.javascript?.lint_issues || 0;
            const rustIssues = currentMetrics.rust?.clippy_warnings || 0;
            const securityVulns = currentMetrics.security?.vulnerabilities || 0;
            
            const getScoreClass = (value, thresholds) => {
                if (value >= (thresholds?.good || 85)) return 'good';
                if (value >= (thresholds?.warning || 70)) return 'warning';
                return 'critical';
            };
            
            grid.innerHTML = \`
                <div class="metric-card \${getScoreClass(score, {good: 85, warning: 70})}">
                    <div class="metric-title">Overall Quality Score</div>
                    <div class="metric-value">\${score}/100</div>
                    <div class="metric-subtitle">Composite quality rating</div>
                </div>
                
                <div class="metric-card \${getScoreClass(jsCoverage, {good: 90, warning: 80})}">
                    <div class="metric-title">JavaScript Coverage</div>
                    <div class="metric-value">\${jsCoverage}%</div>
                    <div class="metric-subtitle">Test coverage percentage</div>
                </div>
                
                <div class="metric-card \${getScoreClass(rustCoverage, {good: 80, warning: 60})}">
                    <div class="metric-title">Rust Coverage</div>
                    <div class="metric-value">\${rustCoverage}%</div>
                    <div class="metric-subtitle">Cargo test coverage</div>
                </div>
                
                <div class="metric-card \${jsIssues + rustIssues === 0 ? 'good' : jsIssues + rustIssues < 10 ? 'warning' : 'critical'}">
                    <div class="metric-title">Lint Issues</div>
                    <div class="metric-value">\${jsIssues + rustIssues}</div>
                    <div class="metric-subtitle">ESLint (\${jsIssues}) + Clippy (\${rustIssues})</div>
                </div>
                
                <div class="metric-card \${securityVulns === 0 ? 'good' : 'critical'}">
                    <div class="metric-title">Security Vulnerabilities</div>
                    <div class="metric-value">\${securityVulns}</div>
                    <div class="metric-subtitle">Known security issues</div>
                </div>
                
                <div class="metric-card">
                    <div class="metric-title">Last Updated</div>
                    <div class="metric-value timestamp">\${new Date(currentMetrics.timestamp || Date.now()).toLocaleTimeString()}</div>
                    <div class="metric-subtitle">Metrics collection time</div>
                </div>
            \`;
        }

        function updateAlerts() {
            const alertsList = document.getElementById('alertsList');
            
            if (currentAlerts.length === 0) {
                alertsList.innerHTML = '<p style="color: #888; text-align: center; padding: 2rem;">No active alerts</p>';
                return;
            }
            
            alertsList.innerHTML = currentAlerts.slice(-10).reverse().map(alert => \`
                <div class="alert-item \${alert.level}">
                    <div class="alert-icon">\${alert.level === 'critical' ? '🚨' : '⚠️'}</div>
                    <div class="alert-content">
                        <div class="alert-title">\${alert.title}</div>
                        <div class="alert-message">\${alert.message}</div>
                        <div class="timestamp">\${new Date(alert.timestamp).toLocaleString()}</div>
                    </div>
                </div>
            \`).join('');
        }

        function refreshMetrics() {
            fetch('/api/metrics/collect', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        console.log('Metrics refresh triggered');
                    }
                })
                .catch(error => console.error('Failed to refresh metrics:', error));
        }

        // Initialize
        connectWebSocket();
        
        // Load initial data
        Promise.all([
            fetch('/api/metrics').then(r => r.json()),
            fetch('/api/alerts').then(r => r.json())
        ]).then(([metrics, alerts]) => {
            currentMetrics = metrics;
            currentAlerts = alerts;
            updateMetrics();
            updateAlerts();
        });
    </script>
</body>
</html>
        `.trim();
  }

  /**
   * Start the dashboard server
   */
  start() {
    this.server.listen(this.port, () => {
      logger.info('Quality Dashboard Server started', {
        url: `http://localhost:${this.port}`,
        dashboard: `http://localhost:${this.port}`,
        api: `http://localhost:${this.port}/api/metrics`,
        health: `http://localhost:${this.port}/health`,
        prometheus: `http://localhost:${this.port}/metrics`
      });
    });
  }

  /**
   * Stop the dashboard server
   */
  stop() {
    this.server.close(() => {
      logger.info('Quality Dashboard Server stopped');
    });
  }
}

// CLI execution
if (require.main === module) {
  const port = process.env.QUALITY_DASHBOARD_PORT || 8090;
  const dashboard = new QualityDashboardServer(port);

  dashboard.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down Quality Dashboard Server...');
    dashboard.stop();
    process.exit(0);
  });
}

module.exports = QualityDashboardServer;
