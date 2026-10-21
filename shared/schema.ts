import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  primaryKey,
  decimal,
  real,
  date,
  index,
  doublePrecision,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  proposals,
  votes,
  parameters,
  delegations,
  parameterHistory,
  proposalsRelations,
  votesRelations,
  parametersRelations,
  parameterHistoryRelations,
} from './governance-schema.js';
import {
  userMfaSettings,
  mfaAttempts,
  userSessions,
  trustedDevices,
  mfaBackupCodeUsage,
  smsVerificationCodes,
  securityEvents,
  userMfaSettingsRelations,
  mfaAttemptsRelations,
  userSessionsRelations,
  trustedDevicesRelations,
  mfaBackupCodeUsageRelations,
  smsVerificationCodesRelations,
  securityEventsRelations,
} from './mfa-schema.js';
import {
  files,
  filePermissions,
  fileAccessLogs,
  fileShares,
  filesRelations,
  filePermissionsRelations,
  fileAccessLogsRelations,
  fileSharesRelations,
  PERMISSION_LEVELS,
  FILE_VISIBILITY,
  type File,
  type InsertFile,
  type FilePermission,
  type InsertFilePermission,
  type FileAccessLog,
  type InsertFileAccessLog,
  type FileShare,
  type InsertFileShare,
  type PermissionLevel,
  type FileVisibility,
} from './file-schema.js';
import {
  lineageRecords,
  type LineageRecord,
  type InsertLineageRecord,
} from './schema-lineage.js';
import {
  marketplaceSubscriptions,
  marketplaceUsage,
  academicApplications,
  MARKETPLACE_TIERS,
  TIER_DAILY_LIMITS,
  ACADEMIC_STATUS,
  type MarketplaceTier,
  type MarketplaceSubscription,
  type NewMarketplaceSubscription,
  type MarketplaceUsage,
  type AcademicApplication,
  type NewAcademicApplication,
  type AcademicStatus,
} from './schema-marketplace.js';

// Cross-Chain Integration Types
export const BRIDGE_PROVIDERS = [
  'AXELAR',
  'LAYERZERO',
  'WORMHOLE',
  'CHAINLINK_CCIP',
  'POLYGON_ZKEVM',
  'CUSTOM',
] as const;

export const BRIDGE_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'MAINTENANCE',
  'DEPRECATED',
] as const;

// Users table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email'),
  walletAddress: text('wallet_address').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastLogin: timestamp('last_login'),
  status: text('status').notNull().default('active'),
  role: text('role').notNull().default('user'),
  preferences: jsonb('preferences'),
  profilePicture: text('profile_picture'),
  reputation: integer('reputation').default(0),
  displayName: text('display_name'),
  bio: text('bio'),
  avatar: text('avatar'),
  location: text('location'),
  isVerified: boolean('is_verified').default(false),
  lastActiveAt: timestamp('last_active_at'),
  passwordHash: text('password_hash'),
  mfaEnabled: boolean('mfa_enabled').default(false),
  permissions: jsonb('permissions'),
});

// Transactions table
export const transactions = pgTable('transactions', {
  id: serial('id').primaryKey(),
  txId: text('tx_id').notNull().unique(),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  amount: integer('amount').notNull(),
  fee: integer('fee').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  status: text('status').notNull(),
  type: text('type').notNull(),
  blockId: integer('block_id'),
  data: jsonb('data'),
}, (table) => ({
  fromAddressIdx: index('idx_transactions_from_address').on(table.fromAddress),
  toAddressIdx: index('idx_transactions_to_address').on(table.toAddress),
  timestampIdx: index('idx_transactions_timestamp').on(table.timestamp),
  statusIdx: index('idx_transactions_status').on(table.status),
  blockIdIdx: index('idx_transactions_block_id').on(table.blockId),
}));

// Blocks table
export const blocks = pgTable('blocks', {
  id: serial('id').primaryKey(),
  blockId: text('block_id').notNull().unique(),
  height: integer('height').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  hash: text('hash').notNull(),
  prevHash: text('prev_hash').notNull(),
  transactionCount: integer('transaction_count').notNull(),
  difficulty: integer('difficulty').notNull(),
  size: integer('size').notNull(),
  validator: text('validator'),
  merkleRoot: text('merkle_root').notNull(),
  nonce: text('nonce'),
  blockType: text('block_type').notNull().default('standard'),
  signature: text('signature'),
  metadata: jsonb('metadata'),
}, (table) => ({
  heightIdx: index('idx_blocks_height').on(table.height),
  timestampIdx: index('idx_blocks_timestamp').on(table.timestamp),
  validatorIdx: index('idx_blocks_validator').on(table.validator),
}));

// NFTs table
export const nfts = pgTable('nfts', {
  id: serial('id').primaryKey(),
  nftId: text('nft_id').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  creator: text('creator').notNull(),
  owner: text('owner').notNull(),
  contentUri: text('content_uri'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  transactionId: text('transaction_id'),
  metadata: jsonb('metadata'),
  nftType: text('nft_type').notNull().default('standard'),
}, (table) => ({
  creatorIdx: index('idx_nfts_creator').on(table.creator),
  ownerIdx: index('idx_nfts_owner').on(table.owner),
  nftTypeIdx: index('idx_nfts_type').on(table.nftType),
  createdAtIdx: index('idx_nfts_created_at').on(table.createdAt),
}));

// Computational NFTs (extends NFTs)
export const computationalNfts = pgTable('computational_nfts', {
  id: serial('id').primaryKey(),
  nftId: text('nft_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  creator: text('creator').notNull(),
  contentUri: text('content_uri'),
  computationType: text('computation_type'),
  computationComplexity: integer('computation_complexity'),
  resourceRequirements: jsonb('resource_requirements'),
  inputData: jsonb('input_data'),
  parameters: jsonb('parameters'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  isVerified: boolean('is_verified').default(false),
  verifiers: jsonb('verifiers'),
  region: text('region'),
  accuracy: text('accuracy'),
  creatorReputation: integer('creator_reputation'),
  verificationSignatures: jsonb('verification_signatures'),
  executionResultHash: text('execution_result_hash'),
  metadata: jsonb('metadata'),
  transactionId: text('transaction_id'),
  versionTag: text('version_tag'),
}, (table) => ({
  creatorIdx: index('idx_computational_nfts_creator').on(table.creator),
  computationTypeIdx: index('idx_computational_nfts_type').on(table.computationType),
  isVerifiedIdx: index('idx_computational_nfts_verified').on(table.isVerified),
}));

// Computational Tasks table
export const computationalTasks = pgTable('computational_tasks', {
  id: serial('id').primaryKey(),
  taskId: text('task_id').notNull().unique(),
  name: text('name'),
  title: text('title'),
  description: text('description'),
  latitude: text('latitude'),
  longitude: text('longitude'),
  region: text('region'),
  regionCode: text('region_code'),
  taskType: text('task_type'),
  priority: text('priority'),
  baseReward: integer('base_reward'),
  status: text('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  deadline: timestamp('deadline'),
  requiresVerification: boolean('requires_verification').default(true),
  dataMetrics: jsonb('data_metrics'),
  assignedNodeId: text('assigned_node_id'),
  nftId: integer('nft_id').references(() => computationalNfts.id),
}, (table) => ({
  statusIdx: index('idx_computational_tasks_status').on(table.status),
  assignedNodeIdx: index('idx_computational_tasks_assigned_node').on(table.assignedNodeId),
  nftIdIdx: index('idx_computational_tasks_nft').on(table.nftId),
  createdAtIdx: index('idx_computational_tasks_created_at').on(table.createdAt),
}));

// ==========================================
// MISSING TABLES FOR TASK 57 COMPLETION
// ==========================================

// Carbon Credits Table - for user carbon credit holdings and trading
export const carbonCredits = pgTable('carbon_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenId: text('token_id').unique().notNull(),
  owner: text('owner').notNull(),
  carbonOffset: decimal('carbon_offset', { precision: 18, scale: 8 }).notNull(), // in tCO2e
  projectType: text('project_type').notNull(), // 'renewable_energy', 'forestry', 'weather_monitoring', etc.
  verificationStandard: text('verification_standard').notNull(), // 'VCS', 'Gold Standard', 'CDM', etc.
  issuanceDate: timestamp('issuance_date').notNull(),
  expiryDate: timestamp('expiry_date'),
  location: jsonb('location'), // { country, region, coordinates }
  isRetired: boolean('is_retired').default(false),
  issuer: text('issuer').notNull(),
  certificationHash: text('certification_hash'), // IPFS hash or blockchain hash
  forSale: boolean('for_sale').default(false),
  price: decimal('price', { precision: 18, scale: 8 }), // in WRF tokens
  metadata: jsonb('metadata'), // Additional project details
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  ownerIdx: index('idx_carbon_credits_owner').on(table.owner),
  projectTypeIdx: index('idx_carbon_credits_project_type').on(table.projectType),
  isRetiredIdx: index('idx_carbon_credits_retired').on(table.isRetired),
  forSaleIdx: index('idx_carbon_credits_for_sale').on(table.forSale),
}));

// Carbon Footprints Table - for user carbon footprint tracking
export const carbonFootprints = pgTable('carbon_footprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  totalEmissions: decimal('total_emissions', {
    precision: 18,
    scale: 8,
  }).notNull(), // in tCO2e
  totalOffsets: decimal('total_offsets', { precision: 18, scale: 8 }).default(
    '0'
  ),
  netEmissions: decimal('net_emissions', { precision: 18, scale: 8 }).notNull(),
  calculationDate: timestamp('calculation_date').notNull(),
  emissionSources: jsonb('emission_sources'), // Breakdown by category
  offsetSources: jsonb('offset_sources'), // Breakdown by source
  methodology: text('methodology').notNull().default('ipcc_2021'),
  confidence: real('confidence').default(0.95), // Calculation confidence
  metadata: jsonb('metadata'), // Additional calculation details
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_carbon_footprints_user').on(table.userId),
  calculationDateIdx: index('idx_carbon_footprints_date').on(table.calculationDate),
}));

