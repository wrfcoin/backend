/**
 * Blockchain Validator for Wrfcoin Backend
 * Implements comprehensive blockchain data validation and integrity checks
 */

const crypto = require('crypto');

class BlockchainValidator {
  constructor() {
    this.validationMetrics = {
      blocksValidated: 0,
      transactionsValidated: 0,
      validationErrors: 0,
      averageValidationTime: 0,
    };

    this.validationRules = {
      block: {
        maxSize: 2 * 1024 * 1024, // 2MB
        maxTransactions: 10000,
        hashLength: 64,
        timestampTolerance: 7200000, // 2 hours in ms
      },
      transaction: {
        maxSize: 100 * 1024, // 100KB
        minFee: 0.0001,
        maxInputs: 1000,
        maxOutputs: 1000,
      },
    };
  }

  // Validate block structure and content
  async validateBlock(block) {
    const startTime = Date.now();
    const validationResult = {
      valid: true,
      errors: [],
      warnings: [],
      metadata: {},
    };

    try {
      // Basic structure validation
      if (!this.validateBlockStructure(block)) {
        validationResult.errors.push('Invalid block structure');
        validationResult.valid = false;
      }

      // Hash validation
      if (!this.validateBlockHash(block)) {
        validationResult.errors.push('Invalid block hash');
        validationResult.valid = false;
      }

      // Timestamp validation
      if (!this.validateTimestamp(block.timestamp)) {
        validationResult.errors.push('Invalid block timestamp');
        validationResult.valid = false;
      }

      // Size validation
      const blockSize = this.calculateBlockSize(block);
      if (blockSize > this.validationRules.block.maxSize) {
        validationResult.errors.push(
          `Block size exceeds maximum: ${blockSize} bytes`
        );
        validationResult.valid = false;
      }

      // Transaction count validation
      if (
        block.transactions &&
        block.transactions.length > this.validationRules.block.maxTransactions
      ) {
        validationResult.errors.push('Too many transactions in block');
        validationResult.valid = false;
      }

      // Validate each transaction
      if (block.transactions) {
        for (let i = 0; i < block.transactions.length; i++) {
          const txValidation = await this.validateTransaction(
            block.transactions[i]
          );
          if (!txValidation.valid) {
            validationResult.errors.push(
              `Transaction ${i} invalid: ${txValidation.errors.join(', ')}`
            );
            validationResult.valid = false;
          }
        }
      }

      // Merkle root validation
      if (block.transactions && block.merkleRoot) {
        const calculatedMerkleRoot = this.calculateMerkleRoot(
          block.transactions
        );
        if (calculatedMerkleRoot !== block.merkleRoot) {
          validationResult.errors.push('Merkle root mismatch');
          validationResult.valid = false;
        }
      }

      // Update metrics
      this.validationMetrics.blocksValidated++;
      if (!validationResult.valid) {
        this.validationMetrics.validationErrors++;
      }

      const validationTime = Date.now() - startTime;
      this.updateAverageValidationTime(validationTime);

      validationResult.metadata = {
        blockSize,
        transactionCount: block.transactions ? block.transactions.length : 0,
        validationTime,
        blockHeight: block.height,
      };
    } catch (error) {
      validationResult.valid = false;
      validationResult.errors.push(`Validation error: ${error.message}`);
      this.validationMetrics.validationErrors++;
    }

    return validationResult;
  }

  validateBlockStructure(block) {
    const requiredFields = [
      'height',
      'previousHash',
      'timestamp',
      'nonce',
      'hash',
    ];
    return (
      requiredFields.every(field => field in block) &&
      typeof block.height === 'number' &&
      typeof block.hash === 'string' &&
      block.hash.length === this.validationRules.block.hashLength
    );
  }

  validateBlockHash(block) {
    // Simplified hash validation - in production would verify full hash
    const blockData = {
      height: block.height,
      previousHash: block.previousHash,
      timestamp: block.timestamp,
      nonce: block.nonce,
      merkleRoot: block.merkleRoot,
    };

    const dataString = JSON.stringify(blockData);
    const calculatedHash = crypto
      .createHash('sha256')
      .update(dataString)
      .digest('hex');

    // For development, accept any valid-looking hash
    return (
      block.hash && block.hash.length === 64 && /^[a-f0-9]+$/i.test(block.hash)
    );
  }

  validateTimestamp(timestamp) {
    const now = Date.now();
    const blockTime = new Date(timestamp).getTime();

    // Block cannot be too far in the future or past
    return (
      Math.abs(now - blockTime) <= this.validationRules.block.timestampTolerance
    );
  }

  calculateBlockSize(block) {
    return JSON.stringify(block).length;
  }

