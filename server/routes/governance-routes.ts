/**
 * Wrfcoin Governance API Routes
 *
 * This module proxies supported governance reads and writes to the core4
 * launch API, with DB-backed lifecycle, treasury, and delegation endpoints.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { logger } from '../../utils/logger.js';
import * as authMiddleware from '../middleware/authMiddleware.js';
import { hasAdminRole } from '../utils/admin-role.js';

const governanceGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const governanceVoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req as any).user?.id || ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many requests, please try again later' },
});

const governanceWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req as any).user?.id || ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many requests, please try again later' },
});
import {
  extractCore4Data,
  fetchCore4Json,
  sendCore4Error,
  sendCore4Unavailable,
  toNullable,
} from '../../shared/core4-route-client.js';
import { db } from '../db.js';
import { eq, desc, sql, count, sum, and } from 'drizzle-orm';
import { parseListPagination, paginatedResponse } from '../utils/api-error.js';
import { toProposalView } from '../utils/governance-proposal-view.js';
import {
  proposals as proposalsTable,
  votes as votesTable,
  parameters as parametersTable,
  delegations as delegationsTable,
} from '../../shared/governance-schema.js';
import { treasuryConsolidated } from '../../shared/schema-governance-consolidated.js';
import { treasuryAmountUnits } from '../../shared/amount-unit-contract.js';

import { core4OperatorHeaders, configuredAddress, adminBodyOrConfig, auditedAdminWrite, sendAdminPolicyError } from '../utils/core4-admin-policy.js';
import { core4ContributorHeaders, sendContributorCredentialUnavailable, CONTRIBUTOR_UNCONFIGURED } from '../utils/core4-contributor-credential.js';
import { verifiedGovernanceVote } from '../utils/governance-vote-signature.js';

const router = Router();

async function getDelegationsForDelegator(address: string) {
  const rows = await db
    .select()
    .from(delegationsTable)
    .where(
      and(
        eq(delegationsTable.active, true),
        eq(delegationsTable.delegator, address),
      ),
    )
    .orderBy(desc(delegationsTable.createdAt));

  return rows.map((delegation) => ({
    ...delegation,
    votingPower: parseFloat(delegation.amount ?? '0'),
  }));
}

router.get(
  '/delegations/delegator/:address',
  governanceGetLimiter,
  async (req: Request, res: Response) => {
    try {
      const delegations = await getDelegationsForDelegator(req.params.address);

      return res.json({
        success: true,
        count: delegations.length,
        delegations,
      });
    } catch (error) {
      logger.error('Error retrieving delegations for delegator', {
        address: req.params.address,
        error,
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve delegations',
      });
    }
  },
);

router.get('/delegations', governanceGetLimiter, async (req: Request, res: Response) => {
  const delegator =
    typeof req.query.delegator === 'string' ? req.query.delegator.trim() : '';

  if (!delegator) {
    return res.status(400).json({
      success: false,
      error: 'delegator query parameter is required',
    });
  }

  try {
    const delegations = await getDelegationsForDelegator(delegator);

    return res.json({
      success: true,
      count: delegations.length,
      delegations,
    });
  } catch (error) {
    logger.error('Error retrieving delegations via query', {
      delegator,
      error,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve delegations',
    });
  }
});

// core4's GET /governance/proposals answers a paginated object,
// `{total, offset, limit, proposals}` (launch_api routes/governance.rs
// list_governance_proposals), not an array. Reading it as an array discarded
// every list, so the API always answered `proposals: []` (backend#1242).
// Defaults and ceiling mirror core4's DEFAULT_/MAX_PROPOSALS_LIMIT.
const PROPOSALS_DEFAULT_LIMIT = 100;
const PROPOSALS_MAX_LIMIT = 500;

interface Core4ProposalPage {
  total: number;
  offset: number;
  limit: number;
  proposals: unknown[];
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The page, or null when core4 answered anything but that exact shape. */
function readCore4ProposalPage(payload: unknown): Core4ProposalPage | null {
  const data = extractCore4Data(payload);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const { total, offset, limit, proposals } = data as Record<string, unknown>;
  if (!Array.isArray(proposals) || !isCount(total) || !isCount(offset) || !isCount(limit)) {
    return null;
  }
  return { total, offset, limit, proposals };
}

function sendProposalShapeMismatch(res: Response) {
  return res.status(502).json({
    success: false,
    error: {
      code: 'CORE4_CONTRACT_MISMATCH',
      message: 'core4 proposal list response did not match {total, offset, limit, proposals}',
    },
  });
}

