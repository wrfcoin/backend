/**
 * Proof of Publishing (PoP) API Routes — LOCAL SIMULATOR, NOT CANONICAL CONSENSUS
 *
 * !!! IMPORTANT !!!
 * This module is a self-contained, in-memory PoP simulator (backed by
 * `server/consensus/pop/controller.js`). It does NOT talk to core4's real
 * consensus engine, does NOT move real WRF tokens, and every "reward" it
 * reports is a fixed, fabricated test value (50 WRF per submission, 10 WRF
 * per validation — see `REWARD_TYPES` in controller.js). Treat everything
 * this router returns as local-dev/demo data only.
 *
 * As of 2026-09 this router is not mounted anywhere in
 * `server/enhanced_unified_api_optimized.ts`, so none of it is reachable in
 * production. If it is ever wired up, every response below carries a
 * `_simulation: true` marker plus an explanatory `_simulationNote` so an API
 * consumer can tell it apart from core4's real PoP consensus without reading
 * source. See backend#1124 for the audit that added these markers.
 *
 * This module defines the API routes for interacting with the local PoP
 * simulator, including submission of environmental data, validation,
 * and retrieving simulated consensus status.
 */

import express, { Request, Response, Router } from 'express';
import { storage } from '../storage.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PopConsensusController = require('../consensus/pop/controller');
import { appLogger } from '../utils/logger.js';

// Create router
const router: Router = express.Router();

// Initialize PoP controller
const popController = new PopConsensusController(storage);

const POP_SIMULATION_NOTE =
  "This is a local, in-memory PoP simulator (server/consensus/pop/controller.js), " +
  "not core4's real Proof-of-Publishing consensus. Rewards shown here are fixed, " +
  "fabricated test values, not real WRF token transfers.";

/**
 * Every response from this router is local-simulation data, not canonical
 * consensus output — see the module header above. Stamp that onto the
 * response body rather than relying on a reader having seen the source.
 */
function withSimulationNotice<T extends Record<string, unknown>>(
  payload: T
): T & { _simulation: true; _simulationNote: string } {
  return { ...payload, _simulation: true, _simulationNote: POP_SIMULATION_NOTE };
}

/**
 * @api {post} /api/pop/submit Submit environmental data
 * @apiName SubmitEnvironmentalData
 * @apiGroup PoP
 * @apiDescription Submit environmental data for validation and consensus
 *
 * @apiParam {String} submitterId ID of the submitter
 * @apiParam {String} dataType Type of environmental data
 * @apiParam {Object} location Location data (latitude, longitude)
 * @apiParam {Array} measurements Array of measurement objects
 * @apiParam {Object} metadata Additional metadata
 *
 * @apiSuccess {Object} submission Created submission
 */
