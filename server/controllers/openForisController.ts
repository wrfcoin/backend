/**
 * OpenForis Controller - TypeScript Implementation
 * Handles OpenForis integration for forestry and land use monitoring
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';
import { weatherLogger } from '../utils/logger.js';

// OpenForis interfaces
interface ForestryProject {
  id: string;
  name: string;
  description: string;
  manager: EthereumAddress;
  location: {
    country: string;
    region: string;
    coordinates: {
      latitude: number;
      longitude: number;
    };
    area: number; // hectares
  };
  type:
    | 'forest_monitoring'
    | 'land_use_assessment'
    | 'carbon_inventory'
    | 'biodiversity_survey';
  status: 'planning' | 'active' | 'completed' | 'suspended';
  tools: {
    collectEarth: boolean;
    earthMap: boolean;
    calc: boolean;
    sepal: boolean;
  };
  data: {
    totalPlots: number;
    completedPlots: number;
    dataQuality: number; // percentage
    lastUpdate: Date;
  };
  timeline: {
    startDate: Date;
    endDate: Date;
    milestones: ProjectMilestone[];
  };
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectMilestone {
  id: string;
  title: string;
  description: string;
  dueDate: Date;
  completed: boolean;
  completedAt?: Date;
}

interface CollectEarthSurvey {
  id: string;
  projectId: string;
  plotId: string;
  surveyor: EthereumAddress;
  location: {
    latitude: number;
    longitude: number;
    elevation?: number;
  };
  landUse: {
    primary: string;
    secondary?: string;
    tertiaryForestStructure?: string;
  };
  forestData: {
    treeCount?: number;
    canopyCover?: number; // percentage
    speciesDiversity?: number;
    biomass?: number; // tons per hectare
  };
  imagery: {
    satelliteDate: Date;
    cloudCover: number; // percentage
    resolution: number; // meters
    source: string;
  };
  quality: {
    confidence: number; // percentage
    verified: boolean;
    verifiedBy?: EthereumAddress;
  };
  submittedAt: Date;
  verifiedAt?: Date;
}

interface EarthMapAnalysis {
  id: string;
  projectId: string;
  analysisType:
    | 'deforestation'
    | 'land_use_change'
    | 'carbon_stock'
    | 'forest_degradation';
  region: {
    name: string;
    boundaries: number[][]; // polygon coordinates
    area: number; // hectares
  };
  timeframe: {
    startDate: Date;
    endDate: Date;
    intervals: number; // months
  };
  results: {
    changeDetected: boolean;
    changeArea?: number; // hectares
    changePercentage?: number;
    confidence: number; // percentage
    methodology: string;
  };
  imagery: {
    sources: string[];
    totalImages: number;
    cloudFreeImages: number;
    resolution: number; // meters
  };
  status: 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

// Enhanced request interface
interface OpenForisRequest extends Request {
  storage?: {
    getAllProjects: () => Promise<ForestryProject[]>;
    getProject: (id: string) => Promise<ForestryProject | null>;
    createProject: (
      project: Partial<ForestryProject>
    ) => Promise<ForestryProject>;
    updateProject: (
      id: string,
      updates: Partial<ForestryProject>
    ) => Promise<ForestryProject>;
    getSurveys: (
      projectId?: string,
      limit?: number
    ) => Promise<CollectEarthSurvey[]>;
    createSurvey: (
      survey: Partial<CollectEarthSurvey>
    ) => Promise<CollectEarthSurvey>;
    getAnalyses: (
      projectId?: string,
      limit?: number
    ) => Promise<EarthMapAnalysis[]>;
    createAnalysis: (
      analysis: Partial<EarthMapAnalysis>
    ) => Promise<EarthMapAnalysis>;
  };
  openForisService?: {
    initializeProject: (project: ForestryProject) => Promise<boolean>;
    processSurvey: (survey: CollectEarthSurvey) => Promise<boolean>;
    runAnalysis: (analysis: EarthMapAnalysis) => Promise<any>;
    validateData: (data: any) => Promise<boolean>;
  };
}

/**
 * Get all forestry projects
 */
