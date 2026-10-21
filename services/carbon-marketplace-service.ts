/**
 * Carbon Credit Marketplace Service
 * Implements order book management, matching algorithms, trade execution, and MEV protection
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

// Order Types
export enum OrderType {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderStatus {
  PENDING_COMMIT = 'PENDING_COMMIT', // Waiting for commit phase
  COMMITTED = 'COMMITTED', // Commit received, waiting for reveal
  ACTIVE = 'ACTIVE', // Order revealed and active in book
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum CreditType {
  VCS = 'VCS', // Verified Carbon Standard
  GOLD_STANDARD = 'GOLD_STANDARD',
  CDM = 'CDM', // Clean Development Mechanism
  VERRA = 'VERRA',
  AMERICAN_CARBON_REGISTRY = 'ACR',
}

// Order Structure
export interface CarbonCreditOrder {
  id: string;
  userId: string;
  walletAddress: string;
  orderType: OrderType;
  creditType: CreditType;
  tokenId?: string; // For specific NFT orders
  quantity: bigint; // Amount of credits (in smallest unit)
  price: bigint; // Price per credit in WRF tokens (wei)
  minPrice?: bigint; // For sell orders - minimum acceptable price
  maxPrice?: bigint; // For buy orders - maximum acceptable price
  remainingQuantity: bigint;
  status: OrderStatus;
  commitHash?: string; // For MEV protection
  revealDeadline?: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  metadata?: {
    vintageYear?: number;
    projectId?: string;
    projectType?: string;
    methodology?: string;
    qualityScore?: number;
  };
}

// Trade Structure
export interface Trade {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  creditType: CreditType;
  tokenId?: string;
  quantity: bigint;
  price: bigint;
  totalValue: bigint;
  fee: bigint;
  transactionHash?: string;
  status: 'PENDING' | 'EXECUTED' | 'SETTLED' | 'FAILED';
  executedAt: Date;
  settledAt?: Date;
}

// Commit-Reveal for MEV Protection
export interface OrderCommit {
  commitHash: string;
  userId: string;
  commitTimestamp: Date;
  revealDeadline: Date;
  revealed: boolean;
}

// Order Book Entry (sorted)
interface OrderBookEntry {
  price: bigint;
  orders: CarbonCreditOrder[];
}

// Market Data
export interface MarketData {
  creditType: CreditType;
  lastPrice: bigint;
  highPrice24h: bigint;
  lowPrice24h: bigint;
  volume24h: bigint;
  openInterest: bigint;
  bestBid: bigint;
  bestAsk: bigint;
  spread: bigint;
  timestamp: Date;
}

/**
 * Carbon Credit Marketplace Service
 * Handles order book management, matching, and trade execution
 */
export class CarbonMarketplaceService extends EventEmitter {
  /** #977: maintenance timer handles — previously discarded, so unclearable. */
  private expiredOrderTimer?: ReturnType<typeof setInterval>;
  private revealDeadlineTimer?: ReturnType<typeof setInterval>;

  // Order books by credit type
  private orderBooks: Map<CreditType, {
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
  }> = new Map();

  // Active orders by ID
  private orders: Map<string, CarbonCreditOrder> = new Map();

  // Commits for MEV protection
  private commits: Map<string, OrderCommit> = new Map();

  // Trade history
  private trades: Trade[] = [];

  // Configuration
  private readonly FEE_BASIS_POINTS = 30n; // 0.3% fee
  private readonly COMMIT_REVEAL_WINDOW = 2 * 60 * 1000; // 2 minutes
  private readonly ORDER_EXPIRY_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly MIN_ORDER_SIZE = 1000000000000000n; // 0.001 credits minimum

  constructor() {
    super();
    this.initializeOrderBooks();
    this.startMaintenanceTasks();
  }

  /**
   * Initialize empty order books for each credit type
   */
  private initializeOrderBooks(): void {
    for (const creditType of Object.values(CreditType)) {
      this.orderBooks.set(creditType, {
        bids: [],
        asks: [],
      });
    }
    logger.info('Carbon marketplace order books initialized');
  }

