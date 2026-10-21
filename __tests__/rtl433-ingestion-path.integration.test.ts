// #1021: this mock carried `{ virtual: true }`, which tells Jest the specifier
// CANNOT be resolved. `axios` resolves fine, and a virtual registration loses to
// the real module as soon as anything else in the worker has resolved it — the
// #1017 non-binding shape. Nothing here asserted on axios, so an unbound mock
// was invisible: the service would build a REAL client and the suite would still
// pass, because every assertion below targets a different mock.
//
// `mockAxiosCreate` is hoisted out of the factory so the binding is now ASSERTED
// (see 'the axios mock is actually bound' below), following #1019/#1022.
const mockAxiosCreate = jest.fn();

jest.mock('axios', () => {
  const httpClient = {
    defaults: {
      headers: {
        common: {},
      },
    },
    get: jest.fn(),
    post: jest.fn(),
  };
  mockAxiosCreate.mockReturnValue(httpClient);

  return {
    __esModule: true,
    default: {
      create: mockAxiosCreate,
    },
  };
});

const mockDurableWrite = jest.fn();
const mockGetIdempotency = jest.fn();
const mockPutIdempotency = jest.fn();
const mockNewDurableId = jest.fn();
const mockResolveIdempotencyKey = jest.fn();
const mockPersistWeatherSubmission = jest.fn();

jest.doMock('../shared/route-durable-store.js', () => ({
  routeDurableStore: {
    write: mockDurableWrite,
    getIdempotency: mockGetIdempotency,
    putIdempotency: mockPutIdempotency,
  },
  newDurableId: mockNewDurableId,
  resolveIdempotencyKey: mockResolveIdempotencyKey,
}));

jest.doMock('../server/services/weather-submission-persistence.js', () => ({
  persistWeatherSubmission: mockPersistWeatherSubmission,
}));

jest.doMock('../server/utils/metrics.js', () => ({
  recordWeatherPayloadFormatMetric: jest.fn(),
}));

jest.doMock('../server/utils/logger.js', () => ({
  weatherLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.doMock('../utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

let RTL433SubmissionService: typeof import('../services/weather/rtl433-submission-service.js').RTL433SubmissionService;

describe('RTL-433 ingestion path', () => {
  const observedAt = new Date(1712718645123).toISOString();
  let weatherRecords: Record<string, Record<string, unknown>>;

  beforeAll(() => {
    RTL433SubmissionService = require('../services/weather/rtl433-submission-service.js').RTL433SubmissionService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    weatherRecords = {};
    mockDurableWrite.mockImplementation(async (fn: Function) =>
      fn({ weather: { records: weatherRecords } })
    );
    mockGetIdempotency.mockResolvedValue(null);
    mockPutIdempotency.mockResolvedValue(undefined);
    mockNewDurableId.mockReturnValue('weather-rtl433-001');
    mockResolveIdempotencyKey.mockImplementation((key: unknown) =>
      typeof key === 'string' ? key : null
    );
    mockPersistWeatherSubmission.mockResolvedValue({
      submissionId: 433,
      submittedAt: observedAt,
    });
  });

  // #1021/#1017: the assertions below never touch axios, so a non-binding mock
  // would let this suite exercise a REAL http client and still pass. This pins
  // the binding itself — if the registration ever stops taking, THIS fails
  // instead of the defect going silent.
  it('the axios mock is actually bound (guards #1017-class non-binding)', () => {
    const service = new RTL433SubmissionService('http://backend:4001', 'internal');
    expect(service).toBeDefined();
    expect(jest.isMockFunction(mockAxiosCreate)).toBe(true);
    expect(mockAxiosCreate).toHaveBeenCalledTimes(1);
  });

  it('executes real canonicalization, validation, durable write, and persistence', async () => {
    const service = new RTL433SubmissionService(
      'http://backend:4001',
      'internal'
    );

    await expect(
      service.submitReading({
        stationId: 'rtl433-acurite-42',
        timestamp: 1712718645123,
        temperature_c: 22.5,
        humidity_percent: 65,
        wind_speed_ms: 3.47,
        wind_direction_deg: 180,
        source: 'rf-sdr',
        protocol: 'acurite',
        messageId: 42,
      })
    ).resolves.toBe(true);

    expect(mockPersistWeatherSubmission).toHaveBeenCalledTimes(1);
    expect(mockPersistWeatherSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: 'rtl433-acurite-42',
        timestamp: observedAt,
        temperature: 22.5,
        humidity: 65,
        windSpeed: 3.47,
        windDirection: 180,
        transportMeta: {
          source: 'rtl433-ingestion',
          userId: null,
          walletAddress: null,
          location: null,
        },
      })
    );
    expect(weatherRecords['weather-rtl433-001']).toEqual(
      expect.objectContaining({
        stationId: 'rtl433-acurite-42',
        temperature: 22.5,
        humidity: 65,
        persistence: {
          submissionId: 433,
          submittedAt: observedAt,
        },
      })
    );
    expect(mockPutIdempotency).toHaveBeenCalledWith(
      'weather:data:create',
      'rtl433-acurite-42:1712718645123:42',
      201,
      expect.objectContaining({
        success: true,
        id: 'weather-rtl433-001',
      })
    );
  });

  it('does not resolve before durable persistence completes', async () => {
    let persistenceComplete = false;
    mockPersistWeatherSubmission.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      persistenceComplete = true;
      return {
        submissionId: 433,
        submittedAt: observedAt,
      };
    });

    const service = new RTL433SubmissionService(
      'http://backend:4001',
      'internal'
    );

    await expect(
      service.submitReading({
        stationId: 'rtl433-acurite-42',
        timestamp: 1712718645123,
        temperature_c: 22.5,
        humidity_percent: 65,
        source: 'rf-sdr',
        protocol: 'acurite',
        messageId: 42,
      })
    ).resolves.toBe(true);
    expect(persistenceComplete).toBe(true);
  });

  it('treats internal mode as healthy without needing an HTTP weather API', async () => {
    const service = new RTL433SubmissionService(
      'http://backend:4001',
      'internal'
    );

    await expect(service.healthCheck()).resolves.toBe(true);
  });
});
