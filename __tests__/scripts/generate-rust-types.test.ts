/** Generator control tests: cargo is always a stub; no Rust compilation. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync,cpSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=resolve('scripts/generate-rust-types.sh');
const realDest=resolve('shared/generated-types');
const HAND_MAINTAINED=['AccuracyWindow','ForecastAccuracyMetrics','Pair','SensorAccuracyBand','SensorAccuracyMetrics','SensorReferencePair'];
// Every committed binding that core4's crates do export (index.ts excluded).
const CORE4_PRODUCED=readdirSync(realDest).filter(f=>f.endsWith('.ts')&&f!=='index.ts').map(f=>f.slice(0,-3)).filter(n=>!HAND_MAINTAINED.includes(n));
const FORECAST=['CategoricalScores'];
const METEO=CORE4_PRODUCED.filter(n=>!FORECAST.includes(n));

// Stub cargo: records the crate it ran in, then mimics ts-rs. With
// TS_RS_EXPORT_DIR set it writes <dir>/bindings/*.ts; without it, ts-rs would
// write into the crate's own ./bindings, which the script must never read.
const STUB=`#!/bin/sh
crate="$(basename "$PWD")"
printf '%s\\n' "$crate" >> "$CARGO_CALL_MARKER"
[ "$CARGO_REFUSE" = 1 ] && exit 99
case "$crate" in meteo-types) list="$STUB_METEO";; forecast-score) list="$STUB_FORECAST";; *) exit 98;; esac
out="\${TS_RS_EXPORT_DIR:-.}/bindings"
mkdir -p "$out"
for n in $list; do printf 'export type %s = { stub: true };\\n' "$n" > "$out/$n.ts"; done
`;

let dir:string;
let dest:string;
let core:string;
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'loop-b17-generator-'));
  mkdirSync(join(dir,'backend/scripts'),{recursive:true});
  copyFileSync(source,join(dir,'backend/scripts/generate-rust-types.sh'));
  dest=join(dir,'backend/shared/generated-types');
  cpSync(realDest,dest,{recursive:true});
  mkdirSync(join(dir,'bin'));
  writeFileSync(join(dir,'bin/cargo'),STUB,{mode:0o755});
  core=join(dir,'core4');
});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));

function git(cwd:string,...args:string[]) {
  const r=spawnSync('git',['-c','user.name=t','-c','user.email=t@example.invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8'});
  if(r.status!==0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function core4Checkout({gitRepo=true}={}) {
  for(const crate of ['meteo-types','forecast-score']) {mkdirSync(join(core,crate),{recursive:true});writeFileSync(join(core,crate,'Cargo.toml'),'[package]\nname="fixture"\n');}
  if(gitRepo) {git(core,'init','-q');git(core,'add','.');git(core,'commit','-q','--no-verify','-m','fixture');}
}
function snapshot() {return Object.fromEntries(readdirSync(dest).map(f=>[f,readFileSync(join(dest,f),'utf8')]));}
function run(env:Record<string,string>={}) {
  const base:Record<string,string|undefined>={...process.env};
  delete base.TS_RS_EXPORT_DIR;
  return spawnSync('bash',[join(dir,'backend/scripts/generate-rust-types.sh')],{encoding:'utf8',env:{
    ...base,CORE4_DIR:core,PATH:`${join(dir,'bin')}:${process.env.PATH}`,CARGO_CALL_MARKER:join(dir,'cargo-called'),
    STUB_METEO:METEO.join(' '),STUB_FORECAST:FORECAST.join(' '),...env,
  }});
}

it.each(['neither','meteo-only','forecast-only'])('refuses missing core4 crates (%s) before invoking cargo',which=>{
  mkdirSync(core);
  for(const crate of which==='meteo-only'?['meteo-types']:which==='forecast-only'?['forecast-score']:[]) {mkdirSync(join(core,crate));writeFileSync(join(core,crate,'Cargo.toml'),'[package]\nname="fixture"\n');}
  const result=run({CARGO_REFUSE:'1'});
  expect(result.status).toBe(1);expect(result.stderr).toMatch(/core4 checkout.*missing|core4.*not found/i);
  expect(existsSync(join(dir,'cargo-called'))).toBe(false);
});

it('refuses a core4 tree that is not a git checkout before invoking cargo',()=>{
  core4Checkout({gitRepo:false});
  const before=snapshot();const result=run();
  expect(result.status).toBe(1);expect(result.stderr).toMatch(/not a git checkout/i);
  expect(existsSync(join(dir,'cargo-called'))).toBe(false);expect(snapshot()).toEqual(before);
});

it('copies core4 output, leaves the listed hand-maintained files alone, and records git describe provenance',()=>{
  core4Checkout();const sha=git(core,'rev-parse','--short=12','HEAD');
  const before=snapshot();const result=run();
  expect(result.status).toBe(0);
  expect(readFileSync(join(dir,'cargo-called'),'utf8').trim().split('\n')).toEqual(['meteo-types','forecast-score']);
  for(const n of CORE4_PRODUCED) expect(readFileSync(join(dest,`${n}.ts`),'utf8')).toContain('stub: true');
  for(const n of HAND_MAINTAINED) expect(readFileSync(join(dest,`${n}.ts`),'utf8')).toBe(before[`${n}.ts`]);
  expect(readFileSync(join(dest,'index.ts'),'utf8')).toBe(before['index.ts']);
  const readme=readFileSync(join(dest,'README.md'),'utf8');
  expect(readme).toContain(`Generated from core4 commit: ${sha} (${CORE4_PRODUCED.length} bindings from meteo-types and forecast-score; the hand-maintained files listed above were not generated).`);
});

it('records a dirty core4 tree in the provenance',()=>{
  core4Checkout();writeFileSync(join(core,'meteo-types','Cargo.toml'),'[package]\nname="edited"\n');
  const result=run();expect(result.status).toBe(0);
  expect(readFileSync(join(dest,'README.md'),'utf8')).toMatch(/^Generated from core4 commit: [0-9a-f]{12}-dirty \(/m);
});

it('fails, listing every destination binding this run did not produce, and leaves the destination unchanged',()=>{
  core4Checkout();const before=snapshot();
  const result=run({STUB_METEO:METEO.filter(n=>n!=='WeatherObservation'&&n!=='GeoLocation').join(' ')});
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/not produced by this core4 run/);
  expect(result.stderr).toContain('GeoLocation.ts');expect(result.stderr).toContain('WeatherObservation.ts');
  for(const n of HAND_MAINTAINED) expect(result.stderr).not.toContain(`${n}.ts`);
  expect(snapshot()).toEqual(before);
});

it('fails when core4 now produces a file the allowlist still calls hand-maintained',()=>{
  core4Checkout();const before=snapshot();
  const result=run({STUB_FORECAST:[...FORECAST,'ForecastAccuracyMetrics'].join(' ')});
  expect(result.status).toBe(1);expect(result.stderr).toMatch(/hand-maintained[^\n]*\n?[^\n]*ForecastAccuracyMetrics\.ts/);
  expect(snapshot()).toEqual(before);
});

it('passes the explicit TS_RS_EXPORT_DIR to both the meteo and the forecast invocation',()=>{
  // The behavioural tests above also kill a dropped TS_RS_EXPORT_DIR: the stub
  // then writes into the crate's own ./bindings, and the run fails.
  const script=readFileSync(source,'utf8');
  for(const [crate,sub] of [['METEO_DIR','meteo'],['FORECAST_DIR','forecast']]) {
    const line=script.split('\n').find(l=>l.includes(`cd "$${crate}"`)&&l.includes('cargo test'));
    expect(line).toBeDefined();expect(line).toContain(`TS_RS_EXPORT_DIR="$GENERATED_ROOT/${sub}"`);
  }
});

it('sources only the current core4 crate paths',()=>{
  const script=readFileSync(source,'utf8');
  expect(script).toContain('CORE4_DIR="${CORE4_DIR:-$WORKSPACE_DIR/core4}"');
  expect(script).toContain('METEO_DIR="$CORE4_DIR/meteo-types"');expect(script).toContain('FORECAST_DIR="$CORE4_DIR/forecast-score"');
  expect(script).not.toContain('$WORKSPACE_DIR/meteo-types');expect(script).not.toContain('$WORKSPACE_DIR/forecast-score');
  expect(script).toContain('describe --always --dirty --abbrev=12');
});

it('the allowlist and the README hand-maintained section list exactly the same files, all present',()=>{
  const allow=readFileSync(join(realDest,'hand-maintained.txt'),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  expect([...allow].sort()).toEqual(HAND_MAINTAINED.map(n=>`${n}.ts`).sort());
  const readme=readFileSync(join(realDest,'README.md'),'utf8');
  const section=readme.split('## Hand-maintained bindings (not generated from core4)')[1]?.split('\n## ')[0] ?? '';
  expect(section).not.toBe('');
  const listed=[...section.matchAll(/^- `([A-Za-z]+\.ts)`/gm)].map(m=>m[1]).sort();
  expect(listed).toEqual([...allow].sort());
  for(const f of allow) expect(existsSync(join(realDest,f))).toBe(true);
});
