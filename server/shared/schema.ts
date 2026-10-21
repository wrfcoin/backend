import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  customType,
} from 'drizzle-orm/pg-core';

// Add numeric type support
export const numeric = customType<{
  data: number;
  driverData: string;
}>({
  dataType() {
    return 'numeric';
  },
  toDriver(value: number): string {
    return value.toString();
  },
  fromDriver(value: string): number {
    return parseFloat(value);
  },
});

// Users table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  profilePicture: text('profile_picture'),
  bio: text('bio'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at'),
  isActive: boolean('is_active').default(true).notNull(),
  role: varchar('role', { length: 50 }).default('user').notNull(),
  preferences: jsonb('preferences'),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// User Sessions table
export const userSessions = pgTable('user_sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  token: varchar('token', { length: 255 }).notNull().unique(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at'),
});

// Authentication Factors table
export const authFactors = pgTable('auth_factors', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  factorType: varchar('factor_type', { length: 50 }).notNull(), // 'totp', 'sms', 'email', etc.
  secret: varchar('secret', { length: 255 }),
  isVerified: boolean('is_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});

// Weather Sensors table
export const weatherSensors = pgTable('weather_sensors', {
  id: serial('id').primaryKey(),
  ownerId: integer('owner_id').references(() => users.id),
  sensorId: varchar('sensor_id', { length: 100 }).notNull().unique(),
  deviceType: varchar('device_type', { length: 100 }).notNull(),
  location: jsonb('location').notNull(), // { lat: number, lng: number, alt?: number }
  status: varchar('status', { length: 50 }).default('active').notNull(),
  installationDate: timestamp('installation_date'),
  lastMaintenance: timestamp('last_maintenance'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastDataAt: timestamp('last_data_at'),
  metadata: jsonb('metadata'),
  calibrationData: jsonb('calibration_data'),
});

// Weather Data Readings table
export const weatherDataReadings = pgTable('weather_data_readings', {
  id: serial('id').primaryKey(),
  sensorId: varchar('sensor_id', { length: 100 }).notNull(),
  timestamp: timestamp('timestamp').notNull(),
  temperature: jsonb('temperature'), // { value: number, unit: string, precision: number }
  humidity: jsonb('humidity'), // { value: number, unit: string, precision: number }
  pressure: jsonb('pressure'), // { value: number, unit: string, precision: number }
  windSpeed: jsonb('wind_speed'), // { value: number, unit: string, precision: number }
  windDirection: jsonb('wind_direction'), // { value: number, unit: string }
  precipitation: jsonb('precipitation'), // { value: number, unit: string, timespan: string }
  solarRadiation: jsonb('solar_radiation'), // { value: number, unit: string }
  additionalData: jsonb('additional_data'),
  quality: integer('quality').default(100), // 0-100 quality score
  isVerified: boolean('is_verified').default(false).notNull(),
});

// Forecasts table
export const forecasts = pgTable('forecasts', {
  id: serial('id').primaryKey(),
  forecastId: varchar('forecast_id', { length: 100 }).notNull().unique(),
  creatorId: integer('creator_id').references(() => users.id),
  region: jsonb('region').notNull(), // { name: string, bounds: { ne: {lat, lng}, sw: {lat, lng} } }
  timestamp: timestamp('timestamp').notNull(),
  validFrom: timestamp('valid_from').notNull(),
  validTo: timestamp('valid_to').notNull(),
  forecastType: varchar('forecast_type', { length: 50 }).notNull(), // 'temperature', 'precipitation', etc.
  forecastData: jsonb('forecast_data').notNull(),
  accuracy: jsonb('accuracy'), // { score: number, method: string, reference: string }
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  metadata: jsonb('metadata'),
  source: varchar('source', { length: 100 }).notNull(), // 'model-name' or 'ensemble'
});

// Blocks table
export const blocks = pgTable('blocks', {
  id: serial('id').primaryKey(),
  blockHeight: integer('block_height').notNull().unique(),
  blockHash: varchar('block_hash', { length: 255 }).notNull().unique(),
  previousHash: varchar('previous_hash', { length: 255 }).notNull(),
  timestamp: timestamp('timestamp').notNull(),
  transactions: jsonb('transactions'), // Array of transaction IDs
  merkleRoot: varchar('merkle_root', { length: 255 }).notNull(),
  blockType: varchar('block_type', { length: 50 })
    .default('standard')
    .notNull(),
  createdBy: varchar('created_by', { length: 255 }).notNull(), // Validator address
  signature: varchar('signature', { length: 255 }).notNull(),
  size: integer('size').notNull(), // Size in bytes
  difficulty: integer('difficulty').notNull(),
  nonce: varchar('nonce', { length: 255 }).notNull(),
  extraData: jsonb('extra_data'),
});

// Transactions table
export const transactions = pgTable('transactions', {
  id: serial('id').primaryKey(),
  txId: varchar('tx_id', { length: 255 }).notNull().unique(),
  blockHeight: integer('block_height').references(() => blocks.blockHeight),
  timestamp: timestamp('timestamp').notNull(),
  fromAddress: varchar('from_address', { length: 255 }).notNull(),
  toAddress: varchar('to_address', { length: 255 }).notNull(),
  amount: jsonb('amount').notNull(), // { value: number, unit: string }
  fee: jsonb('fee').notNull(), // { value: number, unit: string }
  txType: varchar('tx_type', { length: 50 }).default('regular').notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  data: jsonb('data'),
  signature: varchar('signature', { length: 255 }).notNull(),
});

// Validators table
export const validators = pgTable('validators', {
  id: serial('id').primaryKey(),
  address: varchar('address', { length: 255 }).notNull().unique(),
  pubKey: varchar('pub_key', { length: 255 }).notNull().unique(),
  nickname: varchar('nickname', { length: 100 }),
  stake: jsonb('stake').notNull(), // { value: number, unit: string }
  status: varchar('status', { length: 50 }).default('active').notNull(),
  validatorType: varchar('validator_type', { length: 50 })
    .default('standard')
    .notNull(),
  commissionRate: jsonb('commission_rate'), // { value: number, unit: string }
  uptime: jsonb('uptime'), // { value: number, timespan: string }
  totalBlocks: integer('total_blocks').default(0).notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at'),
  slashingHistory: jsonb('slashing_history'), // Array of slashing events
  location: jsonb('location'), // { lat: number, lng: number, region: string }
  website: varchar('website', { length: 255 }),
  description: text('description'),
});

// Computational NFTs table
export const computationalNfts = pgTable('computational_nfts', {
  id: serial('id').primaryKey(),
  nftId: varchar('nft_id', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  creator: varchar('creator', { length: 255 }).notNull(),
  contentUri: text('content_uri'),
  computationType: varchar('computation_type', { length: 100 }).notNull(),
  computationComplexity: integer('computation_complexity').default(1).notNull(),
  resourceRequirements: jsonb('resource_requirements'),
  inputData: jsonb('input_data'),
  parameters: jsonb('parameters'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  verifiers: jsonb('verifiers'), // Array of verifier addresses
  region: varchar('region', { length: 100 }),
  accuracy: numeric('accuracy'),
  creatorReputation: jsonb('creator_reputation'),
  verificationSignatures: jsonb('verification_signatures'), // Array of signatures
  executionResultHash: varchar('execution_result_hash', { length: 255 }),
  metadata: jsonb('metadata'),
  transactionId: varchar('transaction_id', { length: 255 }),
});

// Computational Tasks table
export const computationalTasks = pgTable('computational_tasks', {
  id: serial('id').primaryKey(),
  taskId: varchar('task_id', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  latitude: numeric('latitude'),
  longitude: numeric('longitude'),
  region: varchar('region', { length: 100 }).default(''),
  regionCode: varchar('region_code', { length: 50 }),
  taskType: varchar('task_type', { length: 100 }).notNull(),
  priority: varchar('priority', { length: 50 }).default('standard').notNull(),
  baseReward: integer('base_reward').notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deadline: timestamp('deadline'),
  requiresVerification: boolean('requires_verification')
    .default(true)
    .notNull(),
  dataMetrics: jsonb('data_metrics').default({}),
  assignedNodeId: varchar('assigned_node_id', { length: 100 }),
  nftId: integer('nft_id').references(() => computationalNfts.id),
});

export const weatherCommitments = pgTable('weather_commitments', {
  id: serial('id').primaryKey(),
  stationId: text('station_id').notNull(),
  commitmentHash: text('commitment_hash').notNull(),
  revealDeadline: integer('reveal_deadline').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
});

export type ComputationalNft = typeof computationalNfts.$inferSelect;
export type InsertComputationalNft = typeof computationalNfts.$inferInsert;

export type ComputationalTask = typeof computationalTasks.$inferSelect;
export type InsertComputationalTask = typeof computationalTasks.$inferInsert;
export type WeatherCommitment = typeof weatherCommitments.$inferSelect;
export type InsertWeatherCommitment = typeof weatherCommitments.$inferInsert;