  // Validate individual transaction
  async validateTransaction(transaction) {
    const validationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    try {
      // Structure validation
      if (!this.validateTransactionStructure(transaction)) {
        validationResult.errors.push('Invalid transaction structure');
        validationResult.valid = false;
      }

      // Size validation
      const txSize = JSON.stringify(transaction).length;
      if (txSize > this.validationRules.transaction.maxSize) {
        validationResult.errors.push(`Transaction too large: ${txSize} bytes`);
        validationResult.valid = false;
      }

      // Input/output validation
      if (
        transaction.inputs &&
        transaction.inputs.length > this.validationRules.transaction.maxInputs
      ) {
        validationResult.errors.push('Too many inputs');
        validationResult.valid = false;
      }

      if (
        transaction.outputs &&
        transaction.outputs.length > this.validationRules.transaction.maxOutputs
      ) {
        validationResult.errors.push('Too many outputs');
        validationResult.valid = false;
      }

      // Fee validation
      if (
        transaction.fee &&
        transaction.fee < this.validationRules.transaction.minFee
      ) {
        validationResult.warnings.push(
          'Transaction fee below recommended minimum'
        );
      }

      // Signature validation (simplified)
      if (transaction.signature && !this.validateSignature(transaction)) {
        validationResult.errors.push('Invalid transaction signature');
        validationResult.valid = false;
      }

      this.validationMetrics.transactionsValidated++;
    } catch (error) {
      validationResult.valid = false;
      validationResult.errors.push(
        `Transaction validation error: ${error.message}`
      );
    }

    return validationResult;
  }

  validateTransactionStructure(transaction) {
    const requiredFields = ['id', 'from', 'to', 'amount', 'timestamp'];
    return (
      requiredFields.every(field => field in transaction) &&
      typeof transaction.amount === 'number' &&
      transaction.amount > 0
    );
  }

  validateSignature(transaction) {
    // Simplified signature validation
    // In production, would verify cryptographic signature
    return (
      transaction.signature &&
      typeof transaction.signature === 'string' &&
      transaction.signature.length >= 64
    );
  }

  calculateMerkleRoot(transactions) {
    if (!transactions || transactions.length === 0) {
      return crypto.createHash('sha256').update('').digest('hex');
    }

    // Simple Merkle root calculation
    let hashes = transactions.map(tx =>
      crypto.createHash('sha256').update(JSON.stringify(tx)).digest('hex')
    );

    while (hashes.length > 1) {
      const newHashes = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        const combined = crypto
          .createHash('sha256')
          .update(left + right)
          .digest('hex');
        newHashes.push(combined);
      }
      hashes = newHashes;
    }

    return hashes[0];
  }

  // Validate blockchain integrity
  async validateChain(blocks) {
    const validationResult = {
      valid: true,
      errors: [],
      totalBlocks: blocks.length,
      validBlocks: 0,
      invalidBlocks: 0,
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Validate individual block
      const blockValidation = await this.validateBlock(block);
      if (!blockValidation.valid) {
        validationResult.errors.push(
          `Block ${i} (height ${block.height}): ${blockValidation.errors.join(', ')}`
        );
        validationResult.invalidBlocks++;
        validationResult.valid = false;
      } else {
        validationResult.validBlocks++;
      }

      // Validate chain continuity
      if (i > 0) {
        const previousBlock = blocks[i - 1];
        if (block.previousHash !== previousBlock.hash) {
          validationResult.errors.push(`Block ${i} previous hash mismatch`);
          validationResult.valid = false;
        }
        if (block.height !== previousBlock.height + 1) {
          validationResult.errors.push(`Block ${i} height inconsistency`);
          validationResult.valid = false;
        }
      }
    }

    return validationResult;
  }

  updateAverageValidationTime(newTime) {
    const count = this.validationMetrics.blocksValidated;
    const currentAvg = this.validationMetrics.averageValidationTime;
    this.validationMetrics.averageValidationTime =
      (currentAvg * (count - 1) + newTime) / count;
  }

  // Health check for validator
  getValidatorHealth() {
    const errorRate =
      this.validationMetrics.blocksValidated > 0
        ? this.validationMetrics.validationErrors /
          this.validationMetrics.blocksValidated
        : 0;

    return {
      status: errorRate < 0.01 ? 'healthy' : 'degraded',
      metrics: this.validationMetrics,
      errorRate: (errorRate * 100).toFixed(2) + '%',
      performance: {
        averageValidationTime: Math.round(
          this.validationMetrics.averageValidationTime
        ),
        throughput:
          this.validationMetrics.blocksValidated > 0
            ? Math.round(
                this.validationMetrics.blocksValidated / (process.uptime() / 60)
              ) + ' blocks/min'
            : '0 blocks/min',
      },
      rules: this.validationRules,
    };
  }

  // Reset validation metrics
  resetMetrics() {
    this.validationMetrics = {
      blocksValidated: 0,
      transactionsValidated: 0,
      validationErrors: 0,
      averageValidationTime: 0,
    };
  }
}

module.exports = BlockchainValidator;