router.get('/status', governanceGetLimiter, async (_req: Request, res: Response) => {
  try {
    const [proposalResponse, lawResponse, trustWeightsResponse] =
      await Promise.all([
        // Only `total` is read, so fetch the smallest page core4 allows.
        fetchCore4Json('/governance/proposals', { query: { limit: 1 } }),
        fetchCore4Json('/governance/laws'),
        fetchCore4Json('/governance/trust/weights'),
      ]);

    if (!proposalResponse.ok) {
      return sendCore4Error(
        res,
        proposalResponse,
        'Failed to retrieve governance status',
      );
    }

    // Like laws and trust weights below, an unreadable part degrades to null
    // rather than failing the whole status view.
    const proposalPage = readCore4ProposalPage(proposalResponse.payload);
    const laws = lawResponse.ok ? extractCore4Data(lawResponse.payload) : null;
    const trustWeights = trustWeightsResponse.ok
      ? extractCore4Data(trustWeightsResponse.payload)
      : null;

    return res.json({
      success: true,
      data: {
        core4: 'available',
        proposalCount: proposalPage ? proposalPage.total : null,
        // core4 pages laws by cursor and exposes no total. The first page is an
        // exact count only when there is no next page; otherwise report a lower bound.
        lawCount: Array.isArray(laws?.items) && !laws.next_cursor ? laws.items.length : null,
        lawCountAtLeast: Array.isArray(laws?.items) && laws.next_cursor ? laws.items.length : null,
        trustWeights: trustWeights ?? null,
      },
      message: 'Governance status retrieved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving governance status', { error });
    return sendCore4Unavailable(
      res,
      error,
      'Failed to retrieve governance status',
    );
  }
});

router.get('/proposals', governanceGetLimiter, async (req: Request, res: Response) => {
  try {
    // Clamped like every other list (and like core4 itself), then forwarded:
    // core4 pages by offset/limit, so `?page=` becomes an offset here.
    const { limit, offset } = parseListPagination(req.query, {
      defaultLimit: PROPOSALS_DEFAULT_LIMIT,
      maxLimit: PROPOSALS_MAX_LIMIT,
    });
    const response = await fetchCore4Json('/governance/proposals', {
      query: { offset, limit },
    });

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to retrieve proposals');
    }

    const page = readCore4ProposalPage(response.payload);
    if (!page) {
      return sendProposalShapeMismatch(res);
    }

    return res.json({
      success: true,
      // `count` is this page's length; `total` is every proposal on chain.
      count: page.proposals.length,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.offset + page.proposals.length < page.total,
      // Native core4 fields plus derived display fields (title, description,
      // ...) that the mobile ProposalModel requires.
      proposals: page.proposals.map(toProposalView),
    });
  } catch (error) {
    logger.error('Error retrieving proposals', { error });
    return sendCore4Unavailable(res, error, 'Failed to retrieve proposals');
  }
});

// Proposal ids are opaque core4 tokens (e.g. `prop-001`). Anything outside this
// alphabet — `.`, `/`, `%`, `?` — could rewrite the upstream core4 path once
// interpolated, so reject it before building the URL (backend#1221).
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

router.get('/proposals/:id', governanceGetLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!PROPOSAL_ID_RE.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid proposal id' });
  }
  try {
    const response = await fetchCore4Json(`/governance/proposals/${encodeURIComponent(id)}`);

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to retrieve proposal');
    }

    const proposal = extractCore4Data(response.payload);
    return res.json({
      success: true,
      proposal: proposal == null ? null : toProposalView(proposal),
    });
  } catch (error) {
    logger.error(`Error retrieving proposal ${id}`, { error });
    return sendCore4Unavailable(res, error, 'Failed to retrieve proposal');
  }
});

router.post(
  '/proposals',
  authMiddleware.requireAdmin,
  governanceWriteLimiter,
  async (req: Request, res: Response) => {
    try {
      const { payload, source } = adminBodyOrConfig('WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG', req.body);
      const proposer = configuredAddress('WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS');
      const headers = { ...core4OperatorHeaders(req.headers), 'x-proposer-address': proposer };
      const audit = { source, proposalId: payload.proposal_id, parameter: payload.parameter };
      const response = await auditedAdminWrite(req, 'governance.proposal', audit, () => fetchCore4Json('/governance/proposals/submit', {
        method: 'POST',
        headers,
        body: payload,
      }));

      if (!response.ok) {
        return sendCore4Error(res, response, 'Failed to create proposal');
      }

      return res.status(response.status).json({
        success: true,
        proposal: extractCore4Data(response.payload),
        message: 'Proposal created successfully',
      });
    } catch (error) {
      if (sendAdminPolicyError(res, error)) return;
      logger.error('Error creating proposal', { code: 'CORE4_UNAVAILABLE' });
      return sendCore4Unavailable(res, error, 'Failed to create proposal');
    }
  },
);

