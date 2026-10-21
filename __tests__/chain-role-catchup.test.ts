import { readFileSync } from 'node:fs';
import { Pool as PgPool } from 'pg';
import * as stores from '../server/services/chain-rewards/store.js';
import { type IndexStore } from '../server/services/chain-rewards/store.js';
import { runRewardIndexOnce, startChainRewardIndex, stopChainRewardIndex } from '../server/services/chain-rewards/indexer.js';
import { RewardIndexError, type RewardBlock } from '../server/services/chain-rewards/parser.js';
import { READ_PACE_MS, MAX_READS_PER_MINUTE, RUN_INTERVAL_MS, CATCHUP_THRESHOLD, MAX_ERROR_BACKOFF_MS, passDelayMs } from '../server/services/chain-rewards/scheduling.js';

const hash = (n:number) => n.toString(16).padStart(64,'0'), genesis=hash(1);
const wire=(h:number) => JSON.stringify({data:{height:h,hash:hash(h),prev_block_hash:hash(h-1),timestamp:'2026-10-12T00:00:00Z',metadata:{}}});
class ClockStore implements IndexStore {
  height=0; hash:string|null=null; probeHeight:number|null=null; failures=0; next=0; started=0;
  blocks=new Map<number,RewardBlock>(); last:number|null=null;
  constructor(public now:()=>number, public sleep:(ms:number)=>Promise<void>) {}
  async state(){return {height:this.height,hash:this.hash,probe:this.probeHeight,ready:this.now()>=this.next,nextDelayMs:Math.max(0,this.next-this.now())};}
  async block(h:number){return this.blocks.get(h)??null;}
  async beginPass(){this.started=this.now();this.next=this.started+RUN_INTERVAL_MS;}
  async finishPass(status:string,lag:number|null){this.failures=['ok','budget'].includes(status)?0:Math.min(5,this.failures+1);const delay=passDelayMs(status,lag,this.failures,this.started,this.now());this.next=this.now()+delay;return delay;}
  async reserveRead(){
    // Execute the production persisted-pacing helper using a deterministic DB clock.
    const client={release(){},query:async(sql:string)=>{
      if(sql.startsWith('SELECT CASE'))return {rows:[{delay_ms:this.last===null?0:Math.max(0,this.last+READ_PACE_MS-this.now())}]};
      if(sql.startsWith('UPDATE chain_reward_index_state SET last_read_at')){this.last=this.now();return {rows:[]};}
      throw Error('Unexpected pacing SQL');
    }};
    await stores.reservePacedRead(client,['777',genesis],this.sleep);
  }
  async probe(h:number|null){this.probeHeight=h;}
  async rewind(h:number,key:string|null){this.height=h;this.hash=key;for(const n of this.blocks.keys())if(n>h)this.blocks.delete(n);}
  async append(b:RewardBlock){if(b.height!==this.height+1||this.hash!==null&&b.prevHash!==this.hash)throw Error('gap');this.blocks.set(b.height,b);this.height=b.height;this.hash=b.hash;}
  async status(_s:string){}
}

