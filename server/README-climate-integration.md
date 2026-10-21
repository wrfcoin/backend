# WRFCoin Climate Model Integration Framework

## Overview

The WRFCoin Climate Model Integration Framework is a comprehensive, enterprise-grade system designed
to seamlessly integrate multiple numerical weather prediction models (GFS, WRF, ICON) with the
WRFCoin weather data platform. This framework provides unified interfaces for model execution, data
exchange, format conversion, and blockchain provenance tracking.

## Architecture

### Core Components

1. **Climate Model Framework** (`climate-model-integration-framework.js`)

   - Orchestrates multi-model operations
   - Manages job queuing and execution
   - Provides unified adapter interfaces for different climate models

2. **Data Format Converter** (`climate-data-format-converter.js`)

   - Converts between GRIB, NetCDF, JSON, and WRFCoin formats
   - Handles metadata preservation and quality validation
   - Supports batch processing and streaming operations

3. **Data Transformer** (`climate-data-transformer.js`)

   - Coordinates system transformations and unit conversions
   - Temporal alignment and spatial regridding
   - WRFCoin schema standardization

4. **Model Controller** (`climate-model-controller.js`)

   - RESTful API endpoints for model operations
   - Request validation and rate limiting
   - Performance metrics and health monitoring

5. **API Routes** (`climate-model-routes.js`)
   - Comprehensive REST API with full documentation
   - Model execution, data retrieval, and format conversion endpoints
   - System monitoring and health check endpoints

## Supported Climate Models

### GFS (Global Forecast System)

- **Provider**: NOAA/NCEP
- **Type**: Global numerical weather prediction
- **Resolution**: 0.25° (∼28km)
- **Forecast Range**: Up to 384 hours (16 days)
- **Update Frequency**: Every 6 hours (00, 06, 12, 18 UTC)
- **Data Source**: AWS Open Data or NCEP servers

### WRF (Weather Research and Forecasting)

- **Provider**: NCAR/NOAA
- **Type**: Regional atmospheric modeling system
- **Resolution**: User-configurable (1km - 50km typical)
- **Forecast Range**: User-configurable (hours to days)
- **Execution**: Containerized Docker environment
- **Use Case**: High-resolution regional forecasts

### ICON (ICOsahedral Nonhydrostatic)

- **Provider**: DWD (German Weather Service)
- **Type**: Global and regional weather model
- **Resolution**: 13km (global), 2.2km (Europe)
- **Forecast Range**: 120 hours (global), 78 hours (Europe)
- **Update Frequency**: 4x daily (global), 8x daily (Europe)
- **Grid**: Icosahedral-triangular mesh

## Data Format Support

### Input Formats

- **GRIB/GRIB2**: Binary gridded meteorological data
- **NetCDF**: Network Common Data Form
- **HDF5**: Hierarchical Data Format
- **JSON**: JavaScript Object Notation
- **CSV**: Comma Separated Values

### Output Formats

- **WRFCoin-JSON**: Unified JSON format with metadata
- **WRFCoin-NetCDF**: Standardized NetCDF with provenance
- **NetCDF**: Standard NetCDF format
- **JSON**: Generic JSON output

### Conversion Capabilities

- Automatic format detection
- Metadata preservation and enhancement
- Unit standardization and conversion
- Quality validation during conversion
- Coordinate system transformations
- Temporal and spatial regridding

## API Endpoints

### Model Operations

- `POST /api/climate/models/execute` - Execute climate model
- `GET /api/climate/models/:modelName/data` - Retrieve model data
- `GET /api/climate/models/available` - List available models

### Job Management

- `GET /api/climate/jobs/active` - Get active jobs
- `GET /api/climate/jobs/history` - Get job history
- `DELETE /api/climate/jobs/:jobId` - Cancel job
- `GET /api/climate/jobs/stats` - Get job statistics

### Data Conversion

- `POST /api/climate/convert/format` - Convert specific format
- `POST /api/climate/convert/auto` - Auto-detect and convert
- `GET /api/climate/convert/converters` - List converters
- `GET /api/climate/convert/formats` - List supported formats

### System Monitoring

- `GET /api/climate/system/status` - System status
- `GET /api/climate/system/health` - Health check
- `GET /api/climate/system/metrics` - Performance metrics
- `GET /api/climate/system/info` - System information

### Documentation

