import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';

// Stateful Redis sorted sets drive the real wallet-login middleware.
function redisFake() {
  const sets = new Map<string, Array<{score:number; member:string}>>();
  return {
    status:'ready', on:jest.fn(), connect:jest.fn(async()=>undefined), quit:jest.fn(async()=>'OK'), disconnect:jest.fn(),
    ttl:jest.fn(async()=>-2), exists:jest.fn(async()=>0), incr:jest.fn(async()=>1), expire:jest.fn(async()=>1), setex:jest.fn(async()=>'OK'), del:jest.fn(async()=>1),
    pipeline:()=>{
      const ops:Array<()=>unknown>=[];
      const p:any={
        zremrangebyscore:(k:string,min:number,max:number)=>{ops.push(()=>{sets.set(k,(sets.get(k)||[]).filter(e=>e.score<min||e.score>max));return 0;});return p;},
        zadd:(k:string,score:number,member:string)=>{ops.push(()=>{sets.set(k,[...(sets.get(k)||[]),{score,member}]);return 1;});return p;},
        zcard:(k:string)=>{ops.push(()=>(sets.get(k)||[]).length);return p;},
        expire:()=>{ops.push(()=>1);return p;}, exec:async()=>ops.map(op=>[null,op()]),
      };return p;
    },
  };
}
jest.mock('ioredis',()=>jest.fn().mockImplementation(()=>(global as any).__bondRedis));
jest.mock('../utils/create-redis.js',()=>({createRedisClient:jest.fn()}));
jest.mock('../utils/logger.js',()=>({appLogger:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}}));
const originalEnv={...process.env};
const originalFetch=global.fetch;
const token='test-bond-service-secret-never-echo';
const row={ownerAddress:'0x'+'1'.repeat(40),peerId:'12D3KooW'+'1'.repeat(44),serverKey:'ab'.repeat(32),txHash:'0x'+'cd'.repeat(32),time:'2026-10-23T00:00:00Z',bonded:null};
let app:express.Express;
let upstream:any;
let logger:any;
async function proof() {
  const r=await request(app).post('/api/onboarding/faucet/challenge').send({});
  expect(r.status).toBe(200);
  const numbers=r.body.question.match(/\d+/g).map(Number);
  return {challengeId:r.body.challengeId,answer:numbers[0]+numbers[1]};
}
function makeApp(parsed=false, limited=false) {
  const a=express();
  if(limited){
    const mod=require('../../shared/middleware/rate-limit-redis');
    // Same instance/config/paths as the deployed entrypoint.
    const limiter=mod.createRateLimitMiddleware({...mod.RATE_LIMIT_PRESETS.auth,message:'Too many wallet login attempts, please try again later.'});
    a.use(['/api/auth/nonce','/api/auth/wallet-login','/api/faucet/bond-grant','/api/faucet/bond-grants'],limiter);
  }
  if(parsed)a.use(express.json({limit:'1mb'}));
  a.use('/api/onboarding',require('../routes/onboarding-routes').default);
  a.use('/api/faucet',require('../routes/faucet-bond-routes').default);
  return a;
}
beforeEach(()=>{
  jest.resetModules();
  process.env={...originalEnv,FAUCET_SERVICE_URL:'http://faucet.invalid/faucet/request',FAUCET_SERVICE_TOKEN:token,RATE_LIMIT_AUTH_MAX_REQUESTS:'5',TRUSTED_PROXIES:'127.0.0.1,::1',DISABLE_FILE_LOG_TRANSPORTS:'true'};
  (global as any).__bondRedis=redisFake();
  upstream=jest.fn(async()=>new Response(JSON.stringify({ok:true,amount:'250.36',receipt:{txHash:row.txHash,ownerAddress:row.ownerAddress}}),{status:200}));
  global.fetch=upstream;
  app=makeApp(true);
  logger=require('../utils/logger').appLogger;
});
afterEach(()=>{process.env={...originalEnv};global.fetch=originalFetch;jest.restoreAllMocks();delete (global as any).__bondRedis;});

