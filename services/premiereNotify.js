/**
 * Premiere reminders as notifications.
 *
 * A viewer who pressed "Notify me" on a premiere (services/premieres.js,
 * premiere_reminders) is told when it starts, in two places:
 *
 *   - the bell: premiereSource() is one more source of the checker's feed
 *     (routes/notify.js). It is read when the bell asks, from the viewer's own
 *     reminders, so it shows while the premiere runs and needs no fan-out.
 *   - web push: runOnce() takes the reminders whose premiere started in the last
 *     30 minutes and were not handed out yet, pushes each to that viewer's
 *     browsers (utils/webPush.js) and marks them, so a premiere is pushed once.
 *     The viewer asked for this one premiere, so the push kinds do not gate it.
 *
 * Background-jobs instance only (it marks shared rows); every PREMIERE_NOTIFY_SEC.
 */
const premieres = require('./premieres');
const push = require('../utils/webPush');
const { levelOf } = require('../utils/notifyLevels');

const INTERVAL_SEC = Math.max(20, parseInt(process.env.PREMIERE_NOTIFY_SEC, 10) || 60);

const watchUrl = (owner, permlink) => `/watch?v=${owner}/${permlink}`;

async function premiereSource({ user, levels, now }) {
  const list = await premieres.remindersOf(user, now);
  return list
    .filter((p) => p.state === 'live' && levelOf(levels, p.owner) !== 'off')
    .map((p) => ({
      id: `premiere:${p.owner}/${p.permlink}`,
      type: 'premiere',
      actor: p.owner,
      title: p.title || p.permlink,
      url: watchUrl(p.owner, p.permlink),
      thumbnail: p.thumbnail || null,
      at: p.startAt,
      live: true,
      author: p.owner,
      permlink: p.permlink,
    }));
}

async function runOnce({ now = Date.now() } = {}) {
  const due = await premieres.dueReminders({ now });
  if (!due.length) return { due: 0, sent: 0 };
  let sent = 0;
  const done = [];
  for (const r of due) {
    try {
      const res = await push.sendToUser(r.user, {
        title: `@${r.owner}'s premiere has started`,
        body: r.title,
        url: watchUrl(r.owner, r.permlink),
        tag: `premiere:${r.owner}/${r.permlink}`,
      });
      sent += res.sent;
      done.push(r.id);
    } catch (err) {
      console.warn(`[premiereNotify] push failed for ${r.user}: ${err.message}`);
    }
  }
  await premieres.markReminded(done);
  return { due: due.length, sent };
}

function schedule() {
  const tick = () => runOnce().catch((e) => console.error('[premiereNotify] run:', e.message));
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_SEC * 1000);
  }, 50 * 1000);
  console.log(`Premiere reminders every ${INTERVAL_SEC}s (first pass in 50 s)`);
}

module.exports = { premiereSource, runOnce, schedule };
