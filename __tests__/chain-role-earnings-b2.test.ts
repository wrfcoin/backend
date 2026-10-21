import express from 'express';
import { refreshPayeeAliases } from '../server/services/chain-rewards/payee-aliases.js';
import request from 'supertest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { createEarningsRouter } from '../server/routes/earnings-routes.js';
import { createEarningsSource, type EarningsSource } from '../server/services/chain-rewards/earnings.js';
import { createOperatorProfileRouter } from '../server/routes/operator-profile-routes.js';
import { createCapabilitiesRouter } from '../server/routes/capabilities-routes.js';
import { profileKeyFor, shortAddress } from '../server/utils/contributor-alias.js';

const address = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const hash = (n: number) => n.toString(16).padStart(64,'0');
const genesis = hash(1), now = Date.parse('2026-10-11T12:00:00Z');
const saved = { ...process.env };
beforeEach(()=>{process.env.CHAIN_REWARD_EARNINGS_ENABLED='true';process.env.CHAIN_REWARD_INDEX_ENABLED='true';process.env.WRFCOIN_PUBLIC_ALIAS_SECRET='synthetic-public-alias-secret-for-b2-tests';});
afterAll(()=>{for(const key of ['CHAIN_REWARD_EARNINGS_ENABLED','CHAIN_REWARD_INDEX_ENABLED','WRFCOIN_PUBLIC_ALIAS_SECRET','JWT_SECRET','WRFCOIN_OPERATOR_TOKEN']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
function app(source: EarningsSource, db: any = {execute:async()=>({rows:[]})}) {
  const a=express();a.use('/api/earnings',createEarningsRouter(source));a.use('/api/operators',createOperatorProfileRouter(db,source));return a;
}
const url=(role='producer',period='all',limit=30)=>`/api/earnings/leaderboard?role=${role}&period=${period}&limit=${limit}`;

describe('B2 route gate and capabilities',()=>{
  test.each([undefined,'false','TRUE','1'])('default OFF (%s) never queries or returns rows',async(flag)=>{
    if(flag===undefined)delete process.env.CHAIN_REWARD_EARNINGS_ENABLED;else process.env.CHAIN_REWARD_EARNINGS_ENABLED=flag;
    const source={leaderboard:jest.fn(),profile:jest.fn(),addresses:jest.fn()};expect((await request(app(source)).get(url())).status).toBe(503);expect(source.leaderboard).not.toHaveBeenCalled();
  });
  test('indexer OFF also refuses an enabled earnings flag',async()=>{
    process.env.CHAIN_REWARD_INDEX_ENABLED='false';const source={leaderboard:jest.fn(),profile:jest.fn(),addresses:jest.fn()};expect((await request(app(source)).get(url())).status).toBe(503);expect(source.leaderboard).not.toHaveBeenCalled();
  });
  test.each(['role=producer&period=all&limit=0','role=faucet&period=all&limit=1','role=producer&period=week&limit=1','period=all&role=producer&limit=1','role=producer&period=all&limit=1&limit=2','role=producer&period=all&limit=1&geo=all'])('invalid ordered grammar: %s',async(q)=>{
    const source={leaderboard:jest.fn(),profile:jest.fn(),addresses:jest.fn()};expect((await request(app(source)).get('/api/earnings/leaderboard?'+q)).status).toBe(400);expect(source.leaderboard).not.toHaveBeenCalled();
  });
  test('capability cannot be promoted while gated OFF; enabled seed is configured only',async()=>{
    const a=express();a.use('/api',createCapabilitiesRouter({evidenceProvider:async()=>({earningsRead:{capabilityId:'earningsRead',evidenceClass:'operational',observedAt:new Date().toISOString(),source:'synthetic',detail:'synthetic',functional:true,proof:{kind:'semantic',assertion:'test'}}})}));
    process.env.CHAIN_REWARD_EARNINGS_ENABLED='false';expect((await request(a).get('/api/capabilities')).body.features.earningsRead.status).toBe('unavailable');
    const b=express();b.use('/api',createCapabilitiesRouter());process.env.CHAIN_REWARD_EARNINGS_ENABLED='true';expect((await request(b).get('/api/capabilities')).body.features.earningsRead.status).toBe('configured');
  });
});

const port=process.env.CHAIN_REWARD_TEST_PORT;
(port?describe:describe.skip)('B2 real-PostgreSQL earnings and profiles',()=>{
  const pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres',options:'-c search_path=chain_rewards_b2_test,public'});
  const source=createEarningsSource(pool,'777',genesis,()=>now);
  beforeAll(async()=>{await pool.query('CREATE SCHEMA chain_rewards_b2_test');await pool.query(readFileSync('drizzle/migrations/0031_chain_role_reward_index.sql','utf8'));await pool.query(readFileSync('drizzle/migrations/0032_operator_role_labels.sql','utf8'));await pool.query(readFileSync('drizzle/migrations/0033_chain_role_payee_aliases.sql','utf8'));
    await pool.query(readFileSync('drizzle/migrations/0034_chain_reward_catchup_schedule.sql','utf8'));});
  afterAll(async()=>{await pool.query('DROP SCHEMA chain_rewards_b2_test CASCADE');await pool.end();});
  beforeEach(async()=>{
    await pool.query('TRUNCATE operator_role_labels,chain_reward_index_state CASCADE');
    await pool.query("INSERT INTO chain_reward_index_state(chain_id,genesis_hash,cursor_height,cursor_hash,status,checked_at) VALUES ('777',$1,4,$2,'ok',$3)",[genesis,hash(4),new Date(now)]);
    for(let h=1;h<=4;h++) await pool.query("INSERT INTO chain_reward_blocks(chain_id,genesis_hash,height,block_hash,prev_hash,block_time,parser_version) VALUES ('777',$1,$2,$3,$4,$5,1)",[genesis,h,hash(h),hash(h-1),new Date(now-(4-h)*86400000)]);
  });
  async function payout(h:number,payee=address(1),amount='5',role='producer',identity=hash(9),id=`${role}:${h}:${payee}:${identity}`){await pool.query("INSERT INTO chain_role_payouts(chain_id,genesis_hash,height,block_hash,role,event_id,payee_address,operator_identity,amount) VALUES ('777',$1,$2,$3,$4,$5,$6,$7,$8)",[genesis,h,hash(h),role,id,payee,identity,amount]);const c=await pool.connect();try{await refreshPayeeAliases(c,['777',genesis]);}finally{c.release();}}
  test('payees without users/stations, multiple signing keys, exact aggregation, ties and limit',async()=>{
    await payout(1,address(1),'9007199254740993');await payout(2,address(1),'7','producer',hash(10));await payout(3,address(2),'9007199254741000');await payout(4,address(1),'99','attester',address(1));
    const r=await request(app(source)).get(url('producer','all',1));expect(r.status).toBe(200);expect(r.body.rows).toHaveLength(1);expect(r.body.rows[0]).toMatchObject({rank:1,shortAddress:shortAddress(address(1)),paidBaseUnits:'9007199254741000',paidDisplay:'90071992.54741000'});
    expect(r.body.rows[0].displayName).toMatch(/^Operator-/);expect(JSON.stringify(r.body)).not.toContain(address(1));expect(JSON.stringify(r.body)).not.toContain(hash(9));
    expect((await request(app(source)).get(url('attester'))).body.rows[0].paidBaseUnits).toBe('99');
  });
  test('payment-window boundaries use block timestamps and exclude future payments',async()=>{
    await pool.query('UPDATE chain_reward_blocks SET block_time=$1 WHERE height=1',[new Date(now-7*86400000)]);await pool.query('UPDATE chain_reward_blocks SET block_time=$1 WHERE height=2',[new Date(now-7*86400000-1)]);await pool.query('UPDATE chain_reward_blocks SET block_time=$1 WHERE height=3',[new Date(now+1)]);
    for(let h=1;h<=4;h++)await payout(h,address(1),String(h));
    expect((await source.leaderboard('producer','7d',30)).rows[0].paidBaseUnits).toBe('5');expect((await source.leaderboard('producer','30d',30)).rows[0].paidBaseUnits).toBe('7');
    expect((await source.leaderboard('producer','all',30)).rows[0].paidBaseUnits).toBe('10');
    expect(Date.parse((await source.leaderboard('producer','7d',30)).window.from)).toBe(now-7*86400000);
    await pool.query("UPDATE chain_reward_blocks SET block_time='2026-10-11T12:00:00.000001Z' WHERE height=4");
    const micro=await source.leaderboard('producer','7d',30);expect(micro.rows[0].paidBaseUnits).toBe('4');expect(micro.asOf.time).toBe('2026-10-11T12:00:00.000001Z');expect(micro.window.from).toBe('2026-10-04T12:00:00.000001Z');
    await pool.query("SET TIME ZONE 'America/Los_Angeles'");
    try {
      const dstNow=Date.parse('2026-11-02T12:00:00Z');await pool.query("UPDATE chain_reward_blocks SET block_time='2026-11-02T12:00:00.000001Z' WHERE height=4");await pool.query('UPDATE chain_reward_index_state SET checked_at=$1',[new Date(dstNow)]);
      const dst=await createEarningsSource(pool,'777',genesis,()=>dstNow).leaderboard('producer','7d',30);expect(dst.window.from).toBe('2026-10-26T12:00:00.000001Z');expect(dst.rows[0].paidBaseUnits).toBe('4');
    } finally { await pool.query("SET TIME ZONE 'UTC'"); }
  });
  test('incomplete, stale, reorg and unavailable coverage never publish partial rankings',async()=>{
    await payout(1);for(const status of ['running','budget','missing_archive','rate_limited']){await pool.query('UPDATE chain_reward_index_state SET status=$1',[status]);expect((await request(app(source)).get(url())).status).toBe(503);}
    await pool.query("UPDATE chain_reward_index_state SET status='ok',checked_at=$1",[new Date(now-600001)]);await expect(source.leaderboard('producer','all',30)).rejects.toThrow('EARNINGS_UNAVAILABLE');
    await pool.query('UPDATE chain_reward_index_state SET checked_at=$1',[new Date(now)]);await pool.query('DELETE FROM chain_reward_blocks WHERE height=2');await expect(source.leaderboard('producer','all',30)).rejects.toThrow();
  });
  test('proven empty is distinct from unsupported nodes and unproven forecast/contribution',async()=>{
    expect((await source.leaderboard('producer','all',30))).toMatchObject({status:'available',complete:true,rows:[]});
    expect((await source.leaderboard('node','all',30))).toMatchObject({status:'unsupported',message:'Node payments are not implemented yet',paidBaseUnits:null,rows:[]});
    for(const role of ['forecast','contribution'] as const){const r=await source.leaderboard(role,'7d',30);expect(r.status).toBe('unavailable');expect(r.complete).toBe(false);expect(JSON.stringify(r)).not.toContain('No forecast payments observed');}
  });
  test('verified full-identity labels are effective-height scoped; renaming never changes amounts',async()=>{
    expect((await pool.query('SELECT count(*) FROM operator_role_labels')).rows[0].count).toBe('0');await payout(1);
    const bind=(identity:string,label:string,from=1)=>pool.query("INSERT INTO operator_role_labels VALUES ('777',$1,'producer',$2,$3,NULL,$4,'synthetic-owner-approval',$5)",[genesis,identity,from,label,new Date(now)]);
    await bind(hash(90),'Mango');expect((await source.leaderboard('producer','all',30)).rows[0].displayName).toMatch(/^Operator-/);
    await bind(hash(9),'N5 node');let row=(await source.leaderboard('producer','all',30)).rows[0];expect(row.displayName).toBe('N5 node');expect(row.paidBaseUnits).toBe('5');
    await pool.query("UPDATE operator_role_labels SET display_label='Workstation' WHERE operator_identity=$1",[hash(9)]);row=(await source.leaderboard('producer','all',30)).rows[0];expect(row.displayName).toBe('Workstation');expect(row.paidBaseUnits).toBe('5');
    await pool.query('UPDATE operator_role_labels SET from_height=2 WHERE operator_identity=$1',[hash(9)]);expect((await source.leaderboard('producer','all',30)).rows[0].displayName).toMatch(/^Operator-/);
    await expect(bind('abc','Mango')).rejects.toThrow();await expect(bind(hash(11),'Guessed machine')).rejects.toThrow();
    await expect(bind(address(1),'Mango')).rejects.toThrow();
    await pool.query('UPDATE operator_role_labels SET from_height=1 WHERE operator_identity=$1',[hash(9)]);await bind(hash(9),'Mango',2);await payout(2);
    row=(await source.leaderboard('producer','all',30)).rows[0];expect(row.displayName).toMatch(/^Operator-/);expect(row.paidBaseUnits).toBe('10');
  });
  test('non-user opaque profile has public role totals and shortened addresses without invented weather stats',async()=>{
    await payout(1,address(1),'123456789');await payout(2,address(1),'7','attester',address(1));const key=profileKeyFor(address(1));
    const r=await request(app(source)).get(`/api/operators/${key}/profile`);expect(r.status).toBe(200);expect(r.body.profile).toMatchObject({walletAddress:shortAddress(address(1)),weatherStatisticsAvailable:false,roleEarnings:{overallPaidBaseUnits:null,roles:{producer:{paidBaseUnits:'123456789'},attester:{paidBaseUnits:'7'}}}});
    expect(r.body.profile.totalSubmissions).toBeUndefined();expect(JSON.stringify(r.body)).not.toContain(address(1));expect(r.headers['cache-control']).toContain('no-store');
    const raw=await request(app(source)).get(`/api/operators/${address(1)}/profile`);expect(raw.body.profile.walletAddress).toBe(shortAddress(address(1)));expect(raw.body.profile.profileKey).toBeNull();
    process.env.JWT_SECRET='synthetic-b2-wallet-secret-at-least-32-characters';process.env.WRFCOIN_OPERATOR_TOKEN='synthetic-b2-operator-token-at-least-32-characters';
    const token=jwt.sign({sub:address(1),type:'access'},process.env.JWT_SECRET,{algorithm:'HS256',issuer:'wrfcoin-platform',audience:'wrfcoin-api',expiresIn:'5m'});
    const a=app(source);const own=await request(a).get(`/api/operators/${key}/profile`).set('Authorization',`Bearer ${token}`);expect(own.body.profile.isYou).toBe(true);expect(own.body.profile.walletAddress).toBe(address(1));
    const operator=await request(a).get(`/api/operators/${key}/profile`).set('Authorization',`Bearer ${process.env.WRFCOIN_OPERATOR_TOKEN}`);expect(operator.body.profile.walletAddress).toBe(address(1));
    const anonymous=await request(a).get(`/api/operators/${key}/profile`);expect(anonymous.body.profile.walletAddress).toBe(shortAddress(address(1)));expect(anonymous.body.profile.roleEarnings.roles.producer.paidBaseUnits).toBe('123456789');
    expect((await request(a).get(url()).set('Authorization',`Bearer ${token}`)).body.rows[0].isYou).toBe(true);expect((await request(a).get(url())).body.rows[0].isYou).toBe(false);
  });
  test('legacy user fields retain financial visibility while new role amounts are public and uncached',async()=>{
    await payout(1);const db={execute:async(sql:string)=>({rows:sql.includes('SELECT id, wallet_address')?[{id:'b2-synthetic',created_at:'2026-01-01T00:00:00Z'}]:sql.includes('total_rewards')?[{total_rewards:'999'}]:[]})};
    let r=await request(app(source,db)).get(`/api/operators/${address(1)}/profile`);expect(r.body.profile.totalRewardsEarned).toBeNull();expect(r.body.profile.roleEarnings.roles.producer.paidBaseUnits).toBe('5');
    await payout(2);r=await request(app(source,db)).get(`/api/operators/${address(1)}/profile`);expect(r.body.profile.roleEarnings.roles.producer.paidBaseUnits).toBe('10');
  });
  test('chain/genesis namespaces cannot mix receipts or produce fabricated zero',async()=>{
    await payout(1);await expect(createEarningsSource(pool,'778',genesis,()=>now).leaderboard('producer','all',30)).rejects.toThrow();await expect(createEarningsSource(pool,'777',hash(100),()=>now).profile(address(1))).rejects.toThrow();
    await expect(source.profile('wrf'+address(1).slice(2))).rejects.toThrow('EARNINGS_UNAVAILABLE');
  });
});
