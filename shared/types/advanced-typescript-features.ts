/**
 * Advanced TypeScript Features for Wrfcoin Platform
 *
 * This module demonstrates and implements advanced TypeScript patterns
 * that can enhance type safety, developer experience, and code maintainability.
 */

// 1. CONDITIONAL TYPES - Dynamic type selection based on conditions
type IsArray<T> = T extends any[] ? true : false;
type ArrayElement<T> = T extends (infer E)[] ? E : never;

// 2. MAPPED TYPES - Transform object types systematically
type Optional<T> = {
  [K in keyof T]?: T[K];
};

type Readonly<T> = {
  readonly [K in keyof T]: T[K];
};

type Nullable<T> = {
  [K in keyof T]: T[K] | null;
};

// 3. TEMPLATE LITERAL TYPES - String manipulation at type level
type EventName<T extends string> = `on${Capitalize<T>}`;
type ApiEndpoint<T extends string> = `/api/${T}`;
type DbTable<T extends string> = `wrfcoin_${T}`;

// 4. UTILITY TYPES FOR BLOCKCHAIN OPERATIONS
type TransactionStatus = 'pending' | 'confirmed' | 'failed' | 'rejected';
type ChainId = 'ethereum' | 'polygon' | 'bsc' | 'avalanche' | 'wrfcoin';

// Advanced blockchain type with conditional validation
type Transaction<T extends ChainId = ChainId> = {
  id: string;
  chainId: T;
  hash: string;
  status: TransactionStatus;
  timestamp: Date;
  // Conditional fields based on chain
  gasPrice: T extends 'ethereum' | 'polygon' ? string : never;
  gasLimit: T extends 'ethereum' | 'polygon' ? number : never;
  bnbFee: T extends 'bsc' ? string : never;
  avaxFee: T extends 'avalanche' ? string : never;
  wrfReward: T extends 'wrfcoin' ? string : never;
};

// 5. DISCRIMINATED UNIONS for Weather Data Types
type WeatherDataType =
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'precipitation';

interface BaseWeatherData {
  id: string;
  stationId: string;
  timestamp: Date;
  quality: 'high' | 'medium' | 'low';
}

interface TemperatureData extends BaseWeatherData {
  type: 'temperature';
  value: number; // Celsius
  unit: '°C';
  dewPoint?: number;
}

interface HumidityData extends BaseWeatherData {
  type: 'humidity';
  value: number; // Percentage
  unit: '%';
  relativeHumidity: number;
}

interface PressureData extends BaseWeatherData {
  type: 'pressure';
  value: number; // hPa
  unit: 'hPa';
  seaLevelPressure?: number;
}

interface PrecipitationData extends BaseWeatherData {
  type: 'precipitation';
  value: number; // mm
  unit: 'mm';
  intensity: 'light' | 'moderate' | 'heavy';
}

export type WeatherData =
  | TemperatureData
  | HumidityData
  | PressureData
  | PrecipitationData;

// 6. BRAND TYPES for Enhanced Type Safety
declare const __brand: unique symbol;
type Brand<T, TBrand> = T & { [__brand]: TBrand };

export type WalletAddress = Brand<string, 'WalletAddress'>;
export type TransactionHash = Brand<string, 'TransactionHash'>;
export type BlockHash = Brand<string, 'BlockHash'>;
export type TokenAmount = Brand<string, 'TokenAmount'>;

// 7. RECURSIVE TYPES for NFT Metadata
interface NFTAttribute {
  trait_type: string;
  value: string | number;
  display_type?: 'boost_number' | 'boost_percentage' | 'number' | 'date';
}

interface ComputationalNFTMetadata {
  name: string;
  description: string;
  image: string;
  attributes: NFTAttribute[];
  // Recursive type for nested computational results
  computationResults?: {
    [key: string]: ComputationalNFTMetadata | string | number;
  };
}

// 8. FUNCTION OVERLOADS for API Methods
interface ApiClient {
  // Different return types based on method
  request<T = any>(method: 'GET', url: string): Promise<T>;
  request<T = any>(method: 'POST', url: string, data: any): Promise<T>;
  request<T = any>(method: 'PUT', url: string, data: any): Promise<T>;
  request<T = any>(method: 'DELETE', url: string): Promise<void>;
}

// 9. CONST ASSERTIONS and READONLY TUPLES
export const CHAIN_CONFIG = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    gasMultiplier: 1.1,
  },
  polygon: {
    chainId: 137,
    name: 'Polygon',
    gasMultiplier: 1.05,
  },
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    gasMultiplier: 1.02,
  },
  wrfcoin: {
    chainId: 9999,
    name: 'Wrfcoin Network',
    gasMultiplier: 1.0,
  },
} as const;

