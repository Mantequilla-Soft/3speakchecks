/**
 * collectSubscriptions: once an hour the provider account asks the Okinoko Subs
 * contract to bill due subscribers, one signed vsc.call per offer. The key is a
 * throwaway from a test seed and broadcasts are captured on dhive's BroadcastAPI.
 */
const dhive = require('@hiveio/dhive');

process.env.THREESPEAK_PRO_USERNAME = ' threespeakpro ';
process.env.THREESPEAK_PRO_POSTING_KEY = dhive.PrivateKey.fromSeed('checker-tests:threespeakpro').toString();
process.env.COLLECT_SUBS_OFFER_IDS = '5, 7,,';

const { BroadcastAPI } = require('@hiveio/dhive/lib/helpers/broadcast');
const collect = require('../../services/collectSubscriptions');

let sent;
function stubBroadcast(impl = async () => ({ id: `tx${sent.length}` })) {
  sent = [];
  jest.spyOn(BroadcastAPI.prototype, 'sendOperations').mockImplementation(async (ops, key) => {
    sent.push({ ops, signedWithConfiguredKey: key.toString() === process.env.THREESPEAK_PRO_POSTING_KEY });
    return impl(ops);
  });
}

// A fresh copy under other env, with the same dhive the stub is installed on.
function loadWith(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  let mod;
  jest.isolateModules(() => {
    jest.doMock('@hiveio/dhive', () => dhive);
    mod = require('../../services/collectSubscriptions');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  jest.dontMock('@hiveio/dhive');
  return mod;
}
function captureTimers() {
  const timers = [];
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => { timers.push({ kind: 'timeout', fn, ms }); return 0; });
  jest.spyOn(global, 'setInterval').mockImplementation((fn, ms) => { timers.push({ kind: 'interval', fn, ms }); return 0; });
  return timers;
}

beforeEach(() => {
  stubBroadcast();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runCollect', () => {
  test('broadcasts one collect_subscriptions call per configured offer, signed by the provider', async () => {
    await collect.runCollect();

    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.signedWithConfiguredKey)).toBe(true);
    const [[type, op]] = sent[0].ops;
    expect(type).toBe('custom_json');
    expect(op).toMatchObject({ required_auths: [], required_posting_auths: ['threespeakpro'], id: 'vsc.call' });
    expect(JSON.parse(op.json)).toEqual({
      net_id: 'vsc-mainnet',
      contract_id: 'vsc1BpkPNtC1pBLhxtNn4uE3QkLhudoyzAiXUi',
      action: 'collect_subscriptions',
      payload: '5',
      rc_limit: 50000,
      intents: [], // posting authority only: no transfer intent
    });
    expect(JSON.parse(sent[1].ops[0][1].json).payload).toBe('7');
  });

  test('a failing offer is logged and the next offer is still collected', async () => {
    stubBroadcast(async (ops) => {
      if (JSON.parse(ops[0][1].json).payload === '5') throw new Error('RC exhausted');
      return { id: 'ok' };
    });

    await collect.runCollect();

    expect(sent).toHaveLength(2);
    expect(console.error).toHaveBeenCalledWith('[collectSubs] offer 5 → broadcast failed: RC exhausted');
  });

  test('without provider credentials nothing is signed', async () => {
    const mod = loadWith({ THREESPEAK_PRO_POSTING_KEY: '' });
    await mod.runCollect();
    expect(sent).toHaveLength(0);
  });

  test('net, contract and RC limit come from the environment', async () => {
    const mod = loadWith({ VSC_NET_ID: 'vsc-testnet', VSC_SUBS_CONTRACT_ID: 'vsc1Test', COLLECT_SUBS_RC_LIMIT: '1234', COLLECT_SUBS_OFFER_IDS: '9' });
    await mod.runCollect();
    expect(JSON.parse(sent[0].ops[0][1].json)).toMatchObject({ net_id: 'vsc-testnet', contract_id: 'vsc1Test', rc_limit: 1234, payload: '9' });
  });
});

describe('schedule()', () => {
  test.each([
    ['no provider account', { THREESPEAK_PRO_USERNAME: '' }],
    ['no posting key', { THREESPEAK_PRO_POSTING_KEY: '' }],
    ['a key that does not parse', { THREESPEAK_PRO_POSTING_KEY: 'garbage' }],
  ])('does not start with %s', (_label, env) => {
    const mod = loadWith(env);
    const timers = captureTimers();
    mod.schedule();
    expect(timers).toHaveLength(0);
  });

  test('first run after 5 minutes, then every COLLECT_SUBS_INTERVAL_HOURS (never under a minute)', async () => {
    const mod = loadWith({ COLLECT_SUBS_INTERVAL_HOURS: '0.0001', COLLECT_SUBS_OFFER_IDS: '5' });
    const timers = captureTimers();

    mod.schedule();
    expect(timers).toEqual([expect.objectContaining({ kind: 'timeout', ms: 5 * 60 * 1000 })]);

    timers[0].fn();
    expect(timers[1]).toEqual(expect.objectContaining({ kind: 'interval', ms: 60 * 1000 }));
    timers[1].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(2); // one per tick
  });
});