// --- Governance lifecycle: activate, finalize, execute, update ---

async function handleUpdateProposal(req: Request, res: Response) {
  try {
    const proposalId = parseInt(req.params.id);
    const [existing] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, proposalId));
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const isCreator = existing.proposer === (req.user?.address || req.user?.id);
    const isAdmin = hasAdminRole(req.user);
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the proposal creator or an admin can perform this action' });
    }

    const updates: Record<string, any> = {};
    if (req.body.title) updates.title = req.body.title;
    if (req.body.description) updates.description = req.body.description;
    if (req.body.metadata) updates.metadata = req.body.metadata;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields provided' });
    }

    const [updated] = await db.update(proposalsTable).set(updates).where(eq(proposalsTable.id, proposalId)).returning();
    return res.json({ success: true, proposal: updated, message: 'Proposal updated' });
  } catch (error) {
    logger.error(`Error updating proposal ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to update proposal' });
  }
}

async function handleActivateProposal(req: Request, res: Response) {
  try {
    const proposalId = parseInt(req.params.id);
    const [existing] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, proposalId));
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const isCreator = existing.proposer === (req.user?.address || req.user?.id);
    const isAdmin = hasAdminRole(req.user);
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the proposal creator or an admin can perform this action' });
    }

    if (existing.status !== 'DEPOSIT' && existing.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Cannot activate proposal in '${existing.status}' status` });
    }

    const now = new Date();
    const votingPeriod = existing.votingPeriod || 604800; // default 7 days
    const votingEnd = new Date(now.getTime() + votingPeriod * 1000);

    const [updated] = await db.update(proposalsTable).set({
      status: 'VOTING',
      state: 'active',
      votingStartTime: now,
      votingEndTime: votingEnd,
    }).where(eq(proposalsTable.id, proposalId)).returning();

    return res.json({ success: true, proposal: updated, message: 'Proposal activated for voting' });
  } catch (error) {
    logger.error(`Error activating proposal ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to activate proposal' });
  }
}

async function handleFinalizeProposal(req: Request, res: Response) {
  try {
    const proposalId = parseInt(req.params.id);
    const [existing] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, proposalId));
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const isCreator = existing.proposer === (req.user?.address || req.user?.id);
    const isAdmin = hasAdminRole(req.user);
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the proposal creator or an admin can perform this action' });
    }

    if (existing.status !== 'VOTING' && existing.status !== 'ACTIVE') {
      return res.status(409).json({ success: false, error: `Cannot finalize proposal in '${existing.status}' status` });
    }

    if (existing.votingEndTime && new Date(existing.votingEndTime) > new Date()) {
      return res.status(400).json({ error: 'Cannot finalize proposal while voting period is still active' });
    }

    const yesVotes = parseInt(existing.totalYes ?? '0') || 0;
    const noVotes = parseInt(existing.totalNo ?? '0') || 0;
    const vetoVotes = parseInt(existing.totalNoWithVeto ?? '0') || 0;
    const totalVotes = yesVotes + noVotes + vetoVotes + (parseInt(existing.totalAbstain ?? '0') || 0);

    let finalStatus: string;
    if (totalVotes === 0) {
      finalStatus = 'REJECTED';
    } else if (vetoVotes > totalVotes / 3) {
      finalStatus = 'VETOED';
    } else if (yesVotes > noVotes) {
      finalStatus = 'PASSED';
    } else {
      finalStatus = 'REJECTED';
    }

    const [updated] = await db.update(proposalsTable).set({
      status: finalStatus,
      state: finalStatus.toLowerCase(),
    }).where(eq(proposalsTable.id, proposalId)).returning();

    return res.json({
      success: true,
      proposal: updated,
      tally: { yes: yesVotes, no: noVotes, veto: vetoVotes, total: totalVotes },
      message: `Proposal finalized: ${finalStatus}`,
    });
  } catch (error) {
    logger.error(`Error finalizing proposal ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to finalize proposal' });
  }
}