router.post('/submit', async (req, res) => {
  try {
    const submissionData = req.body;

    if (!submissionData.dataType) {
      return res
        .status(400)
        .json({ error: 'Missing required field: dataType' });
    }

    if (
      !submissionData.measurements ||
      !Array.isArray(submissionData.measurements)
    ) {
      return res
        .status(400)
        .json({
          error: 'Missing or invalid field: measurements must be an array',
        });
    }

    if (!submissionData.location) {
      return res
        .status(400)
        .json({ error: 'Missing required field: location' });
    }

    // Create the submission using the PopController's createSubmission method
    const popSubmission = await popController.createSubmission(submissionData);

    res.status(201).json(withSimulationNotice({
      success: true,
      submission: popSubmission,
      message: `Environmental data submission ${popSubmission.submissionId} created and pending validation`,
    }));
  } catch (error) {
    appLogger.error('Error submitting environmental data', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to process environmental data submission',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {get} /api/pop/submissions/:submissionId Get submission details
 * @apiName GetSubmissionDetails
 * @apiGroup PoP
 * @apiDescription Get details of a specific environmental data submission
 *
 * @apiParam {String} submissionId ID of the submission
 *
 * @apiSuccess {Object} submission Submission details
 */
router.get('/submissions/:submissionId', async (req, res) => {
  try {
    const { submissionId } = req.params;

    const submission = await storage.getSubmissionById(submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Get attestations for this submission
    const attestations =
      await storage.getAttestationsForSubmission(submissionId);

    // Get rewards for this submission
    const rewards = await storage.getRewardsForSubmission(submissionId);

    res.json(withSimulationNotice({
      success: true,
      submission,
      attestations,
      rewards,
      validationProgress: {
        attestationsCount: attestations.length,
        positiveCount: attestations.filter(a => a.validationResult).length,
        negativeCount: attestations.filter(a => !a.validationResult).length,
      },
    }));
  } catch (error) {
    appLogger.error('Error getting submission details', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to get submission details',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {get} /api/pop/submissions Get recent submissions
 * @apiName GetRecentSubmissions
 * @apiGroup PoP
 * @apiDescription Get list of recent environmental data submissions
 *
 * @apiParam {Number} [limit=50] Maximum number of submissions to return
 * @apiParam {String} [dataType] Filter by data type
 *
 * @apiSuccess {Array} submissions List of submissions
 */
router.get('/submissions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const dataType = req.query.dataType as string;

    const submissions = await storage.getRecentSubmissions(limit, dataType);

    res.json(withSimulationNotice({
      success: true,
      count: submissions.length,
      submissions,
    }));
  } catch (error) {
    appLogger.error('Error getting recent submissions', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to get recent submissions',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {post} /api/pop/validate/:submissionId Submit validation attestation
 * @apiName SubmitValidationAttestation
 * @apiGroup PoP
 * @apiDescription Submit a validation attestation for an environmental data submission
 *
 * @apiParam {String} submissionId ID of the submission
 * @apiParam {String} validatorId ID of the validator
 * @apiParam {Boolean} validationResult Result of validation
 * @apiParam {Number} confidenceScore Confidence score (0-1)
 * @apiParam {String} attestationMethod Method used for attestation
 * @apiParam {Object} metadata Additional metadata
 *
 * @apiSuccess {Object} attestation Created attestation
 */
router.post('/validate/:submissionId', async (req, res) => {
  try {
    const { submissionId } = req.params;
    const attestationData = req.body;

    if (!attestationData.validatorId) {
      return res
        .status(400)
        .json({ error: 'Missing required field: validatorId' });
    }

    if (typeof attestationData.validationResult !== 'boolean') {
      return res
        .status(400)
        .json({
          error: 'Missing or invalid field: validationResult must be a boolean',
        });
    }

    // Check if the submission exists
    const submission = await storage.getSubmissionById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Process attestation
    attestationData.dataSubmissionId = submission.id;
    const attestation =
      await (popController as any).addValidation(submissionId, attestationData);

    res.status(201).json(withSimulationNotice({
      success: true,
      attestation,
      message: `Validation attestation processed for submission ${submissionId}`,
    }));
  } catch (error) {
    appLogger.error('Error processing validation attestation', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to process validation attestation',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {get} /api/pop/reference/:dataType Get reference data sources
 * @apiName GetReferenceDataSources
 * @apiGroup PoP
 * @apiDescription Get reference data sources for validating a specific type of environmental data
 *
 * @apiParam {String} dataType Type of data to get reference sources for
 *
 * @apiSuccess {Array} sources List of reference data sources
 */
router.get('/reference/:dataType', async (req, res) => {
  try {
    const { dataType } = req.params;

    // Reference data sources are defined per data type in the PoP configuration.
    // Returns empty until data-type-specific reference feeds are onboarded.
    const sources: Array<{ name: string; url: string; type: string }> = [];

    res.json(withSimulationNotice({
      success: true,
      count: sources.length,
      sources,
    }));
  } catch (error) {
    appLogger.error('Error getting reference data sources', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to get reference data sources',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {post} /api/pop/finalize/:submissionId Finalize validation process
 * @apiName FinalizeValidation
 * @apiGroup PoP
 * @apiDescription Finalize the validation process for a submission
 *
 * @apiParam {String} submissionId ID of the submission to finalize
 *
 * @apiSuccess {Object} result Finalization result
 */
router.post('/finalize/:submissionId', async (req, res) => {
  try {
    const { submissionId } = req.params;

    // Check if the submission exists
    const submission = await storage.getSubmissionById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Finalize validation
    await popController.finalizeValidation(submissionId);

    // Get the updated submission
    const updatedSubmission = await storage.getSubmissionById(submissionId);

    // Get rewards
    const rewards = await storage.getRewardsForSubmission(submissionId);

    res.json(withSimulationNotice({
      success: true,
      submission: updatedSubmission,
      validationState: updatedSubmission.validationState,
      rewards,
      message: `Validation finalized for submission ${submissionId}`,
    }));
  } catch (error) {
    appLogger.error('Error finalizing validation', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to finalize validation',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {get} /api/pop/rewards/:submissionId Get rewards for submission
 * @apiName GetSubmissionRewards
 * @apiGroup PoP
 * @apiDescription Get rewards distributed for a specific submission
 *
 * @apiParam {String} submissionId ID of the submission
 *
 * @apiSuccess {Array} rewards List of rewards
 */
router.get('/rewards/:submissionId', async (req, res) => {
  try {
    const { submissionId } = req.params;

    // Check if the submission exists
    const submission = await storage.getSubmissionById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Get rewards for this submission
    const rewards = await storage.getRewardsForSubmission(submissionId);

    res.json(withSimulationNotice({
      success: true,
      submissionId,
      count: rewards.length,
      rewards,
      totalAmount: rewards.reduce((sum, reward) => sum + reward.amount, 0),
    }));
  } catch (error) {
    appLogger.error('Error getting rewards', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to get rewards',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {get} /api/pop/stats Get PoP consensus statistics
 * @apiName GetPopStats
 * @apiGroup PoP
 * @apiDescription Get statistics about the Proof of Publishing consensus mechanism
 *
 * @apiSuccess {Object} stats PoP statistics
 */
router.get('/stats', async (req, res) => {
  try {
    // Get recent submissions
    const submissions = await storage.getRecentSubmissions(1000);

    // Calculate statistics
    const validatedCount = submissions.filter(
      s => s.validationState === 'VALIDATED'
    ).length;
    const rejectedCount = submissions.filter(
      s => s.validationState === 'REJECTED'
    ).length;
    const pendingCount = submissions.filter(
      s => s.validationState === 'PENDING' || s.validationState === 'VALIDATING'
    ).length;

    // Group by data type
    const dataTypeStats = {};
    submissions.forEach(s => {
      if (!dataTypeStats[s.dataType]) {
        dataTypeStats[s.dataType] = {
          count: 0,
          validated: 0,
          rejected: 0,
          pending: 0,
        };
      }

      dataTypeStats[s.dataType].count++;

      if (s.validationState === 'VALIDATED') {
        dataTypeStats[s.dataType].validated++;
      } else if (s.validationState === 'REJECTED') {
        dataTypeStats[s.dataType].rejected++;
      } else {
        dataTypeStats[s.dataType].pending++;
      }
    });

    res.json(withSimulationNotice({
      success: true,
      stats: {
        totalSubmissions: submissions.length,
        validatedSubmissions: validatedCount,
        rejectedSubmissions: rejectedCount,
        pendingSubmissions: pendingCount,
        validationRate:
          submissions.length > 0 ? validatedCount / submissions.length : 0,
        rejectionRate:
          submissions.length > 0 ? rejectedCount / submissions.length : 0,
        dataTypeBreakdown: dataTypeStats,
      },
    }));
  } catch (error) {
    appLogger.error('Error getting PoP stats', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res
      .status(500)
      .json({
        error: 'Failed to get PoP statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
  }
});

/**
 * @api {post} /api/pop/iot/submit Submit IoT device environmental data
 * @apiName SubmitIoTEnvironmentalData
 * @apiGroup PoP
 * @apiDescription Submit IoT device environmental data for validation and consensus
 *
 * @apiParam {String} submissionId Optional unique ID for the submission
 * @apiParam {String} dataType Type of environmental data (e.g., WEATHER, AIR_QUALITY)
 * @apiParam {String} deviceType Type of IoT device (e.g., WEATHER_STATION)
 * @apiParam {String} deviceId Unique identifier for the IoT device
 * @apiParam {Number} sensorAccuracy Accuracy of the device's sensors (0-1)
 * @apiParam {Number} batteryLevel Current battery level of the device (0-100)
 * @apiParam {Number} signalStrength Signal strength of the device (0-5)
 * @apiParam {Object} measurements Measurement data collected by the device
 * @apiParam {Object} location Location data (latitude, longitude)
 *
 * @apiSuccess {Object} submission Created submission
 */
router.post('/iot/submit', async (req, res) => {
  try {
    const submissionData = req.body;

    if (!submissionData.dataType) {
      return res
        .status(400)
        .json({ error: 'Missing required field: dataType' });
    }

    if (!submissionData.deviceType) {
      return res
        .status(400)
        .json({ error: 'Missing required field: deviceType' });
    }

    if (!submissionData.deviceId) {
      return res
        .status(400)
        .json({ error: 'Missing required field: deviceId' });
    }

    if (!submissionData.measurements) {
      return res
        .status(400)
        .json({ error: 'Missing required field: measurements' });
    }

    // Use the storage interface's submitEnvironmentalData method
    const submission = await storage.submitEnvironmentalData(submissionData);

    // If submission was successful, also create a PoP entry via the controller
    try {
      // Format data for the PoP controller if needed
      const popSubmissionData = {
        ...submissionData,
        submitterId:
          submissionData.submitterId || `device-${submissionData.deviceId}`,
      };

      // Create a PoP submission record
      const popSubmission =
        await popController.createSubmission(popSubmissionData);

      // Return both the storage submission and PoP submission
      res.status(201).json(withSimulationNotice({
        success: true,
        submission: submission,
        popSubmission: popSubmission,
        message: `IoT device data submission ${submission.submissionId} created and pending validation`,
      }));
    } catch (popError) {
      appLogger.warn('IoT submission saved but PoP controller submission failed', { error: popError instanceof Error ? popError.message : 'Unknown error' });

      // Still return success since the primary storage submission worked
      res.status(201).json(withSimulationNotice({
        success: true,
        submission: submission,
        message: `IoT device data submission ${submission.submissionId} created but PoP validation not initialized`,
      }));
    }
  } catch (error) {
    appLogger.error('Error submitting IoT environmental data', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    res.status(500).json({
      error: 'Failed to process IoT environmental data submission',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
