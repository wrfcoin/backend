/**
 * Quick Test of Advanced TypeScript Features
 * Demonstrates key patterns without complex dependencies
 */

// 1. BRANDED TYPES
declare const __testFeatureBrand: unique symbol;
declare const __testIdentifier: unique symbol;
type TestBrand<T, TBrand> = T & { [__testIdentifier]: TBrand };

type TestWalletAddress = string & {
  readonly __testFeatureBrand: 'WalletAddress';
} & { [__testIdentifier]: 'WalletAddress' };
type TestTokenAmount = string & {
  readonly __testFeatureBrand: 'TokenAmount';
} & { [__testIdentifier]: 'TokenAmount' };

function createWalletAddress(address: string): TestWalletAddress {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('Invalid wallet address format');
  }
  return address as TestWalletAddress;
}

function createTokenAmount(amount: string): TestTokenAmount {
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error('Invalid token amount format');
  }
  return amount as TestTokenAmount;
}

// 2. CONDITIONAL TYPES
type TestChainId = 'ethereum' | 'polygon' | 'bsc' | 'wrfcoin';

type TestChainData<T extends TestChainId> = T extends 'ethereum' | 'polygon'
  ? { gasPrice: string; gasLimit: number }
  : T extends 'bsc'
    ? { gasPrice: string; bnbFee: string }
    : T extends 'wrfcoin'
      ? { computationalProof?: string }
      : never;

// 3. DISCRIMINATED UNIONS
interface BaseTestWeatherData {
  id: string;
  timestamp: Date;
  stationId: string;
}

interface TestTemperatureData extends BaseTestWeatherData {
  type: 'temperature';
  value: number;
  unit: '°C';
}

interface TestHumidityData extends BaseTestWeatherData {
  type: 'humidity';
  value: number;
  unit: '%';
}

type TestWeatherData = TestTemperatureData | TestHumidityData;

// 4. BUILDER PATTERN
class TestTransactionBuilder<T extends TestChainId> {
  private transaction: Partial<{
    chainId: T;
    from: TestWalletAddress;
    to: TestWalletAddress;
    amount: TestTokenAmount;
    chainData: TestChainData<T>;
  }> = {};

  static create<K extends TestChainId>(chainId: K): TestTransactionBuilder<K> {
    const builder = new TestTransactionBuilder<K>();
    builder.transaction.chainId = chainId;
    return builder;
  }

  setFrom(address: TestWalletAddress): this {
    this.transaction.from = address;
    return this;
  }

  setTo(address: TestWalletAddress): this {
    this.transaction.to = address;
    return this;
  }

  setAmount(amount: TestTokenAmount): this {
    this.transaction.amount = amount;
    return this;
  }

  setChainData(data: TestChainData<T>): this {
    this.transaction.chainData = data;
    return this;
  }

  build() {
    const { chainId, from, to, amount, chainData } = this.transaction;
    if (!chainId || !from || !to || !amount || !chainData) {
      throw new Error('Missing required fields');
    }
    return this.transaction as Required<typeof this.transaction>;
  }
}

// 5. TYPE GUARDS
function isTestTemperatureData(
  data: TestWeatherData
): data is TestTemperatureData {
  return data.type === 'temperature';
}

function isTestHumidityData(data: TestWeatherData): data is TestHumidityData {
  return data.type === 'humidity';
}

// 6. TEMPLATE LITERAL TYPES
type TestApiEndpoint<T extends string> = `/api/v1/${T}`;
type TestWeatherEndpoint = TestApiEndpoint<'weather'>; // "/api/v1/weather"
type TestTransactionEndpoint = TestApiEndpoint<'transactions'>; // "/api/v1/transactions"

