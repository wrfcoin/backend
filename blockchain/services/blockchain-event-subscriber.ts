/**
 * Blockchain Event Subscriber Service
 * Subscribes to smart contract events and broadcasts them to WebSocket clients
 * Supports governance, carbon credit, and DeFi events for real-time updates
 */

import { ethers } from 'ethers';
import winston from 'winston';
import { getCore4ApiUrl } from '../../src/config/core4.js';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/blockchain-events.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Event types that can be subscribed to
export enum GovernanceEventType {
  PROPOSAL_CREATED = 'ProposalCreated',
  VOTE_CAST = 'VoteCast',
  PROPOSAL_PASSED = 'ProposalPassed',
  PROPOSAL_EXECUTED = 'ProposalExecuted',
  PROPOSAL_DEFEATED = 'ProposalDefeated',
  DELEGATION_CHANGED = 'DelegationChanged',
}

export enum CarbonCreditEventType {
  CREDIT_MINTED = 'CreditMinted',
  CREDIT_TRANSFERRED = 'CreditTransferred',
  CREDIT_RETIRED = 'CreditRetired',
  CREDIT_VERIFIED = 'CreditVerified',
}

export enum DeFiEventType {
  SWAP_EXECUTED = 'SwapExecuted',
  LIQUIDITY_ADDED = 'LiquidityAdded',
  LIQUIDITY_REMOVED = 'LiquidityRemoved',
  STAKE_DEPOSITED = 'StakeDeposited',
  REWARDS_CLAIMED = 'RewardsClaimed',
}

export interface EventSubscription {
  contractAddress: string;
  eventName: string;
  channel: string;
  filter?: ethers.EventFilter;
}

export interface ParsedEvent {
  eventName: string;
  contractAddress: string;
  blockNumber: number;
  transactionHash: string;
  args: Record<string, any>;
  timestamp: string;
}

// WebSocket broadcast callback type
type BroadcastCallback = (channel: string, event: string, data: any) => void;

// Contract ABIs for events we want to subscribe to
const GOVERNANCE_EVENT_ABI = [
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string title)',
  'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)',
  'event ProposalPassed(uint256 indexed proposalId)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProposalDefeated(uint256 indexed proposalId)',
  'event DelegationChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)',
];

const CARBON_CREDIT_EVENT_ABI = [
  'event CreditMinted(uint256 indexed tokenId, address indexed to, uint256 amount, string projectId)',
  'event CreditTransferred(uint256 indexed tokenId, address indexed from, address indexed to, uint256 amount)',
  'event CreditRetired(uint256 indexed tokenId, address indexed owner, uint256 amount, string reason)',
  'event CreditVerified(uint256 indexed tokenId, address indexed verifier, uint8 verificationStatus)',
];

const DEFI_EVENT_ABI = [
  'event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address indexed trader)',
  'event LiquidityAdded(address indexed provider, uint256 tokenAAmount, uint256 tokenBAmount, uint256 lpTokens)',
  'event LiquidityRemoved(address indexed provider, uint256 tokenAAmount, uint256 tokenBAmount, uint256 lpTokens)',
  'event StakeDeposited(address indexed user, uint256 amount, uint256 lockDuration)',
  'event RewardsClaimed(address indexed user, uint256 amount)',
];

export class BlockchainEventSubscriber {
  private provider: ethers.JsonRpcProvider | null = null;
  private subscriptions: Map<string, ethers.Contract> = new Map();
  private broadcastCallback: BroadcastCallback | null = null;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 5000;

  constructor() {
    // Initialize provider in async init
  }

  async initialize(rpcUrl?: string): Promise<void> {
    const providerUrl = rpcUrl || getCore4ApiUrl();

    try {
      this.provider = new ethers.JsonRpcProvider(providerUrl);
      await this.provider.getBlockNumber(); // Test connection
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info('BlockchainEventSubscriber connected', { providerUrl });
    } catch (error) {
      logger.error('Failed to connect to blockchain provider', { error, providerUrl });
      this.isConnected = false;
      throw error;
    }
  }

  setBroadcastCallback(callback: BroadcastCallback): void {
    this.broadcastCallback = callback;
  }

  async subscribeToGovernanceEvents(
    governanceContractAddress: string,
    websocketChannel: string = 'governance'
  ): Promise<void> {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call initialize() first.');
    }

    const contract = new ethers.Contract(
      governanceContractAddress,
      GOVERNANCE_EVENT_ABI,
      this.provider
    );

    const subscriptionKey = `governance:${governanceContractAddress}`;
    this.subscriptions.set(subscriptionKey, contract);

