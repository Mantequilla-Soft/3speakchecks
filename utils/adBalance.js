/**
 * An advertiser's unspent balance with us, and where it came from.
 *
 * WHY A BALANCE RATHER THAN A REFUND
 * A flat booking buys a slot for a period, so a campaign that under-delivered against
 * its forecast bought less than it paid for. That difference used to be recorded as a
 * refund owed. It is now kept as credit against their next campaign instead: the money
 * stays with us, the advertiser is still made whole, and they have a reason to come
 * back rather than a payment to chase.
 *
 * ⚠️ That is a deliberate commercial choice and it only stays honest if the credit is
 * genuinely spendable. Anything that makes it hard to use — expiry, a minimum, a
 * booking it cannot be applied to — turns "credit" into "we kept it". There is no
 * expiry here on purpose.
 *
 * 🚨 WHY IT IS DERIVED, NOT STORED
 * The obvious shape is a `creditHbd` counter on the advertiser that gets `$inc`ed when
 * a campaign closes short and decremented when it is spent. Two things go wrong with
 * that. A crash between "close the campaign" and "increment the balance" silently
 * loses somebody's money, and a retry of the same close silently doubles it — and
 * because the counter is the only record, neither is detectable afterwards.
 *
 * So the balance is a SUM over the campaigns that produced and consumed it:
 *
 *     balance = Σ campaign.creditHbd − Σ campaign.creditAppliedHbd
 *
 * Both fields are written inside the same atomic update as the state change that
 * earns or spends them, so the sum cannot drift from what actually happened. Closing
 * a campaign twice cannot double the balance, because the second close writes the
 * same field on the same document rather than adding to a counter. The cost is an
 * aggregation per lookup, over a handful of documents per advertiser.
 */
const { AD_CAMPAIGNS_COLLECTION } = require('./config');

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * What this advertiser has left to spend, in HBD.
 *
 * Never negative: a rounding artefact or a hand-edited document must not turn into a
 * debt we then try to collect by shorting their next flight.
 */
async function balanceOf(db, advertiserRef) {
  if (!advertiserRef) return 0;
  const [row] = await db.collection(AD_CAMPAIGNS_COLLECTION).aggregate([
    { $match: { advertiserRef } },
    {
      $group: {
        _id: null,
        earned: { $sum: { $ifNull: ['$creditHbd', 0] } },
        spent: { $sum: { $ifNull: ['$creditAppliedHbd', 0] } },
      },
    },
  ]).toArray();
  if (!row) return 0;
  return Math.max(0, round3((row.earned || 0) - (row.spent || 0)));
}

/**
 * The same number with its working shown — every campaign that added to or drew from
 * the balance. This is what an advertiser is owed an explanation of, so it returns
 * the campaigns rather than just the total.
 */
async function ledgerOf(db, advertiserRef) {
  if (!advertiserRef) return { balanceHbd: 0, entries: [] };
  const rows = await db.collection(AD_CAMPAIGNS_COLLECTION)
    .find({
      advertiserRef,
      $or: [{ creditHbd: { $gt: 0 } }, { creditAppliedHbd: { $gt: 0 } }],
    })
    .sort({ createdAt: 1 })
    .toArray();

  const entries = [];
  for (const c of rows) {
    if (c.creditHbd > 0) {
      entries.push({
        campaignId: String(c._id),
        name: c.name,
        kind: 'earned',
        hbd: round3(c.creditHbd),
        // The reason, in the advertiser's terms rather than ours.
        reason: `Delivered ${Math.round((c.deliveryRate || 0) * 100)}% of the forecast for this flight`,
        at: c.closedAt || c.updatedAt,
      });
    }
    if (c.creditAppliedHbd > 0) {
      entries.push({
        campaignId: String(c._id),
        name: c.name,
        kind: 'spent',
        hbd: round3(c.creditAppliedHbd),
        reason: 'Applied to this booking',
        at: c.creditAppliedAt || c.createdAt,
      });
    }
  }
  entries.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return { balanceHbd: await balanceOf(db, advertiserRef), entries };
}

module.exports = { balanceOf, ledgerOf, round3 };
