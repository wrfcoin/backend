/**
 * backend#1236 (codex round 9, P2): servers the first inventory missed.
 *   - services/etl/pipeline_server.js (CORS_ORIGIN || [localhost]) — booted in
 *     the layout infra/docker/Dockerfile.etl builds, with the helper copied
 *     to the same relative path (infra companion adds that COPY).
 *   - services/feedback-collection-service.ts (allowedOrigins || '*') —
 *     applies CORS in its constructor, so construction is its startup.
 *   - graphql/server.ts and server/routes/climate-model-routes.js
 *     (FRONTEND_URL || localhost).
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ORIGIN = 'https://wrfcoin-testnet.taila1c049.ts.net';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

describe('ETL pipeline server in its Dockerfile.etl image layout', () => {
  let image: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    // /app/package.json (no "type": CommonJS), /app/src/etl/, /app/server/utils/
    image = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-image-1236-'));
    fs.writeFileSync(path.join(image, 'package.json'), JSON.stringify({ name: 'etl-image-layout', private: true }));
    fs.mkdirSync(path.join(image, 'src/etl'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'services/etl/pipeline_server.js'), path.join(image, 'src/etl/pipeline_server.js'));
    fs.mkdirSync(path.join(image, 'server/utils'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'server/utils/strict-cors-config.js'),
      path.join(image, 'server/utils/strict-cors-config.js'),
    );
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(image, 'node_modules'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  afterAll(() => {
    fs.rmSync(image, { recursive: true, force: true });
  });

  function boot(env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, ['src/etl/pipeline_server.js'], {
      cwd: image,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { out += d; });
    const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    return { child, exit, output: () => out };
  }

  it.each(['', 'http://localhost:5000', 'https://*.example.org'])(
    'production CORS_ORIGIN=%j refuses to start (exit 1)',
    async corsOrigin => {
      const port = await freePort();
      const b = boot({ NODE_ENV: 'production', CORS_ORIGIN: corsOrigin, PORT: String(port) });
      const code = await Promise.race([
        b.exit,
        new Promise(resolve => setTimeout(() => resolve('timeout'), 20_000).unref()),
      ]);
      expect(code).not.toBe(0);
      expect(code).not.toBe('timeout');
      expect(b.output()).toMatch(/Refusing to start with NODE_ENV=production/);
    },
    30_000,
  );

  it('production with a public origin serves that origin only', async () => {
    const port = await freePort();
    const b = boot({ NODE_ENV: 'production', CORS_ORIGIN: PUBLIC_ORIGIN, PORT: String(port) });
    let res: Response | undefined;
    for (let i = 0; i < 100 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: PUBLIC_ORIGIN } });
      } catch {
        if (b.child.exitCode !== null) throw new Error(b.output());
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    expect(res).toBeDefined();
    expect(res!.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN);
    const loopback = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'http://localhost:5000' } });
    expect(loopback.headers.get('access-control-allow-origin')).toBeNull();
  }, 30_000);
});

describe('feedback-collection OracleAPIService applies CORS at construction', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
  });

  function construct(allowedOrigins?: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OracleAPIService } = require('../services/feedback-collection-service');
    return new OracleAPIService({} as any, {
      port: 0,
      enableCORS: true,
      allowedOrigins,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
    } as any);
  }

  it.each([
    ['no allowedOrigins and no CORS_ORIGIN', undefined, ''],
    ['a loopback allowedOrigins entry', ['http://localhost:3000'], PUBLIC_ORIGIN],
    ["a '*' allowedOrigins entry", ['*'], PUBLIC_ORIGIN],
  ])('production refuses %s', (_label, allowed, cors) => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = cors;
    expect(() => construct(allowed)).toThrow(/Refusing to start with NODE_ENV=production/);
  });

  it('production accepts CORS_ORIGIN or a valid explicit list', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = PUBLIC_ORIGIN;
    expect(() => construct()).not.toThrow();
    expect(() => construct(['https://feedback.example.org'])).not.toThrow();
  });

  it("development keeps the historical '*' default", () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGIN;
    expect(() => construct()).not.toThrow();
  });
});

describe('FRONTEND_URL servers route through the helper', () => {
  it.each(['graphql/server.ts', 'server/routes/climate-model-routes.js'])('%s', file => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toMatch(/resolveServiceCorsOrigins\(process\.env\.FRONTEND_URL/);
    expect(source).not.toMatch(/FRONTEND_URL \|\| 'http:\/\/localhost/);
  });
});
