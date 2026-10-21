import { callerHeaderFlows } from './helpers/core4-header-flow-guard';

const flows = [
  ['get', "function probe(req) { fetchCore4Json('/x', {headers: {authorization: req.get('authorization')}}) }"],
  ['get alias', "function probe(req) { const h = req.get('authorization'); fetchCore4Json('/x', {headers: {authorization: h}}) }"],
  ['header', "function probe(req) { fetchCore4Json('/x', {headers: {'x-api-key': req.header('x-api-key')}}) }"],
  ['bracket getter', "function probe(req) { fetchCore4Json('/x', {headers: {authorization: req['header']('authorization')}}) }"],
  ['destructure', "function probe(req) { const {headers} = req; fetchCore4Json('/x', {headers}) }"],
  ['renamed destructure', "function probe(req) { const {headers: h} = req; forwardCore4Headers(h) }"],
  ['parameter destructure', "function probe({headers: h}) { fetchCore4Json('/x', {headers: h}) }"],
  ['renamed request', "function probe(incoming) { fetchCore4Json('/x', {headers: incoming.headers}) }"],
  ['renamed request getter', "const probe = incoming => fetchCore4Json('/x', {headers: {authorization: incoming.get('authorization')}})"],
  ['typed later request', "function probe(url: string, incoming: Request) { fetchCore4Json('/x', {headers: incoming.headers}) }"],
  ['renamed request alias', "function probe(incoming) { const r = incoming; const h = r.headers; fetchCore4Json('/x', {headers: h}) }"],
  ['raw fetch', "function probe(req) { fetch(CORE4_URL + '/x', {headers: req.headers}) }"],
  ['global fetch', "function probe(req) { globalThis.fetch(CORE4_URL + '/x', {headers: req.headers}) }"],
  ['raw fetch alias', "function probe(req) { const send = fetch; send(CORE4_URL + '/x', {headers: req.headers}) }"],
  ['imported fetch alias', "import send from 'node-fetch'; function probe(req) { send(CORE4_URL + '/x', {headers: req.headers}) }"],
  ['combined', "const probe = incoming => {const {headers: h} = incoming; const send = globalThis.fetch; send(CORE4_URL + '/x', {headers: {...h}})}"],
] as const;
it.each(flows)('rejects %s caller-header bypass', (_name, source) => {
  expect(callerHeaderFlows(new Map([['probe.js', source]]))).not.toEqual([]);
});
it.each([
  "function probe(incoming) { const h = incoming.get('authorization'); authenticate(h); fetch('/x', {headers: {authorization: 'server-token'}}) }",
  "function probe(incoming) { const {headers} = incoming; authenticate(headers); fetch('/x', {headers: {authorization: 'server-token'}}) }",
  "function authenticate(incoming) { const h = incoming.headers; return h.authorization; } function probe() { const h = {authorization: 'server'}; fetch('/x', {headers: h}) }",
  "function client(url, options = {}) { const {headers} = options; fetch(url, {headers}) }",
  "function client(url, options = {}) { fetch(url, {headers: options.headers}) }",
  "const {core4ReaderHeaders: safe} = require('./server/utils/core4-reader-credential'); function probe(incoming) {fetch('/x', {headers: safe(incoming.headers)})}",
  "const {core4TraceHeaders: safe} = require('./server/utils/core4-reader-credential'); function probe(incoming) {fetch('/x', {headers: safe(incoming.headers)})}",
])('allows auth-only or canonical sanitized flow: %s', source => {
  expect(callerHeaderFlows(new Map([['probe.js', source]]))).toEqual([]);
});
