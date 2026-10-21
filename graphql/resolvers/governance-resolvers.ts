/**
 * Governance GraphQL Resolvers
 * Handles governance proposals, voting, and DAO operations
 */

import { ethers } from 'ethers';
import {
  GraphQLContext,
  requireAuth,
  requireVerifiedWallet,
} from '../context.js';
import { logger } from '../../utils/logger.js';
import { formatError } from '../error-handler.js';
import { eq, gte, desc, asc, and, or, sql } from 'drizzle-orm';
import { proposals, votes, parameters, delegations } from '../../shared/schema.js';

export const governanceResolvers = {
  Query: {
    proposal: async (
      _: any,
      { id }: { id: string },
      context: GraphQLContext
    ) => {
      try {
        const proposalId = BigInt(id);

        // Get proposal from smart contract
        const proposalData =
          await context.contracts.wrfGovernor.proposals(proposalId);
        const proposalState =
          await context.contracts.wrfGovernor.state(proposalId);

        // Get from database for additional details
        const proposalRecord = await context.db.query.proposals.findFirst({
          where: eq(proposals.id, parseInt(id)),
        });

        if (!proposalRecord) {
          return null;
        }

        return {
          id,
          proposalId: proposalId.toString(),
          title: proposalRecord.title,
          description: proposalRecord.description,
          proposer: proposalRecord.proposer,
          targets: proposalRecord.targets,
          values: proposalRecord.values,
          calldatas: proposalRecord.calldatas,
          votingType: proposalRecord.votingType,
          votingDelay: proposalRecord.votingDelay,
          votingPeriod: proposalRecord.votingPeriod,
          quorumFraction: proposalRecord.quorumFraction,
          emergencyProposal: proposalRecord.emergencyProposal,
          state: mapProposalState(proposalState),
          startBlock: proposalData[2].toString(), // startBlock
          endBlock: proposalData[3].toString(), // endBlock
          forVotes: proposalData[4].toString(), // forVotes
          againstVotes: proposalData[5].toString(), // againstVotes
          abstainVotes: proposalData[6].toString(), // abstainVotes
          createdAt: proposalRecord.createdAt,
          executedAt: proposalRecord.executedAt,
        };
      } catch (error) {
        logger.error('Error fetching proposal', {
          id,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'PROPOSAL_FETCH_ERROR',
        });
      }
    },

    proposals: async (
      _: any,
      {
        first = 10,
        skip = 0,
        orderBy = 'id',
        orderDirection = 'asc',
        where,
      }: {
        first?: number;
        skip?: number;
        orderBy?: string;
        orderDirection?: string;
        where?: any;
      },
      context: GraphQLContext
    ) => {
      try {
        const queryConditions: any[] = [];

        if (where) {
          if (where.state) {
            queryConditions.push(eq(proposals.state, where.state));
          }

          if (where.proposer) {
            queryConditions.push(
              eq(proposals.proposer, where.proposer.toLowerCase())
            );
          }

          if (where.votingType) {
            queryConditions.push(eq(proposals.votingType, where.votingType));
          }

          if (where.emergencyProposal !== undefined) {
            queryConditions.push(
              eq(proposals.emergencyProposal, where.emergencyProposal)
            );
          }
        }

        const whereClause =
          queryConditions.length > 0 ? and(...queryConditions) : undefined;

        const proposalsList = await context.db.query.proposals.findMany({
          where: whereClause,
          limit: Math.min(first, 100),
          offset: skip,
          orderBy:
            orderDirection === 'desc'
              ? desc(proposals.createdAt)
              : asc(proposals.createdAt),
        });

        return proposalsList.map(proposal => ({
          id: proposal.id.toString(),
          proposalId: proposal.id.toString(),
          title: proposal.title,
          description: proposal.description,
          proposer: proposal.proposer,
          targets: proposal.targets,
          values: proposal.values,
          calldatas: proposal.calldatas,
          votingType: proposal.votingType,
          votingDelay: proposal.votingDelay,
          votingPeriod: proposal.votingPeriod,
          quorumFraction: proposal.quorumFraction,
          emergencyProposal: proposal.emergencyProposal,
          state: proposal.state,
          startBlock: proposal.startBlock,
          endBlock: proposal.endBlock,
          forVotes: proposal.forVotes,
          againstVotes: proposal.againstVotes,
          abstainVotes: proposal.abstainVotes,
          createdAt: proposal.createdAt,
          executedAt: proposal.executedAt,
        }));
      } catch (error) {
        logger.error('Error fetching proposals', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'PROPOSALS_FETCH_ERROR',
        });
      }
    },
  },

  Mutation: {
    castVote: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      try {
        const user = requireVerifiedWallet(context);

        if (
          !input.proposalId ||
          input.support === undefined ||
          !input.signature
        ) {
          throw new Error(
            'Proposal ID, support choice, and signature are required'
          );
        }

        // Verify the signature
        const voteMessage = ethers.solidityPackedKeccak256(
          ['uint256', 'uint8', 'string'],
          [input.proposalId, input.support, input.reason || '']
        );

        const recoveredAddress = ethers.verifyMessage(
          ethers.getBytes(voteMessage),
          input.signature
        );

        if (recoveredAddress.toLowerCase() !== user.address.toLowerCase()) {
          throw new Error('Invalid signature for vote');
        }

        // Check if user has already voted
        const existingVote = await context.db.query.votes.findFirst({
          where: and(
            eq(votes.proposalId, input.proposalId.toString()),
            eq(votes.voter, user.address)
          ),
        });

        if (existingVote) {
          throw new Error('User has already voted on this proposal');
        }

        // Get user's voting power
        const votingPower = await context.contracts.wrfGovernor.getVotes(
          user.address,
          (await context.provider.getBlockNumber()) - 1
        );

        // Store vote in database
        const [voteRecord] = await context.db
          .insert(votes)
          .values({
            proposalId: input.proposalId.toString(),
            voter: user.address,
            voteOption: mapVoteChoice(input.support),
            support: mapVoteChoice(input.support),
            weight: votingPower.toString(),
            reason: input.reason || '',
            timestamp: new Date(),
            transactionHash: '', // Would be filled when submitted to blockchain
          })
          .returning();

        logger.info('Vote cast', {
          proposalId: input.proposalId,
          voter: user.address,
          support: input.support,
          weight: votingPower.toString(),
          requestId: context.requestId,
        });

        return {
          success: true,
          vote: {
            id: voteRecord.id,
            proposalId: voteRecord.proposalId,
            voter: voteRecord.voter,
            support: voteRecord.support,
            weight: voteRecord.weight,
            reason: voteRecord.reason,
            timestamp: voteRecord.timestamp,
            transactionHash: voteRecord.transactionHash,
          },
          transactionHash: '', // Would be returned from blockchain submission
          error: null,
        };
      } catch (error) {
        logger.error('Error casting vote', {
          input,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          vote: null,
          transactionHash: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },

  // Field resolvers
  GovernanceProposal: {
    votes: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const voteRecords = await context.db.query.votes.findMany({
          where: eq(votes.proposalId, parent.proposalId),
          limit: Math.min(first, 100),
          orderBy: desc(votes.timestamp),
        });

        return voteRecords.map(vote => ({
          id: vote.id,
          proposalId: vote.proposalId,
          voter: vote.voter,
          support: vote.support,
          weight: vote.weight,
          reason: vote.reason,
          timestamp: vote.timestamp,
          transactionHash: vote.transactionHash,
        }));
      } catch (error) {
        logger.error('Error fetching proposal votes', {
          proposalId: parent.proposalId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  },
};

// Helper functions
function mapProposalState(state: number): string {
  const states = [
    'PENDING',
    'ACTIVE',
    'CANCELED',
    'DEFEATED',
    'SUCCEEDED',
    'QUEUED',
    'EXPIRED',
    'EXECUTED',
  ];
  return states[state] || 'UNKNOWN';
}

function mapVoteChoice(support: number): string {
  const choices = ['AGAINST', 'FOR', 'ABSTAIN'];
  return choices[support] || 'UNKNOWN';
}
