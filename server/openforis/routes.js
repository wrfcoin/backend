/**
 * OpenForis API Routes
 *
 * Example routes demonstrating OpenForis API validation usage
 */

const express = require('express');
const OpenForisMiddleware = require('./middleware');
const { OpenForisAdapter } = require('./adapter');

const router = express.Router();

// Apply general middleware
router.use(OpenForisMiddleware.cors());
router.use(OpenForisMiddleware.requestLogger());
router.use(
  OpenForisMiddleware.rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 requests per windowMs for OpenForis endpoints
  })
);

// Health check endpoint
router.get('/health', OpenForisMiddleware.healthCheck());

// Initialize OpenForis adapter
let openforisAdapter;

const getAdapter = () => {
  if (!openforisAdapter) {
    openforisAdapter = new OpenForisAdapter({
      testMode: process.env.NODE_ENV !== 'production',
    });
  }
  return openforisAdapter;
};

/**
 * Project Management Routes
 */

// Get all projects
router.get(
  '/projects',
  OpenForisMiddleware.cache({ maxAge: 5 * 60 }), // Cache for 5 minutes
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const projects = adapter.getAllProjects();

      res.json({
        success: true,
        data: projects,
        count: projects.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get project by ID
router.get('/projects/:projectId', async (req, res, next) => {
  try {
    const adapter = getAdapter();
    await adapter.initialize();

    const project = adapter.getProjectById(req.params.projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
        code: 'PROJECT_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: project,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Create new project with validation
router.post(
  '/projects',
  ...OpenForisMiddleware.validateCreateProject(),
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const project = await adapter.createCollectEarthProject(req.body);

      res.status(201).json({
        success: true,
        data: project,
        message: 'Project created successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Plot Management Routes
 */

// Get plots for a project
router.get(
  '/projects/:projectId/plots',
  OpenForisMiddleware.cache({ maxAge: 3 * 60 }), // Cache for 3 minutes
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const plots = adapter.getPlotsByProject(req.params.projectId);

      res.json({
        success: true,
        data: plots,
        count: plots.length,
        projectId: req.params.projectId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get plot by ID
router.get('/plots/:plotId', async (req, res, next) => {
  try {
    const adapter = getAdapter();
    await adapter.initialize();

    const plot = adapter.getPlotById(req.params.plotId);

    if (!plot) {
      return res.status(404).json({
        success: false,
        error: 'Plot not found',
        code: 'PLOT_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: plot,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Create new plot with validation
router.post(
  '/plots',
  ...OpenForisMiddleware.validateCreatePlot(),
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const result = await adapter.createPlot(req.body);

      res.status(201).json({
        success: true,
        data: result.plot,
        message: 'Plot created successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Time Series Analysis Routes
 */

// Get time series data for a plot
router.get('/plots/:plotId/time-series', async (req, res, next) => {
  try {
    const adapter = getAdapter();
    await adapter.initialize();

    const timeSeries = adapter.getTimeSeriesForPlot(req.params.plotId);

    if (!timeSeries) {
      return res.status(404).json({
        success: false,
        error: 'Time series data not found',
        code: 'TIME_SERIES_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: timeSeries,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Start time series analysis with validation
router.post(
  '/plots/:plotId/time-series',
  ...OpenForisMiddleware.validateTimeSeriesAnalysis(),
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const timeSeries = await adapter.startTimeSeriesAnalysis(
        req.params.plotId,
        req.body
      );

      res.status(202).json({
        success: true,
        data: timeSeries,
        message: 'Time series analysis started',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Climate Projection Routes
 */

// Get climate scenarios
router.get(
  '/climate/scenarios',
  OpenForisMiddleware.cache({ maxAge: 60 * 60 }), // Cache for 1 hour
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const scenarios = adapter.getClimateScenarios();

      res.json({
        success: true,
        data: scenarios,
        count: scenarios.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Get climate data for region and scenario
router.get('/climate/data', async (req, res, next) => {
  try {
    const { region, scenario } = req.query;

    if (!region || !scenario) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters',
        code: 'MISSING_PARAMETERS',
        message: 'Both region and scenario parameters are required',
        timestamp: new Date().toISOString(),
      });
    }

    const adapter = getAdapter();
    await adapter.initialize();

    const climateData = adapter.getClimateData(region, scenario);

    if (!climateData) {
      return res.status(404).json({
        success: false,
        error: 'Climate data not found',
        code: 'CLIMATE_DATA_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: climateData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Generate climate projection with validation
router.post(
  '/climate/projections',
  ...OpenForisMiddleware.validateClimateProjection(),
  async (req, res, next) => {
    try {
      const adapter = getAdapter();
      await adapter.initialize();

      const projection = await adapter.generateClimateProjection(req.body);

      res.status(201).json({
        success: true,
        data: projection,
        message: 'Climate projection generated successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Data Export Routes
 */

// Export data to blockchain
router.post('/export/:dataType/:dataId', async (req, res, next) => {
  try {
    const { dataType, dataId } = req.params;

    const validDataTypes = ['PROJECT', 'PLOT', 'TIME_SERIES', 'CLIMATE_DATA'];
    if (!validDataTypes.includes(dataType.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid data type',
        code: 'INVALID_DATA_TYPE',
        message: `Data type must be one of: ${validDataTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
    }

    const adapter = getAdapter();
    await adapter.initialize();

    const result = await adapter.exportToBlockchain(
      dataType.toUpperCase(),
      dataId
    );

    res.json({
      success: true,
      data: result,
      message: 'Data exported to blockchain successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Error handling middleware (must be last)
router.use(OpenForisMiddleware.errorHandler());

module.exports = router;