async function handleExecuteProposal(req: Request, res: Response) {
  try {
    const proposalId = parseInt(req.params.id);
    const [existing] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, proposalId));
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const isCreator = existing.proposer === (req.user?.address || req.user?.id);
    const isAdmin = hasAdminRole(req.user);
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Only the proposal creator or an admin can perform this action' });
    }

    if (existing.status !== 'PASSED') {
      return res.status(409).json({ success: false, error: `Cannot execute proposal in '${existing.status}' status (must be PASSED)` });
    }

    // No state transition occurs until a canonical execution adapter returns
    // a verified receipt with durable provenance.
    return res.status(503).json({
      success: false,
      code: 'CANONICAL_EXECUTION_UNAVAILABLE',
      error: 'Proposal passed, but no canonical execution receipt was produced; state remains PASSED',
      proposal: { id: existing.id, status: existing.status },
    });
  } catch (error) {
    logger.error(`Error executing proposal ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to execute proposal' });
  }
}

router.put('/proposals/:id/activate', authMiddleware.requireAuth, handleActivateProposal);
router.post('/proposals/:id/activate', authMiddleware.requireAuth, handleActivateProposal);
router.put('/proposals/:id/finalize', authMiddleware.requireAuth, handleFinalizeProposal);
router.post('/proposals/:id/finalize', authMiddleware.requireAuth, handleFinalizeProposal);
router.put('/proposals/:id/execute', authMiddleware.requireAuth, handleExecuteProposal);
router.post('/proposals/:id/execute', authMiddleware.requireAuth, handleExecuteProposal);
router.put('/proposals/:id', authMiddleware.requireAuth, handleUpdateProposal);
router.post('/proposals/:id', authMiddleware.requireAuth, handleUpdateProposal);

router.post(
  '/proposals/:id/vote',
  authMiddleware.requireAuth,
  governanceVoteLimiter,
  async (req: Request, res: Response) => {
    try {
      const { voter, payload } = verifiedGovernanceVote(req.user, req.params.id, req.body);
      const response = await fetchCore4Json('/governance/vote', {
        method: 'POST',
        headers: { ...core4ContributorHeaders(req.headers), 'x-voter-address': voter },
        body: payload,
      });

      if (!response.ok) {
        return sendCore4Error(res, response, 'Failed to cast vote');
      }

      return res.json({
        success: true,
        vote: {
          proposalId: req.params.id,
          voterAddress: voter,
          support: payload.approve,
          reason: req.body?.reason ?? null,
          core4: extractCore4Data(response.payload),
        },
        message: 'Vote cast successfully',
      });
    } catch (error) {
      if (error?.governanceVotePolicy) return res.status(error.status).json({ success: false, error: error.message });
      if (error?.code === CONTRIBUTOR_UNCONFIGURED) return sendContributorCredentialUnavailable(res);
      logger.error(`Error voting on proposal ${req.params.id}`, { error });
      return sendCore4Unavailable(res, error, 'Failed to cast vote');
    }
  },
);

router.get('/proposals/:id/votes', async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.id;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const proposalFilter = eq(votesTable.proposalId, proposalId);

    const [countRow] = await db
      .select({ total: count() })
      .from(votesTable)
      .where(proposalFilter);

    const results = await db
      .select()
      .from(votesTable)
      .where(proposalFilter)
      .orderBy(desc(votesTable.timestamp), desc(votesTable.id))
      .limit(limit)
      .offset(offset);

    return res.json(paginatedResponse(results, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    logger.error(`Error retrieving votes for proposal ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve proposal votes' });
  }
});

// --- Treasury endpoints ---

