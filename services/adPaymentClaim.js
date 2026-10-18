/**
 * Verify a campaign's on-chain payment and schedule the flight.
 *
 * This used to live inside POST /advertise/campaigns/:id/claim, which meant a
 * payment only counted once the advertiser came back and pressed something: the
 * website's wallet flow calls claim after the transfer, and "I have sent it" calls
 * it by hand. Anybody who paid from their own wallet and closed the tab left the
 * money sitting in the payment account with the flight never scheduled.
 *
 * Now it is one function with two callers: the route, and services/adPaymentWatch.js,
 * which looks for payments on every unpaid booking by itself. One implementation of
 * "prove the transfer happened, exactly once" — the reservation on the unique txid
 * index is what makes running it from two places safe.
 */
const { transfersSince, hiveRpcBatch } = require('../utils/hive');
const {
  AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_PAYMENTS_COLLECTION,
  AD_PAYMENT_ACCOUNT, AD_BOOKING_EXPIRY_DAYS,
} = require('../utils/config');
const { STATES, ensureAdIndexes, windowFrom } = require('../utils/adModel');
const { balanceOf } = require('../utils/adBalance');

// HBD per HIVE from the on-chain median feed, so a HIVE payment is valued the
// same way promote.js values one. Never trust a client-supplied rate.
async function getHbdPerHive() {
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', method: 'condenser_api.get_current_median_history_price', params: [], id: 1,
  }]);
  const base = parseFloat(res?.result?.base);
  const quote = parseFloat(res?.result?.quote);
  if (!base || !quote) return 0;
  return base / quote;
}

function parseAsset(s) {
  const [amount, symbol] = String(s || '').trim().split(' ');
  return { amount: parseFloat(amount) || 0, symbol: (symbol || '').toUpperCase() };
}

/**
 * What the flight costs. A self-promotion booking (routes/adSelfPromo.js) stores
 * `totalHbd` and no `priceHbd`, and `x >= undefined` is false, so without this a
 * self-promo flight could be paid in full and never be scheduled.
 */
function priceOf(campaign) {
  return Number(campaign.priceHbd ?? campaign.totalHbd) || 0;
}

/**
 * One claim per campaign at a time, within this process.
 *
 * The txid reservation already stops a transfer being credited twice. What it does
 * not stop is two claims that each reserve a DIFFERENT transfer, both read paidHbd
 * before either writes, and both $set "what I read + what I found" — the second
 * write erases the first credit. The watcher makes two claims on one campaign at
 * once a real possibility (it runs while the advertiser presses "I have sent it"),
 * and both callers live in the main process, so a per-campaign queue closes it.
 */
const inFlight = new Map();
function withCampaignLock(key, fn) {
  const prev = inFlight.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  inFlight.set(key, tail);
  tail.then(() => { if (inFlight.get(key) === tail) inFlight.delete(key); });
  return run;
}

/**
 * Returns `{ status, body, campaign?, creative? }`: the HTTP status and JSON body the
 * claim route answers with. `campaign` and `creative` are the raw rows for the route
 * to present (publicCampaign lives with the route).
 *
 * `opts.ops` lets a caller that has already read the payment account's history pass
 * it in, so the watcher reads the chain once per run rather than once per campaign.
 */
function claimCampaignPayment(db, id, opts = {}) {
  return withCampaignLock(String(id), () => claimLocked(db, id, opts));
}

