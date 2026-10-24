// Parallel download of large files: fetch several parts of the same file at once and write each to its offset.
// gramjs's built-in downloadMedia fetches one part after another, so speed is limited by round-trip latency.
const fs = require('node:fs');
const bigInt = require('big-integer');
const { Api, errors } = require('telegram');
const { getSetting } = require('./db');
const tg = require('./tg');

const PART = 512 * 1024; // Telegram allows at most 512KB per request
const FAST_MIN = 4 * 1024 * 1024; // Below 4MB use the normal download

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settingInt(key, fallback, min, max) {
    const n = parseInt(getSetting(key, ''), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
const partWorkers = () => settingInt('dl_part_workers', 4, 1, 8);
// Download speed limit (MB/s, 0 = unlimited); only applies to downloads, not to thumbnails or streaming while browsing
const speedLimit = () => Math.max(0, parseFloat(getSetting('dl_speed_limit', '0')) || 0);
const fileWorkers = () => settingInt('dl_file_workers', 2, 1, 5);

function documentLocation(msg) {
    const m = msg.media;
    if (!(m instanceof Api.MessageMediaDocument) || !(m.document instanceof Api.Document)) return null;
    const d = m.document;
    return {
        location: new Api.InputDocumentFileLocation({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: '' }),
        dcId: d.dcId,
        size: Number(d.size.toString()),
    };
}

// Photos: take the largest size
function photoLocation(msg) {
    const m = msg.media;
    if (!(m instanceof Api.MessageMediaPhoto) || !(m.photo instanceof Api.Photo)) return null;
    const p = m.photo;
    let best = null;
    for (const sz of p.sizes || []) {
        const size = sz instanceof Api.PhotoSize ? sz.size : sz instanceof Api.PhotoSizeProgressive ? Math.max(...sz.sizes) : 0;
        if (size && (!best || size > best.size)) best = { type: sz.type, size };
    }
    if (!best) return null;
    return {
        location: new Api.InputPhotoFileLocation({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference, thumbSize: best.type }),
        dcId: p.dcId,
        size: best.size,
    };
}

const fileLocation = (msg) => documentLocation(msg) || photoLocation(msg);

// One throttle shared by all downloads: each part reserves a time slot first and waits if over the limit
let nextSlot = 0;
async function throttle(bytes) {
    const limit = speedLimit();
    if (!limit) return;
    const rate = limit * 1024 * 1024;
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + (bytes / rate) * 1000;
    if (start > now) await sleep(start - now);
}

async function refetch(c, msg) {
    const peer = msg.inputChat || await c.getInputEntity(msg.peerId);
    const [fresh] = await c.getMessages(peer, { ids: [msg.id] });
    if (!fresh) throw new Error('訊息已不存在');
    return fresh;
}

// Returns getPart(i): fetches part i (512KB), handling DC migration, rate limits, expired file references and transient-error retries
function partFetcher(c, msg, info, isFailed = () => false) {
    let { location } = info;
    let senderP = c.getSender(info.dcId);
    return async function getPart(i) {
        for (let attempt = 0; ; attempt++) {
            try {
                const sender = await senderP;
                const r = await c.invokeWithSender(new Api.upload.GetFile({ location, offset: bigInt(i * PART), limit: PART }), sender);
                return r.bytes;
            } catch (e) {
                if (isFailed()) throw e;
                if (e instanceof errors.FileMigrateError) {
                    senderP = c.getSender(e.newDc);
                } else if (e instanceof errors.FloodWaitError) {
                    await sleep((e.seconds + 1) * 1000);
                } else if (/FILE_REFERENCE_(EXPIRED|INVALID)/.test(e.errorMessage || '') && attempt < 3) {
                    location = fileLocation(await refetch(c, msg)).location;
                } else if (attempt < 4) {
                    await sleep(800 * (attempt + 1));
                } else {
                    throw e;
                }
            }
        }
    };
}

// ---- Streaming: only fetch the range the player asks for, play while downloading ----
const partCache = new Map(); // "fileKey:i" -> Buffer, the 128 most recently used parts (~64MB)
const PART_CACHE_MAX = 128;
const fetchers = new Map(); // fileKey -> getPart
const inflightParts = new Map();

function cachedPart(fileKey, i, getPart) {
    const k = `${fileKey}:${i}`;
    if (partCache.has(k)) {
        const b = partCache.get(k);
        partCache.delete(k);
        partCache.set(k, b);
        return Promise.resolve(b);
    }
    if (!inflightParts.has(k)) {
        inflightParts.set(k, getPart(i).then((b) => {
            partCache.set(k, b);
            if (partCache.size > PART_CACHE_MAX) partCache.delete(partCache.keys().next().value);
            return b;
        }).finally(() => inflightParts.delete(k)));
    }
    return inflightParts.get(k);
}

/**
 * Reads bytes [start, end] (inclusive) of a file, prefetching the next few parts so playback is smoother.
 */
async function readRange(msg, start, end) {
    const c = await tg.getClient();
    const info = documentLocation(msg);
    if (!info) throw new Error('這則訊息沒有可串流的檔案');
    const fileKey = `d${msg.document.id}`;
    if (!fetchers.has(fileKey)) {
        fetchers.set(fileKey, partFetcher(c, msg, info));
        if (fetchers.size > 50) fetchers.delete(fetchers.keys().next().value);
    }
    const getPart = fetchers.get(fileKey);
    const first = Math.floor(start / PART);
    const last = Math.floor(end / PART);
    const total = Math.ceil(info.size / PART);
    const bufs = await Promise.all(Array.from({ length: last - first + 1 }, (_, n) => cachedPart(fileKey, first + n, getPart)));
    for (let i = last + 1; i <= Math.min(total - 1, last + partWorkers()); i++) cachedPart(fileKey, i, getPart).catch(() => {});
    const all = Buffer.concat(bufs);
    return all.subarray(start - first * PART, end - first * PART + 1);
}

/**
 * Downloads a message's media to outFile. onProgress(bytesDownloaded).
 */
// noLimit: originals for the viewer ignore the download speed limit
async function download(msg, outFile, { onProgress, noLimit = false } = {}) {
    const c = await tg.getClient();
    // With a speed limit, small files and photos also use the parallel path (the only way to control speed)
    const limited = !noLimit && speedLimit() > 0;
    const info = limited ? fileLocation(msg) : documentLocation(msg);
    if (!info || (info.size < FAST_MIN && !limited)) {
        return c.downloadMedia(msg, {
            outputFile: outFile,
            progressCallback: (r) => onProgress && onProgress(Number(r.toString())),
        });
    }

    const parts = Math.max(1, Math.ceil(info.size / PART));
    const fh = await fs.promises.open(outFile, 'w');
    let next = 0;
    let received = 0;
    let failed = null;
    const getPart = partFetcher(c, msg, info, () => failed);

    async function worker() {
        while (!failed && next < parts) {
            const i = next++;
            try {
                if (limited) await throttle(Math.min(PART, info.size - i * PART));
                const bytes = await getPart(i);
                await fh.write(bytes, 0, bytes.length, i * PART);
                received += bytes.length;
                if (onProgress) onProgress(received);
            } catch (e) {
                failed = failed || e;
            }
        }
    }

    try {
        await Promise.allSettled(Array.from({ length: Math.min(partWorkers(), parts) }, worker));
    } finally {
        await fh.close();
    }
    if (failed) throw failed;
    return outFile;
}

// A simple pool that runs several jobs at once
function pool(limit) {
    const running = new Set();
    return {
        async add(fn) {
            while (running.size >= limit()) await Promise.race(running);
            const p = Promise.resolve().then(fn).finally(() => running.delete(p));
            running.add(p);
            return p;
        },
        size: () => running.size,
        drain: () => Promise.allSettled([...running]),
    };
}

module.exports = { download, readRange, documentLocation, pool, fileWorkers, partWorkers, PART, throttle };