export const getAllProjects = async (
  req: OpenForisRequest,
  res: Response
): Promise<PaginatedResponse<ForestryProject>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const type = req.query.type as string;
    const status = req.query.status as string;
    const country = req.query.country as string;

    let projects: ForestryProject[] = [];
    if (req.storage) {
      projects = await req.storage.getAllProjects();
    } else {
      // Mock projects for development
      projects = [
        {
          id: 'project_1',
          name: 'Amazon Basin Carbon Monitoring',
          description:
            'Large-scale carbon stock assessment and deforestation monitoring in the Amazon Basin',
          manager:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          location: {
            country: 'Brazil',
            region: 'Amazon Basin',
            coordinates: {
              latitude: -3.4653,
              longitude: -62.2159,
            },
            area: 500000, // 500,000 hectares
          },
          type: 'carbon_inventory',
          status: 'active',
          tools: {
            collectEarth: true,
            earthMap: true,
            calc: true,
            sepal: false,
          },
          data: {
            totalPlots: 1000,
            completedPlots: 750,
            dataQuality: 92,
            lastUpdate: new Date(),
          },
          timeline: {
            startDate: new Date('2024-01-15'),
            endDate: new Date('2025-01-15'),
            milestones: [
              {
                id: 'milestone_1',
                title: 'Baseline Assessment Complete',
                description:
                  'Complete initial forest inventory and carbon stock assessment',
                dueDate: new Date('2024-06-15'),
                completed: true,
                completedAt: new Date('2024-06-10'),
              },
            ],
          },
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (type) {
      projects = projects.filter(project => project.type === type);
    }
    if (status) {
      projects = projects.filter(project => project.status === status);
    }
    if (country) {
      projects = projects.filter(project =>
        project.location.country.toLowerCase().includes(country.toLowerCase())
      );
    }

    // Sort by last update (most recent first)
    projects.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedProjects = projects.slice(startIndex, endIndex);
    const totalPages = Math.ceil(projects.length / limit);

    const response: PaginatedResponse<ForestryProject> = {
      success: true,
      data: paginatedProjects,
      message: `Retrieved ${paginatedProjects.length} forestry projects`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: projects.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in getAllProjects', { module: 'OpenForisController', operation: 'getAllProjects', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<ForestryProject> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve forestry projects',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create forestry project
 */
export const createProject = async (
  req: OpenForisRequest,
  res: Response
): Promise<ControllerResponse<ForestryProject>> => {
  const requestId = uuidv4();

  try {
    const { name, description, manager, location, type, tools, timeline } =
      req.body;

    // Validate required fields
    if (!name || !manager || !location || !type || !timeline) {
      const errorResponse: ControllerResponse<ForestryProject> = {
        success: false,
        error: 'Missing required fields',
        message: 'Name, manager, location, type, and timeline are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate manager address
    if (!manager.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<ForestryProject> = {
        success: false,
        error: 'Invalid manager address',
        message: 'Manager must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate project type
    const validTypes = [
      'forest_monitoring',
      'land_use_assessment',
      'carbon_inventory',
      'biodiversity_survey',
    ];
    if (!validTypes.includes(type)) {
      const errorResponse: ControllerResponse<ForestryProject> = {
        success: false,
        error: 'Invalid project type',
        message: `Project type must be one of: ${validTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate location
    if (!location.country || !location.coordinates || !location.area) {
      const errorResponse: ControllerResponse<ForestryProject> = {
        success: false,
        error: 'Invalid location',
        message: 'Location must include country, coordinates, and area',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate coordinates
    const { latitude, longitude } = location.coordinates;
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      const errorResponse: ControllerResponse<ForestryProject> = {
        success: false,
        error: 'Invalid coordinates',
        message:
          'Latitude must be between -90 and 90, longitude between -180 and 180',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create project data
    const projectData: Partial<ForestryProject> = {
      id: `project_${uuidv4()}`,
      name,
      description: description || '',
      manager: manager as EthereumAddress,
      location,
      type,
      status: 'planning',
      tools: tools || {
        collectEarth: true,
        earthMap: false,
        calc: false,
        sepal: false,
      },
      data: {
        totalPlots: 0,
        completedPlots: 0,
        dataQuality: 0,
        lastUpdate: new Date(),
      },
      timeline: {
        ...timeline,
        milestones: timeline.milestones || [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let project: ForestryProject;
    if (req.storage) {
      project = await req.storage.createProject(projectData);
    } else {
      project = projectData as ForestryProject;
    }

    // Initialize project if service is available
    if (req.openForisService) {
      const initialized = await req.openForisService.initializeProject(project);
      if (initialized) {
        project.status = 'active';
        if (req.storage) {
          project = await req.storage.updateProject(project.id, {
            status: 'active',
          });
        }
      }
    }

    const response: ControllerResponse<ForestryProject> = {
      success: true,
      data: project,
      message: 'Forestry project created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in createProject', { module: 'OpenForisController', operation: 'createProject', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ForestryProject> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create forestry project',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit Collect Earth survey
 */
export const submitSurvey = async (
  req: OpenForisRequest,
  res: Response
): Promise<ControllerResponse<CollectEarthSurvey>> => {
  const requestId = uuidv4();

  try {
    const {
      projectId,
      plotId,
      surveyor,
      location,
      landUse,
      forestData,
      imagery,
    } = req.body;

    // Validate required fields
    if (!projectId || !plotId || !surveyor || !location || !landUse) {
      const errorResponse: ControllerResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Project ID, plot ID, surveyor, location, and land use are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate surveyor address
    if (!surveyor.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Invalid surveyor address',
        message: 'Surveyor must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate coordinates
    const { latitude, longitude } = location;
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      const errorResponse: ControllerResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Invalid coordinates',
        message: 'Invalid latitude or longitude values',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate project exists
    let project: ForestryProject | null = null;
    if (req.storage) {
      project = await req.storage.getProject(projectId);
    }

    if (!project) {
      const notFoundResponse: ControllerResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Project not found',
        message: `No project found with ID ${projectId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (project.status !== 'active') {
      const errorResponse: ControllerResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Project not active',
        message: 'Cannot submit surveys to inactive projects',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create survey data
    const surveyData: Partial<CollectEarthSurvey> = {
      id: `survey_${uuidv4()}`,
      projectId,
      plotId,
      surveyor: surveyor as EthereumAddress,
      location,
      landUse,
      forestData: forestData || {},
      imagery: imagery || {
        satelliteDate: new Date(),
        cloudCover: 0,
        resolution: 10,
        source: 'Landsat',
      },
      quality: {
        confidence: 85,
        verified: false,
      },
      submittedAt: new Date(),
    };

    let survey: CollectEarthSurvey;
    if (req.storage) {
      survey = await req.storage.createSurvey(surveyData);
    } else {
      survey = surveyData as CollectEarthSurvey;
    }

    // Process survey if service is available
    if (req.openForisService) {
      const processed = await req.openForisService.processSurvey(survey);
      if (processed) {
        survey.quality.confidence = 95;
      }
    }

    // Update project data
    if (req.storage && project) {
      await req.storage.updateProject(projectId, {
        data: {
          ...project.data,
          completedPlots: project.data.completedPlots + 1,
          lastUpdate: new Date(),
        },
        updatedAt: new Date(),
      });
    }

    const response: ControllerResponse<CollectEarthSurvey> = {
      success: true,
      data: survey,
      message: 'Survey submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in submitSurvey', { module: 'OpenForisController', operation: 'submitSurvey', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CollectEarthSurvey> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit survey',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Run Earth Map analysis
 */
export const runAnalysis = async (
  req: OpenForisRequest,
  res: Response
): Promise<ControllerResponse<EarthMapAnalysis>> => {
  const requestId = uuidv4();

  try {
    const { projectId, analysisType, region, timeframe } = req.body;

    // Validate required fields
    if (!projectId || !analysisType || !region || !timeframe) {
      const errorResponse: ControllerResponse<EarthMapAnalysis> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Project ID, analysis type, region, and timeframe are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate analysis type
    const validTypes = [
      'deforestation',
      'land_use_change',
      'carbon_stock',
      'forest_degradation',
    ];
    if (!validTypes.includes(analysisType)) {
      const errorResponse: ControllerResponse<EarthMapAnalysis> = {
        success: false,
        error: 'Invalid analysis type',
        message: `Analysis type must be one of: ${validTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate project exists
    let project: ForestryProject | null = null;
    if (req.storage) {
      project = await req.storage.getProject(projectId);
    }

    if (!project) {
      const notFoundResponse: ControllerResponse<EarthMapAnalysis> = {
        success: false,
        error: 'Project not found',
        message: `No project found with ID ${projectId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (!project.tools.earthMap) {
      const errorResponse: ControllerResponse<EarthMapAnalysis> = {
        success: false,
        error: 'Earth Map not enabled',
        message: 'Earth Map tool is not enabled for this project',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create analysis data
    const analysisData: Partial<EarthMapAnalysis> = {
      id: `analysis_${uuidv4()}`,
      projectId,
      analysisType,
      region,
      timeframe,
      results: {
        changeDetected: false,
        confidence: 0,
        methodology: 'Time series analysis with Landsat imagery',
      },
      imagery: {
        sources: ['Landsat 8', 'Sentinel-2'],
        totalImages: 0,
        cloudFreeImages: 0,
        resolution: 10,
      },
      status: 'processing',
      createdAt: new Date(),
    };

    let analysis: EarthMapAnalysis;
    if (req.storage) {
      analysis = await req.storage.createAnalysis(analysisData);
    } else {
      analysis = analysisData as EarthMapAnalysis;
    }

    // Run analysis if service is available
    if (req.openForisService) {
      try {
        const results = await req.openForisService.runAnalysis(analysis);
        analysis.results = results;
        analysis.status = 'completed';
        analysis.completedAt = new Date();
      } catch (error) {
        analysis.status = 'failed';
      }
    } else {
      // Mock analysis results for development
      analysis.results = {
        changeDetected: true,
        changeArea: 150.5,
        changePercentage: 3.2,
        confidence: 89,
        methodology: 'Time series analysis with Landsat imagery',
      };
      analysis.status = 'completed';
      analysis.completedAt = new Date();
    }

    const response: ControllerResponse<EarthMapAnalysis> = {
      success: analysis.status !== 'failed',
      data: analysis,
      message:
        analysis.status === 'failed'
          ? 'Analysis failed to complete'
          : 'Analysis initiated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(analysis.status === 'failed' ? 400 : 201).json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in runAnalysis', { module: 'OpenForisController', operation: 'runAnalysis', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<EarthMapAnalysis> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to run analysis',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get project surveys
 */
export const getProjectSurveys = async (
  req: OpenForisRequest,
  res: Response
): Promise<PaginatedResponse<CollectEarthSurvey>> => {
  const requestId = uuidv4();

  try {
    const projectId = req.params.projectId;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!projectId) {
      const errorResponse: PaginatedResponse<CollectEarthSurvey> = {
        success: false,
        error: 'Project ID is required',
        message: 'Please provide a valid project ID',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let surveys: CollectEarthSurvey[] = [];
    if (req.storage) {
      surveys = await req.storage.getSurveys(projectId, limit);
    } else {
      // Mock surveys for development
      surveys = [
        {
          id: 'survey_1',
          projectId,
          plotId: 'plot_001',
          surveyor:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          location: {
            latitude: -3.4653,
            longitude: -62.2159,
            elevation: 125,
          },
          landUse: {
            primary: 'Forest',
            secondary: 'Primary forest',
            tertiaryForestStructure: 'Dense canopy',
          },
          forestData: {
            treeCount: 45,
            canopyCover: 85,
            speciesDiversity: 12,
            biomass: 250,
          },
          imagery: {
            satelliteDate: new Date('2024-06-15'),
            cloudCover: 15,
            resolution: 10,
            source: 'Landsat 8',
          },
          quality: {
            confidence: 92,
            verified: true,
            verifiedBy:
              '0x2345678901234567890123456789012345678901' as EthereumAddress,
          },
          submittedAt: new Date(Date.now() - 86400000),
          verifiedAt: new Date(Date.now() - 82800000),
        },
      ];
    }

    // Sort by submission date (most recent first)
    surveys.sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedSurveys = surveys.slice(startIndex, endIndex);
    const totalPages = Math.ceil(surveys.length / limit);

    const response: PaginatedResponse<CollectEarthSurvey> = {
      success: true,
      data: paginatedSurveys,
      message: `Retrieved ${paginatedSurveys.length} surveys`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: surveys.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in getProjectSurveys', { module: 'OpenForisController', operation: 'getProjectSurveys', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<CollectEarthSurvey> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve project surveys',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getAllProjects,
  createProject,
  submitSurvey,
  runAnalysis,
  getProjectSurveys,
};
