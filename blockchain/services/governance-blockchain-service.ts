/**
 * Governance Blockchain Service
 * Provides real blockchain queries for governance analytics data
 * Replaces mock data in governance-analytics.js with actual smart contract queries
 */

import { ethers } from 'ethers';
import { smartContractService } from './smart-contract-service.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/governance-blockchain.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Types for governance data
export interface GovernanceStats {
  proposalCount: bigint;
  activeProposals: bigint;
  totalProposalsPassed: bigint;
  totalProposalsExecuted: bigint;
  treasuryBalance: bigint;
  totalStakeParticipating: bigint;
}

export interface ProposalData {
  proposer: string;
  proposalType: number;
  title: string;
  description: string;
  status: number;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  startTime: bigint;
  endTime: bigint;
  executionTime: bigint;
}

export interface VoterData {
  votingPower: bigint;
  delegatedPower: bigint;
  totalVotesCast: bigint;
  proposalsCreated: bigint;
  proposalsPassed: bigint;
  governanceScore: bigint;
  lastVoteTime: bigint;
  isDelegate: boolean;
}

export interface VotingParticipationResult {
  totalTokenHolders: number;
  activeVoters: number;
  delegatedVoters: number;
  participationRate: string;
  totalStakeParticipating: string;
  lastUpdated: string;
}

export interface ProposalSuccessRates {
  total: number;
  passed: number;
  executed: number;
  active: number;
  successRate: string;
  executionRate: string;
  lastUpdated: string;
}

export interface TreasuryUtilization {
  totalBalance: string;
  balanceWei: string;
  lastUpdated: string;
}

// Contract addresses - should come from config in production
const GOVERNANCE_CONTRACT_ADDRESS = process.env.GOVERNANCE_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000';

// CommunityGovernance ABI (minimal for the functions we need)
const GOVERNANCE_ABI = [
  'function getGovernanceStats() external view returns (uint256 proposalCount, uint256 activeProposals, uint256 totalProposalsPassed, uint256 totalProposalsExecuted, uint256 treasuryBalance, uint256 totalStakeParticipating)',
  'function getProposal(uint256 proposalId) external view returns (address proposer, uint8 proposalType, string title, string description, uint8 status, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 startTime, uint256 endTime, uint256 executionTime)',
  'function getVoter(address voter) external view returns (tuple(uint256 votingPower, uint256 delegatedPower, uint256 totalVotesCast, uint256 proposalsCreated, uint256 proposalsPassed, uint256 governanceScore, uint256 lastVoteTime, bool isDelegate))',
  'function getCurrentVotingPower(address voter) external view returns (uint256)',
  'function proposalCount() external view returns (uint256)',
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string title)',
  'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)',
  'event ProposalPassed(uint256 indexed proposalId)',
  'event ProposalExecuted(uint256 indexed proposalId)',
];

export class GovernanceBlockchainService {
  private contractAddress: string;
  private isInitialized: boolean = false;

