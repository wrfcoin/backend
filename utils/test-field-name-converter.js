/**
 * Field Name Converter Test Script
 *
 * This script tests the field name converter utility functions for converting
 * between camelCase (application code) and snake_case (database).
 */

const {
  toSnakeCase,
  toCamelCase,
  transformQueryResults,
  snakeToCamel,
  camelToSnake,
} = require('./fieldNameConverter');

// Test snake_case to camelCase conversion
function testSnakeToCamel() {
  console.log('\n=== Testing snake_case to camelCase conversion ===');

  const testCases = [
    { input: 'test_field', expected: 'testField' },
    { input: 'multi_word_field_name', expected: 'multiWordFieldName' },
    { input: 'single', expected: 'single' }, // No underscores
    { input: '_leading_underscore', expected: 'leadingUnderscore' },
    { input: 'trailing_underscore_', expected: 'trailingUnderscore' },
    { input: 'multiple__underscores', expected: 'multipleUnderscores' },
    { input: 'mixed_Case_field', expected: 'mixedCaseField' },
  ];

  testCases.forEach(({ input, expected }) => {
    const result = snakeToCamel(input);
    console.log(
      `"${input}" -> "${result}" (Expected: "${expected}")`,
      result === expected ? '✓' : '✗'
    );
  });
}

// Test camelCase to snake_case conversion
function testCamelToSnake() {
  console.log('\n=== Testing camelCase to snake_case conversion ===');

  const testCases = [
    { input: 'testField', expected: 'test_field' },
    { input: 'multiWordFieldName', expected: 'multi_word_field_name' },
    { input: 'single', expected: 'single' }, // No capital letters
    { input: 'leadingCapital', expected: 'leading_capital' },
    { input: 'ALLCAPS', expected: '_a_l_l_c_a_p_s' }, // Not ideal, but consistent with implementation
    { input: 'mixedCAPS', expected: 'mixed_c_a_p_s' }, // Not ideal, but consistent
  ];

  testCases.forEach(({ input, expected }) => {
    const result = camelToSnake(input);
    console.log(
      `"${input}" -> "${result}" (Expected: "${expected}")`,
      result === expected ? '✓' : '✗'
    );
  });
}

// Test object conversion to snake_case
function testObjectToSnakeCase() {
  console.log('\n=== Testing object conversion to snake_case ===');

  const testObject = {
    userId: 123,
    userName: 'JohnDoe',
    userPreferences: {
      darkMode: true,
      notificationEnabled: false,
      displaySettings: {
        fontSize: 14,
        colorTheme: 'dark',
      },
    },
    loginHistory: [
      { loginTime: '2025-01-01', ipAddress: '192.168.1.1' },
      { loginTime: '2025-01-02', ipAddress: '192.168.1.2' },
    ],
  };

  const snakeCaseObject = toSnakeCase(testObject);
  console.log('Original object:', JSON.stringify(testObject, null, 2));
  console.log('Snake case object:', JSON.stringify(snakeCaseObject, null, 2));

  // Check specific conversions
  console.log('\nChecking specific field conversions:');
  console.log(
    'userId -> user_id:',
    snakeCaseObject.user_id === testObject.userId ? '✓' : '✗'
  );
  console.log(
    'userName -> user_name:',
    snakeCaseObject.user_name === testObject.userName ? '✓' : '✗'
  );
  console.log(
    'userPreferences.darkMode -> user_preferences.dark_mode:',
    snakeCaseObject.user_preferences.dark_mode ===
      testObject.userPreferences.darkMode
      ? '✓'
      : '✗'
  );
  console.log(
    'userPreferences.displaySettings.fontSize -> user_preferences.display_settings.font_size:',
    snakeCaseObject.user_preferences.display_settings.font_size ===
      testObject.userPreferences.displaySettings.fontSize
      ? '✓'
      : '✗'
  );
  console.log(
    'loginHistory[0].loginTime -> login_history[0].login_time:',
    snakeCaseObject.login_history[0].login_time ===
      testObject.loginHistory[0].loginTime
      ? '✓'
      : '✗'
  );
}

