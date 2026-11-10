/**
 * routes/rss.js: the podcast feeds 3Speak publishes (one per channel, one per
 * public playlist), the playlist share card and the cover-art routes.
 *
 * Every feed is parsed back as XML and checked by structure, against real MongoDB.
 * Hive (profile names, post bodies) and the cover renderer are stand-ins.
 */
const crypto = require('crypto');
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { NOW, pinClock, parseXml, asList, binaryParser } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/podcastCover', () => ({ renderCover: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const { renderCover } = require('../../utils/podcastCover');

const app = buildApp(['/rss', require('../../routes/rss')]);
const db = testDb.use();

// ─── Builders ─────────────────────────────────────────────────────────────────

const day = (n) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

const legacyVideo = (owner, permlink, extra = {}) => ({
  owner, permlink, title: `Legacy ${permlink}`, description: `Notes for ${permlink}`,
  created: day(5), status: 'published', filename: `${permlink}.mp4`, size: '12345', duration: 61,
  thumbnail: `ipfs://QmThumb${permlink}`, ...extra,
});

const embedVideo = (owner, permlink, extra = {}) => ({
  owner, hive_author: owner, hive_permlink: permlink, hive_title: `Embed ${permlink}`, hive_body: `Body of ${permlink}`,
  permlink: `embed-${permlink}`, createdAt: day(3), status: 'published', short: false, listed_on_3speak: true,
  manifest_cid: `bafyhls${permlink}`, duration: 3725, thumbnail_url: `https://images.3speak.tv/${permlink}.png`, ...extra,
});

const audio = (owner, permlink, extra = {}) => ({
  owner, post_permlink: permlink, title: `Audio ${permlink}`, description: `Show notes ${permlink}`,
  createdAt: day(1), status: 'published', audio_cid: `bafyorig${permlink}`, format: 'webm', size: 2000,
  mp3_cid: `bafymp3${permlink}`, mp3_size: 1500, duration: 125.4, category: 'podcast', ...extra,
});

/** Hive's answers by RPC method; anything not given answers nothing. */
function hiveAnswers({ accounts = {}, posts = {} } = {}) {
  hiveRpcBatch.mockImplementation(async (batch) => batch.map((req) => {
    if (req.method === 'condenser_api.get_accounts') {
      const name = req.params[0][0];
      return { id: req.id, result: accounts[name] ? [accounts[name]] : [] };
    }
    if (req.method === 'condenser_api.get_content') {
      return { id: req.id, result: posts[req.params.join('/')] || null };
    }
    return { id: req.id, result: null };
  }));
}

/** GET a feed and parse it. Fails the test if the body is not well-formed XML. */
async function feed(path, status = 200) {
  const res = await request(app).get(path).buffer(true).parse(binaryParser).expect(status);
  const xml = res.body.toString('utf8');
  return { res, xml, doc: parseXml(xml) };
}
const itemsOf = (doc) => asList(doc.rss.channel.item);
const textOf = (node) => (node && typeof node === 'object' ? node['#text'] : node);

// Independent RFC 4122 UUIDv5, checked against the RFC's own vector below, so the
// feed's podcast:guid can be compared with something that is not the code under test.
function referenceUuidV5(name, namespace) {
  const bytes = crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(namespace.replace(/-/g, ''), 'hex'), Buffer.from(name)]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}
const PODCAST_NAMESPACE = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

