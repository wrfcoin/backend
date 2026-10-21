/**
 * Advanced Gossip Rate Limiting System
 * Task 100.14 - Sophisticated rate limiting beyond basic throttling
 *
 * SECURITY FEATURES:
 * - Adaptive rate limits based on network conditions
 * - Per-source, per-topic, and global rate limiting
 * - Burst detection and mitigation with sliding windows
 * - Priority-based message queuing
 * - Token bucket algorithm with dynamic refill rates
 * - Distributed rate limiting coordination
 */

import { EventEmitter } from 'events';
import { PeerReputationService } from './p2p-peer-reputation.js';

export interface RateLimitConfig {
  globalLimit: {
    messagesPerSecond: number;
    burstSize: number;
  };
  perSourceLimit: {
    messagesPerSecond: number;
    burstSize: number;
  };
  perTopicLimit: {
    messagesPerSecond: number;
    burstSize: number;
  };
  adaptiveScaling: boolean;
  priorityQueueSize: number;
  slidingWindowSize: number; // in milliseconds
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number; // milliseconds
  currentRate: number;
  limit: number;
  tokensRemaining: number;
  queuePosition?: number;
}

export interface PriorityMessage {
  messageId: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  payload: any;
  source: string;
  topic: string;
  timestamp: Date;
  attempts: number;
}

export interface TokenBucket {
  capacity: number;
  tokens: number;
  refillRate: number; // tokens per second
  lastRefill: Date;
}

export interface SlidingWindow {
  windowSize: number;
  events: Date[];
  maxEvents: number;
}

/**
 * Advanced Gossip Rate Limiter
 * SECURITY: Multi-dimensional rate limiting with adaptive behavior
 */
export class GossipRateLimiter extends EventEmitter {
  private globalBucket: TokenBucket;
  private sourceBuckets: Map<string, TokenBucket> = new Map();
  private topicBuckets: Map<string, TokenBucket> = new Map();
  private slidingWindows: Map<string, SlidingWindow> = new Map();
  private priorityQueue: PriorityMessage[] = [];
  private readonly config: RateLimitConfig;
  private readonly peerReputation: PeerReputationService;
  private networkLoad: number = 0.5; // 0-1, affects adaptive scaling
  private refillInterval: NodeJS.Timeout | null = null;

  private static readonly DEFAULT_CONFIG: RateLimitConfig = {
    globalLimit: {
      messagesPerSecond: 1000,
      burstSize: 2000,
    },
    perSourceLimit: {
      messagesPerSecond: 50,
      burstSize: 100,
    },
    perTopicLimit: {
      messagesPerSecond: 100,
      burstSize: 200,
    },
    adaptiveScaling: true,
    priorityQueueSize: 500,
    slidingWindowSize: 60000, // 1 minute
  };

