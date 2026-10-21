import mongoose from 'mongoose';
import { appLogger } from '../../../../server/utils/logger.js';

export class DatabaseService {
  private static instance: DatabaseService;
  private isConnected = false;

  private constructor() {}

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      const mongoUri =
        process.env.MONGODB_URI || 'mongodb://localhost:27017/wrfcoin_nft';

      await mongoose.connect(mongoUri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      this.isConnected = true;
      appLogger.info('Connected to MongoDB for NFT service');

      mongoose.connection.on('error', error => {
        appLogger.error('MongoDB connection error', { error });
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        appLogger.warn('MongoDB disconnected');
        this.isConnected = false;
      });
    } catch (error) {
      appLogger.error('Failed to connect to MongoDB', { error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      appLogger.info('Disconnected from MongoDB');
    } catch (error) {
      appLogger.error('Error disconnecting from MongoDB', { error });
      throw error;
    }
  }

  isHealthy(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  getConnectionStatus(): string {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    return states[mongoose.connection.readyState] || 'unknown';
  }
}