  /**
   * Start background maintenance tasks
   */
  private startMaintenanceTasks(): void {
    // #977: both handles are stored and unref'd. The constructor calls this and
    // the module exports a module-scope singleton, so importing this file starts
    // two timers that hold the event loop open. They were previously DISCARDED,
    // so they could be neither unref'd nor cleared.
    // Check for expired orders every minute
    this.expiredOrderTimer = setInterval(() => this.processExpiredOrders(), 60000);
    this.expiredOrderTimer.unref();

    // Check for reveal deadlines every 30 seconds
    this.revealDeadlineTimer = setInterval(() => this.processRevealDeadlines(), 30000);
    this.revealDeadlineTimer.unref();
  }

  /**
   * MEV Protection: Phase 1 - Commit Order
   * User submits a hash of their order details
   */
  async commitOrder(
    userId: string,
    commitHash: string
  ): Promise<{ commitId: string; revealDeadline: Date }> {
    // Validate commit hash format
    if (!this.isValidCommitHash(commitHash)) {
      throw new Error('Invalid commit hash format');
    }

    // Check for duplicate commits
    if (this.commits.has(commitHash)) {
      throw new Error('Duplicate commit hash');
    }

    const revealDeadline = new Date(Date.now() + this.COMMIT_REVEAL_WINDOW);

    const commit: OrderCommit = {
      commitHash,
      userId,
      commitTimestamp: new Date(),
      revealDeadline,
      revealed: false,
    };

    this.commits.set(commitHash, commit);

    logger.info('Order committed', { userId, commitHash, revealDeadline });

    return {
      commitId: commitHash,
      revealDeadline,
    };
  }

  /**
   * MEV Protection: Phase 2 - Reveal Order
   * User reveals their order details matching the commit
   */
  async revealOrder(
    userId: string,
    commitHash: string,
    orderDetails: {
      orderType: OrderType;
      creditType: CreditType;
      quantity: string;
      price: string;
      salt: string;
      tokenId?: string;
      metadata?: CarbonCreditOrder['metadata'];
    },
    walletAddress: string
  ): Promise<CarbonCreditOrder> {
    // Verify commit exists and belongs to user
    const commit = this.commits.get(commitHash);
    if (!commit) {
      throw new Error('Commit not found');
    }
    if (commit.userId !== userId) {
      throw new Error('Commit does not belong to user');
    }
    if (commit.revealed) {
      throw new Error('Order already revealed');
    }
    if (new Date() > commit.revealDeadline) {
      throw new Error('Reveal deadline passed');
    }

    // Verify the reveal matches the commit
    const computedHash = this.computeOrderHash(orderDetails);
    if (computedHash !== commitHash) {
      throw new Error('Reveal does not match commit');
    }

    // Mark commit as revealed
    commit.revealed = true;
    this.commits.set(commitHash, commit);

    // Create the order
    const order = await this.createOrder({
      userId,
      walletAddress,
      orderType: orderDetails.orderType,
      creditType: orderDetails.creditType,
      quantity: BigInt(orderDetails.quantity),
      price: BigInt(orderDetails.price),
      tokenId: orderDetails.tokenId,
      metadata: orderDetails.metadata,
    });

    logger.info('Order revealed and created', { userId, orderId: order.id });

    return order;
  }

  /**
   * Direct order placement (for non-MEV-sensitive trades)
   */
  async createOrder(params: {
    userId: string;
    walletAddress: string;
    orderType: OrderType;
    creditType: CreditType;
    quantity: bigint;
    price: bigint;
    tokenId?: string;
    minPrice?: bigint;
    maxPrice?: bigint;
    expiresAt?: Date;
    metadata?: CarbonCreditOrder['metadata'];
  }): Promise<CarbonCreditOrder> {
    // Validate order parameters
    this.validateOrderParams(params);

    const order: CarbonCreditOrder = {
      id: crypto.randomUUID(),
      userId: params.userId,
      walletAddress: params.walletAddress,
      orderType: params.orderType,
      creditType: params.creditType,
      tokenId: params.tokenId,
      quantity: params.quantity,
      price: params.price,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      remainingQuantity: params.quantity,
      status: OrderStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: params.expiresAt || new Date(Date.now() + this.ORDER_EXPIRY_DEFAULT),
      metadata: params.metadata,
    };

    // Add to orders map
    this.orders.set(order.id, order);

    // Add to order book
    this.addToOrderBook(order);

    // Try to match immediately
    const matchedTrades = await this.matchOrder(order);

    this.emit('orderCreated', order);

    if (matchedTrades.length > 0) {
      this.emit('tradesExecuted', matchedTrades);
    }

    return order;
  }

