import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { createEarningsSource } from '../server/services/chain-rewards/earnings.js';
import { createOperatorProfileRouter } from '../server/routes/operator-profile-routes.js';
import { parseRewardBlock } from '../server/services/chain-rewards/parser.js';
import { withRewardStore } from '../server/services/chain-rewards/store.js';
import { aliasEpoch, refreshPayeeAliases, ALIAS_BACKFILL_BATCH } from '../server/services/chain-rewards/payee-aliases.js';
import { profileKeyFor } from '../server/utils/contributor-alias.js';
const hash = (n:number)=>n.toString(16).padStart(64,'0');
const address = (n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const genesis=hash(1), identity='ab'.repeat(32);
const port=process.env.CHAIN_REWARD_TEST_PORT;
if (!port && process.env.CHAIN_REWARD_P3_REQUIRE_PG==='1') test('P3 requires real PostgreSQL',()=>{throw new Error('CHAIN_REWARD_TEST_PORT required');});
(port?describe:describe.skip)('P3 real-PostgreSQL indexed profile lookup',()=>{
  const pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres',options:'-c search_path=chain_rewards_p3_test,public'});
  const saved={alias:process.env.WRFCOIN_PUBLIC_ALIAS_SECRET,index:process.env.CHAIN_REWARD_INDEX_ENABLED,earnings:process.env.CHAIN_REWARD_EARNINGS_ENABLED};
  let migrated: any;
  const source=createEarningsSource(pool,'777',genesis);
  beforeAll(async()=>{
    process.env.WRFCOIN_PUBLIC_ALIAS_SECRET='synthetic-p3-alias-key-at-least-32-characters';
    process.env.CHAIN_REWARD_INDEX_ENABLED='true';process.env.CHAIN_REWARD_EARNINGS_ENABLED='true';
    await pool.query('CREATE SCHEMA chain_rewards_p3_test');
    for(const f of ['0031_chain_role_reward_index','0032_operator_role_labels'])await pool.query(readFileSync(`drizzle/migrations/${f}.sql`,'utf8'));
    await seedState();await payout(1,identity.toUpperCase());
    await pool.query("INSERT INTO operator_role_labels VALUES ('777',$1,'attester',$2,1,NULL,'Mango','synthetic-owner-approval',now())",[genesis,identity.toUpperCase()]);
    await pool.query(readFileSync('drizzle/migrations/0033_chain_role_payee_aliases.sql','utf8'));
    await pool.query(readFileSync('drizzle/migrations/0034_chain_reward_catchup_schedule.sql','utf8'));
    migrated={label:(await pool.query('SELECT operator_identity FROM operator_role_labels')).rows[0],payout:(await pool.query('SELECT operator_identity,amount::text FROM chain_role_payouts')).rows[0]};
  });
  beforeEach(async()=>{
    process.env.WRFCOIN_PUBLIC_ALIAS_SECRET='synthetic-p3-alias-key-at-least-32-characters';
    await pool.query('TRUNCATE operator_role_labels,chain_reward_index_state CASCADE');
    await seedState();await payout(1);await aliases();
    await pool.query("INSERT INTO operator_role_labels VALUES ('777',$1,'attester',$2,1,NULL,'Mango','synthetic-owner-approval',now())",[genesis,identity]);
  });
  afterAll(async()=>{await pool.query('DROP SCHEMA chain_rewards_p3_test CASCADE');await pool.end();
    for(const [k,v] of Object.entries({WRFCOIN_PUBLIC_ALIAS_SECRET:saved.alias,CHAIN_REWARD_INDEX_ENABLED:saved.index,CHAIN_REWARD_EARNINGS_ENABLED:saved.earnings})) {if(v===undefined)delete process.env[k];else process.env[k]=v;}
  });
  async function seedState(){
    await pool.query("INSERT INTO chain_reward_index_state(chain_id,genesis_hash,cursor_height,cursor_hash,status,checked_at) VALUES ('777',$1,1,$1,'ok',now())",[genesis]);
    await pool.query("INSERT INTO chain_reward_blocks VALUES ('777',$1,1,$1,$2,now(),1)",[genesis,hash(0)]);
  }
  async function payout(n:number,id=identity){await pool.query("INSERT INTO chain_role_payouts VALUES ('777',$1,1,$1,'attester',$2,$3,$4,7)",[genesis,`event-${n}`,address(n),id]);}
  async function aliases(){const c=await pool.connect();try{return await refreshPayeeAliases(c,['777',genesis]);}finally{c.release();}}
  test('additive migration preserves legacy labels and amounts in canonical lowercase',async()=>{
    expect(migrated.label.operator_identity).toBe(identity);
    expect(migrated.payout).toEqual({operator_identity:identity,amount:'7'});
    await aliases();expect((await source.leaderboard('attester','all',30)).rows[0].displayName).toBe('Mango');
  });
  test('100000 receipts use actual alias/payout indexes with bounded buffers and time',async()=>{
    await pool.query(`INSERT INTO chain_role_payouts SELECT '777',$1,1,$1,'producer','large-'||n,
      '0x'||lpad(to_hex(n),40,'0'),$2,1 FROM generate_series(2,100001) n`,[genesis,identity]);
    // Populate synthetic public aliases without doing an unbounded application
    // scan. The actual target still uses the real HMAC written by the indexer.
    await pool.query("UPDATE chain_role_payees SET profile_key='c_'||right(payee_address,24),alias_epoch=$1 WHERE payee_address<>$2",[aliasEpoch(),address(1)]);
    await pool.query('ANALYZE chain_role_payees');await pool.query('ANALYZE chain_role_payouts');
    const statements:string[]=[];const plans:any[]=[];
    const explained={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql:string,args?:any[])=>{
      statements.push(sql);const result=await c.query(sql,args);
      if(sql.includes('LIMIT 1'))plans.push((await c.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0]);return result;
    }};}};
    const indexed=createEarningsSource(explained,'777',genesis);
    expect(await indexed.resolveAddress!(profileKeyFor(address(1))!)).toBe(address(1));
    expect(await indexed.resolveAddress!(address(1))).toBe(address(1));
    expect(await indexed.resolveAddress!('c_'+'f'.repeat(24))).toBeNull();
    expect(statements).toHaveLength(3);expect(statements.every(s=>!s.includes('DISTINCT'))).toBe(true);
    expect(JSON.stringify(plans)).toContain('chain_role_payees_alias');
    expect(JSON.stringify(plans)).toContain('chain_role_payouts_address_lookup');
    for(const plan of plans){expect(JSON.stringify(plan)).not.toContain('Seq Scan');expect(plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks']).toBeLessThan(100);expect(plan['Execution Time']).toBeLessThan(1000);}
    console.log('P3 EXPLAIN 100001 receipts:',JSON.stringify(plans));
    await pool.query("DELETE FROM chain_role_payouts WHERE event_id LIKE 'large-%'");
    await pool.query('DELETE FROM chain_role_payees WHERE payee_address<>$1',[address(1)]);
  },30000);
  test('opaque and raw profiles never call DISTINCT addresses(); response contract is preserved',async()=>{
    source.addresses=async()=>{throw new Error('must never enumerate');};
    const db={execute:async()=>({rows:[]})};const app=express();app.use('/api/operators',createOperatorProfileRouter(db,source));
    for(const input of [profileKeyFor(address(1))!,address(1)]){
      const r=await request(app).get(`/api/operators/${input}/profile`);
      expect(r.status).toBe(200);expect(r.body.profile.roleEarnings.roles.attester.paidBaseUnits).toBe('7');
      expect(JSON.stringify(r.body)).not.toContain(address(1));
    }
  });
  test('canonical chain identities normalize mixed-case receipts; DB refuses noncanonical owner bindings',async()=>{
    for(const raw of ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'.toUpperCase(),address(11).toUpperCase().replace('0X','0x'),address(11).slice(2).toUpperCase()]) {
      const block=parseRewardBlock(JSON.stringify({data:{height:2,hash:hash(2),prev_block_hash:genesis,timestamp:'2026-10-11T00:00:00Z',metadata:{attester_settlements:JSON.stringify([{decision_id:'mixed',finalization_height:2,allocations:[{attester_id:raw,amount:9}]}])}}}),2);
      expect(block.payouts[0].identity).toBe(raw.length===40?'0x'+raw.toLowerCase():raw.toLowerCase());
    }
    await expect(pool.query("INSERT INTO operator_role_labels VALUES ('777',$1,'attester',$2,2,NULL,'Workstation','synthetic',now())",[genesis,identity.toUpperCase()])).rejects.toThrow();
    await expect(payout(2,identity.toUpperCase())).rejects.toThrow();
    await expect(pool.query("INSERT INTO operator_role_labels VALUES ('777',$1,'attester',$2,2,NULL,'Workstation','synthetic',now())",[genesis,address(11).slice(2)])).rejects.toThrow();
    expect((await source.leaderboard('attester','all',30)).rows[0].displayName).toBe('Mango');
  });
  test('rotation refuses stale aliases and bounded indexer backfill restores current keys',async()=>{
    const oldKey=profileKeyFor(address(1))!;
    process.env.WRFCOIN_PUBLIC_ALIAS_SECRET='synthetic-p3-rotated-alias-key-at-least-32-characters';
    expect(await source.resolveAddress!(oldKey)).toBeNull();
    await expect(source.leaderboard('attester','all',30)).rejects.toThrow('EARNINGS_UNAVAILABLE');
    await withRewardStore(pool,'777',genesis,async()=>null);
    expect(await source.resolveAddress!(profileKeyFor(address(1))!)).toBe(address(1));
    expect(await source.resolveAddress!(oldKey)).toBeNull();
    const many=Array.from({length:ALIAS_BACKFILL_BATCH+1},(_,i)=>address(i+2));
    await pool.query("INSERT INTO chain_role_payees(chain_id,genesis_hash,payee_address) SELECT '777',$1,unnest($2::text[])",[genesis,many]);
    expect(await aliases()).toBe(ALIAS_BACKFILL_BATCH);
    expect(await aliases()).toBe(1);
    await pool.query('DELETE FROM chain_role_payees WHERE payee_address<>$1',[address(1)]);
  });
  test('receipt transactions register aliases; rewound-only payees cannot resolve',async()=>{
    const key='d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const block=parseRewardBlock(JSON.stringify({data:{height:2,hash:hash(2),prev_block_hash:genesis,timestamp:'2026-10-11T00:00:00Z',producer_pubkey:[...Buffer.from(key,'hex')],metadata:{producer_settlement:JSON.stringify({height:2,payout_address:address(9),amount:1})}}}),2);
    await withRewardStore(pool,'777',genesis,async s=>{await s.append(block);});
    expect(await source.resolveAddress!(profileKeyFor(address(9))!)).toBe(address(9));
    await withRewardStore(pool,'777',genesis,async s=>{await s.rewind(1,genesis);});
    expect(await source.resolveAddress!(profileKeyFor(address(9))!)).toBeNull();
    expect(await source.resolveAddress!(address(9))).toBeNull();
  });
});
