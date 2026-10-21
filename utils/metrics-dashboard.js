/**
 * Wrfcoin Core Metrics Dashboard
 *
 * This utility provides a real-time dashboard for monitoring startup metrics
 * and component performance. It visualizes the metrics collected during startup
 * and provides insights into optimization opportunities.
 */

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { componentEvents } = require('./component-scheduler');

// Create Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/metrics-ws' });

// Dashboard port
const PORT = process.env.METRICS_PORT || 5002;

// Store all metrics
const allMetrics = {
  current: {
    startTime: Date.now(),
    components: {},
    groups: {},
    activeComponents: [],
    lastUpdated: Date.now(),
  },
  history: [],
  aggregated: {
    averages: {},
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
  },
};

// Load historical metrics
function loadHistoricalMetrics() {
  try {
    const metricsDir = path.join(__dirname, '..', 'logs', 'metrics');

    if (!fs.existsSync(metricsDir)) {
      console.log('No metrics directory found, creating one');
      fs.mkdirSync(metricsDir, { recursive: true });
      return;
    }

    const files = fs
      .readdirSync(metricsDir)
      .filter(file => file.startsWith('startup-') && file.endsWith('.json'))
      .sort((a, b) => {
        // Sort by timestamp (most recent first)
        const timestampA = parseInt(a.split('-')[1].split('.')[0], 10);
        const timestampB = parseInt(b.split('-')[1].split('.')[0], 10);
        return timestampB - timestampA;
      });

    // Load up to the last 10 metrics files
    const recentFiles = files.slice(0, 10);

    recentFiles.forEach(file => {
      try {
        const content = fs.readFileSync(path.join(metricsDir, file), 'utf8');
        const metrics = JSON.parse(content);

        allMetrics.history.push(metrics);

        // Update aggregated metrics
        allMetrics.aggregated.totalRuns++;

        if (metrics.status === 'success') {
          allMetrics.aggregated.successfulRuns++;
        } else {
          allMetrics.aggregated.failedRuns++;
        }

        // Update average durations
        const updateAverage = (key, value) => {
          if (!allMetrics.aggregated.averages[key]) {
            allMetrics.aggregated.averages[key] = {
              total: 0,
              count: 0,
              average: 0,
            };
          }

          allMetrics.aggregated.averages[key].total += value;
          allMetrics.aggregated.averages[key].count++;
          allMetrics.aggregated.averages[key].average =
            allMetrics.aggregated.averages[key].total /
            allMetrics.aggregated.averages[key].count;
        };

        // Update overall duration average
        if (metrics.duration) {
          updateAverage('overall', metrics.duration);
        }

        // Update component duration averages
        if (metrics.components) {
          Object.entries(metrics.components).forEach(([component, stats]) => {
            if (stats.duration) {
              updateAverage(`component.${component}`, stats.duration);
            }
          });
        }

        // Update group duration averages
        if (metrics.groups) {
          Object.entries(metrics.groups).forEach(([group, stats]) => {
            if (stats.duration) {
              updateAverage(`group.${group}`, stats.duration);
            }
          });
        }
      } catch (error) {
        console.error(`Error loading metrics from ${file}: ${error.message}`);
      }
    });

    console.log(`Loaded ${allMetrics.history.length} historical metrics files`);
  } catch (error) {
    console.error(`Error loading historical metrics: ${error.message}`);
  }
}

// Broadcast metrics to all clients
function broadcastMetrics() {
  // Update last updated timestamp
  allMetrics.current.lastUpdated = Date.now();

  // Send to all connected clients
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      client.send(JSON.stringify(allMetrics));
    }
  });
}

