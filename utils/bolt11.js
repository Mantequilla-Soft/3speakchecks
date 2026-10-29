/**
 * Just enough BOLT11 to read a Lightning invoice's payment hash: tagged field `p`
 * of the bech32 data part, which sits between the 35-bit timestamp and the
 * 520-bit signature + checksum. Checksum and signature are not checked; callers
 * only compare the hash against one they already trust.
 */
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function paymentHash(invoice) {
    const str = String(invoice || '').trim().toLowerCase();
    const sep = str.lastIndexOf('1');
    if (!str.startsWith('ln') || sep < 1) return null;
    const words = [];
    for (const c of str.slice(sep + 1)) {
        const v = BECH32.indexOf(c);
        if (v < 0) return null;
        words.push(v);
    }
    const end = words.length - 6 - 104;
    for (let i = 7; i + 3 <= end;) {
        const tag = words[i];
        const len = words[i + 1] * 32 + words[i + 2];
        const data = words.slice(i + 3, i + 3 + len);
        i += 3 + len;
        if (tag !== 1 || len !== 52) continue;
        let acc = 0;
        let bits = 0;
        const bytes = [];
        for (const w of data) {
            acc = (acc << 5) | w;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                bytes.push((acc >> bits) & 0xff);
            }
        }
        return Buffer.from(bytes.slice(0, 32)).toString('hex');
    }
    return null;
}

// The first BOLT11 invoice in a piece of text (a transfer memo), or null.
function findInvoice(text) {
    const m = /\bln(?:bc|tb|bcrt)[0-9a-z]{50,}\b/i.exec(String(text || ''));
    return m ? m[0] : null;
}

module.exports = { paymentHash, findInvoice };
