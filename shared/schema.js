/**
 * CommonJS version of the schema for use with scripts
 * This file mirrors the TypeScript schema but in CommonJS format
 */

const { drizzle } = require('drizzle-orm/neon-serverless');
const {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  varchar,
  json,
  doublePrecision,
  bigint,
  jsonb,
  uuid,
  decimal,
} = require('drizzle-orm/pg-core');
const { pgEnum } = require('drizzle-orm/pg-core');
const { relations } = require('drizzle-orm');

// Import LayerZero schema
const layerZeroSchema = require('./layer-zero-schema');

// Enums for identity and reputation systems
const identityVerificationLevelEnum = pgEnum('identity_verification_level', [
  'UNVERIFIED',
  'BASIC',
  'VERIFIED',
  'ENHANCED',
  'AUTHORITY',
]);
const identityTypeEnum = pgEnum('identity_type', [
  'INDIVIDUAL',
  'ORGANIZATION',
  'SERVICE',
  'DEVICE',
  'VALIDATOR',
]);
const credentialStatusEnum = pgEnum('credential_status', [
  'ACTIVE',
  'REVOKED',
  'SUSPENDED',
  'EXPIRED',
]);
const trustAnchorTypeEnum = pgEnum('trust_anchor_type', [
  'VALIDATOR',
  'AUTHORITY',
  'ORACLE',
  'COMMUNITY',
]);
const reputationFactorEnum = pgEnum('reputation_factor', [
  'BLOCK_VALIDATION',
  'TRANSACTION_VALIDATION',
  'DATA_SUBMISSION',
  'GOVERNANCE',
  'COMPUTATIONAL',
  'PROXIMITY',
  'PEER_ENDORSEMENT',
]);

// Enums for validators and slashing
const validatorStatusEnum = pgEnum('validator_status', [
  'ACTIVE', // Actively participating in consensus
  'INACTIVE', // Registered but not actively validating
  'JAILED', // Temporarily removed from validator set due to violations
  'TOMBSTONED', // Permanently removed due to severe violations
]);

const validatorRoleEnum = pgEnum('validator_role', [
  'VALIDATOR', // Standard validator
  'DATA_COLLECTOR', // Specialized in collecting weather data
  'COMPUTE', // Specialized in computational tasks
  'STORAGE_KEEPER', // Specialized in data storage
  'BRIDGE_OPERATOR', // Operates cross-chain bridges
]);

const slashingReasonEnum = pgEnum('slashing_reason', [
  'DOWNTIME', // Node offline beyond threshold
  'DOUBLE_SIGNING', // Validator signed conflicting blocks/states
  'INVALID_VALIDATION', // Validator approved invalid meteorological data
  'MALICIOUS_FORK', // Validator attempted to create an invalid fork
  'DATA_MANIPULATION', // Validator tampered with weather data
  'CONSENSUS_VIOLATION', // Other consensus rule violations
]);

const slashingSeverityEnum = pgEnum('slashing_severity', [
  'WARNING', // No actual slashing, just a warning
  'MINOR', // Small penalty (1-5%)
  'MODERATE', // Medium penalty (5-25%)
  'MAJOR', // Severe penalty (25-50%)
  'CRITICAL', // Extreme penalty (50-100%) and ejection from validator set
]);

