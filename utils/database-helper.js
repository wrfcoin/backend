/**
 * Database Helper Utilities for Wrfcoin Core
 *
 * This module provides helper functions for consistent database operations
 * with proper error handling, logging, and compatibility across different
 * database engines.
 */

const { db } = require('../server/db');
const { sql } = require('drizzle-orm');

/**
 * Validate SQL identifier (table/column name) to prevent injection
 * @param {string} identifier - The identifier to validate
 * @returns {boolean} Whether the identifier is safe
 */
function isValidIdentifier(identifier) {
  // Allow only alphanumeric characters, underscores, and dots (for schema.table)
  return /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(identifier);
}

/**
 * Validate an array of identifiers
 * @param {Array<string>} identifiers - Array of identifiers to validate
 * @throws {Error} If any identifier is invalid
 */
function validateIdentifiers(identifiers) {
  for (const identifier of identifiers) {
    if (!isValidIdentifier(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
  }
}

/**
 * Check if the database supports the RETURNING clause
 *
 * @returns {Promise<boolean>} Whether RETURNING is supported
 */
async function supportsReturningClause() {
  try {
    // Try a simple insert with RETURNING to see if it's supported
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS test_returning (id SERIAL PRIMARY KEY, test TEXT)`
    );

    const result = await db.execute(
      sql`INSERT INTO test_returning (test) VALUES ('test_returning') RETURNING id`
    );

    // Clean up
    await db.execute(sql`DROP TABLE IF EXISTS test_returning`);

    return result && result.length > 0;
  } catch (error) {
    console.log('Database does not support RETURNING clause:', error.message);
    return false;
  }
}

/**
 * Execute an INSERT query with proper error handling and RETURNING clause support detection
 *
 * @param {string} tableName - Name of the table to insert into
 * @param {Object} data - Data to insert (field:value pairs)
 * @param {Object} options - Additional options
 * @param {string} options.idField - Primary key field name for retrieving the record if RETURNING is not supported
 * @param {string} options.returningFields - Fields to return in RETURNING clause
 * @returns {Promise<Object|null>} The inserted record or null if insert failed
 */
async function executeInsert(tableName, data, options = {}) {
  const { idField = 'id', returningFields = '*' } = options;

  try {
    // Validate identifiers to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    if (!isValidIdentifier(idField)) {
      throw new Error(`Invalid ID field: ${idField}`);
    }

    // Build the column names and values parts of the query
    const columns = Object.keys(data);
    validateIdentifiers(columns);
    const values = Object.values(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    // Try to use RETURNING if supported
    const hasReturning = await supportsReturningClause();

    if (hasReturning) {
      // Validate returningFields to prevent injection
      if (returningFields !== '*' && !isValidIdentifier(returningFields)) {
        throw new Error(`Invalid returning fields: ${returningFields}`);
      }

      // With RETURNING - use safe Drizzle query builder
      const columnIdentifiers = columns.map(col => sql.identifier(col));
      const placeholderSql = values.map((_, i) => sql.placeholder(`param${i}`));

      const result = await db.execute(
        sql`
        INSERT INTO ${sql.identifier(tableName)} (${sql.join(columnIdentifiers, sql`, `)})
        VALUES (${sql.join(placeholderSql, sql`, `)})
        RETURNING *
      `.mapWith(Object.fromEntries(values.map((val, i) => [`param${i}`, val])))
      );
      return result && result.length > 0 ? result[0] : null;
    } else {
      // Without RETURNING, insert and then select the record
      const columnIdentifiers = columns.map(col => sql.identifier(col));
      const placeholderSql = values.map((_, i) => sql.placeholder(`param${i}`));

      await db.execute(
        sql`
        INSERT INTO ${sql.identifier(tableName)} (${sql.join(columnIdentifiers, sql`, `)})
        VALUES (${sql.join(placeholderSql, sql`, `)})
      `.mapWith(Object.fromEntries(values.map((val, i) => [`param${i}`, val])))
      );

      // Try to retrieve the inserted record if we have a unique identifier
      // This is less reliable but necessary for databases without RETURNING
      if (data[idField]) {
        // Validate returningFields to prevent injection
        if (returningFields !== '*' && !isValidIdentifier(returningFields)) {
          throw new Error(`Invalid returning fields: ${returningFields}`);
        }

        // Use parameterized query to prevent SQL injection
        const result = await db.execute(
          sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(idField)} = ${data[idField]} LIMIT 1`
        );
        return result && result.length > 0 ? result[0] : null;
      }

      return { inserted: true };
    }
  } catch (error) {
    console.error(`Error executing INSERT into ${tableName}:`, error);
    throw error;
  }
}

/**
 * Execute an UPDATE query with proper error handling
 *
 * @param {string} tableName - Name of the table to update
 * @param {Object} data - Data to update (field:value pairs)
 * @param {Object} where - Where condition fields and values
 * @param {Object} options - Additional options
 * @param {string} options.returningFields - Fields to return in RETURNING clause
 * @returns {Promise<Object|null>} The updated record or null if update failed
 */
