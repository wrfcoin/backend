import { db } from '../../db.js';
import { eq, desc, sum, count, and } from 'drizzle-orm';
import {
  proposals,
  votes,
  delegations,
} from '../../../shared/governance-schema.js';
import { graphqlLogger } from '../../utils/logger.js';
import { wallets } from '../../../shared/schema.js';

// Utility function to safely extract error message from unknown error type
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

// Helper functions for voting power calculation
async function getWalletTokenBalance(walletAddress: string): Promise<number> {
  try {
    // Query wallet balance from the wallets table
    const [walletRow] = await db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(eq(wallets.address, walletAddress))
      .limit(1);
    return walletRow ? parseFloat(walletRow.balance) || 0 : 0;
  } catch (error) {
    graphqlLogger.error('Error fetching wallet balance', {
      operation: 'graphql:governance:walletBalance',
      walletAddress,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    return 0;
  }
}

async function getStakingMultiplier(walletAddress: string): Promise<number> {
  try {
    // Staking multiplier: base 1.0, increases with staked amount.
    // Full staking integration deferred; return base multiplier.
    return 1.0;
  } catch (error) {
    graphqlLogger.error('Error fetching staking multiplier', {
      operation: 'graphql:governance:stakingMultiplier',
      walletAddress,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    return 1;
  }
}

async function getDelegatedVotingPower(walletAddress: string): Promise<number> {
  try {
    // Count delegation power from the delegations table
    const [delegationData] = await db
      .select({ totalAmount: sum(delegations.amount) })
      .from(delegations)
      .where(eq(delegations.delegate, walletAddress));

    return parseInt(delegationData?.totalAmount ?? '0') || 0;
  } catch (error) {
    graphqlLogger.error('Error fetching delegated power', {
      operation: 'graphql:governance:delegatedPower',
      walletAddress,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    return 0;
  }
}

async function getParticipationBonus(walletAddress: string): Promise<number> {
  try {
    const [participationData] = await db
      .select({ voteCount: count() })
      .from(votes)
      .where(eq(votes.voter, walletAddress));

    const voteCount = participationData?.voteCount || 0;
    // Participation bonus: 10 points per vote cast (max 500)
    return Math.min(voteCount * 10, 500);
  } catch (error) {
    graphqlLogger.error('Error fetching participation bonus', {
      operation: 'graphql:governance:participationBonus',
      walletAddress,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    return 0;
  }
}

async function getTimeWeightedBonus(walletAddress: string): Promise<number> {
  try {
    const [firstVote] = await db
      .select({ timestamp: votes.timestamp })
      .from(votes)
      .where(eq(votes.voter, walletAddress))
      .orderBy(votes.timestamp)
      .limit(1);

    if (!firstVote) return 0;

    const daysActive = Math.floor(
      (Date.now() - new Date(firstVote.timestamp).getTime()) /
        (1000 * 60 * 60 * 24)
    );

    // Time bonus: 1 point per day active (max 365)
    return Math.min(daysActive, 365);
  } catch (error) {
    graphqlLogger.error('Error fetching time weighted bonus', {
      operation: 'graphql:governance:timeWeightedBonus',
      walletAddress,
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    return 0;
  }
}

// Individual proposal field resolvers
const GovernanceProposal = {
  // Resolve votes for a proposal
  votes: async (parent: any) => {
    try {
      const results = await db
        .select()
        .from(votes)
        .where(eq(votes.proposalId, parent.id.toString()))
        .orderBy(desc(votes.timestamp));

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching votes for proposal', {
        operation: 'graphql:governance:proposalVotes',
        proposalId: parent.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },
};

// Individual vote field resolvers
const ProposalVote = {
  // Resolve related proposal for a vote
  proposal: async (parent: any) => {
    try {
      const [proposal] = await db
        .select()
        .from(proposals)
        .where(eq(proposals.id, parent.proposalId));

      return proposal;
    } catch (error) {
      graphqlLogger.error('Error fetching proposal for vote', {
        operation: 'graphql:governance:voteProposal',
        proposalId: parent.proposalId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },
};

// Query resolvers
const Query = {
  // Get a specific proposal by ID
  governanceProposal: async (
    _: any,
    { proposalId }: { proposalId: string }
  ) => {
    try {
      const [result] = await db
        .select()
        .from(proposals)
        .where(eq(proposals.id, parseInt(proposalId)));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching governance proposal', {
        operation: 'graphql:governance:getProposal',
        proposalId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get all governance proposals
  proposals: async (_: any, { limit = 100 }: { limit?: number }) => {
    try {
      const results = await db
        .select()
        .from(proposals)
        .orderBy(desc(proposals.createdAt))
        .limit(limit);

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching governance proposals', {
        operation: 'graphql:governance:listProposals',
        limit,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get only active governance proposals
  activeGovernanceProposals: async () => {
    try {
      const results = await db
        .select()
        .from(proposals)
        .where(eq(proposals.status, 'ACTIVE'))
        .orderBy(desc(proposals.createdAt));

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching active governance proposals', {
        operation: 'graphql:governance:activeProposals',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get votes for a specific proposal
  votes: async (_: any, { proposalId }: { proposalId: string }) => {
    try {
      const results = await db
        .select()
        .from(votes)
        .where(eq(votes.proposalId, proposalId))
        .orderBy(desc(votes.timestamp));

      return results;
    } catch (error) {
      graphqlLogger.error('Error fetching proposal votes', {
        operation: 'graphql:governance:getVotes',
        proposalId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return [];
    }
  },

  // Get a specific vote by proposal and voter
  voterVote: async (
    _: any,
    { proposalId, voter }: { proposalId: string; voter: string }
  ) => {
    try {
      const [result] = await db
        .select()
        .from(votes)
        .where(and(eq(votes.proposalId, proposalId), eq(votes.voter, voter)));

      return result;
    } catch (error) {
      graphqlLogger.error('Error fetching voter vote', {
        operation: 'graphql:governance:getVoterVote',
        proposalId,
        voter,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return null;
    }
  },

  // Get voting power for a specific voter
  voterPower: async (_: any, { voter }: { voter: string }) => {
    try {
      const baseBalance = await getWalletTokenBalance(voter);
      const stakingMultiplier = await getStakingMultiplier(voter);
      const delegatedPower = await getDelegatedVotingPower(voter);
      const participationBonus = await getParticipationBonus(voter);
      const timeWeightedBonus = await getTimeWeightedBonus(voter);

      const totalPower = Math.floor(
        baseBalance * stakingMultiplier +
          delegatedPower +
          participationBonus +
          timeWeightedBonus
      );

      return {
        voter,
        baseBalance,
        stakingMultiplier,
        delegatedPower,
        participationBonus,
        timeWeightedBonus,
        totalPower,
      };
    } catch (error) {
      graphqlLogger.error('Error calculating voter power', {
        operation: 'graphql:governance:voterPower',
        voter,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return {
        voter,
        baseBalance: 0,
        stakingMultiplier: 1,
        delegatedPower: 0,
        participationBonus: 0,
        timeWeightedBonus: 0,
        totalPower: 0,
      };
    }
  },
};

// Mutation resolvers
const Mutation = {
  // Create a new governance proposal
  createGovernanceProposal: async (
    _: any,
    {
      proposer,
      title,
      description,
      proposalType,
      content,
      votingPeriod,
      deposit,
    }: {
      proposer: string;
      title: string;
      description: string;
      proposalType: string;
      content: string;
      votingPeriod: number;
      deposit: number;
    }
  ) => {
    try {
      // Generate a unique proposal ID
      const proposalId = `PROP-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      // Calculate end time
      const creationTime = new Date();
      const endTime = new Date(creationTime.getTime() + votingPeriod * 1000);

      // Create the proposal
      const [proposal] = await db
        .insert(proposals)
        .values({
          title,
          description,
          proposalType,
          proposer,
          deposit: deposit.toString(),
          status: 'VOTING',
          votingStartTime: creationTime,
          votingEndTime: endTime,
          votingPeriod,
          totalYes: '0',
          totalNo: '0',
          totalAbstain: '0',
          totalNoWithVeto: '0',
          forVotes: '0',
          againstVotes: '0',
          abstainVotes: '0',
          metadata: { content },
        })
        .returning();

      return proposal;
    } catch (error) {
      graphqlLogger.error('Error creating governance proposal', {
        operation: 'graphql:governance:createProposal',
        proposer,
        title,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      throw new Error(
        `Failed to create governance proposal: ${getErrorMessage(error)}`
      );
    }
  },

  // Cast a vote on a proposal
  castVote: async (
    _: any,
    {
      proposalId,
      voter,
      vote,
    }: { proposalId: string; voter: string; vote: string }
  ) => {
    try {
      // Check if proposal exists and is active
      const [proposal] = await db
        .select()
        .from(proposals)
        .where(eq(proposals.id, parseInt(proposalId)));

      if (!proposal) {
        throw new Error(`Proposal with ID ${proposalId} not found`);
      }

      if (proposal.status !== 'ACTIVE') {
        throw new Error('Proposal is not active for voting');
      }

      // Check if user has already voted
      const existingVote = await db
        .select()
        .from(votes)
        .where(and(eq(votes.proposalId, proposalId), eq(votes.voter, voter)));

      if (existingVote.length > 0) {
        throw new Error('Voter has already cast a vote on this proposal');
      }

      // Get real voting power using the implemented system
      const voterPowerData = await Query.voterPower(null, { voter });
      const votingPower = voterPowerData.totalPower;

      // Cast the vote
      const [newVote] = await db
        .insert(votes)
        .values({
          proposalId,
          voter,
          voteOption: vote,
          support:
            vote === 'YES' ? 'FOR' : vote === 'NO' ? 'AGAINST' : 'ABSTAIN',
          weight: votingPower.toString(),
          timestamp: new Date(),
        })
        .returning();

      // Update proposal vote counts
      const currentTotalYes = parseInt(proposal.totalYes ?? '0') || 0;
      const currentTotalNo = parseInt(proposal.totalNo ?? '0') || 0;
      const currentTotalAbstain = parseInt(proposal.totalAbstain ?? '0') || 0;
      const currentTotalNoWithVeto =
        parseInt(proposal.totalNoWithVeto ?? '0') || 0;

      const updates: any = {};

      if (vote === 'YES') {
        updates.totalYes = (currentTotalYes + votingPower).toString();
        updates.forVotes = (currentTotalYes + votingPower).toString();
      } else if (vote === 'NO') {
        updates.totalNo = (currentTotalNo + votingPower).toString();
        updates.againstVotes = (currentTotalNo + votingPower).toString();
      } else if (vote === 'ABSTAIN') {
        updates.totalAbstain = (currentTotalAbstain + votingPower).toString();
        updates.abstainVotes = (currentTotalAbstain + votingPower).toString();
      } else if (vote === 'VETO') {
        updates.totalNoWithVeto = (
          currentTotalNoWithVeto + votingPower
        ).toString();
      }

      // Update the proposal
      await db
        .update(proposals)
        .set(updates)
        .where(eq(proposals.id, parseInt(proposalId)));

      return newVote;
    } catch (error) {
      graphqlLogger.error('Error casting vote', {
        operation: 'graphql:governance:castVote',
        proposalId,
        voter,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      throw new Error(`Failed to cast vote: ${getErrorMessage(error)}`);
    }
  },
};

// Subscription resolvers
const Subscription = {
  newProposal: {
    subscribe: () => {
      throw new Error('Subscriptions not supported in this implementation');
    },
  },
  proposalStatusChanged: {
    subscribe: () => {
      throw new Error('Subscriptions not supported in this implementation');
    },
  },
};

export { GovernanceProposal, ProposalVote, Query, Mutation, Subscription };
