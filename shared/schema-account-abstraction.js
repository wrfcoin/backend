/**
 * Account Abstraction Schema - JavaScript Export
 * Provides compatibility layer for JavaScript imports
 */

const {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
} = require('drizzle-orm/pg-core');

// Define the account abstraction tables
const smartWallets = pgTable('smart_wallets', {
  id: serial('id').primaryKey(),
  address: varchar('address', { length: 42 }).notNull().unique(),
  owner: varchar('owner', { length: 42 }).notNull(),
  factory: varchar('factory', { length: 42 }).notNull(),
  implementation: varchar('implementation', { length: 42 }),
  salt: varchar('salt', { length: 66 }),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
});

const delegations = pgTable('delegations', {
  id: serial('id').primaryKey(),
  delegator: varchar('delegator', { length: 42 }).notNull(),
  delegate: varchar('delegate', { length: 42 }).notNull(),
  permissions: jsonb('permissions'),
  expiry: timestamp('expiry'),
  created_at: timestamp('created_at').defaultNow(),
});

const sponsors = pgTable('sponsors', {
  id: serial('id').primaryKey(),
  address: varchar('address', { length: 42 }).notNull().unique(),
  balance: varchar('balance', { length: 32 }).default('0'),
  is_active: boolean('is_active').default(true),
  created_at: timestamp('created_at').defaultNow(),
});

const userOperations = pgTable('user_operations', {
  id: serial('id').primaryKey(),
  hash: varchar('hash', { length: 66 }).notNull().unique(),
  sender: varchar('sender', { length: 42 }).notNull(),
  nonce: varchar('nonce', { length: 32 }).notNull(),
  init_code: text('init_code'),
  call_data: text('call_data'),
  call_gas_limit: varchar('call_gas_limit', { length: 32 }),
  verification_gas_limit: varchar('verification_gas_limit', { length: 32 }),
  pre_verification_gas: varchar('pre_verification_gas', { length: 32 }),
  max_fee_per_gas: varchar('max_fee_per_gas', { length: 32 }),
  max_priority_fee_per_gas: varchar('max_priority_fee_per_gas', { length: 32 }),
  paymaster_and_data: text('paymaster_and_data'),
  signature: text('signature'),
  status: varchar('status', { length: 20 }).default('pending'),
  created_at: timestamp('created_at').defaultNow(),
});

const bundles = pgTable('bundles', {
  id: serial('id').primaryKey(),
  hash: varchar('hash', { length: 66 }).notNull().unique(),
  bundler: varchar('bundler', { length: 42 }).notNull(),
  operation_count: integer('operation_count').default(0),
  gas_used: varchar('gas_used', { length: 32 }),
  status: varchar('status', { length: 20 }).default('pending'),
  created_at: timestamp('created_at').defaultNow(),
});

const bundleOperations = pgTable('bundle_operations', {
  id: serial('id').primaryKey(),
  bundle_id: integer('bundle_id').notNull(),
  user_operation_id: integer('user_operation_id').notNull(),
  position: integer('position').notNull(),
  created_at: timestamp('created_at').defaultNow(),
});

module.exports = {
  smartWallets,
  delegations,
  sponsors,
  userOperations,
  bundles,
  bundleOperations,
};
