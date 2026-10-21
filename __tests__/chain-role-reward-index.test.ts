import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Pool as PgPool } from 'pg';
import { keccak256 } from 'ethers';
import { parseRewardBlock, payoutAddress, losslessJson, U128_MAX, type RewardBlock } from '../server/services/chain-rewards/parser.js';
import { createBlockReader, createTipReader, runRewardIndexOnce, startChainRewardIndex, stopChainRewardIndex, READ_PACE_MS } from '../server/services/chain-rewards/indexer.js';
import { withRewardStore, type IndexStore } from '../server/services/chain-rewards/store.js';
import { passDelayMs } from '../server/services/chain-rewards/scheduling.js';
import vectors from './fixtures/chain-role-payee-vectors.json';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const genesis = hash(1), payee = `0x${'12'.repeat(20)}`;
const key = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
function wire(h: number, metadata: any = {}, blockHash = hash(h), prev = hash(h - 1)): string {
  return JSON.stringify({ data: { height: h, hash: blockHash, prev_block_hash: prev, timestamp: '2026-10-11T00:00:00Z', producer_pubkey: [...Buffer.from(key, 'hex')], metadata } });
}
const producer = (h: number, amount = '333333333') => `{"height":${h},"payout_address":"${payee}","amount":${amount}}`;
const attesters = (h: number, amount = '7', decision = 'decision') => `[{"decision_id":"${decision}","finalization_height":${h},"allocations":[{"attester_id":"${key}","amount":${amount}}]}]`;
const paidWire = (h: number, bHash = hash(h), prev = hash(h - 1)) => wire(h, { producer_settlement: producer(h), attester_settlements: attesters(h, '7', `d${h}`) }, bHash, prev);

class MemoryStore implements IndexStore {
  blocks = new Map<number, RewardBlock>(); ready = true; states: string[] = []; reserves = 0; search:number|null=null;
  async state() { const height = Math.max(0, ...this.blocks.keys()); return { height, hash: this.blocks.get(height)?.hash ?? null, ready: this.ready, probe:this.search }; }
  async block(h: number) { return this.blocks.get(h) ?? null; }
  async beginPass() {}
  async finishPass(status: string, lag: number | null) { this.states.push(status); return passDelayMs(status,lag,1,0,0); }
  async reserveRead() { this.reserves++; }
  async probe(h:number|null) { this.search=h; }
  async rewind(h: number) { for (const n of this.blocks.keys()) if (n > h) this.blocks.delete(n);this.search=null; }
  async append(b: RewardBlock) { this.blocks.set(b.height, b); }
  async status(s: string) { this.states.push(s); }
}
const sleep = jest.fn(async (_ms: number) => {});
const pass = (store: IndexStore, read: any, tip = 3) => runRewardIndexOnce({ store, read, genesis, tip: async () => tip, sleep });
const read = async (h: number) => ({ status: 200, raw: paidWire(h) });