router.get('/treasury', async (_req: Request, res: Response) => {
  try {
    const [summary] = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'treasury_transaction' AND approval_status = 'executed' AND amount > 0 THEN amount::numeric ELSE 0 END), 0) AS total_deposits,
        COALESCE(SUM(CASE WHEN transaction_type = 'treasury_transaction' AND approval_status = 'executed' AND amount < 0 THEN ABS(amount::numeric) ELSE 0 END), 0) AS total_withdrawals,
        COALESCE(COUNT(*) FILTER (WHERE transaction_type = 'treasury_transaction' AND approval_status = 'executed'), 0) AS transaction_count
      FROM treasury_consolidated`,
    );

    const totalDeposits = Number(summary?.total_deposits ?? 0);
    const totalWithdrawals = Number(summary?.total_withdrawals ?? 0);
    const transactionCount = Number(summary?.transaction_count ?? 0);

    return res.json({
      success: true,
      data: {
        balance: (totalDeposits - totalWithdrawals).toFixed(8),
        totalDeposits: totalDeposits.toFixed(8),
        totalWithdrawals: totalWithdrawals.toFixed(8),
        transactionCount,
        amountUnits: treasuryAmountUnits(['balance', 'totalDeposits', 'totalWithdrawals']),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving treasury', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve treasury data' });
  }
});

router.get('/treasury/transactions', async (req: Request, res: Response) => {
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const [countRow] = await db
      .select({ total: count() })
      .from(treasuryConsolidated)
      .where(eq(treasuryConsolidated.transactionType, 'treasury_transaction'));

    const transactions = await db
      .select()
      .from(treasuryConsolidated)
      .where(eq(treasuryConsolidated.transactionType, 'treasury_transaction'))
      .orderBy(desc(treasuryConsolidated.createdAt), desc(treasuryConsolidated.id))
      .limit(limit)
      .offset(offset);

    return res.json(
      paginatedResponse(
        transactions,
        Number(countRow?.total ?? 0),
        page,
        limit,
      ),
    );
  } catch (error) {
    logger.error('Error retrieving treasury transactions', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve treasury transactions' });
  }
});

// --- Budget categories ---

router.get('/budget-categories', async (_req: Request, res: Response) => {
  try {
    const categories = await db
      .select()
      .from(treasuryConsolidated)
      .where(eq(treasuryConsolidated.transactionType, 'budget_allocation'))
      .orderBy(desc(treasuryConsolidated.createdAt));

    return res.json({ success: true, count: categories.length, categories });
  } catch (error) {
    logger.error('Error retrieving budget categories', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve budget categories' });
  }
});

// --- Parameters ---

router.get('/parameters', async (_req: Request, res: Response) => {
  try {
    const params = await db.select().from(parametersTable).where(eq(parametersTable.active, true));
    return res.json({ success: true, count: params.length, parameters: params });
  } catch (error) {
    logger.error('Error retrieving governance parameters', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve parameters' });
  }
});

// --- Voting power ---

router.get('/voting-power', async (req: Request, res: Response) => {
  try {
    const address = req.query.address as string;
    if (!address) {
      return res.status(400).json({ success: false, error: 'Missing required query parameter: address' });
    }

    // Base voting power from delegations received
    const [delegatedData] = await db
      .select({ totalAmount: sum(delegationsTable.amount) })
      .from(delegationsTable)
      .where(and(eq(delegationsTable.delegate, address), eq(delegationsTable.active, true)));

    const delegatedPower = parseInt(delegatedData?.totalAmount ?? '0') || 0;

    // Participation bonus: votes cast
    const [participationData] = await db
      .select({ voteCount: count() })
      .from(votesTable)
      .where(eq(votesTable.voter, address));

    const participationBonus = Math.min((participationData?.voteCount || 0) * 10, 500);

    const totalPower = delegatedPower + participationBonus;

    return res.json({
      success: true,
      data: { address, delegatedPower, participationBonus, totalPower },
    });
  } catch (error) {
    logger.error('Error computing voting power', { error });
    return res.status(500).json({ success: false, error: 'Failed to compute voting power' });
  }
});

// --- Votes by address ---

router.get('/votes/:address', async (req: Request, res: Response) => {
  try {
    const results = await db
      .select()
      .from(votesTable)
      .where(eq(votesTable.voter, req.params.address))
      .orderBy(desc(votesTable.timestamp));

    return res.json({ success: true, count: results.length, votes: results });
  } catch (error) {
    logger.error(`Error retrieving votes for ${req.params.address}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve voter history' });
  }
});

// --- Analytics endpoints ---