- `GET /api/climate/docs` - API documentation
- `GET /api/climate/examples` - Usage examples
- `GET /api/climate/schemas` - Data schemas

## Installation and Setup

### Prerequisites

- Node.js 18+ with TypeScript support
- Docker (for WRF model execution)
- PostgreSQL database
- Redis (for caching and job queues)
- CDO (Climate Data Operators) for GRIB processing
- Python 3.8+ with scientific libraries (numpy, scipy, netCDF4)

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://localhost:5432/wrfcoin
REDIS_URL=redis://localhost:6379

# API Configuration
PORT=4001
NODE_ENV=production
JWT_SECRET=your-jwt-secret

# Model-Specific Configuration
GFS_AWS_ENABLED=true
GFS_BASE_URL=https://noaa-gfs-bdp-pds.s3.amazonaws.com
WRF_DOCKER_IMAGE=wrfcoin/wrf:latest
ICON_BASE_URL=https://opendata.dwd.de

# External Tools
CDO_PATH=/usr/bin/cdo
PYTHON_PATH=/usr/bin/python3

# Blockchain Integration
BLOCKCHAIN_ENABLED=true
BLOCKCHAIN_NODE_URL=http://localhost:8080

# Security
CORS_ORIGIN=http://localhost:5000,https://app.wrfcoin.com
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
```

### Installation Steps

1. **Install Dependencies**

```bash
npm install
```

2. **Setup External Tools**

```bash
# Install CDO (Ubuntu/Debian)
sudo apt-get install cdo

# Install Python scientific stack
pip install numpy scipy netCDF4 xarray

# Setup Docker for WRF
docker pull wrfcoin/wrf:latest
```

3. **Database Setup**

```bash
# Run migrations
npm run migrate

# Seed test data (optional)
npm run seed:test
```

4. **Start Services**

```bash
# Development mode
npm run dev

# Production mode
npm run start

# With Docker Compose
docker-compose up -d
```

## Usage Examples

### Execute GFS Model

```bash
curl -X POST http://localhost:4001/api/climate/models/execute \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "GFS",
    "parameters": {
      "runTime": "2023-10-27T00:00:00Z",
      "forecastHours": [0, 6, 12, 24],
      "variables": ["TMP", "UGRD", "VGRD", "PRMSL"],
      "bounds": {
        "north": 50,
        "south": 30,
        "east": -70,
        "west": -120
      }
    },
    "options": {
      "outputFormat": "wrfcoin-json"
    }
  }'
```

### Convert Data Format

```bash
curl -X POST http://localhost:4001/api/climate/convert/auto \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/data/gfs.t00z.pgrb2.0p25.f006",
    "outputFormat": "wrfcoin-json",
    "outputPath": "/output/gfs_converted.json",
    "options": {
      "variables": ["temperature", "wind_speed", "pressure"],
      "qualityControl": true,
      "enrichMetadata": true
    }
  }'
```

### Execute WRF Model

```bash
curl -X POST http://localhost:4001/api/climate/models/execute \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "WRF",
    "parameters": {
      "domain": {
        "center": [40.0, -105.0],
        "size": [100, 100],
        "resolution": [10000, 10000]
      },
      "timeRange": {
        "start": "2023-10-27T00:00:00Z",
        "end": "2023-10-28T00:00:00Z"
      },
      "physicsOptions": "default",
      "outputFrequency": 3600
    },
    "options": {
      "parallelCores": 4,
      "maxRuntimeHours": 6
    }
  }'
```

## Configuration

### Framework Configuration

```javascript
const frameworkConfig = {
  enabledModels: ['GFS', 'WRF', 'ICON'],
  maxConcurrentJobs: 5,
  enableBlockchainProvenance: true,
  dataRetentionDays: 30,

  gfs: {
    useAWS: true,
    resolution: '0p25',
    maxForecastHours: 384,
  },

  wrf: {
    useDocker: true,
    dockerImage: 'wrfcoin/wrf:latest',
    maxRuntimeHours: 12,
    workDir: '/tmp/wrf_runs',
  },

  icon: {
    region: 'global', // or 'europe'
    maxForecastHours: 120,
  },
};
```

### Data Transformation Options

```javascript
const transformationSpec = {
  coordinateTransformation: {
    fromCRS: 'WGS84',
    toCRS: 'WebMercator',
    options: { validateBounds: true },
  },

  unitNormalization: true,

  temporalAlignment: {
    targetGrid: {
      start: '2023-10-27T00:00:00Z',
      end: '2023-10-27T18:00:00Z',
      interval: 6,
    },
  },

  spatialRegridding: {
    targetGrid: {
      longitude: Array.from({ length: 100 }, (_, i) => -120 + i * 0.4),
      latitude: Array.from({ length: 80 }, (_, i) => 30 + i * 0.25),
    },
    method: 'bilinear',
  },
};
```

## Testing

### Running Tests

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Performance tests
npm run test:performance

# Coverage report
npm run test:coverage
```