// Register event handlers for real-time metrics
function registerEventHandlers() {
  // Component started event
  componentEvents.on('component:started', data => {
    allMetrics.current.components[data.component] = {
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      status: 'success',
    };

    // Remove from active components
    const index = allMetrics.current.activeComponents.indexOf(data.component);
    if (index !== -1) {
      allMetrics.current.activeComponents.splice(index, 1);
    }

    broadcastMetrics();
  });

  // Component failed event
  componentEvents.on('component:failed', data => {
    allMetrics.current.components[data.component] = {
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      status: 'failed',
      error: data.error,
    };

    // Remove from active components
    const index = allMetrics.current.activeComponents.indexOf(data.component);
    if (index !== -1) {
      allMetrics.current.activeComponents.splice(index, 1);
    }

    broadcastMetrics();
  });

  // Component starting event
  componentEvents.on('component:starting', data => {
    allMetrics.current.components[data.component] = {
      startTime: data.startTime,
      status: 'starting',
    };

    // Add to active components
    if (!allMetrics.current.activeComponents.includes(data.component)) {
      allMetrics.current.activeComponents.push(data.component);
    }

    broadcastMetrics();
  });

  // Group starting event
  componentEvents.on('group:starting', data => {
    allMetrics.current.groups[data.group] = {
      startTime: data.startTime,
      status: 'starting',
      components: data.components,
    };

    broadcastMetrics();
  });

  // Group completed event
  componentEvents.on('group:completed', data => {
    allMetrics.current.groups[data.group] = {
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      status: 'success',
      components: data.components,
    };

    broadcastMetrics();
  });

  // Group failed event
  componentEvents.on('group:failed', data => {
    allMetrics.current.groups[data.group] = {
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      status: 'failed',
      error: data.error,
      components: data.components,
    };

    broadcastMetrics();
  });
}