// Enums for computational NFTs and tasks
const computationTypeEnum = pgEnum('computation_type', [
  'WEATHER_FORECAST',
  'CLIMATE_SIMULATION',
  'AIR_QUALITY',
  'GENERIC',
]);
const computationModelTypeEnum = pgEnum('computation_model_type', [
  'GFS',
  'WRF',
  'ECMWF',
  'CMAQ',
  'CUSTOM',
]);
const executionEnvironmentEnum = pgEnum('execution_environment', [
  'WASM',
  'DOCKER',
  'NATIVE',
  'VM',
]);
const taskStatusEnum = pgEnum('task_status', [
  'PENDING',
  'ASSIGNED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
const nodeStatusEnum = pgEnum('node_status', [
  'ONLINE',
  'OFFLINE',
  'BUSY',
  'MAINTENANCE',
  'SYNCING',
]);

// Enum for badge tier
const badgeTierEnum = pgEnum('badge_tier', [
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'DIAMOND',
]);

// Enum for achievement category
const achievementCategoryEnum = pgEnum('achievement_category', [
  'MINING',
  'GOVERNANCE',
  'CONTRIBUTION',
  'COMMUNITY',
  'COMPUTATION',
  'CROSS_CHAIN',
  'VALIDATION',
  'PARTICIPATION',
  'ENVIRONMENTAL',
  'SOCIAL',
]);

// Enum for achievement difficulty
const achievementDifficultyEnum = pgEnum('achievement_difficulty', [
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
]);

// Authentication related enums
const userStatusEnum = pgEnum('user_status', [
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'PENDING_VERIFICATION',
]);
const authTypeEnum = pgEnum('auth_type', [
  'PASSWORD',
  'WALLET',
  'OAUTH',
  'API_KEY',
]);

// Wallets table - can exist independently of user accounts
const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  address: varchar('address', { length: 64 }).notNull().unique(),
  network: varchar('network', { length: 20 }).notNull().default('testnet'),
  balance: decimal('balance', { precision: 20, scale: 8 })
    .notNull()
    .default('0'),
  lastUpdated: timestamp('last_updated').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  publicKey: text('public_key'),
  label: varchar('label', { length: 100 }),
  isActive: boolean('is_active').notNull().default(true),
  metadata: json('metadata'),
});

// Users table - Optional, only created when user wants enhanced features
const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 100 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  passwordHash: text('password_hash'),
  publicKey: text('public_key'),
  status: userStatusEnum('status').notNull().default('ACTIVE'),
  roles: json('roles').notNull().default(['user']),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastLogin: timestamp('last_login'),
  preferences: json('preferences'),
  profile: json('profile'), // For storing name, avatar, bio, etc.
  isEmailVerified: boolean('is_email_verified').notNull().default(false),
  verificationToken: text('verification_token'),
});

// Wallet-User associations - Allows multiple wallets per user and tracking wallet connections
const walletUserAssociations = pgTable('wallet_user_associations', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id')
    .notNull()
    .references(() => wallets.id),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  authType: authTypeEnum('auth_type').notNull().default('WALLET'),
  lastUsed: timestamp('last_used'),
  isAuthorized: boolean('is_authorized').notNull().default(true),
});

// Achievements table
const achievements = pgTable('achievements', {
  id: serial('id').primaryKey(),
  achievement_id: varchar('achievement_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(),
  category: achievementCategoryEnum('category').notNull(),
  icon_url: varchar('icon_url', { length: 255 }),
  difficulty: achievementDifficultyEnum('difficulty')
    .notNull()
    .default('COMMON'),
  requirements: json('requirements').notNull(),
  points: integer('points').notNull().default(10),
  governance_weight: integer('governance_weight').notNull().default(0), // Governance weight points
  reputation_boost: doublePrecision('reputation_boost').notNull().default(0), // Reputation multiplier
  tier: badgeTierEnum('tier').notNull().default('BRONZE'),
  active: boolean('active').notNull().default(true),
  display_order: integer('display_order').notNull().default(0),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  // Integration with WrfView app
  wrf_view_badge_id: varchar('wrf_view_badge_id', { length: 100 }),
  is_platform_synced: boolean('is_platform_synced').notNull().default(false),
});

// User earned achievements
const userAchievements = pgTable('user_achievements', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id),
  wallet_address: varchar('wallet_address', { length: 64 }).notNull(),
  achievement_id: varchar('achievement_id', { length: 64 })
    .references(() => achievements.achievement_id)
    .notNull(),
  awarded_at: timestamp('awarded_at').defaultNow().notNull(),
  is_visible: boolean('is_visible').notNull().default(true),
  progress: integer('progress').notNull().default(100),
  evidence_data: json('evidence_data'),
  transaction_id: varchar('transaction_id', { length: 64 }),
  is_displayed: boolean('is_displayed').notNull().default(true),
  // Badge related fields
  current_tier: badgeTierEnum('current_tier').notNull().default('BRONZE'),
  tier_progress: integer('tier_progress').notNull().default(0),
  next_tier_threshold: integer('next_tier_threshold'),
  badge_image_url: varchar('badge_image_url', { length: 255 }),
  // Integration with WrfView app
  wrfview_sync_status: varchar('wrfview_sync_status', { length: 20 })
    .notNull()
    .default('PENDING'), // PENDING, SYNCED, FAILED
  wrfview_sync_timestamp: timestamp('wrfview_sync_timestamp'),
  wrfview_data: json('wrfview_data'),
});

