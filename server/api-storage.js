/**
 * api-storage.js — Real DB-backed storage for server/api.js (#603)
 *
 * api.js is CommonJS; the database layer is ESM (Drizzle + postgres-js).
 * We bridge them with dynamic import() so the ESM modules are loaded lazily
 * on first use. All methods that api.js routes actually invoke get real
 * Drizzle queries; unused methods retain safe empty-response stubs.
 */

'use strict';

let _db, _nfts, _eq, _desc, _asc;
let _initialized = false;
let _initPromise = null;

/**
 * Lazily load the ESM database layer. Returns a promise that resolves once
 * the imports are ready. Repeated calls return the same settled promise.
 */
function ensureInit() {
  if (_initialized) return Promise.resolve();
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const dbMod = await import('../database/connection.js');
    const schemaMod = await import('../shared/schema.js');
    const orm = await import('drizzle-orm');

    _db = dbMod.db;
    _nfts = schemaMod.nfts;
    _eq = orm.eq;
    _desc = orm.desc;
    _asc = orm.asc;
    _initialized = true;
  })().catch(err => {
    // Reset so a retry is possible after transient startup failures.
    _initPromise = null;
    throw err;
  });

  return _initPromise;
}

const storage = {
  // ─── NFT methods ────────────────────────────────────────────────────────────

  /** Return up to `limit` NFTs ordered newest-first. */
  getAllNFTs: async (limit = 100) => {
    await ensureInit();
    return _db.select().from(_nfts).orderBy(_desc(_nfts.createdAt)).limit(limit);
  },

  /** Look up a single NFT by its string nftId. Returns null if not found. */
  getNFTById: async (id) => {
    await ensureInit();
    const rows = await _db.select().from(_nfts).where(_eq(_nfts.nftId, String(id))).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Return NFTs whose `creator` column matches the given address.
   * This is intentionally distinct from getNFTsByOwner — creator != owner.
   */
  getNFTsByCreator: async (creator) => {
    await ensureInit();
    return _db.select().from(_nfts).where(_eq(_nfts.creator, creator)).orderBy(_desc(_nfts.createdAt));
  },

  /** Return NFTs whose `owner` column matches the given address. */
  getNFTsByOwner: async (owner) => {
    await ensureInit();
    return _db.select().from(_nfts).where(_eq(_nfts.owner, owner)).orderBy(_desc(_nfts.createdAt));
  },

  /** Insert a new NFT row and return the inserted record. */
  createNFT: async (nft) => {
    await ensureInit();
    const { randomUUID } = await import('node:crypto');
    const rows = await _db
      .insert(_nfts)
      .values({
        nftId: nft.nftId || randomUUID(),
        title: nft.title || nft.name || 'Untitled',
        description: nft.description ?? null,
        creator: nft.creator || nft.owner || '',
        owner: nft.owner || nft.creator || '',
        contentUri: nft.contentUri ?? null,
        metadata: nft.metadata ?? null,
        nftType: nft.nftType || 'standard',
      })
      .returning();
    return rows[0];
  },

  /** Update fields on an existing NFT and return the updated record. */
  updateNFT: async (id, updates) => {
    await ensureInit();
    const rows = await _db
      .update(_nfts)
      .set({ ...updates, updatedAt: new Date() })
      .where(_eq(_nfts.nftId, String(id)))
      .returning();
    return rows[0] ?? null;
  },

  // ─── Block / chain stats — served by blockchainController/adapter ───────────
  // These stubs return safe empty values; the live data comes from core4 via
  // the blockchain adapter and blockchainController, not from Drizzle.

  getBlockByHash: async () => null,
  getBlockByHeight: async () => null,
  getLatestBlocks: async () => [],
  createBlock: async (data) => ({ ...data }),
  getNodeCount: async () => 0,
  getNetworkHashrate: async () => 0,
  getTotalTransactionCount: async () => 0,

  // ─── Transaction stubs ───────────────────────────────────────────────────────

  getTransactionByHash: async () => null,
  getTransactionsByBlockHash: async () => [],
  getTransactionsBySender: async () => [],
  getTransactionsByRecipient: async () => [],
  createTransaction: async (data) => ({ ...data }),

  // ─── User stubs ─────────────────────────────────────────────────────────────

  getUser: async () => null,
  getUserByUsername: async () => null,
  createUser: async (data) => ({ ...data }),

  // ─── Mining pool stubs ───────────────────────────────────────────────────────

  getMiningPoolById: async () => null,
  getMiningPoolByName: async () => null,
  getAllMiningPools: async () => [],
  createMiningPool: async (pool) => ({ ...pool }),
  updateMiningPool: async (_id, updates) => ({ ...updates }),
  getMiningPoolMembers: async () => [],
  addMiningPoolMember: async (member) => ({ ...member }),
  updateMiningPoolMember: async (_id, updates) => ({ ...updates }),
  getMiningPoolMemberByAddress: async () => null,

  // ─── Mining stubs ────────────────────────────────────────────────────────────

  getMiningContributionsByAddress: async () => [],
  createMiningContribution: async (data) => ({ ...data }),
  getMiningRewardsByBlockHash: async () => null,
  createMiningReward: async (data) => ({ ...data }),
};

module.exports = storage;
