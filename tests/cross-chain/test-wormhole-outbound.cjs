require('tsx/cjs');

async function run() {
  console.log('🧪 Wormhole Outbound Test (local testnet mode)');
  process.env.WORMHOLE_TEST_MODE = 'mock';

  const {
    __resetWormholeTransferTestState,
    initiateOutboundTransfer,
  } = require('../../server/services/wormhole-transfer-service.ts');

  __resetWormholeTransferTestState();

  const record = await initiateOutboundTransfer(
    {
      sender: '0x1111111111111111111111111111111111111111',
      recipient: '0x2222222222222222222222222222222222222222',
      amount: '50',
      token: 'WRF',
      sourceChain: 'wrfcoin-testnet',
      targetChain: 'sepolia',
      burnTxHash: '0xdef456',
    },
    { execute: async () => ({ rows: [] }) }
  );

  console.log('Transfer ID:', record.transferId);
  console.log('Status:', record.status);

  const ok = record.status === 'attested' && record.data && record.data.attestation;

  if (!ok) {
    console.error('❌ Outbound test failed');
    process.exit(1);
  }
  console.log('✅ Outbound test passed');
}

run().catch((error) => {
  console.error('❌ Outbound test crashed:', error);
  process.exit(1);
});
