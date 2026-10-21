// Global type declarations for WRFCoin backend

// Missing module declarations
declare module 'graphql-query-complexity' {
  export function createComplexityRule(options: any): any;
  export function getComplexity(options: any): number;
  export function simpleEstimator(options?: any): any;
  export function fieldExtensionsEstimator(): any;
  export function directiveEstimator(options?: any): any;
}

declare module 'rate-limit-redis' {
  import { Store } from 'express-rate-limit';
  import { Redis } from 'ioredis';
  interface RedisStoreOptions {
    sendCommand?: (...args: any[]) => Promise<any>;
    client?: Redis;
    prefix?: string;
    resetExpiryOnChange?: boolean;
  }
  export default class RedisStore implements Store {
    constructor(options: RedisStoreOptions);
    init(options: any): void;
    increment(key: string): Promise<{ totalHits: number; resetTime: Date }>;
    decrement(key: string): Promise<void>;
    resetKey(key: string): Promise<void>;
    resetAll(): Promise<void>;
  }
}

declare module '@google-cloud/storage' {
  export class Storage {
    constructor(options?: any);
    bucket(name: string): Bucket;
  }
  export class Bucket {
    file(name: string): File;
    upload(path: string, options?: any): Promise<any>;
    getFiles(options?: any): Promise<any>;
  }
  export class File {
    save(data: any, options?: any): Promise<any>;
    download(): Promise<any>;
    delete(): Promise<any>;
    exists(): Promise<[boolean]>;
    getMetadata(): Promise<any>;
    createReadStream(): NodeJS.ReadableStream;
    createWriteStream(options?: any): NodeJS.WritableStream;
  }
}

declare module 'node-cron' {
  export function schedule(expression: string, func: () => void, options?: any): any;
  export function validate(expression: string): boolean;
  export function getTasks(): Map<string, any>;
}

declare module '@opentelemetry/auto-instrumentations-node' {
  export function getNodeAutoInstrumentations(config?: any): any[];
}

declare module 'merkletreejs' {
  export default class MerkleTree {
    constructor(leaves: Buffer[], hashFunction: (...args: any[]) => Buffer, options?: any);
    getRoot(): Buffer;
    getProof(leaf: Buffer): any[];
    verify(proof: any[], leaf: Buffer, root: Buffer): boolean;
    getHexRoot(): string;
    getHexProof(leaf: Buffer): string[];
    static verify(proof: any[], leaf: Buffer, root: Buffer, hashFunction: (...args: any[]) => Buffer): boolean;
  }
}

declare module 'isomorphic-dompurify' {
  const DOMPurify: {
    sanitize(source: string, config?: any): string;
    addHook(hook: string, callback: (...args: any[]) => void): void;
    removeHook(hook: string): void;
    isSupported: boolean;
  };
  export default DOMPurify;
}

declare module '@peculiar/webcrypto' {
  export class Crypto {
    subtle: SubtleCrypto;
    getRandomValues<T extends ArrayBufferView>(array: T): T;
  }
}

declare module 'geoip-lite' {
  interface GeoData {
    range: [number, number];
    country: string;
    region: string;
    eu: string;
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }

  export function lookup(ip: string): GeoData | null;
  export function pretty(n: number): string;
  export function startWatchingDataUpdate(): void;
  export function stopWatchingDataUpdate(): void;
}

declare module 'yaml' {
  export function parse(str: string): any;
  export function stringify(obj: any): string;
  export function parseAllDocuments(str: string): any[];
  export function parseDocument(str: string): any;
}

declare module '@solana/web3.js' {
  export class Connection {
    constructor(endpoint: string, commitment?: string);
    getTransaction(signature: string, opts?: any): Promise<any>;
    getBalance(publicKey: PublicKey): Promise<number>;
    requestAirdrop(publicKey: PublicKey, lamports: number): Promise<string>;
  }
  export class PublicKey {
    constructor(value: string | Buffer | Uint8Array);
    static findProgramAddressSync(seeds: Array<Buffer | Uint8Array>, programId: PublicKey): [PublicKey, number];
    toBuffer(): Buffer;
    toBase58(): string;
    readonly programId: PublicKey;
  }
  export class Transaction {
    add(...items: TransactionInstruction[]): this;
  }
  export class TransactionInstruction {
    constructor(opts: { programId: PublicKey; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>; data: Buffer });
  }
  export class Keypair {
    static generate(): Keypair;
    readonly publicKey: PublicKey;
    readonly secretKey: Uint8Array;
  }
  export const SystemProgram: { programId: PublicKey };
  export const LAMPORTS_PER_SOL: number;
  export function sendAndConfirmTransaction(connection: Connection, transaction: Transaction, signers: Keypair[]): Promise<string>;
}

// Express Request and Response extensions
declare namespace Express {
  interface Request {
    user?: {
      id?: string;
      userId?: string;
      address?: string;
      walletAddress?: string;
      email?: string;
      role?: string;
      roles?: string[];
      permissions?: string[];
      sessionId?: string;
      verified?: boolean;
    };
    /**
     * API key context attached to authenticated API requests
     * SECURITY NOTE (Task 102.11): The plaintext key is NEVER stored
     * in the request object to prevent accidental exposure in logs or errors
     */
    apiKey?: {
      id: string;
      // SECURITY: 'key' property removed - plaintext key is never stored
      userId: string;
      name?: string;
      permissions: string[];
      scopes: string[];
      rateLimitTier: string;
      remainingQuota?: {
        daily: number;
        monthly: number;
      };
      lastUsed?: Date;
    };
    securityContext?: {
      userId?: string;
      sessionId?: string;
      walletAddress?: string;
      apiKeyId?: string;
      ip: string;
      userAgent: string;
      geoLocation?: {
        country: string;
        region: string;
        city: string;
        latitude: number;
        longitude: number;
      };
      deviceFingerprint?: string;
      requestSignature?: string;
      timestamp: Date;
      correlationId: string;
      riskScore: number;
    };
    rateLimit?: {
      remaining: number;
      total: number;
      reset: Date;
    };
  }

  interface Response {
    success<T>(data: T, message?: string, pagination?: any): Response;
    error(code: string | number, message: string, details?: any): Response;
    validationError(errors: any[]): Response;
    unauthorized(message?: string): Response;
    forbidden(message?: string): Response;
    notFound(message?: string): Response;
    serverError(message: string, error?: any): Response;
  }
}