router.get('/analytics/dashboard', async (_req: Request, res: Response) => {
  try {
    const [proposalStats] = await db.select({ total: count() }).from(proposalsTable);
    const [voteStats] = await db.select({ total: count() }).from(votesTable);
    const activeProposals = await db.select().from(proposalsTable).where(eq(proposalsTable.status, 'VOTING'));
    const recentProposals = await db.select().from(proposalsTable).orderBy(desc(proposalsTable.createdAt)).limit(5);

    return res.json({
      success: true,
      data: {
        totalProposals: proposalStats?.total ?? 0,
        totalVotes: voteStats?.total ?? 0,
        activeProposals: activeProposals.length,
        recentProposals,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving analytics dashboard', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve dashboard' });
  }
});

router.get('/analytics/participation', async (_req: Request, res: Response) => {
  try {
    const [proposalCount] = await db.select({ total: count() }).from(proposalsTable);
    const [voteCount] = await db.select({ total: count() }).from(votesTable);
    const [uniqueVoters] = await db.select({ total: sql<number>`count(distinct ${votesTable.voter})` }).from(votesTable);

    return res.json({
      success: true,
      data: {
        totalProposals: proposalCount?.total ?? 0,
        totalVotes: voteCount?.total ?? 0,
        uniqueVoters: uniqueVoters?.total ?? 0,
        avgVotesPerProposal: (proposalCount?.total ?? 0) > 0
          ? ((voteCount?.total ?? 0) / (proposalCount?.total ?? 1)).toFixed(2)
          : '0',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving participation analytics', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve participation data' });
  }
});

router.get('/analytics/treasury', async (_req: Request, res: Response) => {
  try {
    const [analytics] = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'treasury_transaction' AND approval_status = 'executed' AND amount > 0 THEN amount::numeric ELSE 0 END), 0) AS total_inflow,
        COALESCE(SUM(CASE WHEN transaction_type = 'treasury_transaction' AND approval_status = 'executed' AND amount < 0 THEN ABS(amount::numeric) ELSE 0 END), 0) AS total_outflow,
        COALESCE(COUNT(*) FILTER (WHERE transaction_type = 'treasury_transaction' AND approval_status = 'executed'), 0) AS transaction_count
      FROM treasury_consolidated
    `);

    const totalIn = Number(analytics?.total_inflow ?? 0);
    const totalOut = Number(analytics?.total_outflow ?? 0);
    const transactionCount = Number(analytics?.transaction_count ?? 0);

    return res.json({
      success: true,
      data: {
        balance: (totalIn - totalOut).toFixed(8),
        totalInflow: totalIn.toFixed(8),
        totalOutflow: totalOut.toFixed(8),
        transactionCount,
        amountUnits: treasuryAmountUnits(['balance', 'totalInflow', 'totalOutflow']),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving treasury analytics', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve treasury analytics' });
  }
});

router.get('/analytics/delegates', async (_req: Request, res: Response) => {
  try {
    const activeDelegations = await db
      .select()
      .from(delegationsTable)
      .where(eq(delegationsTable.active, true))
      .orderBy(desc(delegationsTable.createdAt));

    // Aggregate by delegate
    const delegateMap = new Map<string, { totalAmount: number; delegatorCount: number }>();
    for (const d of activeDelegations) {
      const current = delegateMap.get(d.delegate) || { totalAmount: 0, delegatorCount: 0 };
      current.totalAmount += parseFloat(d.amount ?? '0');
      current.delegatorCount += 1;
      delegateMap.set(d.delegate, current);
    }

    const delegates = Array.from(delegateMap.entries()).map(([address, data]) => ({
      address,
      totalDelegated: data.totalAmount.toFixed(8),
      delegatorCount: data.delegatorCount,
    }));

    return res.json({
      success: true,
      count: delegates.length,
      delegates,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving delegate analytics', { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve delegate analytics' });
  }
});

// --- Treasury write endpoints ---

function proposalContent(proposal: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = proposal.metadata;
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  const raw = metadataRecord?.content ?? proposal.parametersToChange ?? metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function governanceIntentId(
  proposalId: number,
  action: 'treasury_withdrawal' | 'validator_slashing',
) {
  return `GOV-${proposalId}-${action}`;
}

function proposalAuthorizesAction(
  proposal: Record<string, unknown>,
  action: 'treasury_withdrawal' | 'validator_slashing',
  expected: Record<string, unknown>,
) {
  const content = proposalContent(proposal);
  const declaredAction = String(
    proposal.proposalType ?? content?.action ?? content?.type ?? '',
  ).toLowerCase();
  if (declaredAction !== action || !content) return false;
  return Object.entries(expected).every(([key, value]) => String(content[key]) === String(value));
}

router.post('/treasury/deposit', authMiddleware.requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount, tokenAddress, description } = req.body;
    if (!amount || !tokenAddress) {
      return res.status(400).json({ success: false, error: 'Missing required fields: amount, tokenAddress' });
    }

    const transactionId = `TXN-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [record] = await db.insert(treasuryConsolidated).values({
      transactionId,
      transactionType: 'treasury_transaction',
      fromAddress: req.user?.address || req.user?.id || 'unknown',
      toAddress: 'treasury',
      tokenAddress,
      amount: String(amount),
      description: description || 'Treasury deposit',
      approvalStatus: 'pending',
      createdAt: new Date(),
    }).returning();

    return res.status(202).json({ success: true, executed: false, transaction: record, message: 'Deposit intent recorded; canonical execution is pending' });
  } catch (error) {
    logger.error('Error recording treasury deposit', { error });
    return res.status(500).json({ success: false, error: 'Failed to record deposit' });
  }
});

