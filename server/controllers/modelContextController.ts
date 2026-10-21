/**
 * Model Context Controller - TypeScript Implementation
 * Handles Model Context Protocol integration for AI model communication
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import { EthereumAddress } from '../../shared/types/security-types.js';
import { aimlLogger } from '../utils/logger.js';

// Model Context Protocol interfaces
interface MCPConfiguration {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  serverUrl: string;
  models: MCPModel[];
  authentication: {
    type: 'none' | 'api_key' | 'oauth' | 'jwt';
    credentials?: Record<string, string>;
  };
  capabilities: string[];
  settings: {
    timeout: number; // milliseconds
    retryAttempts: number;
    batchSize: number;
    rateLimitRpm: number; // requests per minute
  };
  metadata: {
    description?: string;
    provider?: string;
    documentation?: string;
    supportedFormats?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

interface MCPModel {
  id: string;
  name: string;
  type: 'text' | 'image' | 'audio' | 'multimodal';
  version: string;
  status: 'available' | 'unavailable' | 'deprecated';
  capabilities: string[];
  parameters: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    contextWindow?: number;
  };
  pricing: {
    inputTokens: number; // cost per 1k tokens
    outputTokens: number; // cost per 1k tokens
    currency: string;
  };
  metadata: Record<string, any>;
}

interface MCPRequest {
  id: string;
  configId: string;
  modelId: string;
  requestType: 'completion' | 'chat' | 'embedding' | 'classification';
  input: any;
  parameters?: Record<string, any>;
  submittedBy: EthereumAddress;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  response?: any;
  errorMessage?: string;
  tokensUsed?: {
    input: number;
    output: number;
    total: number;
  };
  cost?: number;
  processingTime?: number; // milliseconds
  timestamp: Date;
  completedAt?: Date;
}

interface MCPMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number; // milliseconds
  totalTokensUsed: number;
  totalCost: number;
  uptime: number; // percentage
  errorRate: number; // percentage
  requestsPerMinute: number;
  lastUpdated: Date;
}

// Enhanced request interface
interface ModelContextRequest extends Request {
  storage?: {
    getAllConfigurations: () => Promise<MCPConfiguration[]>;
    getConfiguration: (id: string) => Promise<MCPConfiguration | null>;
    createConfiguration: (
      config: Partial<MCPConfiguration>
    ) => Promise<MCPConfiguration>;
    updateConfiguration: (
      id: string,
      updates: Partial<MCPConfiguration>
    ) => Promise<MCPConfiguration>;
    deleteConfiguration: (id: string) => Promise<boolean>;
    getRequests: (configId?: string, status?: string) => Promise<MCPRequest[]>;
    createRequest: (request: Partial<MCPRequest>) => Promise<MCPRequest>;
    updateRequest: (
      id: string,
      updates: Partial<MCPRequest>
    ) => Promise<MCPRequest>;
    getMetrics: (configId?: string) => Promise<MCPMetrics>;
  };
  mcpService?: {
    testConnection: (config: MCPConfiguration) => Promise<boolean>;
    executeRequest: (request: MCPRequest) => Promise<any>;
    getAvailableModels: (configId: string) => Promise<MCPModel[]>;
    validateConfiguration: (
      config: Partial<MCPConfiguration>
    ) => Promise<boolean>;
  };
}

/**
 * Get all MCP configurations
 */