// DEMONSTRATION FUNCTION
async function demonstrateAdvancedFeatures() {
  console.log('🚀 Advanced TypeScript Features Demonstration');
  console.log('=============================================\n');

  // 1. Branded Types Demo
  console.log('1. Branded Types for Type Safety');
  console.log('--------------------------------');
  try {
    const wallet = createWalletAddress(
      '0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315'
    );
    const amount = createTokenAmount('10.50000000');
    console.log(`✓ Valid wallet: ${wallet}`);
    console.log(`✓ Valid amount: ${amount}`);
  } catch (error) {
    console.log(
      `✗ Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  try {
    createWalletAddress('invalid-address');
  } catch (error) {
    console.log(
      `✓ Correctly rejected invalid address: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  console.log();

  // 2. Builder Pattern Demo
  console.log('2. Builder Pattern with Type Safety');
  console.log('-----------------------------------');
  try {
    const ethTransaction = TestTransactionBuilder.create('ethereum')
      .setFrom(
        createWalletAddress('0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315')
      )
      .setTo(createWalletAddress('0x8ba1f109551bD432803012645Hac136c13141E'))
      .setAmount(createTokenAmount('5.0'))
      .setChainData({ gasPrice: '20000000000', gasLimit: 21000 })
      .build();

    console.log(
      `✓ Ethereum transaction built for chain: ${ethTransaction.chainId}`
    );
    console.log(`✓ Gas price: ${ethTransaction.chainData.gasPrice}`);
  } catch (error) {
    console.log(
      `✗ Transaction building failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  try {
    const wrfTransaction = TestTransactionBuilder.create('wrfcoin')
      .setFrom(
        createWalletAddress('0x742d35Cc6634C0532925a3b8D56A1F1eFBe5C315')
      )
      .setTo(createWalletAddress('0x8ba1f109551bD432803012645Hac136c13141E'))
      .setAmount(createTokenAmount('10.0'))
      .setChainData({ computationalProof: 'proof-abc123' })
      .build();

    console.log(
      `✓ Wrfcoin transaction built for chain: ${wrfTransaction.chainId}`
    );
    console.log(
      `✓ Computational proof: ${wrfTransaction.chainData.computationalProof}`
    );
  } catch (error) {
    console.log(
      `✗ Wrfcoin transaction building failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  console.log();

  // 3. Discriminated Unions Demo
  console.log('3. Discriminated Unions for Weather Data');
  console.log('----------------------------------------');

  const weatherReadings: TestWeatherData[] = [
    {
      type: 'temperature',
      id: 'temp-001',
      timestamp: new Date(),
      stationId: 'WS001',
      value: 22.5,
      unit: '°C',
    },
    {
      type: 'humidity',
      id: 'humid-001',
      timestamp: new Date(),
      stationId: 'WS001',
      value: 65.2,
      unit: '%',
    },
  ];

  weatherReadings.forEach(data => {
    if (isTestTemperatureData(data)) {
      console.log(
        `✓ Temperature: ${data.value}${data.unit} (TypeScript knows this is temperature data)`
      );
    } else if (isTestHumidityData(data)) {
      console.log(
        `✓ Humidity: ${data.value}${data.unit} (TypeScript knows this is humidity data)`
      );
    }
  });

  console.log();

  // 4. Template Literal Types Demo
  console.log('4. Template Literal Types for API Routes');
  console.log('----------------------------------------');

  const weatherApi: TestWeatherEndpoint = '/api/v1/weather';
  const transactionApi: TestTransactionEndpoint = '/api/v1/transactions';

  console.log(`✓ Weather API endpoint: ${weatherApi}`);
  console.log(`✓ Transaction API endpoint: ${transactionApi}`);
  console.log('✓ TypeScript ensures correct API route format at compile time');

  console.log();

  // 5. Conditional Types Demo
  console.log('5. Conditional Types for Chain-Specific Data');
  console.log('--------------------------------------------');

  // TypeScript knows ethereum requires gasPrice and gasLimit
  const ethData: TestChainData<'ethereum'> = {
    gasPrice: '20000000000',
    gasLimit: 21000,
  };

  // TypeScript knows wrfcoin can have computationalProof
  const wrfData: TestChainData<'wrfcoin'> = {
    computationalProof: 'proof-123',
  };

  console.log(`✓ Ethereum chain data: ${JSON.stringify(ethData)}`);
  console.log(`✓ Wrfcoin chain data: ${JSON.stringify(wrfData)}`);
  console.log(
    '✓ TypeScript enforces different data structures for different chains'
  );

  console.log();

  console.log('🎉 Advanced TypeScript Features Demo Complete!');
  console.log('\nKey Benefits Demonstrated:');
  console.log('• Branded types prevent parameter confusion');
  console.log('• Builder pattern ensures type-safe object construction');
  console.log('• Discriminated unions enable exhaustive type checking');
  console.log('• Template literals provide compile-time string validation');
  console.log('• Conditional types adapt behavior based on input types');
  console.log('• All patterns work together for enterprise-grade type safety');
}

// Run the demonstration
demonstrateAdvancedFeatures()
  .then(() => {
    console.log('\n✅ Demonstration completed successfully');
  })
  .catch(error => {
    console.error('\n❌ Demonstration failed:', error);
  });
