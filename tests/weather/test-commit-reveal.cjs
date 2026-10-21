'use strict';

const http = require('http');
const crypto = require('crypto');

const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || '4001');
const CORE4_HOST = process.env.WRFCOIN_API_HOST || '127.0.0.1';
const CORE4_PORT = Number(process.env.WRFCOIN_API_PORT || '8556');
const CORE4_TOKEN = process.env.WRFCOIN_OPERATOR_TOKEN || '';

function postJson(host, port, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mineBlock() {
  return postJson(
    CORE4_HOST,
    CORE4_PORT,
    '/blocks/mine',
    { miner_address: '0x0000000000000000000000000000000000000001' },
    CORE4_TOKEN
  );
}

function unwrapApiData(response) {
  if (response && typeof response === 'object' && response.success && response.data) {
    return response.data;
  }
  return response;
}

async function main() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const stationId = 'PWS-LANE3-TEST-001';
  const readings = [
    {
      temperature_c: 21.7,
      pressure_hpa: 1014.2,
      humidity_percent: 58.1,
      timestamp: new Date().toISOString(),
    },
  ];

  console.log('Submitting weather commitment...');
  const commitRes = await postJson(
    BACKEND_HOST,
    BACKEND_PORT,
    '/api/weather/commit',
    { stationId, readings, nonce }
  );

  if (commitRes.status !== 200) {
    console.error('Commit failed:', commitRes.status, commitRes.data);
    process.exit(1);
  }

  const commitData = unwrapApiData(commitRes.data);
  const commitmentId = commitData.commitmentId;
  console.log('Commit accepted. commitmentId=', commitmentId, 'revealDeadline=', commitData.revealDeadline);

  console.log('Submitting reveal...');
  let revealRes = await postJson(
    BACKEND_HOST,
    BACKEND_PORT,
    '/api/weather/reveal',
    { commitmentId, readings, nonce }
  );

  if (revealRes.status === 409) {
    console.log('Reveal is early; attempting to mine blocks and retry...');
    for (let i = 0; i < 5; i += 1) {
      const mined = await mineBlock();
      console.log(`  mine attempt ${i + 1}:`, mined.status);
      await sleep(600);
    }

    revealRes = await postJson(
      BACKEND_HOST,
      BACKEND_PORT,
      '/api/weather/reveal',
      { commitmentId, readings, nonce }
    );
  }

  if (revealRes.status !== 200) {
    console.error('Reveal failed:', revealRes.status, revealRes.data);
    process.exit(1);
  }

  const revealData = unwrapApiData(revealRes.data);
  console.log('Reveal accepted:', {
    receiptId: revealData.receiptId,
    accuracyScore: revealData.accuracyScore,
    rewardEstimate: revealData.rewardEstimate,
  });

  const listRes = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BACKEND_HOST,
        port: BACKEND_PORT,
        path: `/api/weather/commitments/${encodeURIComponent(stationId)}`,
        method: 'GET',
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode, data: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

  if (listRes.status !== 200) {
    console.error('Commitment list failed:', listRes.status, listRes.data);
    process.exit(1);
  }

  const listData = unwrapApiData(listRes.data);
  console.log('Latest commitment status:', listData[0]?.status);
  console.log('Commit/reveal smoke test passed.');
}

main().catch((error) => {
  console.error('Test execution failed:', error);
  process.exit(1);
});
