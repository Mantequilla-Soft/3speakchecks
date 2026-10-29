/**
 * Lightning supports: reading @v4vapp's credits and the payers' invoice transfers
 * off account history, without touching Hive or Mongo.
 */
const { paymentHash, findInvoice } = require('../utils/bolt11');
const { _test } = require('../services/lightningSupports');

const { creditsFrom, payersFrom, commentOf, LINK_RE } = _test;

// BOLT11 spec test vector; its payment hash is 0001020304...0102.
const SPEC_INVOICE = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

// A real credit from @v4vapp (block 111182815), as account history returns it.
const credit = (overrides = {}) => [487600, {
  trx_id: '3abf2c5102bcbb3d8f691d31e73460e9256f6543',
  block: 111182815,
  timestamp: '2026-10-29T01:04:39',
  op: ['custom_json', {
    required_auths: ['v4vapp'],
    required_posting_auths: [],
    id: 'v4vapp_transfer',
    json: JSON.stringify({
      from_account: 'v4vapp',
      to_account: 'melinda010100',
      sats: 1000,
      msats: 1000000,
      memo: 'melinda010100 | Happy Halloween! https://3speak.tv/shorts?v=melinda010100/nxbww8bv #v4vapp #lightningaddress',
      parent_id: Buffer.from(SPEC_HASH, 'hex').toString('base64'),
      ...overrides,
    }),
  }],
}];

describe('bolt11', () => {
  test('reads the payment hash of the spec vector', () => {
    expect(paymentHash(SPEC_INVOICE)).toBe(SPEC_HASH);
  });
  test('finds an invoice inside a memo and ignores junk', () => {
    expect(findInvoice(`pay ${SPEC_INVOICE} thanks`)).toBe(SPEC_INVOICE);
    expect(findInvoice('no invoice here')).toBeNull();
    expect(paymentHash('not an invoice')).toBeNull();
  });
});

describe('creditsFrom', () => {
  test('reads sats, recipient and payment hash from a v4vapp credit', () => {
    const [c] = creditsFrom([credit()]);
    expect(c).toMatchObject({ to: 'melinda010100', sats: 1000, hash: SPEC_HASH, trx_id: '3abf2c5102bcbb3d8f691d31e73460e9256f6543' });
  });
  test('skips credits to v4vapp itself, fees and other custom_jsons', () => {
    expect(creditsFrom([credit({ to_account: 'v4vapp' })])).toHaveLength(0);
    expect(creditsFrom([credit({ from_account: 'someone' })])).toHaveLength(0);
    const other = credit();
    other[1].op[1].id = 'something_else';
    expect(creditsFrom([other])).toHaveLength(0);
  });
  test('a credit not signed by v4vapp does not count', () => {
    const forged = credit();
    forged[1].op[1].required_auths = ['mallory'];
    expect(creditsFrom([forged])).toHaveLength(0);
  });
});

describe('payersFrom', () => {
  test('maps an invoice paid from Hive to its payer', () => {
    const transfer = [1, { op: ['transfer', { from: 'tibfox', to: 'v4vapp', amount: '19.738 HIVE', memo: SPEC_INVOICE }] }];
    expect(payersFrom([transfer]).get(SPEC_HASH)).toBe('tibfox');
  });
});

describe('memo parsing', () => {
  test('keeps only the tipper comment', () => {
    expect(commentOf('melinda010100 | Happy Halloween! https://3speak.tv/x #v4vapp #lightningaddress', 'melinda010100'))
      .toBe('Happy Halloween! https://3speak.tv/x');
  });
  test('finds the post in every link form the site uses', () => {
    for (const link of [
      'https://3speak.tv/audio/nicklewis/marbles-mv7579qk',
      'https://3speak.tv/watch?v=nicklewis/marbles-mv7579qk',
      'https://3speak.tv/shorts?v=nicklewis/marbles-mv7579qk',
      'https://3speak.tv/@nicklewis/marbles-mv7579qk',
    ]) {
      const m = LINK_RE.exec(`thanks ${link} #v4vapp`);
      expect(m && [m[1], m[2]]).toEqual(['nicklewis', 'marbles-mv7579qk']);
    }
  });
});
