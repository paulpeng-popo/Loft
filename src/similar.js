// Similar image / video matching.
// Images: dHash (64 bits) of the thumbnail, compared by Hamming distance. Videos: identical duration + resolution + size, or close duration + similar thumbnail.
// Fingerprints are cached in the database by Telegram file id, so each file is computed only once.
const fs = require('node:fs');
const jpeg = require('jpeg-js');
const { Api } = require('telegram');
const { fingerprints: store } = require('./db');

const VISUAL = new Set(['photo', 'video', 'gif', 'video_note']);
// Strictness: max Hamming distance for images, and for videos when not an exact match (null = exact matches only)
const LEVELS = {
    strict: { photo: 4, video: null, aspect: 0.01 },
    normal: { photo: 8, video: 8, aspect: 0.03 },
    loose: { photo: 12, video: 12, aspect: 0.05 },
};

const memo = new Map(); // file_key -> fingerprint (null means it couldn't be computed)

function fileKeyOf(msg) {
    return msg.photo ? `p${msg.photo.id}` : msg.document ? `d${msg.document.id}` : null;
}

function kindOf(msg) {
    if (msg.photo) return 'photo';
    if (msg.gif) return 'gif';
    if (msg.videoNote) return 'video_note';
    if (msg.video) return 'video';
    if (msg.document && /^image\/(jpeg|png)/.test(msg.document.mimeType || '')) return 'photo';
    return null;
}

// Original size, duration, file size
function meta(msg, kind) {
    if (msg.photo) {
        const sizes = (msg.photo.sizes || []).filter((s) => s.w);
        const big = sizes[sizes.length - 1] || {};
        const size = big.size || (big.sizes ? Math.max(...big.sizes) : 0);
        return { w: big.w || 0, h: big.h || 0, duration: 0, size };
    }
    const doc = msg.document;
    const v = (doc.attributes || []).find((a) => a instanceof Api.DocumentAttributeVideo);
    const img = (doc.attributes || []).find((a) => a instanceof Api.DocumentAttributeImageSize);
    return {
        w: (v && v.w) || (img && img.w) || 0,
        h: (v && v.h) || (img && img.h) || 0,
        duration: v ? Math.round(v.duration || 0) : 0,
        size: Number(doc.size.toString()),
        kind,
    };
}

// dHash: shrink to 9x8 grayscale, compare neighbouring pixels in each row for brighter / darker, giving 64 bits
function dhash(buf) {
    let img;
    try {
        img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
    } catch {
        return null; // not a JPEG (e.g. a WebP sticker)
    }
    const { width: W, height: H, data } = img;
    if (!W || !H) return null;
    const GW = 9;
    const GH = 8;
    const grid = new Float64Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
        const y0 = Math.floor((gy * H) / GH);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / GH));
        for (let gx = 0; gx < GW; gx++) {
            const x0 = Math.floor((gx * W) / GW);
            const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / GW));
            let sum = 0;
            let n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * W + x) * 4;
                    sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                    n++;
                }
            }
            grid[gy * GW + gx] = sum / n;
        }
    }
    let bits = 0n;
    for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW - 1; x++) {
            bits = (bits << 1n) | (grid[y * GW + x] > grid[y * GW + x + 1] ? 1n : 0n);
        }
    }
    return bits.toString(16).padStart(16, '0');
}

// Split the 64 bits into two 32-bit integers: much faster than BigInt (with many downloaded files every message is compared against all of them)
const halves = new Map();
function split(hex) {
    let h = halves.get(hex);
    if (!h) {
        h = [parseInt(hex.slice(0, 8), 16) | 0, parseInt(hex.slice(8, 16), 16) | 0];
        if (halves.size > 200000) halves.clear();
        halves.set(hex, h);
    }
    return h;
}
function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return Math.imul(x, 0x01010101) >>> 24;
}
function hamming(a, b) {
    const [a1, a2] = split(a);
    const [b1, b2] = split(b);
    return popcount(a1 ^ b1) + popcount(a2 ^ b2);
}

// Fingerprints that are almost all bright or all dark carry too little information (solid colors, black frames) and cause false matches
function lowInfo(phash) {
    const ones = hamming(phash, '0000000000000000');
    return ones <= 6 || ones >= 58;
}

/**
 * Gets the fingerprint of a message's media: { key, kind, phash, aspect, w, h, duration, size }, or null if it isn't an image / video.
 * chatKey lets it share the browse page's thumbnail cache.
 */