async function executeUpdate(tableName, data, where, options = {}) {
  const { returningFields = '*' } = options;

  try {
    // Validate identifiers to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    // Safety check - require where clause
    if (!where || Object.keys(where).length === 0) {
      throw new Error(
        `Safety error: UPDATE on ${tableName} attempted without WHERE clause`
      );
    }

    // Validate all field names
    const dataKeys = Object.keys(data);
    const whereKeys = Object.keys(where);
    validateIdentifiers(dataKeys);
    validateIdentifiers(whereKeys);

    // Build the SET part of the query
    const setParts = dataKeys.map((key, i) => `${key} = $${i + 1}`);

    // Build the WHERE part of the query
    const whereClause = whereKeys
      .map((key, i) => `${key} = $${i + 1 + dataKeys.length}`)
      .join(' AND ');

    // Values for all placeholders
    const values = [...Object.values(data), ...Object.values(where)];

    // Check if RETURNING is supported
    const hasReturning = await supportsReturningClause();

    if (hasReturning) {
      // Validate returningFields to prevent injection
      if (returningFields !== '*' && !isValidIdentifier(returningFields)) {
        throw new Error(`Invalid returning fields: ${returningFields}`);
      }

      // With RETURNING - use safe parameterized query
      const setClause = dataKeys.map(
        (key, i) => sql`${sql.identifier(key)} = ${sql.placeholder(`data${i}`)}`
      );
      const whereConditions = whereKeys.map(
        (key, i) =>
          sql`${sql.identifier(key)} = ${sql.placeholder(`where${i}`)}`
      );

      const paramMap = {};
      dataKeys.forEach((key, i) => {
        paramMap[`data${i}`] = Object.values(data)[i];
      });
      whereKeys.forEach((key, i) => {
        paramMap[`where${i}`] = Object.values(where)[i];
      });

      const result = await db.execute(
        sql`
        UPDATE ${sql.identifier(tableName)}
        SET ${sql.join(setClause, sql`, `)}
        WHERE ${sql.join(whereConditions, sql` AND `)}
        RETURNING *
      `.mapWith(paramMap)
      );
      return result && result.length > 0 ? result[0] : null;
    } else {
      // Without RETURNING - use safe parameterized queries
      const setClause = dataKeys.map(
        (key, i) => sql`${sql.identifier(key)} = ${sql.placeholder(`data${i}`)}`
      );
      const whereConditions = whereKeys.map(
        (key, i) =>
          sql`${sql.identifier(key)} = ${sql.placeholder(`where${i}`)}`
      );

      const paramMap = {};
      dataKeys.forEach((key, i) => {
        paramMap[`data${i}`] = Object.values(data)[i];
      });
      whereKeys.forEach((key, i) => {
        paramMap[`where${i}`] = Object.values(where)[i];
      });

      await db.execute(
        sql`
        UPDATE ${sql.identifier(tableName)}
        SET ${sql.join(setClause, sql`, `)}
        WHERE ${sql.join(whereConditions, sql` AND `)}
      `.mapWith(paramMap)
      );

      // Try to retrieve the updated record
      const retrieveWhere = where;
      const retrieveConditions = whereKeys.map(
        (key, i) =>
          sql`${sql.identifier(key)} = ${sql.placeholder(`where${i}`)}`
      );
      const retrieveParamMap = {};
      whereKeys.forEach((key, i) => {
        retrieveParamMap[`where${i}`] = Object.values(retrieveWhere)[i];
      });

      const result = await db.execute(
        sql`
        SELECT * FROM ${sql.identifier(tableName)}
        WHERE ${sql.join(retrieveConditions, sql` AND `)}
        LIMIT 1
      `.mapWith(retrieveParamMap)
      );
      return result && result.length > 0 ? result[0] : null;
    }
  } catch (error) {
    console.error(`Error executing UPDATE on ${tableName}:`, error);
    throw error;
  }
}

/**
 * Execute a SELECT query with proper error handling
 *
 * @param {string} tableName - Name of the table to select from
 * @param {Object} where - Where condition fields and values (optional)
 * @param {Object} options - Additional options
 * @param {string} options.fields - Fields to select
 * @param {string} options.limit - Maximum number of records to return
 * @param {string} options.offset - Offset for pagination
 * @param {string} options.orderBy - Field to order by
 * @param {string} options.orderDir - Order direction (ASC or DESC)
 * @returns {Promise<Array>} Array of matching records
 */
