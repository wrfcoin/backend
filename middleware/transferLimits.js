/**
 * Transfer Security Limits
 * Implements daily and per-transaction limits for cross-chain transfers
 */

class TransferLimitManager {
  constructor() {
    this.dailyLimits = new Map(); // IP -> daily transfer amount
    this.transferLimits = {
      maxPerTransaction: 10000, // 10,000 WRF per transaction
      maxDailyPerIP: 50000, // 50,000 WRF per day per IP
      maxHourlyPerIP: 10000, // 10,000 WRF per hour per IP
    };
  }

  checkTransferLimit(ip, amount) {
    const today = new Date().toDateString();
    const hour = new Date().getHours();
    const key = `${ip}-${today}`;
    const hourKey = `${ip}-${today}-${hour}`;

    // Check per-transaction limit
    if (amount > this.transferLimits.maxPerTransaction) {
      return {
        allowed: false,
        reason: `Transaction amount ${amount} exceeds maximum ${this.transferLimits.maxPerTransaction}`,
      };
    }

    // Check daily limit
    const dailyTotal = this.dailyLimits.get(key) || 0;
    if (dailyTotal + amount > this.transferLimits.maxDailyPerIP) {
      return {
        allowed: false,
        reason: `Daily limit exceeded. Current: ${dailyTotal}, Requested: ${amount}, Limit: ${this.transferLimits.maxDailyPerIP}`,
      };
    }

    // Check hourly limit
    const hourlyTotal = this.dailyLimits.get(hourKey) || 0;
    if (hourlyTotal + amount > this.transferLimits.maxHourlyPerIP) {
      return {
        allowed: false,
        reason: `Hourly limit exceeded. Current: ${hourlyTotal}, Requested: ${amount}, Limit: ${this.transferLimits.maxHourlyPerIP}`,
      };
    }

    return { allowed: true };
  }

  recordTransfer(ip, amount) {
    const today = new Date().toDateString();
    const hour = new Date().getHours();
    const key = `${ip}-${today}`;
    const hourKey = `${ip}-${today}-${hour}`;

    this.dailyLimits.set(key, (this.dailyLimits.get(key) || 0) + amount);
    this.dailyLimits.set(
      hourKey,
      (this.dailyLimits.get(hourKey) || 0) + amount
    );
  }

  getDailyUsage(ip) {
    const today = new Date().toDateString();
    const key = `${ip}-${today}`;
    return this.dailyLimits.get(key) || 0;
  }

  getHourlyUsage(ip) {
    const today = new Date().toDateString();
    const hour = new Date().getHours();
    const hourKey = `${ip}-${today}-${hour}`;
    return this.dailyLimits.get(hourKey) || 0;
  }
}

module.exports = TransferLimitManager;
