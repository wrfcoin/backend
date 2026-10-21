const fs = require('fs');
const path = require('path');
const util = require('util');

const { exec, execFile } = require('child_process');
const toml = require('toml');

const {
  getAllDependencies,
  isEssentialModule,
  getDependents,
} = require('../config/module_dependencies');

/**
 * Module Controller Utility
 *
 * This utility provides functions for managing modules and workflows in the Wrfcoin Core system.
 * It allows enabling/disabling components through configuration files and manages the lifecycle
 * of workflows based on those configurations.
 */

const execPromise = util.promisify(exec);
// Use execFile (no shell) for any command that incorporates caller-supplied
// values. execPromise/exec spawns a shell and is unsafe with untrusted input.
const execFilePromise = util.promisify(execFile);

// Workflow category names are simple identifiers. Reject anything else so a
// caller-supplied value can never be interpreted as a shell argument/option or
// shell metacharacter. Defense-in-depth on top of the execFile argv form below.
// Must start alphanumeric so the value can never be read as a CLI option/flag.
const CATEGORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertValidCategory(category) {
  if (typeof category !== 'string' || !CATEGORY_NAME_PATTERN.test(category)) {
    throw new Error('Invalid category name');
  }
}

// Path constants
const CONFIG_DIR = path.join(__dirname, '../config');
const DEV_CONFIG_PATH = path.join(CONFIG_DIR, 'dev.toml');
const PROD_CONFIG_PATH = path.join(CONFIG_DIR, 'prod.toml');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');

// Ensure profiles directory exists
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Get the current active config path based on environment
 * @returns {string} Path to the active config file
 */
function getActiveConfigPath() {
  const isProduction = process.env.NODE_ENV === 'production';
  return isProduction ? PROD_CONFIG_PATH : DEV_CONFIG_PATH;
}

/**
 * Read and parse the module configuration from TOML file
 * @returns {Promise<Object>} Parsed module configuration
 */
async function getModuleConfig() {
  try {
    const configPath = getActiveConfigPath();

    if (!fs.existsSync(configPath)) {
      // Create a default config if none exists
      const defaultConfig = {
        core: { enabled: true },
        consensus: { enabled: true },
        storage: { enabled: true },
        network: { enabled: true },
        privacy: { enabled: true },
        governance: { enabled: true },
        crosschain: { enabled: true },
        computational: { enabled: true },
        weather: { enabled: true },
        oracle: { enabled: true },
        incentives: { enabled: true },
        sidechain: { enabled: true },
      };

      await fs.promises.writeFile(
        configPath,
        Object.entries(defaultConfig)
          .map(([section, values]) => {
            return `[${section}]\n${Object.entries(values)
              .map(([k, v]) => `${k} = ${v}`)
              .join('\n')}`;
          })
          .join('\n\n')
      );

      return defaultConfig;
    }

    const configContent = await fs.promises.readFile(configPath, 'utf8');
    return toml.parse(configContent);
  } catch (error) {
    console.error('Error reading module configuration:', error);
    throw new Error('Failed to read module configuration');
  }
}

/**
 * Update the module configuration and write it to the TOML file
 * @param {Object} config - New module configuration
 * @returns {Promise<void>}
 */
async function updateModuleConfig(config) {
  try {
    const configPath = getActiveConfigPath();

    // Convert config object to TOML format
    const tomlContent = Object.entries(config)
      .map(([section, values]) => {
        return `[${section}]\n${Object.entries(values)
          .map(([k, v]) => {
            if (typeof v === 'boolean') {
              return `${k} = ${v}`;
            } else if (typeof v === 'string') {
              return `${k} = "${v}"`;
            } else if (typeof v === 'number') {
              return `${k} = ${v}`;
            } else if (Array.isArray(v)) {
              return `${k} = [${v.map(item => (typeof item === 'string' ? `"${item}"` : item)).join(', ')}]`;
            }
            return `${k} = ${JSON.stringify(v)}`;
          })
          .join('\n')}`;
      })
      .join('\n\n');

    await fs.promises.writeFile(configPath, tomlContent);
  } catch (error) {
    console.error('Error updating module configuration:', error);
    throw new Error('Failed to update module configuration');
  }
}

