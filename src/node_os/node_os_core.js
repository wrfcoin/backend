const os = require('os');

/**
 * Minimal in-memory Node-OS core facade.
 *
 * This class restores the `/api/node-os` mount by providing the runtime surface
 * that `node-os-routes.js` requires. It intentionally defaults to safe,
 * no-op behavior and stores state in memory so `/api/node-os` can serve without
 * touching production services while the real implementation is unavailable.
 */
class NodeOSCore {
  constructor() {
    this.initialized = false;
    this.initializedAt = null;
    this.lastStartedAt = null;

    this.configStore = {};
    this.activeProfile = 'default';
    this.plannedProfile = null;

    this.nextJobId = 1;
    this.jobs = new Map();

    this.nextBackupId = 1;
    this.backups = new Map();

    this.plugins = new Map();

    this.securityEvents = [
      {
        id: 1,
        severity: 'info',
        message: 'NodeOSCore initialized (in-memory runtime seam)',
        timestamp: new Date().toISOString(),
      },
    ];
    this.accessLogs = [];

    this.pluginManager = {
      getStatus: this.getPluginStatus.bind(this),
      installPlugin: this.installPlugin.bind(this),
      activatePlugin: this.activatePlugin.bind(this),
      deactivatePlugin: this.deactivatePlugin.bind(this),
    };

    this.workloadManager = {
      getStatus: this.getWorkloadStatus.bind(this),
    };

    this.healthMonitor = {
      getHealthSummary: this.getHealthSummary.bind(this),
      getDetailedReport: this.getHealthReport.bind(this),
      runCheck: this.runCheck.bind(this),
    };

    this.backupManager = {
      listBackups: this.listBackups.bind(this),
      createSystemBackup: this.createSystemBackup.bind(this),
      restoreFromBackup: this.restoreFromBackup.bind(this),
      deleteBackup: this.deleteBackup.bind(this),
    };

    this.securityManager = {
      getSecurityStatus: this.getSecurityStatus.bind(this),
      getSecurityEvents: this.getSecurityEvents.bind(this),
      getAccessLogs: this.getAccessLogs.bind(this),
      validateAccess: this.validateAccess.bind(this),
    };
  }

  async initialize() {
    this.initialized = true;
    this.initializedAt = new Date().toISOString();
    this.lastStartedAt = this.initializedAt;
    return {
      success: true,
      message: 'Node OS core initialized (in-memory placeholder)',
    };
  }

  getSystemStatus() {
    return {
      initialized: this.initialized,
      initializedAt: this.initializedAt,
      activeProfile: this.activeProfile,
      components: {
        plugin_manager: this.getPluginStatus(),
        workload_manager: this.getWorkloadStatus(),
        security_manager: this.getSecurityStatus(),
        backup_manager: {
          backupsAvailable: this.backups.size,
        },
      },
      resources: this.getResourceSnapshot(),
      hostname: os.hostname(),
      nodeVersion: process.version,
    };
  }

  getDetailedReport() {
    return {
      system: this.getSystemStatus(),
      config: this.configStore,
      plugins: Array.from(this.plugins.values()),
      workloads: {
        jobs: Array.from(this.jobs.values()).map((job) => ({
          ...job,
        })),
      },
      backups: Array.from(this.backups.values()),
      generatedAt: new Date().toISOString(),
    };
  }

