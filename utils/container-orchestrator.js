/**
 * Container Orchestrator for Wrfcoin Core
 *
 * This utility provides a consistent interface for managing containers
 * across different orchestration engines (Docker, Kubernetes)
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Constants
const DOCKER_COMPOSE_FILE = path.join(
  __dirname,
  '..',
  'docker',
  'docker-compose.yml'
);
const KUBERNETES_BASE_DIR = path.join(__dirname, '..', 'kubernetes', 'base');

/**
 * Available container engines
 */
const ENGINE = {
  DOCKER: 'docker',
  KUBERNETES: 'kubernetes',
  NONE: 'none',
};

/**
 * Container orchestrator
 */
class ContainerOrchestrator extends EventEmitter {
  /**
   * Create a container orchestrator
   * @param {Object} options Orchestrator options
   * @param {string} options.engine Container engine to use (docker, kubernetes, none)
   * @param {string} options.logLevel Log level (debug, info, warn, error)
   */
  constructor(options = {}) {
    super();

    this.engine = options.engine || ENGINE.NONE;
    this.logLevel = options.logLevel || 'info';
    this.verbose = this.logLevel === 'debug';

    // Validate engine
    if (!Object.values(ENGINE).includes(this.engine)) {
      throw new Error(`Invalid engine: ${this.engine}`);
    }

    this.log(
      'info',
      `Container orchestrator initialized with engine: ${this.engine}`
    );
  }

  /**
   * Log a message
   * @param {string} level Log level
   * @param {string} message Message to log
   */
  log(level, message) {
    const levels = ['debug', 'info', 'warn', 'error'];
    const levelIdx = levels.indexOf(level);
    const configLevelIdx = levels.indexOf(this.logLevel);

    if (levelIdx >= configLevelIdx) {
      const timestamp = new Date().toISOString();
      console[level === 'debug' ? 'log' : level](
        `[${timestamp}] [${level.toUpperCase()}] [container] ${message}`
      );
    }

    this.emit('log', { level, message, timestamp: new Date().toISOString() });
  }

  /**
   * Execute a command
   * @param {string} command Command to execute
   * @param {string[]} args Command arguments
   * @param {Object} options Spawn options
   * @returns {Promise<{stdout: string, stderr: string, code: number}>} Command output
   */
  async executeCommand(command, args = [], options = {}) {
    // Security: Validate command against allowlist to prevent command injection
    const allowedCommands = ['docker', 'docker-compose', 'kubectl'];
    if (!allowedCommands.includes(command)) {
      throw new Error(
        `Command not allowed: ${command}. Allowed commands: ${allowedCommands.join(', ')}`
      );
    }

    return new Promise(resolve => {
      this.log('debug', `Executing command: ${command} ${args.join(' ')}`);

      let stdout = '';
      let stderr = '';

      const child = spawn(command, args, {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', data => {
        const output = data.toString();
        stdout += output;

        if (this.verbose) {
          this.log('debug', `[stdout] ${output.trim()}`);
        }
      });

      child.stderr.on('data', data => {
        const output = data.toString();
        stderr += output;

        if (this.verbose) {
          this.log('debug', `[stderr] ${output.trim()}`);
        }
      });

      child.on('close', code => {
        this.log('debug', `Command exited with code ${code}`);
        resolve({ stdout, stderr, code });
      });
    });
  }

