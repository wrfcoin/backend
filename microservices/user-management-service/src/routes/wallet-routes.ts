import { Router } from 'express';
import { WalletController } from '../controllers/wallet-controller.js';

const router = Router();

// GET /api/wallet/:address - Get wallet balance and info
router.get('/:address', WalletController.getWalletBalance);

// GET /api/wallet/:address/transactions - Get transaction history
router.get('/:address/transactions', WalletController.getTransactionHistory);

// POST /api/wallet/send - Create a new transaction
router.post('/send', WalletController.createTransaction);

export { router as walletRoutes };
