/**
 * BigchainDB API Routes for Wrfcoin
 *
 * Provides API endpoints for interacting with BigchainDB functionality.
 */

import express, { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
const router: Router = express.Router();
import * as bigchaindbController from '../controllers/bigchaindbController.js';

// All BigchainDB operations require authentication (#231)
router.use(authenticateJWT);

/**
 * @api {get} /api/bigchaindb/status Get BigchainDB integration status
 * @apiName GetBigchainDBStatus
 * @apiGroup BigchainDB
 * @apiDescription Get the current status of BigchainDB integration
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {String} status Status of the BigchainDB integration
 * @apiSuccess {String} version Version of the BigchainDB integration
 * @apiSuccess {Array} features List of supported features
 */
router.get('/status', bigchaindbController.getStatus);

/**
 * @api {post} /api/bigchaindb/assets Create a new digital asset
 * @apiName CreateAsset
 * @apiGroup BigchainDB
 * @apiDescription Create a new digital asset with initial ownership
 *
 * @apiParam {Object} assetData Core data of the asset
 * @apiParam {Object} [metadata] Metadata associated with the asset
 * @apiParam {String} ownerId ID of the initial owner
 * @apiParam {String} [publicKey] Public key for verification
 * @apiParam {String} [signature] Cryptographic signature
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} asset Created asset info
 */
router.post('/assets', bigchaindbController.createAsset);

/**
 * @api {post} /api/bigchaindb/computational-assets Create a new computational asset
 * @apiName CreateComputationalAsset
 * @apiGroup BigchainDB
 * @apiDescription Create a new computational asset (specialized for weather/climate data)
 *
 * @apiParam {Object} computationalData Computational asset data
 * @apiParam {Object} [metadata] Metadata for the computational asset
 * @apiParam {String} ownerId ID of the initial owner
 * @apiParam {String} [publicKey] Public key for verification
 * @apiParam {String} [signature] Cryptographic signature
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} asset Created computational asset info
 */
router.post(
  '/computational-assets',
  bigchaindbController.createComputationalAsset
);

/**
 * @api {get} /api/bigchaindb/assets/:assetId Get asset by ID
 * @apiName GetAsset
 * @apiGroup BigchainDB
 * @apiDescription Get asset by ID
 *
 * @apiParam {String} assetId Asset ID
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} asset Asset data
 */
router.get('/assets/:assetId', bigchaindbController.getAsset);

/**
 * @api {post} /api/bigchaindb/assets/search Search assets
 * @apiName SearchAssets
 * @apiGroup BigchainDB
 * @apiDescription Search for assets based on data or metadata
 *
 * @apiParam {Object} [query] Query parameters
 * @apiParam {Number} [limit=10] Maximum number of results
 * @apiParam {Number} [offset=0] Number of results to skip
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Number} count Number of assets found
 * @apiSuccess {Array} assets Matching assets
 */
router.post('/assets/search', bigchaindbController.searchAssets);

/**
 * @api {get} /api/bigchaindb/owners/:ownerId/assets Get assets by owner
 * @apiName GetAssetsByOwner
 * @apiGroup BigchainDB
 * @apiDescription Get assets owned by a specific user
 *
 * @apiParam {String} ownerId Owner ID
 * @apiParam {Number} [limit=10] Maximum number of results
 * @apiParam {Number} [offset=0] Number of results to skip
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Number} count Number of assets found
 * @apiSuccess {Array} assets Assets owned by the user
 */
router.get('/owners/:ownerId/assets', bigchaindbController.getAssetsByOwner);

/**
 * @api {post} /api/bigchaindb/assets/transfer Transfer asset ownership
 * @apiName TransferAsset
 * @apiGroup BigchainDB
 * @apiDescription Transfer ownership of an asset
 *
 * @apiParam {String} assetId ID of the asset to transfer
 * @apiParam {String} currentOwnerId ID of the current owner
 * @apiParam {String} newOwnerId ID of the new owner
 * @apiParam {Object} [metadata] Metadata for the transfer
 * @apiParam {String} [publicKey] Public key for verification
 * @apiParam {String} [signature] Cryptographic signature
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} transaction Transfer transaction info
 */
router.post('/assets/transfer', bigchaindbController.transferAsset);

/**
 * @api {post} /api/bigchaindb/assets/metadata Update asset metadata
 * @apiName UpdateAssetMetadata
 * @apiGroup BigchainDB
 * @apiDescription Update asset metadata without changing ownership
 *
 * @apiParam {String} assetId ID of the asset to update
 * @apiParam {String} ownerId ID of the current owner
 * @apiParam {Object} metadata New metadata for the asset
 * @apiParam {String} [publicKey] Public key for verification
 * @apiParam {String} [signature] Cryptographic signature
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} transaction Updated asset info
 */
router.post('/assets/metadata', bigchaindbController.updateAssetMetadata);

/**
 * @api {post} /api/bigchaindb/shared-assets Create a shared ownership asset
 * @apiName CreateSharedAsset
 * @apiGroup BigchainDB
 * @apiDescription Create a shared ownership asset
 *
 * @apiParam {Object} assetData Core data of the asset
 * @apiParam {Object} [metadata] Metadata associated with the asset
 * @apiParam {Array} owners Array of {ownerId, shares} objects
 * @apiParam {String} [publicKey] Public key for verification
 * @apiParam {String} [signature] Cryptographic signature
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} asset Created asset info
 */
router.post('/shared-assets', bigchaindbController.createSharedAsset);

/**
 * @api {get} /api/bigchaindb/key-pair Generate a cryptographic key pair
 * @apiName GenerateKeyPair
 * @apiGroup BigchainDB
 * @apiDescription Generate a cryptographic key pair for signing and verification
 *
 * @apiSuccess {Boolean} success Request success status
 * @apiSuccess {Object} keyPair Generated key pair
 */
router.get('/key-pair', bigchaindbController.generateKeyPair);

export default router;
