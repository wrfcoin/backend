/**
 * Consensus Stabilizer for Wrfcoin Backend
 * Implements improved consensus mechanisms with stability features
 */

const { appLogger } = require('./logger');

class ConsensusStabilizer {
  constructor() {
    this.validatorNodes = new Map();
    this.consensusRounds = [];
    this.networkState = {
      height: 12847,
      validators: 42,
      proposer: null,
      votingPower: 0,
      lastBlockTime: null,
    };
    this.stabilityMetrics = {
      consensusTimeouts: 0,
      successfulRounds: 0,
      networkPartitions: 0,
      validatorDropouts: 0,
    };
  }

  // Initialize consensus with validator set
  initializeConsensus(validators = []) {
    validators.forEach(validator => {
      this.validatorNodes.set(validator.id, {
        id: validator.id,
        address: validator.address,
        votingPower: validator.votingPower || 100,
        isActive: true,
        lastSeen: new Date(),
        performance: {
          uptime: 0.99,
          responseTime: 45,
          missedBlocks: 0,
        },
      });
    });

    this.networkState.validators = this.validatorNodes.size;
    this.selectProposer();
  }

  // Select block proposer using round-robin with performance weighting
  selectProposer() {
    const activeValidators = Array.from(this.validatorNodes.values()).filter(
      v => v.isActive && v.performance.uptime > 0.95
    );

    if (activeValidators.length === 0) {
      appLogger.warn('No active validators available for consensus', { module: 'ConsensusStabilizer' });
      return null;
    }

    // Weight selection by performance and voting power
    const weightedValidators = activeValidators.map(v => ({
      ...v,
      weight: v.votingPower * v.performance.uptime,
    }));

    weightedValidators.sort((a, b) => b.weight - a.weight);
    this.networkState.proposer = weightedValidators[0].id;

    return weightedValidators[0];
  }

  // Process consensus round
  async processConsensusRound(blockData) {
    const roundStart = Date.now();
    const roundId = `round_${Date.now()}`;

    try {
      // Phase 1: Propose block
      const proposal = await this.proposeBlock(blockData);

      // Phase 2: Collect prevotes
      const prevotes = await this.collectPrevotes(proposal);

      // Phase 3: Collect precommits if 2/3+ prevotes
      if (this.hasSupermajority(prevotes)) {
        const precommits = await this.collectPrecommits(proposal);

        // Phase 4: Commit block if 2/3+ precommits
        if (this.hasSupermajority(precommits)) {
          await this.commitBlock(proposal);
          this.stabilityMetrics.successfulRounds++;

          this.consensusRounds.push({
            id: roundId,
            height: this.networkState.height,
            proposer: this.networkState.proposer,
            duration: Date.now() - roundStart,
            status: 'committed',
            validators: prevotes.length,
          });

          this.networkState.height++;
          this.networkState.lastBlockTime = new Date();

          return { success: true, height: this.networkState.height - 1 };
        }
      }

      // Consensus failed - timeout
      this.stabilityMetrics.consensusTimeouts++;
      this.handleConsensusTimeout(roundId);

      return { success: false, reason: 'consensus_timeout' };
    } catch (error) {
      appLogger.error('Consensus round failed', { module: 'ConsensusStabilizer', error: error.message });
      return { success: false, reason: error.message };
    }
  }

  // Propose block
  async proposeBlock(blockData) {
    const proposer = this.validatorNodes.get(this.networkState.proposer);
    if (!proposer) {
      throw new Error('No valid proposer selected');
    }

    return {
      height: this.networkState.height,
      proposer: proposer.id,
      data: blockData,
      timestamp: new Date().toISOString(),
      hash: this.generateBlockHash(blockData),
    };
  }