async function claimLocked(db, id, { ops: prefetchedOps } = {}) {
  await ensureAdIndexes();
  const campaign = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
  if (!campaign) return { status: 404, body: { success: false, error: 'Campaign not found' } };
  if (campaign.status === STATES.CANCELLED) {
    return { status: 409, body: { success: false, error: 'That campaign was cancelled' } };
  }
  const priceHbd = priceOf(campaign);

  /* 🚨 BOUNDED BY DATE, NOT BY COUNT.
   *
   * This read the last 1000 transfers in one call, which is the most a node will
   * return. That is a moving window, and payouts leave the same account advertisers
   * pay into, so every creator payout pushes older payments towards the edge of it.
   * An advertiser who paid and came back to claim a day later could find their
   * transfer had fallen off the end: money sent, nothing claimable, and no error
   * that says why.
   *
   * The honest bound is time. A payment carrying `ad:<id>` cannot predate the
   * campaign it names, so the scan only has to reach back to when the campaign was
   * booked. An hour of margin covers clock skew between us and the chain, and the
   * fallback covers a campaign with no createdAt — older than the booking expiry,
   * so it still spans every window in which a payment could arrive and still count.
   */
  let ops = prefetchedOps;
  if (!ops) {
    const bookedAtMs = Date.parse(campaign.createdAt);
    const sinceMs = Number.isFinite(bookedAtMs)
      ? bookedAtMs - 60 * 60 * 1000
      : Date.now() - (AD_BOOKING_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000;
    ops = await transfersSince(AD_PAYMENT_ACCOUNT, sinceMs);
  }

  const memoWanted = String(campaign.memo || `ad:${id}`).toLowerCase();
  const matches = [];
  for (const entry of ops) {
    const op = entry?.[1]?.op;
    const trxId = entry?.[1]?.trx_id;
    if (!op || op[0] !== 'transfer' || !trxId) continue;
    const t = op[1];
    if (t.to !== AD_PAYMENT_ACCOUNT) continue;
    if (String(t.memo || '').trim().toLowerCase() !== memoWanted) continue;
    matches.push({ trxId, from: t.from, amount: t.amount });
  }
  if (!matches.length) {
    return {
      status: 404,
      body: {
        success: false,
        error: 'No matching transfer found yet',
        expect: { to: AD_PAYMENT_ACCOUNT, memo: campaign.memo, amount: `${priceHbd.toFixed(3)} HBD` },
      },
    };
  }

  /* ─── who is allowed to pay ────────────────────────────────────────────
   * A transfer only counts if it came FROM the account the campaign is booked
   * under. Registration is deliberately unsigned — several 3Speak login methods
   * cannot sign a message — so until this point nothing had ever proved that an
   * applicant holds the account they claimed. Paying from it does: a transfer
   * requires the ACTIVE key, which is strictly stronger proof than the posting
   * signature the apply route treats as optional.
   *
   * So this is the ownership check, expressed as money rather than as a
   * signature. A payment from anywhere else is refused and owed back.
   *
   * `campaign.hiveAccount` is written from the advertiser record at booking
   * (routes/adCampaigns.js, campaign create), never from a request body — a
   * client-supplied expected-payer would make this check decorative.
   */
  const expectedPayer = String(campaign.hiveAccount || '').trim().toLowerCase();
  const sameAccount = (from) => !!expectedPayer && String(from || '').trim().toLowerCase() === expectedPayer;

  // Reserve before crediting: a duplicate key here means another request already
  // counted this payment, so it is skipped rather than credited twice. Refused
  // transfers are reserved too — the unique index is what stops the same stray
  // payment being queued for refund over and over on every claim retry.
  const payments = db.collection(AD_PAYMENTS_COLLECTION);
  const reserved = [];
  const refused = [];
  for (const m of matches) {
    const ok = sameAccount(m.from);
    const base = {
      trx_id: m.trxId, campaignId: id, from: m.from, amount: m.amount, processedAt: new Date(),
    };
    try {
      await payments.insertOne(ok ? { ...base, status: 'credited' } : {
        ...base,
        status: 'refused',
        // An absent expected payer means the campaign has no account on it at
        // all, which should not happen. Failing CLOSED is deliberate: crediting
        // an unverifiable payment would defeat the whole point of the check, and
        // the money is recorded and refundable either way.
        reason: expectedPayer ? 'payer_mismatch' : 'advertiser_unknown',
        expectedFrom: expectedPayer || null,
        refundStatus: 'pending',
        refundTo: m.from,
        refundAmount: m.amount,
      });
      (ok ? reserved : refused).push(m);
    } catch (e) {
      if (e?.code !== 11000) throw e;
    }
  }

  if (!reserved.length) {
    const current = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
    const creative = current?.creativeEmbedId
      ? await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: current.creativeEmbedId })
      : null;
    // Nothing creditable. Say WHICH of the two it is — "already credited" in
    // front of somebody whose payment was just refused would be actively
    // misleading about where their money went.
    if (refused.length) {
      console.warn(`[ad-campaigns] ${id} refused ${refused.length} transfer(s) from the wrong account (expected @${expectedPayer}): ${refused.map((m) => `@${m.from} ${m.amount}`).join(', ')}`);
      return {
        status: 409,
        body: {
          success: false,
          error: `That payment came from @${refused[0].from}, but this campaign is booked under @${campaign.hiveAccount}. Pay from @${campaign.hiveAccount} — that is how we confirm the account is yours. The transfer we received will be sent back.`,
          refused: refused.map((m) => ({ from: m.from, amount: m.amount, willBeReturnedTo: m.from })),
          expectedFrom: campaign.hiveAccount,
        },
      };
    }
    return { status: 200, body: { success: true, message: 'Already credited' }, campaign: current, creative };
  }
  if (refused.length) {
    console.warn(`[ad-campaigns] ${id} refused ${refused.length} transfer(s) from the wrong account (expected @${expectedPayer})`);
  }

  const hbdPerHive = await getHbdPerHive();
  let credited = 0;
  /* What actually ARRIVED, in native units, alongside the HBD valuation.
   *
   * 🚨 `paidHbd` is a VALUATION, not a balance. It is what the flight is worth in
   * HBD, and pricing, servability and under-delivery credit are all measured
   * against it — but the tokens in the payout account are whatever the advertiser
   * actually sent. Paying an HBD-denominated obligation out of a HIVE-funded
   * campaign is not a treasury inconvenience, it is impossible: the transfer fails.
   *
   * So the mix is carried through to settlement and paid out IN KIND. No
   * conversion, no exchange exposure, and creators receive exactly the asset that
   * was paid for their inventory.
   */
  const assets = { ...(campaign.paidAssets || {}) };
  for (const m of reserved) {
    const { amount, symbol } = parseAsset(m.amount);
    if (symbol === 'HBD') credited += amount;
    else if (symbol === 'HIVE') credited += amount * hbdPerHive;
    else continue;   // not valued above, so not banked here either
    assets[symbol] = Math.round(((assets[symbol] || 0) + amount) * 1000) / 1000;
  }

  let paidHbd = Math.round(((campaign.paidHbd || 0) + credited) * 1000) / 1000;

  /* ─── spend any balance they are carrying ──────────────────────────────
   * A previous campaign that under-delivered leaves credit rather than a refund
   * (utils/adBalance.js). This is where it gets spent — automatically, at the
   * moment it would make a difference, because credit an advertiser has to know
   * about and ask for is not really credit.
   *
   * Applied only to close a shortfall, never beyond it: overspending the balance
   * on a flight that was already paid for would take money out of their account
   * and give them nothing for it.
   *
   * Once per campaign (`creditAppliedHbd` must not already be set). That bound is
   * what stops two concurrent claims each drawing the same balance — the worst
   * case becomes "some credit was not spent on this booking", which is visible and
   * recoverable, rather than "the balance went negative", which is not.
   */
  let creditApplied = 0;
  if (paidHbd + 1e-6 < priceHbd && !campaign.creditAppliedHbd) {
    const shortBy = Math.round((priceHbd - paidHbd) * 1000) / 1000;
    const available = await balanceOf(db, campaign.advertiserRef);
    const take = Math.min(available, shortBy);
    if (take > 0) {
      const applied = await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne(
        { _id: id, creditAppliedHbd: { $exists: false } },
        { $set: { creditAppliedHbd: take, creditAppliedAt: new Date() } },
      );
      if (applied.modifiedCount === 1) {
        creditApplied = take;
        paidHbd = Math.round((paidHbd + take) * 1000) / 1000;
        console.log(`[ad-campaigns] ${id} applied ${take} HBD of credit for @${campaign.hiveAccount} (balance was ${available})`);
      }
    }
  }

  const fullyPaid = paidHbd + 1e-6 >= priceHbd;
  const window = fullyPaid ? windowFrom(campaign.requestedStartAt, campaign.days) : {};

  const update = { paidHbd, paidAssets: assets, updatedAt: new Date() };
  if (fullyPaid) {
    // The flight clock starts now (or at the requested start), never at booking —
    // a campaign paid a week late should get its full run, not what is left of it.
    update.startAt = window.startAt;
    update.endAt = window.endAt;
    update.status = STATES.SCHEDULED;
  }

  try {
    await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne({ _id: id }, { $set: update });
  } catch (creditErr) {
    // Never lose a real payment to a transient write failure — release the
    // reservation so a retry can apply it.
    await payments.deleteMany({ trx_id: { $in: reserved.map((m) => m.trxId) } }).catch(() => {});
    throw creditErr;
  }

  const fresh = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
  const creative = fresh?.creativeEmbedId
    ? await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: fresh.creativeEmbedId })
    : null;
  console.log(`[ad-campaigns] ${id} credited ${credited.toFixed(3)} HBD (total ${paidHbd}/${priceHbd})`);
  return {
    status: 200,
    body: {
      success: true,
      message: fullyPaid ? 'Payment received, flight scheduled' : 'Partial payment received',
      creditedHbd: credited,
      // Say so when a balance covered part of it, or the numbers do not add up from
      // the advertiser's side and it looks like they were charged the wrong amount.
      ...(creditApplied > 0 ? {
        creditAppliedHbd: creditApplied,
        creditNote: `${creditApplied} HBD of credit from an earlier campaign that under-delivered was applied to this booking.`,
      } : {}),
      // A part-payment from the right account alongside a stray one from the wrong
      // account still has to be told about, or the advertiser is left wondering why
      // the total is short.
      ...(refused.length ? {
        refused: refused.map((m) => ({ from: m.from, amount: m.amount, willBeReturnedTo: m.from })),
        refusedNote: `We could not count ${refused.length === 1 ? 'a transfer' : `${refused.length} transfers`} sent from another account. Pay from @${campaign.hiveAccount}; the rest will be sent back.`,
      } : {}),
    },
    campaign: fresh,
    creative,
  };
}

module.exports = { claimCampaignPayment, getHbdPerHive, parseAsset, priceOf };
