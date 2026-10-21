import { GraphQLScalarType, Kind } from 'graphql';

// Types
interface Block {
  id: string;
  height: number;
  hash: string;
  timestamp: string;
  transactions: Transaction[];
}

interface Transaction {
  id: string;
  hash: string;
  from: string;
  to: string;
  amount: number;
  timestamp: string;
}

interface User {
  id: string;
  address: string;
  balance: number;
  joinedAt: string;
}

interface ComputationalNFT {
  id: string;
  owner: string;
  computationType: string;
  resourceTier: string;
  performance: {
    totalExecutions: number;
    averageExecutionTime: number;
    successRate: number;
  };
}

interface Wallet {
  id: string;
  address: string;
  balance: number;
  transactions: Transaction[];
}

interface MiningPool {
  id: string;
  name: string;
  hashRate: string;
  miners: number;
  fee: number;
}

interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  status: string;
  votes: {
    for: number;
    against: number;
    abstain: number;
  };
}

// Mock storage with TypeScript types
const storage = {
  getBlocks: (): Block[] => [],
  getTransactions: (): Transaction[] => [],
  getUsers: (): User[] => [],
  getComputationalNFTs: (): ComputationalNFT[] => [],
  getWallets: (): Wallet[] => [],
  getMiningPools: (): MiningPool[] => [],
  getGovernanceProposals: (): GovernanceProposal[] => [],
  getBlockchainMetrics: () => ({ totalBlocks: 0, totalTransactions: 0 }),
};

// Custom scalar for Date
const dateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'Date custom scalar type',
  serialize(value: any): number {
    // Convert Date to timestamp for client
    return value instanceof Date ? value.getTime() : value;
  },
  parseValue(value: any): Date {
    // Convert timestamp from client to Date
    return new Date(value);
  },
  parseLiteral(ast): Date | null {
    if (ast.kind === Kind.INT) {
      return new Date(parseInt(ast.value, 10));
    }
    return null;
  },
});

// Root resolver combining all resolvers
const resolvers = {
  Date: dateScalar,

  Query: {
    // Blockchain queries
    blocks: () => storage.getBlocks(),
    block: (_: any, { id }: { id: string }) =>
      storage.getBlocks().find(block => block.id === id),
    transactions: () => storage.getTransactions(),
    transaction: (_: any, { id }: { id: string }) =>
      storage.getTransactions().find(tx => tx.id === id),

    // User queries
    users: () => storage.getUsers(),
    user: (_: any, { id }: { id: string }) =>
      storage.getUsers().find(user => user.id === id),

    // Computational NFT queries
    computationalNFTs: () => storage.getComputationalNFTs(),
    computationalNFT: (_: any, { id }: { id: string }) =>
      storage.getComputationalNFTs().find(nft => nft.id === id),

    // Wallet queries
    wallets: () => storage.getWallets(),
    wallet: (_: any, { address }: { address: string }) =>
      storage.getWallets().find(wallet => wallet.address === address),

    // Mining pool queries
    miningPools: () => storage.getMiningPools(),
    miningPool: (_: any, { id }: { id: string }) =>
      storage.getMiningPools().find(pool => pool.id === id),

    // Governance queries
    governanceProposals: () => storage.getGovernanceProposals(),
    governanceProposal: (_: any, { id }: { id: string }) =>
      storage.getGovernanceProposals().find(proposal => proposal.id === id),

    // Metrics
    blockchainMetrics: () => storage.getBlockchainMetrics(),

    // Weather data queries
    weatherData: (_: any, { stationId }: { stationId: string }) => ({
      id: stationId,
      temperature: 22.5,
      humidity: 65,
      pressure: 1013.25,
      timestamp: new Date().toISOString(),
      qualityScore: 95,
    }),

    // Cross-chain queries
    bridgeStatus: (_: any, { chainId }: { chainId: string }) => ({
      chainId,
      status: 'active',
      totalLocked: '1,250,000 WRF',
      dailyVolume: '$45,200',
      fees: '0.1%',
    }),
  },

  Mutation: {
    // User mutations
    createUser: (_: any, { input }: { input: any }) => {
      const newUser: User = {
        id: `user_${Date.now()}`,
        address: input.address,
        balance: 0,
        joinedAt: new Date().toISOString(),
      };
      return newUser;
    },

    // Transaction mutations
    createTransaction: (_: any, { input }: { input: any }) => {
      const newTransaction: Transaction = {
        id: `tx_${Date.now()}`,
        hash: `0x${Math.random().toString(16).substring(2, 66)}`,
        from: input.from,
        to: input.to,
        amount: input.amount,
        timestamp: new Date().toISOString(),
      };
      return newTransaction;
    },

    // Computational NFT mutations
    createComputationalNFT: (_: any, { input }: { input: any }) => {
      const newNFT: ComputationalNFT = {
        id: `nft_${Date.now()}`,
        owner: input.owner,
        computationType: input.computationType,
        resourceTier: input.resourceTier,
        performance: {
          totalExecutions: 0,
          averageExecutionTime: 0,
          successRate: 0,
        },
      };
      return newNFT;
    },

    // Governance mutations
    createProposal: (_: any, { input }: { input: any }) => {
      const newProposal: GovernanceProposal = {
        id: `prop_${Date.now()}`,
        title: input.title,
        description: input.description,
        status: 'active',
        votes: { for: 0, against: 0, abstain: 0 },
      };
      return newProposal;
    },

    // Weather data submission
    submitWeatherData: (_: any, { input }: { input: any }) => {
      return {
        success: true,
        rewardAmount: '0.125 WRF',
        qualityScore: 95,
        transactionHash: `0x${Math.random().toString(16).substring(2, 66)}`,
      };
    },
  },

  // Nested resolvers
  Block: {
    transactions: (parent: Block) => parent.transactions || [],
  },

  User: {
    transactions: (parent: User) =>
      storage
        .getTransactions()
        .filter(tx => tx.from === parent.address || tx.to === parent.address),
  },

  Wallet: {
    transactions: (parent: Wallet) => parent.transactions || [],
  },
};

export default resolvers;
export { storage, dateScalar };
