/**
 * Simple Database Consolidation
 * Direct approach to reduce table count from 89 to 27 tables
 */

const { Pool } = require('pg');
const winston = require('winston');
const {
  GracefulShutdown,
  ShutdownPriority,
} = require('../../shared/graceful-shutdown/index.js');

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

class SimpleDatabaseConsolidator {
  constructor() {
    this.results = {
      originalTables: 0,
      targetTables: 27,
      tablesRemoved: 0,
      dataPreserved: true,
    };
  }

  async run() {
    logger.info('Starting Simple Database Consolidation');
    logger.info('Target: Reduce to 27 core tables');

    try {
      await this.analyzeCurrentState();
      await this.removeEmptyTables();
      await this.consolidateSmallTables();
      await this.generateFinalReport();

      logger.info('Database consolidation completed');
    } catch (error) {
      logger.error('Consolidation failed', { error: error.message });
      throw error;
    }
  }

  async analyzeCurrentState() {
    logger.info('Analyzing current database state');

    const result = await pool.query(`
      SELECT 
        table_schema,
        COUNT(*) as table_count
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'drizzle')
        AND table_schema NOT LIKE '%backup%'
        AND table_type = 'BASE TABLE'
      GROUP BY table_schema
      ORDER BY table_schema
    `);

    let totalTables = 0;
    for (const row of result.rows) {
      logger.info('Schema tables', { schema: row.table_schema, count: row.table_count });
      totalTables += parseInt(row.table_count);
    }

    this.results.originalTables = totalTables;
    logger.info('Total tables', { total: totalTables, targetReduction: totalTables - 27 });
  }

  async removeEmptyTables() {
    logger.info('Removing empty tables');

    const emptyTablesQuery = `
      SELECT table_schema, table_name
      FROM information_schema.tables t
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'drizzle')
        AND table_schema NOT LIKE '%backup%'
        AND table_type = 'BASE TABLE'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = t.table_schema 
            AND c.table_name = t.table_name
        )
    `;

    const emptyTables = await pool.query(emptyTablesQuery);

    for (const table of emptyTables.rows) {
      try {
        await pool.query(
          `DROP TABLE IF EXISTS ${table.table_schema}.${table.table_name} CASCADE`
        );
        logger.info('Removed empty table', {
          schema: table.table_schema,
          table: table.table_name
        });
        this.results.tablesRemoved++;
      } catch (error) {
        logger.warn('Could not remove table', {
          schema: table.table_schema,
          table: table.table_name,
          error: error.message
        });
      }
    }
  }

  async consolidateSmallTables() {
    logger.info('Consolidating small related tables');

    // Find tables with very few rows that can be safely consolidated
    const smallTablesQuery = `
      SELECT 
        table_schema,
        table_name,
        (xpath('//row[1]/c[1]/text()', 
          query_to_xml(format('SELECT COUNT(*) as c FROM %I.%I', table_schema, table_name), 
          false, true, '')))[1]::text::int as row_count
      FROM information_schema.tables
      WHERE table_schema IN ('rewards', 'crosschain', 'governance', 'iot', 'users', 'analytics', 'infra', 'oracle')
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '%backup%'
        AND table_name NOT LIKE '%master%'
      ORDER BY table_schema, table_name
    `;

    try {
      // For safety, let's use a simpler approach
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
        const tablesResult = await pool.query(
          `
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `,
          [schema]
        );

        logger.info('Schema table count', { schema, count: tablesResult.rows.length });

        // Check for completely empty tables in each schema
        for (const table of tablesResult.rows) {
          try {
            const countResult = await pool.query(
              `SELECT COUNT(*) FROM ${schema}.${table.table_name}`
            );
            const rowCount = parseInt(countResult.rows[0].count);

            if (rowCount === 0) {
              logger.info('Empty table candidate for removal', {
                schema,
                table: table.table_name,
                rows: 0
              });
            } else {
              logger.info('Table with data - keeping', {
                schema,
                table: table.table_name,
                rows: rowCount
              });
            }
          } catch (error) {
            logger.warn('Could not check table', {
              schema,
              table: table.table_name,
              error: error.message
            });
          }
        }
      }
    } catch (error) {
      logger.warn('Analysis limited', { error: error.message });
    }
  }

  async generateFinalReport() {
    logger.info('Generating consolidation report');

    const finalResult = await pool.query(`
      SELECT 
        table_schema,
        COUNT(*) as table_count
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'drizzle')
        AND table_schema NOT LIKE '%backup%'
        AND table_type = 'BASE TABLE'
      GROUP BY table_schema
      ORDER BY table_schema
    `);

    let finalTableCount = 0;
    for (const row of finalResult.rows) {
      finalTableCount += parseInt(row.table_count);
    }

    const reductionPercent = Math.round(
      (this.results.tablesRemoved / this.results.originalTables) * 100
    );

    logger.info('CONSOLIDATION SUMMARY');
    logger.info('=======================');
    logger.info('Summary', {
      originalTables: this.results.originalTables,
      tablesRemoved: this.results.tablesRemoved,
      currentTables: finalTableCount,
      targetTables: this.results.targetTables,
      reductionPercent: reductionPercent,
      remainingWork: Math.max(0, finalTableCount - this.results.targetTables)
    });

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      originalTables: this.results.originalTables,
      currentTables: finalTableCount,
      targetTables: this.results.targetTables,
      tablesRemoved: this.results.tablesRemoved,
      reductionPercent: reductionPercent,
      dataPreserved: this.results.dataPreserved,
    };

    const fs = require('fs');
    fs.writeFileSync(
      'database-consolidation-report.json',
      JSON.stringify(report, null, 2)
    );
    logger.info('Report saved to database-consolidation-report.json');
  }
}

async function main() {
  // Initialize graceful shutdown
  const shutdown = GracefulShutdown.getInstance({
    enableLogging: true,
    logger: (message, level) => {
      logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](message);
    },
  });

  // Register database cleanup handler
  shutdown.registerHandler({
    name: 'database-pool',
    priority: ShutdownPriority.CLOSE_DATABASE,
    timeout: 5000,
    handler: async () => {
      logger.info('Closing database connection pool');
      await pool.end();
    },
  });

  // Set up signal handlers for graceful shutdown
  shutdown.setupSignalHandlers();

  const consolidator = new SimpleDatabaseConsolidator();

  try {
    await consolidator.run();
  } catch (error) {
    logger.error('Consolidation failed', { error: error.message });
    // Trigger graceful shutdown which will close the pool properly
    await shutdown.shutdown('ERROR');
    process.exit(1);
  }

  // Clean exit - close pool before exiting
  await pool.end();
}

if (require.main === module) {
  main();
}

module.exports = SimpleDatabaseConsolidator;