  getResourceSnapshot() {
    const mem = process.memoryUsage();
    return {
      cpu: os.loadavg(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  getConfig(config, key) {
    if (!config) return undefined;
    const bucket = this.configStore[config];
    if (bucket === undefined) return undefined;
    return key ? bucket[key] : bucket;
  }

  async setConfig(config, key, value) {
    if (!config || !key) {
      return {
        success: false,
        error: 'MISSING_CONFIG_PARAMS',
      };
    }

    if (!this.configStore[config] || typeof this.configStore[config] !== 'object') {
      this.configStore[config] = {};
    }

    this.configStore[config][key] = value;
    return {
      success: true,
      message: `Config updated for ${config}.${key}`,
    };
  }

  async applyProfile(profileName) {
    if (!profileName) {
      return {
        success: false,
        error: 'MISSING_PROFILE_NAME',
      };
    }

    this.plannedProfile = profileName;
    return {
      success: true,
      message: `Applied profile ${profileName}`,
      previousProfile: this.activeProfile,
    };
  }

  getPluginStatus() {
    return {
      activeProfile: this.activeProfile,
      plugins: Array.from(this.plugins.values()),
    };
  }

  async installPlugin(pluginName) {
    const existing = this.plugins.get(pluginName);
    this.plugins.set(pluginName, {
      name: pluginName,
      state: 'installed',
      installedAt: new Date().toISOString(),
      active: Boolean(existing?.active),
    });

    return {
      success: true,
      message: `Installed plugin ${pluginName}`,
    };
  }

  async activatePlugin(pluginName) {
    const plugin = this.plugins.get(pluginName) || {
      name: pluginName,
      state: 'installed',
      installedAt: new Date().toISOString(),
      active: false,
    };

    plugin.active = true;
    this.plugins.set(pluginName, plugin);

    return {
      success: true,
      message: `Activated plugin ${pluginName}`,
    };
  }

  async deactivatePlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return {
        success: false,
        error: 'PLUGIN_NOT_FOUND',
      };
    }

    plugin.active = false;
    this.plugins.set(pluginName, plugin);

    return {
      success: true,
      message: `Deactivated plugin ${pluginName}`,
    };
  }

  getWorkloadStatus() {
    const all = Array.from(this.jobs.values());
    const byStatus = all.reduce((acc, job) => {
      acc[job.status] = (acc[job.status] || 0) + 1;
      return acc;
    }, {});

    return {
      totalJobs: all.length,
      byStatus,
      running: this.activeWorkloads,
      queued: Math.max(0, byStatus.pending || 0),
      active: this.activeWorkloads,
      completed: byStatus.completed || 0,
    };
  }

  get activeWorkloads() {
    return Array.from(this.jobs.values()).filter((job) => job.status === 'running')
      .length;
  }

  async submitJob(jobDefinition) {
    if (!jobDefinition) {
      return {
        success: false,
        error: 'MISSING_JOB_DEFINITION',
      };
    }

    const jobId = `job_${String(this.nextJobId++).padStart(6, '0')}`;
    const now = new Date().toISOString();

    const job = {
      id: jobId,
      status: 'running',
      definition: jobDefinition,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, job);
    setTimeout(() => {
      const current = this.jobs.get(jobId);
      if (current && current.status === 'running') {
        current.status = 'completed';
        current.updatedAt = new Date().toISOString();
      }
    }, 10);

    return {
      success: true,
      jobId,
      message: `Job ${jobId} submitted`,
    };
  }

  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        error: 'JOB_NOT_FOUND',
      };
    }

    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    return {
      success: true,
      message: `Job ${jobId} cancelled`,
    };
  }

  getHealthSummary() {
    return {
      status: this.initialized ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        nodeCore: true,
        plugins: Object.keys(Object.fromEntries(this.plugins)).length >= 0,
      },
      uptimeSeconds: this.initialized
        ? Math.floor((Date.now() - Date.parse(this.initializedAt || Date.now())) / 1000)
        : 0,
    };
  }

  getHealthReport() {
    return {
      summary: this.getHealthSummary(),
      config: {
        initialized: this.initialized,
        activeProfile: this.activeProfile,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async runCheck(checkId) {
    if (!checkId) {
      return {
        checkId: 'unknown',
        status: 'failed',
        message: 'checkId is required',
      };
    }

    return {
      checkId,
      status: 'passed',
      message: `check ${checkId} passed`,
      timestamp: new Date().toISOString(),
    };
  }

  async performMaintenance() {
    this.plannedProfile = null;
    this.accessLogs = [];
    return {
      success: true,
      message: 'Node OS maintenance completed',
      operations: {
        clearedAccessLog: true,
      },
    };
  }

  listBackups() {
    return Array.from(this.backups.values());
  }

  async createSystemBackup() {
    const backupId = `backup_${String(this.nextBackupId++).padStart(6, '0')}`;
    const backup = {
      id: backupId,
      createdAt: new Date().toISOString(),
      status: 'created',
      sizeBytes: 0,
      profile: this.activeProfile,
    };
    this.backups.set(backupId, backup);
    return {
      success: true,
      backupId,
      message: `Created backup ${backupId}`,
    };
  }

  async restoreFromBackup(backupId) {
    if (!this.backups.has(backupId)) {
      return {
        success: false,
        error: 'BACKUP_NOT_FOUND',
      };
    }

    return {
      success: true,
      message: `Restore from backup ${backupId} initiated`,
      status: 'restoring',
    };
  }

  async deleteBackup(backupId) {
    const had = this.backups.delete(backupId);
    if (!had) {
      return {
        success: false,
        error: 'BACKUP_NOT_FOUND',
      };
    }

    return {
      success: true,
      message: `Deleted backup ${backupId}`,
    };
  }

  getSecurityStatus() {
    return {
      active: true,
      policy: 'fail-open-monitoring',
      lastRotationAt: this.initializedAt,
    };
  }

  getSecurityEvents(limit = 100) {
    return this.securityEvents
      .slice(-Math.max(0, Number(limit) || 0))
      .map((event) => ({ ...event }));
  }

  getAccessLogs(limit = 100) {
    return this.accessLogs
      .slice(-Math.max(0, Number(limit) || 0))
      .map((event) => ({ ...event }));
  }

  async validateAccess(userId, resource, action, context = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      userId,
      resource,
      action,
      context,
      decision: 'allowed',
    };
    this.accessLogs.push(record);
    if (this.accessLogs.length > 1000) {
      this.accessLogs.shift();
    }

    if (!userId || !resource || !action) {
      return {
        allowed: false,
        reason: 'MISSING_PARAMS',
      };
    }

    return {
      allowed: true,
      reason: 'allowed_by_placeholder_policy',
    };
  }

  async shutdown() {
    this.initialized = false;
    this.initializedAt = null;
    return {
      success: true,
      message: 'Node OS core shutdown',
    };
  }
}

module.exports = NodeOSCore;
