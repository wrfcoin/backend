/**
 * GraphQL Type Definitions
 * TypeScript implementation for GraphQL schema types
 */

import { gql } from 'graphql-tag';

const typeDefs = gql`
  scalar Date

  # Basic Types
  type Block {
    id: ID!
    height: Int!
    hash: String!
    timestamp: Date!
    transactions: [Transaction!]!
    validator: String
    gasUsed: Int
    gasLimit: Int
  }

  type Transaction {
    id: ID!
    hash: String!
    from: String!
    to: String!
    amount: Float!
    timestamp: Date!
    status: String!
    gasPrice: Float
    gasUsed: Int
    blockHeight: Int
  }

  type User {
    id: ID!
    address: String!
    balance: Float!
    joinedAt: Date!
    transactions: [Transaction!]!
    nfts: [ComputationalNFT!]!
  }

  # Wallet Types
  type Wallet {
    id: ID!
    address: String!
    balance: Float!
    nonce: Int!
    createdAt: Date!
    transactions: [Transaction!]!
  }

  input WalletInput {
    address: String!
    privateKey: String
  }

  input TransactionInput {
    from: String!
    to: String!
    amount: Float!
    gasPrice: Float
    gasLimit: Int
  }

  # Computational NFT Types
  type ComputationalNFT {
    id: ID!
    tokenId: Int!
    owner: String!
    name: String!
    description: String!
    computationType: String!
    resourceTier: String!
    wasmModule: String!
    metadata: NFTMetadata!
    performance: NFTPerformance!
    createdAt: Date!
    isActive: Boolean!
    executionHistory: [ExecutionResult!]!
    recentExecutions: [ExecutionResult!]!
  }

  type NFTMetadata {
    image: String!
    attributes: [NFTAttribute!]!
    computationalPower: String!
    accuracy: String!
  }

  type NFTAttribute {
    trait_type: String!
    value: String!
  }

  type NFTPerformance {
    totalExecutions: Int!
    averageExecutionTime: Float!
    successRate: Float!
    totalRewards: Float!
    lastExecution: Date!
  }

  type ExecutionResult {
    id: ID!
    nftId: String!
    inputData: JSON
    result: JSON
    executionTime: Float!
    gasUsed: Int!
    timestamp: Date!
    success: Boolean!
    error: String
  }

  type NFTMarketplace {
    featured: [MarketplaceNFT!]!
    totalListings: Int!
    floorPrice: String!
    volume24h: String!
    activeAuctions: Int!
  }

  type MarketplaceNFT {
    id: ID!
    name: String!
    price: String!
    image: String!
    collection: String!
    computationalPower: String!
    accuracy: String!
  }

  input ComputationalNFTInput {
    name: String!
    description: String!
    owner: String!
    computationType: String!
    resourceTier: String!
    wasmModule: String!
    metadata: JSON
  }

  input ExecutionInput {
    nftId: String!
    inputData: JSON!
  }

  # Mining Pool Types
  type MiningPool {
    id: ID!
    name: String!
    hashRate: String!
    miners: Int!
    fee: Float!
    status: String!
    rewards24h: Float!
  }

  # Governance Types
  type GovernanceProposal {
    id: ID!
    title: String!
    description: String!
    proposer: String!
    status: String!
    votes: ProposalVotes!
    votingPeriod: VotingPeriod!
    createdAt: Date!
  }

  type ProposalVotes {
    for: Int!
    against: Int!
    abstain: Int!
  }

  type VotingPeriod {
    start: Date!
    end: Date!
  }

  # Weather Data Types
  type WeatherData {
    id: ID!
    stationId: String!
    temperature: Float!
    humidity: Float!
    pressure: Float!
    timestamp: Date!
    qualityScore: Int!
    validated: Boolean!
  }

  # Cross-Chain Types
  type BridgeStatus {
    chainId: String!
    status: String!
    totalLocked: String!
    dailyVolume: String!
    fees: String!
  }

  # Metrics Types
  type BlockchainMetrics {
    totalBlocks: Int!
    totalTransactions: Int!
    totalUsers: Int!
    networkHashRate: String!
    avgBlockTime: Float!
  }

  # Custom scalar for JSON data
  scalar JSON

  # Queries
  type Query {
    # Blockchain queries
    blocks: [Block!]!
    block(id: ID!): Block
    transactions: [Transaction!]!
    transaction(id: ID!): Transaction
    blockchainMetrics: BlockchainMetrics!

    # User queries
    users: [User!]!
    user(id: ID!): User
    userByAddress(address: String!): User

    # Wallet queries
    wallets: [Wallet!]!
    wallet(address: String!): Wallet
    walletBalance(address: String!): Float!
    walletTransactions(address: String!): [Transaction!]!
    pendingTransactions(address: String!): [Transaction!]!

    # Computational NFT queries
    computationalNFTs(owner: String): [ComputationalNFT!]!
    computationalNFT(id: ID!): ComputationalNFT
    computationalNFTsByType(computationType: String!): [ComputationalNFT!]!
    nftExecutionHistory(nftId: String!): [ExecutionResult!]!
    topPerformingNFTs(limit: Int): [ComputationalNFT!]!
    nftMarketplace: NFTMarketplace!

    # Mining pool queries
    miningPools: [MiningPool!]!
    miningPool(id: ID!): MiningPool

    # Governance queries
    governanceProposals: [GovernanceProposal!]!
    governanceProposal(id: ID!): GovernanceProposal

    # Weather data queries
    weatherData(stationId: String!): WeatherData
    weatherStations: [String!]!

    # Cross-chain queries
    bridgeStatus(chainId: String!): BridgeStatus
    supportedChains: [String!]!
  }

  # Mutations
  type Mutation {
    # User mutations
    createUser(input: UserInput!): User!
    updateUser(id: ID!, input: UserInput!): User!

    # Transaction mutations
    createTransaction(input: TransactionInput!): Transaction!

    # Wallet mutations
    createWallet(input: WalletInput!): Wallet!
    importWallet(input: WalletInput!): Wallet!
    sendTransaction(input: TransactionInput!): Transaction!
    updateWalletBalance(address: String!, amount: Float!): Wallet!

    # Computational NFT mutations
    createComputationalNFT(input: ComputationalNFTInput!): ComputationalNFT!
    executeComputationalNFT(input: ExecutionInput!): ExecutionResult!
    transferComputationalNFT(
      nftId: String!
      newOwner: String!
    ): ComputationalNFT!
    updateNFTStatus(nftId: String!, isActive: Boolean!): ComputationalNFT!

    # Governance mutations
    createProposal(input: ProposalInput!): GovernanceProposal!
    vote(proposalId: String!, vote: String!, amount: Float!): Boolean!

    # Weather data mutations
    submitWeatherData(input: WeatherDataInput!): WeatherSubmissionResult!
  }

  # Additional Input Types
  input UserInput {
    address: String!
    email: String
    username: String
  }

  input ProposalInput {
    title: String!
    description: String!
    proposer: String!
  }

  input WeatherDataInput {
    stationId: String!
    temperature: Float!
    humidity: Float!
    pressure: Float!
    location: LocationInput
  }

  input LocationInput {
    latitude: Float!
    longitude: Float!
    altitude: Float
  }

  type WeatherSubmissionResult {
    success: Boolean!
    rewardAmount: String!
    qualityScore: Int!
    transactionHash: String!
  }

  # Subscriptions for real-time updates
  type Subscription {
    newBlock: Block!
    newTransaction: Transaction!
    nftExecutionUpdate(nftId: String!): ExecutionResult!
    weatherDataUpdate(stationId: String!): WeatherData!
  }
`;

export default typeDefs;

// Named export for compatibility
export { typeDefs };