// Compute Rewards Table - for computational NFT reward distribution
export const computeRewards = pgTable('compute_rewards', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: text('job_id').notNull(), // Links to computational job
  computeProvider: text('compute_provider').notNull(),
  rewardAmount: decimal('reward_amount', { precision: 18, scale: 8 }).notNull(),
  rewardType: text('reward_type').notNull(), // 'WRF', 'CARBON_CREDIT', 'NFT'
  jobComplexity: integer('job_complexity').notNull(), // 1-10 scale
  executionTime: integer('execution_time'), // in seconds
  qualityScore: real('quality_score').default(1.0), // 0-1 scale
  status: text('status').default('pending'), // 'pending', 'distributed', 'failed'
  distributedAt: timestamp('distributed_at'),
  transactionHash: text('transaction_hash'),
  metadata: jsonb('metadata'), // Job execution details
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  providerIdx: index('idx_compute_rewards_provider').on(table.computeProvider),
  statusIdx: index('idx_compute_rewards_status').on(table.status),
  rewardTypeIdx: index('idx_compute_rewards_type').on(table.rewardType),
}));

// AMM Pairs Table - for automated market maker liquidity pairs
export const ammPairs = pgTable('amm_pairs', {
  id: uuid('id').primaryKey().defaultRandom(),
  pairAddress: text('pair_address').unique().notNull(),
  token0: text('token0').notNull(), // First token address (usually WRF)
  token1: text('token1').notNull(), // Second token address (USDC, etc.)
  reserve0: decimal('reserve0', { precision: 36, scale: 18 }).notNull(),
  reserve1: decimal('reserve1', { precision: 36, scale: 18 }).notNull(),
  totalLiquidity: decimal('total_liquidity', {
    precision: 36,
    scale: 18,
  }).notNull(),
  swapFee: integer('swap_fee').default(30), // in basis points (30 = 0.3%)
  volume24h: decimal('volume24h', { precision: 36, scale: 18 }).default('0'),
  volumeWeek: decimal('volume_week', { precision: 36, scale: 18 }).default('0'),
  feeRewards24h: decimal('fee_rewards24h', {
    precision: 36,
    scale: 18,
  }).default('0'),
  priceToken0: decimal('price_token0', { precision: 36, scale: 18 }),
  priceToken1: decimal('price_token1', { precision: 36, scale: 18 }),
  lastUpdateTime: timestamp('last_update_time').defaultNow(),
  isActive: boolean('is_active').default(true),
  metadata: jsonb('metadata'), // Additional pair information
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  isActiveIdx: index('idx_amm_pairs_active').on(table.isActive),
  token0Idx: index('idx_amm_pairs_token0').on(table.token0),
  token1Idx: index('idx_amm_pairs_token1').on(table.token1),
}));

// AMM Swaps Table - for tracking all swap transactions
export const ammSwaps = pgTable('amm_swaps', {
  id: uuid('id').primaryKey().defaultRandom(),
  user: text('user').notNull(),
  pairAddress: text('pair_address').notNull(),
  tokenIn: text('token_in').notNull(),
  tokenOut: text('token_out').notNull(),
  amountIn: decimal('amount_in', { precision: 36, scale: 18 }).notNull(),
  amountOut: decimal('amount_out', { precision: 36, scale: 18 }).notNull(),
  minimumAmountOut: decimal('minimum_amount_out', {
    precision: 36,
    scale: 18,
  }).notNull(),
  priceImpact: decimal('price_impact', { precision: 8, scale: 6 }), // as percentage
  fee: decimal('fee', { precision: 36, scale: 18 }).notNull(),
  status: text('status').default('completed'), // 'pending', 'completed', 'failed'
  timestamp: timestamp('timestamp').notNull(),
  blockNumber: integer('block_number'),
  transactionHash: text('transaction_hash').unique(),
  gasUsed: integer('gas_used'),
  metadata: jsonb('metadata'), // Additional swap details
}, (table) => ({
  userIdx: index('idx_amm_swaps_user').on(table.user),
  pairAddressIdx: index('idx_amm_swaps_pair').on(table.pairAddress),
  timestampIdx: index('idx_amm_swaps_timestamp').on(table.timestamp),
  statusIdx: index('idx_amm_swaps_status').on(table.status),
}));

