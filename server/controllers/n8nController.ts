/**
 * n8n Integration Controller - TypeScript Implementation
 * Handles n8n workflow automation and integration management
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import { EthereumAddress } from '../../shared/types/security-types.js';
import { appLogger } from '../utils/logger.js';

// n8n integration interfaces
interface N8NWorkflow {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  tags: string[];
  nodes: N8NNode[];
  connections: Record<string, any>;
  settings: {
    executionOrder: 'v0' | 'v1';
    saveManualExecutions: boolean;
    callerPolicy: 'workflowsFromSameOwner' | 'workflowsFromAList' | 'any';
    timezone: string;
  };
  staticData?: Record<string, any>;
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  lastExecution?: Date;
  executionCount: number;
}

interface N8NNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, any>;
  credentials?: Record<string, string>;
  disabled?: boolean;
  notes?: string;
}

interface N8NExecution {
  id: string;
  workflowId: string;
  mode: 'manual' | 'trigger' | 'webhook' | 'retry';
  status: 'running' | 'success' | 'error' | 'canceled' | 'waiting';
  startedAt: Date;
  finishedAt?: Date;
  executionTime?: number; // milliseconds
  data?: {
    resultData: Record<string, any>;
    executionData?: Record<string, any>;
  };
  error?: {
    message: string;
    stack?: string;
    node?: string;
  };
  triggeredBy?: EthereumAddress;
}

interface N8NConnection {
  id: string;
  name: string;
  url: string;
  status: 'connected' | 'disconnected' | 'error';
  version?: string;
  authentication: {
    type: 'none' | 'basic' | 'header' | 'oauth2';
    credentials?: Record<string, string>;
  };
  lastHealthCheck: Date;
  metrics: {
    totalWorkflows: number;
    activeWorkflows: number;
    totalExecutions: number;
    averageExecutionTime: number;
    successRate: number;
  };
  settings: {
    timeout: number;
    retryAttempts: number;
    webhookUrl?: string;
  };
}

interface WorkflowTrigger {
  workflowId: string;
  triggerType: 'manual' | 'webhook' | 'cron' | 'blockchain_event';
  parameters: Record<string, any>;
  triggeredBy: EthereumAddress;
  metadata?: Record<string, any>;
}

// Enhanced request interface
interface N8NRequest extends Request {
  storage?: {
    getAllWorkflows: () => Promise<N8NWorkflow[]>;
    getWorkflow: (id: string) => Promise<N8NWorkflow | null>;
    createWorkflow: (workflow: Partial<N8NWorkflow>) => Promise<N8NWorkflow>;
    updateWorkflow: (
      id: string,
      updates: Partial<N8NWorkflow>
    ) => Promise<N8NWorkflow>;
    deleteWorkflow: (id: string) => Promise<boolean>;
    getExecutions: (
      workflowId?: string,
      limit?: number
    ) => Promise<N8NExecution[]>;
    createExecution: (
      execution: Partial<N8NExecution>
    ) => Promise<N8NExecution>;
    getConnection: () => Promise<N8NConnection | null>;
    updateConnection: (
      updates: Partial<N8NConnection>
    ) => Promise<N8NConnection>;
  };
  n8nService?: {
    testConnection: () => Promise<boolean>;
    executeWorkflow: (workflowId: string, data?: any) => Promise<any>;
    getWorkflowStatus: (workflowId: string) => Promise<string>;
    activateWorkflow: (workflowId: string) => Promise<boolean>;
    deactivateWorkflow: (workflowId: string) => Promise<boolean>;
    syncWorkflows: () => Promise<N8NWorkflow[]>;
  };
}

/**
 * Get n8n connection status
 */
