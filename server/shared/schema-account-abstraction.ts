import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

// Define numeric type for this file
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

// Smart Wallets table
export const smartWallets = pgTable('smart_wallets', {
  id: serial('id').primaryKey(),
  address: varchar('address', { length: 255 }).notNull().unique(),
  userId: integer('user_id').notNull(),
  publicKey: text('public_key').notNull(),
  mode: varchar('mode', { length: 50 }).default('STANDARD').notNull(), // STANDARD, MULTI_SIG, SOCIAL_RECOVERY, etc.
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  nonce: integer('nonce').default(0).notNull(),
  recoveryAddresses: jsonb('recovery_addresses'), // Array of addresses for recovery
  authRequirements: jsonb('auth_requirements'), // Authentication requirements
  threshold: integer('threshold'), // Used for multi-sig wallets
  scriptHash: varchar('script_hash', { length: 255 }), // Hash of custom script if scriptable wallet
  implementation: varchar('implementation', { length: 255 }), // Implementation type or version
  deviceId: varchar('device_id', { length: 255 }), // Device identifier if tied to a device
  metadata: jsonb('metadata'), // Additional metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Delegations table - for delegated control of wallets
export const delegations = pgTable('delegations', {
  id: serial('id').primaryKey(),
  delegationId: varchar('delegation_id', { length: 255 }).notNull().unique(),
  walletId: integer('wallet_id').notNull(),
  delegateAddress: varchar('delegate_address', { length: 255 }).notNull(),
  permissions: jsonb('permissions').notNull(), // Array of permissions granted
  expirationTime: timestamp('expiration_time'),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  revokedAt: timestamp('revoked_at'),
  signature: text('signature'), // Signature authorizing this delegation
  authType: varchar('auth_type', { length: 50 })
    .default('STANDARD_SIGNATURE')
    .notNull(),
  approvalRequirements: jsonb('approval_requirements'), // Requirements for operations
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Sponsors table - for gas sponsorship
export const sponsors = pgTable('sponsors', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id').notNull(),
  sponsorAddress: varchar('sponsor_address', { length: 255 }).notNull(),
  maxAllowance: numeric('max_allowance').notNull(),
  allowedOperations: jsonb('allowed_operations'), // Types of operations allowed to sponsor
  contractWhitelist: jsonb('contract_whitelist'), // Whitelisted contracts for sponsorship
  isActive: boolean('is_active').default(true).notNull(),
  sponsorType: varchar('sponsor_type', { length: 50 })
    .default('INDIVIDUAL')
    .notNull(), // INDIVIDUAL, ORGANIZATION, etc.
  usagePolicy: jsonb('usage_policy'), // Usage policy restrictions
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// User Operations table - for individual operations to be executed
export const userOperations = pgTable('user_operations', {
  id: serial('id').primaryKey(),
  operationId: varchar('operation_id', { length: 255 }).notNull().unique(),
  walletId: integer('wallet_id').notNull(),
  operationType: varchar('operation_type', { length: 50 }).notNull(), // TRANSFER, CONTRACT_CALL, etc.
  target: varchar('target', { length: 255 }).notNull(), // Target address
  value: numeric('value').default(0).notNull(), // Value to send
  data: text('data'), // Function call data
  nonce: integer('nonce').notNull(),
  hash: varchar('hash', { length: 255 }), // Hash of the operation
  signature: text('signature'), // Signature authorizing this operation
  delegationId: integer('delegation_id'), // If operation is executed via delegation
  sponsorId: integer('sponsor_id'), // If operation is sponsored
  status: varchar('status', { length: 50 }).default('CREATED').notNull(), // CREATED, PENDING, CONFIRMED, REJECTED, FAILED
  gasUsed: numeric('gas_used'),
  gasPrice: numeric('gas_price'),
  expirationTime: timestamp('expiration_time'),
  executedAt: timestamp('executed_at'),
  failureReason: text('failure_reason'),
  metadata: jsonb('metadata'), // Additional metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Bundles table - for bundling operations together
export const bundles = pgTable('bundles', {
  id: serial('id').primaryKey(),
  bundleId: varchar('bundle_id', { length: 255 }).notNull().unique(),
  initiatorAddress: varchar('initiator_address', { length: 255 }).notNull(),
  bundleType: varchar('bundle_type', { length: 50 })
    .default('STANDARD')
    .notNull(), // STANDARD, ATOMIC, CONDITIONAL, etc.
  atomicExecution: boolean('atomic_execution').default(true).notNull(), // Whether bundle should be executed atomically
  hash: varchar('hash', { length: 255 }), // Hash of the bundle
  status: varchar('status', { length: 50 }).default('CREATED').notNull(), // CREATED, PENDING, CONFIRMED, REJECTED, FAILED
  gasUsed: numeric('gas_used'),
  gasPrice: numeric('gas_price'),
  executedAt: timestamp('executed_at'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Bundle Operations table - for tracking operations in bundles
export const bundleOperations = pgTable('bundle_operations', {
  id: serial('id').primaryKey(),
  bundleId: integer('bundle_id').notNull(),
  operationId: integer('operation_id').notNull(),
  executionOrder: integer('execution_order').notNull(), // Order of execution within bundle
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Account Recovery Requests table
export const accountRecoveryRequests = pgTable('account_recovery_requests', {
  id: serial('id').primaryKey(),
  requestId: varchar('request_id', { length: 255 }).notNull().unique(),
  walletId: integer('wallet_id').notNull(),
  requestorAddress: varchar('requestor_address', { length: 255 }).notNull(),
  recoveryMethod: varchar('recovery_method', { length: 50 }).notNull(), // SOCIAL, BACKUP, GUARDIAN, etc.
  evidence: jsonb('evidence'), // Evidence supporting recovery
  approvals: jsonb('approvals'), // Collection of approvals
  status: varchar('status', { length: 50 }).default('PENDING').notNull(), // PENDING, APPROVED, REJECTED, COMPLETED
  completedAt: timestamp('completed_at'),
  newAddress: varchar('new_address', { length: 255 }),
  newPublicKey: text('new_public_key'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Export types for TypeScript
export type SmartWallet = typeof smartWallets.$inferSelect;
export type InsertSmartWallet = typeof smartWallets.$inferInsert;

export type Delegation = typeof delegations.$inferSelect;
export type InsertDelegation = typeof delegations.$inferInsert;

export type Sponsor = typeof sponsors.$inferSelect;
export type InsertSponsor = typeof sponsors.$inferInsert;

export type UserOperation = typeof userOperations.$inferSelect;
export type InsertUserOperation = typeof userOperations.$inferInsert;

export type Bundle = typeof bundles.$inferSelect;
export type InsertBundle = typeof bundles.$inferInsert;

export type BundleOperation = typeof bundleOperations.$inferSelect;
export type InsertBundleOperation = typeof bundleOperations.$inferInsert;

export type AccountRecoveryRequest =
  typeof accountRecoveryRequests.$inferSelect;
export type InsertAccountRecoveryRequest =
  typeof accountRecoveryRequests.$inferInsert;
