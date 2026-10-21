/**
 * Governance Input Validators
 * Task 104.1: SQL Injection Prevention for Governance Module
 *
 * Provides strict validation for all governance-related inputs to prevent
 * SQL injection and ensure data integrity in the governance system.
 */

import { Request, Response, NextFunction } from 'express';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ValidationResult {
  isValid: boolean;
  value?: unknown;
  errors: string[];
}

export interface ProposalIdValidation extends ValidationResult {
  value?: string;
}

export interface VoterAddressValidation extends ValidationResult {
  value?: string;
}

export interface VoteTypeValidation extends ValidationResult {
  value?: 'yes' | 'no' | 'abstain';
}

export interface StatusValidation extends ValidationResult {
  value?: 'pending' | 'active' | 'voting' | 'executed' | 'cancelled' | 'expired';
}

export interface PaginationValidation extends ValidationResult {
  value?: { page: number; limit: number; offset: number };
}

// ============================================================================
// Validation Patterns
// ============================================================================

// Proposal ID: alphanumeric with optional prefixes (prop-, PROP-, etc.)
const PROPOSAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Blockchain address patterns
const ETHEREUM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const COSMOS_ADDRESS_PATTERN = /^[a-z]+1[a-z0-9]{38,58}$/;
const GENERAL_ADDRESS_PATTERN = /^[a-zA-Z0-9]{20,100}$/;

// Vote types
const VALID_VOTE_TYPES = ['yes', 'no', 'abstain'] as const;

// Proposal statuses
const VALID_STATUSES = [
  'pending',
  'active',
  'voting',
  'executed',
  'cancelled',
  'expired',
] as const;

