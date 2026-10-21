/**
 * MPC Session Manager Module
 *
 * This module manages Multi-Party Computation sessions, including:
 * - Session creation and tracking
 * - Party management within sessions
 * - Session state management
 * - Timeout handling
 */

const { randomBytes } = require('crypto');
const { logger } = require('../utils/logger');

// In-memory storage for sessions (would be replaced with a database in production)
const sessions = new Map();

/**
 * Create a new MPC session
 * @param {string} protocol - The MPC protocol to use
 * @param {number} threshold - Threshold for the computation
 * @param {string[]} participants - List of participant party IDs
 * @param {Object} metadata - Additional session metadata
 * @returns {string} Generated session ID
 */
function createSession(protocol, threshold, participants, metadata = {}) {
  // Generate a unique session ID
  const sessionId = randomBytes(16).toString('hex');

  // Create session
  const session = {
    id: sessionId,
    protocol,
    threshold,
    participants,
    metadata,
    status: 'initialized',
    parties: new Map(),
    shares: new Map(),
    rounds: new Map(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: metadata.createdBy || 'system',
  };

  // Set session timeout if specified
  if (metadata.timeoutMs) {
    session.timeoutId = setTimeout(
      () => handleSessionTimeout(sessionId),
      metadata.timeoutMs
    );
  }

  // Store the session
  sessions.set(sessionId, session);

  logger.info(
    `[SessionManager] Created new session: ${sessionId} (${protocol}, ${participants.length} participants)`
  );

  return sessionId;
}

/**
 * Get a session by ID
 * @param {string} sessionId - ID of the session to retrieve
 * @returns {Object|null} Session object or null if not found
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    logger.warn(`[SessionManager] Session not found: ${sessionId}`);
    return null;
  }

  const session = sessions.get(sessionId);
  logger.debug(`[SessionManager] Retrieved session: ${sessionId}`);

  return session;
}

/**
 * Add a party to a session
 * @param {string} sessionId - The session ID
 * @param {string} partyId - The party ID
 * @param {Object} connection - Party's connection information (e.g., WebSocket)
 * @returns {boolean} Whether the party was added successfully
 */
function addPartyToSession(sessionId, partyId, connection = {}) {
  const session = getSession(sessionId);
  if (!session) return false;

  if (!session.participants.includes(partyId)) {
    logger.warn(
      `[SessionManager] Party ${partyId} not authorized for session ${sessionId}`
    );
    return false;
  }

  // Add party to session
  session.parties.set(partyId, {
    partyId,
    connection,
    joinedAt: Date.now(),
    status: 'connected',
  });

  session.updatedAt = Date.now();

  logger.info(
    `[SessionManager] Added party ${partyId} to session ${sessionId}`
  );

  return true;
}

/**
 * Remove a party from a session
 * @param {string} sessionId - The session ID
 * @param {string} partyId - The party ID
 * @returns {boolean} Whether the party was removed successfully
 */
function removePartyFromSession(sessionId, partyId) {
  const session = getSession(sessionId);
  if (!session) return false;

  if (!session.parties.has(partyId)) {
    logger.warn(
      `[SessionManager] Party ${partyId} not in session ${sessionId}`
    );
    return false;
  }

  // Remove party from session
  session.parties.delete(partyId);
  session.updatedAt = Date.now();

  logger.info(
    `[SessionManager] Removed party ${partyId} from session ${sessionId}`
  );

  return true;
}

/**
 * Add a share to a session
 * @param {string} sessionId - The session ID
 * @param {string} partyId - The party ID
 * @param {Object} share - The share to add
 * @param {number} round - The round number (optional)
 * @returns {boolean} Whether the share was added successfully
 */
function addShareToSession(sessionId, partyId, share, round = 1) {
  const session = getSession(sessionId);
  if (!session) return false;

  if (!session.participants.includes(partyId)) {
    logger.warn(
      `[SessionManager] Party ${partyId} not authorized for session ${sessionId}`
    );
    return false;
  }

  // Initialize round if it doesn't exist
  if (!session.rounds.has(round)) {
    session.rounds.set(round, new Map());
  }

  // Add share to the appropriate round
  const roundShares = session.rounds.get(round);
  roundShares.set(partyId, share);

  // Also store in the general shares map for convenience
  session.shares.set(partyId, share);

  session.updatedAt = Date.now();

  logger.info(
    `[SessionManager] Added share from party ${partyId} to session ${sessionId}, round ${round}`
  );

  return true;
}

/**
 * Check if a round is complete
 * @param {string} sessionId - The session ID
 * @param {number} round - The round number
 * @returns {boolean} Whether the round has enough shares
 */
function isRoundComplete(sessionId, round = 1) {
  const session = getSession(sessionId);
  if (!session) return false;

  // Get shares for this round
  const roundShares = session.rounds.get(round);
  if (!roundShares) return false;

  // Check if we have at least threshold shares
  return roundShares.size >= session.threshold;
}

/**
 * Update session status
 * @param {string} sessionId - The session ID
 * @param {string} status - New status
 * @param {Object} additionalData - Additional data to update
 * @returns {boolean} Whether the status was updated successfully
 */
function updateSessionStatus(sessionId, status, additionalData = {}) {
  const session = getSession(sessionId);
  if (!session) return false;

  // Update session
  session.status = status;
  session.updatedAt = Date.now();

  // Add additional data
  Object.assign(session, additionalData);

  logger.info(
    `[SessionManager] Updated session ${sessionId} status to ${status}`
  );

  return true;
}

/**
 * Complete a session
 * @param {string} sessionId - The session ID
 * @param {Object} result - Computation result
 * @returns {boolean} Whether the session was completed successfully
 */
function completeSession(sessionId, result) {
  const session = getSession(sessionId);
  if (!session) return false;

  // Update session
  session.status = 'completed';
  session.result = result;
  session.completedAt = Date.now();
  session.updatedAt = Date.now();

  // Clear timeout if exists
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    delete session.timeoutId;
  }

  logger.info(`[SessionManager] Completed session ${sessionId}`);

  return true;
}

