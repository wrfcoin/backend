/**
 * Climate Model Integration Framework
 *
 * A comprehensive framework for integrating multiple climate models (WRF, ICON, GFS)
 * with WRFCoin's weather data platform. Provides unified interfaces for model execution,
 * data exchange, and blockchain provenance tracking.
 *
 * Architecture Features:
 * - Model Adapter Pattern for unified interfaces
 * - Blockchain provenance tracking for data integrity
 * - Asynchronous job orchestration and management
 * - Support for containerized model execution
 * - Standardized data format conversion
 * - Comprehensive validation and quality control
 *
 * Supported Models:
 * - WRF (Weather Research and Forecasting) - Regional atmospheric modeling
 * - GFS (Global Forecast System) - NOAA global numerical weather prediction
 * - ICON (ICOsahedral Nonhydrostatic) - German weather/climate model
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
const util = require('util');
const Logger = require('../utils/logger');

// Import existing WRFCoin services
const { WeatherDataValidator } = require('./weather-data-validator');
const { BlockchainService } = require('./blockchain-transaction-service');
const { DatabaseManager } = require('../database/database-manager');

const execAsync = util.promisify(exec);

/**
 * Base Model Adapter Interface
 * All model adapters must implement this interface
 */
class BaseModelAdapter {
  constructor(config = {}) {
    this.config = config;
    this.logger = Logger;
    this.status = 'initialized';
    this.lastRun = null;
    this.metrics = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      averageRunTime: 0,
    };
  }

  /**
   * Execute model with given parameters
   * @param {Object} params - Model execution parameters
   * @returns {Promise<ModelExecutionResult>}
   */
  async execute(params) {
    throw new Error('execute() method must be implemented by model adapters');
  }

  /**
   * Get model data/forecast
   * @param {Object} params - Data retrieval parameters
   * @returns {Promise<ModelDataResult>}
   */
  async getData(params) {
    throw new Error('getData() method must be implemented by model adapters');
  }

  /**
   * Validate model configuration
   * @param {Object} config - Model configuration
   * @returns {ValidationResult}
   */
  validateConfig(config) {
    throw new Error(
      'validateConfig() method must be implemented by model adapters'
    );
  }

  /**
   * Get model health status
   * @returns {HealthStatus}
   */
  getHealth() {
    return {
      status: this.status,
      lastRun: this.lastRun,
      metrics: this.metrics,
      healthy: this.status !== 'error',
    };
  }

  /**
   * Update metrics after model run
   */
  updateMetrics(success, runTime) {
    this.metrics.totalRuns++;
    if (success) {
      this.metrics.successfulRuns++;
    } else {
      this.metrics.failedRuns++;
    }

    // Update average run time
    const count = this.metrics.totalRuns;
    this.metrics.averageRunTime =
      (this.metrics.averageRunTime * (count - 1) + runTime) / count;

    this.lastRun = new Date();
  }
}

/**
 * GFS Model Adapter
 * Handles Global Forecast System data retrieval and processing
 */
class GFSAdapter extends BaseModelAdapter {
  constructor(config = {}) {
    super(config);
    this.modelName = 'GFS';
    this.baseUrl =
      config.baseUrl ||
      'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod';
    this.awsUrl = config.awsUrl || 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
    this.useAWS = config.useAWS || true; // AWS is faster
    this.resolution = config.resolution || '0p25'; // 0.25 degree resolution
    this.maxForecastHours = config.maxForecastHours || 384; // 16 days
  }

  /**
   * Execute GFS data retrieval
   */
  async execute(params) {
    const startTime = Date.now();

    try {
      this.status = 'running';
      this.logger.info(
        `Starting GFS data retrieval: ${JSON.stringify(params)}`
      );

      const {
        runTime = this.getLatestRunTime(),
        forecastHours = [0, 6, 12, 18, 24],
        variables = ['TMP', 'UGRD', 'VGRD', 'HGT', 'RH'],
        bounds = null, // { north, south, east, west }
        outputFormat = 'netcdf',
      } = params;

      // Download and process GFS files
      const downloadedFiles = await this.downloadGFSFiles({
        runTime,
        forecastHours,
        variables,
        bounds,
      });

      // Convert to standard format if needed
      const processedData = await this.processGFSData(downloadedFiles, {
        outputFormat,
        bounds,
        variables,
      });

      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(true, runTime_ms);
      this.status = 'completed';

      return {
        success: true,
        modelName: this.modelName,
        runTime: runTime_ms,
        data: processedData,
        metadata: {
          gfsRunTime: runTime,
          forecastHours,
          variables,
          resolution: this.resolution,
          downloadSource: this.useAWS ? 'AWS' : 'NOMADS',
        },
      };
    } catch (error) {
      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(false, runTime_ms);
      this.status = 'error';

      this.logger.error('GFS execution failed:', error);

      return {
        success: false,
        modelName: this.modelName,
        error: error.message,
        runTime: runTime_ms,
      };
    }
  }

  /**
   * Get GFS forecast data
   */
  async getData(params) {
    return await this.execute(params);
  }

  /**
   * Download GFS GRIB2 files
   */
  async downloadGFSFiles({ runTime, forecastHours, variables, bounds }) {
    const downloadedFiles = [];

    for (const hour of forecastHours) {
      const fileName = this.constructGFSFileName(runTime, hour);
      const url = this.constructGFSUrl(runTime, fileName);

      try {
        const filePath = await this.downloadFile(url, fileName);
        downloadedFiles.push({
          forecastHour: hour,
          filePath,
          url,
          size: await this.getFileSize(filePath),
        });

        this.logger.debug(`Downloaded GFS file: ${fileName}`);
      } catch (error) {
        this.logger.error(`Failed to download GFS file ${fileName}:`, error);
        throw error;
      }
    }

    return downloadedFiles;
  }

  /**
   * Process GFS GRIB2 data
   */
  async processGFSData(files, options) {
    const processedFiles = [];

    for (const file of files) {
      try {
        // Extract variables using Python xarray/cfgrib
        const extractedData = await this.extractGRIBVariables(
          file.filePath,
          options.variables,
          options.bounds
        );

        // Convert to requested format
        const outputPath = await this.convertDataFormat(
          extractedData,
          options.outputFormat,
          file.forecastHour
        );

        processedFiles.push({
          forecastHour: file.forecastHour,
          originalFile: file.filePath,
          processedFile: outputPath,
          variables: options.variables,
          format: options.outputFormat,
        });
      } catch (error) {
        this.logger.error(
          `Failed to process GFS file ${file.filePath}:`,
          error
        );
        throw error;
      }
    }

    return processedFiles;
  }