async function executeSelect(tableName, where = {}, options = {}) {
  const {
    fields = '*',
    limit = null,
    offset = null,
    orderBy = null,
    orderDir = 'ASC',
  } = options;

  try {
    // Validate identifiers to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    // Validate fields parameter
    if (fields !== '*') {
      const fieldList = fields.split(',').map(f => f.trim());
      validateIdentifiers(fieldList);
    }

    if (orderBy && !isValidIdentifier(orderBy)) {
      throw new Error(`Invalid order by field: ${orderBy}`);
    }

    if (orderDir !== 'ASC' && orderDir !== 'DESC') {
      throw new Error(`Invalid order direction: ${orderDir}`);
    }

    // Build the WHERE part of the query if it exists
    let whereClause = '';
    let values = [];

    if (where && Object.keys(where).length > 0) {
      const whereKeys = Object.keys(where);
      validateIdentifiers(whereKeys);
      whereClause =
        'WHERE ' +
        whereKeys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');
      values = Object.values(where);
    }

    // Build the ORDER BY part if specified
    let orderClause = '';
    if (orderBy) {
      orderClause = `ORDER BY ${orderBy} ${orderDir}`;
    }

    // Build the LIMIT and OFFSET parts if specified
    let limitClause = '';
    if (limit !== null) {
      limitClause = `LIMIT ${limit}`;
    }

    let offsetClause = '';
    if (offset !== null) {
      offsetClause = `OFFSET ${offset}`;
    }

    // Build safe parameterized query
    let baseSql = sql`SELECT * FROM ${sql.identifier(tableName)}`;

    if (where && Object.keys(where).length > 0) {
      const whereConditions = whereKeys.map(
        (key, i) =>
          sql`${sql.identifier(key)} = ${sql.placeholder(`where${i}`)}`
      );
      const paramMap = {};
      whereKeys.forEach((key, i) => {
        paramMap[`where${i}`] = Object.values(where)[i];
      });
      baseSql =
        sql`${baseSql} WHERE ${sql.join(whereConditions, sql` AND `)}`.mapWith(
          paramMap
        );
    }

    if (orderBy) {
      baseSql = sql`${baseSql} ORDER BY ${sql.identifier(orderBy)} ${sql.raw(orderDir)}`;
    }

    if (limit !== null) {
      baseSql = sql`${baseSql} LIMIT ${limit}`;
    }

    if (offset !== null) {
      baseSql = sql`${baseSql} OFFSET ${offset}`;
    }

    const result = await db.execute(baseSql);
    return result || [];
  } catch (error) {
    console.error(`Error executing SELECT from ${tableName}:`, error);
    throw error;
  }
}

/**
 * Execute a DELETE query with proper error handling
 *
 * @param {string} tableName - Name of the table to delete from
 * @param {Object} where - Where condition fields and values (required for safety)
 * @returns {Promise<number>} Number of deleted records
 */
async function executeDelete(tableName, where) {
  try {
    // Validate identifiers to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    // Safety check - require where clause
    if (!where || Object.keys(where).length === 0) {
      throw new Error(
        `Safety error: DELETE on ${tableName} attempted without WHERE clause`
      );
    }

    // Build the WHERE part of the query
    const whereKeys = Object.keys(where);
    validateIdentifiers(whereKeys);
    const whereClause = whereKeys
      .map((key, i) => `${key} = $${i + 1}`)
      .join(' AND ');
    const values = Object.values(where);

    // Check if RETURNING is supported
    const hasReturning = await supportsReturningClause();

    const whereConditions = whereKeys.map(
      (key, i) => sql`${sql.identifier(key)} = ${sql.placeholder(`where${i}`)}`
    );
    const paramMap = {};
    whereKeys.forEach((key, i) => {
      paramMap[`where${i}`] = Object.values(where)[i];
    });

    if (hasReturning) {
      // With RETURNING count
      const result = await db.execute(
        sql`
        DELETE FROM ${sql.identifier(tableName)}
        WHERE ${sql.join(whereConditions, sql` AND `)}
        RETURNING COUNT(*)
      `.mapWith(paramMap)
      );
      return result && result.length > 0 ? parseInt(result[0].count, 10) : 0;
    } else {
      // Without RETURNING, just run the DELETE
      await db.execute(
        sql`
        DELETE FROM ${sql.identifier(tableName)}
        WHERE ${sql.join(whereConditions, sql` AND `)}
      `.mapWith(paramMap)
      );
      return 1; // Can't reliably know how many rows were affected
    }
  } catch (error) {
    console.error(`Error executing DELETE from ${tableName}:`, error);
    throw error;
  }
}

/**
 * Check if a table exists in the database
 *
 * @param {string} tableName - Name of the table to check
 * @returns {Promise<boolean>} Whether the table exists
 */
async function tableExists(tableName) {
  try {
    // Validate identifier to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = ${tableName}
      ) as "exists"
    `);
    return result && result.length > 0 && result[0].exists === true;
  } catch (error) {
    console.error(`Error checking if table ${tableName} exists:`, error);
    return false;
  }
}

/**
 * Get the column names of a table
 *
 * @param {string} tableName - Name of the table
 * @returns {Promise<Array<string>>} Array of column names
 */
async function getTableColumns(tableName) {
  try {
    // Validate identifier to prevent SQL injection
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    const result = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
      ORDER BY ordinal_position
    `);
    return result ? result.map(row => row.column_name) : [];
  } catch (error) {
    console.error(`Error getting columns for table ${tableName}:`, error);
    return [];
  }
}

module.exports = {
  supportsReturningClause,
  executeInsert,
  executeUpdate,
  executeSelect,
  executeDelete,
  tableExists,
  getTableColumns,
};