  /**
   * Check if Docker is available
   * @returns {Promise<boolean>} True if Docker is available
   */
  async checkDocker() {
    try {
      const { code } = await this.executeCommand('docker', ['--version']);
      return code === 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if Docker Compose is available
   * @returns {Promise<boolean>} True if Docker Compose is available
   */
  async checkDockerCompose() {
    try {
      const { code } = await this.executeCommand('docker-compose', [
        '--version',
      ]);
      return code === 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if Kubernetes is available
   * @returns {Promise<boolean>} True if Kubernetes is available
   */
  async checkKubernetes() {
    try {
      const { code } = await this.executeCommand('kubectl', [
        'version',
        '--client',
      ]);
      return code === 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Auto-detect available container engine
   * @returns {Promise<string>} Detected engine
   */
  async detectEngine() {
    if (await this.checkKubernetes()) {
      return ENGINE.KUBERNETES;
    } else if (await this.checkDockerCompose()) {
      return ENGINE.DOCKER;
    } else {
      return ENGINE.NONE;
    }
  }

  /**
   * Set the container engine
   * @param {string} engine Container engine
   */
  setEngine(engine) {
    if (!Object.values(ENGINE).includes(engine)) {
      throw new Error(`Invalid engine: ${engine}`);
    }

    this.engine = engine;
    this.log('info', `Container engine set to: ${engine}`);
  }

  /**
   * Start containers using Docker
   * @param {Object} options Docker options
   * @param {string} options.mode Network mode (testnet or mainnet)
   * @param {string} options.env Environment (development, staging, production)
   * @returns {Promise<boolean>} True if successful
   */
  async startDocker(options = {}) {
    const mode = options.mode || 'testnet';
    const env = options.env || 'development';

    if (this.engine !== ENGINE.DOCKER) {
      this.log('error', 'Cannot start Docker containers with current engine');
      return false;
    }

    try {
      // Check if Docker Compose file exists
      if (!fs.existsSync(DOCKER_COMPOSE_FILE)) {
        this.log(
          'error',
          `Docker Compose file not found: ${DOCKER_COMPOSE_FILE}`
        );
        return false;
      }

      // Create environment file
      const pgPassword = process.env.POSTGRES_PASSWORD;
      const apiKeyEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;
      if (!pgPassword) {
        this.log('error', 'POSTGRES_PASSWORD environment variable is required');
        return false;
      }
      if (!apiKeyEncryptionKey) {
        this.log(
          'error',
          'API_KEY_ENCRYPTION_KEY environment variable is required'
        );
        return false;
      }
      const envFile = path.join(path.dirname(DOCKER_COMPOSE_FILE), '.env');
      const envContent = [
        `NODE_ENV=${env}`,
        `NETWORK_MODE=${mode}`,
        `POSTGRES_PASSWORD=${pgPassword}`,
        `API_KEY_ENCRYPTION_KEY=${apiKeyEncryptionKey}`,
      ].join('\n');

      fs.writeFileSync(envFile, envContent);

      // Start containers
      this.log(
        'info',
        `Starting Docker containers with mode=${mode}, env=${env}`
      );

      const { code, stderr } = await this.executeCommand('docker-compose', [
        '-f',
        DOCKER_COMPOSE_FILE,
        'up',
        '-d',
      ]);

      if (code !== 0) {
        this.log('error', `Failed to start Docker containers: ${stderr}`);
        return false;
      }

      this.log('info', 'Docker containers started successfully');
      return true;
    } catch (error) {
      this.log('error', `Error starting Docker containers: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop Docker containers
   * @returns {Promise<boolean>} True if successful
   */
  async stopDocker() {
    if (this.engine !== ENGINE.DOCKER) {
      this.log('error', 'Cannot stop Docker containers with current engine');
      return false;
    }

    try {
      // Check if Docker Compose file exists
      if (!fs.existsSync(DOCKER_COMPOSE_FILE)) {
        this.log(
          'error',
          `Docker Compose file not found: ${DOCKER_COMPOSE_FILE}`
        );
        return false;
      }

      // Stop containers
      this.log('info', 'Stopping Docker containers');

      const { code, stderr } = await this.executeCommand('docker-compose', [
        '-f',
        DOCKER_COMPOSE_FILE,
        'down',
      ]);

      if (code !== 0) {
        this.log('error', `Failed to stop Docker containers: ${stderr}`);
        return false;
      }

      this.log('info', 'Docker containers stopped successfully');
      return true;
    } catch (error) {
      this.log('error', `Error stopping Docker containers: ${error.message}`);
      return false;
    }
  }

  /**
   * Start containers using Kubernetes
   * @param {Object} options Kubernetes options
   * @param {string} options.mode Network mode (testnet or mainnet)
   * @param {string} options.env Environment (development, staging, production)
   * @returns {Promise<boolean>} True if successful
   */
  async startKubernetes(options = {}) {
    const mode = options.mode || 'testnet';
    const env = options.env || 'development';

    if (this.engine !== ENGINE.KUBERNETES) {
      this.log(
        'error',
        'Cannot start Kubernetes resources with current engine'
      );
      return false;
    }

    try {
      // Check if Kubernetes base directory exists
      if (!fs.existsSync(KUBERNETES_BASE_DIR)) {
        this.log(
          'error',
          `Kubernetes base directory not found: ${KUBERNETES_BASE_DIR}`
        );
        return false;
      }

      if (!process.env.POSTGRES_PASSWORD) {
        this.log('error', 'POSTGRES_PASSWORD environment variable is required');
        return false;
      }
      if (!process.env.API_KEY_ENCRYPTION_KEY) {
        this.log(
          'error',
          'API_KEY_ENCRYPTION_KEY environment variable is required'
        );
        return false;
      }

      // Create temporary directory for kustomization
      const tempDir = path.join(os.tmpdir(), `wrfcoin-kustomize-${Date.now()}`);
      fs.mkdirSync(tempDir);

      // Create kustomization.yaml
      const kustomizationFile = path.join(tempDir, 'kustomization.yaml');
      const kustomizationContent = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ${KUBERNETES_BASE_DIR}

namePrefix: wrfcoin-

configMapGenerator:
  - name: wrfcoin-config
    literals:
      - NODE_ENV=${env}
      - NETWORK_MODE=${mode}

secretGenerator:
  - name: wrfcoin-secrets
    literals:
      - POSTGRES_PASSWORD=${process.env.POSTGRES_PASSWORD}
      - API_KEY_ENCRYPTION_KEY=${process.env.API_KEY_ENCRYPTION_KEY}
`;

      fs.writeFileSync(kustomizationFile, kustomizationContent);

      // Apply Kubernetes resources
      this.log(
        'info',
        `Starting Kubernetes resources with mode=${mode}, env=${env}`
      );

      const { code, stderr } = await this.executeCommand('kubectl', [
        'apply',
        '-k',
        tempDir,
      ]);

      // Clean up temporary directory
      fs.unlinkSync(kustomizationFile);
      fs.rmdirSync(tempDir);

      if (code !== 0) {
        this.log('error', `Failed to start Kubernetes resources: ${stderr}`);
        return false;
      }

      this.log('info', 'Kubernetes resources started successfully');
      return true;
    } catch (error) {
      this.log(
        'error',
        `Error starting Kubernetes resources: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Stop Kubernetes resources
   * @returns {Promise<boolean>} True if successful
   */
  async stopKubernetes() {
    if (this.engine !== ENGINE.KUBERNETES) {
      this.log('error', 'Cannot stop Kubernetes resources with current engine');
      return false;
    }

    try {
      // Stop Kubernetes resources
      this.log('info', 'Stopping Kubernetes resources');

      const { code, stderr } = await this.executeCommand('kubectl', [
        'delete',
        '-k',
        KUBERNETES_BASE_DIR,
      ]);

      if (code !== 0) {
        this.log('error', `Failed to stop Kubernetes resources: ${stderr}`);
        return false;
      }

      this.log('info', 'Kubernetes resources stopped successfully');
      return true;
    } catch (error) {
      this.log(
        'error',
        `Error stopping Kubernetes resources: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Start containers
   * @param {Object} options Start options
   * @param {string} options.mode Network mode (testnet or mainnet)
   * @param {string} options.env Environment (development, staging, production)
   * @returns {Promise<boolean>} True if successful
   */
  async start(options = {}) {
    if (this.engine === ENGINE.DOCKER) {
      return this.startDocker(options);
    } else if (this.engine === ENGINE.KUBERNETES) {
      return this.startKubernetes(options);
    } else {
      this.log('error', 'No container engine configured');
      return false;
    }
  }

  /**
   * Stop containers
   * @returns {Promise<boolean>} True if successful
   */
  async stop() {
    if (this.engine === ENGINE.DOCKER) {
      return this.stopDocker();
    } else if (this.engine === ENGINE.KUBERNETES) {
      return this.stopKubernetes();
    } else {
      this.log('error', 'No container engine configured');
      return false;
    }
  }

  /**
   * Get container status
   * @returns {Promise<Object>} Container status
   */
  async getStatus() {
    const status = {
      engine: this.engine,
      running: false,
      containers: [],
    };

    try {
      if (this.engine === ENGINE.DOCKER) {
        const { stdout, code } = await this.executeCommand('docker-compose', [
          '-f',
          DOCKER_COMPOSE_FILE,
          'ps',
          '--format',
          'json',
        ]);

        if (code !== 0) {
          return status;
        }

        try {
          // Parse container status as JSON or as plain text
          try {
            const containers = JSON.parse(stdout);
            status.containers = containers;
            status.running = containers.some(c => c.State === 'running');
          } catch (e) {
            // Handle older Docker Compose versions with plain text output
            const lines = stdout
              .trim()
              .split('\n')
              .filter(line => line.trim());
            if (lines.length > 1) {
              // First line is header
              status.running = lines.slice(1).some(line => line.includes('Up'));
              status.containers = lines.slice(1).map(line => {
                const parts = line.split(/\s{2,}/);
                return {
                  Name: parts[0],
                  State: parts.some(p => p.startsWith('Up'))
                    ? 'running'
                    : 'stopped',
                };
              });
            }
          }
        } catch (error) {
          this.log(
            'warn',
            `Error parsing Docker Compose output: ${error.message}`
          );
        }
      } else if (this.engine === ENGINE.KUBERNETES) {
        const { stdout, code } = await this.executeCommand('kubectl', [
          'get',
          'pods',
          '-l',
          'app=wrfcoin',
          '-o',
          'json',
        ]);

        if (code !== 0) {
          return status;
        }

        try {
          const data = JSON.parse(stdout);

          if (data.items && Array.isArray(data.items)) {
            status.containers = data.items.map(pod => ({
              Name: pod.metadata.name,
              State:
                pod.status.phase === 'Running' ? 'running' : pod.status.phase,
            }));

            status.running = status.containers.some(c => c.State === 'running');
          }
        } catch (error) {
          this.log('warn', `Error parsing Kubernetes output: ${error.message}`);
        }
      }
    } catch (error) {
      this.log('error', `Error getting container status: ${error.message}`);
    }

    return status;
  }
}

module.exports = {
  ContainerOrchestrator,
  ENGINE,
};
