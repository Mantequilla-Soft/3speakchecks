const youtube = require('./youtube');
const soundcloud = require('./soundcloud');
const tiktok = require('./tiktok');
// Reads profiles through the local instagram-browser service (real Firefox), see its header.
const instagram = require('./instagram');
const bitchute = require('./bitchute');
// Reads the About page through RUMBLE_FETCH_PROXY (Cloudflare refuses this server).
const rumble = require('./rumble');
// Podcast RSS feeds: the code in the feed header or its newest episode (rss.js).
const rss = require('./rss');

const platforms = {
    [youtube.name]: youtube,
    [soundcloud.name]: soundcloud,
    [tiktok.name]: tiktok,
    [instagram.name]: instagram,
    [bitchute.name]: bitchute,
    [rumble.name]: rumble,
    [rss.name]: rss,
};

// Which platforms people may LINK (verify) right now: one switch each,
// VERIFY_<NAME>=true|false in .env. Default: only YouTube and SoundCloud (owner's
// call 2026-10-06). A switched-off platform still unlinks and its existing links
// stay readable; only new verifications are refused. RSS feeds on by default
// (owner 2026-11-14: verified feeds are what the podcast import works from).
const DEFAULT_ON = new Set(['youtube', 'soundcloud', 'rss']);
function isLinkEnabled(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!platforms[key]) return false;
    const v = process.env[`VERIFY_${key.toUpperCase()}`];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return DEFAULT_ON.has(key);
}

function getPlatform(name) {
    const key = String(name || '').trim().toLowerCase();
    return platforms[key] || null;
}

// The platforms that can be linked now (what the frontend offers).
function listPlatforms() {
    return Object.keys(platforms).filter(isLinkEnabled);
}

module.exports = { getPlatform, listPlatforms, isLinkEnabled };
