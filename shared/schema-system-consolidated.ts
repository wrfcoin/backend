/**
 * Consolidated System Schema
 * Simplified from 20 tables across 3 schemas to 6 optimized tables
 * Maintains full analytics, infrastructure, and oracle functionality
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  decimal,
  integer,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Table 1: Unified analytics and performance metrics (replaces 5 analytics tables)
export const metricsConsolidated = pgTable('metrics_consolidated', {
  id: serial('id').primaryKey(),
  metricId: varchar('metric_id', { length: 64 }).notNull().unique(),
  metricType: varchar('metric_type', { length: 30 }).notNull(), // 'forecast_coverage', 'data_validation', 'proximity_incentive', 'validator_activity', 'oracle_participation'
  metricCategory: varchar('metric_category', { length: 50 }).notNull(), // 'weather', 'validation', 'network', 'performance'
  entityId: varchar('entity_id', { length: 64 }), // validator, node, or location identifier
  metricData: jsonb('metric_data').notNull(), // metric values and measurements
  coverageData: jsonb('coverage_data'), // forecast coverage specific data
  validationData: jsonb('validation_data'), // data validation attestation details
  incentiveData: jsonb('incentive_data'), // proximity and location-based incentives
  activityData: jsonb('activity_data'), // validator activity metrics
  participationData: jsonb('participation_data'), // oracle participation statistics
  calculationMethod: varchar('calculation_method', { length: 50 }), // how metric was calculated
  baselineValue: decimal('baseline_value', { precision: 20, scale: 8 }), // baseline for comparison
  currentValue: decimal('current_value', { precision: 20, scale: 8 }), // current metric value
  thresholdValues: jsonb('threshold_values'), // alert and warning thresholds
  timePeriod: varchar('time_period', { length: 20 }), // 'hourly', 'daily', 'weekly', 'monthly'
  locationData: jsonb('location_data'), // geographic information if applicable
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Table 2: Unified computational analytics (replaces 3 computational tables)
export const computationalConsolidated = pgTable('computational_consolidated', {
  id: serial('id').primaryKey(),
  computationId: varchar('computation_id', { length: 64 }).notNull().unique(),
  computationType: varchar('computation_type', { length: 30 }).notNull(), // 'block_data', 'task_execution', 'node_performance'
  nodeId: varchar('node_id', { length: 64 }), // computational node identifier
  taskId: varchar('task_id', { length: 64 }), // specific task identifier
  blockData: jsonb('block_data'), // computational block information
  taskData: jsonb('task_data'), // task execution details and metrics
  nodeData: jsonb('node_data'), // node performance and capacity data
  executionMetrics: jsonb('execution_metrics'), // performance measurements
  resourceUsage: jsonb('resource_usage'), // CPU, memory, storage utilization
  processingTime: decimal('processing_time', { precision: 10, scale: 3 }), // execution time in seconds
  successRate: decimal('success_rate', { precision: 5, scale: 2 }), // task success percentage
  errorData: jsonb('error_data'), // error logs and failure analysis
  optimizationData: jsonb('optimization_data'), // performance optimization insights
  networkImpact: jsonb('network_impact'), // impact on network performance
  rewardsEarned: decimal('rewards_earned', { precision: 36, scale: 18 }), // computational rewards
  status: varchar('status', { length: 20 }).default('active'), // 'active', 'idle', 'maintenance', 'offline'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
});

// Table 3: Unified infrastructure operations (replaces 5 infrastructure tables)
export const operationsConsolidated = pgTable('operations_consolidated', {
  id: serial('id').primaryKey(),
  operationId: varchar('operation_id', { length: 64 }).notNull().unique(),
  operationType: varchar('operation_type', { length: 30 }).notNull(), // 'migration', 'bundle_operation', 'bundle_management', 'fire_drill', 'deployment'
  operationCategory: varchar('operation_category', { length: 50 }), // 'database', 'application', 'testing', 'deployment'
  migrationData: jsonb('migration_data'), // database migration information
  bundleData: jsonb('bundle_data'), // application bundle details
  deploymentData: jsonb('deployment_data'), // deployment configuration and status
  testingData: jsonb('testing_data'), // fire drill and testing results
  operationConfig: jsonb('operation_config'), // operation configuration parameters
  executionPlan: jsonb('execution_plan'), // planned execution steps
  executionLog: jsonb('execution_log'), // detailed execution logs
  status: varchar('status', { length: 20 }).default('pending'), // 'pending', 'running', 'completed', 'failed', 'rolled_back'
  environment: varchar('environment', { length: 20 }), // 'development', 'staging', 'production'
  triggeredBy: varchar('triggered_by', { length: 64 }), // user or system that triggered operation
  dependencies: jsonb('dependencies'), // operation dependencies
  rollbackPlan: jsonb('rollback_plan'), // rollback procedure if needed
  createdAt: timestamp('created_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

// Table 4: Unified protocol management (replaces 3 protocol tables)
export const protocolConsolidated = pgTable('protocol_consolidated', {
  id: serial('id').primaryKey(),
  protocolId: varchar('protocol_id', { length: 64 }).notNull().unique(),
  protocolType: varchar('protocol_type', { length: 30 }).notNull(), // 'sponsor_management', 'algorithm_advancement', 'computational_nft'
  sponsorData: jsonb('sponsor_data'), // sponsor information and relationships
  advancementData: jsonb('advancement_data'), // algorithm improvement details
  nftData: jsonb('nft_data'), // computational NFT management
  contributionMetrics: jsonb('contribution_metrics'), // contribution measurements
  developmentProgress: jsonb('development_progress'), // advancement progress tracking
  fundingData: jsonb('funding_data'), // sponsor funding and allocations
  technicalSpecs: jsonb('technical_specs'), // technical specifications
  implementationStatus: varchar('implementation_status', { length: 20 }), // 'planned', 'in_progress', 'testing', 'deployed', 'deprecated'
  impactAnalysis: jsonb('impact_analysis'), // impact on protocol performance
  communityFeedback: jsonb('community_feedback'), // community input and reviews
  versionInfo: jsonb('version_info'), // versioning information
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending'), // 'pending', 'approved', 'rejected'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Table 5: Unified oracle operations (replaces 3 oracle tables)
export const requestsConsolidated = pgTable('requests_consolidated', {
  id: serial('id').primaryKey(),
  oracleId: varchar('oracle_id', { length: 64 }).notNull().unique(),
  requestType: varchar('request_type', { length: 30 }).notNull(), // 'data_request', 'data_response', 'validator_operation'
  requestId: varchar('request_id', { length: 64 }), // original request identifier
  responseId: varchar('response_id', { length: 64 }), // corresponding response identifier
  validatorId: varchar('validator_id', { length: 64 }), // oracle validator handling request
  requestData: jsonb('request_data'), // original request details
  responseData: jsonb('response_data'), // response data and results
  validatorData: jsonb('validator_data'), // validator information and performance
  dataSource: varchar('data_source', { length: 100 }), // external data source
  queryParameters: jsonb('query_parameters'), // query configuration
  verificationData: jsonb('verification_data'), // data verification proofs
  consensusData: jsonb('consensus_data'), // validator consensus information
  status: varchar('status', { length: 20 }).default('pending'), // 'pending', 'processing', 'completed', 'failed', 'disputed'
  priority: integer('priority').default(5), // request priority level
  timeoutSeconds: integer('timeout_seconds'), // request timeout configuration
  retryCount: integer('retry_count').default(0), // number of retry attempts
  costData: jsonb('cost_data'), // oracle operation costs
  createdAt: timestamp('created_at').notNull().defaultNow(),
  processedAt: timestamp('processed_at'),
  completedAt: timestamp('completed_at'),
});

// Table 6: Unified external service integrations (replaces 1 oracle table)
export const integrationsConsolidated = pgTable('integrations_consolidated', {
  id: serial('id').primaryKey(),
  integrationId: varchar('integration_id', { length: 64 }).notNull().unique(),
  integrationType: varchar('integration_type', { length: 30 }).notNull(), // 'wolfram_alpha', 'external_api', 'data_provider'
  serviceName: varchar('service_name', { length: 100 }).notNull(),
  configuration: jsonb('configuration').notNull(), // service configuration settings
  authenticationData: jsonb('authentication_data'), // API keys and auth configuration
  rateLimits: jsonb('rate_limits'), // rate limiting configuration
  endpointMapping: jsonb('endpoint_mapping'), // API endpoint mappings
  dataTransformation: jsonb('data_transformation'), // data transformation rules
  errorHandling: jsonb('error_handling'), // error handling configuration
  monitoringConfig: jsonb('monitoring_config'), // monitoring and alerting setup
  performanceMetrics: jsonb('performance_metrics'), // service performance data
  usageStatistics: jsonb('usage_statistics'), // usage tracking and analytics
  isActive: boolean('is_active').default(true),
  lastHealthCheck: timestamp('last_health_check'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Relations
export const metricsConsolidatedRelations = relations(
  metricsConsolidated,
  ({ many }) => ({
    computationalMetrics: many(computationalConsolidated),
  })
);

export const computationalConsolidatedRelations = relations(
  computationalConsolidated,
  ({ one }) => ({
    relatedMetrics: one(metricsConsolidated, {
      fields: [computationalConsolidated.nodeId],
      references: [metricsConsolidated.entityId],
    }),
  })
);

export const operationsConsolidatedRelations = relations(
  operationsConsolidated,
  ({ many }) => ({
    protocolOperations: many(protocolConsolidated),
  })
);

export const protocolConsolidatedRelations = relations(
  protocolConsolidated,
  ({ one }) => ({
    relatedOperations: one(operationsConsolidated, {
      fields: [protocolConsolidated.protocolId],
      references: [operationsConsolidated.operationId],
    }),
  })
);

export const requestsConsolidatedRelations = relations(
  requestsConsolidated,
  ({ one }) => ({
    integration: one(integrationsConsolidated, {
      fields: [requestsConsolidated.dataSource],
      references: [integrationsConsolidated.serviceName],
    }),
  })
);

export const integrationsConsolidatedRelations = relations(
  integrationsConsolidated,
  ({ many }) => ({
    requests: many(requestsConsolidated),
  })
);

// Export all consolidated System tables
export const systemConsolidatedSchema = {
  metricsConsolidated,
  computationalConsolidated,
  operationsConsolidated,
  protocolConsolidated,
  requestsConsolidated,
  integrationsConsolidated,
};
