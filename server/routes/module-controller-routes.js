/**
 * Module Controller Routes
 *
 * This file defines Express routes for module controller functionality,
 * including configuration profile management.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const moduleController = require('../../utils/module_controller');
const logger = require('../utils/logger');
const {
  nodeControlRateLimiter,
  verifyNodeControlAuth,
} = require('../middleware/rpcAuthMiddleware');

// Module control is an operator-only surface: it restarts workflows, enables/
// disables categories and modules, and writes config profiles to disk. Gate
// the ENTIRE family behind the same node-control rate limiter + auth used by
// node-control-routes.js / node-os-routes.js / key-manager-routes.js. Without
// this, a public-testnet deployment (0.0.0.0 bind) exposes remote restart/
// disable/config-write to any anonymous client. See #899.
router.use(nodeControlRateLimiter);
router.use(verifyNodeControlAuth);

/**
 * @route   GET /api/modules/categories
 * @desc    Get all workflow categories with their status
 * @access  Operator (node-control auth)
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = await moduleController.getWorkflowCategories();
    res.json({ success: true, data: categories });
  } catch (error) {
    logger.error('Error getting workflow categories:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/categories/:category/enable
 * @desc    Enable all workflows in a specific category
 * @access  Public
 */
router.post('/categories/:category/enable', async (req, res) => {
  try {
    const { category } = req.params;
    await moduleController.enableCategory(category);
    res.json({
      success: true,
      message: `Category ${category} enabled successfully`,
    });
  } catch (error) {
    logger.error(`Error enabling category ${req.params.category}:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/categories/:category/disable
 * @desc    Disable all workflows in a specific category
 * @access  Public
 */
router.post('/categories/:category/disable', async (req, res) => {
  try {
    const { category } = req.params;
    await moduleController.disableCategory(category);
    res.json({
      success: true,
      message: `Category ${category} disabled successfully`,
    });
  } catch (error) {
    logger.error(`Error disabling category ${req.params.category}:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/modules/profiles
 * @desc    Get all configuration profiles
 * @access  Public
 */
router.get('/profiles', async (req, res) => {
  try {
    const profiles = await moduleController.getConfigProfiles();
    res.json({ success: true, data: profiles });
  } catch (error) {
    logger.error('Error getting configuration profiles:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/profiles/:name
 * @desc    Load a configuration profile
 * @access  Public
 */
router.post('/profiles/:name', async (req, res) => {
  try {
    const { name } = req.params;
    await moduleController.loadConfigProfile(name);
    res.json({ success: true, message: `Profile ${name} loaded successfully` });
  } catch (error) {
    logger.error(`Error loading configuration profile ${req.params.name}:`, { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/profiles
 * @desc    Save current configuration as a profile
 * @access  Public
 */
router.post('/profiles', async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: 'Profile name is required' });
    }

    await moduleController.saveConfigProfile(name, description || '');
    res.json({ success: true, message: `Profile ${name} saved successfully` });
  } catch (error) {
    logger.error('Error saving configuration profile:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/modules/workflows
 * @desc    Get all workflows with their status
 * @access  Public
 */
router.get('/workflows', async (req, res) => {
  try {
    const workflows = await moduleController.getWorkflowStatuses();
    res.json({ success: true, data: workflows });
  } catch (error) {
    logger.error('Error getting workflow statuses:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/restart
 * @desc    Restart all workflows based on current configuration
 * @access  Public
 */
router.post('/restart', async (req, res) => {
  try {
    await moduleController.restartWorkflows();
    res.json({ success: true, message: 'Workflows restarted successfully' });
  } catch (error) {
    logger.error('Error restarting workflows:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/:module/enable
 * @desc    Enable a specific module
 * @access  Public
 */
router.post('/:module/enable', async (req, res) => {
  try {
    const { module } = req.params;
    await moduleController.enableModule(module);
    res.json({
      success: true,
      message: `Module ${module} enabled successfully`,
    });
  } catch (error) {
    logger.error(`Error enabling module ${req.params.module}:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   POST /api/modules/:module/disable
 * @desc    Disable a specific module
 * @access  Public
 */
router.post('/:module/disable', async (req, res) => {
  try {
    const { module } = req.params;
    await moduleController.disableModule(module);
    res.json({
      success: true,
      message: `Module ${module} disabled successfully`,
    });
  } catch (error) {
    logger.error(`Error disabling module ${req.params.module}:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/modules/:module/dependencies
 * @desc    Get dependencies and dependent modules for a specific module
 * @access  Public
 */
router.get('/:module/dependencies', async (req, res) => {
  try {
    const { module } = req.params;
    const { dependencies, dependents } =
      await moduleController.getModuleDependencies(module);
    res.json({
      success: true,
      dependencies,
      dependents,
    });
  } catch (error) {
    logger.error(
      `Error getting dependencies for module ${req.params.module}:`,
      error
    );
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * @route   GET /api/modules
 * @desc    Get all modules with their status
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const modules = await moduleController.getModuleStatuses();
    res.json({ success: true, data: modules });
  } catch (error) {
    logger.error('Error getting module statuses:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