router.post('/treasury/withdraw', authMiddleware.requireAdmin, async (req: Request, res: Response) => {
  try {
    const { amount, tokenAddress, toAddress, description, proposalId } = req.body;
    if (!amount || !tokenAddress || !toAddress || !proposalId) {
      return res.status(400).json({ success: false, error: 'Missing required fields: amount, tokenAddress, toAddress, proposalId' });
    }
    const parsedProposalId = Number(proposalId);
    if (!Number.isInteger(parsedProposalId) || parsedProposalId <= 0) {
      return res.status(400).json({ success: false, error: 'proposalId must be a positive integer' });
    }
    const [proposal] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, parsedProposalId));
    if (!proposal) return res.status(404).json({ success: false, error: 'Governance proposal not found' });
    if (proposal.status !== 'PASSED') return res.status(409).json({ success: false, error: `Withdrawal requires a PASSED proposal; current status is ${proposal.status}` });
    if (!proposalAuthorizesAction(proposal, 'treasury_withdrawal', { amount, tokenAddress, toAddress })) {
      return res.status(409).json({ success: false, error: 'PASSED proposal does not authorize this exact withdrawal' });
    }

    const transactionId = governanceIntentId(parsedProposalId, 'treasury_withdrawal');
    const [inserted] = await db.insert(treasuryConsolidated).values({
      transactionId,
      transactionType: 'treasury_transaction',
      fromAddress: 'treasury',
      toAddress,
      tokenAddress,
      amount: String(-Math.abs(parseFloat(amount))),
      description: description || 'Treasury withdrawal',
      proposalId: String(parsedProposalId),
      approvalStatus: 'approved',
      createdAt: new Date(),
    }).onConflictDoNothing({ target: treasuryConsolidated.transactionId }).returning();

    const [record] = inserted
      ? [inserted]
      : await db.select().from(treasuryConsolidated).where(eq(treasuryConsolidated.transactionId, transactionId));
    if (!record) throw new Error('Governance withdrawal intent disappeared after conflict');

    return res.status(202).json({ success: true, executed: false, transaction: record, message: 'Approved withdrawal intent recorded; canonical execution is pending' });
  } catch (error) {
    logger.error('Error recording treasury withdrawal', { error });
    return res.status(500).json({ success: false, error: 'Failed to record withdrawal' });
  }
});

router.post('/budget-categories', authMiddleware.requireAuth, async (req: Request, res: Response) => {
  try {
    const { category, amount, tokenAddress, description, budgetData } = req.body;
    if (!category || !amount || !tokenAddress) {
      return res.status(400).json({ success: false, error: 'Missing required fields: category, amount, tokenAddress' });
    }

    const transactionId = `BDG-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [record] = await db.insert(treasuryConsolidated).values({
      transactionId,
      transactionType: 'budget_allocation',
      category,
      tokenAddress,
      amount: String(amount),
      description: description || `Budget allocation: ${category}`,
      budgetData: budgetData || { category, allocatedBy: req.user?.address || 'admin' },
      approvalStatus: 'pending',
      createdAt: new Date(),
    }).returning();

    return res.status(201).json({ success: true, budgetCategory: record, message: 'Budget category created' });
  } catch (error) {
    logger.error('Error creating budget category', { error });
    return res.status(500).json({ success: false, error: 'Failed to create budget category' });
  }
});

router.post('/rewards/slashing-event', authMiddleware.requireAdmin, async (req: Request, res: Response) => {
  try {
    const { validatorAddress, amount, tokenAddress, reason, proposalId } = req.body;
    if (!validatorAddress || !amount || !tokenAddress || !proposalId) {
      return res.status(400).json({ success: false, error: 'Missing required fields: validatorAddress, amount, tokenAddress, proposalId' });
    }
    const parsedProposalId = Number(proposalId);
    if (!Number.isInteger(parsedProposalId) || parsedProposalId <= 0) {
      return res.status(400).json({ success: false, error: 'proposalId must be a positive integer' });
    }
    const [proposal] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, parsedProposalId));
    if (!proposal) return res.status(404).json({ success: false, error: 'Governance proposal not found' });
    if (proposal.status !== 'PASSED') return res.status(409).json({ success: false, error: `Slashing requires a PASSED proposal; current status is ${proposal.status}` });
    if (!proposalAuthorizesAction(proposal, 'validator_slashing', { validatorAddress, amount, tokenAddress })) {
      return res.status(409).json({ success: false, error: 'PASSED proposal does not authorize this exact slashing action' });
    }

    const transactionId = governanceIntentId(parsedProposalId, 'validator_slashing');
    const [inserted] = await db.insert(treasuryConsolidated).values({
      transactionId,
      transactionType: 'reward_distribution',
      fromAddress: validatorAddress,
      toAddress: 'treasury',
      tokenAddress,
      amount: String(amount),
      description: reason || `Slashing event for ${validatorAddress}`,
      rewardData: { type: 'slashing', validatorAddress, reason },
      proposalId: String(parsedProposalId),
      approvalStatus: 'approved',
      createdAt: new Date(),
    }).onConflictDoNothing({ target: treasuryConsolidated.transactionId }).returning();

    const [record] = inserted
      ? [inserted]
      : await db.select().from(treasuryConsolidated).where(eq(treasuryConsolidated.transactionId, transactionId));
    if (!record) throw new Error('Governance slashing intent disappeared after conflict');

    return res.status(202).json({ success: true, executed: false, slashingEvent: record, message: 'Approved slashing intent recorded; canonical execution is pending' });
  } catch (error) {
    logger.error('Error recording slashing event', { error });
    return res.status(500).json({ success: false, error: 'Failed to record slashing event' });
  }
});

router.put('/budget-categories/:id', authMiddleware.requireAdmin, async (req: Request, res: Response) => {
  try {
    const budgetId = parseInt(req.params.id);
    const [existing] = await db.select().from(treasuryConsolidated).where(eq(treasuryConsolidated.id, budgetId));
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Budget category not found' });
    }

    const updates: Record<string, any> = {};
    if (req.body.category) updates.category = req.body.category;
    if (req.body.amount) updates.amount = String(req.body.amount);
    if (req.body.description) updates.description = req.body.description;
    if (req.body.approvalStatus) updates.approvalStatus = req.body.approvalStatus;
    if (req.body.budgetData) updates.budgetData = req.body.budgetData;

    const [updated] = await db.update(treasuryConsolidated).set(updates).where(eq(treasuryConsolidated.id, budgetId)).returning();
    return res.json({ success: true, budgetCategory: updated, message: 'Budget category updated' });
  } catch (error) {
    logger.error(`Error updating budget category ${req.params.id}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to update budget category' });
  }
});