describe('bond-grant proxy',()=>{
  it('forwards all JSON fields unchanged with only the service bearer, after a real shared captcha',async()=>{
    const body={...row,height:998,blockHash:'ee'.repeat(32),signature:'ff'.repeat(64),extra:{preserve:'yes'},...await proof()};
    const r=await request(app).post('/api/faucet/bond-grant').set('Authorization','Bearer caller-token').send(body);
    expect(r.status).toBe(200);
    const [url,options]=upstream.mock.calls[0];
    expect(String(url)).toBe('http://faucet.invalid/faucet/bond-grant');
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers.authorization).toBe('Bearer '+token);
    expect(options.redirect).toBe('manual');
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(token);
    const replay=await request(app).post('/api/faucet/bond-grant').send(body);
    expect(replay.status).toBe(400);expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('refuses missing and incorrect captcha without upstream access',async()=>{
    const missing=await request(app).post('/api/faucet/bond-grant').send(row);
    expect(missing.status).toBe(400);expect(missing.body.error.code).toBe('CAPTCHA_FAILED');
    const p=await proof();const wrong=await request(app).post('/api/faucet/bond-grant').send({...row,...p,answer:-1});
    expect(wrong.status).toBe(400);expect(upstream).not.toHaveBeenCalled();
  });
  it('forwards the bounded audit list, dropping unrelated fields',async()=>{
    upstream.mockResolvedValue(new Response(JSON.stringify({grants:[{...row,ip:'private',requestBody:{token}}]})));
    // Secret detection also refuses a secret in an otherwise discarded field.
    const unsafe=await request(app).get('/api/faucet/bond-grants');expect(unsafe.status).toBe(503);
    upstream.mockResolvedValue(new Response(JSON.stringify({grants:[{...row,ip:'private'}]})));
    const r=await request(app).get('/api/faucet/bond-grants');
    expect(r.status).toBe(200);expect(r.body).toEqual({grants:[row]});expect(r.headers['cache-control']).toBe('no-store');
    expect(String(upstream.mock.calls[1][0])).toBe('http://faucet.invalid/faucet/bond-grants');
  });
  it('maps upstream errors to generic bodies, preserving safe code and retry interval',async()=>{
    upstream.mockResolvedValue(new Response(JSON.stringify({error:{code:'BOND_GRANT_SPACING',message:'http://private.internal '+token,stack:'private stack'}}),{status:429,headers:{'retry-after':'21600'}}));
    const r=await request(app).post('/api/faucet/bond-grant').send({...row,...await proof()});
    expect(r.status).toBe(429);expect(r.body.error.code).toBe('BOND_GRANT_SPACING');expect(r.headers['retry-after']).toBe('21600');
    expect(JSON.stringify(r.body)).not.toMatch(/private|http:|secret|stack/);
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private|secret/);
  });
  it('does not echo the bearer even in a successful upstream response',async()=>{
    upstream.mockResolvedValue(new Response(JSON.stringify({ok:true,receipt:{txHash:token}})));
    const r=await request(app).post('/api/faucet/bond-grant').send({...row,...await proof()});
    expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain(token);
  });
  it('catches transport failures and redirects without logging upstream text',async()=>{
    upstream.mockRejectedValue(new Error('http://private.internal '+token));
    let r=await request(app).get('/api/faucet/bond-grants');expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toMatch(/private|secret/);
    upstream.mockResolvedValue(new Response('',{status:302,headers:{location:'http://private.internal'}}));
    r=await request(app).get('/api/faucet/bond-grants');expect(r.status).toBe(503);
    expect(logger.error).not.toHaveBeenCalled();
  });
  it.each([false,true])('bounds the request when parent JSON parsing is %s',async(parsed)=>{
    app=makeApp(parsed);
    const r=await request(app).post('/api/faucet/bond-grant').send({...row,padding:'x'.repeat(17000)});
    expect(r.status).toBe(413);expect(upstream).not.toHaveBeenCalled();
  });
  it('bounds audit count and upstream bytes',async()=>{
    upstream.mockResolvedValue(new Response(JSON.stringify({grants:Array(101).fill(row)})));
    let r=await request(app).get('/api/faucet/bond-grants');expect(r.status).toBe(503);
    upstream.mockResolvedValue(new Response('x'.repeat(129*1024)));
    r=await request(app).get('/api/faucet/bond-grants');expect(r.status).toBe(503);
  });
  it('fails closed without service configuration',async()=>{
    delete process.env.FAUCET_SERVICE_URL;delete process.env.ONBOARDING_FAUCET_SERVICE_URL;
    const r=await request(app).get('/api/faucet/bond-grants');expect(r.status).toBe(503);expect(upstream).not.toHaveBeenCalled();
  });
  it('the wallet-login limiter returns 429 after five calls and keeps separate client IP budgets',async()=>{
    app=makeApp(true,true);
    upstream.mockImplementation(async()=>new Response(JSON.stringify({grants:[]})));
    for(let n=0;n<5;n++)expect((await request(app).get('/api/faucet/bond-grants').set('X-Forwarded-For','198.51.100.21')).status).toBe(200);
    const limited=await request(app).get('/api/faucet/bond-grants').set('X-Forwarded-For','198.51.100.21');expect(limited.status).toBe(429);
    expect((await request(app).get('/api/faucet/bond-grants').set('X-Forwarded-For','198.51.100.22')).status).toBe(200);
    const src=readFileSync('server/enhanced_unified_api_optimized.ts','utf8');
    expect(src).toContain("app.use(['/api/auth/nonce', '/api/auth/wallet-login', '/api/faucet/bond-grant', '/api/faucet/bond-grants'], walletLoginRateLimit)");
    expect(src).toContain("safeMount('/api/faucet',                  './routes/faucet-bond-routes')");
  });
});