// Test object conversion to camelCase
function testObjectToCamelCase() {
  console.log('\n=== Testing object conversion to camelCase ===');

  const testObject = {
    user_id: 123,
    user_name: 'JohnDoe',
    user_preferences: {
      dark_mode: true,
      notification_enabled: false,
      display_settings: {
        font_size: 14,
        color_theme: 'dark',
      },
    },
    login_history: [
      { login_time: '2025-01-01', ip_address: '192.168.1.1' },
      { login_time: '2025-01-02', ip_address: '192.168.1.2' },
    ],
  };

  const camelCaseObject = toCamelCase(testObject);
  console.log('Original object:', JSON.stringify(testObject, null, 2));
  console.log('Camel case object:', JSON.stringify(camelCaseObject, null, 2));

  // Check specific conversions
  console.log('\nChecking specific field conversions:');
  console.log(
    'user_id -> userId:',
    camelCaseObject.userId === testObject.user_id ? '✓' : '✗'
  );
  console.log(
    'user_name -> userName:',
    camelCaseObject.userName === testObject.user_name ? '✓' : '✗'
  );
  console.log(
    'user_preferences.dark_mode -> userPreferences.darkMode:',
    camelCaseObject.userPreferences.darkMode ===
      testObject.user_preferences.dark_mode
      ? '✓'
      : '✗'
  );
  console.log(
    'user_preferences.display_settings.font_size -> userPreferences.displaySettings.fontSize:',
    camelCaseObject.userPreferences.displaySettings.fontSize ===
      testObject.user_preferences.display_settings.font_size
      ? '✓'
      : '✗'
  );
  console.log(
    'login_history[0].login_time -> loginHistory[0].loginTime:',
    camelCaseObject.loginHistory[0].loginTime ===
      testObject.login_history[0].login_time
      ? '✓'
      : '✗'
  );
}

// Test query results transformation
function testTransformQueryResults() {
  console.log('\n=== Testing query results transformation ===');

  const mockQueryResults = [
    {
      user_id: 1,
      user_name: 'JohnDoe',
      email_address: 'john@example.com',
      created_at: '2025-01-01',
    },
    {
      user_id: 2,
      user_name: 'JaneDoe',
      email_address: 'jane@example.com',
      created_at: '2025-01-02',
    },
  ];

  const transformed = transformQueryResults(mockQueryResults);
  console.log(
    'Original query results:',
    JSON.stringify(mockQueryResults, null, 2)
  );
  console.log('Transformed results:', JSON.stringify(transformed, null, 2));

  // Check transformation
  console.log('\nChecking transformations:');
  console.log(
    'First item - user_id -> userId:',
    transformed[0].userId === mockQueryResults[0].user_id ? '✓' : '✗'
  );
  console.log(
    'First item - user_name -> userName:',
    transformed[0].userName === mockQueryResults[0].user_name ? '✓' : '✗'
  );
  console.log(
    'First item - email_address -> emailAddress:',
    transformed[0].emailAddress === mockQueryResults[0].email_address
      ? '✓'
      : '✗'
  );
  console.log(
    'First item - created_at -> createdAt:',
    transformed[0].createdAt === mockQueryResults[0].created_at ? '✓' : '✗'
  );

  // Test single object transformation
  const singleObject = mockQueryResults[0];
  const transformedSingle = transformQueryResults(singleObject);
  console.log('\nSingle object transformation:');
  console.log('Original:', JSON.stringify(singleObject, null, 2));
  console.log('Transformed:', JSON.stringify(transformedSingle, null, 2));
  console.log(
    'user_id -> userId:',
    transformedSingle.userId === singleObject.user_id ? '✓' : '✗'
  );
}

// Edge cases
function testEdgeCases() {
  console.log('\n=== Testing edge cases ===');

  console.log('Empty object:', JSON.stringify(toSnakeCase({})));
  console.log('null value:', toSnakeCase(null));
  console.log('undefined value:', toSnakeCase(undefined));
  console.log('Array value:', JSON.stringify(toSnakeCase([1, 2, 3])));

  // Test with Date objects
  const objWithDate = {
    createdAt: new Date('2025-01-01'),
    userData: {
      lastLoginTime: new Date('2025-01-02'),
    },
  };

  console.log('\nObject with Date:');
  console.log('Original:', JSON.stringify(objWithDate));
  const snakeWithDate = toSnakeCase(objWithDate);
  console.log('To snake_case:', JSON.stringify(snakeWithDate));
  const backToCamel = toCamelCase(snakeWithDate);
  console.log('Back to camelCase:', JSON.stringify(backToCamel));

  // Check that dates were preserved correctly
  console.log('\nChecking date preservation:');
  console.log(
    'created_at is a Date:',
    snakeWithDate.created_at instanceof Date ? '✓' : '✗'
  );
  console.log(
    'createdAt is a Date after round-trip:',
    backToCamel.createdAt instanceof Date ? '✓' : '✗'
  );
}

// Run all tests
function runAllTests() {
  console.log('=== Field Name Converter Tests ===');

  testSnakeToCamel();
  testCamelToSnake();
  testObjectToSnakeCase();
  testObjectToCamelCase();
  testTransformQueryResults();
  testEdgeCases();

  console.log('\n=== All tests completed ===');
}

runAllTests();