  /**
   * Cancel an active order
   */
  async cancelOrder(orderId: string, userId: string): Promise<CarbonCreditOrder> {
    const order = this.orders.get(orderId);

    if (!order) {
      throw new Error('Order not found');
    }
    if (order.userId !== userId) {
      throw new Error('Not authorized to cancel this order');
    }
    if (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED) {
      throw new Error('Order cannot be cancelled');
    }

    // Remove from order book
    this.removeFromOrderBook(order);

    // Update order status
    order.status = OrderStatus.CANCELLED;
    order.updatedAt = new Date();
    this.orders.set(orderId, order);

    this.emit('orderCancelled', order);

    logger.info('Order cancelled', { orderId, userId });

    return order;
  }

  /**
   * Get current order book for a credit type
   */
  getOrderBook(creditType: CreditType): {
    bids: Array<{ price: string; quantity: string; orderCount: number }>;
    asks: Array<{ price: string; quantity: string; orderCount: number }>;
  } {
    const book = this.orderBooks.get(creditType);
    if (!book) {
      return { bids: [], asks: [] };
    }

    return {
      bids: book.bids.map(entry => ({
        price: entry.price.toString(),
        quantity: entry.orders.reduce((sum, o) => sum + o.remainingQuantity, 0n).toString(),
        orderCount: entry.orders.length,
      })),
      asks: book.asks.map(entry => ({
        price: entry.price.toString(),
        quantity: entry.orders.reduce((sum, o) => sum + o.remainingQuantity, 0n).toString(),
        orderCount: entry.orders.length,
      })),
    };
  }

  /**
   * Get market data for a credit type
   */
  getMarketData(creditType: CreditType): MarketData {
    const book = this.orderBooks.get(creditType);
    const recentTrades = this.trades
      .filter(t => t.creditType === creditType && t.status === 'SETTLED')
      .slice(-100);

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const trades24h = recentTrades.filter(t => t.executedAt > dayAgo);

    const lastTrade = recentTrades[recentTrades.length - 1];
    const prices24h = trades24h.map(t => t.price);

    return {
      creditType,
      lastPrice: lastTrade?.price ?? 0n,
      highPrice24h: prices24h.length > 0 ? prices24h.reduce((a, b) => a > b ? a : b) : 0n,
      lowPrice24h: prices24h.length > 0 ? prices24h.reduce((a, b) => a < b ? a : b) : 0n,
      volume24h: trades24h.reduce((sum, t) => sum + t.quantity, 0n),
      openInterest: this.calculateOpenInterest(creditType),
      bestBid: book?.bids[0]?.price ?? 0n,
      bestAsk: book?.asks[0]?.price ?? 0n,
      spread: book ? (book.asks[0]?.price ?? 0n) - (book.bids[0]?.price ?? 0n) : 0n,
      timestamp: now,
    };
  }