// SQL Injection detection patterns (from input-sanitizer.ts)
const SQL_INJECTION_PATTERNS: RegExp[] = [
  /('|")\s*(or|and)\s*('|"|\d)/gi,
  /;\s*(drop|delete|update|insert|alter|create|truncate)\s/gi,
  /union\s+select/gi,
  /--\s*$/gm,
  /\/\*[\s\S]*?\*\//g,
  /\bexec\s*\(/gi,
  /\bxp_/gi,
  /\bsp_/gi,
  /\bwaitfor\s+delay/gi,
  /\bbenchmark\s*\(/gi,
  /\bsleep\s*\(/gi,
  /\bload_file\s*\(/gi,
  /\binto\s+(out|dump)file/gi,
];

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check for SQL injection patterns in a string
 */
export function detectSQLInjection(input: string): {
  detected: boolean;
  patterns: string[];
} {
  if (typeof input !== 'string') {
    return { detected: false, patterns: [] };
  }

  const detectedPatterns: string[] = [];

  for (const pattern of SQL_INJECTION_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    if (pattern.test(input)) {
      detectedPatterns.push(pattern.source);
    }
  }

  return {
    detected: detectedPatterns.length > 0,
    patterns: detectedPatterns,
  };
}

/**
 * Validate a proposal ID
 */
export function validateProposalId(proposalId: unknown): ProposalIdValidation {
  const errors: string[] = [];

  if (proposalId === undefined || proposalId === null) {
    return { isValid: false, errors: ['Proposal ID is required'] };
  }

  if (typeof proposalId !== 'string') {
    return { isValid: false, errors: ['Proposal ID must be a string'] };
  }

  const trimmed = proposalId.trim();

  if (trimmed.length === 0) {
    errors.push('Proposal ID cannot be empty');
  }

  if (trimmed.length > 64) {
    errors.push('Proposal ID cannot exceed 64 characters');
  }

  if (!PROPOSAL_ID_PATTERN.test(trimmed)) {
    errors.push(
      'Proposal ID must contain only alphanumeric characters, hyphens, and underscores'
    );
  }

  // Check for SQL injection
  const injectionCheck = detectSQLInjection(trimmed);
  if (injectionCheck.detected) {
    errors.push('Proposal ID contains potentially malicious characters');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? trimmed : undefined,
    errors,
  };
}

/**
 * Validate a voter address (blockchain address)
 */
export function validateVoterAddress(address: unknown): VoterAddressValidation {
  const errors: string[] = [];

  if (address === undefined || address === null) {
    return { isValid: false, errors: ['Voter address is required'] };
  }

  if (typeof address !== 'string') {
    return { isValid: false, errors: ['Voter address must be a string'] };
  }

  const trimmed = address.trim();

  if (trimmed.length === 0) {
    errors.push('Voter address cannot be empty');
  }

  // Check for valid address format
  const isEthAddress = ETHEREUM_ADDRESS_PATTERN.test(trimmed);
  const isCosmosAddress = COSMOS_ADDRESS_PATTERN.test(trimmed);
  const isGeneralAddress = GENERAL_ADDRESS_PATTERN.test(trimmed);

  if (!isEthAddress && !isCosmosAddress && !isGeneralAddress) {
    errors.push('Invalid voter address format');
  }

  // Check for SQL injection
  const injectionCheck = detectSQLInjection(trimmed);
  if (injectionCheck.detected) {
    errors.push('Voter address contains potentially malicious characters');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? trimmed : undefined,
    errors,
  };
}

/**
 * Validate a vote type
 */
export function validateVoteType(voteType: unknown): VoteTypeValidation {
  const errors: string[] = [];

  if (voteType === undefined || voteType === null) {
    return { isValid: false, errors: ['Vote type is required'] };
  }

  if (typeof voteType !== 'string') {
    return { isValid: false, errors: ['Vote type must be a string'] };
  }

  const normalized = voteType.trim().toLowerCase() as typeof VALID_VOTE_TYPES[number];

  if (!VALID_VOTE_TYPES.includes(normalized)) {
    errors.push(`Vote type must be one of: ${VALID_VOTE_TYPES.join(', ')}`);
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? normalized : undefined,
    errors,
  };
}

/**
 * Validate a proposal status
 */
export function validateStatus(status: unknown): StatusValidation {
  const errors: string[] = [];

  if (status === undefined || status === null) {
    // Status is optional, default handling
    return { isValid: true, value: undefined, errors: [] };
  }

  if (typeof status !== 'string') {
    return { isValid: false, errors: ['Status must be a string'] };
  }

  const normalized = status.trim().toLowerCase() as typeof VALID_STATUSES[number];

  if (!VALID_STATUSES.includes(normalized)) {
    errors.push(`Status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  // Check for SQL injection
  const injectionCheck = detectSQLInjection(status);
  if (injectionCheck.detected) {
    errors.push('Status contains potentially malicious characters');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? normalized : undefined,
    errors,
  };
}

/**
 * Validate pagination parameters
 */
export function validatePagination(
  page: unknown,
  limit: unknown
): PaginationValidation {
  const errors: string[] = [];

  // Parse page
  let parsedPage = 1;
  if (page !== undefined && page !== null) {
    const pageNum = typeof page === 'string' ? parseInt(page, 10) : Number(page);
    if (isNaN(pageNum) || pageNum < 1) {
      errors.push('Page must be a positive integer');
    } else if (pageNum > 10000) {
      errors.push('Page cannot exceed 10000');
    } else {
      parsedPage = pageNum;
    }
  }

  // Parse limit
  let parsedLimit = 10;
  if (limit !== undefined && limit !== null) {
    const limitNum =
      typeof limit === 'string' ? parseInt(limit, 10) : Number(limit);
    if (isNaN(limitNum) || limitNum < 1) {
      errors.push('Limit must be a positive integer');
    } else if (limitNum > 100) {
      errors.push('Limit cannot exceed 100');
    } else {
      parsedLimit = limitNum;
    }
  }

  const offset = (parsedPage - 1) * parsedLimit;

  return {
    isValid: errors.length === 0,
    value:
      errors.length === 0
        ? { page: parsedPage, limit: parsedLimit, offset }
        : undefined,
    errors,
  };
}

/**
 * Validate voting power (numeric amount)
 */
export function validateVotingPower(power: unknown): ValidationResult {
  const errors: string[] = [];

  if (power === undefined || power === null) {
    return { isValid: false, errors: ['Voting power is required'] };
  }

  const powerNum = typeof power === 'string' ? parseFloat(power) : Number(power);

  if (isNaN(powerNum)) {
    errors.push('Voting power must be a number');
  } else if (powerNum < 0) {
    errors.push('Voting power cannot be negative');
  } else if (powerNum > 1e18) {
    errors.push('Voting power exceeds maximum allowed value');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? powerNum : undefined,
    errors,
  };
}

/**
 * Validate proposal title
 */
export function validateProposalTitle(title: unknown): ValidationResult {
  const errors: string[] = [];

  if (title === undefined || title === null) {
    return { isValid: false, errors: ['Proposal title is required'] };
  }

  if (typeof title !== 'string') {
    return { isValid: false, errors: ['Proposal title must be a string'] };
  }

  const trimmed = title.trim();

  if (trimmed.length < 3) {
    errors.push('Proposal title must be at least 3 characters');
  }

  if (trimmed.length > 200) {
    errors.push('Proposal title cannot exceed 200 characters');
  }

  // Check for SQL injection
  const injectionCheck = detectSQLInjection(trimmed);
  if (injectionCheck.detected) {
    errors.push('Proposal title contains potentially malicious characters');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? trimmed : undefined,
    errors,
  };
}

/**
 * Validate proposal description
 */
export function validateProposalDescription(description: unknown): ValidationResult {
  const errors: string[] = [];

  if (description === undefined || description === null) {
    return { isValid: true, value: '', errors: [] }; // Optional field
  }

  if (typeof description !== 'string') {
    return { isValid: false, errors: ['Proposal description must be a string'] };
  }

  const trimmed = description.trim();

  if (trimmed.length > 10000) {
    errors.push('Proposal description cannot exceed 10000 characters');
  }

  // Check for SQL injection
  const injectionCheck = detectSQLInjection(trimmed);
  if (injectionCheck.detected) {
    errors.push('Proposal description contains potentially malicious characters');
  }

  return {
    isValid: errors.length === 0,
    value: errors.length === 0 ? trimmed : undefined,
    errors,
  };
}

// ============================================================================
// Express Middleware
// ============================================================================

/**
 * Middleware to validate proposal ID from route params
 */
export function validateProposalIdMiddleware(paramName: string = 'proposalId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const proposalId = req.params[paramName];
    const validation = validateProposalId(proposalId);

    if (!validation.isValid) {
      res.status(400).json({
        success: false,
        error: 'Invalid proposal ID',
        details: validation.errors,
      });
      return;
    }

    req.params[paramName] = validation.value!;
    next();
  };
}

/**
 * Middleware to validate voter address from body or params
 */
export function validateVoterAddressMiddleware(
  source: 'body' | 'params' = 'body',
  fieldName: string = 'voter_address'
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const address =
      source === 'body' ? req.body[fieldName] : req.params[fieldName];
    const validation = validateVoterAddress(address);

    if (!validation.isValid) {
      res.status(400).json({
        success: false,
        error: 'Invalid voter address',
        details: validation.errors,
      });
      return;
    }

    if (source === 'body') {
      req.body[fieldName] = validation.value;
    } else {
      req.params[fieldName] = validation.value!;
    }

    next();
  };
}

/**
 * Middleware to validate vote submission
 */
export function validateVoteSubmissionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const errors: string[] = [];

  // Validate proposal ID
  const proposalValidation = validateProposalId(
    req.params.proposalId || req.body.proposalId
  );
  if (!proposalValidation.isValid) {
    errors.push(...proposalValidation.errors);
  }

  // Validate voter address
  const addressValidation = validateVoterAddress(req.body.voter_address);
  if (!addressValidation.isValid) {
    errors.push(...addressValidation.errors);
  }

  // Validate vote type
  const voteTypeValidation = validateVoteType(req.body.vote_type);
  if (!voteTypeValidation.isValid) {
    errors.push(...voteTypeValidation.errors);
  }

  // Validate voting power (if provided)
  if (req.body.voting_power !== undefined) {
    const powerValidation = validateVotingPower(req.body.voting_power);
    if (!powerValidation.isValid) {
      errors.push(...powerValidation.errors);
    }
  }

  if (errors.length > 0) {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors,
    });
    return;
  }

  // Normalize validated values
  if (proposalValidation.value) {
    req.body.proposalId = proposalValidation.value;
  }
  if (addressValidation.value) {
    req.body.voter_address = addressValidation.value;
  }
  if (voteTypeValidation.value) {
    req.body.vote_type = voteTypeValidation.value;
  }

  next();
}

/**
 * Middleware to validate pagination query parameters
 */
export function validatePaginationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const validation = validatePagination(req.query.page, req.query.limit);

  if (!validation.isValid) {
    res.status(400).json({
      success: false,
      error: 'Invalid pagination parameters',
      details: validation.errors,
    });
    return;
  }

  // Attach validated pagination to request
  (req as any).pagination = validation.value;
  next();
}

/**
 * Middleware to validate proposal status filter
 */
export function validateStatusFilterMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.query.status === undefined) {
    next();
    return;
  }

  const validation = validateStatus(req.query.status);

  if (!validation.isValid) {
    res.status(400).json({
      success: false,
      error: 'Invalid status filter',
      details: validation.errors,
    });
    return;
  }

  req.query.status = validation.value;
  next();
}

/**
 * Combined governance validation middleware
 */
export function createGovernanceValidationMiddleware(
  options: {
    validateProposalId?: boolean;
    validateVoterAddress?: boolean;
    validateVoteType?: boolean;
    validatePagination?: boolean;
    validateStatus?: boolean;
  } = {}
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];

    if (options.validateProposalId && req.params.proposalId) {
      const result = validateProposalId(req.params.proposalId);
      if (!result.isValid) errors.push(...result.errors);
    }

    if (options.validateVoterAddress && req.body.voter_address) {
      const result = validateVoterAddress(req.body.voter_address);
      if (!result.isValid) errors.push(...result.errors);
    }

    if (options.validateVoteType && req.body.vote_type) {
      const result = validateVoteType(req.body.vote_type);
      if (!result.isValid) errors.push(...result.errors);
    }

    if (options.validatePagination) {
      const result = validatePagination(req.query.page, req.query.limit);
      if (!result.isValid) errors.push(...result.errors);
      else (req as any).pagination = result.value;
    }

    if (options.validateStatus && req.query.status) {
      const result = validateStatus(req.query.status);
      if (!result.isValid) errors.push(...result.errors);
    }

    if (errors.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors,
      });
      return;
    }

    next();
  };
}

// Export all validators
export default {
  detectSQLInjection,
  validateProposalId,
  validateVoterAddress,
  validateVoteType,
  validateStatus,
  validatePagination,
  validateVotingPower,
  validateProposalTitle,
  validateProposalDescription,
  validateProposalIdMiddleware,
  validateVoterAddressMiddleware,
  validateVoteSubmissionMiddleware,
  validatePaginationMiddleware,
  validateStatusFilterMiddleware,
  createGovernanceValidationMiddleware,
};
