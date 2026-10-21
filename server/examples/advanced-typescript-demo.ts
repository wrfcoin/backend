#!/usr/bin/env node
/**
 * Advanced TypeScript Features Demo
 *
 * Demonstrates the practical implementation of advanced TypeScript patterns
 * in the Wrfcoin platform with real examples and usage scenarios.
 */

import {
  createWeatherDataService,
  createStationId,
  createQualityScore,
} from '../services/weather-data-service.js';
import {
  createBlockchainTransactionService,
  TransactionBuilder,
} from '../services/blockchain-transaction-service.js';
import {
  createWalletAddress,
  createTokenAmount,
  createTransactionHash,
} from '../../shared/types/runtime-validation.js';
import { MiddlewareChain } from '../middleware/advanced-validation.js';

async function demonstrateAdvancedTypeScriptFeatures() {
  console.log('🚀 Advanced TypeScript Features Demo');
  console.log('=====================================\n');

  // 1. BRANDED TYPES DEMONSTRATION
  console.log('1. Branded Types for Type Safety');
  console.log('--------------------------------');

  try {
    const stationId = createStationId('WS001234');
    const walletAddress = createWalletAddress(
      '0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315'
    );
    const tokenAmount = createTokenAmount('10.50000000');

    console.log(`✓ Valid station ID: ${stationId}`);
    console.log(`✓ Valid wallet address: ${walletAddress}`);
    console.log(`✓ Valid token amount: ${tokenAmount}`);
  } catch (error) {
    console.log(
      `✗ Validation error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    // This will fail due to branded type validation
    const invalidWallet = createWalletAddress('invalid-address');
  } catch (error) {
    console.log(
      `✓ Caught invalid wallet address: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log();

  // 2. DISCRIMINATED UNIONS FOR WEATHER DATA
  console.log('2. Discriminated Unions for Weather Data');
  console.log('---------------------------------------');

  const weatherService = createWeatherDataService();

  // Valid temperature data
  const temperatureData = {
    type: 'temperature',
    id: 'temp-001',
    stationId: 'WS001234',
    timestamp: new Date(),
    quality: 'high',
    value: 22.5,
    unit: '°C',
    dewPoint: 18.3,
  };

  const stationId = createStationId('WS001234');
  const walletAddress = createWalletAddress(
    '0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315'
  );

  const result = await weatherService.submitWeatherData(
    stationId,
    walletAddress,
    temperatureData
  );
  console.log(
    `✓ Weather data submission: ${result.success ? 'Success' : 'Failed'}`
  );
  if (result.reward) {
    console.log(`✓ Reward calculated: ${result.reward} WRF`);
  }

  console.log();

  // 3. BUILDER PATTERN WITH TYPE SAFETY
  console.log('3. Builder Pattern with Fluent Interface');
  console.log('---------------------------------------');

  const transactionService = createBlockchainTransactionService();
  await transactionService.initialize();

  try {
    const transaction = TransactionBuilder.create('ethereum')
      .setFrom(
        createWalletAddress('0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315')
      )
      .setTo(createWalletAddress('0x8ba1f109551bD432803012645Hac136c13141E'))
      .setAmount(createTokenAmount('5.0'))
      .setChainData({
        gasPrice: '20000000000',
        gasLimit: 21000,
        nonce: 42,
      })
      .build();

    console.log(`✓ Transaction built for ${transaction.chainId}`);
    console.log(`✓ From: ${transaction.from}`);
    console.log(`✓ To: ${transaction.to}`);
    console.log(`✓ Amount: ${transaction.amount}`);
    console.log(`✓ Gas price: ${transaction.chainData.gasPrice}`);
  } catch (error) {
    console.log(
      `✗ Transaction building failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log();

  // 4. CONDITIONAL TYPES FOR CHAIN-SPECIFIC DATA
  console.log('4. Conditional Types for Chain-Specific Data');
  console.log('--------------------------------------------');

  // Ethereum transaction (requires gas fields)
  const ethTransaction = await transactionService.createTransaction(
    'ethereum',
    createWalletAddress('0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315'),
    createWalletAddress('0x8ba1f109551bD432803012645Hac136c13141E'),
    createTokenAmount('1.5'),
    {
      gasPrice: '25000000000',
      gasLimit: 21000,
      nonce: 43,
    }
  );

  console.log(`✓ Ethereum transaction created: ${ethTransaction.id}`);
  console.log(
    `✓ Chain-specific data includes gas price: ${ethTransaction.chainData.gasPrice}`
  );

  // Wrfcoin transaction (different chain data structure)
  const wrfTransaction = await transactionService.createTransaction(
    'wrfcoin',
    createWalletAddress('0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315'),
    createWalletAddress('0x8ba1f109551bD432803012645Hac136c13141E'),
    createTokenAmount('10.0'),
    {
      computationalProof: 'proof-abc123',
      weatherDataHash: 'hash-def456',
    }
  );

  console.log(`✓ Wrfcoin transaction created: ${wrfTransaction.id}`);
  console.log(
    `✓ Chain-specific data includes computational proof: ${wrfTransaction.chainData.computationalProof}`
  );

  console.log();

  // 5. EVENT SYSTEM WITH TYPED EVENTS
  console.log('5. Event System with Type Safety');
  console.log('--------------------------------');

  // Subscribe to typed events
  weatherService.on('data:validated', event => {
    console.log(`✓ Weather data validated for station ${event.stationId}`);
    console.log(
      `✓ Data type: ${event.data.type}, Quality: ${event.qualityScore}`
    );
  });

  weatherService.on('reward:calculated', event => {
    console.log(
      `✓ Reward calculated: ${event.amount} WRF for ${event.walletAddress}`
    );
  });

  transactionService.on('transaction:created', event => {
    console.log(
      `✓ Transaction created with estimated fee: ${event.estimatedFee}`
    );
  });

  // Submit another weather data point to trigger events
  const humidityData = {
    type: 'humidity',
    id: 'humid-001',
    stationId: 'WS001234',
    timestamp: new Date(),
    quality: 'medium',
    value: 65.2,
    unit: '%',
    relativeHumidity: 68.1,
  };

  await weatherService.submitWeatherData(
    stationId,
    walletAddress,
    humidityData
  );

  console.log();

  // 6. MIDDLEWARE CHAIN COMPOSITION
  console.log('6. Composable Middleware with Type Safety');
  console.log('-----------------------------------------');

  const weatherMiddleware = new MiddlewareChain()
    .addValidation('/api/v1/weather')
    .addPermission('write')
    .addDataFreshness('weather', '15m')
    .build();

  const transactionMiddleware = new MiddlewareChain()
    .addValidation('/api/v1/transactions')
    .addPermission('write')
    .addChainValidation('ethereum')
    .build();

  console.log(
    `✓ Weather middleware chain: ${weatherMiddleware.length} middleware functions`
  );
  console.log(
    `✓ Transaction middleware chain: ${transactionMiddleware.length} middleware functions`
  );
  console.log(
    '✓ Type-safe middleware composition with compile-time validation'
  );

  console.log();

  // 7. PERFORMANCE FEATURES DEMONSTRATION
  console.log('7. Performance Optimization Features');
  console.log('------------------------------------');

  // Demonstrate caching and memoization
  const metrics1 = await weatherService.getStationQualityMetrics(stationId);
  console.log(
    `✓ First metrics call - Average quality: ${metrics1.averageQuality}`
  );

  const metrics2 = await weatherService.getStationQualityMetrics(stationId);
  console.log(
    `✓ Second metrics call (cached) - Average quality: ${metrics2.averageQuality}`
  );

  console.log();

  // 8. RUNTIME VALIDATION WITH COMPILE-TIME TYPES
  console.log('8. Runtime Validation with Compile-Time Types');
  console.log('----------------------------------------------');

  // Valid data passes both runtime and compile-time checks
  const validData = {
    type: 'pressure' as const,
    id: 'press-001',
    stationId: 'WS001234',
    timestamp: new Date(),
    quality: 'high' as const,
    value: 1013.25,
    unit: 'hPa' as const,
    seaLevelPressure: 1013.25,
  };

  try {
    const pressureResult = await weatherService.submitWeatherData(
      stationId,
      walletAddress,
      validData
    );
    console.log(
      `✓ Pressure data validation: ${pressureResult.success ? 'Passed' : 'Failed'}`
    );
  } catch (error) {
    console.log(
      `✗ Pressure data validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Invalid data caught by runtime validation
  const invalidData = {
    type: 'temperature',
    id: 'temp-002',
    stationId: 'WS001234',
    timestamp: new Date(),
    quality: 'high',
    value: 150, // Invalid temperature
    unit: '°C',
  };

  try {
    await weatherService.submitWeatherData(
      stationId,
      walletAddress,
      invalidData
    );
  } catch (error) {
    console.log(
      `✓ Invalid temperature caught: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log();

  // 9. TYPE-SAFE QUERIES WITH CONDITIONAL RETURNS
  console.log('9. Type-Safe Queries with Conditional Returns');
  console.log('----------------------------------------------');

  try {
    // TypeScript knows this returns only temperature data
    const temperatureReadings = await weatherService.getWeatherDataByType(
      'temperature',
      stationId
    );
    console.log(
      `✓ Temperature readings: ${temperatureReadings.length} records`
    );

    // TypeScript knows this returns only humidity data
    const humidityReadings = await weatherService.getWeatherDataByType(
      'humidity',
      stationId
    );
    console.log(`✓ Humidity readings: ${humidityReadings.length} records`);

    // Get Ethereum transactions (TypeScript ensures correct chain data type)
    const ethTransactions =
      transactionService.getTransactionsByChain('ethereum');
    console.log(`✓ Ethereum transactions: ${ethTransactions.length} records`);

    if (ethTransactions.length > 0) {
      // TypeScript knows chainData has gasPrice property for Ethereum
      console.log(
        `✓ First Ethereum tx gas price: ${ethTransactions[0].chainData.gasPrice}`
      );
    }
  } catch (error) {
    console.log(
      `✗ Query failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log();

  // 10. CLEANUP AND SUMMARY
  console.log('10. Cleanup and Summary');
  console.log('----------------------');

  await weatherService.shutdown();
  await transactionService.shutdown();

  console.log('✓ Services cleaned up successfully');
  console.log('\n🎉 Advanced TypeScript Features Demo Complete!');
  console.log('\nKey Benefits Demonstrated:');
  console.log('• Branded types prevent type confusion at compile time');
  console.log('• Discriminated unions enable exhaustive type checking');
  console.log('• Builder pattern provides fluent, type-safe APIs');
  console.log('• Conditional types adapt behavior based on input types');
  console.log('• Event system ensures type safety for event payloads');
  console.log('• Middleware chains compose with full type checking');
  console.log('• Performance features maintain type safety');
  console.log('• Runtime validation integrates with compile-time types');
  console.log('• Query methods return precisely typed results');
  console.log('• All patterns work together for enterprise-grade type safety');
}

// Run the demo
if (require.main === module) {
  demonstrateAdvancedTypeScriptFeatures()
    .then(() => {
      console.log('\n✅ Demo completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Demo failed:', error);
      process.exit(1);
    });
}

export { demonstrateAdvancedTypeScriptFeatures };