  /**
   * Get user's active orders
   */
  getUserOrders(userId: string): CarbonCreditOrder[] {
    return Array.from(this.orders.values())
      .filter(o => o.userId === userId && o.status !== OrderStatus.CANCELLED)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get user's trade history
   */
  getUserTrades(userId: string, limit = 50): Trade[] {
    return this.trades
      .filter(t => t.buyerId === userId || t.sellerId === userId)
      .slice(-limit);
  }

  // ==================== Private Methods ====================

  /**
   * Add order to the order book
   */
  private addToOrderBook(order: CarbonCreditOrder): void {
    const book = this.orderBooks.get(order.creditType);
    if (!book) return;

    const entries = order.orderType === OrderType.BUY ? book.bids : book.asks;

    // Find or create price level
    let entry = entries.find(e => e.price === order.price);
    if (!entry) {
      entry = { price: order.price, orders: [] };
      entries.push(entry);

      // Sort: bids descending, asks ascending
      if (order.orderType === OrderType.BUY) {
        entries.sort((a, b) => Number(b.price - a.price));
      } else {
        entries.sort((a, b) => Number(a.price - b.price));
      }
    }

    // Add order with time priority
    entry.orders.push(order);
  }

  /**
   * Remove order from the order book
   */
  private removeFromOrderBook(order: CarbonCreditOrder): void {
    const book = this.orderBooks.get(order.creditType);
    if (!book) return;

    const entries = order.orderType === OrderType.BUY ? book.bids : book.asks;

    for (const entry of entries) {
      const orderIndex = entry.orders.findIndex(o => o.id === order.id);
      if (orderIndex !== -1) {
        entry.orders.splice(orderIndex, 1);
        break;
      }
    }

    // Clean up empty price levels
    const newEntries = entries.filter(e => e.orders.length > 0);
    if (order.orderType === OrderType.BUY) {
      book.bids = newEntries;
    } else {
      book.asks = newEntries;
    }
  }

  /**
   * Match an order against the order book
   */
  private async matchOrder(order: CarbonCreditOrder): Promise<Trade[]> {
    const book = this.orderBooks.get(order.creditType);
    if (!book) return [];

    const trades: Trade[] = [];
    const oppositeEntries = order.orderType === OrderType.BUY ? book.asks : book.bids;

    for (const entry of oppositeEntries) {
      // Check price match
      if (order.orderType === OrderType.BUY && entry.price > order.price) {
        break; // No more matches possible
      }
      if (order.orderType === OrderType.SELL && entry.price < order.price) {
        break; // No more matches possible
      }

      // Match against orders at this price level (time priority)
      for (const matchingOrder of [...entry.orders]) {
        if (order.remainingQuantity === 0n) break;
        if (matchingOrder.walletAddress === order.walletAddress) continue; // No self-trade

        const trade = await this.executeTrade(order, matchingOrder);
        if (trade) {
          trades.push(trade);
        }
      }

      if (order.remainingQuantity === 0n) break;
    }

    return trades;
  }

  /**
   * Execute a trade between two orders
   */
  private async executeTrade(
    takerOrder: CarbonCreditOrder,
    makerOrder: CarbonCreditOrder
  ): Promise<Trade | null> {
    const tradeQuantity = takerOrder.remainingQuantity < makerOrder.remainingQuantity
      ? takerOrder.remainingQuantity
      : makerOrder.remainingQuantity;

    if (tradeQuantity === 0n) return null;

    // Use maker's price (price-time priority)
    const tradePrice = makerOrder.price;
    const totalValue = tradeQuantity * tradePrice / 1000000000000000000n; // Convert from wei
    const fee = totalValue * this.FEE_BASIS_POINTS / 10000n;

    const trade: Trade = {
      id: crypto.randomUUID(),
      buyOrderId: takerOrder.orderType === OrderType.BUY ? takerOrder.id : makerOrder.id,
      sellOrderId: takerOrder.orderType === OrderType.SELL ? takerOrder.id : makerOrder.id,
      buyerId: takerOrder.orderType === OrderType.BUY ? takerOrder.userId : makerOrder.userId,
      sellerId: takerOrder.orderType === OrderType.SELL ? takerOrder.userId : makerOrder.userId,
      creditType: takerOrder.creditType,
      tokenId: takerOrder.tokenId || makerOrder.tokenId,
      quantity: tradeQuantity,
      price: tradePrice,
      totalValue,
      fee,
      status: 'PENDING',
      executedAt: new Date(),
    };

    // Update order quantities
    takerOrder.remainingQuantity -= tradeQuantity;
    makerOrder.remainingQuantity -= tradeQuantity;

    // Update order statuses
    this.updateOrderStatus(takerOrder);
    this.updateOrderStatus(makerOrder);

    // Add trade to history
    this.trades.push(trade);

    logger.info('Trade executed', {
      tradeId: trade.id,
      buyerId: trade.buyerId,
      sellerId: trade.sellerId,
      quantity: tradeQuantity.toString(),
      price: tradePrice.toString(),
    });

    // Emit event for settlement
    this.emit('tradeExecuted', trade);

    return trade;
  }

  /**
   * Update order status based on remaining quantity
   */
  private updateOrderStatus(order: CarbonCreditOrder): void {
    if (order.remainingQuantity === 0n) {
      order.status = OrderStatus.FILLED;
      this.removeFromOrderBook(order);
    } else if (order.remainingQuantity < order.quantity) {
      order.status = OrderStatus.PARTIALLY_FILLED;
    }
    order.updatedAt = new Date();
    this.orders.set(order.id, order);
  }

  /**
   * Validate order parameters
   */
  private validateOrderParams(params: {
    quantity: bigint;
    price: bigint;
    walletAddress: string;
  }): void {
    if (params.quantity < this.MIN_ORDER_SIZE) {
      throw new Error('Order quantity below minimum');
    }
    if (params.price <= 0n) {
      throw new Error('Invalid price');
    }
    if (!ethers.isAddress(params.walletAddress)) {
      throw new Error('Invalid wallet address');
    }
  }

  /**
   * Compute order hash for commit-reveal
   */
  private computeOrderHash(orderDetails: {
    orderType: OrderType;
    creditType: CreditType;
    quantity: string;
    price: string;
    salt: string;
    tokenId?: string;
  }): string {
    const message = JSON.stringify({
      orderType: orderDetails.orderType,
      creditType: orderDetails.creditType,
      quantity: orderDetails.quantity,
      price: orderDetails.price,
      tokenId: orderDetails.tokenId,
      salt: orderDetails.salt,
    });

    return ethers.keccak256(ethers.toUtf8Bytes(message));
  }

  /**
   * Validate commit hash format
   */
  private isValidCommitHash(hash: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(hash);
  }

  /**
   * Calculate open interest for a credit type
   */
  private calculateOpenInterest(creditType: CreditType): bigint {
    return Array.from(this.orders.values())
      .filter(o =>
        o.creditType === creditType &&
        (o.status === OrderStatus.ACTIVE || o.status === OrderStatus.PARTIALLY_FILLED)
      )
      .reduce((sum, o) => sum + o.remainingQuantity, 0n);
  }

  /**
   * Process expired orders
   */
  private processExpiredOrders(): void {
    const now = new Date();

    for (const [orderId, order] of this.orders) {
      if (
        order.expiresAt &&
        order.expiresAt < now &&
        order.status !== OrderStatus.FILLED &&
        order.status !== OrderStatus.CANCELLED &&
        order.status !== OrderStatus.EXPIRED
      ) {
        this.removeFromOrderBook(order);
        order.status = OrderStatus.EXPIRED;
        order.updatedAt = now;
        this.orders.set(orderId, order);

        this.emit('orderExpired', order);
        logger.info('Order expired', { orderId });
      }
    }
  }

  /**
   * Process reveal deadlines for committed orders
   */
  private processRevealDeadlines(): void {
    const now = new Date();

    for (const [hash, commit] of this.commits) {
      if (!commit.revealed && commit.revealDeadline < now) {
        // Remove expired commit
        this.commits.delete(hash);
        logger.info('Commit expired without reveal', { commitHash: hash });
      }
    }
  }

  /**
   * Settle a trade on-chain
   */
  async settleTrade(tradeId: string, transactionHash: string): Promise<Trade> {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) {
      throw new Error('Trade not found');
    }
    if (trade.status === 'SETTLED') {
      throw new Error('Trade already settled');
    }

    trade.status = 'SETTLED';
    trade.transactionHash = transactionHash;
    trade.settledAt = new Date();

    this.emit('tradeSettled', trade);
    logger.info('Trade settled', { tradeId, transactionHash });

    return trade;
  }

  /**
   * Get trade by ID
   */
  getTrade(tradeId: string): Trade | undefined {
    return this.trades.find(t => t.id === tradeId);
  }

  /**
   * Get all pending trades for settlement
   */
  getPendingTrades(): Trade[] {
    return this.trades.filter(t => t.status === 'PENDING' || t.status === 'EXECUTED');
  }
}

// Singleton instance
export const carbonMarketplaceService = new CarbonMarketplaceService();