router.put('/parameters/:key', authMiddleware.requireAdmin, async (req: Request, res: Response) => {
  try {
    const paramName = req.params.key;
    const { value, reason } = req.body;
    if (value === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required field: value' });
    }

    const [existing] = await db.select().from(parametersTable).where(eq(parametersTable.name, paramName));
    if (!existing) {
      return res.status(404).json({ success: false, error: `Parameter '${paramName}' not found` });
    }

    const [updated] = await db.update(parametersTable).set({
      value: String(value),
      updatedAt: new Date(),
    }).where(eq(parametersTable.name, paramName)).returning();

    return res.json({
      success: true,
      parameter: updated,
      previousValue: existing.value,
      message: `Parameter '${paramName}' updated`,
    });
  } catch (error) {
    logger.error(`Error updating parameter ${req.params.key}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to update parameter' });
  }
});

router.get('/parameters/:key', governanceGetLimiter, async (req: Request, res: Response) => {
  try {
    // For trust_weights, try core4 first (backward compat)
    if (req.params.key === 'trust_weights') {
      try {
        const response = await fetchCore4Json('/governance/trust/weights');
        if (response.ok) {
          return res.json({
            success: true,
            parameter: { key: req.params.key, value: extractCore4Data(response.payload) ?? null },
          });
        }
      } catch {
        // Fall through to local DB lookup
      }
    }

    // Look up in local parameters table
    const [param] = await db
      .select()
      .from(parametersTable)
      .where(eq(parametersTable.name, req.params.key));

    if (!param) {
      return res.status(404).json({ success: false, error: `Parameter '${req.params.key}' not found` });
    }

    return res.json({
      success: true,
      parameter: { key: param.name, value: param.value, dataType: param.dataType, description: param.description },
    });
  } catch (error) {
    logger.error(`Error retrieving governance parameter ${req.params.key}`, { error });
    return res.status(500).json({ success: false, error: 'Failed to retrieve governance parameter' });
  }
});

router.post('/delegate', authMiddleware.requireAuth, async (req: Request, res: Response) => {
  try {
    const { delegate, amount } = req.body;
    const delegator = req.user?.address || req.user?.id;
    if (!delegate || !delegator) {
      return res.status(400).json({ success: false, error: 'Missing required fields: delegate (and valid auth)' });
    }
    if (delegate === delegator) {
      return res.status(400).json({ success: false, error: 'Cannot delegate to yourself' });
    }

    // Deactivate any existing delegation from this delegator
    await db.update(delegationsTable).set({ active: false }).where(
      and(eq(delegationsTable.delegator, delegator), eq(delegationsTable.active, true)),
    );

    const [delegation] = await db.insert(delegationsTable).values({
      delegator,
      delegate,
      amount: String(amount || 0),
      active: true,
      createdAt: new Date(),
    }).returning();

    return res.status(201).json({
      success: true,
      delegation,
      message: `Voting power delegated to ${delegate}`,
    });
  } catch (error) {
    logger.error('Error creating delegation', { error });
    return res.status(500).json({ success: false, error: 'Failed to create delegation' });
  }
});

export default router;