/**
 * Enable a specific module in the configuration, along with its dependencies
 * @param {string} moduleName - Name of the module to enable
 * @param {boolean} enableDependencies - Whether to enable dependencies
 * @returns {Promise<void>}
 */
async function enableModule(moduleName, enableDependencies = true) {
  try {
    const config = await getModuleConfig();
    const dependencies = [];

    // If enableDependencies is true, we need to enable all dependencies
    if (enableDependencies) {
      try {
        // Dynamically require the module_dependencies.js file
        dependencies.push(...getAllDependencies(moduleName));
      } catch (depError) {
        console.warn(
          `Error loading dependencies for module ${moduleName}:`,
          depError
        );
        // Continue without dependencies if there's an error
      }
    }

    // Enable the requested module
    if (!config[moduleName]) {
      config[moduleName] = { enabled: true };
    } else {
      config[moduleName].enabled = true;
    }

    // Enable all dependencies
    for (const dep of dependencies) {
      if (!config[dep]) {
        config[dep] = { enabled: true };
      } else {
        config[dep].enabled = true;
      }
    }

    await updateModuleConfig(config);

    if (dependencies.length > 0) {
      console.log(
        `Enabled module ${moduleName} and its dependencies: ${dependencies.join(', ')}`
      );
    } else {
      console.log(`Enabled module ${moduleName}`);
    }
  } catch (error) {
    console.error(`Error enabling module ${moduleName}:`, error);
    throw new Error(`Failed to enable module ${moduleName}`);
  }
}

/**
 * Disable a specific module in the configuration and optionally its dependents
 * @param {string} moduleName - Name of the module to disable
 * @param {boolean} disableDependents - Whether to also disable modules that depend on this one
 * @returns {Promise<{disabled: string[], skipped: string[]}>} List of disabled modules and skipped essential modules
 */
async function disableModule(moduleName, disableDependents = false) {
  try {
    const config = await getModuleConfig();
    const disabled = [];
    const skipped = [];

    // Check if this is an essential module that shouldn't be disabled
    let isEssential = false;
    try {
      isEssential = isEssentialModule(moduleName);
    } catch (depError) {
      console.warn(
        `Error checking if module ${moduleName} is essential:`,
        depError
      );
      // Continue without dependency checking if there's an error
    }

    if (isEssential) {
      console.warn(
        `Warning: ${moduleName} is an essential module and cannot be disabled.`
      );
      skipped.push(moduleName);
    } else {
      // Disable the requested module
      if (!config[moduleName]) {
        config[moduleName] = { enabled: false };
      } else {
        config[moduleName].enabled = false;
      }
      disabled.push(moduleName);

      // If disableDependents is true, also disable modules that depend on this one
      if (disableDependents) {
        try {
          const dependents = getDependents(moduleName);

          for (const dep of dependents) {
            // Skip essential modules
            let depIsEssential = false;
            try {
              depIsEssential = isEssentialModule(dep);
            } catch (err) {
              console.debug('Unable to determine if module is essential', {
                dependency: dep,
                error: err.message
              });
              depIsEssential = false;
            }

            if (depIsEssential) {
              console.warn(
                `Warning: ${dep} is an essential module and cannot be disabled.`
              );
              skipped.push(dep);
              continue;
            }

            if (!config[dep]) {
              config[dep] = { enabled: false };
            } else {
              config[dep].enabled = false;
            }
            disabled.push(dep);
          }
        } catch (depError) {
          console.warn(
            `Error disabling dependents of module ${moduleName}:`,
            depError
          );
          // Continue without disabling dependents if there's an error
        }
      }
    }

    await updateModuleConfig(config);

    if (disabled.length > 0) {
      if (disabled.length > 1) {
        console.log(
          `Disabled module ${moduleName} and its dependents: ${disabled.filter(d => d !== moduleName).join(', ')}`
        );
      } else {
        console.log(`Disabled module ${moduleName}`);
      }
    }

    if (skipped.length > 0) {
      console.log(`Skipped essential modules: ${skipped.join(', ')}`);
    }

    return { disabled, skipped };
  } catch (error) {
    console.error(`Error disabling module ${moduleName}:`, error);
    throw new Error(`Failed to disable module ${moduleName}`);
  }
}

