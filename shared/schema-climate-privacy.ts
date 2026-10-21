import { relations } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';

// Climate privacy levels
export const CLIMATE_PRIVACY_LEVELS = [
  'basic',
  'enhanced',
  'maximum',
  'selective_disclosure',
] as const;

// Climate stealth address types
export const CLIMATE_STEALTH_ADDRESS_TYPES = [
  'weather_data_reward',
  'sensor_owner_identity',
  'carbon_credit_transfer',
  'climate_fund_disbursement',
  'data_validation_payment',
  'research_data_access',
] as const;

// Private weather data submissions table
export const privateWeatherData = pgTable('private_weather_data', {
  id: serial('id').primaryKey(),
  submissionId: text('submission_id').notNull().unique(),

  // Original weather data reference
  originalWeatherDataId: integer('original_weather_data_id'),

  // Stealth address information
  rewardStealthAddress: jsonb('reward_stealth_address').notNull(),
  sensorOwnerStealthAddress: jsonb('sensor_owner_stealth_address'),

  // Privacy metadata
  privacyLevel: text('privacy_level', {
    enum: CLIMATE_PRIVACY_LEVELS,
  }).notNull(),
  addressType: text('address_type', {
    enum: CLIMATE_STEALTH_ADDRESS_TYPES,
  }).notNull(),
  dataType: text('data_type'),
  regionCode: text('region_code'),
  complianceFlags: jsonb('compliance_flags'),

  // Encrypted data
  encryptedSensorData: text('encrypted_sensor_data'),
  encryptedPayload: text('encrypted_payload'),

  // Cryptographic proofs
  validityProof: text('validity_proof'),
  rangeProof: text('range_proof'),

  // Transaction references
  transactionId: text('transaction_id'),
  blockHash: text('block_hash'),
  blockHeight: integer('block_height'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Additional metadata
  metadata: jsonb('metadata'),
});

// Private climate transactions table
export const privateClimateTransactions = pgTable(
  'private_climate_transactions',
  {
    id: serial('id').primaryKey(),
    transactionId: text('transaction_id').notNull().unique(),

    // Transaction type and context
    transactionType: text('transaction_type').notNull(), // 'carbon_credit', 'climate_fund', 'data_reward', etc.
    climateContext: text('climate_context'), // Additional context for the transaction

    // Stealth address information
    senderStealthAddress: jsonb('sender_stealth_address'),
    recipientStealthAddress: jsonb('recipient_stealth_address').notNull(),

    // Privacy details
    privacyLevel: text('privacy_level', {
      enum: CLIMATE_PRIVACY_LEVELS,
    }).notNull(),
    addressType: text('address_type', {
      enum: CLIMATE_STEALTH_ADDRESS_TYPES,
    }).notNull(),

    // Confidential transaction data
    confidentialAmount: jsonb('confidential_amount'), // Pedersen commitment
    encryptedAmount: text('encrypted_amount'),
    rangeProof: text('range_proof'),

    // Compliance and regulatory
    regionCode: text('region_code'),
    complianceFlags: jsonb('compliance_flags'),
    regulatoryData: jsonb('regulatory_data'),

    // Project or program references
    projectId: text('project_id'),
    programId: text('program_id'),

    // Nullifier for preventing double spending (for shielded transactions)
    nullifierHash: text('nullifier_hash'),
    commitmentIndex: integer('commitment_index'),

    // Zero-knowledge proofs
    membershipProof: text('membership_proof'),
    validityProof: text('validity_proof'),

    // Blockchain references
    blockHash: text('block_hash'),
    blockHeight: integer('block_height'),

    // Status and processing
    status: text('status').notNull().default('pending'),
    processedAt: timestamp('processed_at'),

    // Timestamps
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // Additional metadata
    metadata: jsonb('metadata'),
  }
);

// Carbon credit privacy table
export const privateCarbonCredits = pgTable('private_carbon_credits', {
  id: serial('id').primaryKey(),
  creditId: text('credit_id').notNull().unique(),

  // Credit details
  projectId: text('project_id').notNull(),
  vintageYear: integer('vintage_year').notNull(),
  creditType: text('credit_type'),

  // Privacy information
  buyerStealthAddress: jsonb('buyer_stealth_address').notNull(),
  sellerStealthAddress: jsonb('seller_stealth_address').notNull(),

  // Confidential amount
  confidentialCreditAmount: jsonb('confidential_credit_amount'),
  encryptedAmount: text('encrypted_amount'),
  rangeProof: text('range_proof'),

  // Registry and compliance
  registryData: jsonb('registry_data'),
  complianceFlags: jsonb('compliance_flags'),
  verificationProof: text('verification_proof'),

  // Privacy metadata
  privacyLevel: text('privacy_level', {
    enum: CLIMATE_PRIVACY_LEVELS,
  }).notNull(),
  regionCode: text('region_code'),

  // Transaction reference
  transactionId: text('transaction_id'),

  // Status
  status: text('status').notNull().default('pending'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  transferredAt: timestamp('transferred_at'),

  // Additional metadata
  metadata: jsonb('metadata'),
});

// Climate fund disbursements privacy table
export const privateClimateFunds = pgTable('private_climate_funds', {
  id: serial('id').primaryKey(),
  disbursementId: text('disbursement_id').notNull().unique(),

  // Fund program details
  programId: text('program_id').notNull(),
  purpose: text('purpose').notNull(),
  fundingSource: text('funding_source'),

  // Recipient privacy
  recipientStealthAddress: jsonb('recipient_stealth_address').notNull(),

  // Confidential amount
  confidentialAmount: jsonb('confidential_amount'),
  encryptedAmount: text('encrypted_amount'),
  rangeProof: text('range_proof'),

  // Compliance and reporting
  complianceData: jsonb('compliance_data'),
  encryptedMilestones: text('encrypted_milestones'),
  reportingRequirements: jsonb('reporting_requirements'),

  // Privacy settings
  privacyLevel: text('privacy_level', {
    enum: CLIMATE_PRIVACY_LEVELS,
  }).notNull(),
  regionCode: text('region_code'),
  complianceFlags: jsonb('compliance_flags'),

  // Transaction reference
  transactionId: text('transaction_id'),

  // Status and milestones
  status: text('status').notNull().default('pending'),
  milestonesCompleted: integer('milestones_completed').default(0),
  totalMilestones: integer('total_milestones'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  disbursedAt: timestamp('disbanded_at'),
  completedAt: timestamp('completed_at'),

  // Additional metadata
  metadata: jsonb('metadata'),
});

// Climate stealth address registry
export const climateStealthAddressRegistry = pgTable(
  'climate_stealth_address_registry',
  {
    id: serial('id').primaryKey(),
    addressId: text('address_id').notNull().unique(),

    // Stealth address components (stored as hex strings)
    publicSpendKey: text('public_spend_key').notNull(),
    publicViewKey: text('public_view_key').notNull(),
    oneTimePublicKey: text('one_time_public_key').notNull(),
    transactionKey: text('transaction_key').notNull(),
    paymentId: text('payment_id'),

    // Address purpose and type
    addressType: text('address_type', {
      enum: CLIMATE_STEALTH_ADDRESS_TYPES,
    }).notNull(),
    purpose: text('purpose'),

    // Associated data context
    dataType: text('data_type'),
    projectId: text('project_id'),
    programId: text('program_id'),

    // Privacy settings
    privacyLevel: text('privacy_level', {
      enum: CLIMATE_PRIVACY_LEVELS,
    }).notNull(),
    regionCode: text('region_code'),

    // Usage tracking
    isUsed: boolean('is_used').default(false),
    usedAt: timestamp('used_at'),
    transactionId: text('transaction_id'),

    // Expiration
    expiresAt: timestamp('expires_at'),

    // Timestamps
    createdAt: timestamp('created_at').notNull().defaultNow(),

    // Additional metadata
    metadata: jsonb('metadata'),
  }
);

// Climate privacy keys management table
export const climatePrivacyKeys = pgTable('climate_privacy_keys', {
  id: serial('id').primaryKey(),
  keyId: text('key_id').notNull().unique(),

  // Key owner
  ownerId: text('owner_id').notNull(),
  ownerType: text('owner_type').notNull(), // 'user', 'sensor', 'organization', etc.

  // Key purpose
  keyPurpose: text('key_purpose', {
    enum: CLIMATE_STEALTH_ADDRESS_TYPES,
  }).notNull(),

  // Public keys (private keys stored securely elsewhere, stored as hex strings)
  publicSpendKey: text('public_spend_key').notNull(),
  publicViewKey: text('public_view_key').notNull(),

  // Key metadata
  keyLabel: text('key_label'),
  description: text('description'),

  // Regional and compliance
  regionCode: text('region_code'),
  complianceFlags: jsonb('compliance_flags'),

  // Status
  status: text('status').notNull().default('active'), // 'active', 'revoked', 'expired'

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsed: timestamp('last_used'),
  expiresAt: timestamp('expires_at'),
  revokedAt: timestamp('revoked_at'),

  // Additional metadata
  metadata: jsonb('metadata'),
});

// Climate transaction audit log
export const climateTransactionAuditLog = pgTable(
  'climate_transaction_audit_log',
  {
    id: serial('id').primaryKey(),
    auditId: text('audit_id').notNull().unique(),

    // Transaction reference
    transactionId: text('transaction_id').notNull(),
    transactionType: text('transaction_type').notNull(),

    // Audit event
    auditEvent: text('audit_event').notNull(), // 'created', 'validated', 'committed', 'rejected', etc.
    auditDetails: jsonb('audit_details'),

    // Privacy context
    privacyLevel: text('privacy_level', { enum: CLIMATE_PRIVACY_LEVELS }),
    privacyFeatures: jsonb('privacy_features'), // List of applied privacy features

    // Compliance
    complianceChecks: jsonb('compliance_checks'),
    complianceStatus: text('compliance_status'),

    // Actor information (may be anonymous)
    actorId: text('actor_id'),
    actorType: text('actor_type'), // 'user', 'system', 'validator', etc.

    // System information
    systemVersion: text('system_version'),
    nodeId: text('node_id'),

    // Timestamps
    timestamp: timestamp('timestamp').notNull().defaultNow(),

    // Additional metadata
    metadata: jsonb('metadata'),
  }
);

// Relations
export const privateWeatherDataRelations = relations(
  privateWeatherData,
  ({ one }) => ({
    // Add relations to existing weather_data table when needed
  })
);

export const privateClimateTransactionsRelations = relations(
  privateClimateTransactions,
  ({ one }) => ({
    // Add relations to existing transactions table when needed
  })
);

export const privateCarbonCreditsRelations = relations(
  privateCarbonCredits,
  ({ one }) => ({
    // Add relations to carbon credit systems when available
  })
);

export const privateClimateFundsRelations = relations(
  privateClimateFunds,
  ({ one }) => ({
    // Add relations to funding systems when available
  })
);

export const climateStealthAddressRegistryRelations = relations(
  climateStealthAddressRegistry,
  ({ many }) => ({
    transactions: many(privateClimateTransactions),
  })
);

export const climatePrivacyKeysRelations = relations(
  climatePrivacyKeys,
  ({ many }) => ({
    stealthAddresses: many(climateStealthAddressRegistry),
  })
);

export const climateTransactionAuditLogRelations = relations(
  climateTransactionAuditLog,
  ({ one }) => ({
    transaction: one(privateClimateTransactions, {
      fields: [climateTransactionAuditLog.transactionId],
      references: [privateClimateTransactions.transactionId],
    }),
  })
);