    // Subscribe to each governance event
    contract.on('ProposalCreated', (proposalId, proposer, title, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.PROPOSAL_CREATED, {
        proposalId: proposalId.toString(),
        proposer,
        title,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('VoteCast', (proposalId, voter, support, weight, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.VOTE_CAST, {
        proposalId: proposalId.toString(),
        voter,
        support,
        weight: weight.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('ProposalPassed', (proposalId, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.PROPOSAL_PASSED, {
        proposalId: proposalId.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('ProposalExecuted', (proposalId, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.PROPOSAL_EXECUTED, {
        proposalId: proposalId.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('ProposalDefeated', (proposalId, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.PROPOSAL_DEFEATED, {
        proposalId: proposalId.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('DelegationChanged', (delegator, fromDelegate, toDelegate, event) => {
      this.handleEvent(websocketChannel, GovernanceEventType.DELEGATION_CHANGED, {
        delegator,
        fromDelegate,
        toDelegate,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    logger.info('Subscribed to governance events', {
      contractAddress: governanceContractAddress,
      channel: websocketChannel,
    });
  }

  async subscribeToCarbonCreditEvents(
    carbonCreditContractAddress: string,
    websocketChannel: string = 'carbon-credits'
  ): Promise<void> {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call initialize() first.');
    }

    const contract = new ethers.Contract(
      carbonCreditContractAddress,
      CARBON_CREDIT_EVENT_ABI,
      this.provider
    );

    const subscriptionKey = `carbon:${carbonCreditContractAddress}`;
    this.subscriptions.set(subscriptionKey, contract);

    contract.on('CreditMinted', (tokenId, to, amount, projectId, event) => {
      this.handleEvent(websocketChannel, CarbonCreditEventType.CREDIT_MINTED, {
        tokenId: tokenId.toString(),
        to,
        amount: amount.toString(),
        projectId,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('CreditTransferred', (tokenId, from, to, amount, event) => {
      this.handleEvent(websocketChannel, CarbonCreditEventType.CREDIT_TRANSFERRED, {
        tokenId: tokenId.toString(),
        from,
        to,
        amount: amount.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('CreditRetired', (tokenId, owner, amount, reason, event) => {
      this.handleEvent(websocketChannel, CarbonCreditEventType.CREDIT_RETIRED, {
        tokenId: tokenId.toString(),
        owner,
        amount: amount.toString(),
        reason,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    contract.on('CreditVerified', (tokenId, verifier, verificationStatus, event) => {
      this.handleEvent(websocketChannel, CarbonCreditEventType.CREDIT_VERIFIED, {
        tokenId: tokenId.toString(),
        verifier,
        verificationStatus,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    logger.info('Subscribed to carbon credit events', {
      contractAddress: carbonCreditContractAddress,
      channel: websocketChannel,
    });
  }

  async subscribeToDeFiEvents(
    ammContractAddress: string,
    yieldFarmingContractAddress: string,
    websocketChannel: string = 'defi'
  ): Promise<void> {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call initialize() first.');
    }

    // AMM events
    const ammContract = new ethers.Contract(
      ammContractAddress,
      DEFI_EVENT_ABI,
      this.provider
    );

    const ammKey = `amm:${ammContractAddress}`;
    this.subscriptions.set(ammKey, ammContract);

    ammContract.on('SwapExecuted', (tokenIn, tokenOut, amountIn, amountOut, trader, event) => {
      this.handleEvent(websocketChannel, DeFiEventType.SWAP_EXECUTED, {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        trader,
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    ammContract.on('LiquidityAdded', (provider, tokenAAmount, tokenBAmount, lpTokens, event) => {
      this.handleEvent(websocketChannel, DeFiEventType.LIQUIDITY_ADDED, {
        provider,
        tokenAAmount: tokenAAmount.toString(),
        tokenBAmount: tokenBAmount.toString(),
        lpTokens: lpTokens.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    ammContract.on('LiquidityRemoved', (provider, tokenAAmount, tokenBAmount, lpTokens, event) => {
      this.handleEvent(websocketChannel, DeFiEventType.LIQUIDITY_REMOVED, {
        provider,
        tokenAAmount: tokenAAmount.toString(),
        tokenBAmount: tokenBAmount.toString(),
        lpTokens: lpTokens.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    // Yield Farming events
    const yieldContract = new ethers.Contract(
      yieldFarmingContractAddress,
      DEFI_EVENT_ABI,
      this.provider
    );

    const yieldKey = `yield:${yieldFarmingContractAddress}`;
    this.subscriptions.set(yieldKey, yieldContract);

    yieldContract.on('StakeDeposited', (user, amount, lockDuration, event) => {
      this.handleEvent(websocketChannel, DeFiEventType.STAKE_DEPOSITED, {
        user,
        amount: amount.toString(),
        lockDuration: lockDuration.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    yieldContract.on('RewardsClaimed', (user, amount, event) => {
      this.handleEvent(websocketChannel, DeFiEventType.REWARDS_CLAIMED, {
        user,
        amount: amount.toString(),
        blockNumber: event.log.blockNumber,
        transactionHash: event.log.transactionHash,
      });
    });

    logger.info('Subscribed to DeFi events', {
      ammContract: ammContractAddress,
      yieldFarmingContract: yieldFarmingContractAddress,
      channel: websocketChannel,
    });
  }

  private handleEvent(channel: string, eventName: string, data: any): void {
    const eventData: ParsedEvent = {
      eventName,
      contractAddress: data.contractAddress || 'unknown',
      blockNumber: data.blockNumber,
      transactionHash: data.transactionHash,
      args: data,
      timestamp: new Date().toISOString(),
    };

    logger.info('Blockchain event received', eventData);

    // Broadcast to WebSocket clients
    if (this.broadcastCallback) {
      this.broadcastCallback(channel, eventName, eventData);
    }
  }

  unsubscribe(subscriptionKey: string): void {
    const contract = this.subscriptions.get(subscriptionKey);
    if (contract) {
      contract.removeAllListeners();
      this.subscriptions.delete(subscriptionKey);
      logger.info('Unsubscribed from contract events', { subscriptionKey });
    }
  }

  unsubscribeAll(): void {
    for (const [key, contract] of this.subscriptions) {
      contract.removeAllListeners();
      logger.info('Unsubscribed from contract events', { subscriptionKey: key });
    }
    this.subscriptions.clear();
  }

  isInitialized(): boolean {
    return this.isConnected && this.provider !== null;
  }

  getActiveSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info(`Attempting to reconnect (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));

    try {
      await this.initialize();
      logger.info('Reconnection successful');
    } catch (error) {
      logger.error('Reconnection failed', { error });
      await this.reconnect();
    }
  }
}

// Export singleton instance
export const blockchainEventSubscriber = new BlockchainEventSubscriber();
