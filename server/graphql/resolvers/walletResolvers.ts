/**
 * Wallet GraphQL Resolvers
 * TypeScript implementation for wallet-related GraphQL operations
 */

interface Wallet {
  id: string;
  address: string;
  balance: number;
  nonce: number;
  createdAt: string;
  transactions: Transaction[];
}

interface Transaction {
  id: string;
  hash: string;
  from: string;
  to: string;
  amount: number;
  timestamp: string;
  status: string;
}

interface WalletInput {
  address: string;
  privateKey?: string;
}

interface TransactionInput {
  from: string;
  to: string;
  amount: number;
  gasPrice?: number;
  gasLimit?: number;
}

// Mock storage for wallets
const walletStorage = new Map<string, Wallet>();
const transactionStorage = new Map<string, Transaction>();

// Initialize with sample data
const sampleWallet: Wallet = {
  id: 'wallet_001',
  address: 'wrf717d72395303fcb2aed4df368f32f1078d18e9cc',
  balance: 45.8,
  nonce: 12,
  createdAt: new Date().toISOString(),
  transactions: [],
};

walletStorage.set(sampleWallet.address, sampleWallet);

const walletResolvers = {
  Query: {
    wallet: (_: any, { address }: { address: string }): Wallet | null => {
      return walletStorage.get(address) || null;
    },

    wallets: (): Wallet[] => {
      return Array.from(walletStorage.values());
    },

    walletBalance: (_: any, { address }: { address: string }): number => {
      const wallet = walletStorage.get(address);
      return wallet ? wallet.balance : 0;
    },

    walletTransactions: (
      _: any,
      { address }: { address: string }
    ): Transaction[] => {
      const wallet = walletStorage.get(address);
      if (!wallet) return [];

      return Array.from(transactionStorage.values()).filter(
        tx => tx.from === address || tx.to === address
      );
    },

    pendingTransactions: (
      _: any,
      { address }: { address: string }
    ): Transaction[] => {
      return Array.from(transactionStorage.values()).filter(
        tx =>
          (tx.from === address || tx.to === address) && tx.status === 'pending'
      );
    },
  },

  Mutation: {
    createWallet: (_: any, { input }: { input: WalletInput }): Wallet => {
      const wallet: Wallet = {
        id: `wallet_${Date.now()}`,
        address: input.address,
        balance: 0,
        nonce: 0,
        createdAt: new Date().toISOString(),
        transactions: [],
      };

      walletStorage.set(wallet.address, wallet);
      return wallet;
    },

    sendTransaction: (
      _: any,
      { input }: { input: TransactionInput }
    ): Transaction => {
      const fromWallet = walletStorage.get(input.from);
      if (!fromWallet) {
        throw new Error('Sender wallet not found');
      }

      if (fromWallet.balance < input.amount) {
        throw new Error('Insufficient balance');
      }

      const transaction: Transaction = {
        id: `tx_${Date.now()}`,
        hash: `0x${Math.random().toString(16).substring(2, 66)}`,
        from: input.from,
        to: input.to,
        amount: input.amount,
        timestamp: new Date().toISOString(),
        status: 'pending',
      };

      // Update balances
      fromWallet.balance -= input.amount;
      fromWallet.nonce += 1;

      const toWallet = walletStorage.get(input.to);
      if (toWallet) {
        toWallet.balance += input.amount;
      }

      // Simulate transaction confirmation after delay
      setTimeout(() => {
        transaction.status = 'confirmed';
      }, 5000);

      transactionStorage.set(transaction.id, transaction);
      return transaction;
    },

    importWallet: (_: any, { input }: { input: WalletInput }): Wallet => {
      const existingWallet = walletStorage.get(input.address);
      if (existingWallet) {
        throw new Error('Wallet already exists');
      }

      const wallet: Wallet = {
        id: `wallet_${Date.now()}`,
        address: input.address,
        balance: Math.random() * 1000, // Simulate imported balance
        nonce: Math.floor(Math.random() * 100),
        createdAt: new Date().toISOString(),
        transactions: [],
      };

      walletStorage.set(wallet.address, wallet);
      return wallet;
    },

    updateWalletBalance: (
      _: any,
      { address, amount }: { address: string; amount: number }
    ): Wallet => {
      const wallet = walletStorage.get(address);
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      wallet.balance = amount;
      return wallet;
    },
  },

  Wallet: {
    transactions: (parent: Wallet): Transaction[] => {
      return Array.from(transactionStorage.values()).filter(
        tx => tx.from === parent.address || tx.to === parent.address
      );
    },
  },

  Transaction: {
    fromWallet: (parent: Transaction): Wallet | null => {
      return walletStorage.get(parent.from) || null;
    },

    toWallet: (parent: Transaction): Wallet | null => {
      return walletStorage.get(parent.to) || null;
    },
  },
};

export default walletResolvers;
export { Wallet, Transaction, WalletInput, TransactionInput };
