/**
 * Reading a Lightning invoice's payment hash (utils/bolt11.js), the one field a
 * payment check compares against a hash it already trusts.
 *
 * Uses the BOLT #11 specification's own example invoice, plus invoices built here
 * with a known hash and extra tagged fields around it, so the walk over the tagged
 * fields is tested and not just the first field.
 */
const { paymentHash, findInvoice } = require('../../utils/bolt11');

// From the BOLT #11 spec: payment hash 0001020304050607080900010203040506070809000102030405060708090102.
const SPEC_INVOICE = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const toWords = (bytes) => {
  const words = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
};
const field = (tag, words) => [tag, words.length >> 5, words.length & 31, ...words];
/** An invoice with the given tagged fields, a zero signature and a dummy checksum. */
function invoice(fields, hrp = 'lnbc10u') {
  const words = [...Array(7).fill(0), ...fields.flat(), ...Array(104).fill(0), ...Array(6).fill(0)];
  return `${hrp}1${words.map((w) => BECH32[w]).join('')}`;
}
const HASH = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const P = 1; // tag `p`
const D = 13; // tag `d`, a description

describe('paymentHash', () => {
  test('reads the spec example\'s payment hash', () => {
    expect(paymentHash(SPEC_INVOICE)).toBe(SPEC_HASH);
  });

  test('ignores case and surrounding whitespace', () => {
    expect(paymentHash(`  ${SPEC_INVOICE.toUpperCase()}\n`)).toBe(SPEC_HASH);
  });

  test('finds the hash after other tagged fields', () => {
    const inv = invoice([field(D, toWords(Buffer.from('coffee'))), field(P, toWords(HASH))]);
    expect(paymentHash(inv)).toBe(HASH.toString('hex'));
  });

  test('a `p` field of the wrong length is not a payment hash', () => {
    const inv = invoice([field(P, toWords(Buffer.alloc(20, 7))), field(P, toWords(HASH))]);
    expect(paymentHash(inv)).toBe(HASH.toString('hex'));
  });

  test.each([
    ['no hash field at all', invoice([field(D, toWords(Buffer.from('coffee')))])],
    ['not a Lightning invoice', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['a character outside bech32', `${SPEC_INVOICE.slice(0, 40)}b${SPEC_INVOICE.slice(41)}`],
    ['no separator', 'lnbcqqqqqq'],
    ['empty', ''],
    ['nothing', undefined],
  ])('%s gives null', (_label, input) => {
    expect(paymentHash(input)).toBeNull();
  });
});

describe('findInvoice', () => {
  test.each([
    ['the invoice in a transfer memo', `tip for @alice ${SPEC_INVOICE} thanks`, SPEC_INVOICE],
    ['testnet and regtest prefixes', `pay lntb${'q'.repeat(60)} now`, `lntb${'q'.repeat(60)}`],
    ['a memo with no invoice', 'just a memo', null],
    ['something too short to be one', 'lnbc1qqqq', null],
    ['no memo at all', undefined, null],
  ])('%s', (_label, text, want) => {
    expect(findInvoice(text)).toBe(want);
  });
});