describe('version 1 producer/attester parser', () => {
  test.each(vectors)('Rust shared identity vector $identity', ({ identity, payee: expected }) => {
    if (expected === null) expect(() => payoutAddress(identity)).toThrow('INVALID_BLOCK');
    else expect(payoutAddress(identity)).toBe(expected);
  });
  test('SHA3-256 is pinned independently and differs from Keccak', () => {
    expect(payoutAddress(key)).toBe(`0x${createHash('sha3-256').update(Buffer.from(key,'hex')).digest('hex').slice(0,40)}`);
    expect(payoutAddress(key)).not.toBe(keccak256(`0x${key}`).slice(0,42));
  });
  test.each(['9007199254740993', U128_MAX.toString(), '1'])('exact numeric receipt %s including supply remainder', amount => {
    const b = parseRewardBlock(wire(2,{ producer_settlement: producer(2,amount), attester_settlements: attesters(2,amount) }),2);
    expect(b.payouts.map(p=>p.amount)).toEqual([amount,amount]);
    expect(b.payouts[0].payee).toBe(payee);
    expect(b.payouts[0].identity).toBe(key);
  });
  test.each(['-1','-0','0','1.5','1e2','"123"',(U128_MAX+1n).toString()])('reject invalid producer amount %s', amount => {
    expect(()=>parseRewardBlock(wire(2,{producer_settlement:producer(2,amount)}),2)).toThrow();
  });
  test('zero attester allocation is retained as zero, not an invented earning', () => {
    expect(parseRewardBlock(wire(2,{attester_settlements:attesters(2,'0')}),2).payouts[0].amount).toBe('0');
  });
  test.each([
    {producer_settlement:producer(1)}, {attester_settlements:attesters(1)},
    {attester_settlements:'[]'}, {attester_settlements:'{'},
    {attester_settlements:JSON.stringify([{decision_id:'d',finalization_height:2,allocations:[{attester_id:key,amount:1},{attester_id:key,amount:2}]}])},
    {attester_settlements:attesters(2),attester_settlement_minted_total:'8'},
    {attester_settlement_minted_total:'7'}, {producer_settlement:producer(2).replace('"height":2','"height":2,"height":2')},
  ])('malformed, duplicates, mismatched height/aggregate fail closed %#',metadata=>{
    expect(()=>parseRewardBlock(wire(2,metadata),2)).toThrow();
  });
  test('duplicate decisions and unordered allocations are rejected',()=>{
    const r = JSON.parse(attesters(2))[0];
    expect(()=>parseRewardBlock(wire(2,{attester_settlements:JSON.stringify([r,r])}),2)).toThrow();
    r.allocations = [{attester_id:key,amount:1},{attester_id:'11'.repeat(20),amount:2}];
    expect(()=>parseRewardBlock(wire(2,{attester_settlements:JSON.stringify([r])}),2)).toThrow();
  });
  test('actual receipt fields determine payouts; counters and reward decisions cannot substitute',()=>{
    const metadata = {producer_settlement:producer(2), attester_settlements:attesters(2), reward_entries:'unpaid malformed decision', forecast_rewards_minted_total:'900', faucet_rewards_minted_total:'100'};
    expect(parseRewardBlock(wire(2,metadata),2).payouts).toHaveLength(2);
    delete (metadata as any).producer_settlement;
    expect(parseRewardBlock(wire(2,metadata),2).payouts).toHaveLength(1);
    expect(parseRewardBlock(wire(2,{reward_entries:'[{"amount":999}]'}),2).payouts).toEqual([]);
  });
  test('lossless raw envelope, invalid JSON and nesting limits',()=>{
    expect(losslessJson('{"n":9007199254740993}').n).toBe(9007199254740993n);
    for(const raw of ['{"x":1,"x":2}', '[1,]', '01','null trailing','\u00a0null','['.repeat(70)+'0'+']'.repeat(70)]) expect(()=>losslessJson(raw)).toThrow();
  });
});