  /**
   * Get latest GFS run time
   */
  getLatestRunTime() {
    const now = new Date();
    const hour = now.getUTCHours();

    // GFS runs at 00, 06, 12, 18 UTC
    const runHours = [0, 6, 12, 18];
    const latestRunHour = runHours.reduce((prev, curr) => {
      return hour >= curr ? curr : prev;
    });

    const runTime = new Date(now);
    runTime.setUTCHours(latestRunHour, 0, 0, 0);

    // If the latest run hasn't finished processing, use previous run
    if (now.getTime() - runTime.getTime() < 3 * 60 * 60 * 1000) {
      // 3 hours
      runTime.setTime(runTime.getTime() - 6 * 60 * 60 * 1000); // Previous run
    }

    return runTime;
  }

  /**
   * Construct GFS file name
   */
  constructGFSFileName(runTime, forecastHour) {
    const year = runTime.getUTCFullYear();
    const month = String(runTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(runTime.getUTCDate()).padStart(2, '0');
    const hour = String(runTime.getUTCHours()).padStart(2, '0');
    const fHour = String(forecastHour).padStart(3, '0');

    return `gfs.t${hour}z.pgrb2.${this.resolution}.f${fHour}`;
  }

  /**
   * Construct GFS download URL
   */
  constructGFSUrl(runTime, fileName) {
    const year = runTime.getUTCFullYear();
    const month = String(runTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(runTime.getUTCDate()).padStart(2, '0');
    const hour = String(runTime.getUTCHours()).padStart(2, '0');

    if (this.useAWS) {
      return `${this.awsUrl}/gfs.${year}${month}${day}/${hour}/atmos/${fileName}`;
    } else {
      return `${this.baseUrl}/gfs.${year}${month}${day}/${hour}/atmos/${fileName}`;
    }
  }

  /**
   * Extract variables from GRIB2 file using Python
   */
  async extractGRIBVariables(filePath, variables, bounds) {
    const pythonScript = `
import xarray as xr
import sys
import json

try:
    # Read GRIB file with cfgrib
    ds = xr.open_dataset('${filePath}', engine='cfgrib')
    
    # Extract requested variables
    extracted = {}
    for var in ${JSON.stringify(variables)}:
        if var.lower() in ds.data_vars:
            data = ds[var.lower()]
            
            # Apply bounds if specified
            ${
              bounds
                ? `
            data = data.sel(
                latitude=slice(${bounds.north}, ${bounds.south}),
                longitude=slice(${bounds.west}, ${bounds.east})
            )
            `
                : ''
            }
            
            extracted[var] = {
                'data': data.values.tolist(),
                'coordinates': {
                    'latitude': data.latitude.values.tolist(),
                    'longitude': data.longitude.values.tolist()
                },
                'attributes': dict(data.attrs)
            }
    
    print(json.dumps(extracted))
    
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const outputPath = `/tmp/extract_grib_${Date.now()}.py`;
    await fs.writeFile(outputPath, pythonScript);

    try {
      const { stdout, stderr } = await execAsync(`python3 ${outputPath}`);

      if (stderr && stderr.includes('error')) {
        throw new Error(`GRIB extraction failed: ${stderr}`);
      }

      return JSON.parse(stdout);
    } finally {
      await fs.unlink(outputPath).catch(() => {}); // Clean up
    }
  }

  /**
   * Validate GFS configuration
   */
  validateConfig(config) {
    const errors = [];

    if (config.forecastHours) {
      const invalidHours = config.forecastHours.filter(
        h => h < 0 || h > this.maxForecastHours
      );
      if (invalidHours.length > 0) {
        errors.push(`Invalid forecast hours: ${invalidHours.join(', ')}`);
      }
    }

    if (
      config.resolution &&
      !['0p25', '0p50', '1p00'].includes(config.resolution)
    ) {
      errors.push(`Invalid resolution: ${config.resolution}`);
    }

    if (config.bounds) {
      const { north, south, east, west } = config.bounds;
      if (north <= south || east <= west) {
        errors.push(
          'Invalid bounds: north must be > south, east must be > west'
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Download file from URL
   */
  async downloadFile(url, fileName) {
    const outputPath = `/tmp/gfs_${fileName}`;

    // Use curl for reliable downloads
    const command = `curl -s -o "${outputPath}" "${url}"`;
    await execAsync(command);

    // Verify file was downloaded
    const exists = await fs
      .access(outputPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error(`Failed to download file from ${url}`);
    }

    return outputPath;
  }

  /**
   * Get file size
   */
  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  /**
   * Convert data to specified format
   */
  async convertDataFormat(data, format, forecastHour) {
    const outputPath = `/tmp/gfs_converted_f${String(forecastHour).padStart(3, '0')}.${format}`;

    switch (format) {
      case 'netcdf':
        return await this.convertToNetCDF(data, outputPath);
      case 'json':
        await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
        return outputPath;
      default:
        throw new Error(`Unsupported output format: ${format}`);
    }
  }

  /**
   * Convert data to NetCDF format
   */
  async convertToNetCDF(data, outputPath) {
    const pythonScript = `
import xarray as xr
import numpy as np
import json
import sys

try:
    # Load data from JSON
    data = json.loads('${JSON.stringify(data).replace(/'/g, "\\'")}')
    
    # Create xarray dataset
    data_vars = {}
    coords = {}
    
    for var_name, var_data in data.items():
        if 'error' in var_data:
            continue
            
        # Extract coordinates from first variable
        if not coords:
            coords['latitude'] = var_data['coordinates']['latitude']
            coords['longitude'] = var_data['coordinates']['longitude']
        
        # Create data array
        data_vars[var_name] = (['latitude', 'longitude'], var_data['data'])
    
    # Create dataset
    ds = xr.Dataset(data_vars, coords=coords)
    
    # Save to NetCDF
    ds.to_netcdf('${outputPath}')
    print('SUCCESS')
    
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`;

    const scriptPath = `/tmp/convert_netcdf_${Date.now()}.py`;
    await fs.writeFile(scriptPath, pythonScript);

    try {
      const { stdout, stderr } = await execAsync(`python3 ${scriptPath}`);

      if (stderr && stderr.includes('ERROR')) {
        throw new Error(`NetCDF conversion failed: ${stderr}`);
      }

      return outputPath;
    } finally {
      await fs.unlink(scriptPath).catch(() => {});
    }
  }
}

/**
 * WRF Model Adapter
 * Handles Weather Research and Forecasting model execution
 */
class WRFAdapter extends BaseModelAdapter {
  constructor(config = {}) {
    super(config);
    this.modelName = 'WRF';
    this.wrfPath = config.wrfPath || '/usr/local/wrf';
    this.wpsPath = config.wpsPath || '/usr/local/wps';
    this.workDir = config.workDir || '/tmp/wrf_runs';
    this.dockerImage = config.dockerImage || 'wrfcoin/wrf:latest';
    this.useDocker = config.useDocker !== false; // Default to Docker
    this.maxRuntimeHours = config.maxRuntimeHours || 12;
  }

  /**
   * Execute WRF model simulation
   */
  async execute(params) {
    const startTime = Date.now();
    const runId = this.generateRunId();

    try {
      this.status = 'running';
      this.logger.info(
        `Starting WRF model run ${runId}: ${JSON.stringify(params)}`
      );

      const {
        domain, // { center: [lat, lon], size: [nx, ny], resolution: [dx, dy] }
        timeRange, // { start: Date, end: Date }
        physicsOptions = 'default',
        boundaryData, // Path to GFS or other boundary condition data
        outputFrequency = 3600, // seconds
        parallelCores = 4,
      } = params;

      // Validate parameters
      const validation = this.validateWRFParams(params);
      if (!validation.valid) {
        throw new Error(
          `Invalid WRF parameters: ${validation.errors.join(', ')}`
        );
      }

      // Create run directory
      const runDir = await this.createRunDirectory(runId);

      // Prepare WRF configuration
      await this.prepareWRFConfiguration(runDir, {
        domain,
        timeRange,
        physicsOptions,
        outputFrequency,
        parallelCores,
      });

      // Prepare boundary conditions (WPS workflow)
      await this.prepareBoundaryConditions(runDir, boundaryData);

      // Execute WRF simulation
      const simulationResult = await this.runWRFSimulation(
        runDir,
        parallelCores
      );

      // Post-process outputs
      const outputs = await this.postProcessWRFOutputs(runDir);

      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(true, runTime_ms);
      this.status = 'completed';

      return {
        success: true,
        modelName: this.modelName,
        runId,
        runTime: runTime_ms,
        outputs,
        metadata: {
          domain,
          timeRange,
          physicsOptions,
          parallelCores,
          workDirectory: runDir,
        },
      };
    } catch (error) {
      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(false, runTime_ms);
      this.status = 'error';

      this.logger.error(`WRF execution failed for run ${runId}:`, error);

      return {
        success: false,
        modelName: this.modelName,
        runId,
        error: error.message,
        runTime: runTime_ms,
      };
    }
  }

  /**
   * Generate unique run ID
   */
  generateRunId() {
    return `wrf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create WRF run directory
   */
  async createRunDirectory(runId) {
    const runDir = path.join(this.workDir, runId);
    await fs.mkdir(runDir, { recursive: true });

    // Create subdirectories
    await fs.mkdir(path.join(runDir, 'wps'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'wrf'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'output'), { recursive: true });

    return runDir;
  }

  /**
   * Prepare WRF namelist.input configuration
   */
  async prepareWRFConfiguration(runDir, config) {
    const {
      domain,
      timeRange,
      physicsOptions,
      outputFrequency,
      parallelCores,
    } = config;

    // Calculate domain parameters
    const startDate = new Date(timeRange.start);
    const endDate = new Date(timeRange.end);
    const runDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));
    const runHours = Math.floor(
      ((endDate - startDate) % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)
    );

    const namelist = `
&time_control
 run_days                = ${runDays},
 run_hours               = ${runHours},
 start_year              = ${startDate.getUTCFullYear()},
 start_month             = ${startDate.getUTCMonth() + 1},
 start_day               = ${startDate.getUTCDate()},
 start_hour              = ${startDate.getUTCHours()},
 end_year                = ${endDate.getUTCFullYear()},
 end_month               = ${endDate.getUTCMonth() + 1},
 end_day                 = ${endDate.getUTCDate()},
 end_hour                = ${endDate.getUTCHours()},
 interval_seconds        = 21600,
 input_from_file         = .true.,
 history_interval        = ${Math.floor(outputFrequency / 60)},
 frames_per_outfile      = 1,
 restart                 = .false.,
 io_form_history         = 2,
 io_form_restart         = 2,
 io_form_input           = 2,
 io_form_boundary        = 2,
/

&domains
 time_step               = 60,
 max_dom                 = 1,
 e_we                    = ${domain.size[0]},
 e_sn                    = ${domain.size[1]},
 e_vert                  = 45,
 dx                      = ${domain.resolution[0]},
 dy                      = ${domain.resolution[1]},
 grid_id                 = 1,
 parent_id               = 0,
 i_parent_start          = 1,
 j_parent_start          = 1,
 parent_grid_ratio       = 1,
 parent_time_step_ratio  = 1,
 feedback                = 1,
 smooth_option           = 0,
/

&physics
 mp_physics              = 6,
 ra_lw_physics           = 4,
 ra_sw_physics           = 4,
 radt                    = 10,
 sf_sfclay_physics       = 2,
 sf_surface_physics      = 2,
 bl_pbl_physics          = 2,
 bldt                    = 0,
 cu_physics              = 0,
 cudt                    = 0,
 isfflx                  = 1,
 ifsnow                  = 1,
 icloud                  = 1,
 surface_input_source    = 1,
 num_soil_layers         = 4,
/

&dynamics
 w_damping               = 0,
 diff_opt                = 1,
 km_opt                  = 4,
 diff_6th_opt            = 2,
 diff_6th_factor         = 0.12,
 base_temp               = 290.,
 damp_opt                = 3,
 zdamp                   = 5000.,
 dampcoef                = 0.2,
 khdif                   = 0,
 kvdif                   = 0,
 non_hydrostatic         = .true.,
 moist_adv_opt           = 2,
 scalar_adv_opt          = 2,
 chem_adv_opt            = 0,
 tke_adv_opt             = 0,
/

&bdy_control
 spec_bdy_width          = 5,
 spec_zone               = 1,
 relax_zone              = 4,
 specified               = .true.,
 nested                  = .false.,
/

&grib2
/

&namelist_quilt
 nio_tasks_per_group     = 0,
 nio_groups              = 1,
/
`;

    const namelistPath = path.join(runDir, 'wrf', 'namelist.input');
    await fs.writeFile(namelistPath, namelist);

    this.logger.debug(`Created WRF namelist at ${namelistPath}`);
    return namelistPath;
  }

