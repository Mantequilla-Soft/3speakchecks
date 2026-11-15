/**
 * Sound ids: one name for "the audio a Short uses", shared by the checker
 * (services/soundIndex.js, routes/sounds.js) and 3speak.tv (src/lib/sounds.js,
 * which builds the same ids; keep the two in step).
 *
 *   lib-<slug>                 a song from the editor's music library (library.json `id`)
 *   short_<author>_<permlink>  the original audio of a Hive post (a Short, mostly)
 *   ext-<10 hex>               any other credited song, named by its title + artist
 *
 * `_` never appears in a Hive account or permlink, so a `short_` id splits back
 * into its post without guessing. The post is the HIVE author/permlink (the post
 * the Short was published as), not the upload's asset permlink.
 */
const crypto = require('crypto');

const ACCOUNT = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const PERMLINK = /^[a-z0-9-]{1,255}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SOUND_ID = /^(lib-[a-z0-9][a-z0-9-]{0,79}|short_[a-z][a-z0-9.-]{1,14}[a-z0-9]_[a-z0-9-]{1,255}|ext-[0-9a-f]{10})$/;
// A sound's own page on 3speak.tv, the url the frontend writes into the post.
const PAGE_URL = /^https?:\/\/(?:www\.)?3speak\.tv\/sound\/([^/?#]+)/i;

const norm = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function isSoundId(id) {
  return typeof id === 'string' && id.length <= 300 && SOUND_ID.test(id);
}

function shortSoundId(author, permlink) {
  const a = String(author || '').toLowerCase();
  const p = String(permlink || '').toLowerCase();
  return ACCOUNT.test(a) && PERMLINK.test(p) ? `short_${a}_${p}` : null;
}

/** { kind, author?, permlink?, slug? } for a valid id, else null. */
function parseSoundId(id) {
  if (!isSoundId(id)) return null;
  if (id.startsWith('lib-')) return { kind: 'library', slug: id.slice(4) };
  if (id.startsWith('ext-')) return { kind: 'external' };
  const rest = id.slice('short_'.length);
  const cut = rest.indexOf('_');
  return { kind: 'short', author: rest.slice(0, cut), permlink: rest.slice(cut + 1) };
}

/** The library key of a song: its title and artist, loosely. */
function libraryKey(title, artist) {
  return `${norm(title)}|${norm(artist)}`;
}

function externalSoundId(title, artist) {
  return `ext-${crypto.createHash('sha1').update(libraryKey(title, artist)).digest('hex').slice(0, 10)}`;
}

/**
 * The sound a post uses, from its `json_metadata.video.sound` (already cleaned,
 * utils/hive.js pickSound) and the library index `{ byId: Map, byKey: Map }`.
 * No sound: the post's own audio. Order: an explicit id, the sound page url,
 * a library song by name, then the name itself.
 */
function soundIdForSound(sound, library) {
  if (!sound || typeof sound.title !== 'string' || !sound.title) return null;
  const lib = library || { byId: new Map(), byKey: new Map() };
  const raw = typeof sound.id === 'string' ? sound.id.trim().toLowerCase() : '';
  if (isSoundId(raw)) return raw;
  if (raw && sound.source !== '3speak' && SLUG.test(raw) && lib.byId.has(raw)) return `lib-${raw}`;
  const page = PAGE_URL.exec(String(sound.url || ''));
  if (page) {
    const fromUrl = decodeURIComponent(page[1]).toLowerCase();
    if (isSoundId(fromUrl)) return fromUrl;
  }
  const hit = lib.byKey.get(libraryKey(sound.title, sound.artist));
  if (hit) return `lib-${hit}`;
  return externalSoundId(sound.title, sound.artist);
}

module.exports = {
  isSoundId, parseSoundId, shortSoundId, soundIdForSound, libraryKey, externalSoundId,
  ACCOUNT, PERMLINK, SLUG,
};
