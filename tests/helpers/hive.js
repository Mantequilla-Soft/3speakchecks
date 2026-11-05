/**
 * Real Hive cryptography, fake Hive chain.
 *
 * hiveAccount('alice') is a deterministic key pair that signs exactly like Keychain
 * (sha256 of the UTF-8 message, compact signature). fakeHiveChain() answers the
 * dhive RPC calls the app makes from an in-memory list of accounts, so signature
 * checks run end to end without a node:
 *
 *   const alice = hiveAccount('alice');
 *   const chain = fakeHiveChain([alice]);
 *   const sig = alice.sign(buildMessage({...}));
 *   ...
 *   chain.calls  // every [api, method, params] the code asked for
 *
 * A method with no stub throws, so an unexpected chain read fails the test loudly.
 */
const dhive = require('@hiveio/dhive');

function hiveAccount(name, { postingDelegates = [] } = {}) {
  const key = dhive.PrivateKey.fromSeed(`checker-tests:${name}`);
  const publicKey = key.createPublic().toString();
  return {
    name,
    key,
    publicKey,
    sign: (message) => key.sign(dhive.cryptoUtils.sha256(Buffer.from(String(message), 'utf8'))).toString(),
    // The account object as condenser_api.get_accounts returns it (the parts the app reads).
    chainAccount: (extra = {}) => ({
      name,
      posting: {
        weight_threshold: 1,
        account_auths: postingDelegates.map((d) => [d, 1]),
        key_auths: [[publicKey, 1]],
      },
      active: { weight_threshold: 1, account_auths: [], key_auths: [[publicKey, 1]] },
      memo_key: publicKey,
      balance: '0.000 HIVE',
      hbd_balance: '0.000 HBD',
      json_metadata: '',
      posting_json_metadata: '',
      ...extra,
    }),
  };
}

function fakeHiveChain(accounts = [], handlers = {}) {
  const byName = new Map(accounts.map((a) => [a.name, typeof a.chainAccount === 'function' ? a.chainAccount() : a]));
  const calls = [];
  const spy = jest.spyOn(dhive.Client.prototype, 'call').mockImplementation(async (api, method, params) => {
    calls.push([api, method, params]);
    const custom = handlers[`${api}.${method}`] || handlers[method];
    if (custom) return custom(params, { byName });
    if (method === 'get_accounts' || method === 'lookup_account_names') {
      const names = params[0] || [];
      const found = names.map((n) => byName.get(n) || null);
      return method === 'get_accounts' ? found.filter(Boolean) : found;
    }
    throw new Error(`[fake hive] no stub for ${api}.${method}`);
  });
  return { calls, spy, addAccount: (a) => byName.set(a.name, a.chainAccount ? a.chainAccount() : a) };
}

module.exports = { hiveAccount, fakeHiveChain };