/**
 * Check if a module is enabled in the configuration
 * @param {string} moduleName - Name of the module to check
 * @param {boolean} defaultValue - Default value to return if module not found
 * @returns {boolean} Whether the module is enabled
 */
function isEnabled(moduleName, defaultValue = true) {
  try {
    // Synchronous version to avoid async/await in simple checks
    const configPath = getActiveConfigPath();

    if (!require('fs').existsSync(configPath)) {
      return defaultValue;
    }

    const config = toml.parse(configContent);

    // If the module doesn't exist in config, return default
    if (!config[moduleName]) {
      return defaultValue;
    }

    // If the module exists but doesn't have enabled property, return default
    if (typeof config[moduleName].enabled !== 'boolean') {
      return defaultValue;
    }

    return config[moduleName].enabled;
  } catch (error) {
    console.error(`Error checking if module ${moduleName} is enabled:`, error);
    return defaultValue;
  }
}

/**
 * Get the status of all workflows in the system
 * @returns {Promise<Array<Object>>} List of workflows with their status
 */
async function getWorkflowStatuses() {
  try {
    // This is a placeholder - in a real implementation, you would query
    // the actual workflow status from your workflow management system
    // We've seen from the project workflows are managed through "workflows_set_run_config_tool"

    // Execute a command to get workflow status information
    const { stdout } = await execPromise(
      'node scripts/workflow_manager.js --list'
    );

    // Parse the output into a structured format
    // Format is expected to be: "workflow_name: status (enabled|disabled)"
    return stdout
      .trim()
      .split('\n')
      .map(line => {
        // Handle the case where line doesn't contain a colon
        if (!line.includes(':')) {
          return {
            name: line.trim(),
            status: 'unknown',
            enabled: false,
          };
        }

        const [name, statusInfo] = line.split(':').map(part => part.trim());

        // Check if statusInfo exists before trying to match
        if (!statusInfo) {
          return {
            name,
            status: 'unknown',
            enabled: false,
          };
        }

        const match = statusInfo.match(/(\w+)\s+\((\w+)\)/);

        if (match) {
          const [, status, enabled] = match;
          return {
            name,
            status,
            enabled: enabled === 'enabled',
          };
        }

        return {
          name,
          status: statusInfo || 'unknown',
          enabled: false,
        };
      });
  } catch (error) {
    console.error('Error getting workflow statuses:', error);

    // If the command fails, we'll return some default information
    // based on the configured workflows
    const config = await getModuleConfig();

    // Map modules to likely workflows
    const workflowMap = {
      core: ['Wrfcoin Core'],
      storage: ['Database Push'],
      crosschain: ['Test Cross-Chain', 'Test Cross-Chain Integration'],
      computational: ['Test Computational Blocks', 'Test Computational DB'],
      weather: [
        'Test Weather Data Validation',
        'Test Weather Parsers',
        'Test Weather Station Protocol',
      ],
      oracle: ['Oracle Schema Migration'],
      governance: [
        'Test Governance',
        'Test Governance System',
        'Seed Governance',
      ],
      privacy: ['Test Privacy', 'Test Privacy Features'],
      sidechain: ['Test Sidechain'],
    };

    // Create workflow status objects based on module enablement
    const workflows = [];

    Object.entries(workflowMap).forEach(([module, moduleWorkflows]) => {
      const enabled = config[module]?.enabled ?? false;

      moduleWorkflows.forEach(workflow => {
        workflows.push({
          name: workflow,
          status: enabled ? 'running' : 'stopped',
          enabled,
        });
      });
    });

    return workflows;
  }
}

/**
 * Restart all workflows based on the current module configuration
 * @returns {Promise<void>}
 */