export const getAllConfigurations = async (
  req: ModelContextRequest,
  res: Response
): Promise<ControllerResponse<MCPConfiguration[]>> => {
  const requestId = uuidv4();

  try {
    const enabled =
      req.query.enabled === 'true'
        ? true
        : req.query.enabled === 'false'
          ? false
          : undefined;

    let configurations: MCPConfiguration[] = [];
    if (req.storage) {
      configurations = await req.storage.getAllConfigurations();
    } else {
      // Mock configurations for development
      configurations = [
        {
          id: 'mcp_1',
          name: 'OpenAI GPT-4',
          version: '1.0.0',
          enabled: true,
          serverUrl: 'https://api.openai.com/v1',
          models: [
            {
              id: 'gpt-4',
              name: 'GPT-4',
              type: 'text',
              version: '0613',
              status: 'available',
              capabilities: ['completion', 'chat', 'reasoning'],
              parameters: {
                maxTokens: 8192,
                temperature: 0.7,
                topP: 0.9,
                contextWindow: 8192,
              },
              pricing: {
                inputTokens: 0.03,
                outputTokens: 0.06,
                currency: 'USD',
              },
              metadata: {},
            },
          ],
          authentication: {
            type: 'api_key',
            credentials: { api_key: 'sk-...' },
          },
          capabilities: ['completion', 'chat', 'streaming'],
          settings: {
            timeout: 30000,
            retryAttempts: 3,
            batchSize: 10,
            rateLimitRpm: 60,
          },
          metadata: {
            description: 'OpenAI GPT-4 integration for text generation',
            provider: 'OpenAI',
            documentation: 'https://platform.openai.com/docs',
            supportedFormats: ['text', 'json'],
          },
          createdAt: new Date('2024-03-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Filter by enabled status if provided
    if (enabled !== undefined) {
      configurations = configurations.filter(
        config => config.enabled === enabled
      );
    }

    const response: ControllerResponse<MCPConfiguration[]> = {
      success: true,
      data: configurations,
      message: `Retrieved ${configurations.length} MCP configurations`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    aimlLogger.error('Error in getAllConfigurations', { module: 'ModelContextController', operation: 'getAllConfigurations', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MCPConfiguration[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve MCP configurations',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create MCP configuration
 */
export const createConfiguration = async (
  req: ModelContextRequest,
  res: Response
): Promise<ControllerResponse<MCPConfiguration>> => {
  const requestId = uuidv4();

  try {
    const { name, serverUrl, authentication, settings, metadata } = req.body;

    // Validate required fields
    if (!name || !serverUrl) {
      const errorResponse: ControllerResponse<MCPConfiguration> = {
        success: false,
        error: 'Missing required fields',
        message: 'Name and server URL are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate server URL format
    try {
      new URL(serverUrl);
    } catch {
      const errorResponse: ControllerResponse<MCPConfiguration> = {
        success: false,
        error: 'Invalid server URL',
        message: 'Server URL must be a valid URL',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate authentication type
    const validAuthTypes = ['none', 'api_key', 'oauth', 'jwt'];
    if (authentication && !validAuthTypes.includes(authentication.type)) {
      const errorResponse: ControllerResponse<MCPConfiguration> = {
        success: false,
        error: 'Invalid authentication type',
        message: `Authentication type must be one of: ${validAuthTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create configuration data
    const configData: Partial<MCPConfiguration> = {
      id: `mcp_${uuidv4()}`,
      name,
      version: '1.0.0',
      enabled: false, // Start disabled for safety
      serverUrl,
      models: [],
      authentication: authentication || { type: 'none' },
      capabilities: [],
      settings: {
        timeout: 30000,
        retryAttempts: 3,
        batchSize: 10,
        rateLimitRpm: 60,
        ...settings,
      },
      metadata: metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Validate configuration if service is available
    let isValid = true;
    if (req.mcpService) {
      isValid = await req.mcpService.validateConfiguration(configData);
    }

    if (!isValid) {
      const errorResponse: ControllerResponse<MCPConfiguration> = {
        success: false,
        error: 'Configuration validation failed',
        message: 'The MCP configuration failed validation checks',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let configuration: MCPConfiguration;
    if (req.storage) {
      configuration = await req.storage.createConfiguration(configData);
    } else {
      configuration = configData as MCPConfiguration;
    }

    const response: ControllerResponse<MCPConfiguration> = {
      success: true,
      data: configuration,
      message: 'MCP configuration created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    aimlLogger.error('Error in createConfiguration', { module: 'ModelContextController', operation: 'createConfiguration', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MCPConfiguration> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create MCP configuration',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Execute MCP request
 */
export const executeRequest = async (
  req: ModelContextRequest,
  res: Response
): Promise<ControllerResponse<MCPRequest>> => {
  const requestId = uuidv4();

  try {
    const { configId, modelId, requestType, input, parameters, submittedBy } =
      req.body;

    // Validate required fields
    if (!configId || !modelId || !requestType || !input || !submittedBy) {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Config ID, model ID, request type, input, and submitter are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate submitter address
    if (!submittedBy.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Invalid submitter address',
        message: 'Submitter must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate request type
    const validRequestTypes = [
      'completion',
      'chat',
      'embedding',
      'classification',
    ];
    if (!validRequestTypes.includes(requestType)) {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Invalid request type',
        message: `Request type must be one of: ${validRequestTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get configuration
    let config: MCPConfiguration | null = null;
    if (req.storage) {
      config = await req.storage.getConfiguration(configId);
    }

    if (!config) {
      const notFoundResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Configuration not found',
        message: `No MCP configuration found with ID ${configId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (!config.enabled) {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Configuration disabled',
        message: 'MCP configuration is currently disabled',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate model exists in configuration
    const model = config.models.find(m => m.id === modelId);
    if (!model) {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Model not found',
        message: `Model ${modelId} not found in configuration ${configId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(errorResponse);
      return errorResponse;
    }

    if (model.status !== 'available') {
      const errorResponse: ControllerResponse<MCPRequest> = {
        success: false,
        error: 'Model unavailable',
        message: `Model ${modelId} is currently ${model.status}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create request data
    const mcpRequestData: Partial<MCPRequest> = {
      id: `req_${uuidv4()}`,
      configId,
      modelId,
      requestType,
      input,
      parameters: parameters || {},
      submittedBy: submittedBy as EthereumAddress,
      status: 'pending',
      timestamp: new Date(),
    };

    let mcpRequest: MCPRequest;
    if (req.storage) {
      mcpRequest = await req.storage.createRequest(mcpRequestData);
    } else {
      mcpRequest = mcpRequestData as MCPRequest;
    }

    // Execute request asynchronously
    if (req.mcpService) {
      // Update status to processing
      mcpRequest.status = 'processing';
      if (req.storage) {
        await req.storage.updateRequest(mcpRequest.id, {
          status: 'processing',
        });
      }

      try {
        const startTime = Date.now();
        const response = await req.mcpService.executeRequest(mcpRequest);
        const processingTime = Date.now() - startTime;

        // Update with successful response
        const updates = {
          status: 'completed' as const,
          response,
          processingTime,
          completedAt: new Date(),
          tokensUsed: response.tokensUsed || { input: 0, output: 0, total: 0 },
          cost: response.cost || 0,
        };

        if (req.storage) {
          mcpRequest = await req.storage.updateRequest(mcpRequest.id, updates);
        } else {
          Object.assign(mcpRequest, updates);
        }
      } catch (error) {
        // Update with error
        const updates = {
          status: 'failed' as const,
          errorMessage: (error as Error).message,
          completedAt: new Date(),
        };

        if (req.storage) {
          mcpRequest = await req.storage.updateRequest(mcpRequest.id, updates);
        } else {
          Object.assign(mcpRequest, updates);
        }
      }
    } else {
      // Mock execution for development
      mcpRequest.status = 'completed';
      mcpRequest.response = {
        text: 'Mock response from MCP service',
        model: modelId,
        timestamp: new Date().toISOString(),
      };
      mcpRequest.tokensUsed = { input: 50, output: 100, total: 150 };
      mcpRequest.cost = 0.01;
      mcpRequest.processingTime = 1500;
      mcpRequest.completedAt = new Date();
    }

    const responseData: ControllerResponse<MCPRequest> = {
      success: mcpRequest.status === 'completed',
      data: mcpRequest,
      message:
        mcpRequest.status === 'completed'
          ? 'MCP request executed successfully'
          : `MCP request ${mcpRequest.status}${mcpRequest.errorMessage ? ': ' + mcpRequest.errorMessage : ''}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res
      .status(mcpRequest.status === 'completed' ? 200 : 400)
      .json(responseData);
    return responseData;
  } catch (error) {
    aimlLogger.error('Error in executeRequest', { module: 'ModelContextController', operation: 'executeRequest', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MCPRequest> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to execute MCP request',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get MCP requests
 */
export const getRequests = async (
  req: ModelContextRequest,
  res: Response
): Promise<PaginatedResponse<MCPRequest>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const configId = req.query.configId as string;
    const status = req.query.status as string;

    let requests: MCPRequest[] = [];
    if (req.storage) {
      requests = await req.storage.getRequests(configId, status);
    } else {
      // Mock requests for development
      requests = [
        {
          id: 'req_1',
          configId: 'mcp_1',
          modelId: 'gpt-4',
          requestType: 'completion',
          input: { prompt: 'Analyze weather patterns' },
          submittedBy:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          status: 'completed',
          response: { text: 'Weather analysis complete' },
          tokensUsed: { input: 20, output: 50, total: 70 },
          cost: 0.005,
          processingTime: 1200,
          timestamp: new Date(Date.now() - 3600000),
          completedAt: new Date(Date.now() - 3598800),
        },
      ];
    }

    // Sort by timestamp (most recent first)
    requests.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedRequests = requests.slice(startIndex, endIndex);
    const totalPages = Math.ceil(requests.length / limit);

    const response: PaginatedResponse<MCPRequest> = {
      success: true,
      data: paginatedRequests,
      message: `Retrieved ${paginatedRequests.length} MCP requests`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: requests.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    aimlLogger.error('Error in getRequests', { module: 'ModelContextController', operation: 'getRequests', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<MCPRequest> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve MCP requests',
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
 * Get MCP metrics
 */
export const getMetrics = async (
  req: ModelContextRequest,
  res: Response
): Promise<ControllerResponse<MCPMetrics>> => {
  const requestId = uuidv4();

  try {
    const configId = req.query.configId as string;

    let metrics: MCPMetrics;
    if (req.storage) {
      metrics = await req.storage.getMetrics(configId);
    } else {
      // Mock metrics for development
      metrics = {
        totalRequests: 1250,
        successfulRequests: 1189,
        failedRequests: 61,
        averageResponseTime: 1450,
        totalTokensUsed: 125000,
        totalCost: 42.75,
        uptime: 99.2,
        errorRate: 4.9,
        requestsPerMinute: 12.5,
        lastUpdated: new Date(),
      };
    }

    const response: ControllerResponse<MCPMetrics> = {
      success: true,
      data: metrics,
      message: 'MCP metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    aimlLogger.error('Error in getMetrics', { module: 'ModelContextController', operation: 'getMetrics', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MCPMetrics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve MCP metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getAllConfigurations,
  createConfiguration,
  executeRequest,
  getRequests,
  getMetrics,
};
