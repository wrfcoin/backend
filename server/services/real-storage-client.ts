/**
 * Real Storage Client
 *
 * Implements actual HTTP calls to IPFS, Arweave, and Filecoin (Lotus) APIs.
 * Production exports use a singleton configured from the environment. Tests
 * and other isolated consumers can inject an HTTP client and explicit config
 * through createRealStorageClient without mutating the module registry.
 */

import axios, { type AxiosRequestConfig } from 'axios';
import { logger } from '../../utils/logger.js';

export interface RealStorageHttpClient {
  post(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<{ data: unknown }>;
}

export interface RealStorageConfig {
  enabled: boolean;
  ipfsGatewayUrl: string;
  lotusApiUrl: string;
  lotusAuthToken: string;
}

export interface IpfsPinResult {
  cid: string;
  simulated: boolean;
}

export interface ArweaveTxBundle {
  /** Base64url-encoded data payload */
  data: string;
  tags: Array<{ name: string; value: string }>;
  reward?: string;
  last_tx?: string;
}

export interface ArweaveTxResult {
  txId: string;
  simulated: boolean;
}

export interface FilecoinDealParams {
  /** CID of the data already stored on IPFS/IPLD */
  dataCid: string;
  /** Wallet address to pay for the deal */
  walletAddress: string;
  /** Miner address (storage provider) */
  minerAddress: string;
  /** Epoch price per GiB */
  epochPrice?: string;
  /** Deal duration in epochs (~2880 epochs/day) */
  durationEpochs?: number;
}

export interface FilecoinDealResult {
  dealCid: string;
  simulated: boolean;
}

export interface RealStorageClient {
  ipfsPinAdd(cid: string): Promise<IpfsPinResult>;
  arweavePostTx(bundle: ArweaveTxBundle): Promise<ArweaveTxResult>;
  filecoinStartDeal(params: FilecoinDealParams): Promise<FilecoinDealResult>;
}

export interface RealStorageClientOptions {
  http: RealStorageHttpClient;
  config: RealStorageConfig;
}

/**
 * Construct a storage client from explicit dependencies.
 *
 * Config is copied at construction so later mutation by a caller cannot alter
 * an in-flight client's behavior. The injected HTTP surface deliberately
 * matches the subset of Axios used by these integrations.
 */
export function createRealStorageClient({
  http,
  config,
}: RealStorageClientOptions): RealStorageClient {
  const capturedConfig = Object.freeze({ ...config });

  return {
    async ipfsPinAdd(cid: string): Promise<IpfsPinResult> {
      if (!capturedConfig.enabled) {
        logger.info(
          '[RealStorage] ENABLE_REAL_STORAGE=false — returning IPFS stub',
          { cid }
        );
        return { cid, simulated: true };
      }

      const url = `${capturedConfig.ipfsGatewayUrl}/api/v0/pin/add`;
      logger.info('[RealStorage] Pinning CID via IPFS HTTP API', { url, cid });

      const response = await http.post(url, null, {
        params: { arg: cid },
        headers: { Accept: 'application/json' },
        timeout: 30_000,
      });
      const data = response.data as { Pins?: string[] } | undefined;
      const pinned = data?.Pins?.[0] ?? cid;
      logger.info('[RealStorage] IPFS pin successful', { pinned });
      return { cid: pinned, simulated: false };
    },

    async arweavePostTx(bundle: ArweaveTxBundle): Promise<ArweaveTxResult> {
      if (!capturedConfig.enabled) {
        const stubId = Buffer.from(bundle.data ?? '', 'base64')
          .toString('hex')
          .slice(0, 43);
        logger.info(
          '[RealStorage] ENABLE_REAL_STORAGE=false — returning Arweave stub',
          { stubId }
        );
        return { txId: stubId, simulated: true };
      }

      logger.info('[RealStorage] Posting Arweave transaction', {
        dataLength: bundle.data.length,
      });

      const response = await http.post('https://arweave.net/tx', bundle, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 60_000,
      });
      const raw = response.data as string | { id?: string };
      const txId =
        typeof raw === 'string'
          ? raw === 'OK'
            ? bundle.data.slice(0, 43)
            : raw
          : (raw?.id ?? bundle.data.slice(0, 43));

      logger.info('[RealStorage] Arweave tx posted successfully', { txId });
      return { txId, simulated: false };
    },

    async filecoinStartDeal(
      params: FilecoinDealParams
    ): Promise<FilecoinDealResult> {
      const {
        dataCid,
        walletAddress,
        minerAddress,
        epochPrice = '0',
        durationEpochs = 518400,
      } = params;

      if (!capturedConfig.enabled) {
        const stubDealCid = `bafy2bzace${dataCid.slice(0, 32)}`;
        logger.info(
          '[RealStorage] ENABLE_REAL_STORAGE=false — returning Filecoin stub',
          { stubDealCid }
        );
        return { dealCid: stubDealCid, simulated: true };
      }

      logger.info('[RealStorage] Starting Filecoin deal via Lotus JSON-RPC', {
        dataCid,
        minerAddress,
      });

      const rpcPayload = {
        jsonrpc: '2.0',
        method: 'Filecoin.ClientStartDeal',
        id: 1,
        params: [
          {
            Data: {
              TransferType: 'graphsync',
              Root: { '/': dataCid },
              PieceCid: null,
              PieceSize: 0,
            },
            Wallet: walletAddress,
            Miner: minerAddress,
            EpochPrice: epochPrice,
            MinBlocksDuration: durationEpochs,
            ProviderCollateral: '0',
            DealStartEpoch: -1,
            FastRetrieval: true,
            VerifiedDeal: false,
          },
        ],
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (capturedConfig.lotusAuthToken) {
        headers['Authorization'] = `Bearer ${capturedConfig.lotusAuthToken}`;
      }

      const response = await http.post(
        capturedConfig.lotusApiUrl,
        rpcPayload,
        { headers, timeout: 60_000 }
      );
      const data = response.data as {
        result?: { '/': string };
        error?: unknown;
      };

      if (data?.error) {
        throw new Error(`Lotus RPC error: ${JSON.stringify(data.error)}`);
      }

      const dealCid = data?.result?.['/'] ?? dataCid;
      logger.info('[RealStorage] Filecoin deal started', { dealCid });
      return { dealCid, simulated: false };
    },
  };
}

export const ENABLE_REAL_STORAGE = process.env.ENABLE_REAL_STORAGE === 'true';

const productionHttp: RealStorageHttpClient = {
  post: (url, data, config) => axios.post(url, data, config),
};

const productionClient = createRealStorageClient({
  http: productionHttp,
  config: {
    enabled: ENABLE_REAL_STORAGE,
    ipfsGatewayUrl:
      process.env.IPFS_GATEWAY_URL ?? 'http://localhost:5001',
    lotusApiUrl:
      process.env.LOTUS_API_URL ?? 'http://localhost:1234/rpc/v0',
    lotusAuthToken: process.env.LOTUS_AUTH_TOKEN ?? '',
  },
});

// Compatibility exports: existing production callers retain the same API.
export async function ipfsPinAdd(cid: string): Promise<IpfsPinResult> {
  return productionClient.ipfsPinAdd(cid);
}

export async function arweavePostTx(
  bundle: ArweaveTxBundle
): Promise<ArweaveTxResult> {
  return productionClient.arweavePostTx(bundle);
}

export async function filecoinStartDeal(
  params: FilecoinDealParams
): Promise<FilecoinDealResult> {
  return productionClient.filecoinStartDeal(params);
}
