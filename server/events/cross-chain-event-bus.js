const EventEmitter = require('events');

const CROSS_CHAIN_EVENT_TYPES = {
  BRIDGE_TRANSACTION: 'bridge:transaction',
};

const crossChainEventBus = new EventEmitter();

function emitBridgeTransactionEvent(payload) {
  crossChainEventBus.emit(CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION, payload);
}

module.exports = {
  CROSS_CHAIN_EVENT_TYPES,
  crossChainEventBus,
  emitBridgeTransactionEvent,
};
