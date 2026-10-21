import { callerHeaderFlows } from './helpers/core4-header-flow-guard';

it.each([
  'forwardCore4Headers(req.headers)',
  'const {forwardCore4Headers: f} = client; f(req.headers)',
  'client.forwardCore4Headers(req.headers)',
  'fetchCore4Json("/x", {headers: {...req.headers}})',
  'const h = req.headers; forwardCore4Headers(h)',
  'fetchCore4Json("/x", {headers: req.headers})',
  'const {authorization} = req.headers; fetchCore4Json("/x", {headers: {authorization}})',
  'const r = req; const opts = {headers: r["headers"]}; const f = fetchCore4Json; f("/x", opts)',
  'let h; h = req.headers; client["fetchCore4Json"]("/x", {headers: h})',
  'const headers = () => req.headers; fetchCore4Json("/x", {headers: headers()})',
  'function headers(req) {return req.headers} fetchCore4Json("/x", {headers: headers(req)})',
  'const core4ReaderHeaders = x => x; fetchCore4Json("/x", {headers: core4ReaderHeaders(req.headers)})',
  'const {core4ReaderHeaders} = require("./fake/core4-reader-credential"); fetchCore4Json("/x", {headers: core4ReaderHeaders(req.headers)})',
])('catches caller credential flow: %s', snippet => {
  expect(callerHeaderFlows(new Map([['probe.js', `function probe(req) { ${snippet}; }`]]))).not.toEqual([]);
});
it.each(['core4ReaderHeaders', 'core4PublicReadHeaders', 'core4TraceHeaders', 'core4ContributorHeaders', 'core4OperatorHeaders'])('accepts only the imported server policy helper %s', helper => {
  const module = helper === 'core4OperatorHeaders' ? 'admin-policy' : helper === 'core4ContributorHeaders' ? 'contributor-credential' : 'reader-credential';
  const source = `const {${helper}: safe} = require('./server/utils/core4-${module}'); function probe(req) {fetchCore4Json('/x', {headers: safe(req.headers)})}`;
  expect(callerHeaderFlows(new Map([['probe.js', source]]))).toEqual([]);
});
it('keeps lexical bindings separate and ignores unrelated auth', () => {
  const source = `function auth(req) { const h = req.headers; return h.authorization; }
    function read() {const h = {authorization: 'server'}; fetchCore4Json('/x', {headers: h})}`;
  expect(callerHeaderFlows(new Map([['probe.js', source]]))).toEqual([]);
});
it('proves a wrapper only when all its returns use the real policy helper', () => {
  const safe = `const {core4ReaderHeaders} = require('./server/utils/core4-reader-credential');
    function headers(h) {return core4ReaderHeaders(h)}
    function probe(req) {fetchCore4Json('/x', {headers: headers(req.headers)})}`;
  expect(callerHeaderFlows(new Map([['probe.js', safe]]))).toEqual([]);
  expect(callerHeaderFlows(new Map([['probe.js', safe.replace('return core4ReaderHeaders(h)', 'if (h.cookie) return h; return core4ReaderHeaders(h)')]]))).not.toEqual([]);
});