  // Collect prevotes from validators
  async collectPrevotes(proposal) {
    const prevotes = [];
    const timeout = 3000; // 3 seconds

    for (const [id, validator] of this.validatorNodes) {
      if (!validator.isActive) continue;

      try {
        // Simulate validator prevote
        const vote = await this.simulateValidatorVote(
          validator,
          proposal,
          'prevote'
        );
        if (vote) {
          prevotes.push({
            validator: id,
            vote: 'yes',
            votingPower: validator.votingPower,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        appLogger.warn('Prevote failed from validator', { module: 'ConsensusStabilizer', validatorId: id, error: error.message });
      }
    }

    return prevotes;
  }

  // Collect precommits from validators
  async collectPrecommits(proposal) {
    const precommits = [];

    for (const [id, validator] of this.validatorNodes) {
      if (!validator.isActive) continue;

      try {
        const vote = await this.simulateValidatorVote(
          validator,
          proposal,
          'precommit'
        );
        if (vote) {
          precommits.push({
            validator: id,
            vote: 'yes',
            votingPower: validator.votingPower,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        appLogger.warn('Precommit failed from validator', { module: 'ConsensusStabilizer', validatorId: id, error: error.message });
      }
    }

    return precommits;
  }

  // Check if votes have supermajority (2/3+)
  hasSupermajority(votes) {
    const totalVotingPower = Array.from(this.validatorNodes.values())
      .filter(v => v.isActive)
      .reduce((sum, v) => sum + v.votingPower, 0);

    const votedPower = votes.reduce((sum, vote) => sum + vote.votingPower, 0);

    return votedPower >= (totalVotingPower * 2) / 3;
  }

  // Simulate validator vote (replace with actual network calls)
  async simulateValidatorVote(validator, proposal, voteType) {
    // Simulate network latency and occasional failures
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100));

    // Simulate 5% failure rate for network issues
    if (Math.random() < 0.05) {
      throw new Error('Network timeout');
    }

    // Validate proposal (simplified)
    if (!proposal.hash || !proposal.proposer) {
      return false;
    }

    return true;
  }

  // Commit block to blockchain
  async commitBlock(proposal) {
    appLogger.info('Committing block', { module: 'ConsensusStabilizer', height: proposal.height, proposer: proposal.proposer });

    // Update validator performance metrics
    this.updateValidatorPerformance();

    // Select next proposer
    this.selectProposer();
  }

  // Handle consensus timeout
  handleConsensusTimeout(roundId) {
    appLogger.warn('Consensus timeout for round', { module: 'ConsensusStabilizer', roundId });

    // Select new proposer for next round
    this.selectProposer();

    // Check for network partition
    const activeValidators = Array.from(this.validatorNodes.values()).filter(
      v => v.isActive
    ).length;

    if (activeValidators < this.networkState.validators * 0.67) {
      this.stabilityMetrics.networkPartitions++;
      appLogger.error('Potential network partition detected', { module: 'ConsensusStabilizer', activeValidators, totalValidators: this.networkState.validators });
    }
  }

  // Update validator performance metrics
  updateValidatorPerformance() {
    this.validatorNodes.forEach(validator => {
      // Update uptime based on participation
      validator.performance.uptime = Math.max(
        0.8,
        validator.performance.uptime + (Math.random() - 0.3) * 0.01
      );

      // Update response time
      validator.performance.responseTime = Math.max(
        10,
        validator.performance.responseTime + (Math.random() - 0.5) * 5
      );

      validator.lastSeen = new Date();
    });
  }

  // Generate block hash (simplified)
  generateBlockHash(blockData) {
    const dataString = JSON.stringify(blockData) + Date.now();
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  // Get consensus status
  getConsensusStatus() {
    const recentRounds = this.consensusRounds.slice(-10);
    const successRate =
      recentRounds.length > 0
        ? (
            (recentRounds.filter(r => r.status === 'committed').length /
              recentRounds.length) *
            100
          ).toFixed(1)
        : 0;

    return {
      height: this.networkState.height,
      validators: this.networkState.validators,
      activeValidators: Array.from(this.validatorNodes.values()).filter(
        v => v.isActive
      ).length,
      proposer: this.networkState.proposer,
      lastBlockTime: this.networkState.lastBlockTime,
      successRate: successRate + '%',
      metrics: this.stabilityMetrics,
      recentRounds: recentRounds.map(r => ({
        height: r.height,
        duration: r.duration + 'ms',
        status: r.status,
        validators: r.validators,
      })),
    };
  }

  // Health check
  healthCheck() {
    const activeValidators = Array.from(this.validatorNodes.values()).filter(
      v => v.isActive
    ).length;
    const isHealthy =
      activeValidators >= Math.ceil(this.networkState.validators * 0.67);

    return {
      status: isHealthy ? 'healthy' : 'degraded',
      activeValidators,
      totalValidators: this.networkState.validators,
      lastBlock: this.networkState.lastBlockTime,
      metrics: this.stabilityMetrics,
    };
  }
}

module.exports = ConsensusStabilizer;
