/**
 * Governance Notifications Service
 * Implements Task 3.5 from Feature Completion Roadmap
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const { governanceLogger } = require('../server/utils/logger');

class GovernanceNotificationService extends EventEmitter {
  constructor() {
    super();
    this.subscribers = new Map();
    this.notificationQueue = [];
    this.preferences = new Map();
    this.channels = {
      email: new EmailChannel(),
      push: new PushNotificationChannel(),
      websocket: new WebSocketChannel(),
      discord: new DiscordChannel(),
      telegram: new TelegramChannel(),
    };

    this.startNotificationProcessor();
  }

  // Subscribe to governance notifications
  subscribe(userId, preferences) {
    this.preferences.set(userId, {
      email: preferences.email || false,
      push: preferences.push || false,
      websocket: preferences.websocket || true,
      discord: preferences.discord || false,
      telegram: preferences.telegram || false,
      proposalAnnouncements: preferences.proposalAnnouncements !== false,
      votingReminders: preferences.votingReminders !== false,
      resultNotifications: preferences.resultNotifications !== false,
      delegationUpdates: preferences.delegationUpdates !== false,
      treasuryUpdates: preferences.treasuryUpdates || false,
      emergencyAlerts: preferences.emergencyAlerts !== false,
    });

    governanceLogger.info('User subscribed to governance notifications', { userId });
  }

  // Unsubscribe from notifications
  unsubscribe(userId) {
    this.preferences.delete(userId);
    this.subscribers.delete(userId);
    governanceLogger.info('User unsubscribed from governance notifications', { userId });
  }

  // Send proposal announcement
  async sendProposalAnnouncement(proposal) {
    const notification = {
      type: 'proposal_announcement',
      title: 'New Governance Proposal',
      message: `New proposal: ${proposal.title}`,
      data: {
        proposalId: proposal.id,
        title: proposal.title,
        description: proposal.description,
        proposer: proposal.proposer_address,
        votingDeadline: proposal.voting_deadline,
        category: proposal.proposal_type,
      },
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    await this.queueNotification(notification, 'proposalAnnouncements');
  }

  // Send voting reminder
  async sendVotingReminder(proposal, hoursRemaining) {
    const urgency = hoursRemaining <= 24 ? 'urgent' : 'normal';

    const notification = {
      type: 'voting_reminder',
      title: `Voting Reminder: ${hoursRemaining}h remaining`,
      message: `Don't forget to vote on "${proposal.title}"`,
      data: {
        proposalId: proposal.id,
        title: proposal.title,
        hoursRemaining,
        votingDeadline: proposal.voting_deadline,
      },
      priority: urgency,
      timestamp: new Date().toISOString(),
    };

    await this.queueNotification(notification, 'votingReminders');
  }

  // Send voting result notification
  async sendVotingResult(proposal, result) {
    const notification = {
      type: 'voting_result',
      title: `Voting Complete: ${proposal.title}`,
      message: `Proposal ${result.passed ? 'PASSED' : 'REJECTED'} with ${result.totalVotes} votes`,
      data: {
        proposalId: proposal.id,
        title: proposal.title,
        result: result.passed ? 'passed' : 'rejected',
        votesFor: result.votesFor,
        votesAgainst: result.votesAgainst,
        totalVotes: result.totalVotes,
        quorum: result.quorum,
        executionDate: result.executionDate,
      },
      priority: 'high',
      timestamp: new Date().toISOString(),
    };

    await this.queueNotification(notification, 'resultNotifications');
  }

  // Send delegation update
  async sendDelegationUpdate(userId, update) {
    const notification = {
      type: 'delegation_update',
      title: 'Delegation Update',
      message:
        update.type === 'received'
          ? `You received ${update.amount} WRF voting power delegation`
          : `Your delegation of ${update.amount} WRF has been ${update.action}`,
      data: {
        userId,
        delegationType: update.type,
        amount: update.amount,
        delegator: update.delegator,
        delegate: update.delegate,
        action: update.action,
      },
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    await this.queueNotificationToUser(
      userId,
      notification,
      'delegationUpdates'
    );
  }

  // Send treasury update
  async sendTreasuryUpdate(update) {
    const notification = {
      type: 'treasury_update',
      title: 'Treasury Update',
      message: `Treasury ${update.action}: ${update.amount} WRF for ${update.purpose}`,
      data: {
        action: update.action,
        amount: update.amount,
        purpose: update.purpose,
        proposalId: update.proposalId,
        remainingBalance: update.remainingBalance,
      },
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    await this.queueNotification(notification, 'treasuryUpdates');
  }

  // Send emergency alert
  async sendEmergencyAlert(alert) {
    const notification = {
      type: 'emergency_alert',
      title: `🚨 EMERGENCY: ${alert.title}`,
      message: alert.message,
      data: {
        alertId: alert.id,
        severity: alert.severity,
        affectedSystems: alert.affectedSystems,
        actionRequired: alert.actionRequired,
        estimatedResolution: alert.estimatedResolution,
      },
      priority: 'critical',
      timestamp: new Date().toISOString(),
    };

    await this.queueNotification(notification, 'emergencyAlerts');
  }

  // Queue notification for all eligible users
  async queueNotification(notification, preferenceKey) {
    for (const [userId, preferences] of this.preferences) {
      if (preferences[preferenceKey]) {
        await this.queueNotificationToUser(userId, notification, preferenceKey);
      }
    }
  }

  // Queue notification for specific user
  async queueNotificationToUser(userId, notification, preferenceKey) {
    const userPreferences = this.preferences.get(userId);
    if (!userPreferences || !userPreferences[preferenceKey]) {
      return;
    }

    const userNotification = {
      ...notification,
      userId,
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };

    this.notificationQueue.push(userNotification);
  }

  // Process notification queue
  startNotificationProcessor() {
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer102 = setInterval(async () => {
      if (this.notificationQueue.length === 0) return;

      const notifications = this.notificationQueue.splice(0, 10); // Process 10 at a time

      for (const notification of notifications) {
        await this.deliverNotification(notification);
      }
    }, 1000);
    importTimeTimer102.unref(); // Process every second
  }

  // Deliver notification through enabled channels
  async deliverNotification(notification) {
    const userPreferences = this.preferences.get(notification.userId);
    if (!userPreferences) return;

    const deliveryPromises = [];

    // WebSocket (real-time)
    if (userPreferences.websocket) {
      deliveryPromises.push(
        this.channels.websocket.send(notification.userId, notification)
      );
    }

    // Email
    if (userPreferences.email) {
      deliveryPromises.push(
        this.channels.email.send(notification.userId, notification)
      );
    }

    // Push notifications
    if (userPreferences.push) {
      deliveryPromises.push(
        this.channels.push.send(notification.userId, notification)
      );
    }

    // Discord
    if (userPreferences.discord) {
      deliveryPromises.push(
        this.channels.discord.send(notification.userId, notification)
      );
    }

    // Telegram
    if (userPreferences.telegram) {
      deliveryPromises.push(
        this.channels.telegram.send(notification.userId, notification)
      );
    }

    try {
      await Promise.allSettled(deliveryPromises);
      governanceLogger.info('Notification delivered to user', { userId: notification.userId, notificationType: notification.type });
    } catch (error) {
      governanceLogger.error('Error delivering notification', { error: error.message });
    }
  }

  // Get notification history for user
  getNotificationHistory(userId, limit = 50) {
    // In production, this would query a database
    return {
      userId,
      notifications: [
        {
          id: 'notif_001',
          type: 'proposal_announcement',
          title: 'New Governance Proposal',
          message: 'New proposal: Weather Data Validation Upgrade',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          read: false,
        },
        {
          id: 'notif_002',
          type: 'voting_reminder',
          title: 'Voting Reminder: 6h remaining',
          message:
            'Don\'t forget to vote on "Cross-Chain Bridge Fee Reduction"',
          timestamp: new Date(Date.now() - 7200000).toISOString(),
          read: true,
        },
      ],
      unreadCount: 1,
      totalCount: 2,
    };
  }

  // Mark notification as read
  markAsRead(userId, notificationId) {
    governanceLogger.info('Notification marked as read', { notificationId, userId });
    return true;
  }

  // Get notification statistics
  getNotificationStats() {
    return {
      totalSubscribers: this.preferences.size,
      queueLength: this.notificationQueue.length,
      channelStats: {
        websocket: this.channels.websocket.getStats(),
        email: this.channels.email.getStats(),
        push: this.channels.push.getStats(),
        discord: this.channels.discord.getStats(),
        telegram: this.channels.telegram.getStats(),
      },
      notificationTypes: {
        proposal_announcement: 0,
        voting_reminder: 0,
        voting_result: 0,
        delegation_update: 0,
        treasury_update: 0,
        emergency_alert: 0,
      },
    };
  }
}

// Notification channel implementations
class EmailChannel {
  constructor() {
    this.sent = 0;
    this.failed = 0;
  }

  async send(userId, notification) {
    // Mock email sending
    governanceLogger.info('Email sent', { userId, title: notification.title });
    this.sent++;
    return true;
  }

  getStats() {
    return { sent: this.sent, failed: this.failed };
  }
}

class PushNotificationChannel {
  constructor() {
    this.sent = 0;
    this.failed = 0;
  }

  async send(userId, notification) {
    // Mock push notification
    governanceLogger.info('Push notification sent', { userId, title: notification.title });
    this.sent++;
    return true;
  }

  getStats() {
    return { sent: this.sent, failed: this.failed };
  }
}

class WebSocketChannel {
  constructor() {
    this.connections = new Map();
    this.sent = 0;
    this.failed = 0;
  }

  addConnection(userId, ws) {
    this.connections.set(userId, ws);
    governanceLogger.info('WebSocket connection added', { userId });
  }

  removeConnection(userId) {
    this.connections.delete(userId);
    governanceLogger.info('WebSocket connection removed', { userId });
  }

  async send(userId, notification) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'governance_notification',
          data: notification,
        })
      );
      this.sent++;
      governanceLogger.info('WebSocket notification sent', { userId, title: notification.title });
      return true;
    }
    this.failed++;
    return false;
  }

  getStats() {
    return {
      sent: this.sent,
      failed: this.failed,
      activeConnections: this.connections.size,
    };
  }
}

class DiscordChannel {
  constructor() {
    this.sent = 0;
    this.failed = 0;
  }

  async send(userId, notification) {
    // Mock Discord webhook
    governanceLogger.info('Discord notification sent', { userId, title: notification.title });
    this.sent++;
    return true;
  }

  getStats() {
    return { sent: this.sent, failed: this.failed };
  }
}

class TelegramChannel {
  constructor() {
    this.sent = 0;
    this.failed = 0;
  }

  async send(userId, notification) {
    // Mock Telegram bot
    governanceLogger.info('Telegram notification sent', { userId, title: notification.title });
    this.sent++;
    return true;
  }

  getStats() {
    return { sent: this.sent, failed: this.failed };
  }
}

// Create singleton instance
const governanceNotificationService = new GovernanceNotificationService();

// Simulate some activity
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer7 = setTimeout(() => {
  // Subscribe some test users
  governanceNotificationService.subscribe('user_001', {
    email: true,
    websocket: true,
    proposalAnnouncements: true,
    votingReminders: true,
    resultNotifications: true,
  });

  governanceNotificationService.subscribe('user_002', {
    push: true,
    discord: true,
    votingReminders: true,
    emergencyAlerts: true,
  });

  // Send some test notifications
  governanceNotificationService.sendProposalAnnouncement({
    id: 'prop_001',
    title: 'Weather Data Validation Upgrade',
    description: 'Improve weather data validation algorithms',
    proposer_address: '0x123...',
    voting_deadline: new Date(Date.now() + 604800000).toISOString(),
    proposal_type: 'technical',
  });

  setTimeout(() => {
    governanceNotificationService.sendVotingReminder(
      {
        id: 'prop_001',
        title: 'Weather Data Validation Upgrade',
        voting_deadline: new Date(Date.now() + 86400000).toISOString(),
      },
      24
    );
  }, 5000);
}, 2000);
importTimeTimer7.unref();

module.exports = {
  GovernanceNotificationService,
  governanceNotificationService,
};
