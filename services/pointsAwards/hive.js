/**
 * The 3Speak Points kinds whose facts are on Hive, read from HafSQL
 * (utils/hafsql.js, the same read-only copy of Hive's history the comment inbox
 * and the follower stats use):
 *
 *   tag        a viewer tag on someone else's video: the signed `3speak-viewer-tag`
 *              custom_json the vote dialog broadcasts with the vote. Not the
 *              `viewer-tags` collection, which is its unsigned mirror (anyone can
 *              write a row in any name there).
 *   reply      a creator replied to your comment under their 3Speak video, to you
 *   community  joining a Hive community, for 3Speak accounts (contentcreators, or
 *              anyone who watched or listened here in the last weeks)
 *   followers  an account passing 10, 100 or 1000 followers. The count is stored
 *              the first time an account is looked at (`points-follower-base`), so
 *              only milestones crossed after that pay. Looked at once a UTC day, for
 *              accounts that published on 3Speak in the last FOLLOWERS_ACTIVE_DAYS.
 *
 * Every query is bounded by the window (block number or time) and a row limit.
 */

const hafsql = require('../../utils/hafsql');
const { getMutedSet } = require('../../utils/commentMutes');
const { NOT_PEOPLE } = require('../../routes/commentInbox');
const { normalizeInterestTag } = require('../../utils/interestTags');
const { ENABLE_MONGO_WRITES } = require('../../utils/config');
const { ACTIVITY } = require('./activity');
const { windowStart, name, postKey, chunk, dayKey, PERMLINK_RE } = require('./common');

const BLOCK_MS = 3000;
const ROW_LIMIT = 5000;
const FOLLOWER_MILESTONES = [10, 100, 1000];
const FOLLOWERS_ACTIVE_DAYS = 90;
const FOLLOWERS_CHUNK = 500;
const FOLLOWER_BASE = 'points-follower-base';
const STATE = 'points-award-state';

async function sinceBlock(since, now) {
    const [{ head }] = await hafsql.query('select block_num as head from hafsql.follows order by block_num desc limit 1');
    return Number(head) - Math.ceil((now - since.getTime()) / BLOCK_MS);
}

/** Player keys (upload ids) to the Hive post they belong to, for the posts named in `pairs`. */
async function hivePosts(db, pairs) {
    if (!pairs.length) return new Map();
    const rows = await db.collection('embed-video')
        .find({ permlink: { $in: [...new Set(pairs.map((p) => p[1]))] } }, { projection: { _id: 0, owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1 } })
        .toArray();
    return new Map(rows.filter((r) => r.hive_permlink).map((r) => [`${r.owner}/${r.permlink}`, postKey(r.hive_author, r.hive_permlink)]));
}