async function restartWorkflows() {
  try {
    await execPromise('node scripts/workflow_manager.js --restart-all');
  } catch (error) {
    console.error('Error restarting workflows:', error);
    throw new Error('Failed to restart workflows');
  }
}

/**
 * Get all workflow categories
 * @returns {Promise<Array<Object>>} List of workflow categories with their status
 */
async function getWorkflowCategories() {
  try {
    const { stdout } = await execPromise(
      'node scripts/workflow_manager.js --list-categories'
    );

    // Parse the output into a structured format
    return stdout
      .trim()
      .split('\n')
      .map(line => {
        // Handle the case where line doesn't contain a colon
        if (!line.includes(':')) {
          return {
            name: line.trim(),
            status: 'unknown',
            enabledCount: 0,
            totalCount: 0,
          };
        }

        const [category, statusInfo] = line.split(':').map(part => part.trim());

        // Check if statusInfo exists before trying to match
        if (!statusInfo) {
          return {
            name: category,
            status: 'unknown',
            enabledCount: 0,
            totalCount: 0,
          };
        }

        const match = statusInfo.match(/(\w+)\s+\((\d+)\/(\d+)\)/);

        if (match) {
          const [, status, enabledCount, totalCount] = match;
          return {
            name: category,
            status,
            enabledCount: parseInt(enabledCount, 10),
            totalCount: parseInt(totalCount, 10),
          };
        }

        return {
          name: category,
          status: statusInfo || 'unknown',
          enabledCount: 0,
          totalCount: 0,
        };
      });
  } catch (error) {
    console.error('Error getting workflow categories:', error);

    // Default categories if command fails
    return [
      { name: 'core', status: 'active', enabledCount: 1, totalCount: 1 },
      { name: 'consensus', status: 'active', enabledCount: 2, totalCount: 2 },
      { name: 'storage', status: 'active', enabledCount: 1, totalCount: 1 },
      { name: 'network', status: 'active', enabledCount: 2, totalCount: 2 },
      { name: 'privacy', status: 'partial', enabledCount: 1, totalCount: 2 },
      { name: 'governance', status: 'active', enabledCount: 3, totalCount: 3 },
      { name: 'crosschain', status: 'active', enabledCount: 4, totalCount: 4 },
      {
        name: 'computational',
        status: 'partial',
        enabledCount: 2,
        totalCount: 3,
      },
      { name: 'weather', status: 'active', enabledCount: 3, totalCount: 3 },
      { name: 'oracle', status: 'active', enabledCount: 1, totalCount: 1 },
      { name: 'incentives', status: 'active', enabledCount: 1, totalCount: 1 },
      { name: 'sidechain', status: 'inactive', enabledCount: 0, totalCount: 1 },
    ];
  }
}

/**
 * Enable all workflows in a specific category
 * @param {string} category - Category name
 * @returns {Promise<void>}
 */
async function enableCategory(category) {
  try {
    assertValidCategory(category);
    await execFilePromise('node', [
      'scripts/workflow_manager.js',
      'enable-category',
      category,
    ]);

    // Update config file too
    const config = await getModuleConfig();
    if (!config[category]) {
      config[category] = { enabled: true };
    } else {
      config[category].enabled = true;
    }
    await updateModuleConfig(config);
  } catch (error) {
    console.error(`Error enabling category ${category}:`, error);
    throw new Error(`Failed to enable category ${category}`);
  }
}

/**
 * Disable all workflows in a specific category
 * @param {string} category - Category name
 * @returns {Promise<void>}
 */
async function disableCategory(category) {
  try {
    assertValidCategory(category);
    await execFilePromise('node', [
      'scripts/workflow_manager.js',
      'disable-category',
      category,
    ]);

    // Update config file too
    const config = await getModuleConfig();
    if (!config[category]) {
      config[category] = { enabled: false };
    } else {
      config[category].enabled = false;
    }
    await updateModuleConfig(config);
  } catch (error) {
    console.error(`Error disabling category ${category}:`, error);
    throw new Error(`Failed to disable category ${category}`);
  }
}

