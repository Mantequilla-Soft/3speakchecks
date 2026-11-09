const { spawn } = require('child_process');

// One still frame from a video's HLS manifest, and the upload of that frame to
// our image host. Kept apart from services/thumbnailFrame.js so tests can stand
// in for ffmpeg and the image host without either running.

// Per attempt. A gateway that serves the playlist but stalls on the segments
// (seen on ipfs.3speak.tv and Bunny, 2026-11-09) is given up on here, and the
// next gateway is tried: one that has the video answers in 1-4 s.
const FFMPEG_TIMEOUT_MS = 20 * 1000;
const UPLOAD_TIMEOUT_MS = 30 * 1000;
// A frame larger than this is not a thumbnail; also bounds memory per run.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * { frame, timedOut }: the JPEG bytes of a representative frame near `atSec`
 * (null when ffmpeg produced nothing: seek past the end, unreadable stream), and
 * whether it was cut off by the timeout, i.e. the gateway stalled.
 *
 * `thumbnail=25` picks the most typical of 25 frames, so a fade-in or a black
 * first frame is not what the card ends up showing. Scaled down to at most
 * 1280 wide, like the frames the upload page makes.
 */
function grabFrame(manifestUrl, atSec = 1) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error', '-nostdin',
            // HLS over https only: a manifest can never make ffmpeg read a local file.
            '-protocol_whitelist', 'https,tls,tcp,crypto,hls',
            '-ss', String(atSec),
            '-i', manifestUrl,
            '-vf', "thumbnail=25,scale='min(1280,iw)':-2",
            '-frames:v', '1',
            '-q:v', '3',
            '-f', 'image2pipe', '-vcodec', 'mjpeg',
            'pipe:1',
        ];
        let proc;
        try {
            proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            return resolve({ frame: null, timedOut: false });
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        const done = (buf, timedOut = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ frame: buf && buf.length ? buf : null, timedOut });
        };
        const timer = setTimeout(() => { proc.kill('SIGKILL'); done(null, true); }, FFMPEG_TIMEOUT_MS);
        proc.stdout.on('data', (c) => {
            size += c.length;
            if (size > MAX_FRAME_BYTES) { proc.kill('SIGKILL'); done(null); return; }
            chunks.push(c);
        });
        proc.on('error', () => done(null));   // ENOENT: ffmpeg not installed
        proc.on('close', (code) => done(code === 0 ? Buffer.concat(chunks) : null));
    });
}

/** True when an ffmpeg binary can be run on this machine. */
function ffmpegAvailable() {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
        } catch {
            return resolve(false);
        }
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
    });
}

/**
 * Uploads JPEG bytes to the 3Speak image host (the same /upload the upload page
 * falls back to) and returns the public URL. Throws on any failure.
 */
async function uploadImage(buf, { url, key }) {
    const form = new FormData();
    form.append('image', new Blob([buf], { type: 'image/jpeg' }), 'frame.jpg');
    const res = await fetch(`${url.replace(/\/+$/, '')}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || typeof data.url !== 'string' || !/^https:\/\//.test(data.url)) {
        throw new Error(`image upload failed (${res.status})`);
    }
    return data.url;
}

module.exports = { grabFrame, ffmpegAvailable, uploadImage };