describe('bounded restartable passes',()=>{
  beforeEach(()=>sleep.mockClear());
  test('default OFF: no timers, reads or DB connects',async()=>{
    const connect = jest.fn(), read = jest.fn(), timer = jest.fn();
    for(const flag of [undefined,'false','TRUE','1']) expect(await startChainRewardIndex({env:{CHAIN_REWARD_INDEX_ENABLED:flag},pool:{connect},read,setTimeoutImpl:timer as any})).toBe(false);
    expect(connect).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();
  });
  test('cold pass, duplicate fetch, restart: no double counting',async()=>{
    const store=new MemoryStore();
    expect((await pass(store,read)).appended).toBe(3);
    expect((await pass(store,read)).appended).toBe(0);
    expect([...store.blocks.values()].flatMap(b=>b.payouts)).toHaveLength(6);
  });
  test('all GETs capped at 30 and paced, including verification and genesis',async()=>{
    const store=new MemoryStore(), get=jest.fn(read);
    const result=await pass(store,get,1000);
    expect(result).toEqual({reads:30,appended:29,status:'budget',nextDelayMs:0});
    expect(get).toHaveBeenCalledTimes(29);expect(store.reserves).toBe(30);
    expect(sleep).toHaveBeenCalledTimes(29);expect(sleep.mock.calls.every(([ms])=>ms===READ_PACE_MS)).toBe(true);
    store.ready=false;expect((await pass(store,get,1000)).reads).toBe(0);
  });
  test('reorg replaces suffix and a shorter chain removes orphan rewards',async()=>{
    const store=new MemoryStore();await pass(store,read);
    const fork=async(h:number)=>({status:200,raw:h===1?paidWire(1):paidWire(h,hash(h+100),h===2?genesis:hash(h+99))});
    expect((await pass(store,fork,4)).status).toBe('ok');
    expect(store.blocks.get(2)?.hash).toBe(hash(102));expect(store.blocks.size).toBe(4);
    await pass(store,fork,2);expect(store.blocks.size).toBe(2);
  });
  test.each([404,429,500])('HTTP %s stops at the gap without skip/retry',async(status)=>{
    const store=new MemoryStore(),get=jest.fn(async(h:number)=>h===2?{status,raw:'private upstream text'}:read(h));
    const result=await pass(store,get);
    expect(result.status).toBe(status===404?'missing_archive':status===429?'rate_limited':'upstream');
    expect(store.blocks.size).toBe(1);expect(get).toHaveBeenCalledTimes(2);
  });
  test('deep ancestor search resumes across bounded passes',async()=>{
    const store=new MemoryStore();
    for(let h=1;h<=65;h++) await store.append(parseRewardBlock(paidWire(h),h));
    const fork=async(h:number)=>({status:200,raw:h===1?paidWire(1):paidWire(h,hash(h+1000),h===2?genesis:hash(h+999))});
    const a=await pass(store,fork,65);expect(a.reads).toBe(30);expect(store.search).toBeLessThan(65);
    const checkpoint=store.search!;
    await pass(store,fork,65);expect(store.search).toBeLessThan(checkpoint);
    for(let n=0;n<4;n++) await pass(store,fork,65);
    expect(store.blocks.get(65)?.hash).toBe(hash(1065));expect(store.search).toBeNull();
  });
  test('timeout and predecessor mismatch stop without advancing',async()=>{
    const store=new MemoryStore();
    expect((await pass(store,async()=>{throw Error('SECRET_SENTINEL')})).status).toBe('upstream');
    expect(store.blocks.size).toBe(0);
    const get=async(h:number)=>({status:200,raw:paidWire(h,hash(h),h===2?hash(99):hash(h-1))});
    expect((await pass(store,get)).status).toBe('invalid');expect(store.blocks.size).toBe(1);
  });
  test('wrong genesis rejected, never indexed',async()=>{
    const store=new MemoryStore();expect((await pass(store,async()=>({status:200,raw:paidWire(1,hash(99))}))).status).toBe('invalid');expect(store.blocks.size).toBe(0);
  });
  test('unknown configuration/DB errors never reach logs',async()=>{
    const logger={info:jest.fn(),warn:jest.fn()};
    expect(await startChainRewardIndex({env:{CHAIN_REWARD_INDEX_ENABLED:'true',CORE4_API_URL:'http://127.0.0.1',WRFCOIN_READER_TOKEN:'SECRET_SENTINEL',CHAIN_REWARD_INDEX_CHAIN_ID:'777',CHAIN_REWARD_INDEX_GENESIS_HASH:genesis},pool:{connect:async()=>{throw Error('SECRET_SENTINEL')}},logger,read,tip:async()=>3})).toBe(true);
    await stopChainRewardIndex();expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET_SENTINEL');expect(logger.warn).toHaveBeenCalledWith('Chain reward index pass failed');
  });
});