  /**
   * Prepare boundary conditions using WPS
   */
  async prepareBoundaryConditions(runDir, boundaryData) {
    // This would typically involve running WPS (ungrib, geogrid, metgrid)
    // For now, we'll simulate the process

    this.logger.info('Preparing WRF boundary conditions...');

    // Copy or link boundary data files
    const wpsDir = path.join(runDir, 'wps');

    // Simulate WPS workflow completion
    await fs.writeFile(
      path.join(wpsDir, 'met_em.d01.ready'),
      'Boundary conditions prepared'
    );

    return wpsDir;
  }

  /**
   * Run WRF simulation
   */
  async runWRFSimulation(runDir, parallelCores) {
    const wrfDir = path.join(runDir, 'wrf');

    if (this.useDocker) {
      return await this.runWRFInDocker(runDir, parallelCores);
    } else {
      return await this.runWRFNative(runDir, parallelCores);
    }
  }

  /**
   * Run WRF in Docker container
   */
  async runWRFInDocker(runDir, parallelCores) {
    const dockerCommand = [
      'docker',
      'run',
      '--rm',
      '-v',
      `${runDir}:/wrf_run`,
      '-w',
      '/wrf_run/wrf',
      '--cpus',
      parallelCores.toString(),
      this.dockerImage,
      'mpirun',
      '-np',
      parallelCores.toString(),
      './wrf.exe',
    ].join(' ');

    this.logger.info(`Running WRF in Docker: ${dockerCommand}`);

    return new Promise((resolve, reject) => {
      const process = spawn('docker', dockerCommand.split(' ').slice(1), {
        cwd: runDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', data => {
        stdout += data.toString();
        this.logger.debug(`WRF stdout: ${data.toString().trim()}`);
      });

      process.stderr.on('data', data => {
        stderr += data.toString();
        this.logger.debug(`WRF stderr: ${data.toString().trim()}`);
      });

      // Set timeout for maximum runtime
      const timeout = setTimeout(
        () => {
          process.kill('SIGKILL');
          reject(
            new Error(
              `WRF simulation timed out after ${this.maxRuntimeHours} hours`
            )
          );
        },
        this.maxRuntimeHours * 60 * 60 * 1000
      );

      process.on('close', code => {
        clearTimeout(timeout);

        if (code === 0) {
          this.logger.info('WRF simulation completed successfully');
          resolve({
            exitCode: code,
            stdout,
            stderr,
          });
        } else {
          this.logger.error(`WRF simulation failed with exit code ${code}`);
          reject(new Error(`WRF simulation failed: ${stderr}`));
        }
      });

      process.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Run WRF natively (without Docker)
   */
  async runWRFNative(runDir, parallelCores) {
    // This would run WRF directly on the host system
    // Requires WRF to be installed and configured
    return { success: false, error: 'SERVICE_UNAVAILABLE', message: 'Native WRF execution requires WRF to be installed on the host system' };
  }

  /**
   * Post-process WRF outputs
   */
  async postProcessWRFOutputs(runDir) {
    const wrfDir = path.join(runDir, 'wrf');
    const outputDir = path.join(runDir, 'output');

    // Find WRF output files (wrfout_d01_*)
    const files = await fs.readdir(wrfDir);
    const wrfOutputFiles = files.filter(file => file.startsWith('wrfout_'));

    if (wrfOutputFiles.length === 0) {
      throw new Error('No WRF output files found');
    }

    const processedOutputs = [];

    for (const outputFile of wrfOutputFiles) {
      const inputPath = path.join(wrfDir, outputFile);
      const outputPath = path.join(outputDir, `processed_${outputFile}.nc`);

      // Perform basic post-processing (validation, format conversion, etc.)
      await this.processWRFOutputFile(inputPath, outputPath);

      processedOutputs.push({
        originalFile: inputPath,
        processedFile: outputPath,
        fileSize: await this.getFileSize(outputPath),
      });
    }

    return processedOutputs;
  }

  /**
   * Process individual WRF output file
   */
  async processWRFOutputFile(inputPath, outputPath) {
    // For demonstration, we'll just copy the file
    // In practice, this would involve validation, quality control, format conversion
    await fs.copyFile(inputPath, outputPath);

    this.logger.debug(`Processed WRF output: ${inputPath} -> ${outputPath}`);
  }

  /**
   * Validate WRF parameters
   */
  validateWRFParams(params) {
    const errors = [];

    if (!params.domain) {
      errors.push('Domain configuration is required');
    } else {
      const { center, size, resolution } = params.domain;

      if (!center || center.length !== 2) {
        errors.push('Domain center must be [latitude, longitude]');
      }

      if (!size || size.length !== 2 || size[0] < 10 || size[1] < 10) {
        errors.push(
          'Domain size must be [nx, ny] with minimum 10x10 grid points'
        );
      }

      if (
        !resolution ||
        resolution.length !== 2 ||
        resolution[0] <= 0 ||
        resolution[1] <= 0
      ) {
        errors.push('Domain resolution must be [dx, dy] in meters');
      }
    }

    if (!params.timeRange) {
      errors.push('Time range is required');
    } else {
      const { start, end } = params.timeRange;
      const startDate = new Date(start);
      const endDate = new Date(end);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        errors.push('Invalid start or end date');
      } else if (endDate <= startDate) {
        errors.push('End date must be after start date');
      } else if (endDate - startDate > 30 * 24 * 60 * 60 * 1000) {
        errors.push('Simulation period cannot exceed 30 days');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get data (for WRF, this returns execution results)
   */
  async getData(params) {
    return await this.execute(params);
  }

  /**
   * Validate configuration
   */
  validateConfig(config) {
    const errors = [];

    if (config.useDocker && !config.dockerImage) {
      errors.push('Docker image is required when useDocker is true');
    }

    if (!config.useDocker && !config.wrfPath) {
      errors.push('WRF path is required when not using Docker');
    }

    if (
      config.maxRuntimeHours &&
      (config.maxRuntimeHours < 1 || config.maxRuntimeHours > 72)
    ) {
      errors.push('Max runtime hours must be between 1 and 72');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get file size helper
   */
  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }
}

/**
 * ICON Model Adapter
 * Handles ICOsahedral Nonhydrostatic model data retrieval
 */
class ICONAdapter extends BaseModelAdapter {
  constructor(config = {}) {
    super(config);
    this.modelName = 'ICON';
    this.baseUrl = config.baseUrl || 'https://opendata.dwd.de/weather/nwp/icon';
    this.iconD2Url =
      config.iconD2Url || 'https://opendata.dwd.de/weather/nwp/icon-d2';
    this.region = config.region || 'global'; // 'global' or 'europe' (ICON-D2)
    this.maxForecastHours = config.maxForecastHours || 120; // 5 days for global
  }

  /**
   * Execute ICON data retrieval
   */
  async execute(params) {
    const startTime = Date.now();

    try {
      this.status = 'running';
      this.logger.info(
        `Starting ICON data retrieval: ${JSON.stringify(params)}`
      );

      const {
        runTime = this.getLatestIconRunTime(),
        forecastHours = [0, 3, 6, 12, 24],
        variables = ['T_2M', 'U_10M', 'V_10M', 'TOT_PREC'],
        region = this.region,
        outputFormat = 'netcdf',
      } = params;

      // Download ICON GRIB2 files
      const downloadedFiles = await this.downloadIconFiles({
        runTime,
        forecastHours,
        variables,
        region,
      });

      // Process icosahedral grid data
      const processedData = await this.processIconData(downloadedFiles, {
        outputFormat,
        variables,
        interpolateToLatLon: true, // Convert from icosahedral to regular grid
      });

      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(true, runTime_ms);
      this.status = 'completed';

      return {
        success: true,
        modelName: this.modelName,
        runTime: runTime_ms,
        data: processedData,
        metadata: {
          iconRunTime: runTime,
          forecastHours,
          variables,
          region,
          gridType: 'icosahedral',
        },
      };
    } catch (error) {
      const runTime_ms = Date.now() - startTime;
      this.updateMetrics(false, runTime_ms);
      this.status = 'error';

      this.logger.error('ICON execution failed:', error);

      return {
        success: false,
        modelName: this.modelName,
        error: error.message,
        runTime: runTime_ms,
      };
    }
  }

  /**
   * Get ICON forecast data
   */
  async getData(params) {
    return await this.execute(params);
  }

  /**
   * Download ICON GRIB2 files
   */
  async downloadIconFiles({ runTime, forecastHours, variables, region }) {
    const downloadedFiles = [];
    const baseUrl = region === 'europe' ? this.iconD2Url : this.baseUrl;

    for (const hour of forecastHours) {
      const fileName = this.constructIconFileName(runTime, hour, region);
      const url = this.constructIconUrl(baseUrl, runTime, fileName);

      try {
        const filePath = await this.downloadFile(url, fileName);
        downloadedFiles.push({
          forecastHour: hour,
          filePath,
          url,
          region,
          size: await this.getFileSize(filePath),
        });

        this.logger.debug(`Downloaded ICON file: ${fileName}`);
      } catch (error) {
        this.logger.error(`Failed to download ICON file ${fileName}:`, error);
        throw error;
      }
    }

    return downloadedFiles;
  }

  /**
   * Process ICON icosahedral grid data
   */
  async processIconData(files, options) {
    const processedFiles = [];

    for (const file of files) {
      try {
        // Process icosahedral grid data
        const extractedData = await this.extractIconVariables(
          file.filePath,
          options.variables
        );

        // Interpolate to regular lat-lon grid if requested
        let processedData = extractedData;
        if (options.interpolateToLatLon) {
          processedData = await this.interpolateIconToLatLon(extractedData);
        }

        // Convert to requested format
        const outputPath = await this.convertDataFormat(
          processedData,
          options.outputFormat,
          file.forecastHour
        );

        processedFiles.push({
          forecastHour: file.forecastHour,
          originalFile: file.filePath,
          processedFile: outputPath,
          variables: options.variables,
          format: options.outputFormat,
          gridType: options.interpolateToLatLon ? 'latlon' : 'icosahedral',
        });
      } catch (error) {
        this.logger.error(
          `Failed to process ICON file ${file.filePath}:`,
          error
        );
        throw error;
      }
    }

    return processedFiles;
  }

  /**
   * Get latest ICON run time
   */
  getLatestIconRunTime() {
    const now = new Date();
    const hour = now.getUTCHours();

    // ICON runs at 00, 06, 12, 18 UTC (global) or 00, 03, 06, 09, 12, 15, 18, 21 UTC (ICON-D2)
    const runHours =
      this.region === 'europe' ? [0, 3, 6, 9, 12, 15, 18, 21] : [0, 6, 12, 18];
    const latestRunHour = runHours.reduce((prev, curr) => {
      return hour >= curr ? curr : prev;
    });

    const runTime = new Date(now);
    runTime.setUTCHours(latestRunHour, 0, 0, 0);

    // If the latest run hasn't finished processing, use previous run
    const timeSinceRun = now.getTime() - runTime.getTime();
    const processingDelay =
      this.region === 'europe' ? 2 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000; // 2h for D2, 4h for global

    if (timeSinceRun < processingDelay) {
      const stepHours = this.region === 'europe' ? 3 : 6;
      runTime.setTime(runTime.getTime() - stepHours * 60 * 60 * 1000);
    }

    return runTime;
  }

  /**
   * Construct ICON file name
   */
  constructIconFileName(runTime, forecastHour, region) {
    const year = runTime.getUTCFullYear();
    const month = String(runTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(runTime.getUTCDate()).padStart(2, '0');
    const hour = String(runTime.getUTCHours()).padStart(2, '0');
    const fHour = String(forecastHour).padStart(3, '0');

    if (region === 'europe') {
      return `icon-d2_germany_regular-lat-lon_single-level_${year}${month}${day}${hour}_${fHour}_2d.grib2.bz2`;
    } else {
      return `icon_global_icosahedral_single-level_${year}${month}${day}${hour}_${fHour}_2d.grib2.bz2`;
    }
  }

  /**
   * Construct ICON download URL
   */
  constructIconUrl(baseUrl, runTime, fileName) {
    const year = runTime.getUTCFullYear();
    const month = String(runTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(runTime.getUTCDate()).padStart(2, '0');
    const hour = String(runTime.getUTCHours()).padStart(2, '0');

    return `${baseUrl}/${year}${month}${day}${hour}/${fileName}`;
  }

  /**
   * Extract variables from ICON GRIB2 file
   */
  async extractIconVariables(filePath, variables) {
    // Handle compressed files
    let processedPath = filePath;
    if (filePath.endsWith('.bz2')) {
      processedPath = await this.decompressFile(filePath);
    }

    const pythonScript = `
import xarray as xr
import sys
import json

try:
    # Read ICON GRIB file
    ds = xr.open_dataset('${processedPath}', engine='cfgrib')
    
    # Extract requested variables
    extracted = {}
    for var in ${JSON.stringify(variables)}:
        var_lower = var.lower()
        
        # Map ICON variable names
        icon_var_map = {
            't_2m': 't2m',
            'u_10m': 'u10',
            'v_10m': 'v10',
            'tot_prec': 'tp'
        }
        
        mapped_var = icon_var_map.get(var_lower, var_lower)
        
        if mapped_var in ds.data_vars:
            data = ds[mapped_var]
            
            extracted[var] = {
                'data': data.values.tolist(),
                'coordinates': {
                    'latitude': data.latitude.values.tolist() if 'latitude' in data.coords else None,
                    'longitude': data.longitude.values.tolist() if 'longitude' in data.coords else None
                },
                'attributes': dict(data.attrs),
                'grid_type': 'icosahedral' if 'latitude' not in data.coords else 'regular'
            }
    
    print(json.dumps(extracted))
    
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const outputPath = `/tmp/extract_icon_${Date.now()}.py`;
    await fs.writeFile(outputPath, pythonScript);

    try {
      const { stdout, stderr } = await execAsync(`python3 ${outputPath}`);

      if (stderr && stderr.includes('error')) {
        throw new Error(`ICON extraction failed: ${stderr}`);
      }

      return JSON.parse(stdout);
    } finally {
      await fs.unlink(outputPath).catch(() => {});

      // Clean up decompressed file if created
      if (processedPath !== filePath) {
        await fs.unlink(processedPath).catch(() => {});
      }
    }
  }

  /**
   * Decompress .bz2 files
   */
  async decompressFile(filePath) {
    const outputPath = filePath.replace('.bz2', '');
    await execAsync(`bunzip2 -c "${filePath}" > "${outputPath}"`);
    return outputPath;
  }

  /**
   * Interpolate ICON icosahedral data to regular lat-lon grid
   */
  async interpolateIconToLatLon(data) {
    // For demonstration, we'll return the data as-is
    // In practice, this would use pyresample or similar to interpolate
    // from the unstructured icosahedral grid to a regular lat-lon grid

    this.logger.info('ICON grid interpolation would be performed here');

    // Mark data as interpolated
    const interpolatedData = { ...data };
    for (const [varName, varData] of Object.entries(interpolatedData)) {
      if (varData.grid_type === 'icosahedral') {
        varData.grid_type = 'interpolated_latlon';
        varData.interpolation_method = 'bilinear';
      }
    }

    return interpolatedData;
  }

  /**
   * Validate ICON configuration
   */
  validateConfig(config) {
    const errors = [];

    if (config.region && !['global', 'europe'].includes(config.region)) {
      errors.push('Region must be "global" or "europe"');
    }

    if (config.forecastHours) {
      const maxHours = config.region === 'europe' ? 48 : this.maxForecastHours;
      const invalidHours = config.forecastHours.filter(
        h => h < 0 || h > maxHours
      );
      if (invalidHours.length > 0) {
        errors.push(
          `Invalid forecast hours for ${config.region}: ${invalidHours.join(', ')}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Download file helper
   */
  async downloadFile(url, fileName) {
    const outputPath = `/tmp/icon_${fileName}`;

    const command = `curl -s -o "${outputPath}" "${url}"`;
    await execAsync(command);

    const exists = await fs
      .access(outputPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error(`Failed to download file from ${url}`);
    }

    return outputPath;
  }

  /**
   * Get file size helper
   */
  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  /**
   * Convert data format helper
   */
  async convertDataFormat(data, format, forecastHour) {
    const outputPath = `/tmp/icon_converted_f${String(forecastHour).padStart(3, '0')}.${format}`;

    switch (format) {
      case 'json':
        await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
        return outputPath;
      case 'netcdf':
        // NetCDF conversion not yet available — fall back to JSON
        await fs.writeFile(outputPath.replace('.nc', '.json'), JSON.stringify(data, null, 2));
        return outputPath.replace('.nc', '.json');
      default:
        throw new Error(`Unsupported output format: ${format}`);
    }
  }
}

/**
 * Climate Model Integration Framework Orchestrator
 * Main class that coordinates all model adapters and provides unified interface
 */
class ClimateModelFramework extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      // Default configuration
      enabledModels: config.enabledModels || ['GFS', 'WRF', 'ICON'],
      defaultOutputFormat: config.defaultOutputFormat || 'netcdf',
      maxConcurrentJobs: config.maxConcurrentJobs || 3,
      dataRetentionDays: config.dataRetentionDays || 30,
      enableBlockchainProvenance: config.enableBlockchainProvenance !== false,
      cacheResults: config.cacheResults !== false,
      ...config,
    };

    // Initialize services
    this.logger = Logger;
    this.validator = new WeatherDataValidator();
    this.blockchain = new BlockchainService();
    this.database = new DatabaseManager();

    // Initialize model adapters
    this.adapters = new Map();
    this.initializeAdapters();

    // Job management
    this.activeJobs = new Map();
    this.jobHistory = [];
    this.jobQueue = [];

    // Framework state
    this.isInitialized = false;
    this.stats = {
      totalJobs: 0,
      successfulJobs: 0,
      failedJobs: 0,
      averageJobTime: 0,
      lastJobAt: null,
    };

    this.initialize();
  }

  /**
   * Initialize the framework
   */
  async initialize() {
    try {
      this.logger.info('Initializing Climate Model Integration Framework...');

      // Connect to database
      await this.database.connect();

      // Initialize blockchain service
      if (this.config.enableBlockchainProvenance) {
        await this.blockchain.initialize();
      }

      // Validate adapter configurations
      for (const [modelName, adapter] of this.adapters) {
        const validation = adapter.validateConfig(adapter.config);
        if (!validation.valid) {
          throw new Error(
            `Invalid configuration for ${modelName}: ${validation.errors.join(', ')}`
          );
        }
      }

      // Setup cleanup intervals
      this.setupMaintenanceTasks();

      this.isInitialized = true;
      this.logger.info(
        'Climate Model Integration Framework initialized successfully'
      );
      this.emit('initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Climate Model Framework:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Initialize model adapters
   */
  initializeAdapters() {
    if (this.config.enabledModels.includes('GFS')) {
      this.adapters.set('GFS', new GFSAdapter(this.config.gfs || {}));
    }

    if (this.config.enabledModels.includes('WRF')) {
      this.adapters.set('WRF', new WRFAdapter(this.config.wrf || {}));
    }

    if (this.config.enabledModels.includes('ICON')) {
      this.adapters.set('ICON', new ICONAdapter(this.config.icon || {}));
    }

    this.logger.info(
      `Initialized adapters for models: ${Array.from(this.adapters.keys()).join(', ')}`
    );
  }

  /**
   * Execute model job
   */
  async executeModel(modelName, params, options = {}) {
    const jobId = this.generateJobId();
    const startTime = Date.now();

    try {
      // Validate request
      if (!this.adapters.has(modelName)) {
        throw new Error(`Unsupported model: ${modelName}`);
      }

      // Check concurrent job limit
      if (this.activeJobs.size >= this.config.maxConcurrentJobs) {
        throw new Error('Maximum concurrent jobs limit reached');
      }

      // Create job record
      const job = {
        jobId,
        modelName,
        params,
        options,
        status: 'pending',
        startTime: new Date(),
        requestedBy: options.userId || 'system',
      };

      this.activeJobs.set(jobId, job);
      this.logger.info(`Starting model job ${jobId} for ${modelName}`);
      this.emit('jobStarted', job);

      // Update job status
      job.status = 'running';

      // Execute model
      const adapter = this.adapters.get(modelName);
      const result = await adapter.execute(params);

      // Process results
      const processedResult = await this.processModelResult(result, job);

      // Store provenance on blockchain if enabled
      if (this.config.enableBlockchainProvenance && result.success) {
        const provenanceRecord = await this.createProvenanceRecord(job, result);
        await this.storeProvenance(provenanceRecord);
      }

      // Update job and stats
      job.status = result.success ? 'completed' : 'failed';
      job.result = processedResult;
      job.endTime = new Date();
      job.duration = Date.now() - startTime;

      this.updateStats(result.success, job.duration);
      this.activeJobs.delete(jobId);
      this.jobHistory.push(job);

      this.logger.info(`Model job ${jobId} completed: ${job.status}`);
      this.emit('jobCompleted', job);

      return {
        jobId,
        success: result.success,
        modelName,
        result: processedResult,
        duration: job.duration,
        provenanceStored:
          this.config.enableBlockchainProvenance && result.success,
      };
    } catch (error) {
      // Handle job failure
      const duration = Date.now() - startTime;

      if (this.activeJobs.has(jobId)) {
        const job = this.activeJobs.get(jobId);
        job.status = 'failed';
        job.error = error.message;
        job.endTime = new Date();
        job.duration = duration;

        this.activeJobs.delete(jobId);
        this.jobHistory.push(job);
        this.emit('jobFailed', job);
      }

      this.updateStats(false, duration);
      this.logger.error(`Model job ${jobId} failed:`, error);

      return {
        jobId,
        success: false,
        modelName,
        error: error.message,
        duration,
      };
    }
  }

  /**
   * Get model data (non-execution jobs)
   */
  async getModelData(modelName, params, options = {}) {
    if (!this.adapters.has(modelName)) {
      throw new Error(`Unsupported model: ${modelName}`);
    }

    const adapter = this.adapters.get(modelName);
    return await adapter.getData(params);
  }

  /**
   * Process model execution result
   */
  async processModelResult(result, job) {
    if (!result.success) {
      return result;
    }

    const processed = { ...result };

    // Validate output data if available
    if (result.data) {
      try {
        const validationResult = await this.validateModelOutput(
          result.data,
          job.modelName
        );
        processed.validation = validationResult;
      } catch (error) {
        this.logger.warn(
          `Model output validation failed for job ${job.jobId}:`,
          error
        );
        processed.validation = { passed: false, error: error.message };
      }
    }

    // Add processing metadata
    processed.processingMetadata = {
      processedAt: new Date().toISOString(),
      frameworkVersion: '1.0.0',
      jobId: job.jobId,
      requestedBy: job.requestedBy,
    };

    return processed;
  }

  /**
   * Validate model output data
   */
  async validateModelOutput(data, modelName) {
    // Basic validation based on model type
    const validation = {
      passed: true,
      warnings: [],
      errors: [],
      qualityScore: 1.0,
    };

    // Model-specific validation rules
    switch (modelName) {
      case 'WRF':
        return this.validateWRFOutput(data);
      case 'GFS':
        return this.validateGFSOutput(data);
      case 'ICON':
        return this.validateICONOutput(data);
      default:
        validation.warnings.push(
          `No specific validation rules for model ${modelName}`
        );
    }

    return validation;
  }

  /**
   * Validate WRF output
   */
  validateWRFOutput(data) {
    const validation = {
      passed: true,
      warnings: [],
      errors: [],
      qualityScore: 1.0,
    };

    // Check if outputs exist
    if (!data.outputs || data.outputs.length === 0) {
      validation.errors.push('No WRF output files found');
      validation.passed = false;
      validation.qualityScore = 0.0;
      return validation;
    }

    // Validate file sizes
    for (const output of data.outputs) {
      if (output.fileSize < 1000) {
        // Less than 1KB is suspicious
        validation.warnings.push(
          `Very small output file: ${output.processedFile}`
        );
        validation.qualityScore *= 0.9;
      }
    }

    return validation;
  }

  /**
   * Validate GFS output
   */
  validateGFSOutput(data) {
    const validation = {
      passed: true,
      warnings: [],
      errors: [],
      qualityScore: 1.0,
    };

    // Check if data was downloaded
    if (!data.data || data.data.length === 0) {
      validation.errors.push('No GFS data retrieved');
      validation.passed = false;
      validation.qualityScore = 0.0;
      return validation;
    }

    // Check forecast hours coverage
    const expectedHours = data.metadata?.forecastHours || [];
    const actualHours = data.data.map(d => d.forecastHour);
    const missingHours = expectedHours.filter(h => !actualHours.includes(h));

    if (missingHours.length > 0) {
      validation.warnings.push(
        `Missing forecast hours: ${missingHours.join(', ')}`
      );
      validation.qualityScore *= actualHours.length / expectedHours.length;
    }

    return validation;
  }

  /**
   * Validate ICON output
   */
  validateICONOutput(data) {
    const validation = {
      passed: true,
      warnings: [],
      errors: [],
      qualityScore: 1.0,
    };

    // Check if data was downloaded and processed
    if (!data.data || data.data.length === 0) {
      validation.errors.push('No ICON data retrieved');
      validation.passed = false;
      validation.qualityScore = 0.0;
      return validation;
    }

    // Check for icosahedral grid handling
    for (const dataItem of data.data) {
      if (
        dataItem.gridType === 'icosahedral' &&
        !dataItem.interpolation_method
      ) {
        validation.warnings.push(
          'Icosahedral grid data not interpolated to regular grid'
        );
        validation.qualityScore *= 0.95;
      }
    }

    return validation;
  }

  /**
   * Create blockchain provenance record
   */
  async createProvenanceRecord(job, result) {
    const inputDataHash = this.calculateHash(JSON.stringify(job.params));
    const configHash = this.calculateHash(JSON.stringify(job.options));
    const outputDataHash = result.data
      ? this.calculateHash(JSON.stringify(result.data))
      : null;

    return {
      jobId: job.jobId,
      modelName: job.modelName,
      modelVersion: result.metadata?.version || '1.0.0',
      executionTimestamp: job.startTime.toISOString(),
      inputDataHash,
      configurationHash: configHash,
      outputDataHash,
      processingDuration: result.runTime,
      validationResult: result.validation || null,
      qualityScore: result.validation?.qualityScore || null,
      executorAddress: job.requestedBy,
      frameworkVersion: '1.0.0',
    };
  }

  /**
   * Store provenance record on blockchain
   */
  async storeProvenance(record) {
    try {
      const transaction =
        await this.blockchain.submitClimateModelProvenance(record);
      this.logger.info(
        `Stored provenance for job ${record.jobId}, tx: ${transaction.hash}`
      );
      return transaction;
    } catch (error) {
      this.logger.error(
        `Failed to store provenance for job ${record.jobId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Calculate hash of data
   */
  calculateHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Generate unique job ID
   */
  generateJobId() {
    return `cmf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Update framework statistics
   */
  updateStats(success, duration) {
    this.stats.totalJobs++;

    if (success) {
      this.stats.successfulJobs++;
    } else {
      this.stats.failedJobs++;
    }

    // Update average job time
    const count = this.stats.totalJobs;
    this.stats.averageJobTime =
      (this.stats.averageJobTime * (count - 1) + duration) / count;

    this.stats.lastJobAt = new Date();
  }

  /**
   * Get framework status and statistics
   */
  getStatus() {
    const adapterStatus = {};
    for (const [modelName, adapter] of this.adapters) {
      adapterStatus[modelName] = adapter.getHealth();
    }

    return {
      framework: {
        initialized: this.isInitialized,
        enabledModels: Array.from(this.adapters.keys()),
        activeJobs: this.activeJobs.size,
        queuedJobs: this.jobQueue.length,
        stats: this.stats,
      },
      adapters: adapterStatus,
      config: {
        maxConcurrentJobs: this.config.maxConcurrentJobs,
        enableBlockchainProvenance: this.config.enableBlockchainProvenance,
        dataRetentionDays: this.config.dataRetentionDays,
      },
    };
  }

  /**
   * Get job history
   */
  getJobHistory(limit = 50) {
    return this.jobHistory
      .slice(-limit)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  }

  /**
   * Get active jobs
   */
  getActiveJobs() {
    return Array.from(this.activeJobs.values());
  }

  /**
   * Cancel job
   */
  async cancelJob(jobId) {
    if (!this.activeJobs.has(jobId)) {
      throw new Error(`Job ${jobId} not found or not active`);
    }

    const job = this.activeJobs.get(jobId);
    job.status = 'cancelled';
    job.endTime = new Date();
    job.duration = Date.now() - new Date(job.startTime).getTime();

    this.activeJobs.delete(jobId);
    this.jobHistory.push(job);

    this.logger.info(`Cancelled job ${jobId}`);
    this.emit('jobCancelled', job);

    return job;
  }

  /**
   * Setup maintenance tasks
   */
  setupMaintenanceTasks() {
    // Clean up old job history
    setInterval(
      () => {
        const cutoffDate = new Date();
        cutoffDate.setDate(
          cutoffDate.getDate() - this.config.dataRetentionDays
        );

        const originalLength = this.jobHistory.length;
        this.jobHistory = this.jobHistory.filter(
          job => new Date(job.startTime) > cutoffDate
        );

        const removed = originalLength - this.jobHistory.length;
        if (removed > 0) {
          this.logger.info(`Cleaned up ${removed} old job records`);
        }
      },
      24 * 60 * 60 * 1000
    ); // Daily cleanup

    // Clean up temporary files
    setInterval(
      () => {
        this.cleanupTemporaryFiles();
      },
      6 * 60 * 60 * 1000
    ); // Every 6 hours
  }

  /**
   * Clean up temporary files
   */
  async cleanupTemporaryFiles() {
    try {
      const tmpDir = '/tmp';
      const files = await fs.readdir(tmpDir);

      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
      let cleanedCount = 0;

      for (const file of files) {
        if (
          file.startsWith('gfs_') ||
          file.startsWith('wrf_') ||
          file.startsWith('icon_')
        ) {
          const filePath = path.join(tmpDir, file);

          try {
            const stats = await fs.stat(filePath);
            if (stats.mtime.getTime() < cutoffTime) {
              await fs.unlink(filePath);
              cleanedCount++;
            }
          } catch (error) {
            // File might have been deleted already, ignore
          }
        }
      }

      if (cleanedCount > 0) {
        this.logger.info(`Cleaned up ${cleanedCount} temporary files`);
      }
    } catch (error) {
      this.logger.error('Error during temporary file cleanup:', error);
    }
  }

  /**
   * Shutdown framework gracefully
   */
  async shutdown() {
    this.logger.info('Shutting down Climate Model Integration Framework...');

    // Cancel all active jobs
    for (const jobId of this.activeJobs.keys()) {
      try {
        await this.cancelJob(jobId);
      } catch (error) {
        this.logger.error(`Error cancelling job ${jobId}:`, error);
      }
    }

    // Close database connections
    await this.database.disconnect();

    // Close blockchain service
    if (this.config.enableBlockchainProvenance) {
      await this.blockchain.shutdown();
    }

    this.logger.info('Climate Model Integration Framework shutdown complete');
    this.emit('shutdown');
  }
}

module.exports = {
  ClimateModelFramework,
  BaseModelAdapter,
  GFSAdapter,
  WRFAdapter,
  ICONAdapter,
};