beforeEach(() => {
  pinClock();
  hiveRpcBatch.mockReset();
  hiveAnswers();
  renderCover.mockReset();
  // Hive and cover failures are logged as warnings; the tests that cause one check it.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

// ─── Channel feed ─────────────────────────────────────────────────────────────

describe('GET /rss/:username.xml, the channel feed', () => {
  test.each([
    ['spaces', 'bad%20name'],
    ['angle brackets', '%3Cscript%3E'],
    ['a quote', 'o%27neil'],
  ])('refuses a username with %s (400)', async (_label, name) => {
    const res = await request(app).get(`/rss/${name}.xml`);
    expect(res.status).toBe(400);
  });

  test('a channel with nothing published gets a minimal valid feed, cached for 10 minutes', async () => {
    await db().collection('videos').insertOne(legacyVideo('alice', 'draft', { status: 'encoding' }));
    const { res, doc } = await feed('/rss/alice.xml');
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    expect(doc.rss.channel).toMatchObject({
      title: 'alice 3Speak Podcast',
      link: 'https://3speak.tv/user/alice',
      description: 'No published videos found.',
    });
    expect(doc.rss.channel.item).toBeUndefined();
  });

  test('a banned or hidden creator gets an empty "unavailable" feed even with content', async () => {
    await db().collection('videos').insertOne(legacyVideo('mallory', 'v1'));
    for (const flag of [{ banned: true }, { hidden: true }]) {
      await db().collection('contentcreators').deleteMany({});
      await db().collection('contentcreators').insertOne({ username: 'mallory', ...flag });
      const { doc } = await feed('/rss/mallory.xml');
      expect(doc.rss.channel.description).toBe('Channel unavailable.');
      expect(doc.rss.channel.item).toBeUndefined();
    }
  });

  test('merges legacy videos, embed videos and audio, newest first, one item per Hive post', async () => {
    await db().collection('videos').insertMany([
      legacyVideo('alice', 'old-one', { created: day(10) }),
      // The same post as the embed row below: the embed row wins.
      legacyVideo('alice', 'shared', { created: day(3), title: 'Legacy copy' }),
    ]);
    await db().collection('embed-video').insertOne(embedVideo('alice', 'shared'));
    await db().collection('embed-audio').insertOne(audio('alice', 'talk'));

    const { doc } = await feed('/rss/alice.xml');
    const items = itemsOf(doc);
    expect(items.map((i) => i.title)).toEqual(['Audio talk', 'Embed shared', 'Legacy old-one']);
    expect(items.map((i) => textOf(i.guid))).toEqual([
      'hive.blog/@alice/talk', 'hive.blog/@alice/shared', 'hive.blog/@alice/old-one',
    ]);
    expect(items.every((i) => i.guid['@_isPermaLink'] === 'false')).toBe(true);
    expect(items[0].link).toBe('https://3speak.tv/watch?v=alice/talk');
  });

  test('channel metadata: defaults, both value blocks paying the creator, no podcast:guid', async () => {
    await db().collection('videos').insertOne(legacyVideo('alice', 'v1'));
    const { doc } = await feed('/rss/alice.xml');
    const ch = doc.rss.channel;
    expect(doc.rss['@_version']).toBe('2.0');
    expect(doc.rss['@_xmlns:podcast']).toBe('https://podcastindex.org/namespace/1.0');
    expect(ch.title).toBe('alice 3Speak Podcast');
    expect(ch['itunes:author']).toBe('alice');
    expect(ch['itunes:owner']).toEqual({ 'itunes:name': 'alice', 'itunes:email': 'alice@3speak.v4v.app' });
    expect(ch.language).toBe('en');
    expect(ch['podcast:hiveAccname']).toBe('alice');
    expect(ch['podcast:medium']).toBe('video');
    expect(ch['podcast:guid']).toBeUndefined();
    expect(asList(ch['atom:link']).find((l) => l['@_rel'] === 'self')['@_href']).toBe('https://3speak.tv/rss/alice.xml');
    expect(asList(ch['podcast:podping']).map((p) => p['@_hiveAccount'])).toEqual(['podping.spk', 'podping.bol']);

    const [lightning, hbd] = asList(ch['podcast:value']);
    expect(lightning['@_type']).toBe('lightning');
    const ln = asList(lightning['podcast:valueRecipient']);
    expect(ln[0]).toMatchObject({ '@_customKey': '818818', '@_customValue': 'alice', '@_split': '99' });
    expect(hbd['@_type']).toBe('HBD');
    expect(asList(hbd['podcast:valueRecipient'])[0]).toMatchObject({ '@_address': 'alice', '@_split': '98' });

    // The cover goes through the image cache, tagged by a hash of its source.
    const src = 'https://images.hive.blog/u/alice/avatar/large';
    const v = crypto.createHash('sha1').update(src).digest('hex').slice(0, 8);
    expect(ch['itunes:image']['@_href']).toBe(`https://3speak.tv/img/c/user/alice.jpg?v=${v}`);
  });

  test('podcast settings override the title, description, image, language and categories', async () => {
    await db().collection('videos').insertOne(legacyVideo('alice', 'v1'));
    await db().collection('podcastsettings').insertOne({
      podcast_owner: 'alice', podcast_title: 'Alice Talks', podcast_description: 'All about things',
      podcast_image: 'https://files.peakd.com/alice.png', podcast_languages: ['de'], podcast_categories: ['Technology', 'News'],
    });
    const { doc } = await feed('/rss/alice.xml');
    const ch = doc.rss.channel;
    expect(ch.title).toBe('Alice Talks');
    expect(ch.description).toBe('All about things');
    expect(ch.language).toBe('de');
    expect(asList(ch['itunes:category']).map((c) => c['@_text'])).toEqual(['Technology', 'News']);
    expect(ch['itunes:image']['@_href']).toMatch(/^https:\/\/3speak\.tv\/img\/c\/user\/alice\.jpg\?v=[0-9a-f]{8}$/);
  });

  test('the display name comes from the Hive profile, the account name when Hive is down', async () => {
    await db().collection('videos').insertOne(legacyVideo('alice', 'v1'));
    hiveAnswers({ accounts: { alice: { name: 'alice', posting_json_metadata: JSON.stringify({ profile: { name: 'Alice A.' } }) } } });
    expect((await feed('/rss/alice.xml')).doc.rss.channel['itunes:author']).toBe('Alice A.');

    hiveRpcBatch.mockRejectedValue(new Error('all nodes down'));
    expect((await feed('/rss/alice.xml')).doc.rss.channel['itunes:author']).toBe('alice');
    expect(console.warn).toHaveBeenCalledWith('[RSS] Could not fetch Hive profile for alice:', 'all nodes down');
  });

  test('a legacy video: an MP4 enclosure on the right CDN for each kind of upload', async () => {
    await db().collection('videos').insertMany([
      legacyVideo('alice', 'plain', { created: day(1), thumbnail: 'thumb.png' }),
      legacyVideo('alice', 'onipfs', { created: day(2), filename: 'ipfs://QmFile', upload_type: 'ipfs' }),
      legacyVideo('alice', 'moved', { created: day(3), podcast_transfered: true }),
    ]);
    const items = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(items.map((i) => i.enclosure['@_url'])).toEqual([
      'https://threespeakvideo.b-cdn.net/plain.mp4',
      'https://4everland.io/ipfs/QmFile',
      'https://s3.us-west-1.wasabisys.com/podcast-data/moved/main.mp4',
    ]);
    expect(items[0].enclosure).toMatchObject({ '@_type': 'video/mp4', '@_length': '12345' });
    expect(items[0]['itunes:duration']).toBe('1:01');
    expect(items[0].image['@_url']).toBe('https://images.3speak.tv/plain/thumbnails/default.png');
    expect(items[1].image['@_url']).toBe('https://4everland.io/ipfs/QmThumbonipfs/');
  });

  test('an embed video is HLS only: no enclosure, the stream as the default alternate', async () => {
    await db().collection('embed-video').insertOne(embedVideo('alice', 'hls'));
    const [item] = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(item.enclosure).toBeUndefined();
    expect(item['podcast:alternateEnclosure']).toMatchObject({
      '@_type': 'application/x-mpegURL', '@_default': 'true',
      'podcast:source': { '@_uri': 'https://ipfs.3speak.tv/ipfs/bafyhlshls' },
    });
    expect(item['itunes:duration']).toBe('1:02:05');
    expect(item.description).toBe('Body of hls');
  });

  test.each([
    ['a short', { short: true }],
    ['an unlisted upload', { listed_on_3speak: false }],
    ['an unpublished upload', { status: 'encoding' }],
    ['a row without a Hive post', { hive_permlink: null }],
  ])('%s from the embed pipeline is not an episode', async (_label, extra) => {
    await db().collection('embed-video').insertOne(embedVideo('alice', 'x', extra));
    expect(itemsOf((await feed('/rss/alice.xml')).doc)).toHaveLength(0);
  });

  test('an audio upload: the MP3 companion is the enclosure, the original rides along', async () => {
    await db().collection('embed-audio').insertMany([
      audio('alice', 'with-mp3'),
      audio('alice', 'flac-only', { createdAt: day(2), mp3_cid: null, format: 'FLAC', category: 'song' }),
      // A few rows store "author/permlink".
      audio('alice', 'alice/prefixed', { createdAt: day(3), mp3_cid: null, format: 'weird' }),
    ]);
    const items = itemsOf((await feed('/rss/alice.xml')).doc);

    expect(items[0].enclosure).toEqual({ '@_url': 'https://hotipfs-3speak-1.b-cdn.net/ipfs/bafymp3with-mp3', '@_length': '1500', '@_type': 'audio/mpeg' });
    expect(items[0]['podcast:alternateEnclosure']).toMatchObject({
      '@_type': 'audio/webm', 'podcast:source': { '@_uri': 'https://hotipfs-3speak-1.b-cdn.net/ipfs/bafyorigwith-mp3' },
    });
    expect(items[0]['podcast:medium']).toBe('podcast');
    expect(items[0]['itunes:duration']).toBe('2:05');

    expect(items[1].enclosure['@_type']).toBe('audio/flac');
    expect(items[1]['podcast:medium']).toBe('music');
    expect(items[1]['podcast:alternateEnclosure']).toBeUndefined();

    expect(items[2].link).toBe('https://3speak.tv/watch?v=alice/prefixed');
    expect(items[2].enclosure['@_type']).toBe('audio/mpeg');
  });

  test('NSFW episodes are marked explicit, the rest clean', async () => {
    await db().collection('videos').insertMany([
      legacyVideo('alice', 'spicy', { isNsfwContent: true, created: day(1) }),
      legacyVideo('alice', 'mild', { created: day(2) }),
    ]);
    const items = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(items.map((i) => i['itunes:explicit'])).toEqual(['yes', 'clean']);
  });

  test('hostile titles and notes come back verbatim, the document stays well formed', async () => {
    const hostile = 'Tom & Jerry <script>alert(1)</script> ]]> "quoted" end';
    await db().collection('videos').insertOne(legacyVideo('alice', 'evil', { title: hostile, description: `<b>bold</b> ]]> & more` }));
    const { xml, doc } = await feed('/rss/alice.xml');
    const [item] = itemsOf(doc);
    expect(item.title).toBe(hostile);
    expect(item.description).toBe('<b>bold</b> ]]> & more');
    expect(xml).not.toContain('<script>alert(1)</script> ]]> "quoted"');
  });

  test('a feed carries at most 30 episodes', async () => {
    await db().collection('videos').insertMany(
      Array.from({ length: 35 }, (_, n) => legacyVideo('alice', `ep-${n}`, { created: day(n + 1) })),
    );
    const items = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(items).toHaveLength(30);
    expect(items[0].title).toBe('Legacy ep-0');
  });

  test('audio without notes takes the title and plain show notes from its Hive post', async () => {
    await db().collection('embed-audio').insertOne(audio('alice', 'notes-from-hive', { description: '', title: 'Row title' }));
    hiveAnswers({ posts: { 'alice/notes-from-hive': {
      author: 'alice', title: 'Post title',
      body: '![cover](https://img/x.png)\nhttps://audio.3speak.tv/play?a=alice&p=x\nFirst line <img src="y">\n[my site](https://example.com)<br>Second ]]> line',
    } } });
    const [item] = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(item.title).toBe('Post title');
    expect(item.description).toBe('First line<br>my site https://example.com<br>Second ]] > line');
  });

  test('audio without notes keeps its own title when Hive cannot be read', async () => {
    await db().collection('embed-audio').insertOne(audio('alice', 'hive-down', { description: '' }));
    hiveRpcBatch.mockRejectedValue(new Error('timeout'));
    const [item] = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(item.title).toBe('Audio hive-down');
    // No notes at all: the watch link stands in.
    expect(item.description).toBe('https://3speak.tv/watch?v=alice/hive-down');
  });

  // routes/rss.js:955 reads embed-audio by owner and post_permlink only, with no
  // status filter (the playlist feed and GET /audio both require "published").
  // A deleted or failed upload therefore stays in the creator's public podcast feed.
  test('a deleted or failed audio upload is not an episode of the channel feed', async () => {
    await db().collection('embed-audio').insertMany([
      audio('alice', 'kept'),
      audio('alice', 'deleted-one', { status: 'deleted' }),
      audio('alice', 'failed-one', { status: 'failed' }),
    ]);
    const items = itemsOf((await feed('/rss/alice.xml')).doc);
    expect(items.map((i) => i.title)).toEqual(['Audio kept']);
  });
});

// ─── Playlist feed ────────────────────────────────────────────────────────────

const PLAYLIST_ID = 'pl-0001-abcdef';
const playlist = (extra = {}) => ({
  _id: PLAYLIST_ID, owner: 'alice', name: '30 Day Challenge', access: 'public',
  items: [
    { author: 'alice', permlink: 'day-1', position: 0, added_at: Math.floor(day(9).getTime() / 1000) },
    { author: 'bob', permlink: 'guest', position: 1, added_at: day(2) },
    { author: 'alice', permlink: 'day-2', position: 2, added_at: Math.floor(day(5).getTime() / 1000) },
  ],
  ...extra,
});

async function seedPlaylistEpisodes() {
  await db().collection('videos').insertOne(legacyVideo('alice', 'day-1', { created: day(9) }));
  await db().collection('embed-audio').insertMany([
    audio('bob', 'guest', { createdAt: day(2) }),
    audio('alice', 'day-2', { createdAt: day(5) }),
  ]);
}

describe('GET /rss/playlist/:id.xml, one feed per public playlist', () => {
  test('refuses a malformed id (400)', async () => {
    await request(app).get('/rss/playlist/short.xml').expect(400);
    await request(app).get('/rss/playlist/has%20space%20inside.xml').expect(400);
  });

  test.each([
    ['missing', null],
    ['private', { access: 'private' }],
    ['without an owner', { owner: null }],
  ])('a %s playlist is a 404 with a valid empty feed', async (_label, extra) => {
    if (extra) await db().collection('playlists').insertOne(playlist(extra));
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`, 404);
    expect(doc.rss.channel).toMatchObject({ title: 'Playlist not found', description: 'This playlist does not exist or is private.' });
  });

  test('a banned owner takes the whole playlist with them', async () => {
    await db().collection('playlists').insertOne(playlist());
    await seedPlaylistEpisodes();
    await db().collection('contentcreators').insertOne({ username: 'alice', banned: true });
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    expect(doc.rss.channel).toMatchObject({ title: '30 Day Challenge', description: 'Playlist unavailable.' });
    expect(doc.rss.channel.item).toBeUndefined();
  });

  test('every episode of the series, guests with their own author and value block', async () => {
    await db().collection('playlists').insertOne(playlist());
    await seedPlaylistEpisodes();
    const { res, doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    const ch = doc.rss.channel;
    expect(ch.title).toBe('30 Day Challenge');
    expect(ch.link).toBe(`https://3speak.tv/playlist/${PLAYLIST_ID}`);
    expect(ch.description).toBe('30 Day Challenge by alice. Hosted by 3Speak.tv, the free speech video platform.');
    expect(ch['podcast:medium']).toBe('video'); // a video among the audio

    const items = itemsOf(doc);
    expect(items.map((i) => i.title)).toEqual(['Audio guest', 'Audio day-2', 'Legacy day-1']);
    const guest = items[0];
    expect(guest['itunes:author']).toBe('bob');
    expect(asList(guest['podcast:value']).map((v) => v['@_type'])).toEqual(['lightning', 'HBD']);
    expect(asList(asList(guest['podcast:value'])[1]['podcast:valueRecipient'])[0]['@_address']).toBe('bob');
    // The owner's own episodes are paid by the channel-level block.
    expect(items[1]['podcast:value']).toBeUndefined();
    expect(items[1]['itunes:author']).toBe('alice');
  });

  test('podcast:guid is the UUIDv5 of the feed address, stable and per playlist', async () => {
    // The reference implementation first reproduces RFC 4122's own example.
    expect(referenceUuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    await db().collection('playlists').insertMany([playlist(), playlist({ _id: 'pl-0002-abcdef' })]);
    const one = (await feed(`/rss/playlist/${PLAYLIST_ID}.xml`)).doc.rss.channel['podcast:guid'];
    expect(one).toBe(referenceUuidV5(`3speak.tv/rss/playlist/${PLAYLIST_ID}.xml`, PODCAST_NAMESPACE));
    expect((await feed(`/rss/playlist/${PLAYLIST_ID}.xml`)).doc.rss.channel['podcast:guid']).toBe(one);
    expect((await feed('/rss/playlist/pl-0002-abcdef.xml')).doc.rss.channel['podcast:guid']).not.toBe(one);
  });

  test('a banned guest loses their own episodes only', async () => {
    await db().collection('playlists').insertOne(playlist());
    await seedPlaylistEpisodes();
    await db().collection('contentcreators').insertOne({ username: 'bob', hidden: true });
    const items = itemsOf((await feed(`/rss/playlist/${PLAYLIST_ID}.xml`)).doc);
    expect(items.map((i) => i.title)).toEqual(['Audio day-2', 'Legacy day-1']);
  });

  test('only published rows count, and an album of songs is a music feed', async () => {
    await db().collection('playlists').insertOne(playlist({
      items: [{ author: 'alice', permlink: 's1' }, { author: 'alice', permlink: 's2' }, { author: 'alice', permlink: 's3' }],
      metadata: Buffer.from(JSON.stringify({ album: { description: 'Our first album', thumbnail: 'https://files.peakd.com/album.jpg' } })).toString('base64'),
    }));
    await db().collection('embed-audio').insertMany([
      audio('alice', 's1', { category: 'song' }),
      audio('alice', 's2', { category: 'song', createdAt: day(2) }),
      audio('alice', 's3', { category: 'song', status: 'deleted' }),
    ]);
    await db().collection('podcastsettings').insertOne({ podcast_owner: 'alice', podcast_language: 'pt', podcast_categories: ['Music'] });
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    const ch = doc.rss.channel;
    expect(itemsOf(doc).map((i) => i.title)).toEqual(['Audio s1', 'Audio s2']);
    expect(ch['podcast:medium']).toBe('music');
    expect(ch.description).toBe('Our first album');
    expect(ch.language).toBe('pt');
    expect(ch['itunes:category']['@_text']).toBe('Music');
    const v = crypto.createHash('sha1').update('https://files.peakd.com/album.jpg').digest('hex').slice(0, 8);
    expect(ch['itunes:image']['@_href']).toBe(`https://3speak.tv/img/c/playlist/${PLAYLIST_ID}.jpg?v=${v}`);
  });

  test('a playlist of podcast audio is a podcast feed; an empty one still a valid feed', async () => {
    await db().collection('playlists').insertOne(playlist({ items: [{ author: 'alice', permlink: 'p1' }] }));
    await db().collection('embed-audio').insertOne(audio('alice', 'p1'));
    expect((await feed(`/rss/playlist/${PLAYLIST_ID}.xml`)).doc.rss.channel['podcast:medium']).toBe('podcast');

    await db().collection('playlists').updateOne({ _id: PLAYLIST_ID }, { $set: { items: [] } });
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    expect(doc.rss.channel['podcast:medium']).toBe('video');
    expect(doc.rss.channel.item).toBeUndefined();
  });
});

describe('GET /rss/playlist/:id.xml with outside shows in the playlist', () => {
  const { ObjectId } = require('mongodb');
  const SHOW = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
  const NODE = `02${'a'.repeat(64)}`;
  // The site sends json_metadata as a JSON string; the indexer stores it encoded once more.
  const withFeeds = (feeds, extra = {}) => playlist({ json_metadata: JSON.stringify(JSON.stringify({ tags: ['x'], feeds })), ...extra });
  const show = (extra = {}) => ({
    _id: SHOW, url: 'https://feeds.example.com/show.xml', url_key: 'feeds.example.com/show.xml', alt_keys: ['old.example.com/show'],
    title: 'Outside Show', author: 'Outside Host', image: 'https://cdn.example.com/show.jpg', status: 'ok', subscribers: 0,
    value: { method: 'keysend', suggested: 0.00000005, recipients: [{ name: 'Host', type: 'node', address: NODE, split: 100 }] },
    ...extra,
  });
  const outsideEp = (n, extra = {}) => ({
    _id: `${SHOW.toHexString()}:${String(n).padStart(16, 'x')}`, feed_id: SHOW, title: `Outside ${n}`,
    guid: `urn:outside:${n}`, audio_url: `https://cdn.example.com/${n}.mp3`, mime: 'audio/mpeg', bytes: 4242,
    duration: 1800, summary: `Summary ${n}`, published_at: day(n), ...extra,
  });

  test('outside episodes merge by date, keep their guid and file, and pay their own show', async () => {
    await db().collection('playlists').insertOne(withFeeds([{ url: 'https://old.example.com/show/', title: 'Outside Show' }]));
    await seedPlaylistEpisodes();
    await db().collection('podcast_feeds').insertOne(show());
    await db().collection('podcast_episodes').insertMany([outsideEp(0), outsideEp(4), outsideEp(20, { published_at: null })]);

    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    const ch = doc.rss.channel;
    // Nothing at channel level: an outside item must never inherit the owner's block.
    expect(ch['podcast:value']).toBeUndefined();
    const items = itemsOf(doc);
    expect(items.map((i) => i.title)).toEqual(['Outside 0', 'Audio guest', 'Outside 4', 'Audio day-2', 'Legacy day-1']);

    const out = items[0];
    expect(textOf(out.guid)).toBe('urn:outside:0');
    expect(out.enclosure).toMatchObject({ '@_url': 'https://cdn.example.com/0.mp3', '@_type': 'audio/mpeg', '@_length': '4242' });
    expect(out['itunes:author']).toBe('Outside Host');
    expect(out['itunes:image']['@_href']).toBe('https://cdn.example.com/show.jpg');
    const value = asList(out['podcast:value']);
    expect(value).toHaveLength(1);
    expect(value[0]['@_type']).toBe('lightning');
    expect(asList(value[0]['podcast:valueRecipient'])[0]).toMatchObject({ '@_address': NODE, '@_split': '100' });

    // The owner's own episodes now carry the owner's block themselves.
    const own = items[3];
    expect(asList(own['podcast:value']).map((v) => v['@_type'])).toEqual(['lightning', 'HBD']);
    expect(asList(asList(own['podcast:value'])[1]['podcast:valueRecipient'])[0]['@_address']).toBe('alice');
  });

  test('a show without a value block pays nobody; a 3Speak post already in the playlist is listed once', async () => {
    await db().collection('playlists').insertOne(withFeeds([{ url: 'https://feeds.example.com/show.xml' }]));
    await seedPlaylistEpisodes();
    await db().collection('podcast_feeds').insertOne(show({ value: undefined }));
    await db().collection('podcast_episodes').insertMany([
      outsideEp(0, { guid: undefined }),
      outsideEp(1, { link: 'https://3speak.tv/watch?v=bob/guest' }),
    ]);
    const items = itemsOf((await feed(`/rss/playlist/${PLAYLIST_ID}.xml`)).doc);
    expect(items.map((i) => i.title)).toEqual(['Outside 0', 'Audio guest', 'Audio day-2', 'Legacy day-1']);
    expect(items[0]['podcast:value']).toBeUndefined();
    // Stored before guids were kept: the file is the guid.
    expect(textOf(items[0].guid)).toBe('https://cdn.example.com/0.mp3');
  });

  test('private feed rows, the playlist\'s own feed and unknown URLs add nothing', async () => {
    await db().collection('playlists').insertOne(withFeeds([
      { url: 'https://feeds.example.com/show.xml' },
      { url: `https://3speak.tv/rss/playlist/${PLAYLIST_ID}.xml` },
      { url: 'https://nobody.example.com/feed' },
    ]));
    await seedPlaylistEpisodes();
    await db().collection('podcast_feeds').insertOne(show({ private: true }));
    await db().collection('podcast_episodes').insertOne(outsideEp(0));
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    expect(itemsOf(doc).map((i) => i.title)).toEqual(['Audio guest', 'Audio day-2', 'Legacy day-1']);
    expect(asList(doc.rss.channel['podcast:value']).map((v) => v['@_type'])).toEqual(['lightning', 'HBD']);
  });

  test('a playlist of outside shows only is a podcast feed', async () => {
    await db().collection('playlists').insertOne(withFeeds([{ url: 'https://feeds.example.com/show.xml' }], { items: [] }));
    await db().collection('podcast_feeds').insertOne(show());
    await db().collection('podcast_episodes').insertMany([outsideEp(1), outsideEp(2)]);
    const { doc } = await feed(`/rss/playlist/${PLAYLIST_ID}.xml`);
    expect(doc.rss.channel['podcast:medium']).toBe('podcast');
    expect(itemsOf(doc).map((i) => i.title)).toEqual(['Outside 1', 'Outside 2']);
  });
});

// ─── Playlist share card ──────────────────────────────────────────────────────

describe('GET /rss/playlist/:id/card.json, the link preview', () => {
  test('400 for a malformed id, 404 for a private or blocked playlist', async () => {
    await request(app).get('/rss/playlist/x/card.json').expect(400);
    await db().collection('playlists').insertOne(playlist({ access: 'unlisted' }));
    await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(404);
    await db().collection('playlists').updateOne({ _id: PLAYLIST_ID }, { $set: { access: 'public' } });
    await db().collection('contentcreators').insertOne({ username: 'alice', banned: true });
    await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(404);
  });

  test('items in the playlist order; the cover is the most recently ADDED item with art', async () => {
    await db().collection('playlists').insertOne(playlist({ updated_at: day(1) }));
    await seedPlaylistEpisodes();
    const res = await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toMatchObject({
      id: PLAYLIST_ID, name: '30 Day Challenge', owner: 'alice', medium: 'video', itemCount: 3,
      description: null, album: null, coverFrom: 'latest-item',
      // bob's guest episode was added last (2 days ago).
      cover: 'https://images.hive.blog/u/bob/avatar/large',
    });
    expect(res.body.items.map((i) => [i.position, i.author, i.permlink, i.kind])).toEqual([
      [0, 'alice', 'day-1', 'video'], [1, 'bob', 'guest', 'audio'], [2, 'alice', 'day-2', 'audio'],
    ]);
    // added_at is unix seconds from the indexer and a Date from older writers: both read.
    expect(res.body.items[0].addedAt).toBe(new Date(Math.floor(day(9).getTime() / 1000) * 1000).toISOString());
    expect(res.body.items[1].addedAt).toBe(day(2).toISOString());
  });

  test("the playlist's own cover wins; album details come from its metadata; NSFW art is never shown", async () => {
    await db().collection('playlists').insertOne(playlist({
      items: [{ author: 'alice', permlink: 'n1', position: 0 }],
      metadata: { album: { thumbnail: 'https://files.peakd.com/own.jpg', musicStyle: 'Jazz', year: 2026, description: 'Smooth' } },
    }));
    await db().collection('embed-audio').insertOne(audio('alice', 'n1', { isNsfwContent: true, thumbnail_url: 'https://x/nsfw.jpg' }));
    const res = await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(200);
    expect(res.body).toMatchObject({
      cover: 'https://files.peakd.com/own.jpg', coverFrom: 'playlist', description: 'Smooth',
      album: { musicStyle: 'Jazz', year: 2026, label: null, credits: null },
    });
    expect(res.body.items[0].thumb).toBeNull();
  });

  test('no art anywhere: no cover', async () => {
    await db().collection('playlists').insertOne(playlist({ name: '', items: [{ author: 'alice', permlink: 'only-nsfw' }] }));
    await db().collection('embed-audio').insertOne(audio('alice', 'only-nsfw', { isNsfwContent: true }));
    const res = await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(200);
    expect(res.body).toMatchObject({ name: 'alice playlist', cover: null, coverFrom: null });
  });
});

// ─── Covers ───────────────────────────────────────────────────────────────────

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('cover art routes', () => {
  test('a channel cover is rendered from the podcast image and cached for a day', async () => {
    renderCover.mockResolvedValue(JPEG);
    await db().collection('podcastsettings').insertOne({ podcast_owner: 'alice', podcast_image: 'https://files.peakd.com/a.png' });
    const res = await request(app).get('/rss/cover/user/alice.jpg').buffer(true).parse(binaryParser).expect(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.body.equals(JPEG)).toBe(true);
    expect(renderCover).toHaveBeenCalledWith('https://files.peakd.com/a.png', { fit: 'crop' });
  });

  test('a cover that cannot be rendered redirects to its source, briefly cached', async () => {
    renderCover.mockRejectedValue(new Error('source not allowed'));
    const res = await request(app).get('/rss/cover/user/alice.jpg').expect(302);
    expect(res.headers.location).toBe('https://images.hive.blog/u/alice/avatar/large');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Cover for @alice not rendered (source not allowed)'));
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  test.each([
    ['/rss/cover/user/Alice.jpg'],
    ['/rss/cover/user/ab.jpg'],
    ['/rss/cover/episode/alice/Bad_Permlink.jpg'],
    ['/rss/cover/episode/a/x.jpg'],
    ['/rss/cover/playlist/short.jpg'],
  ])('%s is refused (400) without rendering anything', async (path) => {
    await request(app).get(path).expect(400);
    expect(renderCover).not.toHaveBeenCalled();
  });

  test('episode art is resolved from the stored post (embed first) and fitted, never cropped', async () => {
    renderCover.mockResolvedValue(JPEG);
    await db().collection('embed-video').insertOne(embedVideo('alice', 'ep-art'));
    await db().collection('videos').insertOne(legacyVideo('alice', 'ep-art', { thumbnail: 'legacy.png' }));
    await request(app).get('/rss/cover/episode/alice/ep-art.jpg').expect(200);
    expect(renderCover).toHaveBeenCalledWith('https://images.3speak.tv/ep-art.png', { fit: 'fit' });
  });

  test('episode art for an audio post stored as "author/permlink", 404 for an unknown one', async () => {
    renderCover.mockResolvedValue(JPEG);
    await db().collection('embed-audio').insertOne(audio('alice', 'alice/talk', { thumbnail_url: 'https://files.peakd.com/t.jpg' }));
    await request(app).get('/rss/cover/episode/alice/talk.jpg').expect(200);
    expect(renderCover).toHaveBeenLastCalledWith('https://files.peakd.com/t.jpg', { fit: 'fit' });
    await request(app).get('/rss/cover/episode/alice/nothing-here.jpg').expect(404);
  });

  test('a playlist cover only for a public playlist, from its album art', async () => {
    renderCover.mockResolvedValue(JPEG);
    await db().collection('playlists').insertOne(playlist({
      access: 'private', metadata: Buffer.from(JSON.stringify({ album: { thumbnail: 'https://files.peakd.com/alb.jpg' } })),
    }));
    await request(app).get(`/rss/cover/playlist/${PLAYLIST_ID}.jpg`).expect(404);
    await db().collection('playlists').updateOne({ _id: PLAYLIST_ID }, { $set: { access: 'public' } });
    await request(app).get(`/rss/cover/playlist/${PLAYLIST_ID}.jpg`).expect(200);
    expect(renderCover).toHaveBeenCalledWith('https://files.peakd.com/alb.jpg', { fit: 'crop' });
  });
});

// ─── A database failure ───────────────────────────────────────────────────────

describe('a database failure', () => {
  const { Collection } = require('mongodb');
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('db down'); });
    jest.spyOn(Collection.prototype, 'findOne').mockRejectedValue(new Error('db down'));
  });

  test.each([
    ['/rss/alice.xml'],
    [`/rss/playlist/${PLAYLIST_ID}.xml`],
  ])('%s answers a well-formed XML error (500)', async (path) => {
    const { doc } = await feed(path, 500);
    expect(doc.error).toBe('Internal server error');
  });

  test('the share card answers a JSON 500', async () => {
    expect((await request(app).get(`/rss/playlist/${PLAYLIST_ID}/card.json`).expect(500)).body).toEqual({ error: 'Internal server error' });
  });

  test.each([
    ['/rss/cover/episode/alice/talk.jpg'],
    [`/rss/cover/playlist/${PLAYLIST_ID}.jpg`],
  ])('%s answers 500 without rendering', async (path) => {
    await request(app).get(path).expect(500);
    expect(renderCover).not.toHaveBeenCalled();
  });

  test('a channel cover still renders from the default avatar when the settings cannot be read', async () => {
    renderCover.mockResolvedValue(JPEG);
    await request(app).get('/rss/cover/user/alice.jpg').expect(200);
    expect(renderCover).toHaveBeenCalledWith('https://images.hive.blog/u/alice/avatar/large', { fit: 'crop' });
  });
});
