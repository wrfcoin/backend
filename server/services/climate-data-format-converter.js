/**
 * Climate Data Format Converter
 *
 * Comprehensive data format conversion utilities for climate model integration.
 * Supports conversion between various meteorological data formats including:
 * - GRIB/GRIB2 (Gridded Binary)
 * - NetCDF (Network Common Data Form)
 * - HDF5 (Hierarchical Data Format)
 * - JSON (JavaScript Object Notation)
 * - CSV (Comma Separated Values)
 * - WRFCoin unified format
 *
 * Features:
 * - Standardized data schema transformations
 * - Grid coordinate system conversions
 * - Unit conversions and standardization
 * - Metadata preservation and enhancement
 * - Quality validation during conversion
 * - Efficient handling of large datasets
 */

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const Logger = require('../utils/logger');

const execFileAsync = util.promisify(execFile);

/**
 * Allowed base directory for climate data files.
 * All user-supplied file paths must resolve within this directory.
 */
const ALLOWED_DATA_DIR = process.env.CLIMATE_DATA_DIR || '/data/climate/';

/**
 * Sanitize and validate a file path to prevent path traversal and injection.
 * @param {string} filePath - The file path to validate
 * @returns {string} The resolved, validated path
 * @throws {Error} If the path is invalid or outside the allowed directory
 */
