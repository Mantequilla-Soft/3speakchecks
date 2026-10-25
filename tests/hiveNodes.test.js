/**
 * Hive node failover: a node that fails is tried LAST until its cooldown ends, a
 * total outage still tries every node, a JSON error is not an outage, and heavy
 * calls (get_account_history) keep the old order and timeout.
 */
jest.mock('../utils/config', () => ({
  ...jest.requireActual('../utils/config'),
  HIVE_RPC_ENDPOINTS: ['https://a', 'https://b', 'https://c'],
  HIVE_RPC_TIMEOUT_MS: 3000,
  HIVE_RPC_HEAVY_TIMEOUT_MS: 10000,
  HIVE_NODE_COOLDOWN_MS: 60000,
}));

const { hiveRpcBatch, hiveRpcCall, resetNodeHealth } = require('../utils/hive');

const GET = [{ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params: ['x', 'y'] }];
const HISTORY = [{ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_account_history', params: ['x', -1, 1000, 4, 0] }];

// behaviour per node: 'ok' | 'timeout' | 'html' | 'jsonerror'
let nodes;
let calls;
let timeouts;
const realTimeout = AbortSignal.timeout;

beforeEach(() => {
  resetNodeHealth();
  calls = [];
  timeouts = [];
  nodes = { 'https://a': 'ok', 'https://b': 'ok', 'https://c': 'ok' };
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  global.fetch = jest.fn(async (url) => {
    calls.push(url);
    const mode = nodes[url];
    if (mode === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (mode === 'html') return { json: async () => { throw new SyntaxError('Unexpected token \'<\''); } };
    if (mode === 'jsonerror') return { json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'no bridge' } }) };
    return { json: async () => [{ jsonrpc: '2.0', id: 1, result: { from: url } }] };
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  AbortSignal.timeout = realTimeout;
  jest.restoreAllMocks();
});

test('normal calls use the short timeout and the config order', async () => {
  const [r] = await hiveRpcBatch(GET);
  expect(r.result.from).toBe('https://a');
  expect(calls).toEqual(['https://a']);
  expect(timeouts).toEqual([3000]);
});

test('a node that timed out is tried LAST on the next call', async () => {
  nodes['https://a'] = 'timeout';
  const [r1] = await hiveRpcBatch(GET);
  expect(r1.result.from).toBe('https://b');
  calls = [];
  const [r2] = await hiveRpcBatch(GET);
  expect(r2.result.from).toBe('https://b');
  expect(calls).toEqual(['https://b']);                 // a is skipped, no 3s wait
});

test('an HTML error page counts as a failure too', async () => {
  nodes['https://a'] = 'html';
  await hiveRpcBatch(GET);
  calls = [];
  await hiveRpcBatch(GET);
  expect(calls[0]).toBe('https://b');
});

test('after the cooldown the node is first again', async () => {
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValue(1_000_000);
  nodes['https://a'] = 'timeout';
  await hiveRpcBatch(GET);
  nodes['https://a'] = 'ok';
  now.mockReturnValue(1_000_000 + 60001);
  calls = [];
  const [r] = await hiveRpcBatch(GET);
  expect(r.result.from).toBe('https://a');
  expect(calls).toEqual(['https://a']);
});

test('a cooling node that answers as last resort is marked up again', async () => {
  nodes['https://a'] = 'timeout';
  await hiveRpcBatch(GET);                              // a down
  nodes['https://a'] = 'ok';
  nodes['https://b'] = 'timeout';
  nodes['https://c'] = 'timeout';
  const [r] = await hiveRpcBatch(GET);                  // b, c fail, a answers
  expect(r.result.from).toBe('https://a');
  nodes['https://b'] = 'ok';
  nodes['https://c'] = 'ok';
  calls = [];
  await hiveRpcBatch(GET);
  expect(calls).toEqual(['https://a']);                 // a is up, b and c cooling
});

test('a total outage still tries every node and returns empty', async () => {
  nodes = { 'https://a': 'timeout', 'https://b': 'timeout', 'https://c': 'timeout' };
  expect(await hiveRpcBatch(GET)).toEqual([]);
  calls = [];
  expect(await hiveRpcBatch(GET)).toEqual([]);
  expect(calls.sort()).toEqual(['https://a', 'https://b', 'https://c']);
});

test('heavy calls keep config order and the long timeout, and never mark a node', async () => {
  nodes['https://a'] = 'timeout';
  await hiveRpcBatch(GET);                              // a down for normal calls
  calls = [];
  timeouts = [];
  nodes['https://a'] = 'ok';
  const [r] = await hiveRpcBatch(HISTORY);
  expect(r.result.from).toBe('https://a');              // still asked first
  expect(timeouts).toEqual([10000]);

  resetNodeHealth();
  nodes['https://a'] = 'timeout';
  await hiveRpcBatch(HISTORY);                          // slow history on a...
  calls = [];
  await hiveRpcBatch(GET);
  expect(calls[0]).toBe('https://a');                   // ...does not mark it down
});

test('hiveRpcCall: a JSON error moves on but is NOT an outage', async () => {
  nodes['https://a'] = 'jsonerror';
  const res = await hiveRpcCall('bridge.get_account_posts', {});
  expect(res).toBeNull();                               // b and c return arrays, not {result}
  calls = [];
  await hiveRpcBatch(GET);
  expect(calls).toEqual(['https://a']);                 // a still first
});

test('hiveRpcCall: a timeout marks the node down', async () => {
  nodes['https://a'] = 'timeout';
  await hiveRpcCall('bridge.get_account_posts', {});
  calls = [];
  await hiveRpcBatch(GET);
  expect(calls).toEqual(['https://b']);
});
