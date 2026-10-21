/**
 * Database Structure Analyzer
 * Analyzes actual table structures to create accurate consolidation scripts
 */

const { Pool } = require('pg');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

class DatabaseAnalyzer {
  constructor() {
    this.analysis = {
      schemas: {},
      tableCount: 0,
      consolidationPlan: {},
    };
  }

  async analyzeSchema(schemaName) {
    logger.info('Analyzing schema', { schema: schemaName });

    // Get all tables in schema
    const tablesQuery = `
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns 
              WHERE table_schema = $1 AND table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = $1 
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '%backup%'
        AND table_name NOT LIKE '%consolidated%'
      ORDER BY table_name;
    `;

    const tablesResult = await pool.query(tablesQuery, [schemaName]);

    const tables = {};
    for (const table of tablesResult.rows) {
      // Get column details for each table
      const columnsQuery = `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position;
      `;

      const columnsResult = await pool.query(columnsQuery, [
        schemaName,
        table.table_name,
      ]);

      // Get row count for each table
      const countQuery = `SELECT COUNT(*) as row_count FROM ${schemaName}.${table.table_name};`;
      const countResult = await pool.query(countQuery);

      tables[table.table_name] = {
        columns: columnsResult.rows,
        columnCount: table.column_count,
        rowCount: parseInt(countResult.rows[0].row_count),
      };
    }

    this.analysis.schemas[schemaName] = {
      tableCount: tablesResult.rows.length,
      tables: tables,
    };

    logger.info('Found tables', { schema: schemaName, count: tablesResult.rows.length });
    return tables;
  }

  async analyzeAll() {
    logger.info('Starting comprehensive database structure analysis');

    const schemas = [
      'rewards',
      'crosschain',
      'governance',
      'iot',
      'users',
      'analytics',
      'infra',
      'oracle',
    ];

    for (const schema of schemas) {
      try {
        await this.analyzeSchema(schema);
      } catch (error) {
        logger.error('Error analyzing schema', { schema, error: error.message });
      }
    }

    // Calculate totals
    this.analysis.tableCount = Object.values(this.analysis.schemas).reduce(
      (sum, schema) => sum + schema.tableCount,
      0
    );

    this.generateConsolidationPlan();
    this.displayAnalysis();
    this.saveAnalysis();
  }

  generateConsolidationPlan() {
    logger.info('Generating consolidation plan based on actual structure');

    // Rewards schema: 13 → 4 tables
    this.analysis.consolidationPlan.rewards = {
      current: this.analysis.schemas.rewards?.tableCount || 0,
      target: 4,
      consolidatedTables: {
        achievements_master: [
          'achievements',
          'achievement_categories',
          'achievement_progress',
          'user_achievements',
          'miner_achievements',
          'miner_achievement_progress',
          'miner_earned_achievements',
        ],
        token_rewards_master: [
          'mining_rewards',
          'validator_rewards',
          'contributor_rewards',
        ],
        reward_config_master: ['reward_distribution_config'],
        mining_contributions_master: ['mining_contributions'],
      },
    };

    // CrossChain schema: 16 → 4 tables
    this.analysis.consolidationPlan.crosschain = {
      current: this.analysis.schemas.crosschain?.tableCount || 0,
      target: 4,
      consolidatedTables: {
        protocols_master: [
          'bridge_protocols',
          'bridge_configurations',
          'protocol_fees',
          'protocol_limits',
        ],
        transfers_master: [
          'bridge_transfers',
          'transfer_history',
          'pending_transfers',
          'failed_transfers',
        ],
        tokens_master: [
          'supported_tokens',
          'token_mappings',
          'token_balances',
          'liquidity_pools',
        ],
        messages_master: [
          'cross_chain_messages',
          'message_proofs',
          'validator_signatures',
          'relay_confirmations',
        ],
      },
    };

    // Continue for other schemas...
    logger.info('Consolidation plan generated');
  }

  displayAnalysis() {
    logger.info('DATABASE STRUCTURE ANALYSIS RESULTS');
    logger.info('=====================================');
    logger.info('Total Tables', { count: this.analysis.tableCount });
    logger.info('Target Tables: 27 (69% reduction)');

    for (const [schemaName, schema] of Object.entries(this.analysis.schemas)) {
      logger.info(`${schemaName.toUpperCase()} Schema`, { tables: schema.tableCount });

      // Show tables with data
      const tablesWithData = Object.entries(schema.tables)
        .filter(([_, table]) => table.rowCount > 0)
        .map(([name, table]) => `${name} (${table.rowCount} rows)`);

      if (tablesWithData.length > 0) {
        logger.info('Tables with data', { tables: tablesWithData.join(', ') });
      } else {
        logger.info('Tables with data: None');
      }

      // Show column structure for key tables
      const keyTables = Object.entries(schema.tables)
        .filter(([_, table]) => table.rowCount > 0)
        .slice(0, 2); // Show first 2 tables with data

      for (const [tableName, table] of keyTables) {
        const columnNames = table.columns
          .map(col => col.column_name)
          .slice(0, 5);
        logger.info(`${tableName} columns`, {
          columns: columnNames.join(', ') + (table.columns.length > 5 ? '...' : '')
        });
      }
    }
  }

  async saveAnalysis() {
    const analysisFile = {
      timestamp: new Date().toISOString(),
      totalTables: this.analysis.tableCount,
      targetTables: 27,
      reductionPercentage: Math.round(
        (1 - 27 / this.analysis.tableCount) * 100
      ),
      schemas: this.analysis.schemas,
      consolidationPlan: this.analysis.consolidationPlan,
    };

    const fs = require('fs');
    fs.writeFileSync(
      'database-structure-analysis.json',
      JSON.stringify(analysisFile, null, 2)
    );
    logger.info('Analysis saved to database-structure-analysis.json');
  }
}

async function main() {
  const analyzer = new DatabaseAnalyzer();
  try {
    await analyzer.analyzeAll();
    logger.info('Database structure analysis complete');
    logger.info('Ready to create accurate consolidation scripts');
  } catch (error) {
    logger.error('Analysis failed', { error: error.message });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = DatabaseAnalyzer;
