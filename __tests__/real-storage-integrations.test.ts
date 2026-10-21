/**
 * Integration tests for real IPFS / Arweave / Filecoin storage calls (#383).
 *
 * The HTTP and configuration boundaries are injected directly. No module
 * registry reset, module mocking, or process environment mutation is needed.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  createRealStorageClient,
  type RealStorageConfig,
  type RealStorageHttpClient,
} from '../server/services/real-storage-client.js';

jest.mock('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const disabledConfig: RealStorageConfig = {
  enabled: false,
  ipfsGatewayUrl: 'http://unused-ipfs.invalid',
  lotusApiUrl: 'http://unused-lotus.invalid/rpc/v0',
  lotusAuthToken: '',
};

const enabledConfig: RealStorageConfig = {
  enabled: true,
  ipfsGatewayUrl: 'http://mock-ipfs:5001',
  lotusApiUrl: 'http://mock-lotus:1234/rpc/v0',
  lotusAuthToken: 'test-token-abc',
};

function fakeHttp() {
  const post = jest.fn() as jest.MockedFunction<RealStorageHttpClient['post']>;
  return { http: { post } satisfies RealStorageHttpClient, post };
}

describe('real-storage-client: disabled (stub mode)', () => {
  it('ipfsPinAdd returns a simulated result without an HTTP call', async () => {
    const { http, post } = fakeHttp();
    const client = createRealStorageClient({ http, config: disabledConfig });

    const result = await client.ipfsPinAdd('bafy2bzacetest123');

    expect(result).toEqual({ cid: 'bafy2bzacetest123', simulated: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('arweavePostTx returns a simulated result without an HTTP call', async () => {
    const { http, post } = fakeHttp();
    const client = createRealStorageClient({ http, config: disabledConfig });
    const data = Buffer.from('test-content').toString('base64');

    const result = await client.arweavePostTx({ data, tags: [] });

    expect(result.simulated).toBe(true);
    expect(result.txId.length).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('filecoinStartDeal returns a simulated result without an HTTP call', async () => {
    const { http, post } = fakeHttp();
    const client = createRealStorageClient({ http, config: disabledConfig });

    const result = await client.filecoinStartDeal({
      dataCid: 'bafy2bzaceXYZ',
      walletAddress: 'f1testwallet',
      minerAddress: 'f01234',
    });

    expect(result.simulated).toBe(true);
    expect(result.dealCid).toContain('bafy2bzace');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('real-storage-client: enabled IPFS pin', () => {
  it('posts to the configured gateway and returns the pinned CID', async () => {
    const testCid = 'bafy2bzacepinned999';
    const { http, post } = fakeHttp();
    post.mockResolvedValue({ data: { Pins: [testCid] } });
    const client = createRealStorageClient({ http, config: enabledConfig });

    const result = await client.ipfsPinAdd(testCid);

    expect(result).toEqual({ cid: testCid, simulated: false });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, , config] = post.mock.calls[0];
    expect(url).toBe('http://mock-ipfs:5001/api/v0/pin/add');
    expect(config?.params).toEqual({ arg: testCid });
  });
});

describe('real-storage-client: enabled Arweave transaction', () => {
  it('posts JSON to arweave.net and returns the response transaction ID', async () => {
    const fakeTxId = 'Abc123ArweaveTxId00000000000000000000000000';
    const { http, post } = fakeHttp();
    post.mockResolvedValue({ data: { id: fakeTxId } });
    const client = createRealStorageClient({ http, config: enabledConfig });
    const data = Buffer.from('weather-data-payload').toString('base64');
    const bundle = {
      data,
      tags: [{ name: 'Content-Type', value: 'application/json' }],
    };

    const result = await client.arweavePostTx(bundle);

    expect(result).toEqual({ txId: fakeTxId, simulated: false });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://arweave.net/tx');
    expect(body).toEqual(bundle);
    expect(config?.headers?.['Content-Type']).toBe('application/json');
    expect(config?.headers?.['Accept']).toBe('application/json');
  });

  it('derives the transaction ID from data when arweave.net returns OK', async () => {
    const { http, post } = fakeHttp();
    post.mockResolvedValue({ data: 'OK' });
    const client = createRealStorageClient({ http, config: enabledConfig });
    const data = Buffer.from('another-payload').toString('base64');

    const result = await client.arweavePostTx({ data, tags: [] });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://arweave.net/tx');
    expect(result).toEqual({ txId: data.slice(0, 43), simulated: false });
  });
});

describe('real-storage-client: enabled Filecoin deal', () => {
  it('calls the configured Lotus endpoint with JSON-RPC 2.0', async () => {
    const fakeDealCid = 'bafy2bzacedealcid000111222333';
    const { http, post } = fakeHttp();
    post.mockResolvedValue({ data: { result: { '/': fakeDealCid } } });
    const client = createRealStorageClient({ http, config: enabledConfig });

    const result = await client.filecoinStartDeal({
      dataCid: 'bafy2bzacedata123',
      walletAddress: 'f1testwallet',
      minerAddress: 'f01999',
    });

    expect(result).toEqual({ dealCid: fakeDealCid, simulated: false });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('http://mock-lotus:1234/rpc/v0');
    expect(body).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'Filecoin.ClientStartDeal',
      })
    );
    expect(config?.headers?.['Authorization']).toBe('Bearer test-token-abc');
  });

  it('throws the Lotus JSON-RPC error returned by the injected client', async () => {
    const { http, post } = fakeHttp();
    post.mockResolvedValue({
      data: { error: { code: -32603, message: 'Internal error' } },
    });
    const client = createRealStorageClient({ http, config: enabledConfig });

    await expect(
      client.filecoinStartDeal({
        dataCid: 'bafy2bzacedata999',
        walletAddress: 'f1bad',
        minerAddress: 'f09999',
      })
    ).rejects.toThrow(/Lotus RPC error/);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://mock-lotus:1234/rpc/v0');
  });
});
