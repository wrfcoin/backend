require('tsx/cjs');

async function run() {
  console.log('🧪 Wormhole Inbound Test (local testnet mode)');
  process.env.WORMHOLE_TEST_MODE = 'mock';

  const {
    __resetWormholeTransferTestState,
    processInboundTransfer,
    getWormholeTransfer,
  } = require('../../server/services/wormhole-transfer-service.ts');

  __resetWormholeTransferTestState();
  const record = await processInboundTransfer(
    {
      emitterChain: 2,
      emitterAddress: '0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78',
      sequence: '1001',
      sourceChain: 'sepolia',
      targetChain: 'wrfcoin-testnet',
      token: 'WRF',
      amount: '100',
      recipient: '0x1111111111111111111111111111111111111111',
      sourceTxHash: '0xabc123',
    },
    { execute: async () => ({ rows: [] }) }
  );
  const fetched = await getWormholeTransfer(record.transferId, {
    execute: async () => ({ rows: [] }),
  });

  console.log('Transfer ID:', record.transferId);
  console.log('Status:', record.status);

  const ok = record.status === 'mint_submitted' && fetched && fetched.transferId === record.transferId;

  if (!ok) {
    console.error('❌ Inbound test failed');
    process.exit(1);
  }
  console.log('✅ Inbound test passed');
}

run().catch((error) => {
  console.error('❌ Inbound test crashed:', error);
  process.exit(1);
});