describe('catch-up rate and scheduling',()=>{
  test('many immediate passes include tip/genesis/cursor GETs and retain pacing across restart',async()=>{
    let now=0;const sleep=async(ms:number)=>{now+=ms;};let store=new ClockStore(()=>now,sleep);
    const attempts:number[]=[]; const tip=async()=>{attempts.push(now);return 2000;};
    const read=async(h:number)=>{attempts.push(now);return {status:200,raw:wire(h)};};
    for(let n=0;n<40;n++){
      const result=await runRewardIndexOnce({store,read,tip,genesis,sleep});
      expect(result).toMatchObject({reads:30,status:'budget',nextDelayMs:0});
      if(n===19){const fresh=new ClockStore(()=>now,sleep);Object.assign(fresh,store);store=fresh;}
    }
    expect(attempts).toHaveLength(1200);expect(store.height).toBe(1082);
    for(let i=1;i<attempts.length;i++)expect(attempts[i]-attempts[i-1]).toBeGreaterThanOrEqual(READ_PACE_MS);
    for(const start of attempts)expect(attempts.filter(t=>t>=start&&t<start+60000).length).toBeLessThanOrEqual(MAX_READS_PER_MINUTE);
    // 30 paced reads/pass include three checks, leaving 27 new blocks.
    const netBlocksPerMinute=27/(30*READ_PACE_MS/60000)-1;
    expect(41100/netBlocksPerMinute/60+30/60).toBeLessThan(24);
  });
  test('catch-up threshold is strict and normal schedule stays relative to START, not last read',async()=>{
    let now=0;const sleep=async(ms:number)=>{now+=ms;};const store=new ClockStore(()=>now,sleep);
    const first=await runRewardIndexOnce({store,read:async h=>({status:200,raw:wire(h)}),tip:async()=>129,genesis,sleep});
    expect(store.height).toBe(29);expect(129-store.height).toBe(CATCHUP_THRESHOLD);
    expect(first.nextDelayMs).toBe(RUN_INTERVAL_MS-29*READ_PACE_MS);
    expect(store.next).toBe(RUN_INTERVAL_MS);
    now=store.next;
    const next=await runRewardIndexOnce({store,read:async h=>({status:200,raw:wire(h)}),tip:async()=>2000,genesis,sleep});
    expect(next.nextDelayMs).toBe(0);
  });
  test.each(['RATE_LIMITED','UPSTREAM','INVALID_BLOCK'])('%s stops immediately and backs off exponentially to a bounded maximum',async(code)=>{
    let now=0;const sleep=async(ms:number)=>{now+=ms;};const store=new ClockStore(()=>now,sleep);const reads=jest.fn();
    for(const expected of [300000,600000,1200000,2400000,3600000,3600000]){
      const tip=jest.fn(async()=>{throw new RewardIndexError(code);});
      const result=await runRewardIndexOnce({store,read:reads,tip,genesis,sleep});
      expect(result.reads).toBe(1);expect(result.nextDelayMs).toBe(expected);expect(tip).toHaveBeenCalledTimes(1);
      expect((await runRewardIndexOnce({store,read:reads,tip,genesis,sleep})).status).toBe('cooldown');
      expect(tip).toHaveBeenCalledTimes(1);now=store.next;
    }
    expect(reads).not.toHaveBeenCalled();expect(store.height).toBe(0);expect(store.next-now).toBe(0);
    const recovered=await runRewardIndexOnce({store,read:async h=>({status:200,raw:wire(h)}),tip:async()=>1,genesis,sleep});
    expect(recovered.status).toBe('ok');expect(store.failures).toBe(0);expect(recovered.nextDelayMs).toBeLessThanOrEqual(RUN_INTERVAL_MS);
  });
  test('early sleep wakeups recheck persisted deadline instead of admitting a request',async()=>{
    let now=0;const store=new ClockStore(()=>now,async ms=>{now+=Math.min(500,ms);});
    await store.reserveRead();await store.reserveRead();expect(now).toBe(READ_PACE_MS);
  });
});

describe('completion-driven production timer',()=>{
  const env={CHAIN_REWARD_INDEX_ENABLED:'true',CORE4_API_URL:'http://127.0.0.1',WRFCOIN_READER_TOKEN:'synthetic-catchup-only',CHAIN_REWARD_INDEX_CHAIN_ID:'777',CHAIN_REWARD_INDEX_GENESIS_HASH:genesis};
  beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(0);});
  afterEach(async()=>{const done=stopChainRewardIndex();await jest.advanceTimersByTimeAsync(120000);await done;jest.restoreAllMocks();jest.useRealTimers();});
  function setup(){const store=new ClockStore(()=>Date.now(),ms=>new Promise(resolve=>setTimeout(resolve,ms)));jest.spyOn(stores,'withRewardStore').mockImplementation(async(_p,_c,_g,fn)=>fn(store));return store;}
  test('new pass begins immediately when behind, without interval ticks or overlap',async()=>{
    const store=setup();const tip=jest.fn(async()=>2000);
    await startChainRewardIndex({env,pool:{connect:jest.fn()},tip,read:async h=>({status:200,raw:wire(h)})});
    await jest.advanceTimersByTimeAsync(60000);
    expect(tip).toHaveBeenCalledTimes(2);expect(store.height).toBeGreaterThanOrEqual(29);
    expect(stores.withRewardStore).toHaveBeenCalledTimes(2);
  });
  test('caught-up pass starts again at five minutes from pass start',async()=>{
    setup();const tip=jest.fn(async()=>1);
    await startChainRewardIndex({env,pool:{connect:jest.fn()},tip,read:async h=>({status:200,raw:wire(h)})});
    await jest.advanceTimersByTimeAsync(RUN_INTERVAL_MS-1);expect(tip).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);expect(tip).toHaveBeenCalledTimes(2);
  });
});

