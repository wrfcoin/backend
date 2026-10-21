// Every dispatchable method must select a credential and caller policy.
const RPC_METHOD_POLICY = Object.freeze({
  'blockchain.getStatus': 'reader',
  'blockchain.getBlock': 'reader',
  'wallet.getBalance': 'owner-reader',
  'tx.submit': 'permissionless',
  'oracle.getForecast': 'local',
});
module.exports = { RPC_METHOD_POLICY };