export type ChainConfig = typeof CHAIN_CONFIG;
export type SupportedChain = keyof ChainConfig;

// 10. ADVANCED GENERICS with Constraints
interface Repository<T extends { id: string }> {
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  create(entity: Omit<T, 'id'>): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
}

// 11. INDEXED ACCESS TYPES
type UserRole = 'admin' | 'validator' | 'contributor' | 'viewer';
type PermissionMatrix = {
  admin: ['read', 'write', 'delete', 'manage'];
  validator: ['read', 'write', 'validate'];
  contributor: ['read', 'write'];
  viewer: ['read'];
};

type UserPermissions<T extends UserRole> = PermissionMatrix[T][number];

// 12. CONDITIONAL TYPE HELPERS
type NonNullable<T> = T extends null | undefined ? never : T;
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// 13. TYPE GUARDS with User-Defined Type Predicates
export function isTemperatureData(data: WeatherData): data is TemperatureData {
  return data.type === 'temperature';
}

export function isValidWalletAddress(
  address: string
): address is WalletAddress {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isTransactionHash(hash: string): hash is TransactionHash {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

// 14. BUILDER PATTERN with Fluent Interface
export class TransactionBuilder {
  private transaction: Partial<Transaction> = {};

  setChain<T extends ChainId>(chainId: T): TransactionBuilder {
    this.transaction.chainId = chainId;
    return this;
  }

  setAmount(amount: TokenAmount): TransactionBuilder {
    // Implementation would set amount
    return this;
  }

  setRecipient(address: WalletAddress): TransactionBuilder {
    // Implementation would set recipient
    return this;
  }

  build(): Transaction {
    if (!this.transaction.chainId) {
      throw new Error('Chain ID is required');
    }
    return this.transaction as Transaction;
  }
}

// 15. ASYNC ITERATOR TYPES for Streaming Data
export interface WeatherDataStream {
  [Symbol.asyncIterator](): AsyncIterableIterator<WeatherData>;
}

// 16. MIXIN PATTERN with TypeScript
type Constructor<T = {}> = new (...args: any[]) => T;

function Timestamped<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    timestamp = new Date();

    getTimestamp() {
      return this.timestamp;
    }
  };
}

function Identifiable<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    id = Math.random().toString(36);

    getId() {
      return this.id;
    }
  };
}

// 17. PLUGIN ARCHITECTURE with Advanced Types
interface Plugin<TConfig = any> {
  name: string;
  version: string;
  init(config: TConfig): Promise<void>;
  destroy(): Promise<void>;
}

type PluginRegistry<T extends Record<string, Plugin>> = {
  [K in keyof T]: T[K];
};

// 18. STATE MACHINE TYPES
type WeatherStationState =
  | 'idle'
  | 'collecting'
  | 'processing'
  | 'transmitting'
  | 'error';
type WeatherStationEvent =
  | 'start'
  | 'dataReady'
  | 'process'
  | 'transmit'
  | 'fail'
  | 'reset';

type StateMachine<TState extends string, TEvent extends string> = {
  currentState: TState;
  transition(event: TEvent): TState;
  canTransition(from: TState, event: TEvent): boolean;
};

// 19. SCHEMA VALIDATION TYPES
interface ValidationSchema<T> {
  validate(input: unknown): input is T;
  parse(input: unknown): T;
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: string };
}

// 20. EVENT SYSTEM with Typed Events
type EventMap = {
  'transaction:pending': { txHash: TransactionHash; chainId: ChainId };
  'transaction:confirmed': { txHash: TransactionHash; blockNumber: number };
  'weather:data': WeatherData;
  'nft:minted': { tokenId: string; owner: WalletAddress };
  error: { message: string; code: number };
};

interface TypedEventEmitter<T extends Record<string, any>> {
  on<K extends keyof T>(event: K, listener: (data: T[K]) => void): void;
  emit<K extends keyof T>(event: K, data: T[K]): void;
  off<K extends keyof T>(event: K, listener: (data: T[K]) => void): void;
}

// Export utility types for platform use
export type {
  Optional,
  Readonly,
  Nullable,
  EventName,
  ApiEndpoint,
  DbTable,
  TransactionStatus,
  ChainId,
  Transaction,
  ComputationalNFTMetadata,
  Repository,
  UserRole,
  UserPermissions,
  NonNullable,
  DeepPartial,
  Constructor,
  Plugin,
  PluginRegistry,
  StateMachine,
  ValidationSchema,
  EventMap,
  TypedEventEmitter,
};