// Create HTML dashboard
const dashboardHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wrfcoin Core Metrics Dashboard</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f5f5f5;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      background-color: #2c3e50;
      color: white;
      padding: 1rem;
      border-radius: 5px;
      margin-bottom: 20px;
    }
    h1, h2, h3 {
      margin: 0;
    }
    .card {
      background-color: white;
      border-radius: 5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      margin-bottom: 20px;
      padding: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }
    .full-width {
      grid-column: 1 / -1;
    }
    .metrics-table {
      width: 100%;
      border-collapse: collapse;
    }
    .metrics-table th, .metrics-table td {
      padding: 10px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    .metrics-table th {
      background-color: #f2f2f2;
    }
    .status-success {
      color: #27ae60;
    }
    .status-failed {
      color: #e74c3c;
    }
    .status-running {
      color: #3498db;
    }
    .component-bar {
      height: 30px;
      border-radius: 5px;
      position: relative;
      background-color: #ecf0f1;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .component-bar-fill {
      height: 100%;
      background-color: #3498db;
      position: absolute;
      top: 0;
      left: 0;
      transition: width 0.3s ease;
    }
    .component-name {
      position: absolute;
      left: 10px;
      top: 5px;
      color: #fff;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
      z-index: 1;
    }
    .component-time {
      position: absolute;
      right: 10px;
      top: 5px;
      color: #fff;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Wrfcoin Core Metrics Dashboard</h1>
      <p>Real-time monitoring of startup performance and component metrics</p>
    </header>
    
    <div class="grid">
      <div class="card">
        <h2>Current Status</h2>
        <div id="current-status">Loading...</div>
      </div>
      
      <div class="card">
        <h2>Historical Stats</h2>
        <div id="historical-stats">Loading...</div>
      </div>
      
      <div class="card full-width">
        <h2>Active Components</h2>
        <div id="active-components">No active components</div>
      </div>
      
      <div class="card full-width">
        <h2>Component Timeline</h2>
        <div id="component-timeline"></div>
      </div>
      
      <div class="card full-width">
        <h2>Group Performance</h2>
        <div id="group-performance"></div>
      </div>
      
      <div class="card full-width">
        <h2>Component Details</h2>
        <div id="component-details"></div>
      </div>
    </div>
  </div>
  
  <script>
    // Connect to WebSocket server
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}/metrics-ws\`;
    let socket;
    
    // Store metrics data
    let metricsData = null;
    
    // Format time in milliseconds to a readable format
    function formatTime(ms) {
      if (ms < 1000) {
        return \`\${ms}ms\`;
      } else if (ms < 60000) {
        return \`\${(ms / 1000).toFixed(2)}s\`;
      } else {
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(1);
        return \`\${minutes}m \${seconds}s\`;
      }
    }
    
    // Format date
    function formatDate(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleString();
    }
    
    // Update current status card
    function updateCurrentStatus() {
      if (!metricsData) return;
      
      const current = metricsData.current;
      const elapsedTime = current.lastUpdated - current.startTime;
      
      const completedComponents = Object.values(current.components)
        .filter(c => c.status === 'success').length;
      const failedComponents = Object.values(current.components)
        .filter(c => c.status === 'failed').length;
      const pendingComponents = current.activeComponents.length;
      
      const html = \`
        <p><strong>Start Time:</strong> \${formatDate(current.startTime)}</p>
        <p><strong>Elapsed Time:</strong> \${formatTime(elapsedTime)}</p>
        <p><strong>Components:</strong> 
          <span class="status-success">\${completedComponents} completed</span> | 
          <span class="status-failed">\${failedComponents} failed</span> | 
          <span class="status-running">\${pendingComponents} pending</span>
        </p>
        <p><strong>Last Updated:</strong> \${formatDate(current.lastUpdated)}</p>
      \`;
      
      document.getElementById('current-status').innerHTML = html;
    }
    
    // Update historical stats card
    function updateHistoricalStats() {
      if (!metricsData) return;
      
      const aggregated = metricsData.aggregated;
      const successRate = (aggregated.successfulRuns / aggregated.totalRuns * 100).toFixed(1);
      
      const html = \`
        <p><strong>Total Runs:</strong> \${aggregated.totalRuns}</p>
        <p><strong>Success Rate:</strong> \${successRate}% 
          (\${aggregated.successfulRuns} successful, \${aggregated.failedRuns} failed)</p>
        <p><strong>Average Startup Time:</strong> \${formatTime(aggregated.averages.overall?.average || 0)}</p>
      \`;
      
      document.getElementById('historical-stats').innerHTML = html;
    }
    
    // Update active components card
    function updateActiveComponents() {
      if (!metricsData) return;
      
      const current = metricsData.current;
      
      if (current.activeComponents.length === 0) {
        document.getElementById('active-components').innerHTML = 'No active components';
        return;
      }
      
      let html = '<div>';
      
      current.activeComponents.forEach(component => {
        const componentData = current.components[component];
        const elapsed = current.lastUpdated - componentData.startTime;
        
        html += \`
          <div class="component-bar">
            <div class="component-bar-fill" style="width: 100%; background-color: #3498db;"></div>
            <span class="component-name">\${component}</span>
            <span class="component-time">\${formatTime(elapsed)}</span>
          </div>
        \`;
      });
      
      html += '</div>';
      
      document.getElementById('active-components').innerHTML = html;
    }
    
    // Update component timeline card
    function updateComponentTimeline() {
      if (!metricsData) return;
      
      const current = metricsData.current;
      const components = Object.entries(current.components)
        .filter(([_, data]) => data.endTime) // Only completed components
        .sort((a, b) => a[1].startTime - b[1].startTime); // Sort by start time
      
      if (components.length === 0) {
        document.getElementById('component-timeline').innerHTML = 'No completed components yet';
        return;
      }
      
      // Calculate timeline bounds
      const startTime = Math.min(...components.map(([_, data]) => data.startTime));
      const endTime = Math.max(...components.map(([_, data]) => data.endTime || current.lastUpdated));
      const totalDuration = endTime - startTime;
      
      let html = '<div>';
      
      components.forEach(([component, data]) => {
        const startOffset = ((data.startTime - startTime) / totalDuration * 100).toFixed(1);
        const width = ((data.endTime - data.startTime) / totalDuration * 100).toFixed(1);
        const backgroundColor = data.status === 'success' ? '#27ae60' : '#e74c3c';
        
        html += \`
          <div class="component-bar">
            <div class="component-bar-fill" style="left: \${startOffset}%; width: \${width}%; background-color: \${backgroundColor};"></div>
            <span class="component-name">\${component}</span>
            <span class="component-time">\${formatTime(data.duration)}</span>
          </div>
        \`;
      });
      
      html += '</div>';
      
      document.getElementById('component-timeline').innerHTML = html;
    }
    
    // Update group performance card
    function updateGroupPerformance() {
      if (!metricsData) return;
      
      const current = metricsData.current;
      const groups = Object.entries(current.groups);
      
      if (groups.length === 0) {
        document.getElementById('group-performance').innerHTML = 'No group data available';
        return;
      }
      
      let html = '<table class="metrics-table">';
      html += '<tr><th>Group</th><th>Status</th><th>Duration</th><th>Components</th></tr>';
      
      groups.forEach(([group, data]) => {
        const status = data.status;
        const statusClass = status === 'success' ? 'status-success' : 
                           status === 'failed' ? 'status-failed' : 'status-running';
        
        const duration = data.duration ? formatTime(data.duration) : 'Running...';
        const componentCount = data.components ? data.components.length : 0;
        
        html += \`
          <tr>
            <td>\${group}</td>
            <td class="\${statusClass}">\${status}</td>
            <td>\${duration}</td>
            <td>\${componentCount}</td>
          </tr>
        \`;
      });
      
      html += '</table>';
      
      document.getElementById('group-performance').innerHTML = html;
    }
    
    // Update component details card
    function updateComponentDetails() {
      if (!metricsData) return;
      
      const current = metricsData.current;
      const components = Object.entries(current.components)
        .sort((a, b) => {
          // Sort by status (success, running, failed) then by name
          const statusOrder = { success: 0, starting: 1, failed: 2 };
          const orderA = statusOrder[a[1].status] || 1;
          const orderB = statusOrder[b[1].status] || 1;
          
          if (orderA !== orderB) {
            return orderA - orderB;
          }
          
          return a[0].localeCompare(b[0]);
        });
      
      if (components.length === 0) {
        document.getElementById('component-details').innerHTML = 'No component data available';
        return;
      }
      
      let html = '<table class="metrics-table">';
      html += '<tr><th>Component</th><th>Status</th><th>Duration</th><th>Start Time</th><th>End Time</th></tr>';
      
      components.forEach(([component, data]) => {
        const status = data.status;
        const statusClass = status === 'success' ? 'status-success' : 
                           status === 'failed' ? 'status-failed' : 'status-running';
        
        const duration = data.duration ? formatTime(data.duration) : 'Running...';
        const startTime = formatDate(data.startTime);
        const endTime = data.endTime ? formatDate(data.endTime) : '-';
        
        html += \`
          <tr>
            <td>\${component}</td>
            <td class="\${statusClass}">\${status}</td>
            <td>\${duration}</td>
            <td>\${startTime}</td>
            <td>\${endTime}</td>
          </tr>
        \`;
      });
      
      html += '</table>';
      
      document.getElementById('component-details').innerHTML = html;
    }
    
    // Connect to WebSocket and handle events
    function connect() {
      socket = new WebSocket(wsUrl);
      
      socket.onopen = () => {
        console.log('Connected to metrics server');
      };
      
      socket.onmessage = (event) => {
        metricsData = JSON.parse(event.data);
        updateDashboard();
      };
      
      socket.onclose = () => {
        console.log('Disconnected from metrics server');
        setTimeout(connect, 5000); // Reconnect after 5 seconds
      };
      
      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    }
    
    // Update all dashboard sections
    function updateDashboard() {
      updateCurrentStatus();
      updateHistoricalStats();
      updateActiveComponents();
      updateComponentTimeline();
      updateGroupPerformance();
      updateComponentDetails();
    }
    
    // Initialize dashboard
    function init() {
      connect();
      
      // Periodically update the dashboard
      setInterval(() => {
        if (metricsData) {
          metricsData.current.lastUpdated = Date.now();
          updateDashboard();
        }
      }, 1000);
    }
    
    // Start dashboard
    init();
  </script>
</body>
</html>
`;

// Create API routes
app.get('/', (req, res) => {
  res.send(dashboardHtml);
});

app.get('/api/metrics', (req, res) => {
  res.json(allMetrics);
});

app.get('/api/metrics/current', (req, res) => {
  res.json(allMetrics.current);
});

app.get('/api/metrics/history', (req, res) => {
  res.json(allMetrics.history);
});

app.get('/api/metrics/aggregated', (req, res) => {
  res.json(allMetrics.aggregated);
});

// WebSocket connection handler
wss.on('connection', ws => {
  console.log('Client connected to metrics dashboard');

  // Send current metrics to the new client
  ws.send(JSON.stringify(allMetrics));

  ws.on('close', () => {
    console.log('Client disconnected from metrics dashboard');
  });
});

// Start server
function startDashboard() {
  // Load historical metrics
  loadHistoricalMetrics();

  // Register event handlers
  registerEventHandlers();

  // Start server
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Metrics dashboard running on http://localhost:${PORT}`);
  });

  return server;
}

// Export functions
module.exports = {
  startDashboard,
  broadcastMetrics,
  allMetrics,
};