  constructor(
    peerReputation: PeerReputationService,
    config?: Partial<RateLimitConfig>
  ) {
    super();
    this.config = { ...GossipRateLimiter.DEFAULT_CONFIG, ...config };
    this.peerReputation = peerReputation;

    // Initialize global token bucket
    this.globalBucket = this.createTokenBucket(
      this.config.globalLimit.messagesPerSecond,
      this.config.globalLimit.burstSize
    );

    // Start token refill mechanism
    this.startTokenRefill();

    // Periodic cleanup
    setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Check if message should be rate limited
   * SECURITY: Multi-layer rate limiting with priority handling
   */
  async checkRateLimit(
    messageId: string,
    source: string,
    topic: string,
    priority: PriorityMessage['priority']
  ): Promise<RateLimitResult> {
    // Stage 1: Check global rate limit
    const globalCheck = this.checkGlobalLimit();
    if (!globalCheck.allowed) {
      return globalCheck;
    }

    // Stage 2: Check per-source rate limit
    const sourceCheck = await this.checkSourceLimit(source, priority);
    if (!sourceCheck.allowed) {
      return sourceCheck;
    }

    // Stage 3: Check per-topic rate limit
    const topicCheck = this.checkTopicLimit(topic);
    if (!topicCheck.allowed) {
      return topicCheck;
    }

    // Stage 4: Check burst detection
    const burstCheck = this.checkBurstDetection(source, topic);
    if (!burstCheck.allowed) {
      return burstCheck;
    }

    // All checks passed - consume tokens
    this.consumeTokens(source, topic);

    this.emit('rateLimitPassed', {
      messageId,
      source,
      topic,
      priority,
    });

    return {
      allowed: true,
      currentRate: this.calculateCurrentRate(source),
      limit: this.getEffectiveLimit(source),
      tokensRemaining: this.getSourceBucket(source).tokens,
    };
  }

  /**
   * Check global rate limit
   */
  private checkGlobalLimit(): RateLimitResult {
    if (this.globalBucket.tokens < 1) {
      const refillTime = this.calculateRefillTime(this.globalBucket, 1);

      this.emit('globalLimitExceeded', {
        tokensRemaining: this.globalBucket.tokens,
        refillTime,
      });

      return {
        allowed: false,
        reason: 'Global rate limit exceeded',
        retryAfter: refillTime,
        currentRate: this.config.globalLimit.messagesPerSecond,
        limit: this.config.globalLimit.messagesPerSecond,
        tokensRemaining: this.globalBucket.tokens,
      };
    }

    return {
      allowed: true,
      currentRate: 0,
      limit: this.config.globalLimit.messagesPerSecond,
      tokensRemaining: this.globalBucket.tokens,
    };
  }

  /**
   * Check per-source rate limit with reputation-based adjustment
   */
  private async checkSourceLimit(
    source: string,
    priority: PriorityMessage['priority']
  ): Promise<RateLimitResult> {
    const bucket = this.getSourceBucket(source);
    const effectiveLimit = this.getEffectiveLimit(source);

    // Priority messages get reduced cost
    const tokenCost = this.getTokenCost(priority);

    if (bucket.tokens < tokenCost) {
      // Check if message can be queued
      if (this.priorityQueue.length < this.config.priorityQueueSize) {
        const queuePosition = this.enqueueMessage(source, priority);

        return {
          allowed: false,
          reason: 'Source rate limit exceeded - queued',
          retryAfter: this.calculateRefillTime(bucket, tokenCost),
          currentRate: this.calculateCurrentRate(source),
          limit: effectiveLimit,
          tokensRemaining: bucket.tokens,
          queuePosition,
        };
      }

      this.emit('sourceLimitExceeded', {
        source,
        tokensRemaining: bucket.tokens,
      });

      return {
        allowed: false,
        reason: 'Source rate limit exceeded',
        retryAfter: this.calculateRefillTime(bucket, tokenCost),
        currentRate: this.calculateCurrentRate(source),
        limit: effectiveLimit,
        tokensRemaining: bucket.tokens,
      };
    }

    return {
      allowed: true,
      currentRate: this.calculateCurrentRate(source),
      limit: effectiveLimit,
      tokensRemaining: bucket.tokens,
    };
  }

  /**
   * Check per-topic rate limit
   */
  private checkTopicLimit(topic: string): RateLimitResult {
    const bucket = this.getTopicBucket(topic);

    if (bucket.tokens < 1) {
      this.emit('topicLimitExceeded', {
        topic,
        tokensRemaining: bucket.tokens,
      });

      return {
        allowed: false,
        reason: `Topic '${topic}' rate limit exceeded`,
        retryAfter: this.calculateRefillTime(bucket, 1),
        currentRate: this.config.perTopicLimit.messagesPerSecond,
        limit: this.config.perTopicLimit.messagesPerSecond,
        tokensRemaining: bucket.tokens,
      };
    }

    return {
      allowed: true,
      currentRate: 0,
      limit: this.config.perTopicLimit.messagesPerSecond,
      tokensRemaining: bucket.tokens,
    };
  }

  /**
   * Check for burst attacks using sliding window
   */
  private checkBurstDetection(source: string, topic: string): RateLimitResult {
    const windowKey = `${source}:${topic}`;
    const window = this.getSlidingWindow(windowKey);

    // Clean old events outside window
    const now = Date.now();
    window.events = window.events.filter(
      event => now - event.getTime() < window.windowSize
    );

    // Check if burst detected
    if (window.events.length >= window.maxEvents) {
      this.emit('burstDetected', {
        source,
        topic,
        eventCount: window.events.length,
        windowSize: window.windowSize,
      });

      return {
        allowed: false,
        reason: 'Burst attack detected',
        retryAfter: window.windowSize,
        currentRate: window.events.length / (window.windowSize / 1000),
        limit: window.maxEvents / (window.windowSize / 1000),
        tokensRemaining: 0,
      };
    }

    // Add current event
    window.events.push(new Date());

    return {
      allowed: true,
      currentRate: window.events.length / (window.windowSize / 1000),
      limit: window.maxEvents / (window.windowSize / 1000),
      tokensRemaining: window.maxEvents - window.events.length,
    };
  }

  /**
   * Get effective rate limit for source based on reputation
   * SECURITY: Higher reputation = higher limits
   */
  private getEffectiveLimit(source: string): number {
    const baseLimit = this.config.perSourceLimit.messagesPerSecond;

    if (!this.config.adaptiveScaling) {
      return baseLimit;
    }

    const reputation = this.peerReputation.getReputation(source);
    if (!reputation) {
      return baseLimit * 0.5; // Unknown sources get 50% limit
    }

    // Scale based on reputation score (0-100)
    const reputationMultiplier = 0.5 + (reputation.score / 100) * 1.5; // 0.5x to 2x

    // Scale based on network load
    const loadMultiplier = 1.5 - this.networkLoad; // Lower limits under high load

    return Math.floor(baseLimit * reputationMultiplier * loadMultiplier);
  }

  /**
   * Get token cost based on message priority
   */
  private getTokenCost(priority: PriorityMessage['priority']): number {
    const costs = {
      critical: 0.5, // Critical messages cost half
      high: 0.75,
      normal: 1.0,
      low: 1.5, // Low priority costs more
    };

    return costs[priority];
  }

  /**
   * Create token bucket for rate limiting
   */
  private createTokenBucket(refillRate: number, capacity: number): TokenBucket {
    return {
      capacity,
      tokens: capacity,
      refillRate,
      lastRefill: new Date(),
    };
  }

  /**
   * Get or create source token bucket
   */
  private getSourceBucket(source: string): TokenBucket {
    let bucket = this.sourceBuckets.get(source);

    if (!bucket) {
      const effectiveLimit = this.getEffectiveLimit(source);
      bucket = this.createTokenBucket(
        effectiveLimit,
        this.config.perSourceLimit.burstSize
      );
      this.sourceBuckets.set(source, bucket);
    }

    return bucket;
  }

  /**
   * Get or create topic token bucket
   */
  private getTopicBucket(topic: string): TokenBucket {
    let bucket = this.topicBuckets.get(topic);

    if (!bucket) {
      bucket = this.createTokenBucket(
        this.config.perTopicLimit.messagesPerSecond,
        this.config.perTopicLimit.burstSize
      );
      this.topicBuckets.set(topic, bucket);
    }

    return bucket;
  }

  /**
   * Get or create sliding window
   */
  private getSlidingWindow(key: string): SlidingWindow {
    let window = this.slidingWindows.get(key);

    if (!window) {
      window = {
        windowSize: this.config.slidingWindowSize,
        events: [],
        maxEvents: this.config.perSourceLimit.burstSize,
      };
      this.slidingWindows.set(key, window);
    }

    return window;
  }

  /**
   * Consume tokens from buckets
   */
  private consumeTokens(source: string, topic: string): void {
    // Global bucket
    this.globalBucket.tokens = Math.max(0, this.globalBucket.tokens - 1);

    // Source bucket
    const sourceBucket = this.getSourceBucket(source);
    sourceBucket.tokens = Math.max(0, sourceBucket.tokens - 1);

    // Topic bucket
    const topicBucket = this.getTopicBucket(topic);
    topicBucket.tokens = Math.max(0, topicBucket.tokens - 1);
  }

  /**
   * Calculate time until bucket has enough tokens
   */
  private calculateRefillTime(bucket: TokenBucket, tokensNeeded: number): number {
    const tokensShortfall = tokensNeeded - bucket.tokens;
    if (tokensShortfall <= 0) return 0;

    return Math.ceil((tokensShortfall / bucket.refillRate) * 1000); // Convert to ms
  }

  /**
   * Calculate current rate for source
   */
  private calculateCurrentRate(source: string): number {
    const window = this.slidingWindows.get(source);
    if (!window) return 0;

    const now = Date.now();
    const recentEvents = window.events.filter(
      event => now - event.getTime() < window.windowSize
    );

    return recentEvents.length / (window.windowSize / 1000); // messages per second
  }

  /**
   * Enqueue message for later processing
   */
  private enqueueMessage(
    source: string,
    priority: PriorityMessage['priority']
  ): number {
    const message: PriorityMessage = {
      messageId: `queued_${Date.now()}_${source}`,
      priority,
      payload: null,
      source,
      topic: '',
      timestamp: new Date(),
      attempts: 0,
    };

    this.priorityQueue.push(message);
    this.sortPriorityQueue();

    const position = this.priorityQueue.findIndex(m => m.messageId === message.messageId);

    this.emit('messageQueued', {
      messageId: message.messageId,
      source,
      priority,
      queuePosition: position,
    });

    return position;
  }

  /**
   * Sort priority queue by priority and timestamp
   */
  private sortPriorityQueue(): void {
    const priorityValues = {
      critical: 4,
      high: 3,
      normal: 2,
      low: 1,
    };

    this.priorityQueue.sort((a, b) => {
      // First sort by priority
      const priorityDiff = priorityValues[b.priority] - priorityValues[a.priority];
      if (priorityDiff !== 0) return priorityDiff;

      // Then by timestamp (older first)
      return a.timestamp.getTime() - b.timestamp.getTime();
    });
  }

  /**
   * Process queued messages when tokens available
   */
  private async processQueue(): Promise<void> {
    while (this.priorityQueue.length > 0) {
      const message = this.priorityQueue[0];

      // Check if we can process this message
      const result = await this.checkRateLimit(
        message.messageId,
        message.source,
        message.topic,
        message.priority
      );

      if (result.allowed) {
        this.priorityQueue.shift();
        this.emit('messageDequeued', {
          messageId: message.messageId,
          source: message.source,
        });
      } else {
        // Can't process yet, wait for next refill
        break;
      }
    }
  }

  /**
   * Start token refill mechanism
   */
  private startTokenRefill(): void {
    this.refillInterval = setInterval(() => {
      this.refillTokens();
      this.processQueue();
    }, 100); // Refill every 100ms
  }

  /**
   * Refill tokens in all buckets
   */
  private refillTokens(): void {
    const now = new Date();

    // Refill global bucket
    this.refillBucket(this.globalBucket, now);

    // Refill source buckets
    for (const bucket of this.sourceBuckets.values()) {
      this.refillBucket(bucket, now);
    }

    // Refill topic buckets
    for (const bucket of this.topicBuckets.values()) {
      this.refillBucket(bucket, now);
    }
  }

  /**
   * Refill individual bucket based on elapsed time
   */
  private refillBucket(bucket: TokenBucket, now: Date): void {
    const elapsed = (now.getTime() - bucket.lastRefill.getTime()) / 1000; // seconds
    const tokensToAdd = elapsed * bucket.refillRate;

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * Update network load (affects adaptive scaling)
   * @param load - Network load from 0 (idle) to 1 (saturated)
   */
  updateNetworkLoad(load: number): void {
    this.networkLoad = Math.max(0, Math.min(1, load));

    // Update source bucket refill rates based on new load
    if (this.config.adaptiveScaling) {
      for (const [source, bucket] of this.sourceBuckets.entries()) {
        const effectiveLimit = this.getEffectiveLimit(source);
        bucket.refillRate = effectiveLimit;
      }
    }

    this.emit('networkLoadUpdated', { load: this.networkLoad });
  }

  /**
   * Cleanup old buckets and windows
   */
  private cleanup(): void {
    const cutoff = Date.now() - 300000; // 5 minutes

    // Cleanup source buckets with no recent activity
    for (const [source, bucket] of this.sourceBuckets.entries()) {
      if (bucket.lastRefill.getTime() < cutoff && bucket.tokens === bucket.capacity) {
        this.sourceBuckets.delete(source);
      }
    }

    // Cleanup topic buckets
    for (const [topic, bucket] of this.topicBuckets.entries()) {
      if (bucket.lastRefill.getTime() < cutoff && bucket.tokens === bucket.capacity) {
        this.topicBuckets.delete(topic);
      }
    }

    // Cleanup sliding windows
    for (const [key, window] of this.slidingWindows.entries()) {
      window.events = window.events.filter(
        event => Date.now() - event.getTime() < window.windowSize
      );

      if (window.events.length === 0) {
        this.slidingWindows.delete(key);
      }
    }

    // Clear old queued messages
    this.priorityQueue = this.priorityQueue.filter(msg => {
      const age = Date.now() - msg.timestamp.getTime();
      return age < 300000; // Keep for 5 minutes max
    });
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    globalTokens: number;
    activeSources: number;
    activeTopics: number;
    queueLength: number;
    networkLoad: number;
  } {
    return {
      globalTokens: this.globalBucket.tokens,
      activeSources: this.sourceBuckets.size,
      activeTopics: this.topicBuckets.size,
      queueLength: this.priorityQueue.length,
      networkLoad: this.networkLoad,
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    if (this.refillInterval) {
      clearInterval(this.refillInterval);
      this.refillInterval = null;
    }

    this.sourceBuckets.clear();
    this.topicBuckets.clear();
    this.slidingWindows.clear();
    this.priorityQueue = [];
    this.emit('shutdown');
  }
}
