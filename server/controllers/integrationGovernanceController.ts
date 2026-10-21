/**
 * Integration Governance Controller - TypeScript Implementation
 * Handles governance operations for external integrations and API management
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
import { governanceLogger } from '../utils/logger.js';

// Integration Governance interfaces
interface IntegrationProposal {
  id: string;
  title: string;
  description: string;
  proposer: EthereumAddress;
  type:
    | 'api_integration'
    | 'service_addition'
    | 'configuration_change'
    | 'deprecation'
    | 'security_update';
  integration: {
    name: string;
    provider: string;
    endpoint: string;
    version: string;
    documentation?: string;
  };
  requirements: {
    apiKey: boolean;
    authentication: string;
    rateLimit: number;
    cost: PositiveNumber;
    maintenance: string;
  };
  impact: {
    affectedServices: string[];
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    downtime: number; // minutes
    rollbackPlan: string;
  };
  voting: {
    required: number;
    received: number;
    deadline: Date;
    quorum: number;
  };
  status:
    | 'draft'
    | 'review'
    | 'voting'
    | 'approved'
    | 'rejected'
    | 'implemented'
    | 'cancelled';
  votes: Vote[];
  createdAt: Date;
  updatedAt: Date;
  implementedAt?: Date;
}

interface Vote {
  id: string;
  voter: EthereumAddress;
  decision: 'approve' | 'reject' | 'abstain';
  weight: number;
  reason?: string;
  timestamp: Date;
}

interface Integration {
  id: string;
  name: string;
  provider: string;
  category:
    | 'weather'
    | 'blockchain'
    | 'ai'
    | 'storage'
    | 'compute'
    | 'data'
    | 'other';
  status: 'active' | 'inactive' | 'deprecated' | 'maintenance';
  configuration: {
    endpoint: string;
    version: string;
    authentication: string;
    rateLimit: number;
    timeout: number;
  };
  governance: {
    approvalProposal: string;
    lastReview: Date;
    nextReview: Date;
    maintainer: EthereumAddress;
  };
  metrics: {
    uptime: number; // percentage
    totalRequests: number;
    avgResponseTime: number; // ms
    errorRate: number; // percentage
    cost: PositiveNumber;
  };
  dependencies: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface GovernanceConfig {
  id: string;
  votingPeriod: number; // hours
  quorumThreshold: number; // percentage
  approvalThreshold: number; // percentage
  proposalDeposit: PositiveNumber;
  reviewers: EthereumAddress[];
  emergencyCommittee: EthereumAddress[];
  settings: {
    allowPublicProposals: boolean;
    requireTechnicalReview: boolean;
    mandatorySecurityAudit: boolean;
    cooldownPeriod: number; // hours
  };
  updatedAt: Date;
}

// Enhanced request interface
interface IntegrationGovernanceRequest extends Request {
  storage?: {
    getAllProposals: () => Promise<IntegrationProposal[]>;
    getProposal: (id: string) => Promise<IntegrationProposal | null>;
    createProposal: (
      proposal: Partial<IntegrationProposal>
    ) => Promise<IntegrationProposal>;
    updateProposal: (
      id: string,
      updates: Partial<IntegrationProposal>
    ) => Promise<IntegrationProposal>;
    getAllIntegrations: () => Promise<Integration[]>;
    getIntegration: (id: string) => Promise<Integration | null>;
    createIntegration: (
      integration: Partial<Integration>
    ) => Promise<Integration>;
    getGovernanceConfig: () => Promise<GovernanceConfig>;
    updateGovernanceConfig: (
      config: Partial<GovernanceConfig>
    ) => Promise<GovernanceConfig>;
    castVote: (proposalId: string, vote: Partial<Vote>) => Promise<Vote>;
  };
  governanceService?: {
    validateProposal: (proposal: IntegrationProposal) => Promise<boolean>;
    executeProposal: (proposalId: string) => Promise<boolean>;
    checkVotingEligibility: (voter: EthereumAddress) => Promise<boolean>;
    calculateVotingWeight: (voter: EthereumAddress) => Promise<number>;
  };
}

/**
 * Get all integration proposals
 */
