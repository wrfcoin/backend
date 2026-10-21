import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
  rmdirSync: jest.fn(),
}));

let mockFs: any;

describe('container orchestrator bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockFs = jest.requireMock('fs');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('writes API_KEY_ENCRYPTION_KEY into the Docker bootstrap env file', async () => {
    process.env.POSTGRES_PASSWORD = 'postgres-pass';
    process.env.API_KEY_ENCRYPTION_KEY = 'api-key-secret';

    const { ContainerOrchestrator, ENGINE } = require('../utils/container-orchestrator.js');
    const orchestrator = new ContainerOrchestrator({
      engine: ENGINE.DOCKER,
      logLevel: 'error',
    });
    jest
      .spyOn(orchestrator, 'executeCommand')
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await expect(orchestrator.startDocker()).resolves.toBe(true);

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, envContent] = mockFs.writeFileSync.mock.calls[0];
    expect(envContent as string).toContain('POSTGRES_PASSWORD=postgres-pass');
    expect(envContent as string).toContain('API_KEY_ENCRYPTION_KEY=api-key-secret');
  });

  it('writes API_KEY_ENCRYPTION_KEY into the Kubernetes secret generator', async () => {
    process.env.POSTGRES_PASSWORD = 'postgres-pass';
    process.env.API_KEY_ENCRYPTION_KEY = 'api-key-secret';

    const { ContainerOrchestrator, ENGINE } = require('../utils/container-orchestrator.js');
    const orchestrator = new ContainerOrchestrator({
      engine: ENGINE.KUBERNETES,
      logLevel: 'error',
    });
    jest
      .spyOn(orchestrator, 'executeCommand')
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await expect(orchestrator.startKubernetes()).resolves.toBe(true);

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, kustomizationContent] = mockFs.writeFileSync.mock.calls[0];
    expect(kustomizationContent as string).toContain(
      'POSTGRES_PASSWORD=postgres-pass'
    );
    expect(kustomizationContent as string).toContain(
      'API_KEY_ENCRYPTION_KEY=api-key-secret'
    );
  });
});