// Weather Data table
export const weatherData = pgTable('weather_data', {
  id: serial('id').primaryKey(),
  dataId: text('data_id').notNull().unique(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  latitude: text('latitude').notNull(),
  longitude: text('longitude').notNull(),
  elevation: integer('elevation'),
  stationId: text('station_id'),
  temperature: text('temperature'),
  humidity: text('humidity'),
  pressure: text('pressure'),
  windSpeed: text('wind_speed'),
  windDirection: text('wind_direction'),
  precipitation: text('precipitation'),
  cloudCover: text('cloud_cover'),
  visibility: text('visibility'),
  dataHash: text('data_hash').notNull(),
  signature: text('signature'),
  verificationStatus: text('verification_status').notNull().default('pending'),
  verifiers: jsonb('verifiers'),
  blockId: text('block_id'),
  sourceType: text('source_type').notNull(),
  metadata: jsonb('metadata'),
}, (table) => ({
  stationIdIdx: index('idx_weather_data_station_id').on(table.stationId),
  timestampIdx: index('idx_weather_data_timestamp').on(table.timestamp),
  stationTimestampIdx: index('idx_weather_data_station_timestamp').on(table.stationId, table.timestamp),
  verificationStatusIdx: index('idx_weather_data_verification_status').on(table.verificationStatus),
  sourceTypeIdx: index('idx_weather_data_source_type').on(table.sourceType),
}));

// Weather Forecasts table
export const weatherForecasts = pgTable('weather_forecasts', {
  id: serial('id').primaryKey(),
  forecastId: text('forecast_id').notNull().unique(),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
  validFrom: timestamp('valid_from').notNull(),
  validTo: timestamp('valid_to').notNull(),
  region: text('region').notNull(),
  resolution: text('resolution').notNull(),
  latitude: text('latitude').notNull(),
  longitude: text('longitude').notNull(),
  modelName: text('model_name').notNull(),
  modelVersion: text('model_version').notNull(),
  creator: text('creator').notNull(),
  dataUri: text('data_uri').notNull(),
  metrics: jsonb('metrics'),
  variables: jsonb('variables').notNull(),
  verificationStatus: text('verification_status').notNull().default('pending'),
  verifiers: jsonb('verifiers'),
  transactionId: text('transaction_id'),
  taskId: text('task_id'),
  metadata: jsonb('metadata'),
}, (table) => ({
  regionIdx: index('idx_weather_forecasts_region').on(table.region),
  creatorIdx: index('idx_weather_forecasts_creator').on(table.creator),
  validFromIdx: index('idx_weather_forecasts_valid_from').on(table.validFrom),
  verificationStatusIdx: index('idx_weather_forecasts_verification').on(table.verificationStatus),
  modelNameIdx: index('idx_weather_forecasts_model').on(table.modelName),
}));

// Weather Stations table
export const weatherStations = pgTable('weather_stations', {
  id: serial('id').primaryKey(),
  stationId: text('station_id').notNull().unique(),
  ownerAddress: text('owner_address').notNull(),
  location: text('location').notNull(),
  // Self-service registration columns (backend#788). Nullable so existing rows
  // remain valid; map pins require latitude/longitude to be populated.
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  name: text('name'),
  stationType: text('station_type'),
  isActive: boolean('is_active').notNull().default(true),
  qualityScore: integer('quality_score').notNull().default(100),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastRewardTime: timestamp('last_reward_time'),
  totalRewards: text('total_rewards').default('0'),
  metadata: jsonb('metadata'),
}, (table) => ({
  ownerAddressIdx: index('idx_weather_stations_owner').on(table.ownerAddress),
  // backend#1210: owner reads compare lower(owner_address) (migration 0021).
  ownerAddressLowerIdx: index('idx_weather_stations_owner_lower').on(sql`lower(${table.ownerAddress})`),
  isActiveIdx: index('idx_weather_stations_active').on(table.isActive),
  createdAtIdx: index('idx_weather_stations_created_at').on(table.createdAt),
}));

// Per-station provider API credentials (backend#788). Encrypted at rest with
// AES-256-GCM via API_KEY_ENCRYPTION_KEY; only the collector decrypts (server-side).
export const stationProviderCredentials = pgTable('station_provider_credentials', {
  id: serial('id').primaryKey(),
  stationId: text('station_id').notNull()
    .references(() => weatherStations.stationId, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('ambient'),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  keyIv: text('key_iv').notNull(),
  keyTag: text('key_tag').notNull(),
  encryptedAppKey: text('encrypted_app_key'),
  appIv: text('app_iv'),
  appTag: text('app_tag'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (table) => ({
  stationProviderUnique: unique('uq_station_provider_credentials_station_provider')
    .on(table.stationId, table.provider),
  stationIdIdx: index('idx_station_provider_credentials_station').on(table.stationId),
}));

// Validators table
export const validators = pgTable('validators', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  stake: integer('stake').notNull(),
  commission: text('commission').notNull(),
  uptime: text('uptime').notNull(),
  status: text('status').notNull().default('active'),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at'),
  consensusType: text('consensus_type').notNull(),
  delegatedStake: integer('delegated_stake').default(0),
  capabilities: jsonb('capabilities'),
  location: jsonb('location'),
  reportUrl: text('report_url'),
  verificationCount: integer('verification_count').default(0),
  successRate: text('success_rate').default('0'),
  reputation: text('reputation').default('0'),
  slashingHistory: jsonb('slashing_history'),
  metadata: jsonb('metadata'),
}, (table) => ({
  statusIdx: index('idx_validators_status').on(table.status),
  consensusTypeIdx: index('idx_validators_consensus_type').on(table.consensusType),
}));

// Achievements table
export const achievements = pgTable('achievements', {
  id: serial('id').primaryKey(),
  achievementId: text('achievement_id').notNull().unique(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  imageUrl: text('image_url'),
  criteria: jsonb('criteria').notNull(),
  points: integer('points').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  category: text('category').notNull(),
  rarity: text('rarity').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata'),
}, (table) => ({
  categoryIdx: index('idx_achievements_category').on(table.category),
  isActiveIdx: index('idx_achievements_active').on(table.isActive),
  rarityIdx: index('idx_achievements_rarity').on(table.rarity),
}));

// User Achievements junction table
export const userAchievements = pgTable('user_achievements', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  achievementId: integer('achievement_id')
    .notNull()
    .references(() => achievements.id),
  awardedAt: timestamp('awarded_at').notNull().defaultNow(),
  // backend#995: no defaults. A bare INSERT (user_id, achievement_id) must be inert, not an instantly
  // claimable 100%/'completed' row, so a writer has to state progress and status explicitly.
  progress: integer('progress').notNull(),
  status: text('status').notNull(),
  metadata: jsonb('metadata'),
}, (table) => ({
  userIdIdx: index('idx_user_achievements_user').on(table.userId),
  achievementIdIdx: index('idx_user_achievements_achievement').on(table.achievementId),
  statusIdx: index('idx_user_achievements_status').on(table.status),
}));

// Decentralized Identity tables
export const decentralizedIdentities = pgTable('decentralized_identities', {
  id: serial('id').primaryKey(),
  did: text('did').notNull().unique(),
  identityType: text('identity_type').notNull(),
  verificationLevel: text('verification_level').notNull().default('basic'),
  status: text('status').notNull().default('active'),
  publicKey: text('public_key').notNull(),
  privateKeyHash: text('private_key_hash'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const verifiableCredentials = pgTable('verifiable_credentials', {
  id: serial('id').primaryKey(),
  credentialId: text('credential_id').notNull().unique(),
  issuerDid: text('issuer_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  credentialType: text('credential_type').notNull(),
  claims: jsonb('claims').notNull(),
  issuanceDate: timestamp('issuance_date').notNull().defaultNow(),
  expirationDate: timestamp('expiration_date'),
  status: text('status').notNull().default('active'),
  proof: jsonb('proof').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const trustAnchors = pgTable('trust_anchors', {
  id: serial('id').primaryKey(),
  anchorDid: text('anchor_did').notNull().unique(),
  anchorType: text('anchor_type').notNull(),
  trustLevel: integer('trust_level').notNull().default(1),
  publicKey: text('public_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const trustEndorsements = pgTable('trust_endorsements', {
  id: serial('id').primaryKey(),
  endorserDid: text('endorser_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  endorsementType: text('endorsement_type').notNull(),
  trustScore: integer('trust_score').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
  metadata: jsonb('metadata'),
});

export const reputationScores = pgTable('reputation_scores', {
  id: serial('id').primaryKey(),
  identityDid: text('identity_did').notNull().unique(),
  overallScore: integer('overall_score').notNull().default(0),
  dataQuality: integer('data_quality').notNull().default(0),
  reliability: integer('reliability').notNull().default(0),
  verification: integer('verification').notNull().default(0),
  contributionValue: integer('contribution_value').notNull().default(0),
  participationLevel: integer('participation_level').notNull().default(0),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
  totalEvents: integer('total_events').notNull().default(0),
  confidenceLevel: text('confidence_level').notNull().default('low'),
  metadata: jsonb('metadata'),
});

export const reputationEvents = pgTable('reputation_events', {
  id: serial('id').primaryKey(),
  identityDid: text('identity_did').notNull(),
  eventType: text('event_type').notNull(),
  factor: text('factor').notNull(),
  impact: integer('impact').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  relatedEntity: text('related_entity'),
  metadata: jsonb('metadata'),
}, (table) => ({
  identityDidIdx: index('idx_reputation_events_did').on(table.identityDid),
  eventTypeIdx: index('idx_reputation_events_type').on(table.eventType),
  createdAtIdx: index('idx_reputation_events_created').on(table.createdAt),
}));

export const reputationRankings = pgTable('reputation_rankings', {
  id: serial('id').primaryKey(),
  identityDid: text('identity_did').notNull(),
  category: text('category').notNull(),
  rank: integer('rank').notNull(),
  score: integer('score').notNull(),
  period: text('period').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (table) => ({
  identityDidIdx: index('idx_reputation_rankings_did').on(table.identityDid),
  categoryIdx: index('idx_reputation_rankings_category').on(table.category),
  periodIdx: index('idx_reputation_rankings_period').on(table.period),
}));

// backend#62: contributor reputation engine persistence
export const contributorReputation = pgTable('contributor_reputation', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  role: text('role').notNull(),
  compositeScore: real('composite_score').notNull().default(0),
  dataQualityScore: real('data_quality_score').notNull().default(0),
  consistencyScore: real('consistency_score').notNull().default(0),
  verificationAccuracyScore: real('verification_accuracy_score')
    .notNull()
    .default(0),
  communityContributionScore: real('community_contribution_score')
    .notNull()
    .default(0),
  tenureScore: real('tenure_score').notNull().default(0),
  bonusMultiplier: real('bonus_multiplier').notNull().default(1),
  tier: text('tier').notNull().default('Bronze'),
  badges: jsonb('badges').notNull().default([]),
  history: jsonb('history').notNull().default([]),
  lastContributionAt: timestamp('last_contribution_at'),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const contributorReputationEvents = pgTable('contributor_reputation_events', {
  id: serial('id').primaryKey(),
  address: text('address').notNull(),
  role: text('role').notNull(),
  eventType: text('event_type').notNull(),
  dataQuality: real('data_quality').notNull().default(0),
  uptime: real('uptime').notNull().default(0),
  verificationAccuracy: real('verification_accuracy').notNull().default(0),
  communityContribution: real('community_contribution').notNull().default(0),
  details: jsonb('details'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  addressIdx: index('idx_contributor_reputation_events_address').on(table.address),
  eventTypeIdx: index('idx_contributor_reputation_events_type').on(table.eventType),
  createdAtIdx: index('idx_contributor_reputation_events_created').on(table.createdAt),
}));

export const weatherAlertHistory = pgTable('weather_alert_history', {
  id: serial('id').primaryKey(),
  alertId: text('alert_id').notNull().unique(),
  alertType: text('alert_type').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  areaDesc: text('area_desc'),
  zoneIds: jsonb('zone_ids'),
  payload: jsonb('payload').notNull(),
  issuedAt: timestamp('issued_at'),
  effectiveAt: timestamp('effective_at'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  alertTypeIdx: index('idx_weather_alert_history_type').on(table.alertType),
  severityIdx: index('idx_weather_alert_history_severity').on(table.severity),
  statusIdx: index('idx_weather_alert_history_status').on(table.status),
  issuedAtIdx: index('idx_weather_alert_history_issued').on(table.issuedAt),
}));

export const forecastEnsembleSubmissions = pgTable('forecast_ensemble_submissions', {
  id: serial('id').primaryKey(),
  submissionId: text('submission_id').notNull().unique(),
  roundId: text('round_id').notNull(),
  modelId: text('model_id').notNull(),
  modelName: text('model_name').notNull(),
  contributorAddress: text('contributor_address'),
  domainBounds: jsonb('domain_bounds').notNull(),
  validTimeRange: jsonb('valid_time_range').notNull(),
  forecastRef: jsonb('forecast_ref').notNull(),
  metrics: jsonb('metrics'),
  status: text('status').notNull().default('pending'),
  submittedAt: timestamp('submitted_at').notNull().defaultNow(),
  scoredAt: timestamp('scored_at'),
  metadata: jsonb('metadata'),
}, (table) => ({
  roundIdIdx: index('idx_forecast_ensemble_submissions_round').on(table.roundId),
  modelIdIdx: index('idx_forecast_ensemble_submissions_model').on(table.modelId),
  contributorIdx: index('idx_forecast_ensemble_submissions_contributor').on(table.contributorAddress),
  statusIdx: index('idx_forecast_ensemble_submissions_status').on(table.status),
}));

export const forecastEnsembleRounds = pgTable('forecast_ensemble_rounds', {
  id: serial('id').primaryKey(),
  roundId: text('round_id').notNull().unique(),
  scoredAt: timestamp('scored_at').notNull().defaultNow(),
  winnerModelId: text('winner_model_id'),
  participants: integer('participants').notNull().default(0),
  metadata: jsonb('metadata'),
}, (table) => ({
  roundIdScoresIdx: index('idx_forecast_ensemble_rounds_round').on(table.roundId),
}));

export const forecastEnsembleScores = pgTable('forecast_ensemble_scores', {
  id: serial('id').primaryKey(),
  roundId: text('round_id').notNull(),
  modelId: text('model_id').notNull(),
  skillScore: real('skill_score').notNull(),
  scoredAt: timestamp('scored_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (table) => ({
  roundIdIdx: index('idx_forecast_ensemble_scores_round').on(table.roundId),
  modelIdIdx: index('idx_forecast_ensemble_scores_model').on(table.modelId),
}));

export const forecastModelLifecycle = pgTable('forecast_model_lifecycle', {
  id: serial('id').primaryKey(),
  modelId: text('model_id').notNull().unique(),
  modelName: text('model_name').notNull(),
  rounds: integer('rounds').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  totalSkill: real('total_skill').notNull().default(0),
  lastSkill: real('last_skill').notNull().default(0),
  decayedSkill: real('decayed_skill').notNull().default(0),
  consecutiveBelowThreshold: integer('consecutive_below_threshold').notNull().default(0),
  retired: boolean('retired').notNull().default(false),
  lastScoredAt: timestamp('last_scored_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const advisoryPolicyVersions = pgTable('advisory_policy_versions', {
  id: serial('id').primaryKey(),
  policyId: text('policy_id').notNull(),
  eventClass: text('event_class').notNull(),
  version: text('version').notNull(),
  ruleBundle: jsonb('rule_bundle').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const advisoryDecisions = pgTable('advisory_decisions', {
  id: serial('id').primaryKey(),
  advisoryId: text('advisory_id').notNull().unique(),
  eventClass: text('event_class').notNull(),
  advisoryLevel: text('advisory_level').notNull(),
  policyVersion: text('policy_version').notNull(),
  ruleBundleVersion: text('rule_bundle_version').notNull(),
  modelEnabled: boolean('model_enabled').notNull().default(false),
  modelUsed: boolean('model_used').notNull().default(false),
  modelFallbackUsed: boolean('model_fallback_used').notNull().default(false),
  modelVersion: text('model_version'),
  modelConfidence: real('model_confidence').notNull().default(0),
  evidenceBundle: jsonb('evidence_bundle').notNull(),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
});

// Environmental data tables
export const environmentalSubmissions = pgTable('environmental_submissions', {
  id: serial('id').primaryKey(),
  submissionId: text('submission_id').notNull().unique(),
  submitterId: text('submitter_id').notNull(),
  dataType: text('data_type').notNull(),
  data: jsonb('data').notNull(),
  location: jsonb('location').notNull(),
  validationState: text('validation_state').notNull().default('pending'),
  submissionTimestamp: timestamp('submission_timestamp').notNull().defaultNow(),
  deviceType: text('device_type'),
  deviceId: text('device_id'),
  sensorAccuracy: text('sensor_accuracy'),
  batteryLevel: integer('battery_level'),
  signalStrength: integer('signal_strength'),
  maintenanceStatus: text('maintenance_status'),
  firmwareVersion: text('firmware_version'),
  metadata: jsonb('metadata'),
}, (table) => ({
  submitterIdx: index('idx_environmental_submissions_submitter').on(table.submitterId),
  validationStateIdx: index('idx_environmental_submissions_validation').on(table.validationState),
  dataTypeIdx: index('idx_environmental_submissions_data_type').on(table.dataType),
  deviceIdIdx: index('idx_environmental_submissions_device').on(table.deviceId),
}));

export const validationAttestations = pgTable('validation_attestations', {
  id: serial('id').primaryKey(),
  submissionId: text('submission_id').notNull(),
  validatorDid: text('validator_did').notNull(),
  validationType: text('validation_type').notNull(),
  isValid: boolean('is_valid').notNull(),
  confidence: integer('confidence').notNull(),
  validatedAt: timestamp('validated_at').notNull().defaultNow(),
  proof: jsonb('proof'),
  metadata: jsonb('metadata'),
}, (table) => ({
  submissionIdIdx: index('idx_validation_attestations_submission').on(table.submissionId),
  validatorDidIdx: index('idx_validation_attestations_validator').on(table.validatorDid),
}));

export const popRewards = pgTable('pop_rewards', {
  id: serial('id').primaryKey(),
  submissionId: text('submission_id').notNull(),
  recipientDid: text('recipient_did').notNull(),
  rewardType: text('reward_type').notNull(),
  amount: text('amount').notNull(),
  reason: text('reason'),
  distributedAt: timestamp('distributed_at').notNull().defaultNow(),
  transactionId: text('transaction_id'),
  metadata: jsonb('metadata'),
}, (table) => ({
  submissionIdIdx: index('idx_pop_rewards_submission').on(table.submissionId),
  recipientDidIdx: index('idx_pop_rewards_recipient').on(table.recipientDid),
  rewardTypeIdx: index('idx_pop_rewards_type').on(table.rewardType),
}));

export const referenceDataSources = pgTable('reference_data_sources', {
  id: serial('id').primaryKey(),
  sourceId: text('source_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  dataType: text('data_type').notNull(),
  url: text('url'),
  apiKey: text('api_key'),
  isActive: boolean('is_active').notNull().default(true),
  trustLevel: integer('trust_level').notNull().default(50),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

// Cross-chain tables
export const crossChainTransfers = pgTable('cross_chain_transfers', {
  id: serial('id').primaryKey(),
  transferId: text('transfer_id').notNull().unique(),
  fromChain: text('from_chain').notNull(),
  toChain: text('to_chain').notNull(),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  amount: text('amount').notNull(),
  tokenType: text('token_type').notNull(),
  status: text('status').notNull().default('pending'),
  initiatedAt: timestamp('initiated_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  bridgeProvider: text('bridge_provider').notNull(),
  fees: text('fees'),
  metadata: jsonb('metadata'),
}, (table) => ({
  fromAddressIdx: index('idx_cross_chain_transfers_from').on(table.fromAddress),
  toAddressIdx: index('idx_cross_chain_transfers_to').on(table.toAddress),
  statusIdx: index('idx_cross_chain_transfers_status').on(table.status),
  bridgeProviderIdx: index('idx_cross_chain_transfers_bridge').on(table.bridgeProvider),
  initiatedAtIdx: index('idx_cross_chain_transfers_initiated').on(table.initiatedAt),
}));

export const achievementCategories = pgTable('achievement_categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  icon: text('icon'),
  color: text('color'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const minerAchievementProgress = pgTable('miner_achievement_progress', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  achievementId: integer('achievement_id').notNull(),
  currentProgress: integer('current_progress').notNull().default(0),
  targetProgress: integer('target_progress').notNull(),
  isCompleted: boolean('is_completed').notNull().default(false),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const minerAchievements = pgTable('miner_achievements', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  achievementId: integer('achievement_id').notNull(),
  awardedAt: timestamp('awarded_at').notNull().defaultNow(),
  progress: integer('progress').notNull().default(100),
  status: text('status').notNull().default('completed'),
  metadata: jsonb('metadata'),
});

export const computationalNodes = pgTable('computational_nodes', {
  id: serial('id').primaryKey(),
  nodeId: text('node_id').notNull().unique(),
  operatorAddress: text('operator_address').notNull(),
  capabilities: jsonb('capabilities').notNull(),
  status: text('status').notNull().default('active'),
  lastHeartbeat: timestamp('last_heartbeat'),
  totalTasksCompleted: integer('total_tasks_completed').notNull().default(0),
  uptime: text('uptime').notNull().default('0'),
  location: text('location'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (table) => ({
  operatorAddressIdx: index('idx_computational_nodes_operator').on(table.operatorAddress),
  statusIdx: index('idx_computational_nodes_status').on(table.status),
  lastHeartbeatIdx: index('idx_computational_nodes_heartbeat').on(table.lastHeartbeat),
}));

// Relationships
export const usersRelations = relations(users, ({ many }) => ({
  transactions: many(transactions),
  nfts: many(nfts),
  userAchievements: many(userAchievements),
  weatherStations: many(weatherStations),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  sender: one(users, {
    fields: [transactions.fromAddress],
    references: [users.walletAddress],
  }),
  receiver: one(users, {
    fields: [transactions.toAddress],
    references: [users.walletAddress],
  }),
  block: one(blocks, {
    fields: [transactions.blockId],
    references: [blocks.id],
  }),
}));

export const nftsRelations = relations(nfts, ({ one }) => ({
  createdBy: one(users, {
    fields: [nfts.creator],
    references: [users.walletAddress],
  }),
  ownedBy: one(users, {
    fields: [nfts.owner],
    references: [users.walletAddress],
  }),
}));

export const computationalNftsRelations = relations(
  computationalNfts,
  ({ many }) => ({
    tasks: many(computationalTasks),
    workflowLinks: many(nftWorkflowLinks),
  })
);

export const computationalTasksRelations = relations(
  computationalTasks,
  ({ one }) => ({
    nft: one(computationalNfts, {
      fields: [computationalTasks.nftId],
      references: [computationalNfts.id],
    }),
  })
);

export const achievementsRelations = relations(achievements, ({ many }) => ({
  userAchievements: many(userAchievements),
}));

export const userAchievementsRelations = relations(
  userAchievements,
  ({ one }) => ({
    user: one(users, {
      fields: [userAchievements.userId],
      references: [users.id],
    }),
    achievement: one(achievements, {
      fields: [userAchievements.achievementId],
      references: [achievements.id],
    }),
  })
);

export const weatherStationsRelations = relations(
  weatherStations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [weatherStations.ownerAddress],
      references: [users.walletAddress],
    }),
    weatherData: many(weatherData),
    providerCredentials: many(stationProviderCredentials),
  })
);

export const stationProviderCredentialsRelations = relations(
  stationProviderCredentials,
  ({ one }) => ({
    station: one(weatherStations, {
      fields: [stationProviderCredentials.stationId],
      references: [weatherStations.stationId],
    }),
  })
);

export const weatherDataRelations = relations(weatherData, ({ one }) => ({
  station: one(weatherStations, {
    fields: [weatherData.stationId],
    references: [weatherStations.stationId],
  }),
}));
// Relations for new Task 57 tables
export const carbonCreditsRelations = relations(carbonCredits, ({ one }) => ({
  ownerUser: one(users, {
    fields: [carbonCredits.owner],
    references: [users.walletAddress],
  }),
}));

export const carbonFootprintsRelations = relations(
  carbonFootprints,
  ({ one }) => ({
    user: one(users, {
      fields: [carbonFootprints.userId],
      references: [users.walletAddress],
    }),
  })
);

export const computeRewardsRelations = relations(computeRewards, ({ one }) => ({
  provider: one(users, {
    fields: [computeRewards.computeProvider],
    references: [users.walletAddress],
  }),
}));

export const ammPairsRelations = relations(ammPairs, ({ many }) => ({
  swaps: many(ammSwaps),
}));

export const ammSwapsRelations = relations(ammSwaps, ({ one }) => ({
  pair: one(ammPairs, {
    fields: [ammSwaps.pairAddress],
    references: [ammPairs.pairAddress],
  }),
  swapper: one(users, {
    fields: [ammSwaps.user],
    references: [users.walletAddress],
  }),
}));

// Export governance schema elements
export {
  proposals,
  votes,
  parameters,
  delegations,
  parameterHistory,
  proposalsRelations,
  votesRelations,
  parametersRelations,
  parameterHistoryRelations,
};

// NFT Workflow Links table (for n8n integration)
export const nftWorkflowLinks = pgTable('nft_workflow_links', {
  id: text('id').primaryKey(),
  nftId: text('nft_id').notNull(),
  workflowId: text('workflow_id').notNull(),
  name: text('name').notNull(),
  triggerType: text('trigger_type').notNull().default('manual'),
  triggerEvents: jsonb('trigger_events'),
  schedule: text('schedule'),
  inputMappings: jsonb('input_mappings'),
  lastRun: timestamp('last_run'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (table) => ({
  nftIdIdx: index('idx_nft_workflow_links_nft').on(table.nftId),
  workflowIdIdx: index('idx_nft_workflow_links_workflow').on(table.workflowId),
  statusIdx: index('idx_nft_workflow_links_status').on(table.status),
}));

// Relationships for NFT Workflow Links
export const nftWorkflowLinksRelations = relations(
  nftWorkflowLinks,
  ({ one }) => ({
    computationalNft: one(computationalNfts, {
      fields: [nftWorkflowLinks.nftId],
      references: [computationalNfts.nftId],
    }),
  })
);

// Update the existing computationalNftsRelations definition to include workflowLinks

// Export Drizzle types
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = typeof transactions.$inferInsert;

export type Block = typeof blocks.$inferSelect;
export type InsertBlock = typeof blocks.$inferInsert;

export type NFT = typeof nfts.$inferSelect;
export type InsertNFT = typeof nfts.$inferInsert;

export type ComputationalNFT = typeof computationalNfts.$inferSelect;
export type InsertComputationalNFT = typeof computationalNfts.$inferInsert;

export type ComputationalTask = typeof computationalTasks.$inferSelect;
export type InsertComputationalTask = typeof computationalTasks.$inferInsert;

export type WeatherData = typeof weatherData.$inferSelect;
export type InsertWeatherData = typeof weatherData.$inferInsert;

export type WeatherForecast = typeof weatherForecasts.$inferSelect;
export type InsertWeatherForecast = typeof weatherForecasts.$inferInsert;

export type Validator = typeof validators.$inferSelect;
export type InsertValidator = typeof validators.$inferInsert;

export type Achievement = typeof achievements.$inferSelect;
export type InsertAchievement = typeof achievements.$inferInsert;

export type UserAchievement = typeof userAchievements.$inferSelect;
export type InsertUserAchievement = typeof userAchievements.$inferInsert;

export type NftWorkflowLink = typeof nftWorkflowLinks.$inferSelect;
export type InsertNftWorkflowLink = typeof nftWorkflowLinks.$inferInsert;

export type WeatherStation = typeof weatherStations.$inferSelect;
export type InsertWeatherStation = typeof weatherStations.$inferInsert;
// Task 57 types for new tables
export type CarbonCredit = typeof carbonCredits.$inferSelect;
export type InsertCarbonCredit = typeof carbonCredits.$inferInsert;

export type CarbonFootprint = typeof carbonFootprints.$inferSelect;
export type InsertCarbonFootprint = typeof carbonFootprints.$inferInsert;

export type ComputeReward = typeof computeRewards.$inferSelect;
export type InsertComputeReward = typeof computeRewards.$inferInsert;

export type AmmPair = typeof ammPairs.$inferSelect;
export type InsertAmmPair = typeof ammPairs.$inferInsert;

export type AmmSwap = typeof ammSwaps.$inferSelect;
export type InsertAmmSwap = typeof ammSwaps.$inferInsert;

// Wolfram integration settings
export const wolframSettings = pgTable('wolfram_settings', {
  id: serial('id').primaryKey(),
  apiKey: text('api_key'),
  useCaching: boolean('use_caching').default(true),
  cacheTTL: integer('cache_ttl').default(86400000), // 24 hours in milliseconds
  useAlternativeEndpoint: boolean('use_alternative_endpoint').default(false),
  alternativeEndpoint: text('alternative_endpoint'),
  maxQueriesPerDay: integer('max_queries_per_day').default(1000),
  preferShortAnswers: boolean('prefer_short_answers').default(true),
  timeoutMs: integer('timeout_ms').default(30000),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type WolframSettings = typeof wolframSettings.$inferSelect;
export type InsertWolframSettings = typeof wolframSettings.$inferInsert;

// Cross-Chain Bridge Schema
export const crossChainBridges = pgTable('cross_chain_bridges', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  sourceChain: text('source_chain').notNull().default('wrfcoin'),
  targetChain: text('target_chain').notNull(),
  contractAddress: text('contract_address'),
  providerApiKey: text('provider_api_key'),
  status: text('status').notNull().default('INACTIVE'),
  lastActive: timestamp('last_active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  config: jsonb('config'),
  gasLimit: integer('gas_limit'),
  maxFeeAmount: integer('max_fee_amount'),
  securityLevel: integer('security_level').default(1),
  requiresApproval: boolean('requires_approval').default(false),
  approverRoles: jsonb('approver_roles'),
}, (table) => ({
  statusIdx: index('idx_cross_chain_bridges_status').on(table.status),
  providerIdx: index('idx_cross_chain_bridges_provider').on(table.provider),
}));

// Cross-Chain Transactions
export const crossChainTransactions = pgTable('cross_chain_transactions', {
  id: serial('id').primaryKey(),
  transactionId: text('transaction_id').notNull().unique(),
  bridgeId: integer('bridge_id')
    .notNull()
    .references(() => crossChainBridges.id),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  amount: integer('amount').notNull(),
  fee: integer('fee').notNull(),
  sourceChain: text('source_chain').notNull(),
  targetChain: text('target_chain').notNull(),
  sourceTransactionHash: text('source_transaction_hash'),
  targetTransactionHash: text('target_transaction_hash'),
  status: text('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  data: jsonb('data'),
  errorMessage: text('error_message'),
  nonce: integer('nonce'),
  recoveryHash: text('recovery_hash'),
}, (table) => ({
  bridgeIdIdx: index('idx_cross_chain_transactions_bridge').on(table.bridgeId),
  fromAddressIdx: index('idx_cross_chain_transactions_from').on(table.fromAddress),
  statusIdx: index('idx_cross_chain_transactions_status').on(table.status),
  createdAtIdx: index('idx_cross_chain_transactions_created').on(table.createdAt),
}));

// Cross-Chain Supported Networks
export const crossChainNetworks = pgTable('cross_chain_networks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  chainId: text('chain_id').notNull().unique(),
  rpcUrl: text('rpc_url').notNull(),
  explorerUrl: text('explorer_url'),
  nativeToken: text('native_token').notNull(),
  logoUrl: text('logo_url'),
  isTestnet: boolean('is_testnet').default(false),
  bridgeContracts: jsonb('bridge_contracts'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Relations for Cross-Chain Bridges
export const crossChainBridgesRelations = relations(
  crossChainBridges,
  ({ many }) => ({
    transactions: many(crossChainTransactions),
  })
);

// Relations for Cross-Chain Transactions
export const crossChainTransactionsRelations = relations(
  crossChainTransactions,
  ({ one }) => ({
    bridge: one(crossChainBridges, {
      fields: [crossChainTransactions.bridgeId],
      references: [crossChainBridges.id],
    }),
  })
);

export type CrossChainBridge = typeof crossChainBridges.$inferSelect;
export type InsertCrossChainBridge = typeof crossChainBridges.$inferInsert;

export type CrossChainTransaction = typeof crossChainTransactions.$inferSelect;
export type InsertCrossChainTransaction =
  typeof crossChainTransactions.$inferInsert;

export type CrossChainNetwork = typeof crossChainNetworks.$inferSelect;
export type InsertCrossChainNetwork = typeof crossChainNetworks.$inferInsert;

// Export MFA schema elements
export {
  userMfaSettings,
  mfaAttempts,
  userSessions,
  trustedDevices,
  mfaBackupCodeUsage,
  smsVerificationCodes,
  securityEvents,
  userMfaSettingsRelations,
  mfaAttemptsRelations,
  userSessionsRelations,
  trustedDevicesRelations,
  mfaBackupCodeUsageRelations,
  smsVerificationCodesRelations,
  securityEventsRelations,
};

// Export File schema elements
export {
  files,
  filePermissions,
  fileAccessLogs,
  fileShares,
  filesRelations,
  filePermissionsRelations,
  fileAccessLogsRelations,
  fileSharesRelations,
  PERMISSION_LEVELS,
  FILE_VISIBILITY,
  type File,
  type InsertFile,
  type FilePermission,
  type InsertFilePermission,
  type FileAccessLog,
  type InsertFileAccessLog,
  type FileShare,
  type InsertFileShare,
  type PermissionLevel,
  type FileVisibility,
};

// Re-export MFA types
export type {
  UserMfaSettings,
  InsertUserMfaSettings,
  MfaAttempt,
  InsertMfaAttempt,
  UserSession,
  InsertUserSession,
  TrustedDevice,
  InsertTrustedDevice,
  MfaBackupCodeUsage,
  InsertMfaBackupCodeUsage,
  SmsVerificationCode,
  InsertSmsVerificationCode,
  SecurityEvent,
  InsertSecurityEvent,
} from './mfa-schema.js';

// Reward Distribution Schema
export const rewardDistributionConfig = pgTable('reward_distribution_config', {
  id: serial('id').primaryKey(),
  active: boolean('active').default(true),
  distributionRules: jsonb('distribution_rules').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  version: text('version').notNull().default('1.0'),
  description: text('description'),
});

export const contributorRewards = pgTable('contributor_rewards', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  contributorType: text('contributor_type').notNull(),
  amount: integer('amount').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  reason: text('reason'),
  metadata: jsonb('metadata'),
}, (table) => ({
  userIdIdx: index('idx_contributor_rewards_user').on(table.userId),
  contributorTypeIdx: index('idx_contributor_rewards_type').on(table.contributorType),
  createdAtIdx: index('idx_contributor_rewards_created').on(table.createdAt),
  payoutNonceIdx: uniqueIndex('idx_achievement_payout_nonce_unique')
    .on(sql`(${table.metadata}->'payoutAuthorization'->>'nonce')`)
    .where(sql`${table.contributorType} = 'achievement' AND ${table.metadata}->'payoutAuthorization'->>'nonce' IS NOT NULL`),
}));

export const forecastCoverageMetrics = pgTable('forecast_coverage_metrics', {
  id: serial('id').primaryKey(),
  region: text('region').notNull(),
  coverage: integer('coverage').notNull(),
  accuracy: integer('accuracy').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (table) => ({
  regionIdx: index('idx_forecast_coverage_region').on(table.region),
}));

export const environmentalOffsetProofs = pgTable(
  'environmental_offset_proofs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    offsetPoints: integer('offset_points').notNull(),
    isVerified: boolean('is_verified').default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    proofData: jsonb('proof_data'),
    metadata: jsonb('metadata'),
  }
);

export const computationalWorkProofs = pgTable('computational_work_proofs', {
  id: serial('id').primaryKey(),
  taskId: text('task_id').notNull(),
  nodeId: text('node_id').notNull(),
  computationType: text('computation_type').notNull(),
  computeResourcesUsed: jsonb('compute_resources_used'),
  resourceHours: integer('resource_hours').notNull(),
  rewardAmount: integer('reward_amount').notNull(),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
  isVerified: boolean('is_verified').default(false),
  resultMetadata: jsonb('result_metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const algorithmAdvancements = pgTable('algorithm_advancements', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  algorithmName: text('algorithm_name').notNull(),
  description: text('description'),
  isVerified: boolean('is_verified').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

// Wallets table - can exist independently of user accounts
export const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  network: text('network').notNull().default('testnet'),
  balance: text('balance').notNull().default('0'), // Using text for decimal precision
  lastUpdated: timestamp('last_updated').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  publicKey: text('public_key'),
  label: text('label'),
  isActive: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata'),
}, (table) => ({
  networkIdx: index('idx_wallets_network').on(table.network),
  isActiveIdx: index('idx_wallets_active').on(table.isActive),
  createdAtIdx: index('idx_wallets_created_at').on(table.createdAt),
}));

// ============================================================================
// Task 82: GraphQL Resolver Database Integration Tables
// ============================================================================

// Staking Deposits - tracks user staking positions
export const stakingDeposits = pgTable('staking_deposits', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  validatorId: text('validator_id'),
  amount: text('amount').notNull(), // Using text for wei precision
  lockupPeriod: integer('lockup_period'), // Lock duration in seconds
  depositedAt: timestamp('deposited_at').defaultNow(),
  unlocksAt: timestamp('unlocks_at'),
  status: text('status').default('active'), // active, withdrawn, slashed
  transactionHash: text('transaction_hash'),
  metadata: jsonb('metadata'),
}, (table) => ({
  userIdIdx: index('idx_staking_deposits_user').on(table.userId),
  validatorIdIdx: index('idx_staking_deposits_validator').on(table.validatorId),
  statusIdx: index('idx_staking_deposits_status').on(table.status),
}));

// Staking Rewards - tracks rewards earned from staking
export const stakingRewards = pgTable('staking_rewards', {
  id: serial('id').primaryKey(),
  stakerId: text('staker_id').notNull(),
  depositId: integer('deposit_id').references(() => stakingDeposits.id),
  amount: text('amount').notNull(), // Using text for wei precision
  rewardType: text('reward_type').default('staking'), // staking, delegation, bonus
  period: text('period'), // e.g., "2024-Q1"
  claimedAt: timestamp('claimed_at'),
  createdAt: timestamp('created_at').defaultNow(),
  transactionHash: text('transaction_hash'),
  metadata: jsonb('metadata'),
}, (table) => ({
  stakerIdIdx: index('idx_staking_rewards_staker').on(table.stakerId),
  depositIdIdx: index('idx_staking_rewards_deposit').on(table.depositId),
  rewardTypeIdx: index('idx_staking_rewards_type').on(table.rewardType),
}));

// Liquidity Positions - tracks LP positions in AMM pools
export const liquidityPositions = pgTable('liquidity_positions', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  poolId: text('pool_id').notNull(),
  pairAddress: text('pair_address').references(() => ammPairs.pairAddress),
  token0Amount: text('token0_amount').notNull(),
  token1Amount: text('token1_amount').notNull(),
  lpTokens: text('lp_tokens').notNull(), // LP token balance
  sharePercentage: text('share_percentage'), // Pool share %
  entryPrice: text('entry_price'),
  status: text('status').default('active'), // active, withdrawn
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at'),
  withdrawnAt: timestamp('withdrawn_at'),
  metadata: jsonb('metadata'),
}, (table) => ({
  userIdIdx: index('idx_liquidity_positions_user').on(table.userId),
  poolIdIdx: index('idx_liquidity_positions_pool').on(table.poolId),
  pairAddressIdx: index('idx_liquidity_positions_pair').on(table.pairAddress),
  statusIdx: index('idx_liquidity_positions_status').on(table.status),
}));

// Carbon Trades - individual trade history for carbon credits
export const carbonTrades = pgTable('carbon_trades', {
  id: serial('id').primaryKey(),
  creditId: text('credit_id').notNull(),
  buyerAddress: text('buyer_address').notNull(),
  sellerAddress: text('seller_address').notNull(),
  price: text('price').notNull(), // Price per credit in WRF
  quantity: text('quantity').notNull(), // Number of credits traded
  totalValue: text('total_value'), // Total transaction value
  transactionHash: text('transaction_hash'),
  tradedAt: timestamp('traded_at').defaultNow(),
  tradeType: text('trade_type').default('market'), // market, limit, auction
  metadata: jsonb('metadata'),
}, (table) => ({
  buyerIdx: index('idx_carbon_trades_buyer').on(table.buyerAddress),
  sellerIdx: index('idx_carbon_trades_seller').on(table.sellerAddress),
  creditIdIdx: index('idx_carbon_trades_credit').on(table.creditId),
  tradedAtIdx: index('idx_carbon_trades_traded_at').on(table.tradedAt),
}));

// Weather Data Quality - quality metrics for weather submissions
export const weatherDataQuality = pgTable('weather_data_quality', {
  id: serial('id').primaryKey(),
  stationId: text('station_id').notNull(),
  submissionId: text('submission_id'),
  dataId: text('data_id').references(() => weatherData.dataId),
  qualityScore: real('quality_score'), // 0-100 quality score
  confidence: real('confidence'), // 0-1 confidence level
  factors: jsonb('factors'), // Breakdown of quality factors
  anomalyDetected: boolean('anomaly_detected').default(false),
  validationStatus: text('validation_status').default('pending'), // pending, validated, rejected
  calculatedAt: timestamp('calculated_at').defaultNow(),
  validatedBy: text('validated_by'), // Validator address
  metadata: jsonb('metadata'),
}, (table) => ({
  stationIdIdx: index('idx_weather_data_quality_station').on(table.stationId),
  dataIdIdx: index('idx_weather_data_quality_data').on(table.dataId),
  validationStatusIdx: index('idx_weather_data_quality_validation').on(table.validationStatus),
  anomalyDetectedIdx: index('idx_weather_data_quality_anomaly').on(table.anomalyDetected),
}));

// Relations for new tables
export const stakingDepositsRelations = relations(
  stakingDeposits,
  ({ one, many }) => ({
    user: one(users, {
      fields: [stakingDeposits.userId],
      references: [users.walletAddress],
    }),
    validator: one(validators, {
      fields: [stakingDeposits.validatorId],
      references: [validators.address],
    }),
    rewards: many(stakingRewards),
  })
);

export const stakingRewardsRelations = relations(stakingRewards, ({ one }) => ({
  staker: one(users, {
    fields: [stakingRewards.stakerId],
    references: [users.walletAddress],
  }),
  deposit: one(stakingDeposits, {
    fields: [stakingRewards.depositId],
    references: [stakingDeposits.id],
  }),
}));

export const liquidityPositionsRelations = relations(
  liquidityPositions,
  ({ one }) => ({
    user: one(users, {
      fields: [liquidityPositions.userId],
      references: [users.walletAddress],
    }),
    pair: one(ammPairs, {
      fields: [liquidityPositions.pairAddress],
      references: [ammPairs.pairAddress],
    }),
  })
);

export const carbonTradesRelations = relations(carbonTrades, ({ one }) => ({
  buyer: one(users, {
    fields: [carbonTrades.buyerAddress],
    references: [users.walletAddress],
  }),
  seller: one(users, {
    fields: [carbonTrades.sellerAddress],
    references: [users.walletAddress],
  }),
}));

export const weatherDataQualityRelations = relations(
  weatherDataQuality,
  ({ one }) => ({
    station: one(weatherStations, {
      fields: [weatherDataQuality.stationId],
      references: [weatherStations.stationId],
    }),
    data: one(weatherData, {
      fields: [weatherDataQuality.dataId],
      references: [weatherData.dataId],
    }),
  })
);

// Export types for the new tables
export type RewardDistributionConfig =
  typeof rewardDistributionConfig.$inferSelect;
export type InsertRewardDistributionConfig =
  typeof rewardDistributionConfig.$inferInsert;

export type ContributorReward = typeof contributorRewards.$inferSelect;
export type InsertContributorReward = typeof contributorRewards.$inferInsert;

export type ForecastCoverageMetric =
  typeof forecastCoverageMetrics.$inferSelect;
export type InsertForecastCoverageMetric =
  typeof forecastCoverageMetrics.$inferInsert;

export type EnvironmentalOffsetProof =
  typeof environmentalOffsetProofs.$inferSelect;
export type InsertEnvironmentalOffsetProof =
  typeof environmentalOffsetProofs.$inferInsert;

export type ComputationalWorkProof =
  typeof computationalWorkProofs.$inferSelect;
export type InsertComputationalWorkProof =
  typeof computationalWorkProofs.$inferInsert;

export type AlgorithmAdvancement = typeof algorithmAdvancements.$inferSelect;
export type InsertAlgorithmAdvancement =
  typeof algorithmAdvancements.$inferInsert;

// Task 82: Types for GraphQL Resolver Integration Tables
export type StakingDeposit = typeof stakingDeposits.$inferSelect;
export type InsertStakingDeposit = typeof stakingDeposits.$inferInsert;

export type StakingReward = typeof stakingRewards.$inferSelect;
export type InsertStakingReward = typeof stakingRewards.$inferInsert;

export type LiquidityPosition = typeof liquidityPositions.$inferSelect;
export type InsertLiquidityPosition = typeof liquidityPositions.$inferInsert;

export type CarbonTrade = typeof carbonTrades.$inferSelect;
export type InsertCarbonTrade = typeof carbonTrades.$inferInsert;

export type WeatherDataQuality = typeof weatherDataQuality.$inferSelect;
export type InsertWeatherDataQuality = typeof weatherDataQuality.$inferInsert;

// Export Lineage schema elements
export { lineageRecords, type LineageRecord, type InsertLineageRecord };
export {
  marketplaceSubscriptions,
  marketplaceUsage,
  academicApplications,
  MARKETPLACE_TIERS,
  TIER_DAILY_LIMITS,
  ACADEMIC_STATUS,
  type MarketplaceTier,
  type MarketplaceSubscription,
  type NewMarketplaceSubscription,
  type MarketplaceUsage,
  type AcademicApplication,
  type NewAcademicApplication,
  type AcademicStatus,
};

export const streakMilestonesClaimed = pgTable('streak_milestones_claimed', {
  walletAddress: text('wallet_address').notNull(),
  milestoneDays: integer('milestone_days').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow(),
  txHash: text('tx_hash'),
}, (t) => ({ pk: primaryKey({ columns: [t.walletAddress, t.milestoneDays] }) }));

export const socialAccounts = pgTable('social_accounts', {
  sub:                text('sub').notNull(),
  provider:           text('provider').notNull(),
  email:              text('email'),
  walletAddress:      text('wallet_address').notNull(),
  smartAccountAddress: text('smart_account_address'),
  smartAccountDeployTx: text('smart_account_deploy_tx'),
  sponsoredTxCount:   integer('sponsored_tx_count').notNull().default(0),
  createdAt:          timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.sub, t.provider] }) }));

export const gasSponsorLog = pgTable('gas_sponsor_log', {
  id:            serial('id').primaryKey(),
  walletAddress: text('wallet_address').notNull(),
  userOpHash:    text('user_op_hash'),
  sponsoredAt:   timestamp('sponsored_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  walletAddressIdx: index('idx_gas_sponsor_log_wallet').on(table.walletAddress),
  sponsoredAtIdx: index('idx_gas_sponsor_log_sponsored_at').on(table.sponsoredAt),
}));

export const weatherCommitments = pgTable('weather_commitments', {
  id: serial('id').primaryKey(),
  stationId: text('station_id').notNull(),
  commitmentHash: text('commitment_hash').notNull(),
  revealDeadline: integer('reveal_deadline').notNull(),
  status: text('status').notNull().default('pending'),
  // Runtime-managed columns (also backfilled by ensureWeatherTables):
  nonce: text('nonce'),
  readingsJson: text('readings_json'),
  contributor: text('contributor'),
  // Unix-second timestamp fixed at commit time, replayed at reveal — part of the
  // core4 commit-hash preimage (#767). NULL for legacy pre-#767 commitments.
  commitTimestamp: integer('commit_timestamp'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  stationIdIdx: index('idx_weather_commitments_station').on(table.stationId),
  statusIdx: index('idx_weather_commitments_status').on(table.status),
  revealDeadlineIdx: index('idx_weather_commitments_deadline').on(table.revealDeadline),
}));

// Advisory-only oracle-reference scores (#866). Nothing in reward eligibility
// or minting reads this table.
export const referenceScores = pgTable('reference_scores', {
  id: serial('id').primaryKey(),
  commitmentId: integer('commitment_id').notNull().unique(),
  stationId: text('station_id').notNull(),
  tier: text('tier').notNull(),
  bandsVersion: integer('bands_version').notNull(),
  worstSource: text('worst_source'),
  worstVariable: text('worst_variable'),
  worstResidual: doublePrecision('worst_residual'),
  worstRatio: doublePrecision('worst_ratio'),
  residuals: jsonb('residuals').notNull(),
  analysisResidual: doublePrecision('analysis_residual'),
  forecastError: doublePrecision('forecast_error'),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  stationScoredIdx: index('idx_reference_scores_station_scored')
    .on(table.stationId, table.scoredAt),
  tierIdx: index('idx_reference_scores_tier').on(table.tier),
}));

export const streakCheckins = pgTable(
  'streak_checkins',
  {
    userId: integer('user_id').notNull(),
    dateKey: date('date_key').notNull(),
    tzOffsetMinutes: integer('tz_offset_minutes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.dateKey] }) })
);

export const streakBadgeClaims = pgTable(
  'streak_badge_claims',
  {
    userId: integer('user_id').notNull(),
    milestoneDays: integer('milestone_days').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow(),
    txHash: text('tx_hash'),
    nftContract: text('nft_contract'),
    tokenId: text('token_id'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.milestoneDays] }) })
);

export type StreakMilestoneClaimed = typeof streakMilestonesClaimed.$inferSelect;
export type InsertStreakMilestoneClaimed = typeof streakMilestonesClaimed.$inferInsert;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type InsertSocialAccount = typeof socialAccounts.$inferInsert;
export type GasSponsorLog = typeof gasSponsorLog.$inferSelect;
export type InsertGasSponsorLog = typeof gasSponsorLog.$inferInsert;
export type WeatherCommitment = typeof weatherCommitments.$inferSelect;
export type InsertWeatherCommitment = typeof weatherCommitments.$inferInsert;
export type ReferenceScore = typeof referenceScores.$inferSelect;
export type InsertReferenceScore = typeof referenceScores.$inferInsert;
export type StreakCheckin = typeof streakCheckins.$inferSelect;
export type InsertStreakCheckin = typeof streakCheckins.$inferInsert;
export type StreakBadgeClaim = typeof streakBadgeClaims.$inferSelect;
export type InsertStreakBadgeClaim = typeof streakBadgeClaims.$inferInsert;
