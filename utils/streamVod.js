/**
 * Is this embed-video the recording of a live stream (its VOD)?
 *
 * Three ways to tell, from newest to oldest:
 * - the live server (hangouts, lib/streamVodPublish.ts) uploads the recording
 *   itself with `frontend_app: '3speak-hangouts'`, and nothing else uploads
 *   under that name;
 * - the old studio path stamped `is_openpod_stream` (PUT /video/openpod);
 * - recordings from before that flag have a `stream-<room>-<n>s.<ext>` filename.
 *
 * Cards carry it as `streamVod: true` and the frontend draws a VOD badge.
 * Presentation only.
 */
function isStreamVod(ev) {
    if (!ev || ev.short === true) return false;
    return ev.is_openpod_stream === true
        || ev.frontend_app === '3speak-hangouts'
        || /^stream-/.test(ev.originalFilename || '');
}

module.exports = { isStreamVod };
