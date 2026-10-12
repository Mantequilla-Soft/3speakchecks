/**
 * A video's author correcting the automatic captions of their own video.
 *
 * The captions are SRT files on IPFS, one per language, listed in the
 * `subtitles` collection as { author, permlink, subtitles: { <lang>: <cid> } }.
 * The pipeline that generates them runs elsewhere; this route only REPLACES the
 * file for one language that already exists:
 *
 *   1. the author proves it is them (signature, see below),
 *   2. the SRT is rebuilt here from the submitted lines, so what is stored is
 *      always clean SRT and never bytes the browser chose,
 *   3. it is added to the IPFS node next door WITH a pin, so garbage collection
 *      can never take an author's edit away (unpinned files are how captions
 *      went missing before),
 *   4. `subtitles.<lang>` points at the new file, and `subtitle_edits.<lang>`
 *      records who, when, who signed, and every file it replaced, so an edit can
 *      be undone and the generator can tell an author's version from its own.
 *
 * 🚨 The generator must not overwrite a language listed in `subtitle_edits`.
 *
 * Proof of authorship, same shape as the ad preferences (routes/advertise.js):
 * a signature over a message WE build from the request, accepted from the
 * author's own posting key or from a posting-authority delegate we sign with
 * (@threespeak, for HiveSigner / Butter Auth sessions that hold no key in the
 * browser). The SHA-256 of the rebuilt SRT is in the message, so a signature
 * made for one text cannot be replayed to store another.
 */
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../utils/db');
const { verifyHiveAuthority } = require('../utils/hiveAuth');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');

const router = express.Router();

const LOCAL_IPFS_API = (process.env.IPFS_API_URL || 'http://127.0.0.1:5001').replace(/\/$/, '');

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const MAX_CUES = 6000;
const MAX_LINE_CHARS = 500;
const MAX_SRT_BYTES = 1024 * 1024;
const MAX_SECONDS = 24 * 3600;
const HISTORY_KEEP = 20;

// Must match captionEditMessage() in the frontend (src/lib/captionEdit.js) and
// the signer in server/index.cjs exactly.
const editMessage = (author, permlink, lang, srtSha256, timestamp) =>
  ['3speak-captions', 'edit', author, permlink, lang, srtSha256, String(timestamp)].join('|');

// ── SRT, byte-for-byte the same as the frontend builds it ──────────────────
const pad = (n, w = 2) => String(n).padStart(w, '0');
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
// Plain text only: no HTML (the player renders cue text), no control characters,
// at most two lines per cue, trimmed.
function cleanText(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2)
    .join('\n')
    .slice(0, MAX_LINE_CHARS);
}
function cuesToSrt(cues) {
  // Every block ends with a blank line, the last one too: the generator's exact
  // layout, so saving unchanged captions yields the same file (same CID).
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n\n`).join('');
}

function validCues(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_CUES) return null;
  const out = [];
  for (const c of raw) {
    const start = Number(c && c.start);
    const end = Number(c && c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || end > MAX_SECONDS) return null;
    const text = cleanText(c.text ?? '');
    if (!text) continue; // an emptied line is a deleted line
    out.push({ start, end, text });
  }
  return out.length ? out : null;
}

async function ipfsAddPinned(text) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), 'captions.srt');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${LOCAL_IPFS_API}/api/v0/add?pin=true&cid-version=0`, {
      method: 'POST', body: form, signal: controller.signal,
    });
    if (!r.ok) throw new Error(`ipfs add ${r.status}`);
    const data = await r.json();
    if (!data || !data.Hash) throw new Error('ipfs add returned no hash');
    return data.Hash;
  } finally {
    clearTimeout(timer);
  }
}

// A small per-author brake: a save is a pin and a database write.
const recentSaves = new Map();
function tooMany(author) {
  const now = Date.now();
  const list = (recentSaves.get(author) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 60) return true;
  list.push(now);
  recentSaves.set(author, list);
  return false;
}

// POST /subtitles/edit — { author, permlink, lang, cues: [{start,end,text}], signature, timestamp }
router.post('/subtitles/edit', express.json({ limit: '2mb' }), async (req, res) => {
  const b = req.body || {};
  const author = String(b.author || '').toLowerCase();
  const permlink = String(b.permlink || '');
  const lang = String(b.lang || '').toLowerCase();
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink) || !LANG_RE.test(lang)) {
    return res.status(400).json({ success: false, error: 'invalid author, permlink or language' });
  }

  const cues = validCues(b.cues);
  if (!cues) return res.status(400).json({ success: false, error: 'invalid captions' });
  const srt = cuesToSrt(cues);
  if (Buffer.byteLength(srt, 'utf8') > MAX_SRT_BYTES) {
    return res.status(413).json({ success: false, error: 'captions too large' });
  }
  const srtSha256 = crypto.createHash('sha256').update(srt, 'utf8').digest('hex');

  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp)) {
    return res.status(401).json({
      success: false,
      error: 'Signature required',
      expected_message: editMessage(author, permlink, lang, srtSha256, '<ms>'),
    });
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
    return res.status(401).json({ success: false, error: 'timestamp out of tolerance' });
  }

  let verdict = { ok: false, signer: null };
  try {
    verdict = await verifyHiveAuthority({
      message: editMessage(author, permlink, lang, srtSha256, timestamp),
      signature,
      username: author,
      allowedDelegates: AD_SIGNING_DELEGATES,
    });
  } catch (err) {
    if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Hive account not found' });
    }
  }
  // Same answer for a wrong text, a wrong key and a wrong account: the message
  // includes the content hash, so "the text changed after signing" lands here too.
  if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });

  if (tooMany(author)) return res.status(429).json({ success: false, error: 'too many edits, try again later' });

  try {
    const col = getDb().collection('subtitles');
    const doc = await col.findOne({ author, permlink }, { projection: { subtitles: 1, subtitle_edits: 1 } });
    const previous = doc && doc.subtitles && doc.subtitles[lang];
    // Only a language that exists can be corrected; adding new languages is the
    // generator's job, not this route's.
    if (!previous) return res.status(404).json({ success: false, error: 'no captions in this language' });

    const cid = await ipfsAddPinned(srt);
    if (cid === previous) return res.json({ success: true, cid, unchanged: true });

    const now = new Date();
    const history = [{ cid: previous, replacedAt: now }]
      .concat((doc.subtitle_edits && doc.subtitle_edits[lang] && doc.subtitle_edits[lang].history) || [])
      .slice(0, HISTORY_KEEP);
    await col.updateOne(
      { author, permlink, [`subtitles.${lang}`]: previous }, // nobody replaced it meanwhile
      {
        $set: {
          [`subtitles.${lang}`]: cid,
          [`subtitle_edits.${lang}`]: {
            by: author,
            // "@threespeak on their behalf" and "the author's own key" are
            // different facts; keep which one it was.
            signedBy: verdict.signer,
            at: now,
            lines: cues.length,
            history,
          },
        },
      },
    ).then((r) => {
      if (!r.matchedCount) {
        const e = new Error('captions changed meanwhile');
        e.status = 409;
        throw e;
      }
    });

    res.json({ success: true, cid });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ success: false, error: 'The captions were changed meanwhile. Reload and try again.' });
    console.error('[subtitle-edit]', author, permlink, lang, err.message);
    res.status(502).json({ success: false, error: 'could not save the captions' });
  }
});

module.exports = router;
module.exports._test = { cuesToSrt, cleanText, validCues, editMessage, srtTime };