const pgPort=process.env.CHAIN_REWARD_TEST_PORT;
if(process.env.CHAIN_REWARD_CATCHUP_REQUIRE_PG==='1'&&!pgPort)throw Error('Catch-up real PostgreSQL port required');
(pgPort?describe:describe.skip)('catch-up real PostgreSQL scheduling',()=>{
  const pool=new PgPool({host:'127.0.0.1',port:Number(pgPort),user:'postgres',database:'postgres',options:'-c search_path=chain_rewards_catchup_test'});
  beforeAll(async()=>{await pool.query('CREATE SCHEMA chain_rewards_catchup_test');for(const n of ['0031_chain_role_reward_index','0032_operator_role_labels','0033_chain_role_payee_aliases','0034_chain_reward_catchup_schedule'])await pool.query(readFileSync(`drizzle/migrations/${n}.sql`,'utf8'));});
  afterAll(async()=>{await pool.query('DROP SCHEMA chain_rewards_catchup_test CASCADE');await pool.end();});
  beforeEach(async()=>{await pool.query('TRUNCATE chain_reward_index_state CASCADE');});
  const using=(fn:(store:IndexStore)=>Promise<any>)=>stores.withRewardStore(pool,'777',genesis,fn);
  test('migration and catch-up schedule allow immediate next locked pass',async()=>{
    await using(async s=>{await s.beginPass();expect(await s.finishPass('budget',CATCHUP_THRESHOLD+1)).toBe(0);});
    await using(async s=>{expect((await s.state()).ready).toBe(true);});
  });
  test('read reservation does not push normal start-anchored next_run_at',async()=>{
    await using(async s=>{await s.beginPass();const before=(await pool.query('SELECT next_run_at FROM chain_reward_index_state')).rows[0].next_run_at.getTime();await s.reserveRead();await s.finishPass('ok',0);const after=(await pool.query('SELECT next_run_at FROM chain_reward_index_state')).rows[0].next_run_at.getTime();expect(Math.abs(after-before)).toBeLessThan(1000);expect((await s.state()).ready).toBe(false);});
  });
  test('429 and generic failures persist exponential bounded backoff across lock owners',async()=>{
    for(const expected of [300000,600000,1200000,2400000,MAX_ERROR_BACKOFF_MS,MAX_ERROR_BACKOFF_MS]){
      await pool.query("UPDATE chain_reward_index_state SET next_run_at='-infinity'");
      await using(async s=>{await s.beginPass();expect(await s.finishPass('rate_limited',2000)).toBe(expected);});
      await using(async s=>{expect((await s.state()).ready).toBe(false);expect((await s.state()).nextDelayMs).toBeGreaterThan(expected-1000);});
    }
    await using(async s=>{await s.beginPass();await s.finishPass('budget',2000);});
    expect((await pool.query('SELECT failure_count FROM chain_reward_index_state')).rows[0].failure_count).toBe(0);
  });
  test('pacing timestamp survives new store sessions and cannot be bypassed at pass boundary',async()=>{
    let first=0;
    await using(async s=>{await s.beginPass();await s.reserveRead();first=Date.now();await s.finishPass('budget',2000);});
    await using(async s=>{await s.beginPass();await s.reserveRead();expect(Date.now()-first).toBeGreaterThanOrEqual(READ_PACE_MS-20);});
  });
});
