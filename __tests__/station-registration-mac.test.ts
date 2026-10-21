import { registerStation, listRegisteredStations, type QueryablePool, type FetchLike } from '../server/services/station-registration-service.js';
const MAC = 'AA:BB:CC:DD:EE:FF';
const input = { name:'Garden', latitude:1, longitude:2, provider:'ambient', mac:MAC, ambientApiKey:'private-key', ambientAppKey:'private-app', elevation_meters:10 };
const fetchDevices = (macs = [MAC]): FetchLike => jest.fn(async () => ({ok:true,status:200,json:async()=>macs.map(macAddress=>({macAddress}))}));
function database(rows: Array<Record<string, any>> = []) {
  const locks = new Map<string, Promise<void>>();
  const clients: QueryablePool[] = [];
  function client() {
    const releases: Array<()=>void> = [];
    let pending: Record<string, any> | undefined;
    const pool: QueryablePool = { query: jest.fn(async (sql, params = []) => {
      await new Promise(resolve=>setImmediate(resolve));
      if(sql.includes('pg_advisory_xact_lock')) {
        const namespace = sql.match(/pg_advisory_xact_lock\((\d+)/)?.[1];
        const key = `${namespace}:${params[0]}`;
        const previous = locks.get(key) ?? Promise.resolve();
        let release!:()=>void;
        const hold = new Promise<void>(r=>{release=r;});
        locks.set(key, previous.then(()=>hold));
        await previous; releases.push(release); return {rows:[]};
      }
      if(sql.includes('COUNT(*)')) return {rows:[{n:0}]};
      if(sql.includes("metadata->>'mac'")) {
        // Emulates the query's canonical (separator/case-insensitive) MAC and case-insensitive provider match.
        const canon=(v:unknown)=>String(v).toLowerCase().replace(/[^0-9a-f]/g,'');
        return {rows:rows.filter(row=>row.is_active && (!sql.includes("COALESCE(metadata->>'provider'") || String(row.metadata.provider ?? 'ambient').trim().toLowerCase() === 'ambient') && canon(row.metadata.mac)===params[0] && (sql.includes('station_id <> $2') ? row.station_id!==params[1] : String(row.owner_address).toLowerCase()!==params[1]))};
      }
      if(sql.includes('WHERE station_id = $1')) return {rows:rows.filter(row=>row.station_id===params[0])};
      if(sql.includes('INSERT INTO weather_stations')) {
        const old = rows.find(row=>row.station_id===params[0]);
        pending = {station_id:params[0],owner_address:params[1],is_active:true,metadata:{...old?.metadata,...JSON.parse(String(params[7]))}};
      }
      return {rows:[]};
    })};
    clients.push(pool);
    return {pool,finish(ok:boolean) { if(ok && pending) {const index=rows.findIndex(row=>row.station_id===pending!.station_id); if(index<0)rows.push(pending);else rows[index]=pending;} releases.reverse().forEach(release=>release()); }};
  }
  async function register(overrides: Record<string,unknown> = {}, owner='owner-a', devices=[MAC], admin=false) {
    const tx=client();
    try {const result=await registerStation({...input,...overrides},owner,{pool:tx.pool,fetchFn:fetchDevices(devices),encryptionKey:'a'.repeat(64)},()=>String(clients.length),{isAdminOverride:admin});tx.finish(result.status<400);return result;}
    catch(error){tx.finish(false);throw error;}
  }
  return {rows,clients,register};
}
describe('Ambient MAC account binding and cross-wallet admission (#1261)',()=>{
  it.each(['11:22:33:44:55:66','',null])('rejects submitted MAC %s absent from account before writing',async mac=>{
    const db=database();const result=await db.register({mac});
    // Empty identity binds the unique account device; a nonempty mismatch must fail.
    if(mac) {expect(result.status).toBe(422);expect(result.body.error).toBe('AMBIENT_MAC_NOT_ON_ACCOUNT');expect(db.rows).toHaveLength(0);}
    else expect(result.status).toBe(201);
  });
  it('returns 422 when the Ambient account lists no devices',async()=>{
    const db=database();const result=await db.register({},'owner-a',[]);
    expect(result.status).toBe(422);expect(result.body.error).toBe('AMBIENT_MAC_NOT_ON_ACCOUNT');expect(db.rows).toHaveLength(0);
  });
  it('binds the only account device when MAC is omitted and still blocks another owner',async()=>{
    const db=database();expect((await db.register({mac:undefined},'owner-a')).status).toBe(201);
    expect(db.rows[0].metadata.mac).toBe(MAC.toLowerCase());
    expect((await db.register({mac:undefined},'owner-b')).status).toBe(409);
  });
  it('requires an explicit device selection for a multi-device account',async()=>{
    const db=database();expect((await db.register({mac:undefined},'owner-a',[MAC,'11:22:33:44:55:66'])).status).toBe(422);expect(db.rows).toHaveLength(0);
  });
  it('keeps the retained MAC on re-registration with a multi-device account',async()=>{
    const db=database([{station_id:'old',owner_address:'owner-a',is_active:true,metadata:{mac:MAC}}]);
    expect((await db.register({stationId:'old',mac:undefined},'owner-a',[MAC,'11:22:33:44:55:66'])).status).toBe(201);
    expect(db.rows[0].metadata.mac.toLowerCase()).toBe(MAC.toLowerCase());
  });
  it.each(['acurite','davis','netatmo','ecowitt','tempest'])('cannot reserve an Ambient MAC through pending provider %s',async provider=>{
    const db=database();const result=await db.register({provider},'attacker');
    expect(result.status).toBe(422);expect(db.rows).toHaveLength(0);
    expect((await db.register({},'real-owner')).status).toBe(201);
  });
  it.each(['AA-BB-CC-DD-EE-FF','aabbccddeeff','aa:bb:cc:dd:ee:ff'])('a legacy row stored as %s still blocks another owner (#1272)',async legacy=>{
    const db=database([{station_id:'legacy',owner_address:'owner-b',is_active:true,metadata:{mac:legacy}}]);
    const result=await db.register({},'owner-a');
    expect(result.status).toBe(409);expect(result.body.error).toBe('MAC_TAKEN');expect(db.rows).toHaveLength(1);
  });
  it.each(['Ambient','AMBIENT',' ambient '])('a legacy row tagged %j still reserves its MAC (#1272)',async provider=>{
    const db=database([{station_id:'legacy',owner_address:'owner-b',is_active:true,metadata:{mac:MAC,provider}}]);
    expect((await db.register({},'owner-a')).status).toBe(409);
  });
  it('locks every spelling of one device on the SAME advisory key (#1272)',async()=>{
    const db=database();
    await db.register({mac:'aa-bb-cc-dd-ee-ff'},'owner-a',['AA:BB:CC:DD:EE:FF']);
    await db.register({mac:'AA:BB:CC:DD:EE:FF'},'owner-b',['AA:BB:CC:DD:EE:FF']);
    const keys=db.clients.flatMap(c=>(c.query as jest.Mock).mock.calls).filter(c=>String(c[0]).includes('pg_advisory_xact_lock(1261')).map(c=>c[1][0]);
    expect(new Set(keys)).toEqual(new Set(['aabbccddeeff']));
  });
  it('ignores a historical pending-provider MAC reservation',async()=>{
    const db=database([{station_id:'pending',owner_address:'attacker',is_active:true,metadata:{mac:MAC,provider:'ecowitt'}}]);
    expect((await db.register({},'real-owner')).status).toBe(201);
  });
  it('cannot promote a retained unverified MAC to Ambient without a key',async()=>{
    const db=database([{station_id:'pending',owner_address:'owner-a',is_active:true,metadata:{mac:MAC,provider:'ecowitt'}}]);
    expect((await db.register({stationId:'pending',mac:undefined,ambientApiKey:''})).status).toBe(422);
  });
  it('requires a validating key for a supplied Ambient MAC',async()=>{
    const db=database();expect((await db.register({ambientApiKey:''})).status).toBe(422);expect(db.rows).toHaveLength(0);
  });
  it('matches any device, normalizes case/whitespace, and keeps MAC out of the response',async()=>{
    const db=database();const result=await db.register({mac:' aa:bb:cc:dd:ee:ff '},'owner-a',['other',MAC]);
    expect(result.status).toBe(201);expect(db.rows[0].metadata.mac).toBe(MAC.toLowerCase());
    expect(JSON.stringify(result.body)).not.toMatch(/aa:bb|AA:BB|private-key/);
  });
  it.each([false,true])('rejects active MAC held by another owner, admin=%s',async admin=>{
    const db=database([{station_id:'old',owner_address:'OWNER-B',is_active:true,metadata:{mac:MAC}}]);
    const result=await db.register({},'owner-a',[MAC],admin);expect(result.status).toBe(409);expect(result.body.error).toBe('MAC_TAKEN');expect(db.rows).toHaveLength(1);
  });
  it('permits same-owner re-registration and inactive other-owner claims',async()=>{
    const db=database([{station_id:'old',owner_address:'OWNER-A',is_active:true,metadata:{mac:MAC}},{station_id:'retired',owner_address:'owner-b',is_active:false,metadata:{mac:MAC}}]);
    expect((await db.register({stationId:'old'})).status).toBe(201);expect(db.rows).toHaveLength(2);
  });
  it('cannot rotate credentials to another account by omitting a stored MAC',async()=>{
    const db=database([{station_id:'old',owner_address:'owner-a',is_active:true,metadata:{mac:MAC}}]);
    expect((await db.register({stationId:'old',mac:undefined},'owner-a',['different'])).status).toBe(422);
  });
  it('serializes different wallets claiming the same normalized MAC',async()=>{
    const db=database();const results=await Promise.all(Array.from({length:8},(_,i)=>db.register({stationId:`s-${i}`,mac:i%2?MAC.toLowerCase():MAC},`owner-${i}`)));
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(7);expect(db.rows).toHaveLength(1);
  });
  it('refuses the same owner binding one MAC to a second active station (owner ruling 2026-09-27)',async()=>{
    const db=database();
    expect((await db.register({stationId:'s1'},'owner-a')).status).toBe(201);
    const second=await db.register({stationId:'s2',mac:' aa:bb:cc:dd:ee:ff '},'OWNER-A');
    expect(second.status).toBe(409);expect(second.body.error).toBe('MAC_TAKEN');
    expect(db.rows.map(row=>row.station_id)).toEqual(['s1']);
  });
  it('keeps re-binding the same station idempotent under the one-MAC-one-station rule',async()=>{
    const db=database();
    expect((await db.register({stationId:'s1'},'owner-a')).status).toBe(201);
    expect((await db.register({stationId:'s1'},'owner-a')).status).toBe(201);
    expect((await db.register({stationId:'s1',mac:undefined},'owner-a')).status).toBe(201);
    expect(db.rows).toHaveLength(1);
  });
  it('lets the same owner reuse the MAC of an inactive station',async()=>{
    const db=database([{station_id:'retired',owner_address:'owner-a',is_active:false,metadata:{mac:MAC}}]);
    expect((await db.register({stationId:'s2'},'owner-a')).status).toBe(201);expect(db.rows).toHaveLength(2);
  });
  it('serializes one owner binding one MAC to several stations',async()=>{
    const db=database();const results=await Promise.all(Array.from({length:6},(_,i)=>db.register({stationId:`s-${i}`},'owner-a')));
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(5);expect(db.rows).toHaveLength(1);
  });
  it('fails closed if the active-MAC ownership query fails',async()=>{
    const pool:QueryablePool={query:jest.fn(async sql=>{if(sql.includes("metadata->>'mac'"))throw Error('database unavailable');return {rows:sql.includes('COUNT(*)')?[{n:0}]:[]};})};
    const result=await registerStation(input,'owner-a',{pool,fetchFn:fetchDevices(),encryptionKey:'a'.repeat(64)},()=> 'id');
    expect(result.status).toBe(503);expect((pool.query as jest.Mock).mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);
  });
  it('public station projection never returns MAC or raw metadata',async()=>{
    const pool:QueryablePool={query:jest.fn(async()=>({rows:[{station_id:'s',name:'Garden',latitude:1,longitude:2,is_active:true,metadata:{mac:MAC},mac:MAC,mac_address:MAC}]}))};
    const page=await listRegisteredStations(pool);expect(page.stations).toHaveLength(1);expect(page.stations[0].name).toBe('Garden');
    expect(JSON.stringify(page)).not.toContain(MAC);expect(page.stations[0]).not.toHaveProperty('metadata');
  });
});