### Test Categories

- **Unit Tests**: Individual component testing
- **Integration Tests**: End-to-end workflow testing
- **Performance Tests**: Load and scalability testing
- **Format Tests**: Data conversion validation
- **API Tests**: Endpoint functionality testing

### Test Data

The framework includes comprehensive test data generators for:

- Mock GRIB/GRIB2 files with realistic structure
- NetCDF test datasets with various dimensions
- CSV weather station data
- JSON formatted climate data

## Performance Specifications

### Throughput

- **GFS Processing**: 50-100 forecast files per hour
- **Format Conversion**: 10-20 GB/hour sustained
- **API Requests**: 1000+ requests/minute
- **Concurrent Jobs**: Up to 10 parallel model executions

### Latency

- **GFS Data Retrieval**: < 30 seconds
- **Format Conversion**: < 5 seconds per 100MB
- **API Response**: < 200ms for metadata requests
- **WRF Execution**: 1-6 hours depending on domain size

### Resource Requirements

- **Memory**: 8GB minimum, 32GB recommended for large domains
- **Storage**: 100GB+ for model data caching
- **CPU**: 8+ cores recommended for parallel processing
- **Network**: High bandwidth for real-time data retrieval

## Security Features

### Data Protection

- Input validation and sanitization
- Rate limiting and DDoS protection
- Secure file handling and temporary storage cleanup
- Authentication and authorization middleware

### Blockchain Integration

- Immutable data provenance tracking
- Cryptographic data integrity verification
- Transparent processing history
- Multi-signature validation support

### Access Control

- API key authentication
- Role-based permissions
- IP whitelisting support
- Audit logging for all operations

## Monitoring and Observability

### Metrics Collection

- Request/response timing and throughput
- Model execution success/failure rates
- Data quality assessment scores
- Resource utilization monitoring

### Health Checks

- Service availability monitoring
- External dependency health
- Data pipeline status
- Performance threshold alerting

### Logging

- Structured JSON logging
- Distributed tracing support
- Error aggregation and analysis
- Security event monitoring

## Troubleshooting

### Common Issues

1. **GRIB File Processing Errors**

   - Verify CDO installation and PATH
   - Check file permissions and temporary space
   - Validate GRIB file integrity

2. **WRF Execution Failures**

   - Check Docker daemon status
   - Verify container image availability
   - Monitor resource consumption

3. **Format Conversion Timeouts**

   - Adjust timeout settings for large files
   - Check available disk space
   - Monitor memory usage during conversion

4. **API Rate Limiting**
   - Review rate limit settings
   - Implement request queuing
   - Use appropriate caching strategies

### Debug Mode

```bash
# Enable detailed logging
DEBUG=climate:* npm start

# Run with verbose output
npm run start -- --verbose

# Development mode with hot reload
npm run dev
```

## Contributing

### Development Guidelines

- Follow TypeScript strict mode requirements
- Implement comprehensive error handling
- Add unit tests for all new functionality
- Update API documentation for changes
- Follow semantic versioning for releases

### Code Style

- Use ESLint configuration provided
- Format code with Prettier
- Follow conventional commit messages
- Document all public APIs with JSDoc

### Testing Requirements

- Minimum 80% code coverage
- Integration tests for new endpoints
- Performance tests for data processing
- Security tests for sensitive operations

## License

This Climate Model Integration Framework is part of the WRFCoin platform and is licensed under the
MIT License. See LICENSE file for details.

## Support

For technical support and questions:

- Documentation: https://docs.wrfcoin.com/climate-integration
- Issues: https://github.com/wrfcoin/platform/issues
- Discussion: https://discord.gg/wrfcoin
- Email: support@wrfcoin.com

---

**WRFCoin Climate Model Integration Framework v1.0.0**  
Built with ❤️ for the global weather community