export const getAllProposals = async (
  req: IntegrationGovernanceRequest,
  res: Response
): Promise<PaginatedResponse<IntegrationProposal>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const status = req.query.status as string;
    const type = req.query.type as string;
    const proposer = req.query.proposer as string;

    let proposals: IntegrationProposal[] = [];
    if (req.storage) {
      proposals = await req.storage.getAllProposals();
    } else {
      // Mock proposals for development
      proposals = [
        {
          id: 'proposal_1',
          title: 'Add OpenWeatherMap API Integration',
          description:
            'Proposal to integrate OpenWeatherMap API for enhanced weather data coverage',
          proposer:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          type: 'api_integration',
          integration: {
            name: 'OpenWeatherMap',
            provider: 'OpenWeather Ltd.',
            endpoint: 'https://api.openweathermap.org/data/2.5',
            version: '2.5',
            documentation: 'https://openweathermap.org/api',
          },
          requirements: {
            apiKey: true,
            authentication: 'API Key',
            rateLimit: 1000,
            cost: 50 as PositiveNumber,
            maintenance: 'Monthly API key rotation',
          },
          impact: {
            affectedServices: ['weather-api', 'data-collector'],
            riskLevel: 'low',
            downtime: 5,
            rollbackPlan:
              'Disable integration and revert to previous data sources',
          },
          voting: {
            required: 10,
            received: 7,
            deadline: new Date(Date.now() + 86400000),
            quorum: 8,
          },
          status: 'voting',
          votes: [
            {
              id: 'vote_1',
              voter:
                '0x2345678901234567890123456789012345678901' as EthereumAddress,
              decision: 'approve',
              weight: 2,
              reason: 'Enhances data quality and coverage',
              timestamp: new Date(Date.now() - 3600000),
            },
          ],
          createdAt: new Date(Date.now() - 172800000),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (status) {
      proposals = proposals.filter(proposal => proposal.status === status);
    }
    if (type) {
      proposals = proposals.filter(proposal => proposal.type === type);
    }
    if (proposer) {
      proposals = proposals.filter(
        proposal => proposal.proposer.toLowerCase() === proposer.toLowerCase()
      );
    }

    // Sort by creation date (most recent first)
    proposals.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedProposals = proposals.slice(startIndex, endIndex);
    const totalPages = Math.ceil(proposals.length / limit);

    const response: PaginatedResponse<IntegrationProposal> = {
      success: true,
      data: paginatedProposals,
      message: `Retrieved ${paginatedProposals.length} integration proposals`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: proposals.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in getAllProposals', { module: 'IntegrationGovernanceController', operation: 'getAllProposals', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<IntegrationProposal> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve integration proposals',
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
 * Create integration proposal
 */
export const createProposal = async (
  req: IntegrationGovernanceRequest,
  res: Response
): Promise<ControllerResponse<IntegrationProposal>> => {
  const requestId = uuidv4();

  try {
    const {
      title,
      description,
      proposer,
      type,
      integration,
      requirements,
      impact,
    } = req.body;

    // Validate required fields
    if (
      !title ||
      !description ||
      !proposer ||
      !type ||
      !integration ||
      !requirements ||
      !impact
    ) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Missing required fields',
        message:
          'All proposal fields (title, description, proposer, type, integration, requirements, impact) are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate proposer address
    if (!proposer.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Invalid proposer address',
        message: 'Proposer must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate proposal type
    const validTypes = [
      'api_integration',
      'service_addition',
      'configuration_change',
      'deprecation',
      'security_update',
    ];
    if (!validTypes.includes(type)) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Invalid proposal type',
        message: `Proposal type must be one of: ${validTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate integration details
    if (!integration.name || !integration.provider || !integration.endpoint) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Invalid integration details',
        message: 'Integration must include name, provider, and endpoint',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate risk level
    const validRiskLevels = ['low', 'medium', 'high', 'critical'];
    if (!validRiskLevels.includes(impact.riskLevel)) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Invalid risk level',
        message: `Risk level must be one of: ${validRiskLevels.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get governance configuration for voting parameters
    let governanceConfig: GovernanceConfig | null = null;
    if (req.storage) {
      governanceConfig = await req.storage.getGovernanceConfig();
    }

    const votingPeriod = governanceConfig?.votingPeriod || 72; // hours
    const quorum = governanceConfig?.quorumThreshold || 50; // percentage

    // Create proposal data
    const proposalData: Partial<IntegrationProposal> = {
      id: `proposal_${uuidv4()}`,
      title,
      description,
      proposer: proposer as EthereumAddress,
      type,
      integration,
      requirements,
      impact,
      voting: {
        required: Math.ceil((quorum / 100) * 20), // Assume 20 total voters
        received: 0,
        deadline: new Date(Date.now() + votingPeriod * 60 * 60 * 1000),
        quorum: Math.ceil((quorum / 100) * 20),
      },
      status: 'draft',
      votes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Validate proposal if service is available
    let isValid = true;
    if (req.governanceService) {
      isValid = await req.governanceService.validateProposal(
        proposalData as IntegrationProposal
      );
    }

    if (!isValid) {
      const errorResponse: ControllerResponse<IntegrationProposal> = {
        success: false,
        error: 'Proposal validation failed',
        message: 'The proposal failed validation checks',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let proposal: IntegrationProposal;
    if (req.storage) {
      proposal = await req.storage.createProposal(proposalData);
    } else {
      proposal = proposalData as IntegrationProposal;
    }

    // Move to review status
    proposal.status = 'review';

    const response: ControllerResponse<IntegrationProposal> = {
      success: true,
      data: proposal,
      message: 'Integration proposal created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in createProposal', { module: 'IntegrationGovernanceController', operation: 'createProposal', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<IntegrationProposal> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create integration proposal',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Cast vote on proposal
 */
export const castVote = async (
  req: IntegrationGovernanceRequest,
  res: Response
): Promise<ControllerResponse<Vote>> => {
  const requestId = uuidv4();

  try {
    const proposalId = req.params.proposalId;
    const { voter, decision, reason } = req.body;

    // Validate required fields
    if (!proposalId || !voter || !decision) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Missing required fields',
        message: 'Proposal ID, voter address, and decision are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate voter address
    if (!voter.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Invalid voter address',
        message: 'Voter must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate decision
    const validDecisions = ['approve', 'reject', 'abstain'];
    if (!validDecisions.includes(decision)) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Invalid decision',
        message: `Decision must be one of: ${validDecisions.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get proposal
    let proposal: IntegrationProposal | null = null;
    if (req.storage) {
      proposal = await req.storage.getProposal(proposalId);
    }

    if (!proposal) {
      const notFoundResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Proposal not found',
        message: `No proposal found with ID ${proposalId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (proposal.status !== 'voting') {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Proposal not in voting phase',
        message: 'Can only vote on proposals in voting status',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (new Date() > proposal.voting.deadline) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Voting period ended',
        message: 'The voting period for this proposal has expired',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Check if voter has already voted
    const existingVote = proposal.votes.find(vote => vote.voter === voter);
    if (existingVote) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Already voted',
        message: 'Voter has already cast a vote on this proposal',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(409).json(errorResponse);
      return errorResponse;
    }

    // Check voting eligibility
    let isEligible = true;
    let votingWeight = 1;

    if (req.governanceService) {
      isEligible = await req.governanceService.checkVotingEligibility(
        voter as EthereumAddress
      );
      if (isEligible) {
        votingWeight = await req.governanceService.calculateVotingWeight(
          voter as EthereumAddress
        );
      }
    }

    if (!isEligible) {
      const errorResponse: ControllerResponse<Vote> = {
        success: false,
        error: 'Voting not eligible',
        message: 'Voter is not eligible to vote on this proposal',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(403).json(errorResponse);
      return errorResponse;
    }

    // Create vote
    const voteData: Partial<Vote> = {
      id: `vote_${uuidv4()}`,
      voter: voter as EthereumAddress,
      decision,
      weight: votingWeight,
      reason,
      timestamp: new Date(),
    };

    let vote: Vote;
    if (req.storage) {
      vote = await req.storage.castVote(proposalId, voteData);
    } else {
      vote = voteData as Vote;
    }

    // Update proposal vote count
    proposal.voting.received += votingWeight;
    proposal.votes.push(vote);

    // Check if voting is complete
    if (proposal.voting.received >= proposal.voting.quorum) {
      const approveVotes = proposal.votes
        .filter(v => v.decision === 'approve')
        .reduce((sum, v) => sum + v.weight, 0);

      const totalVotes = proposal.voting.received;
      const approvalRate = (approveVotes / totalVotes) * 100;

      if (approvalRate >= 60) {
        // 60% approval threshold
        proposal.status = 'approved';
      } else {
        proposal.status = 'rejected';
      }
    }

    // Update proposal
    if (req.storage) {
      await req.storage.updateProposal(proposalId, {
        voting: proposal.voting,
        votes: proposal.votes,
        status: proposal.status,
        updatedAt: new Date(),
      });
    }

    const response: ControllerResponse<Vote> = {
      success: true,
      data: vote,
      message: 'Vote cast successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in castVote', { module: 'IntegrationGovernanceController', operation: 'castVote', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<Vote> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to cast vote',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get all integrations
 */
export const getAllIntegrations = async (
  req: IntegrationGovernanceRequest,
  res: Response
): Promise<PaginatedResponse<Integration>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const category = req.query.category as string;
    const status = req.query.status as string;

    let integrations: Integration[] = [];
    if (req.storage) {
      integrations = await req.storage.getAllIntegrations();
    } else {
      // Mock integrations for development
      integrations = [
        {
          id: 'integration_1',
          name: 'WeatherAPI',
          provider: 'WeatherAPI.com',
          category: 'weather',
          status: 'active',
          configuration: {
            endpoint: 'https://api.weatherapi.com/v1',
            version: '1.0',
            authentication: 'API Key',
            rateLimit: 1000000,
            timeout: 30000,
          },
          governance: {
            approvalProposal: 'proposal_weather_api_2024',
            lastReview: new Date(Date.now() - 86400000 * 30),
            nextReview: new Date(Date.now() + 86400000 * 60),
            maintainer:
              '0x1234567890123456789012345678901234567890' as EthereumAddress,
          },
          metrics: {
            uptime: 99.9,
            totalRequests: 1500000,
            avgResponseTime: 245,
            errorRate: 0.1,
            cost: 450 as PositiveNumber,
          },
          dependencies: ['http-client', 'rate-limiter'],
          createdAt: new Date('2024-01-15'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (category) {
      integrations = integrations.filter(
        integration => integration.category === category
      );
    }
    if (status) {
      integrations = integrations.filter(
        integration => integration.status === status
      );
    }

    // Sort by name
    integrations.sort((a, b) => a.name.localeCompare(b.name));

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedIntegrations = integrations.slice(startIndex, endIndex);
    const totalPages = Math.ceil(integrations.length / limit);

    const response: PaginatedResponse<Integration> = {
      success: true,
      data: paginatedIntegrations,
      message: `Retrieved ${paginatedIntegrations.length} integrations`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: integrations.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in getAllIntegrations', { module: 'IntegrationGovernanceController', operation: 'getAllIntegrations', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<Integration> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve integrations',
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
 * Get governance configuration
 */
export const getGovernanceConfig = async (
  req: IntegrationGovernanceRequest,
  res: Response
): Promise<ControllerResponse<GovernanceConfig>> => {
  const requestId = uuidv4();

  try {
    let config: GovernanceConfig;
    if (req.storage) {
      config = await req.storage.getGovernanceConfig();
    } else {
      // Mock configuration for development
      config = {
        id: 'governance_config',
        votingPeriod: 72,
        quorumThreshold: 50,
        approvalThreshold: 60,
        proposalDeposit: 100 as PositiveNumber,
        reviewers: [
          '0x1234567890123456789012345678901234567890' as EthereumAddress,
          '0x2345678901234567890123456789012345678901' as EthereumAddress,
        ],
        emergencyCommittee: [
          '0x3456789012345678901234567890123456789012' as EthereumAddress,
        ],
        settings: {
          allowPublicProposals: true,
          requireTechnicalReview: true,
          mandatorySecurityAudit: false,
          cooldownPeriod: 24,
        },
        updatedAt: new Date(),
      };
    }

    const response: ControllerResponse<GovernanceConfig> = {
      success: true,
      data: config,
      message: 'Governance configuration retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in getGovernanceConfig', { module: 'IntegrationGovernanceController', operation: 'getGovernanceConfig', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<GovernanceConfig> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve governance configuration',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getAllProposals,
  createProposal,
  castVote,
  getAllIntegrations,
  getGovernanceConfig,
};