async function sanitizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path must be a non-empty string');
  }

  // Reject path traversal
  if (/\.\./.test(filePath)) {
    throw new Error('File path must not contain ".."');
  }

  // Reject null bytes
  if (/\0/.test(filePath)) {
    throw new Error('File path must not contain null bytes');
  }

  // Reject shell metacharacters and single/double quotes (prevents Python string injection)
  if (/[;|&$`(){}<>\n\r'"]/.test(filePath)) {
    throw new Error('File path contains forbidden characters');
  }

  // Resolve symlinks to prevent symlink-based allowlist bypass
  let resolved;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    // File may not exist yet (output paths) — fall back to lexical resolve
    resolved = path.resolve(filePath);
  }

  // Ensure path is within the allowed data directory
  const normalizedAllowed = path.resolve(ALLOWED_DATA_DIR);
  if (!resolved.startsWith(normalizedAllowed + path.sep) && resolved !== normalizedAllowed) {
    throw new Error(`File path must be within ${normalizedAllowed}`);
  }

  return resolved;
}

/**
 * Base Data Format Converter
 * Abstract class defining the interface for all format converters
 */
class BaseFormatConverter {
  constructor(config = {}) {
    this.config = config;
    this.logger = Logger;
    this.supportedInputFormats = [];
    this.supportedOutputFormats = [];
    this.conversionMetrics = {
      totalConversions: 0,
      successfulConversions: 0,
      failedConversions: 0,
      averageConversionTime: 0,
    };
  }

  /**
   * Convert data from one format to another
   * @param {string} inputPath - Path to input file
   * @param {string} outputPath - Path for output file
   * @param {Object} options - Conversion options
   * @returns {Promise<ConversionResult>}
   */
  async convert(inputPath, outputPath, options = {}) {
    throw new Error(
      'convert() method must be implemented by format converters'
    );
  }

  /**
   * Validate input format
   * @param {string} filePath - Path to file to validate
   * @returns {Promise<ValidationResult>}
   */
  async validateInput(filePath) {
    throw new Error(
      'validateInput() method must be implemented by format converters'
    );
  }

  /**
   * Get format metadata
   * @param {string} filePath - Path to file
   * @returns {Promise<Object>} Format metadata
   */
  async getFormatMetadata(filePath) {
    throw new Error(
      'getFormatMetadata() method must be implemented by format converters'
    );
  }

  /**
   * Update conversion metrics
   */
  updateMetrics(success, conversionTime) {
    this.conversionMetrics.totalConversions++;

    if (success) {
      this.conversionMetrics.successfulConversions++;
    } else {
      this.conversionMetrics.failedConversions++;
    }

    const count = this.conversionMetrics.totalConversions;
    this.conversionMetrics.averageConversionTime =
      (this.conversionMetrics.averageConversionTime * (count - 1) +
        conversionTime) /
      count;
  }

  /**
   * Get conversion statistics
   */
  getMetrics() {
    return {
      ...this.conversionMetrics,
      successRate:
        this.conversionMetrics.totalConversions > 0
          ? this.conversionMetrics.successfulConversions /
            this.conversionMetrics.totalConversions
          : 0,
    };
  }
}

/**
 * GRIB to NetCDF Converter
 * Converts GRIB/GRIB2 files to NetCDF format using CDO (Climate Data Operators)
 */
class GRIBToNetCDFConverter extends BaseFormatConverter {
  constructor(config = {}) {
    super(config);
    this.supportedInputFormats = ['grib', 'grib2', 'grb', 'gb'];
    this.supportedOutputFormats = ['nc', 'netcdf'];
    this.cdoPath = config.cdoPath || 'cdo';
    this.preserveMetadata = config.preserveMetadata !== false;
  }

  /**
   * Convert GRIB to NetCDF
   */
  async convert(inputPath, outputPath, options = {}) {
    const startTime = Date.now();

    try {
      // Validate input file
      const validation = await this.validateInput(inputPath);
      if (!validation.valid) {
        throw new Error(`Invalid GRIB file: ${validation.errors.join(', ')}`);
      }

      const {
        variables = null, // Specific variables to extract
        region = null, // Geographic region to extract
        compression = 'deflate', // NetCDF compression
        compressionLevel = 6, // Compression level (0-9)
        addMetadata = true, // Add additional metadata
      } = options;

      // Sanitize file paths
      inputPath = await sanitizePath(inputPath);
      outputPath = await sanitizePath(outputPath);

      // Build CDO command
      const cdoCommand = this.buildCDOCommand(inputPath, outputPath, {
        variables,
        region,
        compression,
        compressionLevel,
      });

      // Execute conversion (use execFileAsync to avoid shell injection)
      const { stdout, stderr } = await execFileAsync(cdoCommand.program, cdoCommand.args);

      // Add custom metadata if requested
      if (addMetadata) {
        await this.addCustomMetadata(outputPath, inputPath, options);
      }

      // Verify output file
      const outputExists = await fs
        .access(outputPath)
        .then(() => true)
        .catch(() => false);
      if (!outputExists) {
        throw new Error('Conversion failed: output file not created');
      }

      const conversionTime = Date.now() - startTime;
      this.updateMetrics(true, conversionTime);

      const result = {
        success: true,
        inputPath,
        outputPath,
        inputFormat: 'grib',
        outputFormat: 'netcdf',
        conversionTime,
        fileSize: await this.getFileSize(outputPath),
        metadata: await this.getNetCDFMetadata(outputPath),
      };

      this.logger.info(
        `GRIB to NetCDF conversion completed: ${inputPath} -> ${outputPath}`
      );
      return result;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      this.updateMetrics(false, conversionTime);

      this.logger.error('GRIB to NetCDF conversion failed:', error);

      return {
        success: false,
        inputPath,
        outputPath,
        error: error.message,
        conversionTime,
      };
    }
  }

  /**
   * Build CDO command for conversion
   */
  buildCDOCommand(inputPath, outputPath, options) {
    const command = [this.cdoPath];

    // Add compression options
    if (options.compression) {
      command.push('-f', 'nc4c'); // NetCDF4 classic with compression
      command.push('-z', `zip_${options.compressionLevel}`);
    }

    // Add variable selection
    if (options.variables && options.variables.length > 0) {
      const varString = options.variables.join(',');
      command.push(`-selvar,${varString}`);
    }

    // Add region selection
    if (options.region) {
      const { north, south, east, west } = options.region;
      command.push(`-sellonlatbox,${west},${east},${south},${north}`);
    }

    // Add copy operation and file paths
    command.push('copy', inputPath, outputPath);

    return { program: command[0], args: command.slice(1) };
  }

  /**
   * Add custom metadata to NetCDF file
   */
  async addCustomMetadata(outputPath, inputPath, options) {
    outputPath = await sanitizePath(outputPath);
    inputPath = await sanitizePath(inputPath);

    try {
      await execFileAsync('ncatted', [
        '-a', `converted_from,global,c,c,${path.basename(inputPath)}`,
        '-a', `conversion_time,global,c,c,${new Date().toISOString()}`,
        '-a', 'converter,global,c,c,WRFCoin Climate Data Format Converter v1.0',
        outputPath,
      ]);
    } catch (error) {
      this.logger.warn(`Failed to add custom metadata: ${error.message}`);
    }
  }

  /**
   * Validate GRIB input file
   */
  async validateInput(filePath) {
    try {
      filePath = await sanitizePath(filePath);

      // Check file exists and is readable
      await fs.access(filePath, fs.constants.R_OK);

      // Use grib_ls to validate GRIB format (execFileAsync avoids shell injection)
      const { stdout, stderr } = await execFileAsync(
        'grib_ls', ['-n', 'statistics', filePath]
      );

      if (stderr && stderr.includes('ERROR')) {
        return {
          valid: false,
          errors: [`GRIB validation failed: ${stderr}`],
        };
      }

      // Parse grib_ls output for basic validation
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) {
        return {
          valid: false,
          errors: ['No GRIB messages found in file'],
        };
      }

      return {
        valid: true,
        messageCount: lines.length - 1,
        metadata: { gribValidated: true },
      };
    } catch (error) {
      return {
        valid: false,
        errors: [error.message],
      };
    }
  }

  /**
   * Get NetCDF metadata
   */
  async getNetCDFMetadata(filePath) {
    try {
      filePath = await sanitizePath(filePath);
      const { stdout } = await execFileAsync('ncdump', ['-h', filePath]);

      // Parse dimensions, variables, and attributes
      const metadata = {
        dimensions: this.parseNetCDFDimensions(stdout),
        variables: this.parseNetCDFVariables(stdout),
        globalAttributes: this.parseNetCDFGlobalAttributes(stdout),
      };

      return metadata;
    } catch (error) {
      this.logger.warn(`Failed to extract NetCDF metadata: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse NetCDF dimensions from ncdump output
   */
  parseNetCDFDimensions(ncdumpOutput) {
    const dimensions = {};
    const dimRegex = /\s*(\w+)\s*=\s*(\d+|UNLIMITED)/g;
    let match;

    while ((match = dimRegex.exec(ncdumpOutput)) !== null) {
      dimensions[match[1]] =
        match[2] === 'UNLIMITED' ? 'UNLIMITED' : parseInt(match[2]);
    }

    return dimensions;
  }

  /**
   * Parse NetCDF variables from ncdump output
   */
  parseNetCDFVariables(ncdumpOutput) {
    const variables = {};
    const varRegex = /\s*(\w+)\s+(\w+)\((.*?)\)/g;
    let match;

    while ((match = varRegex.exec(ncdumpOutput)) !== null) {
      variables[match[2]] = {
        type: match[1],
        dimensions: match[3].split(',').map(d => d.trim()),
      };
    }

    return variables;
  }

  /**
   * Parse NetCDF global attributes from ncdump output
   */
  parseNetCDFGlobalAttributes(ncdumpOutput) {
    const attributes = {};
    const attrRegex = /\s*:(\w+)\s*=\s*"([^"]+)"/g;
    let match;

    while ((match = attrRegex.exec(ncdumpOutput)) !== null) {
      attributes[match[1]] = match[2];
    }

    return attributes;
  }

  /**
   * Get format metadata
   */
  async getFormatMetadata(filePath) {
    const validation = await this.validateInput(filePath);
    if (!validation.valid) {
      throw new Error(`Cannot get metadata: ${validation.errors.join(', ')}`);
    }

    return {
      format: 'grib',
      messageCount: validation.messageCount,
      fileSize: await this.getFileSize(filePath),
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
 * NetCDF to JSON Converter
 * Converts NetCDF files to JSON format for web consumption
 */
class NetCDFToJSONConverter extends BaseFormatConverter {
  constructor(config = {}) {
    super(config);
    this.supportedInputFormats = ['nc', 'netcdf'];
    this.supportedOutputFormats = ['json'];
    this.maxArraySize = config.maxArraySize || 1000000; // Limit array size for memory
  }

  /**
   * Convert NetCDF to JSON
   */
  async convert(inputPath, outputPath, options = {}) {
    const startTime = Date.now();

    try {
      // Sanitize file paths (#472 follow-up)
      inputPath = await sanitizePath(inputPath);
      outputPath = await sanitizePath(outputPath);

      // Validate input
      const validation = await this.validateInput(inputPath);
      if (!validation.valid) {
        throw new Error(`Invalid NetCDF file: ${validation.errors.join(', ')}`);
      }

      const {
        variables = null, // Specific variables to extract
        subsample = 1, // Subsample factor for large arrays
        includeData = true, // Include actual data arrays
        includeMetadata = true, // Include metadata
        precision = 6, // Decimal precision for floating point
      } = options;

      // Extract data using Python xarray
      const jsonData = await this.extractNetCDFToJSON(inputPath, {
        variables,
        subsample,
        includeData,
        includeMetadata,
        precision,
      });

      // Write JSON output
      await fs.writeFile(outputPath, JSON.stringify(jsonData, null, 2));

      const conversionTime = Date.now() - startTime;
      this.updateMetrics(true, conversionTime);

      const result = {
        success: true,
        inputPath,
        outputPath,
        inputFormat: 'netcdf',
        outputFormat: 'json',
        conversionTime,
        fileSize: await this.getFileSize(outputPath),
        dataStructure: {
          variables: Object.keys(jsonData.variables || {}),
          dimensions: Object.keys(jsonData.dimensions || {}),
          hasData: includeData,
        },
      };

      this.logger.info(
        `NetCDF to JSON conversion completed: ${inputPath} -> ${outputPath}`
      );
      return result;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      this.updateMetrics(false, conversionTime);

      this.logger.error('NetCDF to JSON conversion failed:', error);

      return {
        success: false,
        inputPath,
        outputPath,
        error: error.message,
        conversionTime,
      };
    }
  }

  /**
   * Extract NetCDF data to JSON using Python
   */
  async extractNetCDFToJSON(inputPath, options) {
    const pythonScript = `
import xarray as xr
import numpy as np
import json
import sys

try:
    # Open NetCDF file
    ds = xr.open_dataset('${inputPath}')
    
    result = {
        'metadata': {
            'format': 'netcdf',
            'source_file': '${inputPath}',
            'extraction_time': '${new Date().toISOString()}',
            'extractor': 'WRFCoin Climate Data Format Converter'
        },
        'dimensions': {},
        'variables': {},
        'global_attributes': {}
    }
    
    # Extract dimensions
    for dim_name, dim_size in ds.dims.items():
        result['dimensions'][dim_name] = int(dim_size)
    
    # Extract global attributes
    result['global_attributes'] = dict(ds.attrs)
    
    # Extract variables
    variables_to_extract = ${options.variables ? JSON.stringify(options.variables) : 'list(ds.data_vars.keys())'}
    
    for var_name in variables_to_extract:
        if var_name in ds.data_vars:
            var_data = ds[var_name]
            
            var_info = {
                'dimensions': list(var_data.dims),
                'shape': list(var_data.shape),
                'dtype': str(var_data.dtype),
                'attributes': dict(var_data.attrs)
            }
            
            # Include data if requested and not too large
            if ${options.includeData ? 'True' : 'False'}:
                total_size = np.prod(var_data.shape)
                if total_size <= ${options.maxArraySize}:
                    # Apply subsampling if requested
                    subsample = ${options.subsample}
                    if subsample > 1:
                        slices = tuple(slice(None, None, subsample) for _ in var_data.dims)
                        var_data_sampled = var_data[slices]
                    else:
                        var_data_sampled = var_data
                    
                    # Convert to list with specified precision
                    data_array = var_data_sampled.values
                    
                    # Handle different data types
                    if np.issubdtype(data_array.dtype, np.floating):
                        data_array = np.round(data_array, ${options.precision})
                    
                    # Convert NaN to null for JSON compatibility
                    data_array = np.where(np.isnan(data_array), None, data_array)
                    
                    var_info['data'] = data_array.tolist()
                    var_info['subsampled'] = subsample > 1
                    var_info['subsample_factor'] = subsample
                else:
                    var_info['data_too_large'] = True
                    var_info['total_size'] = int(total_size)
            
            result['variables'][var_name] = var_info
    
    # Extract coordinate variables
    result['coordinates'] = {}
    for coord_name, coord_data in ds.coords.items():
        if coord_name not in result['variables']:  # Don't duplicate
            coord_info = {
                'dimensions': list(coord_data.dims),
                'shape': list(coord_data.shape),
                'dtype': str(coord_data.dtype),
                'attributes': dict(coord_data.attrs)
            }
            
            # Include coordinate data (usually small)
            if coord_data.size <= 10000:  # Reasonable limit for coordinates
                coord_array = coord_data.values
                if np.issubdtype(coord_array.dtype, np.floating):
                    coord_array = np.round(coord_array, ${options.precision})
                coord_info['data'] = coord_array.tolist()
            
            result['coordinates'][coord_name] = coord_info
    
    print(json.dumps(result))
    
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const scriptPath = `/tmp/netcdf_to_json_${Date.now()}.py`;
    await fs.writeFile(scriptPath, pythonScript);

    try {
      const { stdout, stderr } = await execFileAsync('python3', [scriptPath]);

      if (stderr && stderr.includes('error')) {
        throw new Error(`NetCDF extraction failed: ${stderr}`);
      }

      return JSON.parse(stdout);
    } finally {
      await fs.unlink(scriptPath).catch(() => {});
    }
  }

  /**
   * Validate NetCDF input
   */
  async validateInput(filePath) {
    try {
      filePath = await sanitizePath(filePath);
      await fs.access(filePath, fs.constants.R_OK);

      // Use ncdump to validate NetCDF format (execFileAsync avoids shell injection)
      const { stdout, stderr } = await execFileAsync('ncdump', ['-h', filePath]);

      if (stderr && stderr.includes('syntax error')) {
        return {
          valid: false,
          errors: [`NetCDF validation failed: ${stderr}`],
        };
      }

      // Check for basic NetCDF structure
      if (!stdout.includes('dimensions:') && !stdout.includes('variables:')) {
        return {
          valid: false,
          errors: ['File does not appear to contain valid NetCDF structure'],
        };
      }

      return {
        valid: true,
        metadata: { netcdfValidated: true },
      };
    } catch (error) {
      return {
        valid: false,
        errors: [error.message],
      };
    }
  }

  /**
   * Get format metadata
   */
  async getFormatMetadata(filePath) {
    const validation = await this.validateInput(filePath);
    if (!validation.valid) {
      throw new Error(`Cannot get metadata: ${validation.errors.join(', ')}`);
    }

    try {
      filePath = await sanitizePath(filePath);
      const { stdout } = await execFileAsync('ncdump', ['-h', filePath]);

      return {
        format: 'netcdf',
        fileSize: await this.getFileSize(filePath),
        structure: {
          hasDimensions: stdout.includes('dimensions:'),
          hasVariables: stdout.includes('variables:'),
          hasAttributes: stdout.includes('// global attributes:'),
        },
      };
    } catch (error) {
      throw new Error(`Failed to extract NetCDF metadata: ${error.message}`);
    }
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
 * WRFCoin Unified Format Converter
 * Converts various formats to/from WRFCoin's standardized weather data format
 */
class WRFCoinFormatConverter extends BaseFormatConverter {
  constructor(config = {}) {
    super(config);
    this.supportedInputFormats = ['grib', 'grib2', 'netcdf', 'json', 'csv'];
    this.supportedOutputFormats = ['wrfcoin-json', 'wrfcoin-netcdf'];

    // Import WRFCoin weather data schema
    const {
      WRFCoinWeatherSchema,
      UnitConversions,
    } = require('./weather-data-schema');
    this.schema = WRFCoinWeatherSchema;
    this.unitConversions = UnitConversions;
  }

  /**
   * Convert to WRFCoin unified format
   */
  async convert(inputPath, outputPath, options = {}) {
    const startTime = Date.now();

    try {
      // Sanitize file paths (#472 follow-up)
      inputPath = await sanitizePath(inputPath);
      outputPath = await sanitizePath(outputPath);

      const {
        sourceFormat, // Input format if not auto-detected
        targetFormat = 'wrfcoin-json', // Output format
        stationMapping = null, // Station ID mapping
        variableMapping = null, // Variable name mapping
        qualityControl = true, // Apply quality control
        enrichMetadata = true, // Add WRFCoin metadata
      } = options;

      // Detect input format if not specified
      const inputFormat = sourceFormat || (await this.detectFormat(inputPath));

      // Extract data from input format
      let rawData;
      switch (inputFormat) {
        case 'grib':
        case 'grib2':
          rawData = await this.extractGRIBData(inputPath, options);
          break;
        case 'netcdf':
          rawData = await this.extractNetCDFData(inputPath, options);
          break;
        case 'json':
          rawData = await this.extractJSONData(inputPath, options);
          break;
        case 'csv':
          rawData = await this.extractCSVData(inputPath, options);
          break;
        default:
          throw new Error(`Unsupported input format: ${inputFormat}`);
      }

      // Transform to WRFCoin format
      const wrfcoinData = await this.transformToWRFCoinFormat(rawData, {
        stationMapping,
        variableMapping,
        qualityControl,
        enrichMetadata,
      });

      // Write output in requested format
      await this.writeWRFCoinFormat(wrfcoinData, outputPath, targetFormat);

      const conversionTime = Date.now() - startTime;
      this.updateMetrics(true, conversionTime);

      const result = {
        success: true,
        inputPath,
        outputPath,
        inputFormat,
        outputFormat: targetFormat,
        conversionTime,
        fileSize: await this.getFileSize(outputPath),
        recordCount: Array.isArray(wrfcoinData) ? wrfcoinData.length : 1,
        qualityInfo: wrfcoinData.qualityInfo || null,
      };

      this.logger.info(
        `WRFCoin format conversion completed: ${inputPath} -> ${outputPath}`
      );
      return result;
    } catch (error) {
      const conversionTime = Date.now() - startTime;
      this.updateMetrics(false, conversionTime);

      this.logger.error('WRFCoin format conversion failed:', error);

      return {
        success: false,
        inputPath,
        outputPath,
        error: error.message,
        conversionTime,
      };
    }
  }

  /**
   * Detect input file format
   */
  async detectFormat(filePath) {
    const fileExt = path.extname(filePath).toLowerCase();

    // Simple extension-based detection
    switch (fileExt) {
      case '.grb':
      case '.grib':
      case '.grib2':
        return 'grib';
      case '.nc':
      case '.netcdf':
        return 'netcdf';
      case '.json':
        return 'json';
      case '.csv':
        return 'csv';
      default:
        // Try to detect by file content
        return await this.detectFormatByContent(filePath);
    }
  }

  /**
   * Detect format by examining file content
   */
  async detectFormatByContent(filePath) {
    try {
      // Read first few bytes
      const handle = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(16);
      await handle.read(buffer, 0, 16, 0);
      await handle.close();

      // Check for GRIB magic numbers
      if (buffer.toString('ascii', 0, 4) === 'GRIB') {
        return 'grib';
      }

      // Check for NetCDF magic numbers
      if (
        buffer.toString('ascii', 0, 3) === 'CDF' ||
        buffer.toString('hex', 0, 4) === '89484446'
      ) {
        // HDF5 signature
        return 'netcdf';
      }

      // Check for JSON by trying to parse
      try {
        const content = await fs.readFile(filePath, 'utf8');
        JSON.parse(content.substring(0, 1000));
        return 'json';
      } catch {
        // Not JSON
      }

      // Default to CSV if we can't detect
      return 'csv';
    } catch (error) {
      throw new Error(`Cannot detect file format: ${error.message}`);
    }
  }

  /**
   * Extract data from GRIB format
   */
  async extractGRIBData(inputPath, options) {
    // Use the existing GRIB extraction logic from GFS adapter
    const gribConverter = new GRIBToNetCDFConverter();
    const tempNetCDF = `/tmp/grib_to_wrfcoin_${Date.now()}.nc`;

    try {
      // Convert GRIB to NetCDF first
      await gribConverter.convert(inputPath, tempNetCDF);

      // Then extract as NetCDF
      const data = await this.extractNetCDFData(tempNetCDF, options);

      return {
        ...data,
        originalFormat: 'grib',
        conversionSteps: ['grib -> netcdf -> wrfcoin'],
      };
    } finally {
      // Clean up temporary file
      await fs.unlink(tempNetCDF).catch(() => {});
    }
  }

  /**
   * Extract data from NetCDF format
   */
  async extractNetCDFData(inputPath, options) {
    const netcdfConverter = new NetCDFToJSONConverter();
    const tempJSON = `/tmp/netcdf_to_wrfcoin_${Date.now()}.json`;

    try {
      // Convert NetCDF to JSON first
      await netcdfConverter.convert(inputPath, tempJSON, {
        includeData: true,
        includeMetadata: true,
      });

      // Load JSON data
      const jsonContent = await fs.readFile(tempJSON, 'utf8');
      const jsonData = JSON.parse(jsonContent);

      return {
        ...jsonData,
        originalFormat: 'netcdf',
        conversionSteps: ['netcdf -> json -> wrfcoin'],
      };
    } finally {
      await fs.unlink(tempJSON).catch(() => {});
    }
  }

  /**
   * Extract data from JSON format
   */
  async extractJSONData(inputPath, options) {
    const content = await fs.readFile(inputPath, 'utf8');
    const data = JSON.parse(content);

    return {
      ...data,
      originalFormat: 'json',
      conversionSteps: ['json -> wrfcoin'],
    };
  }

  /**
   * Extract data from CSV format
   */
  async extractCSVData(inputPath, options) {
    const content = await fs.readFile(inputPath, 'utf8');
    const lines = content.trim().split('\n');

    if (lines.length < 2) {
      throw new Error('CSV file must have at least a header and one data row');
    }

    // Parse CSV
    const headers = lines[0].split(',').map(h => h.trim());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const record = {};

      headers.forEach((header, index) => {
        record[header] = values[index] || null;
      });

      records.push(record);
    }

    return {
      format: 'csv',
      headers,
      records,
      originalFormat: 'csv',
      conversionSteps: ['csv -> wrfcoin'],
    };
  }

  /**
   * Transform data to WRFCoin unified format
   */
  async transformToWRFCoinFormat(rawData, options) {
    const { stationMapping, variableMapping, qualityControl, enrichMetadata } =
      options;

    // Handle different input data structures
    let transformedRecords = [];

    if (rawData.originalFormat === 'csv') {
      transformedRecords = this.transformCSVToWRFCoin(rawData, options);
    } else if (rawData.variables) {
      transformedRecords = this.transformGriddedToWRFCoin(rawData, options);
    } else {
      throw new Error('Unsupported data structure for WRFCoin transformation');
    }

    // Apply quality control if requested
    if (qualityControl) {
      transformedRecords = await this.applyQualityControl(transformedRecords);
    }

    // Enrich metadata if requested
    if (enrichMetadata) {
      transformedRecords = this.enrichWRFCoinMetadata(transformedRecords);
    }

    return transformedRecords;
  }

  /**
   * Transform CSV data to WRFCoin format
   */
  transformCSVToWRFCoin(csvData, options) {
    const records = [];

    for (const row of csvData.records) {
      const wrfcoinRecord = {
        metadata: {
          sourceId: row.station_id || row.id || 'unknown',
          sourceType: 'station',
          provider: 'csv-import',
          dataType: 'current',
          timestamp: new Date(
            row.timestamp || row.time || Date.now()
          ).toISOString(),
          ingestedAt: new Date().toISOString(),
          qualityScore: 1.0,
          validationStatus: 'pending',
        },
        location: {
          latitude: parseFloat(row.latitude || row.lat) || 0,
          longitude: parseFloat(row.longitude || row.lon || row.lng) || 0,
          elevation: parseFloat(row.elevation || row.alt) || null,
          stationId: row.station_id || row.id || null,
          stationName: row.station_name || row.name || null,
          locationName: row.location || null,
          country: row.country || null,
          region: row.region || row.state || null,
        },
        measurements: this.mapCSVMeasurements(row),
        validation: {
          rangeValidation: { passed: true, errors: [] },
          physicsValidation: { passed: true, warnings: [] },
          completenessValidation: {
            passed: true,
            completenessRatio: 1.0,
            missingParameters: [],
          },
          overallScore: 1.0,
          qualityLevel: 'good',
        },
      };

      records.push(wrfcoinRecord);
    }

    return records;
  }

  /**
   * Map CSV measurements to WRFCoin format
   */
  mapCSVMeasurements(row) {
    const measurements = {};

    // Common measurement mappings
    const fieldMappings = {
      temperature: ['temperature', 'temp', 't', 'air_temp'],
      humidity: ['humidity', 'rh', 'relative_humidity'],
      pressure: ['pressure', 'press', 'sea_level_pressure', 'slp'],
      windSpeed: ['wind_speed', 'wspd', 'ws'],
      windDirection: ['wind_direction', 'wind_dir', 'wdir', 'wd'],
      precipitation: ['precipitation', 'precip', 'rain'],
      visibility: ['visibility', 'vis'],
      cloudCoverage: ['cloud_cover', 'clouds'],
    };

    for (const [wrfcoinField, csvFields] of Object.entries(fieldMappings)) {
      for (const csvField of csvFields) {
        if (
          row[csvField] !== undefined &&
          row[csvField] !== null &&
          row[csvField] !== ''
        ) {
          const value = parseFloat(row[csvField]);
          if (!isNaN(value)) {
            measurements[wrfcoinField] = {
              value: value,
              unit: this.guessUnit(csvField),
              qualityFlag: 'A',
            };
            break;
          }
        }
      }
    }

    return measurements;
  }

  /**
   * Guess measurement unit based on field name
   */
  guessUnit(fieldName) {
    const lowerField = fieldName.toLowerCase();

    if (lowerField.includes('temp')) return 'celsius';
    if (lowerField.includes('humid')) return 'percent';
    if (lowerField.includes('press')) return 'hPa';
    if (lowerField.includes('wind') && lowerField.includes('speed'))
      return 'm/s';
    if (lowerField.includes('wind') && lowerField.includes('dir'))
      return 'degrees';
    if (lowerField.includes('precip') || lowerField.includes('rain'))
      return 'mm';
    if (lowerField.includes('vis')) return 'km';
    if (lowerField.includes('cloud')) return 'percent';

    return 'unknown';
  }

  /**
   * Transform gridded data to WRFCoin format
   */
  transformGriddedToWRFCoin(griddedData, options) {
    // For gridded data, we'll create records for each grid point
    // This is a simplified transformation - in practice, you might want to
    // aggregate or sample the grid data

    const records = [];
    const variables = griddedData.variables || {};

    // Get coordinate data
    const latData =
      griddedData.coordinates?.latitude?.data ||
      griddedData.coordinates?.lat?.data;
    const lonData =
      griddedData.coordinates?.longitude?.data ||
      griddedData.coordinates?.lon?.data;

    if (!latData || !lonData) {
      throw new Error(
        'Cannot find latitude/longitude coordinates in gridded data'
      );
    }

    // Sample a subset of grid points to avoid creating too many records
    const maxPoints = 1000;
    const stepLat = Math.max(
      1,
      Math.floor(latData.length / Math.sqrt(maxPoints))
    );
    const stepLon = Math.max(
      1,
      Math.floor(lonData.length / Math.sqrt(maxPoints))
    );

    for (let i = 0; i < latData.length; i += stepLat) {
      for (let j = 0; j < lonData.length; j += stepLon) {
        const record = {
          metadata: {
            sourceId: `grid_${i}_${j}`,
            sourceType: 'model',
            provider: 'gridded-data-import',
            dataType: 'current',
            timestamp: new Date().toISOString(),
            ingestedAt: new Date().toISOString(),
            qualityScore: 0.9,
            validationStatus: 'valid',
          },
          location: {
            latitude: latData[i],
            longitude: lonData[j],
            elevation: null,
            stationId: `grid_${i}_${j}`,
            stationName: `Grid Point ${i},${j}`,
            locationName: null,
            country: null,
            region: null,
          },
          measurements: this.extractGridPointMeasurements(variables, i, j),
          validation: {
            rangeValidation: { passed: true, errors: [] },
            physicsValidation: { passed: true, warnings: [] },
            completenessValidation: {
              passed: true,
              completenessRatio: 1.0,
              missingParameters: [],
            },
            overallScore: 0.9,
            qualityLevel: 'good',
          },
        };

        records.push(record);
      }
    }

    return records;
  }

  /**
   * Extract measurements for a specific grid point
   */
  extractGridPointMeasurements(variables, latIndex, lonIndex) {
    const measurements = {};

    // Map common variable names to WRFCoin format
    const variableMappings = {
      t2m: 'temperature',
      temp: 'temperature',
      temperature: 'temperature',
      rh: 'humidity',
      humidity: 'humidity',
      msl: 'pressure',
      pressure: 'pressure',
      u10: 'windSpeed',
      v10: 'windSpeed',
      wind_speed: 'windSpeed',
      precip: 'precipitation',
      precipitation: 'precipitation',
      vis: 'visibility',
      visibility: 'visibility',
    };

    for (const [varName, varData] of Object.entries(variables)) {
      const wrfcoinField = variableMappings[varName.toLowerCase()];

      if (wrfcoinField && varData.data) {
        let value;

        // Handle different array structures
        if (Array.isArray(varData.data) && Array.isArray(varData.data[0])) {
          // 2D array
          value = varData.data[latIndex]
            ? varData.data[latIndex][lonIndex]
            : null;
        } else if (Array.isArray(varData.data)) {
          // 1D array - try to map to 2D index
          const flatIndex = latIndex * (varData.shape[1] || 1) + lonIndex;
          value = varData.data[flatIndex];
        }

        if (value !== null && value !== undefined && !isNaN(value)) {
          measurements[wrfcoinField] = {
            value: value,
            unit: this.inferUnitFromVariable(varName, varData.attributes),
            qualityFlag: 'B', // Good quality for model data
          };
        }
      }
    }

    return measurements;
  }

  /**
   * Infer unit from variable name and attributes
   */
  inferUnitFromVariable(varName, attributes) {
    if (attributes && attributes.units) {
      return attributes.units;
    }

    const lowerName = varName.toLowerCase();

    if (lowerName.includes('temp')) return 'K'; // Kelvin is common in model data
    if (lowerName.includes('humid') || lowerName === 'rh') return 'percent';
    if (lowerName.includes('pressure') || lowerName === 'msl') return 'Pa';
    if (
      lowerName.includes('wind') ||
      lowerName.startsWith('u') ||
      lowerName.startsWith('v')
    )
      return 'm/s';
    if (lowerName.includes('precip')) return 'kg/m^2';
    if (lowerName.includes('vis')) return 'm';

    return 'unknown';
  }

  /**
   * Apply quality control to WRFCoin records
   */
  async applyQualityControl(records) {
    // Import validation rules from existing system
    const { ValidationRules } = require('./weather-data-schema');

    for (const record of records) {
      let overallScore = 1.0;
      const errors = [];
      const warnings = [];

      // Validate each measurement
      for (const [measurementType, measurement] of Object.entries(
        record.measurements
      )) {
        const rule = ValidationRules[measurementType];

        if (rule && measurement.value !== null) {
          // Range validation
          if (measurement.value < rule.min || measurement.value > rule.max) {
            errors.push(
              `${measurementType} value ${measurement.value} outside valid range [${rule.min}, ${rule.max}]`
            );
            overallScore *= 0.5;
          }

          // Unit validation
          if (measurement.unit !== rule.unit) {
            warnings.push(
              `${measurementType} unit ${measurement.unit} differs from expected ${rule.unit}`
            );
            overallScore *= 0.95;
          }
        }
      }

      // Update validation results
      record.validation.rangeValidation = {
        passed: errors.length === 0,
        errors,
      };

      record.validation.physicsValidation = {
        passed: warnings.length === 0,
        warnings,
      };

      record.validation.overallScore = overallScore;
      record.validation.qualityLevel = this.determineQualityLevel(overallScore);
      record.metadata.qualityScore = overallScore;
      record.metadata.validationStatus =
        errors.length === 0 ? 'valid' : 'warning';
    }

    return records;
  }

  /**
   * Determine quality level from score
   */
  determineQualityLevel(score) {
    if (score >= 0.95) return 'excellent';
    if (score >= 0.85) return 'good';
    if (score >= 0.7) return 'fair';
    if (score >= 0.5) return 'poor';
    return 'invalid';
  }

  /**
   * Enrich WRFCoin metadata
   */
  enrichWRFCoinMetadata(records) {
    const timestamp = new Date().toISOString();

    for (const record of records) {
      // Add conversion metadata
      record.metadata.conversionInfo = {
        convertedAt: timestamp,
        converter: 'WRFCoin Climate Data Format Converter v1.0',
        schemaVersion: '1.0.0',
      };

      // Add data completeness assessment
      const totalPossibleMeasurements = Object.keys(
        this.schema.measurements
      ).length;
      const actualMeasurements = Object.keys(record.measurements).length;

      record.validation.completenessValidation = {
        passed: actualMeasurements >= 3, // Minimum 3 measurements
        completenessRatio: actualMeasurements / totalPossibleMeasurements,
        missingParameters: Object.keys(this.schema.measurements).filter(
          param => !(param in record.measurements)
        ),
      };
    }

    return records;
  }

  /**
   * Write WRFCoin format data
   */
  async writeWRFCoinFormat(data, outputPath, format) {
    switch (format) {
      case 'wrfcoin-json':
        await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
        break;
      case 'wrfcoin-netcdf':
        await this.writeWRFCoinNetCDF(data, outputPath);
        break;
      default:
        throw new Error(`Unsupported WRFCoin output format: ${format}`);
    }
  }

  /**
   * Write WRFCoin data to NetCDF format
   */
  async writeWRFCoinNetCDF(data, outputPath) {
    // This would create a NetCDF file following CF conventions
    // For now, we'll create a simplified version using Python

    const pythonScript = `
import xarray as xr
import numpy as np
import json
import sys

try:
    # Load WRFCoin data
    data = json.loads('${JSON.stringify(data).replace(/'/g, "\\'")}')
    
    # Extract coordinates and measurements
    latitudes = [record['location']['latitude'] for record in data]
    longitudes = [record['location']['longitude'] for record in data]
    timestamps = [record['metadata']['timestamp'] for record in data]
    
    # Create coordinate arrays
    unique_lats = sorted(list(set(latitudes)))
    unique_lons = sorted(list(set(longitudes)))
    unique_times = sorted(list(set(timestamps)))
    
    # Create dataset
    coords = {
        'latitude': unique_lats,
        'longitude': unique_lons,
        'time': unique_times
    }
    
    data_vars = {}
    
    # Extract measurements
    measurement_types = set()
    for record in data:
        measurement_types.update(record['measurements'].keys())
    
    for measurement_type in measurement_types:
        # Create array for this measurement
        shape = (len(unique_times), len(unique_lats), len(unique_lons))
        values = np.full(shape, np.nan)
        
        for record in data:
            if measurement_type in record['measurements']:
                try:
                    time_idx = unique_times.index(record['metadata']['timestamp'])
                    lat_idx = unique_lats.index(record['location']['latitude'])
                    lon_idx = unique_lons.index(record['location']['longitude'])
                    
                    value = record['measurements'][measurement_type]['value']
                    values[time_idx, lat_idx, lon_idx] = value
                except (ValueError, KeyError):
                    continue
        
        data_vars[measurement_type] = (['time', 'latitude', 'longitude'], values)
    
    # Create xarray dataset
    ds = xr.Dataset(data_vars, coords=coords)
    
    # Add global attributes
    ds.attrs['title'] = 'WRFCoin Weather Data'
    ds.attrs['institution'] = 'WRFCoin Climate Model Integration Framework'
    ds.attrs['source'] = 'Climate Data Format Converter'
    ds.attrs['conventions'] = 'CF-1.8'
    ds.attrs['created'] = '${new Date().toISOString()}'
    
    # Save to NetCDF
    ds.to_netcdf('${outputPath}')
    print('SUCCESS')
    
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`;

    const scriptPath = `/tmp/write_wrfcoin_netcdf_${Date.now()}.py`;
    await fs.writeFile(scriptPath, pythonScript);

    try {
      const { stdout, stderr } = await execFileAsync('python3', [scriptPath]);

      if (stderr && stderr.includes('ERROR')) {
        throw new Error(`NetCDF writing failed: ${stderr}`);
      }
    } finally {
      await fs.unlink(scriptPath).catch(() => {});
    }
  }

  /**
   * Validate input (generic validation)
   */
  async validateInput(filePath) {
    try {
      await fs.access(filePath, fs.constants.R_OK);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        errors: [error.message],
      };
    }
  }

  /**
   * Get format metadata
   */
  async getFormatMetadata(filePath) {
    const format = await this.detectFormat(filePath);

    return {
      format,
      fileSize: await this.getFileSize(filePath),
      detected: true,
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
 * Climate Data Format Manager
 * Main class that coordinates all format converters
 */
class ClimateDataFormatManager {
  constructor(config = {}) {
    this.config = config;
    this.logger = Logger;

    // Initialize converters
    this.converters = new Map();
    this.initializeConverters();

    // Conversion statistics
    this.stats = {
      totalConversions: 0,
      successfulConversions: 0,
      failedConversions: 0,
      converterStats: {},
    };
  }

  /**
   * Initialize format converters
   */
  initializeConverters() {
    this.converters.set(
      'grib-to-netcdf',
      new GRIBToNetCDFConverter(this.config.gribToNetcdf || {})
    );
    this.converters.set(
      'netcdf-to-json',
      new NetCDFToJSONConverter(this.config.netcdfToJson || {})
    );
    this.converters.set(
      'wrfcoin-format',
      new WRFCoinFormatConverter(this.config.wrfcoinFormat || {})
    );

    this.logger.info(`Initialized ${this.converters.size} format converters`);
  }

  /**
   * Convert data format
   */
  async convertFormat(converterName, inputPath, outputPath, options = {}) {
    if (!this.converters.has(converterName)) {
      throw new Error(`Unknown converter: ${converterName}`);
    }

    const converter = this.converters.get(converterName);
    const result = await converter.convert(inputPath, outputPath, options);

    // Update statistics
    this.updateStats(converterName, result.success);

    return result;
  }

  /**
   * Get available converters
   */
  getAvailableConverters() {
    const converterInfo = {};

    for (const [name, converter] of this.converters) {
      converterInfo[name] = {
        supportedInputFormats: converter.supportedInputFormats,
        supportedOutputFormats: converter.supportedOutputFormats,
        metrics: converter.getMetrics(),
      };
    }

    return converterInfo;
  }

  /**
   * Auto-detect and convert format
   */
  async autoConvert(inputPath, outputFormat, outputPath, options = {}) {
    // Detect input format
    const wrfcoinConverter = this.converters.get('wrfcoin-format');
    const inputFormat = await wrfcoinConverter.detectFormat(inputPath);

    // Determine conversion path
    const conversionPath = this.planConversionPath(inputFormat, outputFormat);

    if (!conversionPath) {
      throw new Error(
        `No conversion path found from ${inputFormat} to ${outputFormat}`
      );
    }

    // Execute conversion chain
    let currentPath = inputPath;

    for (const step of conversionPath) {
      const tempPath = step.final
        ? outputPath
        : `/tmp/temp_conversion_${Date.now()}_${step.to}`;

      const result = await this.convertFormat(
        step.converter,
        currentPath,
        tempPath,
        options
      );

      if (!result.success) {
        throw new Error(`Conversion step failed: ${result.error}`);
      }

      // Clean up intermediate files
      if (currentPath !== inputPath && !step.final) {
        await fs.unlink(currentPath).catch(() => {});
      }

      currentPath = tempPath;
    }

    return {
      success: true,
      inputPath,
      outputPath: currentPath,
      inputFormat,
      outputFormat,
      conversionPath: conversionPath.map(step => `${step.from} -> ${step.to}`),
    };
  }

  /**
   * Plan conversion path between formats
   */
  planConversionPath(inputFormat, outputFormat) {
    // Simple conversion path planning
    // In a more complex system, this would use graph algorithms

    const paths = {
      'grib-to-netcdf': { from: 'grib', to: 'netcdf' },
      'grib-to-wrfcoin': { from: 'grib', to: 'wrfcoin-json', via: ['netcdf'] },
      'netcdf-to-json': { from: 'netcdf', to: 'json' },
      'netcdf-to-wrfcoin': { from: 'netcdf', to: 'wrfcoin-json' },
      'any-to-wrfcoin': { from: '*', to: 'wrfcoin-json' },
    };

    // Simple direct conversion
    if (inputFormat === 'grib' && outputFormat === 'netcdf') {
      return [
        {
          converter: 'grib-to-netcdf',
          from: inputFormat,
          to: outputFormat,
          final: true,
        },
      ];
    }

    if (inputFormat === 'netcdf' && outputFormat === 'json') {
      return [
        {
          converter: 'netcdf-to-json',
          from: inputFormat,
          to: outputFormat,
          final: true,
        },
      ];
    }

    if (outputFormat.startsWith('wrfcoin')) {
      return [
        {
          converter: 'wrfcoin-format',
          from: inputFormat,
          to: outputFormat,
          final: true,
        },
      ];
    }

    // Multi-step conversion
    if (inputFormat === 'grib' && outputFormat === 'json') {
      return [
        {
          converter: 'grib-to-netcdf',
          from: 'grib',
          to: 'netcdf',
          final: false,
        },
        {
          converter: 'netcdf-to-json',
          from: 'netcdf',
          to: 'json',
          final: true,
        },
      ];
    }

    return null; // No path found
  }

  /**
   * Update conversion statistics
   */
  updateStats(converterName, success) {
    this.stats.totalConversions++;

    if (success) {
      this.stats.successfulConversions++;
    } else {
      this.stats.failedConversions++;
    }

    if (!this.stats.converterStats[converterName]) {
      this.stats.converterStats[converterName] = {
        total: 0,
        successful: 0,
        failed: 0,
      };
    }

    this.stats.converterStats[converterName].total++;
    if (success) {
      this.stats.converterStats[converterName].successful++;
    } else {
      this.stats.converterStats[converterName].failed++;
    }
  }

  /**
   * Get conversion statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      successRate:
        this.stats.totalConversions > 0
          ? this.stats.successfulConversions / this.stats.totalConversions
          : 0,
    };
  }
}

module.exports = {
  ClimateDataFormatManager,
  BaseFormatConverter,
  GRIBToNetCDFConverter,
  NetCDFToJSONConverter,
  WRFCoinFormatConverter,
};