/**
 * Handle session timeout
 * @param {string} sessionId - The session ID
 */
function handleSessionTimeout(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;

  if (session.status === 'initialized' || session.status === 'in_progress') {
    // Update session status
    session.status = 'timeout';
    session.updatedAt = Date.now();

    logger.warn(`[SessionManager] Session ${sessionId} timed out`);
  }
}

/**
 * List all sessions (public information only)
 * @param {Object} filters - Optional filters for the sessions
 * @returns {Array<Object>} Array of session information
 */
function listSessions(filters = {}) {
  const result = [];

  for (const [sessionId, session] of sessions.entries()) {
    // Apply filters if any
    if (filters.status && session.status !== filters.status) continue;
    if (filters.protocol && session.protocol !== filters.protocol) continue;

    // Only include public information
    result.push({
      id: session.id,
      protocol: session.protocol,
      threshold: session.threshold,
      participants: session.participants.length,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      completedAt: session.completedAt,
    });
  }

  logger.info(`[SessionManager] Listed ${result.length} sessions`);

  return result;
}

/**
 * Get all shares for a session
 * @param {string} sessionId - The session ID
 * @param {number} round - The round number (optional)
 * @returns {Map<string, Object>|null} Map of party IDs to shares, or null if session not found
 */
function getSessionShares(sessionId, round) {
  const session = getSession(sessionId);
  if (!session) return null;

  if (round !== undefined) {
    // Get shares for specific round
    return session.rounds.get(round) || new Map();
  }

  // Get all shares
  return session.shares;
}

/**
 * Delete a session
 * @param {string} sessionId - The session ID
 * @returns {boolean} Whether the session was deleted successfully
 */
function deleteSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;

  // Clear timeout if exists
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }

  // Delete session
  sessions.delete(sessionId);

  logger.info(`[SessionManager] Deleted session ${sessionId}`);

  return true;
}

module.exports = {
  createSession,
  getSession,
  addPartyToSession,
  removePartyFromSession,
  addShareToSession,
  isRoundComplete,
  updateSessionStatus,
  completeSession,
  handleSessionTimeout,
  listSessions,
  getSessionShares,
  deleteSession,
};
