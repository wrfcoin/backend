/**
 * Wrfcoin Testing Framework
 *
 * A comprehensive testing framework for the Wrfcoin blockchain that includes:
 * 1. Smart contract testing utilities
 * 2. Weather data validation testers
 * 3. Transaction simulation tools
 * 4. Network simulation helpers
 */

// Import all testing modules
const smartContractTesting = require('./smart-contract-testing');
const weatherDataValidation = require('./weather-data-validation');
const transactionSimulation = require('./transaction-simulation');
const networkSimulation = require('./network-simulation');

// Re-export all testing utilities
module.exports = {
  // Smart Contract Testing Utilities
  ContractTestEnvironment: smartContractTesting.ContractTestEnvironment,
  VulnerabilityScanner: smartContractTesting.VulnerabilityScanner,
  GasAnalyzer: smartContractTesting.GasAnalyzer,

  // Weather Data Validation Testing
  WeatherDataValidator: weatherDataValidation.WeatherDataValidator,
  StationDataValidator: weatherDataValidation.StationDataValidator,
  GridDataValidator: weatherDataValidation.GridDataValidator,
  ReferenceDataComparator: weatherDataValidation.ReferenceDataComparator,
  DataIntegrityChecker: weatherDataValidation.DataIntegrityChecker,

  // Transaction Simulation Tools
  SimulatedTransaction: transactionSimulation.SimulatedTransaction,
  TransactionPoolSimulator: transactionSimulation.TransactionPoolSimulator,
  NetworkPropagationSimulator:
    transactionSimulation.NetworkPropagationSimulator,
  TransactionGenerator: transactionSimulation.TransactionGenerator,

  // Network Simulation Helpers
  SimulatedNode: networkSimulation.SimulatedNode,
  NetworkSimulator: networkSimulation.NetworkSimulator,
  ByzantineSimulator: networkSimulation.ByzantineSimulator,
  ChainSplitSimulator: networkSimulation.ChainSplitSimulator,

  // Exported utility functions
  createSmartContractTestEnvironment: config =>
    new smartContractTesting.ContractTestEnvironment(config),
  createWeatherValidator: config =>
    new weatherDataValidation.WeatherDataValidator(config),
  createTransactionGenerator: config =>
    new transactionSimulation.TransactionGenerator(config),
  createNetworkSimulator: config =>
    new networkSimulation.NetworkSimulator(config),
};
