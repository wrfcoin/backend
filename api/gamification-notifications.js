/**
 * Gamification Notifications Service
 * Real-time achievement and level-up notifications
 */

const express = require('express');
const WebSocket = require('ws');
const { gamificationService } = require('../services/gamification-service');
const { websocketLogger } = require('../server/utils/logger');

const router = express.Router();

// WebSocket server for real-time notifications
const wss = new WebSocket.Server({ port: 8080 });
const connectedClients = new Map();

wss.on('connection', (ws, req) => {
  websocketLogger.info('Client connected to gamification notifications', { service: 'gamification-notifications' });

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe' && data.userAddress) {
        connectedClients.set(data.userAddress, ws);
        websocketLogger.info('User subscribed to notifications', { service: 'gamification-notifications', userAddress: data.userAddress });
      }
    } catch (error) {
      websocketLogger.error('Error processing WebSocket message', { service: 'gamification-notifications', error: error.message });
    }
  });

  ws.on('close', () => {
    // Remove client from connected clients
    for (const [userAddress, client] of connectedClients) {
      if (client === ws) {
        connectedClients.delete(userAddress);
        break;
      }
    }
  });
});

// Listen to gamification service events
gamificationService.on('achievement_unlocked', data => {
  const { userAddress, achievement } = data;
  const client = connectedClients.get(userAddress);

  if (client && client.readyState === WebSocket.OPEN) {
    client.send(
      JSON.stringify({
        type: 'achievement_unlocked',
        achievement,
        timestamp: new Date().toISOString(),
      })
    );
  }
});

gamificationService.on('level_up', data => {
  const { userAddress, oldLevel, newLevel, totalPoints } = data;
  const client = connectedClients.get(userAddress);

  if (client && client.readyState === WebSocket.OPEN) {
    client.send(
      JSON.stringify({
        type: 'level_up',
        oldLevel,
        newLevel,
        totalPoints,
        timestamp: new Date().toISOString(),
      })
    );
  }
});

// Get notification preferences
router.get('/preferences/:userAddress', (req, res) => {
  const { userAddress } = req.params;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }

  // In a real implementation, this would be stored in a database
  const defaultPreferences = {
    achievements: true,
    levelUps: true,
    streakMilestones: true,
    leaderboardChanges: false,
    weeklyDigest: true,
    email: false,
    push: true,
    inApp: true,
  };

  res.json({
    success: true,
    data: defaultPreferences,
  });
});

// Update notification preferences
router.put('/preferences/:userAddress', (req, res) => {
  const { userAddress } = req.params;
  const preferences = req.body;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }
  if (typeof preferences !== 'object' || preferences === null || Array.isArray(preferences)) {
    return res.status(400).json({
      success: false,
      error: 'Request body must be an object containing preferences',
    });
  }
  // Validate preference fields
  const booleanFields = ['achievements', 'levelUps', 'streakMilestones', 'leaderboardChanges', 'weeklyDigest', 'email', 'push', 'inApp'];
  for (const field of booleanFields) {
    if (preferences[field] !== undefined && typeof preferences[field] !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: `${field} must be a boolean`,
      });
    }
  }

  // In a real implementation, this would be saved to a database
  websocketLogger.info('Updated notification preferences', { service: 'gamification-notifications', userAddress, preferences });

  res.json({
    success: true,
    data: preferences,
    message: 'Notification preferences updated',
  });
});

// Send test notification
router.post('/test/:userAddress', (req, res) => {
  const { userAddress } = req.params;
  const { type = 'achievement_unlocked' } = req.body;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }
  const validTypes = ['achievement_unlocked', 'level_up', 'streak_milestone', 'leaderboard_change'];
  if (typeof type !== 'string' || !validTypes.includes(type)) {
    return res.status(400).json({
      success: false,
      error: `type must be one of: ${validTypes.join(', ')}`,
    });
  }

  const client = connectedClients.get(userAddress);

  if (client && client.readyState === WebSocket.OPEN) {
    const testNotification = {
      type,
      achievement: {
        id: 'test_achievement',
        name: 'Test Achievement',
        description: 'This is a test notification',
        icon: '🧪',
        rarity: 'common',
        points: 10,
      },
      timestamp: new Date().toISOString(),
    };

    client.send(JSON.stringify(testNotification));

    res.json({
      success: true,
      message: 'Test notification sent',
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'User not connected',
    });
  }
});

// Get notification history
router.get('/history/:userAddress', (req, res) => {
  const { userAddress } = req.params;
  const { limit = 20 } = req.query;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }
  const parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return res.status(400).json({
      success: false,
      error: 'limit must be a number between 1 and 100',
    });
  }

  // Mock notification history
  const notifications = [
    {
      id: 'notif_1',
      type: 'achievement_unlocked',
      achievement: {
        name: 'Democracy Begins',
        icon: '🗳️',
        rarity: 'common',
      },
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      read: false,
    },
    {
      id: 'notif_2',
      type: 'level_up',
      oldLevel: { level: 2, name: 'Advocate' },
      newLevel: { level: 3, name: 'Delegate' },
      timestamp: new Date(Date.now() - 7200000).toISOString(),
      read: true,
    },
  ];

  res.json({
    success: true,
    data: notifications.slice(0, parseInt(limit, 10)),
    unreadCount: notifications.filter(n => !n.read).length,
  });
});

// Mark notifications as read
router.post('/read/:userAddress', (req, res) => {
  const { userAddress } = req.params;
  const { notificationIds } = req.body;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'notificationIds must be a non-empty array',
    });
  }
  for (const id of notificationIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Each notificationId must be a non-empty string under 100 chars',
      });
    }
  }

  // In a real implementation, this would update the database
  websocketLogger.info('Marked notifications as read', { service: 'gamification-notifications', userAddress, notificationIds });

  res.json({
    success: true,
    message: 'Notifications marked as read',
  });
});

// Get WebSocket connection status
router.get('/status/:userAddress', (req, res) => {
  const { userAddress } = req.params;

  // Input validation
  if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return res.status(400).json({
      success: false,
      error: 'userAddress must be a valid Ethereum address',
    });
  }

  const isConnected = connectedClients.has(userAddress);

  res.json({
    success: true,
    data: {
      connected: isConnected,
      totalConnections: connectedClients.size,
      userAddress,
    },
  });
});

module.exports = router;