// Achievement progress tracking
const achievementProgress = pgTable('achievement_progress', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id),
  wallet_address: varchar('wallet_address', { length: 64 }).notNull(),
  achievement_id: varchar('achievement_id', { length: 64 })
    .references(() => achievements.achievement_id)
    .notNull(),
  current_value: integer('current_value').notNull().default(0),
  target_value: integer('target_value').notNull(),
  percentage_complete: integer('percentage_complete').notNull().default(0),
  last_updated: timestamp('last_updated').defaultNow().notNull(),
  tracking_data: json('tracking_data'),
});

// Achievement categories
const achievementCategories = pgTable('achievement_categories', {
  id: serial('id').primaryKey(),
  category: achievementCategoryEnum('category').notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon_url: varchar('icon_url', { length: 255 }),
  governance_multiplier: doublePrecision('governance_multiplier')
    .notNull()
    .default(1.0),
  reputation_multiplier: doublePrecision('reputation_multiplier')
    .notNull()
    .default(1.0),
  display_order: integer('display_order').notNull().default(0),
  is_active: boolean('is_active').notNull().default(true),
});

// Miner achievements (legacy compatibility)
const minerAchievements = pgTable('miner_achievements', {
  id: serial('id').primaryKey(),
  achievement_id: varchar('achievement_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  icon_url: varchar('icon_url', { length: 255 }),
  difficulty: varchar('difficulty', { length: 20 }).notNull().default('COMMON'),
  requirements: json('requirements').notNull(),
  points: integer('points').notNull().default(10),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Miner earned achievements (legacy compatibility)
const minerEarnedAchievements = pgTable('miner_earned_achievements', {
  id: serial('id').primaryKey(),
  miner_address: varchar('miner_address', { length: 64 }).notNull(),
  achievement_id: varchar('achievement_id', { length: 64 })
    .references(() => minerAchievements.achievement_id)
    .notNull(),
  awarded_at: timestamp('awarded_at').defaultNow().notNull(),
  is_visible: boolean('is_visible').notNull().default(true),
  progress: integer('progress').notNull().default(100),
  evidence_data: json('evidence_data'),
  transaction_id: varchar('transaction_id', { length: 64 }),
  is_displayed: boolean('is_displayed').notNull().default(true),
});

// Miner achievement progress table for tracking partial progress
const minerAchievementProgress = pgTable('miner_achievement_progress', {
  id: serial('id').primaryKey(),
  miner_address: varchar('miner_address', { length: 64 }).notNull(),
  achievement_id: varchar('achievement_id', { length: 64 })
    .references(() => achievements.achievement_id)
    .notNull(),
  progress_data: json('progress_data').notNull(),
  is_completed: boolean('is_completed').notNull().default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Define relations for miner achievement progress
const minerAchievementProgressRelations = relations(
  minerAchievementProgress,
  ({ one }) => ({
    achievement: one(achievements, {
      fields: [minerAchievementProgress.achievement_id],
      references: [achievements.achievement_id],
    }),
  })
);

// Wallet-User association relations
const walletUserAssociationsRelations = relations(
  walletUserAssociations,
  ({ one }) => ({
    wallet: one(wallets, {
      fields: [walletUserAssociations.walletId],
      references: [wallets.id],
    }),
    user: one(users, {
      fields: [walletUserAssociations.userId],
      references: [users.id],
    }),
  })
);

// Define user-wallet relations
const userRelations = relations(users, ({ many }) => ({
  walletAssociations: many(walletUserAssociations),
  achievements: many(userAchievements),
  achievementProgress: many(achievementProgress),
}));

const walletRelations = relations(wallets, ({ many }) => ({
  userAssociations: many(walletUserAssociations),
}));

// Define achievement relations
const achievementsRelations = relations(achievements, ({ many, one }) => ({
  earnedAchievements: many(userAchievements),
  progressTracking: many(achievementProgress),
  category: one(achievementCategories, {
    fields: [achievements.category],
    references: [achievementCategories.category],
  }),
}));

const userAchievementsRelations = relations(userAchievements, ({ one }) => ({
  achievement: one(achievements, {
    fields: [userAchievements.achievement_id],
    references: [achievements.achievement_id],
  }),
  user: one(users, {
    fields: [userAchievements.user_id],
    references: [users.id],
  }),
}));

const achievementProgressRelations = relations(
  achievementProgress,
  ({ one }) => ({
    achievement: one(achievements, {
      fields: [achievementProgress.achievement_id],
      references: [achievements.achievement_id],
    }),
    user: one(users, {
      fields: [achievementProgress.user_id],
      references: [users.id],
    }),
  })
);

const minerEarnedAchievementsRelations = relations(
  minerEarnedAchievements,
  ({ one }) => ({
    achievement: one(minerAchievements, {
      fields: [minerEarnedAchievements.achievement_id],
      references: [minerAchievements.achievement_id],
    }),
  })
);

// Validators
const validators = pgTable('validators', {
  id: serial('id').primaryKey(),
  validatorId: varchar('validator_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  walletAddress: varchar('wallet_address', { length: 64 }).notNull().unique(),
  publicKey: varchar('public_key', { length: 255 }).notNull().unique(),
  role: validatorRoleEnum('role').notNull().default('VALIDATOR'),
  status: validatorStatusEnum('status').notNull().default('INACTIVE'),
  stakedAmount: decimal('staked_amount', { precision: 20, scale: 8 })
    .notNull()
    .default('0'),
  commission: decimal('commission', { precision: 5, scale: 2 })
    .notNull()
    .default('5.00'),
  totalUptime: decimal('total_uptime', { precision: 5, scale: 2 })
    .notNull()
    .default('0'),
  reliability: decimal('reliability', { precision: 5, scale: 4 })
    .notNull()
    .default('1.0000'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastActive: timestamp('last_active'),
  lastStatusChange: timestamp('last_status_change'),
  lastSlashed: timestamp('last_slashed'),
  jailedAt: timestamp('jailed_at'),
  jailReleaseTime: timestamp('jail_release_time'),
  dataAccuracy: decimal('data_accuracy', { precision: 5, scale: 2 }), // For data validators
  computeCapacity: integer('compute_capacity'), // For compute validators
  storageCapacity: integer('storage_capacity'), // For storage validators
  location: varchar('location', { length: 100 }),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  hardware: json('hardware'),
  metadata: json('metadata'),
});

// Validator activity tracking
const validatorActivity = pgTable('validator_activity', {
  id: serial('id').primaryKey(),
  validatorId: integer('validator_id')
    .notNull()
    .references(() => validators.id),
  blockHeight: integer('block_height').notNull(),
  signedBlockHeight: integer('signed_block_height'),
  blockHash: varchar('block_hash', { length: 64 }),
  lastActiveBlockHeight: integer('last_active_block_height'),
  currentBlockHeight: integer('current_block_height'),
  missedBlocks: integer('missed_blocks').notNull().default(0),
  consecutiveMissedBlocks: integer('consecutive_missed_blocks')
    .notNull()
    .default(0),
  validations: integer('validations').notNull().default(0),
  successfulValidations: integer('successful_validations').notNull().default(0),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
});

// Slashing events
const slashEvents = pgTable('slash_events', {
  id: serial('id').primaryKey(),
  validatorId: integer('validator_id')
    .notNull()
    .references(() => validators.id),
  reason: slashingReasonEnum('reason').notNull(),
  severity: slashingSeverityEnum('severity').notNull(),
  penaltyPercentage: decimal('penalty_percentage', {
    precision: 5,
    scale: 2,
  }).notNull(),
  penaltyAmount: decimal('penalty_amount', { precision: 20, scale: 8 }),
  blockHeight: integer('block_height'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  details: json('details'),
});

// Validator delegation (for delegated proof of stake)
const validatorDelegations = pgTable('validator_delegations', {
  id: serial('id').primaryKey(),
  validatorId: integer('validator_id')
    .notNull()
    .references(() => validators.id),
  delegatorAddress: varchar('delegator_address', { length: 64 }).notNull(),
  amount: decimal('amount', { precision: 20, scale: 8 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  unbondingHeight: integer('unbonding_height'),
  unbondingTime: timestamp('unbonding_time'),
  isActive: boolean('is_active').notNull().default(true),
});

// Validator rewards
const validatorRewards = pgTable('validator_rewards', {
  id: serial('id').primaryKey(),
  validatorId: integer('validator_id')
    .notNull()
    .references(() => validators.id),
  blockHeight: integer('block_height').notNull(),
  amount: decimal('amount', { precision: 20, scale: 8 }).notNull(),
  rewardType: varchar('reward_type', { length: 50 }).notNull(), // block_reward, data_validation, computational, etc.
  timestamp: timestamp('timestamp').notNull().defaultNow(),
});

// Wolfram Plugin Settings
const wolframSettings = pgTable('wolfram_settings', {
  id: serial('id').primaryKey(),
  apiKey: varchar('api_key', { length: 255 }).notNull().default(''),
  useCaching: boolean('use_caching').notNull().default(true),
  cacheTTL: integer('cache_ttl')
    .notNull()
    .default(24 * 60 * 60 * 1000), // 24 hours in milliseconds
  useAlternativeEndpoint: boolean('use_alternative_endpoint')
    .notNull()
    .default(false),
  alternativeEndpoint: varchar('alternative_endpoint', { length: 255 }).default(
    ''
  ),
  maxQueriesPerDay: integer('max_queries_per_day').notNull().default(1000),
  preferShortAnswers: boolean('prefer_short_answers').notNull().default(true),
  timeoutMs: integer('timeout_ms').notNull().default(30000),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Define validator relationships
const validatorRelations = relations(validators, ({ many }) => ({
  activities: many(validatorActivity),
  slashEvents: many(slashEvents),
  delegations: many(validatorDelegations),
  rewards: many(validatorRewards),
}));

const validatorActivityRelations = relations(validatorActivity, ({ one }) => ({
  validator: one(validators, {
    fields: [validatorActivity.validatorId],
    references: [validators.id],
  }),
}));

const slashEventsRelations = relations(slashEvents, ({ one }) => ({
  validator: one(validators, {
    fields: [slashEvents.validatorId],
    references: [validators.id],
  }),
}));

const validatorDelegationsRelations = relations(
  validatorDelegations,
  ({ one }) => ({
    validator: one(validators, {
      fields: [validatorDelegations.validatorId],
      references: [validators.id],
    }),
  })
);

const validatorRewardsRelations = relations(validatorRewards, ({ one }) => ({
  validator: one(validators, {
    fields: [validatorRewards.validatorId],
    references: [validators.id],
  }),
}));

// Computational Nodes
const computationalNodes = pgTable('computational_nodes', {
  id: serial('id').primaryKey(),
  nodeId: varchar('node_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }),
  walletAddress: varchar('wallet_address', { length: 64 }).notNull(),
  ipAddress: varchar('ip_address', { length: 45 }),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  region: varchar('region', { length: 100 }),
  regionCode: varchar('region_code', { length: 10 }),
  capabilities: json('capabilities').notNull(),
  reliability: doublePrecision('reliability').notNull().default(1.0),
  status: nodeStatusEnum('status').notNull().default('ONLINE'),
  lastSeen: timestamp('last_seen').defaultNow().notNull(),
  cpuThreads: integer('cpu_threads'),
  memoryTotal: integer('memory_total'),
  diskSpace: integer('disk_space'),
  networkBandwidth: integer('network_bandwidth'),
  gpuInfo: json('gpu_info'),
  supportedComputationTypes: json('supported_computation_types'),
  performanceScore: integer('performance_score'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Computational NFTs
const computationalNfts = pgTable('computational_nfts', {
  id: serial('id').primaryKey(),
  nftId: varchar('nft_id', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  creator: varchar('creator', { length: 64 }).notNull(),
  owner: varchar('owner', { length: 64 }).notNull(),
  tokenStandard: varchar('token_standard', { length: 20 })
    .notNull()
    .default('ERC721'),
  computationType: computationTypeEnum('computation_type').notNull(),
  computationModel:
    computationModelTypeEnum('computation_model').default('CUSTOM'),
  executionEnvironment: executionEnvironmentEnum(
    'execution_environment'
  ).default('WASM'),
  storageProvider: varchar('storage_provider', { length: 50 }),
  resourceRequirements: json('resource_requirements').notNull(),
  inputData: text('input_data'),
  inputDataHash: varchar('input_data_hash', { length: 64 }),
  result: text('result'),
  resultHash: varchar('result_hash', { length: 64 }),
  parameters: json('parameters'),
  status: taskStatusEnum('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  isVerified: boolean('is_verified').notNull().default(false),
  verifiers: json('verifiers'),
  executor: varchar('executor', { length: 64 }),
  regionCode: varchar('region_code', { length: 10 }),
  regionLatitude: doublePrecision('region_latitude'),
  regionLongitude: doublePrecision('region_longitude'),
  dataType: computationTypeEnum('data_type').default('GENERIC'),
  timestampMs: bigint('timestamp_ms', { mode: 'number' }),
  resolution: varchar('resolution', { length: 50 }),
  resolutionValue: bigint('resolution_value', { mode: 'number' }),
  shardId: integer('shard_id'),
  forecastLength: integer('forecast_length'),
  updateFrequency: varchar('update_frequency', { length: 50 }),
  modelVersion: varchar('model_version', { length: 50 }),
  accuracy: integer('accuracy'),
  creatorReputation: integer('creator_reputation'),
  verificationSignatures: json('verification_signatures'),
  executionResultHash: varchar('execution_result_hash', { length: 64 }),
  metadata: json('metadata'),
  reward: integer('reward').notNull().default(0),
  creationTx: varchar('creation_tx', { length: 64 }),
  resultTx: varchar('result_tx', { length: 64 }),
  transactionId: integer('transaction_id'),
});

// Computational Tasks
const computationalTasks = pgTable('computational_tasks', {
  id: serial('id').primaryKey(),
  taskId: varchar('task_id', { length: 64 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  region: varchar('region', { length: 100 }),
  regionCode: varchar('region_code', { length: 10 }),
  computationType: computationTypeEnum('computation_type').notNull(),
  computationModel:
    computationModelTypeEnum('computation_model').default('CUSTOM'),
  executionEnvironment: executionEnvironmentEnum(
    'execution_environment'
  ).default('WASM'),
  priority: varchar('priority', { length: 20 }).notNull().default('STANDARD'),
  baseReward: integer('base_reward').notNull(),
  status: taskStatusEnum('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deadline: timestamp('deadline'),
  requiresVerification: boolean('requires_verification')
    .notNull()
    .default(false),
  dataMetrics: json('data_metrics'),
  resourceRequirements: json('resource_requirements'),
  assignedNodeId: integer('assigned_node_id'),
  nftId: integer('nft_id'),
  assignedAt: timestamp('assigned_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  resultHash: varchar('result_hash', { length: 64 }),
  verificationCount: integer('verification_count').default(0),
});

// Proximity incentives table
const proximityIncentives = pgTable('proximity_incentives', {
  id: serial('id').primaryKey(),
  incentiveId: varchar('incentive_id', { length: 64 }).notNull().unique(),
  taskId: integer('task_id'),
  nodeId: integer('node_id'),
  distanceKm: doublePrecision('distance_km').notNull(),
  distanceTier: varchar('distance_tier', { length: 20 }).notNull(),
  baseReward: integer('base_reward').notNull(),
  finalReward: integer('final_reward').notNull(),
  totalMultiplier: doublePrecision('total_multiplier').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('CALCULATED'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  metrics: json('metrics'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Define relations for computational components
const computationalNodesRelations = relations(
  computationalNodes,
  ({ many }) => ({
    tasks: many(computationalTasks),
  })
);

const computationalTasksRelations = relations(
  computationalTasks,
  ({ one, many }) => ({
    assignedNode: one(computationalNodes, {
      fields: [computationalTasks.assignedNodeId],
      references: [computationalNodes.id],
    }),
    nft: one(computationalNfts, {
      fields: [computationalTasks.nftId],
      references: [computationalNfts.id],
    }),
  })
);

const proximityIncentivesRelations = relations(
  proximityIncentives,
  ({ one }) => ({
    task: one(computationalTasks, {
      fields: [proximityIncentives.taskId],
      references: [computationalTasks.id],
    }),
    node: one(computationalNodes, {
      fields: [proximityIncentives.nodeId],
      references: [computationalNodes.id],
    }),
  })
);

module.exports = {
  // Achievement tables
  achievements,
  userAchievements,
  achievementProgress,
  achievementCategories,
  minerAchievements,
  minerEarnedAchievements,
  minerAchievementProgress,

  // Validator and Slashing tables
  validators,
  validatorActivity,
  slashEvents,
  validatorDelegations,
  validatorRewards,

  // Plugin settings
  wolframSettings,

  // Validator and Slashing relations
  validatorRelations,
  validatorActivityRelations,
  slashEventsRelations,
  validatorDelegationsRelations,
  validatorRewardsRelations,

  // Computational tables
  computationalNodes,
  computationalNfts,
  computationalTasks,
  proximityIncentives,

  // Enums
  badgeTierEnum,
  achievementCategoryEnum,
  achievementDifficultyEnum,
  identityVerificationLevelEnum,
  identityTypeEnum,
  credentialStatusEnum,
  trustAnchorTypeEnum,
  reputationFactorEnum,
  computationTypeEnum,
  computationModelTypeEnum,
  executionEnvironmentEnum,
  taskStatusEnum,
  nodeStatusEnum,

  // User and wallet tables
  users,
  wallets,
  walletUserAssociations,
  userStatusEnum,
  authTypeEnum,

  // Relations
  achievementsRelations,
  userAchievementsRelations,
  achievementProgressRelations,
  minerEarnedAchievementsRelations,
  computationalNodesRelations,
  computationalTasksRelations,
  proximityIncentivesRelations,

  // User-wallet relations
  userRelations,
  walletRelations,
  walletUserAssociationsRelations,

  // Add the new minerAchievementProgress relations
  minerAchievementProgressRelations,
};