  constructor(contractAddress?: string) {
    this.contractAddress = contractAddress || GOVERNANCE_CONTRACT_ADDRESS;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Register the ABI with SmartContractService
      await smartContractService.registerContractABI(this.contractAddress, GOVERNANCE_ABI as any[]);
      this.isInitialized = true;
      logger.info('GovernanceBlockchainService initialized', { contractAddress: this.contractAddress });
    } catch (error) {
      logger.error('Failed to initialize GovernanceBlockchainService', { error });
      throw error;
    }
  }

  async getGovernanceStats(): Promise<GovernanceStats> {
    await this.initialize();

    try {
      const result = await smartContractService.callContract({
        contractAddress: this.contractAddress,
        functionName: 'getGovernanceStats',
        args: [],
        isReadOnly: true,
      });

      const [
        proposalCount,
        activeProposals,
        totalProposalsPassed,
        totalProposalsExecuted,
        treasuryBalance,
        totalStakeParticipating,
      ] = result.result as any[];

      return {
        proposalCount: BigInt(proposalCount),
        activeProposals: BigInt(activeProposals),
        totalProposalsPassed: BigInt(totalProposalsPassed),
        totalProposalsExecuted: BigInt(totalProposalsExecuted),
        treasuryBalance: BigInt(treasuryBalance),
        totalStakeParticipating: BigInt(totalStakeParticipating),
      };
    } catch (error) {
      logger.error('Failed to get governance stats', { error });
      throw error;
    }
  }

  async getProposal(proposalId: number): Promise<ProposalData> {
    await this.initialize();

    try {
      const result = await smartContractService.callContract({
        contractAddress: this.contractAddress,
        functionName: 'getProposal',
        args: [proposalId],
        isReadOnly: true,
      });

      const [
        proposer,
        proposalType,
        title,
        description,
        status,
        forVotes,
        againstVotes,
        abstainVotes,
        startTime,
        endTime,
        executionTime,
      ] = result.result as any[];

      return {
        proposer,
        proposalType: Number(proposalType),
        title,
        description,
        status: Number(status),
        forVotes: BigInt(forVotes),
        againstVotes: BigInt(againstVotes),
        abstainVotes: BigInt(abstainVotes),
        startTime: BigInt(startTime),
        endTime: BigInt(endTime),
        executionTime: BigInt(executionTime),
      };
    } catch (error) {
      logger.error('Failed to get proposal', { proposalId, error });
      throw error;
    }
  }

  async getVoter(address: string): Promise<VoterData> {
    await this.initialize();

    try {
      const result = await smartContractService.callContract({
        contractAddress: this.contractAddress,
        functionName: 'getVoter',
        args: [address],
        isReadOnly: true,
      });

      const voter = result.result as any;
      return {
        votingPower: BigInt(voter.votingPower),
        delegatedPower: BigInt(voter.delegatedPower),
        totalVotesCast: BigInt(voter.totalVotesCast),
        proposalsCreated: BigInt(voter.proposalsCreated),
        proposalsPassed: BigInt(voter.proposalsPassed),
        governanceScore: BigInt(voter.governanceScore),
        lastVoteTime: BigInt(voter.lastVoteTime),
        isDelegate: voter.isDelegate,
      };
    } catch (error) {
      logger.error('Failed to get voter data', { address, error });
      throw error;
    }
  }

  async getCurrentVotingPower(address: string): Promise<bigint> {
    await this.initialize();

    try {
      const result = await smartContractService.callContract({
        contractAddress: this.contractAddress,
        functionName: 'getCurrentVotingPower',
        args: [address],
        isReadOnly: true,
      });

      return BigInt(result.result as any);
    } catch (error) {
      logger.error('Failed to get voting power', { address, error });
      throw error;
    }
  }

  async getVotingParticipation(): Promise<VotingParticipationResult> {
    try {
      const stats = await this.getGovernanceStats();

      // Calculate participation metrics from on-chain data
      const totalStake = stats.totalStakeParticipating;
      const activeProposals = Number(stats.activeProposals);
      const totalProposals = Number(stats.proposalCount);

      // Estimate participation rate based on stake participation
      // In production, this could be calculated from total token supply
      const participationRate = totalProposals > 0
        ? ((Number(stats.totalProposalsPassed) / totalProposals) * 100).toFixed(2)
        : '0.00';

      return {
        totalTokenHolders: 0, // Would need token holder query
        activeVoters: activeProposals,
        delegatedVoters: 0, // Would need delegation tracking
        participationRate,
        totalStakeParticipating: ethers.formatEther(totalStake),
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to calculate voting participation', { error });
      throw error;
    }
  }

  async getProposalSuccessRates(): Promise<ProposalSuccessRates> {
    try {
      const stats = await this.getGovernanceStats();

      const total = Number(stats.proposalCount);
      const passed = Number(stats.totalProposalsPassed);
      const executed = Number(stats.totalProposalsExecuted);
      const active = Number(stats.activeProposals);

      const successRate = total > 0
        ? ((passed / total) * 100).toFixed(2)
        : '0.00';

      const executionRate = passed > 0
        ? ((executed / passed) * 100).toFixed(2)
        : '0.00';

      return {
        total,
        passed,
        executed,
        active,
        successRate,
        executionRate,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to calculate proposal success rates', { error });
      throw error;
    }
  }

  async getTreasuryUtilization(): Promise<TreasuryUtilization> {
    try {
      const stats = await this.getGovernanceStats();

      return {
        totalBalance: ethers.formatEther(stats.treasuryBalance) + ' WRF',
        balanceWei: stats.treasuryBalance.toString(),
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to get treasury utilization', { error });
      throw error;
    }
  }

  async getProposalHistory(fromBlock: number = 0, toBlock: number | 'latest' = 'latest'): Promise<any[]> {
    await this.initialize();

    try {
      const events = await smartContractService.getContractEvents({
        contractAddress: this.contractAddress,
        eventName: 'ProposalCreated',
        fromBlock,
        toBlock,
      });

      return events.map((event: any) => ({
        proposalId: event.args.proposalId.toString(),
        proposer: event.args.proposer,
        title: event.args.title,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      }));
    } catch (error) {
      logger.error('Failed to get proposal history', { error });
      throw error;
    }
  }

  async getVoteHistory(proposalId?: number, fromBlock: number = 0, toBlock: number | 'latest' = 'latest'): Promise<any[]> {
    await this.initialize();

    try {
      const events = await smartContractService.getContractEvents({
        contractAddress: this.contractAddress,
        eventName: 'VoteCast',
        fromBlock,
        toBlock,
      });

      let filteredEvents = events;
      if (proposalId !== undefined) {
        filteredEvents = events.filter((e: any) => e.args.proposalId.toString() === proposalId.toString());
      }

      return filteredEvents.map((event: any) => ({
        proposalId: event.args.proposalId.toString(),
        voter: event.args.voter,
        support: event.args.support,
        weight: event.args.weight.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      }));
    } catch (error) {
      logger.error('Failed to get vote history', { error });
      throw error;
    }
  }
}

// Export singleton instance
export const governanceBlockchainService = new GovernanceBlockchainService();