/** Signed viewer tags in the window, one award per (voter, post, tag). */
async function tagAwards({ db, now, launch }) {
    const since = windowStart(now, launch);
    const rows = await hafsql.query(
        `select required_posting_auths as auths, json, timestamp from hafsql.operation_custom_json_view
          where custom_id = '3speak-viewer-tag' and block_num >= $1 order by block_num limit $2`,
        [await sinceBlock(since, now), ROW_LIMIT],
    );
    const tags = [];
    for (const r of rows) {
        if (new Date(r.timestamp) < since) continue;
        let j;
        try { j = typeof r.json === 'string' ? JSON.parse(r.json) : r.json; } catch { continue; }
        const voter = name(Array.isArray(r.auths) ? r.auths[0] : '');
        const author = name(j && j.author);
        const permlink = String((j && j.permlink) || '');
        const tag = normalizeInterestTag(j && j.tag);
        if (!voter || !author || !PERMLINK_RE.test(permlink) || !tag || voter === author) continue;
        tags.push({ voter, author, permlink, tag });
    }
    const posts = await hivePosts(db, tags.map((t) => [t.author, t.permlink]));
    const seen = new Set();
    const out = [];
    for (const t of tags) {
        const post = posts.get(`${t.author}/${t.permlink}`) || `${t.author}/${t.permlink}`;
        if (post.split('/')[0] === t.voter) continue;
        const id = `tag:${t.voter}:${post}:${t.tag}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, user: t.voter, kind: 'tag', ref: post });
    }
    return out;
}

/** Comments under a 3Speak video that its creator answered in the window. */
async function replyAwards({ db, now, launch }) {
    const rows = await hafsql.query(
        `select author as creator, parent_author as commenter, parent_permlink as comment, root_permlink from hafsql.comments
          where created >= $1 and author = root_author and parent_author <> '' and parent_author <> author
            and deleted = false
          order by created limit $2`,
        [windowStart(now, launch), ROW_LIMIT],
    );
    if (!rows.length) return [];
    const skip = new Set([...NOT_PEOPLE, ...await getMutedSet()]);
    const candidates = rows.filter((r) => r.commenter !== r.creator && !skip.has(r.commenter));
    if (!candidates.length) return [];
    const videos = await db.collection('embed-video')
        .find({ hive_author: { $in: [...new Set(candidates.map((r) => r.creator))] }, hive_permlink: { $in: [...new Set(candidates.map((r) => r.root_permlink))] } },
            { projection: { _id: 0, hive_author: 1, hive_permlink: 1 } })
        .toArray();
    const ours = new Set(videos.map((v) => postKey(v.hive_author, v.hive_permlink)));
    const seen = new Set();
    const out = [];
    for (const r of candidates) {
        const id = `reply:${r.commenter}/${r.comment}`;
        if (!ours.has(postKey(r.creator, r.root_permlink)) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, user: r.commenter, kind: 'reply', ref: r.creator });
    }
    return out;
}

/** Hive community subscriptions in the window, by 3Speak accounts. */
async function communityAwards({ db, now, launch }) {
    const rows = await hafsql.query(
        `select account_name, community_name from hafsql.community_subs
          where created_at >= $1 order by created_at limit $2`,
        [windowStart(now, launch), ROW_LIMIT],
    );
    const subs = rows.map((r) => ({ user: name(r.account_name), community: String(r.community_name || '') }))
        .filter((s) => s.user && /^hive-\d{1,10}$/.test(s.community));
    if (!subs.length) return [];
    const users = [...new Set(subs.map((s) => s.user))];
    const [creators, viewers] = await Promise.all([
        db.collection('contentcreators').distinct('username', { username: { $in: users } }),
        db.collection(ACTIVITY).distinct('user', { user: { $in: users } }),
    ]);
    const known = new Set([...creators, ...viewers]);
    return subs.filter((s) => known.has(s.user))
        .map((s) => ({ id: `community:${s.user}:${s.community}`, user: s.user, kind: 'community', ref: s.community }));
}

/**
 * Follower milestones, once a UTC day. New accounts get their count stored as the
 * base (no award); known ones pay every milestone between their base and now.
 */
async function followerAwards({ db, now }) {
    if (!ENABLE_MONGO_WRITES) return [];
    const today = dayKey(now);
    const state = db.collection(STATE);
    const done = await state.findOne({ _id: 'followers' });
    if (done && done.day === today) return [];

    const since = new Date(now - FOLLOWERS_ACTIVE_DAYS * 24 * 3600 * 1000);
    const [video, audio, based] = await Promise.all([
        db.collection('embed-video').distinct('owner', { processed: { $in: [true, false, null] }, createdAt: { $gte: since }, status: 'published' }),
        db.collection('embed-audio').distinct('owner', { createdAt: { $gte: since }, status: 'published' }),
        db.collection(FOLLOWER_BASE).find({}, { projection: { base: 1 } }).toArray(),
    ]);
    const base = new Map(based.map((b) => [b._id, Number(b.base) || 0]));
    const accounts = [...new Set([...video, ...audio, ...base.keys()].map(name).filter(Boolean))].sort();
    const counts = new Map();
    for (const part of chunk(accounts, FOLLOWERS_CHUNK)) {
        const rows = await hafsql.query(
            'select following_name as account, count(*)::int as n from hafsql.follows where following_name = any($1) group by following_name',
            [part],
        );
        for (const r of rows) counts.set(r.account, Number(r.n) || 0);
    }
    const fresh = [];
    const out = [];
    for (const user of accounts) {
        const n = counts.get(user) || 0;
        if (!base.has(user)) { fresh.push({ user, n }); continue; }
        for (const m of FOLLOWER_MILESTONES) {
            if (base.get(user) < m && n >= m) out.push({ id: `followers:${user}:${m}`, user, kind: 'followers', ref: String(m) });
        }
    }
    const at = new Date(now);
    if (fresh.length) {
        await db.collection(FOLLOWER_BASE).bulkWrite(fresh.map(({ user, n }) => ({
            updateOne: { filter: { _id: user }, update: { $setOnInsert: { base: n, at } }, upsert: true },
        })), { ordered: false });
    }
    await state.updateOne({ _id: 'followers' }, { $set: { day: today, at } }, { upsert: true });
    return out;
}

module.exports = {
    tagAwards, replyAwards, communityAwards, followerAwards,
    FOLLOWER_MILESTONES, FOLLOWER_BASE,
};