describe('real loopback transport',()=>{
  let server:Server, url:string; const requests: {method:string;path:string;auth:string}[]=[];
  beforeAll(async()=>{
    server=createServer((req,res)=>{
      requests.push({method:req.method!,path:req.url!,auth:req.headers.authorization!});
      if(req.url==='/blockchain'){res.end('{"data":{"height":3}}');return;}
      if(req.url==='/chain/block/9'){res.writeHead(302,{location:'/consensus/write'});res.end();return;}
      if(req.url==='/chain/block/8'){res.writeHead(429);res.end('SECRET_SENTINEL');return;}
      res.end(paidWire(Number(req.url!.split('/').pop())));
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    url=`http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  test('GET-only raw amounts; redirects refused without extra hops; errors sanitized',async()=>{
    const get=createBlockReader(url,'test-only-token');
    expect(parseRewardBlock((await get(1)).raw,1).payouts).toHaveLength(2);
    expect(await createTipReader(url,'test-only-token')()).toBe(3);
    expect(await get(8)).toEqual({status:429,raw:''});
    await expect(get(9)).rejects.toThrow('UPSTREAM');
    expect(requests.map(r=>r.method)).toEqual(['GET','GET','GET','GET']);
    expect(requests.map(r=>r.path)).not.toContain('/consensus/write');
    expect(requests.every(r=>r.auth==='Bearer test-only-token')).toBe(true);
  });
});

// Explicit dedicated loopback DB; never pick up DATABASE_URL or a deployment credential.
const pgPort=process.env.CHAIN_REWARD_TEST_PORT;
(pgPort ? describe : describe.skip)('PostgreSQL migrations and persistent indexer',()=>{
  jest.setTimeout(120_000);
  const pool=new PgPool({host:'127.0.0.1',port:Number(pgPort),user:'postgres',database:'postgres'});
  beforeAll(async()=>{
    await pool.query(readFileSync('drizzle/migrations/0031_chain_role_reward_index.sql','utf8'));
    await pool.query(readFileSync('drizzle/migrations/0032_operator_role_labels.sql','utf8'));
    await pool.query(readFileSync('drizzle/migrations/0033_chain_role_payee_aliases.sql','utf8'));
    await pool.query(readFileSync('drizzle/migrations/0034_chain_reward_catchup_schedule.sql','utf8'));
  });
  afterAll(async()=>{await pool.query('DROP TABLE operator_role_labels,chain_role_payees,chain_role_payouts,chain_reward_blocks,chain_reward_index_state CASCADE; DROP FUNCTION register_chain_role_payee()');await pool.end();});
  beforeEach(async()=>{await pool.query('TRUNCATE chain_reward_index_state CASCADE');});
  const dbPass = (get=read,tip=3) => withRewardStore(pool,'777',genesis,store=>pass(store,get,tip));
  const cool = () => pool.query("UPDATE chain_reward_index_state SET next_run_at='-infinity'");
  test('atomic paid receipts/cursor, restart cooldown, same-payee totals, fork replacement',async()=>{
    await dbPass();
    expect((await pool.query('SELECT SUM(amount)::text AS total FROM chain_role_payouts WHERE role=\'producer\'')).rows[0].total).toBe('999999999');
    expect((await dbPass())?.reads).toBe(0);
    await cool();await dbPass();expect((await pool.query('SELECT count(*) FROM chain_role_payouts')).rows[0].count).toBe('6');
    await cool();
    const fork=async(h:number)=>({status:200,raw:h===1?paidWire(1):paidWire(h,hash(h+100),h===2?genesis:hash(h+99))});
    await dbPass(fork,3);
    expect((await pool.query('SELECT block_hash FROM chain_reward_blocks WHERE height=2')).rows[0].block_hash).toBe(hash(102));
    expect((await pool.query('SELECT count(*) FROM chain_role_payouts')).rows[0].count).toBe('6');
    await cool();await dbPass(fork,2);expect((await pool.query('SELECT count(*) FROM chain_role_payouts')).rows[0].count).toBe('4');
  });
  test('duplicate paid decision in a later block rolls back block and cursor',async()=>{
    const duplicate=async(h:number)=>({status:200,raw:wire(h,{producer_settlement:producer(h),attester_settlements:attesters(h,'7','same-decision')})});
    expect((await dbPass(duplicate))?.status).toBe('db_error');
    expect((await pool.query('SELECT cursor_height FROM chain_reward_index_state')).rows[0].cursor_height).toBe('1');
    expect((await pool.query('SELECT count(*) FROM chain_reward_blocks')).rows[0].count).toBe('1');
  });
  test('u128 persists exactly and database enforces bounds',async()=>{
    await dbPass(async(h:number)=>({status:200,raw:wire(h,{producer_settlement:producer(h,U128_MAX.toString())})}),1);
    expect((await pool.query('SELECT amount::text FROM chain_role_payouts')).rows[0].amount).toBe(U128_MAX.toString());
    await expect(pool.query('UPDATE chain_role_payouts SET amount=$1',[(U128_MAX+1n).toString()])).rejects.toThrow();
  });
  test('cross-process session lock prevents a second reader',async()=>{
    await withRewardStore(pool,'777',genesis,async()=>{expect(await dbPass()).toBeNull();});
  });
});
