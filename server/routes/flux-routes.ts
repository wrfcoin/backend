/**
 * Flux (RunOnFlux) Integration API Routes
 *
 * This module defines the API endpoints for interacting with the
 * Flux decentralized cloud infrastructure integration.
 */

import express, { Router } from 'express';
import * as fluxController from '../controllers/fluxController.js';
import type { Request, Response } from 'express';

const router: Router = express.Router();

// Get Flux network status
router.get('/status', fluxController.getStatus);

// Create a new deployment
router.post('/deploy', fluxController.deployApplication);

// Get deployment by ID
router.get('/deployments/:id', fluxController.getDeployment);

// Start a stopped deployment
router.post('/deployments/:id/start', fluxController.startDeployment);

// Stop a running deployment
router.post('/deployments/:id/stop', fluxController.stopDeployment);

export default router;
