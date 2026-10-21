/**
 * Carbon Credit Marketplace Service Unit Tests
 * Location: tests/unit/carbon-credit/marketplace-service.test.ts
 * Coverage: Order book management, matching, MEV protection, trade execution
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'crypto';

// Override the global ethers mock with real crypto implementations
// so that keccak256 produces different hashes for different inputs.
jest.mock('ethers', () => {
  const realKeccak256 = (data: Uint8Array | string): string => {
    const buf = typeof data === 'string'
      ? Buffer.from(data.replace(/^0x/, ''), 'hex')
      : Buffer.from(data);
    return '0x' + crypto.createHash('sha256').update(buf).digest('hex');
  };
  const realToUtf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const mockIsAddress = (addr: string) => /^0x[a-fA-F0-9]{40}$/.test(addr);

  class MockWallet {
    address = '0x' + 'c'.repeat(40);
    privateKey = '0x' + 'a'.repeat(64);
    publicKey = '0x04' + 'b'.repeat(128);
    connect = jest.fn().mockReturnThis();
    signMessage = jest.fn().mockResolvedValue('0x' + 'd'.repeat(130) as never);
  }
  (MockWallet as any).createRandom = jest.fn(() => new MockWallet());

  const ethersMock = {
    isAddress: jest.fn(mockIsAddress),
    keccak256: jest.fn(realKeccak256),
    toUtf8Bytes: jest.fn(realToUtf8Bytes),
    Wallet: Object.assign(MockWallet, { createRandom: (MockWallet as any).createRandom }),
    Contract: jest.fn(),
    hashMessage: jest.fn((data: any) => realKeccak256(data)),
    recoverAddress: jest.fn(() => '0x' + 'c'.repeat(40)),
    computeAddress: jest.fn(() => '0x' + 'c'.repeat(40)),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  };

  return {
    ...ethersMock,
    ethers: ethersMock,
  };
});

import { ethers } from 'ethers';

// Mock the logger
jest.mock('../../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Import after mocking
import {
  CarbonMarketplaceService,
  OrderType,
  OrderStatus,
  CreditType,
  type CarbonCreditOrder,
  type Trade,
} from '../../services/carbon-marketplace-service';

describe('CarbonMarketplaceService', () => {
  let marketplace: CarbonMarketplaceService;
  const validWalletAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f8dB03';
  const secondWalletAddress = '0x8Ba1f109551bD432803012645Ac136ddd64DBA72';

  beforeEach(() => {
    marketplace = new CarbonMarketplaceService();
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any intervals
    jest.clearAllTimers();
  });

  describe('Order Creation', () => {
    it('should create a valid buy order', async () => {
      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'), // 1 credit
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
      expect(order.orderType).toBe(OrderType.BUY);
      expect(order.creditType).toBe(CreditType.VCS);
      expect(order.status).toBe(OrderStatus.ACTIVE);
      expect(order.remainingQuantity).toBe(order.quantity);
    });

    it('should create a valid sell order', async () => {
      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.GOLD_STANDARD,
        quantity: BigInt('2000000000000000000'), // 2 credits
        price: BigInt('75000000000000000000'), // 75 WRF
        metadata: {
          vintageYear: 2024,
          projectId: 'proj-123',
          projectType: 'reforestation',
        },
      });

      expect(order).toBeDefined();
      expect(order.orderType).toBe(OrderType.SELL);
      expect(order.creditType).toBe(CreditType.GOLD_STANDARD);
      expect(order.metadata?.vintageYear).toBe(2024);
    });

    it('should reject order with quantity below minimum', async () => {
      await expect(
        marketplace.createOrder({
          userId: 'user-1',
          walletAddress: validWalletAddress,
          orderType: OrderType.BUY,
          creditType: CreditType.VCS,
          quantity: BigInt('100'), // Too small
          price: BigInt('50000000000000000000'),
        })
      ).rejects.toThrow('Order quantity below minimum');
    });

    it('should reject order with invalid price', async () => {
      await expect(
        marketplace.createOrder({
          userId: 'user-1',
          walletAddress: validWalletAddress,
          orderType: OrderType.BUY,
          creditType: CreditType.VCS,
          quantity: BigInt('1000000000000000000'),
          price: BigInt('0'),
        })
      ).rejects.toThrow('Invalid price');
    });

    it('should reject order with invalid wallet address', async () => {
      await expect(
        marketplace.createOrder({
          userId: 'user-1',
          walletAddress: 'invalid-address',
          orderType: OrderType.BUY,
          creditType: CreditType.VCS,
          quantity: BigInt('1000000000000000000'),
          price: BigInt('50000000000000000000'),
        })
      ).rejects.toThrow('Invalid wallet address');
    });
  });

  describe('Order Book Management', () => {
    it('should add buy orders to bids sorted by price descending', async () => {
      // Create buy orders at different prices
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('40000000000000000000'), // 40 WRF
      });

      await marketplace.createOrder({
        userId: 'user-2',
        walletAddress: secondWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('60000000000000000000'), // 60 WRF
      });

      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      const orderBook = marketplace.getOrderBook(CreditType.VCS);

      expect(orderBook.bids.length).toBe(3);
      // Bids should be sorted highest price first
      expect(BigInt(orderBook.bids[0].price)).toBe(BigInt('60000000000000000000'));
      expect(BigInt(orderBook.bids[1].price)).toBe(BigInt('50000000000000000000'));
      expect(BigInt(orderBook.bids[2].price)).toBe(BigInt('40000000000000000000'));
    });

    it('should add sell orders to asks sorted by price ascending', async () => {
      // Create sell orders at different prices
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('60000000000000000000'), // 60 WRF
      });

      await marketplace.createOrder({
        userId: 'user-2',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('40000000000000000000'), // 40 WRF
      });

      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      const orderBook = marketplace.getOrderBook(CreditType.VCS);

      expect(orderBook.asks.length).toBe(3);
      // Asks should be sorted lowest price first
      expect(BigInt(orderBook.asks[0].price)).toBe(BigInt('40000000000000000000'));
      expect(BigInt(orderBook.asks[1].price)).toBe(BigInt('50000000000000000000'));
      expect(BigInt(orderBook.asks[2].price)).toBe(BigInt('60000000000000000000'));
    });

    it('should separate order books by credit type', async () => {
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.GOLD_STANDARD,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('75000000000000000000'),
      });

      const vcsOrderBook = marketplace.getOrderBook(CreditType.VCS);
      const gsOrderBook = marketplace.getOrderBook(CreditType.GOLD_STANDARD);

      expect(vcsOrderBook.bids.length).toBe(1);
      expect(gsOrderBook.bids.length).toBe(1);
      expect(BigInt(vcsOrderBook.bids[0].price)).toBe(BigInt('50000000000000000000'));
      expect(BigInt(gsOrderBook.bids[0].price)).toBe(BigInt('75000000000000000000'));
    });
  });

  describe('Order Matching and Trade Execution', () => {
    it('should match buy order with sell order at same price', async () => {
      // First create a sell order
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'), // 1 credit
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      // Then create a matching buy order
      const buyOrder = await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'), // 1 credit
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      // Both orders should be filled
      expect(buyOrder.status).toBe(OrderStatus.FILLED);
      expect(buyOrder.remainingQuantity).toBe(BigInt(0));

      // Check trade history
      const trades = marketplace.getUserTrades('buyer-1');
      expect(trades.length).toBe(1);
      expect(trades[0].quantity).toBe(BigInt('1000000000000000000'));
      expect(trades[0].buyerId).toBe('buyer-1');
      expect(trades[0].sellerId).toBe('seller-1');
    });

    it('should match buy order with sell order at better price', async () => {
      // Create sell order at lower price
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('45000000000000000000'), // 45 WRF (seller wants less)
      });

      // Create buy order at higher price
      const buyOrder = await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'), // 50 WRF (buyer willing to pay more)
      });

      // Both should be filled, trade at maker's price (45 WRF)
      expect(buyOrder.status).toBe(OrderStatus.FILLED);

      const trades = marketplace.getUserTrades('buyer-1');
      expect(trades.length).toBe(1);
      expect(trades[0].price).toBe(BigInt('45000000000000000000'));
    });

    it('should partially fill orders with mismatched quantities', async () => {
      // Create large sell order
      const sellOrder = await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('5000000000000000000'), // 5 credits
        price: BigInt('50000000000000000000'),
      });

      // Create smaller buy order
      const buyOrder = await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('2000000000000000000'), // 2 credits
        price: BigInt('50000000000000000000'),
      });

      // Buy order should be filled
      expect(buyOrder.status).toBe(OrderStatus.FILLED);
      expect(buyOrder.remainingQuantity).toBe(BigInt(0));

      // Sell order should be partially filled
      const updatedSellOrder = marketplace.getUserOrders('seller-1')[0];
      expect(updatedSellOrder.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(updatedSellOrder.remainingQuantity).toBe(BigInt('3000000000000000000'));
    });

    it('should not match orders from same wallet (no self-trade)', async () => {
      // Create sell order
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      // Create buy order from same wallet
      const buyOrder = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      // Both orders should remain active (not matched)
      expect(buyOrder.status).toBe(OrderStatus.ACTIVE);
      expect(buyOrder.remainingQuantity).toBe(BigInt('1000000000000000000'));
    });

    it('should not match orders with non-crossing prices', async () => {
      // Create sell order at high price
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('60000000000000000000'), // 60 WRF
      });

      // Create buy order at lower price
      const buyOrder = await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'), // 50 WRF
      });

      // Both orders should remain active
      expect(buyOrder.status).toBe(OrderStatus.ACTIVE);
    });
  });

  describe('Order Cancellation', () => {
    it('should cancel an active order', async () => {
      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      const cancelledOrder = await marketplace.cancelOrder(order.id, 'user-1');

      expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);
    });

    it('should remove cancelled order from order book', async () => {
      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.cancelOrder(order.id, 'user-1');

      const orderBook = marketplace.getOrderBook(CreditType.VCS);
      expect(orderBook.bids.length).toBe(0);
    });

    it('should reject cancellation by non-owner', async () => {
      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await expect(
        marketplace.cancelOrder(order.id, 'user-2')
      ).rejects.toThrow('Not authorized to cancel this order');
    });

    it('should reject cancellation of already filled order', async () => {
      // Create matching orders
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      const buyOrder = await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      // Try to cancel the filled buy order
      await expect(
        marketplace.cancelOrder(buyOrder.id, 'buyer-1')
      ).rejects.toThrow('Order cannot be cancelled');
    });
  });

  describe('MEV Protection (Commit-Reveal)', () => {
    it('should accept valid commit hash', async () => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes('test-order-details'));

      const result = await marketplace.commitOrder('user-1', hash);

      expect(result.commitId).toBe(hash);
      expect(result.revealDeadline).toBeInstanceOf(Date);
      expect(result.revealDeadline.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject invalid commit hash format', async () => {
      await expect(
        marketplace.commitOrder('user-1', 'invalid-hash')
      ).rejects.toThrow('Invalid commit hash format');
    });

    it('should reject duplicate commit hash', async () => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes('test-order-details'));

      await marketplace.commitOrder('user-1', hash);

      await expect(
        marketplace.commitOrder('user-2', hash)
      ).rejects.toThrow('Duplicate commit hash');
    });

    it('should reveal order matching commit', async () => {
      const orderDetails = {
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: '1000000000000000000',
        price: '50000000000000000000',
        salt: 'random-salt-123',
      };

      const message = JSON.stringify({
        orderType: orderDetails.orderType,
        creditType: orderDetails.creditType,
        quantity: orderDetails.quantity,
        price: orderDetails.price,
        tokenId: undefined,
        salt: orderDetails.salt,
      });

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes(message));

      await marketplace.commitOrder('user-1', commitHash);

      const order = await marketplace.revealOrder(
        'user-1',
        commitHash,
        orderDetails,
        validWalletAddress
      );

      expect(order).toBeDefined();
      expect(order.orderType).toBe(OrderType.BUY);
      expect(order.status).toBe(OrderStatus.ACTIVE);
    });

    it('should reject reveal from wrong user', async () => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes('test'));

      await marketplace.commitOrder('user-1', hash);

      await expect(
        marketplace.revealOrder(
          'user-2',
          hash,
          {
            orderType: OrderType.BUY,
            creditType: CreditType.VCS,
            quantity: '1000000000000000000',
            price: '50000000000000000000',
            salt: 'salt',
          },
          validWalletAddress
        )
      ).rejects.toThrow('Commit does not belong to user');
    });

    it('should reject reveal with mismatched hash', async () => {
      const orderDetails = {
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: '1000000000000000000',
        price: '50000000000000000000',
        salt: 'salt-1',
      };

      // Use a hash that is valid format but does NOT match the orderDetails
      // This is computed from completely different content
      const commitHash = ethers.keccak256(ethers.toUtf8Bytes('this-is-completely-different-content-that-will-not-match'));

      await marketplace.commitOrder('user-1', commitHash);

      await expect(
        marketplace.revealOrder('user-1', commitHash, orderDetails, validWalletAddress)
      ).rejects.toThrow('Reveal does not match commit');
    });

    it('should reject duplicate reveal', async () => {
      const orderDetails = {
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: '1000000000000000000',
        price: '50000000000000000000',
        salt: 'random-salt-456',
      };

      const message = JSON.stringify({
        orderType: orderDetails.orderType,
        creditType: orderDetails.creditType,
        quantity: orderDetails.quantity,
        price: orderDetails.price,
        tokenId: undefined,
        salt: orderDetails.salt,
      });

      const commitHash = ethers.keccak256(ethers.toUtf8Bytes(message));

      await marketplace.commitOrder('user-1', commitHash);
      await marketplace.revealOrder('user-1', commitHash, orderDetails, validWalletAddress);

      await expect(
        marketplace.revealOrder('user-1', commitHash, orderDetails, validWalletAddress)
      ).rejects.toThrow('Order already revealed');
    });
  });

  describe('Market Data', () => {
    it('should return market data for credit type', async () => {
      // Create some orders
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('48000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'user-2',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('52000000000000000000'),
      });

      const marketData = marketplace.getMarketData(CreditType.VCS);

      expect(marketData.creditType).toBe(CreditType.VCS);
      expect(marketData.bestBid).toBe(BigInt('48000000000000000000'));
      expect(marketData.bestAsk).toBe(BigInt('52000000000000000000'));
      expect(marketData.spread).toBe(BigInt('4000000000000000000'));
      expect(marketData.timestamp).toBeInstanceOf(Date);
    });

    it('should calculate open interest correctly', async () => {
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('2000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'user-2',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('3000000000000000000'),
        price: BigInt('55000000000000000000'),
      });

      const marketData = marketplace.getMarketData(CreditType.VCS);

      expect(marketData.openInterest).toBe(BigInt('5000000000000000000'));
    });
  });

  describe('Trade Settlement', () => {
    it('should settle a trade with transaction hash', async () => {
      // Create and match orders to generate a trade
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      const trades = marketplace.getPendingTrades();
      expect(trades.length).toBeGreaterThan(0);

      const txHash = '0x' + 'a'.repeat(64);
      const settledTrade = await marketplace.settleTrade(trades[0].id, txHash);

      expect(settledTrade.status).toBe('SETTLED');
      expect(settledTrade.transactionHash).toBe(txHash);
      expect(settledTrade.settledAt).toBeInstanceOf(Date);
    });

    it('should reject settlement of non-existent trade', async () => {
      await expect(
        marketplace.settleTrade('non-existent-id', '0x' + 'a'.repeat(64))
      ).rejects.toThrow('Trade not found');
    });

    it('should reject double settlement', async () => {
      // Create and match orders
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      const trades = marketplace.getPendingTrades();
      const txHash = '0x' + 'a'.repeat(64);

      await marketplace.settleTrade(trades[0].id, txHash);

      await expect(
        marketplace.settleTrade(trades[0].id, '0x' + 'b'.repeat(64))
      ).rejects.toThrow('Trade already settled');
    });
  });

  describe('User Orders and Trades', () => {
    it('should return user active orders', async () => {
      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.GOLD_STANDARD,
        quantity: BigInt('2000000000000000000'),
        price: BigInt('75000000000000000000'),
      });

      const userOrders = marketplace.getUserOrders('user-1');

      expect(userOrders.length).toBe(2);
      expect(userOrders[0].userId).toBe('user-1');
    });

    it('should return user trade history', async () => {
      // Create matching orders to generate trades
      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      const buyerTrades = marketplace.getUserTrades('buyer-1');
      const sellerTrades = marketplace.getUserTrades('seller-1');

      expect(buyerTrades.length).toBe(1);
      expect(sellerTrades.length).toBe(1);
      expect(buyerTrades[0].buyerId).toBe('buyer-1');
      expect(sellerTrades[0].sellerId).toBe('seller-1');
    });
  });

  describe('Event Emission', () => {
    it('should emit orderCreated event', async () => {
      const eventHandler = jest.fn();
      marketplace.on('orderCreated', eventHandler);

      await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit tradeExecuted event on match', async () => {
      const eventHandler = jest.fn();
      marketplace.on('tradeExecuted', eventHandler);

      await marketplace.createOrder({
        userId: 'seller-1',
        walletAddress: secondWalletAddress,
        orderType: OrderType.SELL,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.createOrder({
        userId: 'buyer-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit orderCancelled event', async () => {
      const eventHandler = jest.fn();
      marketplace.on('orderCancelled', eventHandler);

      const order = await marketplace.createOrder({
        userId: 'user-1',
        walletAddress: validWalletAddress,
        orderType: OrderType.BUY,
        creditType: CreditType.VCS,
        quantity: BigInt('1000000000000000000'),
        price: BigInt('50000000000000000000'),
      });

      await marketplace.cancelOrder(order.id, 'user-1');

      expect(eventHandler).toHaveBeenCalledTimes(1);
    });
  });
});
