/**
 * Multi-Stage Node Validation Middleware
 * Orchestrates the complete node validation process
 */

import { Request, Response, NextFunction } from 'express';
import { NodeCapabilityVerification } from '../../shared/node-validation.js';
import { NodeIdentityVerification } from '../../shared/node-identity.js';
import { NodeStakingManager } from '../../shared/node-staking.js';
import { NodeBehaviorMonitor } from '../../shared/node-monitoring.js';

interface ValidatedNodeRequest extends Request {
  nodeId?: string;
  nodeVerified?: boolean;
  validationStage?: string;
}

export class NodeValidationMiddleware {
  private capabilityVerifier: NodeCapabilityVerification;
  private identityVerifier: NodeIdentityVerification;
  private stakingManager: NodeStakingManager;
  private behaviorMonitor: NodeBehaviorMonitor;

  constructor() {
    this.capabilityVerifier = new NodeCapabilityVerification();
    this.identityVerifier = new NodeIdentityVerification();
    this.stakingManager = new NodeStakingManager();
    this.behaviorMonitor = new NodeBehaviorMonitor();
  }

  /**
   * Stage 1: Verify node capabilities
   */
  verifyCapabilities = async (
    req: ValidatedNodeRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { nodeId, challengeId, capabilities, solution, computationTime } =
        req.body;

      const result = await this.capabilityVerifier.verifyNodeCapabilities(
        nodeId,
        challengeId,
        capabilities,
        solution,
        computationTime
      );

      if (!result.verified) {
        return res.status(403).json({
          success: false,
          error: 'Node capability verification failed',
          reason: result.reason,
        });
      }

      req.nodeId = nodeId;
      req.validationStage = 'capabilities_verified';
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Capability verification error',
        message: (error as Error).message,
      });
    }
  };

  /**
   * Stage 2: Verify node identity (PKI)
   */
  verifyIdentity = async (
    req: ValidatedNodeRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { nodeId, certificate, certificateChain, challenge, signature } =
        req.body;

      const authResult = await this.identityVerifier.authenticateNode(
        nodeId,
        challenge,
        signature,
        certificate
      );

      if (!authResult.authenticated) {
        return res.status(403).json({
          success: false,
          error: 'Node identity verification failed',
          reason: authResult.reason,
        });
      }

      req.validationStage = 'identity_verified';
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Identity verification error',
        message: (error as Error).message,
      });
    }
  };

  /**
   * Stage 3: Verify economic stake
   */
  verifyStake = async (
    req: ValidatedNodeRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { nodeId } = req;
      if (!nodeId) {
        return res.status(400).json({
          success: false,
          error: 'Node ID required',
        });
      }

      const votingPower = this.stakingManager.getVotingPower(nodeId);
      if (votingPower === 0) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient stake for consensus participation',
        });
      }

      req.validationStage = 'stake_verified';
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Stake verification error',
        message: (error as Error).message,
      });
    }
  };

  /**
   * Stage 4: Check node reputation
   */
  checkReputation = async (
    req: ValidatedNodeRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { nodeId } = req;
      if (!nodeId) {
        return res.status(400).json({
          success: false,
          error: 'Node ID required',
        });
      }

      const reputation = this.behaviorMonitor.getReputation(nodeId);
      if (!reputation || reputation.trustLevel === 'untrusted') {
        return res.status(403).json({
          success: false,
          error: 'Node reputation insufficient for consensus',
        });
      }

      req.nodeVerified = true;
      req.validationStage = 'fully_validated';
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Reputation check error',
        message: (error as Error).message,
      });
    }
  };

  /**
   * Complete validation chain
   */
  validateNode = [
    this.verifyCapabilities,
    this.verifyIdentity,
    this.verifyStake,
    this.checkReputation,
  ];
}

export const nodeValidation = new NodeValidationMiddleware();