export const getConnectionStatus = async (
  req: N8NRequest,
  res: Response
): Promise<ControllerResponse<N8NConnection>> => {
  const requestId = uuidv4();

  try {
    let connection: N8NConnection | null = null;
    if (req.storage) {
      connection = await req.storage.getConnection();
    }

    if (!connection) {
      // Create default connection if none exists
      connection = {
        id: 'n8n_default',
        name: 'Default n8n Instance',
        url: process.env.N8N_URL || 'http://localhost:5678',
        status: 'disconnected',
        authentication: { type: 'none' },
        lastHealthCheck: new Date(),
        metrics: {
          totalWorkflows: 0,
          activeWorkflows: 0,
          totalExecutions: 0,
          averageExecutionTime: 0,
          successRate: 100,
        },
        settings: {
          timeout: 30000,
          retryAttempts: 3,
        },
      };
    }

    // Test connection if service is available
    if (req.n8nService) {
      const isConnected = await req.n8nService.testConnection();
      connection.status = isConnected ? 'connected' : 'disconnected';
      connection.lastHealthCheck = new Date();

      if (req.storage) {
        connection = await req.storage.updateConnection({
          status: connection.status,
          lastHealthCheck: connection.lastHealthCheck,
        });
      }
    } else {
      // Mock connection status for development
      connection.status = 'connected';
      connection.version = '1.0.0';
      connection.metrics = {
        totalWorkflows: 12,
        activeWorkflows: 8,
        totalExecutions: 1456,
        averageExecutionTime: 2340,
        successRate: 96.8,
      };
    }

    const response: ControllerResponse<N8NConnection> = {
      success: true,
      data: connection,
      message: 'n8n connection status retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in getConnectionStatus', { module: 'N8NController', operation: 'getConnectionStatus', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<N8NConnection> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve n8n connection status',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get all n8n workflows
 */
export const getAllWorkflows = async (
  req: N8NRequest,
  res: Response
): Promise<PaginatedResponse<N8NWorkflow>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const active =
      req.query.active === 'true'
        ? true
        : req.query.active === 'false'
          ? false
          : undefined;
    const tag = req.query.tag as string;

    let workflows: N8NWorkflow[] = [];
    if (req.storage) {
      workflows = await req.storage.getAllWorkflows();
    } else if (req.n8nService) {
      workflows = await req.n8nService.syncWorkflows();
    } else {
      // Mock workflows for development
      workflows = [
        {
          id: 'workflow_1',
          name: 'Weather Data Processing',
          description:
            'Processes incoming weather data and stores it on blockchain',
          active: true,
          tags: ['weather', 'blockchain', 'data-processing'],
          nodes: [
            {
              id: 'webhook',
              name: 'Weather Webhook',
              type: 'n8n-nodes-base.webhook',
              typeVersion: 1,
              position: [240, 300],
              parameters: { httpMethod: 'POST', path: 'weather-data' },
            },
            {
              id: 'process',
              name: 'Process Data',
              type: 'n8n-nodes-base.function',
              typeVersion: 1,
              position: [460, 300],
              parameters: {
                functionCode:
                  'return items.map(item => ({ ...item, processed: true }))',
              },
            },
          ],
          connections: {
            webhook: { main: [[{ node: 'process', type: 'main', index: 0 }]] },
          },
          settings: {
            executionOrder: 'v1',
            saveManualExecutions: true,
            callerPolicy: 'workflowsFromSameOwner',
            timezone: 'UTC',
          },
          createdAt: new Date('2024-03-01'),
          updatedAt: new Date(),
          lastExecution: new Date(Date.now() - 3600000),
          executionCount: 156,
        },
        {
          id: 'workflow_2',
          name: 'NFT Metadata Generator',
          description:
            'Automatically generates metadata for computational NFTs',
          active: false,
          tags: ['nft', 'metadata', 'automation'],
          nodes: [
            {
              id: 'trigger',
              name: 'Manual Trigger',
              type: 'n8n-nodes-base.manualTrigger',
              typeVersion: 1,
              position: [240, 300],
              parameters: {},
            },
          ],
          connections: {},
          settings: {
            executionOrder: 'v1',
            saveManualExecutions: false,
            callerPolicy: 'any',
            timezone: 'UTC',
          },
          createdAt: new Date('2024-04-15'),
          updatedAt: new Date(),
          executionCount: 42,
        },
      ];
    }

    // Apply filters
    if (active !== undefined) {
      workflows = workflows.filter(workflow => workflow.active === active);
    }
    if (tag) {
      workflows = workflows.filter(workflow => workflow.tags.includes(tag));
    }

    // Sort by last execution (most recent first)
    workflows.sort((a, b) => {
      const aTime = a.lastExecution?.getTime() || 0;
      const bTime = b.lastExecution?.getTime() || 0;
      return bTime - aTime;
    });

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedWorkflows = workflows.slice(startIndex, endIndex);
    const totalPages = Math.ceil(workflows.length / limit);

    const response: PaginatedResponse<N8NWorkflow> = {
      success: true,
      data: paginatedWorkflows,
      message: `Retrieved ${paginatedWorkflows.length} n8n workflows`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: workflows.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in getAllWorkflows', { module: 'N8NController', operation: 'getAllWorkflows', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<N8NWorkflow> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve n8n workflows',
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
 * Execute n8n workflow
 */
export const executeWorkflow = async (
  req: N8NRequest,
  res: Response
): Promise<ControllerResponse<N8NExecution>> => {
  const requestId = uuidv4();

  try {
    const workflowId = req.params.workflowId;
    const { triggeredBy } = req.body;
    const data = req.body.data;

    if (!workflowId) {
      const errorResponse: ControllerResponse<N8NExecution> = {
        success: false,
        error: 'Workflow ID is required',
        message: 'Please provide a valid workflow ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate triggered by address if provided
    if (triggeredBy && !triggeredBy.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<N8NExecution> = {
        success: false,
        error: 'Invalid address format',
        message: 'Triggered by must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get workflow
    let workflow: N8NWorkflow | null = null;
    if (req.storage) {
      workflow = await req.storage.getWorkflow(workflowId);
    }

    if (!workflow) {
      const notFoundResponse: ControllerResponse<N8NExecution> = {
        success: false,
        error: 'Workflow not found',
        message: `No workflow found with ID ${workflowId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (!workflow.active) {
      const errorResponse: ControllerResponse<N8NExecution> = {
        success: false,
        error: 'Workflow inactive',
        message: 'Cannot execute inactive workflow',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create execution record
    const executionData: Partial<N8NExecution> = {
      id: `exec_${uuidv4()}`,
      workflowId,
      mode: 'manual',
      status: 'running',
      startedAt: new Date(),
      triggeredBy: triggeredBy as EthereumAddress,
    };

    let execution: N8NExecution;
    if (req.storage) {
      execution = await req.storage.createExecution(executionData);
    } else {
      execution = executionData as N8NExecution;
    }

    // Execute workflow
    let executionResult: any;
    let success = true;
    const startTime = Date.now();

    try {
      if (req.n8nService) {
        executionResult = await req.n8nService.executeWorkflow(
          workflowId,
          data
        );
      } else {
        // Mock execution for development
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate processing time
        executionResult = {
          success: true,
          data: { processed: true, timestamp: new Date().toISOString() },
          message: 'Workflow executed successfully',
        };
      }
    } catch (error) {
      success = false;
      executionResult = {
        error: (error as Error).message,
        stack: (error as Error).stack,
      };
    }

    const executionTime = Date.now() - startTime;

    // Update execution with results
    const updates = {
      status: success ? ('success' as const) : ('error' as const),
      finishedAt: new Date(),
      executionTime,
      data: success ? { resultData: executionResult } : undefined,
      error: success
        ? undefined
        : {
            message: executionResult.error,
            stack: executionResult.stack,
          },
    };

    if (req.storage) {
      execution = await req.storage.createExecution({
        ...execution,
        ...updates,
      });

      // Update workflow execution count and last execution
      await req.storage.updateWorkflow(workflowId, {
        executionCount: workflow.executionCount + 1,
        lastExecution: new Date(),
        updatedAt: new Date(),
      });
    } else {
      Object.assign(execution, updates);
    }

    const response: ControllerResponse<N8NExecution> = {
      success,
      data: execution,
      message: success
        ? 'Workflow executed successfully'
        : 'Workflow execution failed',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(success ? 200 : 400).json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in executeWorkflow', { module: 'N8NController', operation: 'executeWorkflow', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<N8NExecution> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to execute workflow',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get workflow executions
 */
export const getExecutions = async (
  req: N8NRequest,
  res: Response
): Promise<PaginatedResponse<N8NExecution>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const workflowId = req.query.workflowId as string;
    const status = req.query.status as string;

    let executions: N8NExecution[] = [];
    if (req.storage) {
      executions = await req.storage.getExecutions(workflowId, limit);
    } else {
      // Mock executions for development
      executions = [
        {
          id: 'exec_1',
          workflowId: 'workflow_1',
          mode: 'webhook',
          status: 'success',
          startedAt: new Date(Date.now() - 3600000),
          finishedAt: new Date(Date.now() - 3598000),
          executionTime: 2000,
          data: {
            resultData: { processed: true, items: 5 },
          },
          triggeredBy:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
        },
        {
          id: 'exec_2',
          workflowId: 'workflow_1',
          mode: 'manual',
          status: 'error',
          startedAt: new Date(Date.now() - 7200000),
          finishedAt: new Date(Date.now() - 7198000),
          executionTime: 2000,
          error: {
            message: 'Node execution failed',
            node: 'process',
          },
          triggeredBy:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
        },
      ];
    }

    // Filter by status if provided
    if (status) {
      executions = executions.filter(exec => exec.status === status);
    }

    // Sort by start time (most recent first)
    executions.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedExecutions = executions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(executions.length / limit);

    const response: PaginatedResponse<N8NExecution> = {
      success: true,
      data: paginatedExecutions,
      message: `Retrieved ${paginatedExecutions.length} workflow executions`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: executions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in getExecutions', { module: 'N8NController', operation: 'getExecutions', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<N8NExecution> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve workflow executions',
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
 * Toggle workflow active status
 */
export const toggleWorkflow = async (
  req: N8NRequest,
  res: Response
): Promise<ControllerResponse<N8NWorkflow>> => {
  const requestId = uuidv4();

  try {
    const workflowId = req.params.workflowId;
    const { active } = req.body;

    if (!workflowId) {
      const errorResponse: ControllerResponse<N8NWorkflow> = {
        success: false,
        error: 'Workflow ID is required',
        message: 'Please provide a valid workflow ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (typeof active !== 'boolean') {
      const errorResponse: ControllerResponse<N8NWorkflow> = {
        success: false,
        error: 'Invalid active status',
        message: 'Active status must be a boolean value',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get workflow
    let workflow: N8NWorkflow | null = null;
    if (req.storage) {
      workflow = await req.storage.getWorkflow(workflowId);
    }

    if (!workflow) {
      const notFoundResponse: ControllerResponse<N8NWorkflow> = {
        success: false,
        error: 'Workflow not found',
        message: `No workflow found with ID ${workflowId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Toggle workflow in n8n if service is available
    let toggleSuccess = true;
    if (req.n8nService) {
      if (active) {
        toggleSuccess = await req.n8nService.activateWorkflow(workflowId);
      } else {
        toggleSuccess = await req.n8nService.deactivateWorkflow(workflowId);
      }
    }

    if (!toggleSuccess) {
      const errorResponse: ControllerResponse<N8NWorkflow> = {
        success: false,
        error: 'Toggle operation failed',
        message: 'Failed to toggle workflow status in n8n',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(500).json(errorResponse);
      return errorResponse;
    }

    // Update workflow status
    let updatedWorkflow: N8NWorkflow;
    if (req.storage) {
      updatedWorkflow = await req.storage.updateWorkflow(workflowId, {
        active,
        updatedAt: new Date(),
      });
    } else {
      updatedWorkflow = { ...workflow, active, updatedAt: new Date() };
    }

    const response: ControllerResponse<N8NWorkflow> = {
      success: true,
      data: updatedWorkflow,
      message: `Workflow ${active ? 'activated' : 'deactivated'} successfully`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in toggleWorkflow', { module: 'N8NController', operation: 'toggleWorkflow', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<N8NWorkflow> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to toggle workflow status',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getConnectionStatus,
  getAllWorkflows,
  executeWorkflow,
  getExecutions,
  toggleWorkflow,
};