/**
 * Save current configuration as a profile
 * @param {string} name - Profile name
 * @param {string} description - Profile description
 * @returns {Promise<void>}
 */
async function saveConfigProfile(name, description) {
  try {
    const config = await getModuleConfig();

    // Add metadata to the config
    const profileConfig = {
      ...config,
      meta: {
        name,
        description,
        createdAt: new Date().toISOString(),
      },
    };

    const profilePath = path.join(PROFILES_DIR, `${name}.toml`);

    // Convert config object to TOML format
    const tomlContent = Object.entries(profileConfig)
      .map(([section, values]) => {
        return `[${section}]\n${Object.entries(values)
          .map(([k, v]) => {
            if (typeof v === 'boolean') {
              return `${k} = ${v}`;
            } else if (typeof v === 'string') {
              return `${k} = "${v}"`;
            } else if (typeof v === 'number') {
              return `${k} = ${v}`;
            } else if (Array.isArray(v)) {
              return `${k} = [${v.map(item => (typeof item === 'string' ? `"${item}"` : item)).join(', ')}]`;
            }
            return `${k} = ${JSON.stringify(v)}`;
          })
          .join('\n')}`;
      })
      .join('\n\n');

    await fs.promises.writeFile(profilePath, tomlContent);
  } catch (error) {
    console.error(`Error saving configuration profile ${name}:`, error);
    throw new Error(`Failed to save configuration profile ${name}`);
  }
}

/**
 * Get all saved configuration profiles
 * @returns {Promise<Array<Object>>} List of configuration profiles
 */
async function getConfigProfiles() {
  try {
    const files = await fs.promises.readdir(PROFILES_DIR);
    const profiles = [];

    for (const file of files) {
      if (file.endsWith('.toml')) {
        const profilePath = path.join(PROFILES_DIR, file);
        const content = await fs.promises.readFile(profilePath, 'utf8');
        const config = toml.parse(content);

        profiles.push({
          name: config.meta?.name || file.replace('.toml', ''),
          description: config.meta?.description || '',
          createdAt: config.meta?.createdAt || '',
        });
      }
    }

    return profiles;
  } catch (error) {
    console.error('Error getting configuration profiles:', error);
    return [];
  }
}

/**
 * Load a saved configuration profile
 * @param {string} name - Profile name
 * @returns {Promise<void>}
 */
async function loadConfigProfile(name) {
  try {
    // Try exact match first
    let profilePath = path.join(PROFILES_DIR, `${name}.toml`);

    // If file doesn't exist, try a case-insensitive match
    if (!fs.existsSync(profilePath)) {
      // Get all profile files
      const files = fs.readdirSync(PROFILES_DIR);
      const profileFile = files.find(
        f =>
          f.toLowerCase() === `${name.toLowerCase()}.toml` ||
          f.replace(/\s+/g, '_').toLowerCase() ===
            `${name.toLowerCase()}.toml` ||
          f
            .replace(/\_/g, ' ')
            .toLowerCase()
            .replace(/\.toml$/i, '') === name.toLowerCase()
      );

      if (profileFile) {
        profilePath = path.join(PROFILES_DIR, profileFile);
      } else {
        throw new Error(`Profile ${name} does not exist`);
      }
    }

    console.log(`Loading profile from: ${profilePath}`);
    const content = await fs.promises.readFile(profilePath, 'utf8');
    const config = toml.parse(content);

    // Remove metadata from the config
    delete config.meta;

    // Update the active config
    await updateModuleConfig(config);

    // Restart the workflows based on the new config
    await restartWorkflows();
  } catch (error) {
    console.error(`Error loading configuration profile ${name}:`, error);
    throw new Error(`Failed to load configuration profile ${name}`);
  }
}

module.exports = {
  getModuleConfig,
  updateModuleConfig,
  enableModule,
  disableModule,
  isEnabled,
  getWorkflowStatuses,
  restartWorkflows,
  getWorkflowCategories,
  enableCategory,
  disableCategory,
  saveConfigProfile,
  getConfigProfiles,
  loadConfigProfile,
};