async function fingerprint(msg, chatKey = require('./tg').peerKey(msg.peerId)) {
    const key = fileKeyOf(msg);
    const kind = kindOf(msg);
    if (!key || !kind || !VISUAL.has(kind)) return null;
    if (memo.has(key)) return memo.get(key);
    const saved = store.get(key);
    if (saved) {
        const fp = { key, kind: saved.kind, phash: saved.phash, aspect: saved.aspect, w: saved.w, h: saved.h, duration: saved.duration, size: saved.size };
        memo.set(key, fp);
        return fp;
    }
    const m = meta(msg, kind);
    let phash = null;
    try {
        // A small thumbnail is enough for a fingerprint and much faster to download (shares the media wall's cache too)
        const file = await require('./browse').thumbForMsg(msg, chatKey, 'small');
        if (file) phash = dhash(fs.readFileSync(file));
    } catch {
        // Without a thumbnail, use the size info only
    }
    const fp = { key, kind, phash, aspect: m.w && m.h ? m.w / m.h : 0, w: m.w, h: m.h, duration: m.duration, size: m.size };
    store.put(fp);
    memo.set(key, fp);
    return fp;
}

const cached = (key) => (key ? memo.get(key) || null : null);

// Already computed fingerprints (only returned if in memory or the database; never fetches thumbnails)
function cachedFp(key) {
    if (!key) return null;
    if (memo.has(key)) return memo.get(key);
    const s = store.get(key);
    if (!s) return null;
    const fp = { key, kind: s.kind, phash: s.phash, aspect: s.aspect, w: s.w, h: s.h, duration: s.duration, size: s.size };
    memo.set(key, fp);
    return fp;
}

// Precompute fingerprints for a batch of messages (thumbnail downloads are limited to 4 at a time)
async function ensure(msgs) {
    await Promise.all(msgs.filter((m) => kindOf(m) && fileKeyOf(m) && !memo.has(fileKeyOf(m))).map((m) => fingerprint(m).catch(() => null)));
}

/**
 * Whether two fingerprints are similar. Returns { similar, exact, distance }.
 */
function compare(a, b, level = 'normal') {
    const L = LEVELS[level] || LEVELS.normal;
    if (!a || !b || a.key === b.key) return { similar: !!(a && b), exact: true, distance: 0 };
    const isVideo = (k) => k === 'video' || k === 'gif' || k === 'video_note';
    if (isVideo(a.kind) !== isVideo(b.kind)) return { similar: false };
    // Videos: identical duration, resolution and size means the same video
    if (isVideo(a.kind) && a.size && a.size === b.size && a.duration === b.duration && a.w === b.w && a.h === b.h) {
        return { similar: true, exact: true, distance: 0 };
    }
    if (!a.phash || !b.phash || lowInfo(a.phash) || lowInfo(b.phash)) return { similar: false };
    if (a.aspect && b.aspect && Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect) > L.aspect) return { similar: false };
    const distance = hamming(a.phash, b.phash);
    if (isVideo(a.kind)) {
        if (L.video == null || Math.abs((a.duration || 0) - (b.duration || 0)) > 1) return { similar: false };
        return { similar: distance <= L.video, exact: false, distance };
    }
    return { similar: distance <= L.photo, exact: false, distance };
}

// ---- Fingerprint index of downloaded files (for duplicate checks) ----
let downloadedIndex = null;

function loadIndex() {
    if (!downloadedIndex) {
        downloadedIndex = store.downloaded();
    }
    return downloadedIndex;
}

// Add to the index once a download finishes
function addDownloaded(fp, row) {
    loadIndex().push({ ...row, file_key: fp.key, kind: fp.kind, phash: fp.phash, aspect: fp.aspect, w: fp.w, h: fp.h, duration: fp.duration, size: fp.size });
}

function removeDownloaded(downloadId) {
    if (!downloadedIndex) return;
    downloadedIndex = downloadedIndex.filter((r) => r.download_id !== downloadId);
}

// Find the most similar of the downloaded files
function findDownloaded(fp, level) {
    let best = null;
    for (const r of loadIndex()) {
        const c = compare(fp, { key: r.file_key, kind: r.kind, phash: r.phash, aspect: r.aspect, w: r.w, h: r.h, duration: r.duration, size: r.size }, level);
        if (c.similar && (!best || c.distance < best.distance)) best = { row: r, distance: c.distance, exact: c.exact };
    }
    return best;
}

module.exports = { fingerprint, ensure, cached, cachedFp, compare, findDownloaded, addDownloaded, removeDownloaded, kindOf, fileKeyOf, LEVELS };
