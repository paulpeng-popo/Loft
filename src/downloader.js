// Downloads: everything goes through one queue, one job at a time.
// Duplicate checks are built in, nothing to configure:
//   Before download: this message already downloaded -> this Telegram file already downloaded
//   After download: same content hash -> delete the just-downloaded temp file right away (not sent to the Recycle Bin)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Api } = require('telegram');
const { getSetting, tasks, downloads, runs, failures } = require('./db');
const tg = require('./tg');
const { log, lines: logLines } = require('./log');
const fastdl = require('./fastdl');

// Types a task can pick (stickers are not media downloads)
const MEDIA_TYPES = ['photo', 'video', 'gif', 'document', 'audio', 'voice', 'video_note'];

const state = {
    running: null, // { taskId, taskName, runId, scanned, downloaded, skipped, failed, active }
    queue: [],
    cancel: false,
};

const MIME_EXT = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/jpeg': '.jpg', 'image/png': '.png', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf', 'application/zip': '.zip',
};

const num = (v) => (v == null ? 0 : Number(v.toString()));

function mediaInfo(msg) {
    if (!msg.media || msg.media instanceof Api.MessageMediaWebPage || msg.sticker) return null;
    let type;
    if (msg.gif) type = 'gif';
    else if (msg.videoNote) type = 'video_note';
    else if (msg.video) type = 'video';
    else if (msg.voice) type = 'voice';
    else if (msg.audio) type = 'audio';
    else if (msg.photo) type = 'photo';
    else if (msg.document) type = 'document';
    else return null;

    const f = msg.file;
    let ext = (f && f.ext) || '';
    if (type === 'photo') ext = '.jpg';
    // GIFs (really mp4) and voice messages often have no file name, so guess the extension from the MIME type
    if (!ext && msg.document) ext = MIME_EXT[msg.document.mimeType] || '';
    if (ext && !ext.startsWith('.')) ext = `.${ext}`;
    const name = (f && f.name) || null;
    return {
        type,
        size: num(f && f.size),
        name,
        ext: name && path.extname(name) ? path.extname(name) : ext,
        key: msg.photo ? `p${msg.photo.id}` : msg.document ? `d${msg.document.id}` : null,
    };
}

const inflightKeys = new Set(); // Telegram files being downloaded right now (duplicates within one batch are fetched only once)

/**
 * Duplicate check before download. Returns { skip: reason }, or {} when it should be downloaded
 */
async function precheck(chatKey, msg, info, force) {
    if (downloads.byMessage(chatKey, msg.id)) return { skip: '這則已下載過' };
    if (force) return {};
    if (info.key) {
        const hit = downloads.byKey(info.key);
        if (hit) return { skip: `同一個檔案已下載（${hit.chat_title || hit.chat_id} #${hit.msg_id}）` };
        if (inflightKeys.has(info.key)) return { skip: '同一個檔案正在下載' };
    }
    return {};
}

const sanitize = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || '_';

function senderOf(msg) {
    const s = msg.sender;
    if (s) return s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || '';
    return msg.postAuthor || '';
}

/**
 * File name template. extra.topic = topic name (looked up by the caller when the template has {topic})
 * When a variable becomes empty, the leftover _ - and spaces around it are removed too; folders that end up empty are skipped.
 */
function fileNameFor(template, msg, info, chatTitle, extra = {}) {
    const date = new Date(msg.date * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const original = info.name || `${info.type}_${msg.id}${info.ext}`;
    const base = path.basename(original, path.extname(original));
    const caption = (msg.message || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const album = msg.groupedId ? `album_${msg.groupedId.toString().slice(-8)}` : '';
    const tpl = template || getSetting('name_template') || (info.name ? '{id}_{name}' : '{id}_{type}');
    // Without an original name (GIFs, voice, photos) {id}_{name} would become 123_gif_123, so make it 123_gif
    const effective = !info.name && tpl === '{id}_{name}' ? '{id}_{type}' : tpl;
    const vars = {
        id: msg.id, name: original, basename: base, ext: info.ext, date: ymd, time: hms, type: info.type,
        chat: chatTitle, caption, sender: senderOf(msg), topic: extra.topic || '', album,
    };
    const out = effective.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]).replace(/[\\/]/g, '_') : m));
    const segs = out.split(/[\\/]/).map((x) => x.replace(/^[\s_\-.]+|[\s_\-]+$/g, '')).filter(Boolean);
    if (!segs.length) segs.push(`${msg.id}`);
    let last = segs.pop();
    if (info.ext && !last.toLowerCase().endsWith(info.ext.toLowerCase())) last += info.ext;
    segs.push(last);
    // A / in the template means a subfolder
    return segs.map(sanitize).join(path.sep);
}

// Topic name cache (only looked up when the template uses {topic})
const topicNames = new Map(); // chatKey -> { at, map }
async function topicTitle(chatKey, msg) {
    const id = tg.topicOf(msg);
    if (!id) return '';
    let hit = topicNames.get(chatKey);
    if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
        const map = new Map();
        try {
            const { entity } = await tg.resolveChat(chatKey);
            const c = await tg.getClient();
            for (const t of await tg.forumTopics(c, entity)) map.set(t.id, t.title);
        } catch {
            // Leave empty if it can't be found
        }
        hit = { at: Date.now(), map };
        topicNames.set(chatKey, hit);
    }
    return hit.map.get(id) || (id === 1 ? 'General' : String(id));
}

async function nameFor(template, msg, info, chatKey, chatTitle) {
    const tpl = template || getSetting('name_template') || '';
    const topic = tpl.includes('{topic}') ? await topicTitle(chatKey, msg) : '';
    return fileNameFor(template, msg, info, chatTitle, { topic });
}

function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p);
    const base = p.slice(0, p.length - ext.length);
    for (let i = 1; ; i++) {
        const c = `${base} (${i})${ext}`;
        if (!fs.existsSync(c)) return c;
    }
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', (b) => h.update(b)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

const systemDownloads = () => process.env.LOFT_DOWNLOADS_DIR || path.join(require('node:os').homedir(), 'Downloads');
const downloadRoot = () => getSetting('download_root') || path.join(systemDownloads(), 'Telegram');
const destDir = (task, chatTitle) => (task && task.dest_dir) || path.join(downloadRoot(), sanitize(chatTitle));

const reservedPaths = new Set();

/**
 * Downloads one message: returns true on success (including skipped as a duplicate), false on failure.
 * track = false: don't update the progress bar at the top
 */
async function downloadOne({ task, msg, info, key, chatTitle, dir, stats, track = true }) {
    let target = uniquePath(path.join(dir, await nameFor(task && task.name_template, msg, info, key, chatTitle)));
    while (reservedPaths.has(target)) target = uniquePath(target.replace(/(\.[^.\\/]*)?$/, ' (+)$1'));
    reservedPaths.add(target);
    if (info.key) inflightKeys.add(info.key);
    const part = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const current = { msgId: msg.id, name: path.basename(target), size: info.size, received: 0 };
    const active = track && state.running && state.running.active;
    if (active) active.set(`${key}:${msg.id}`, current);
    const record = (p, hash) => downloads.add({
        task_id: (task && task.id) || null, chat_id: key, chat_title: chatTitle, msg_id: msg.id, file_key: info.key,
        file_name: info.name, size: info.size, sha256: hash, media_type: info.type, path: p, msg_date: new Date(msg.date * 1000).toISOString(),
    });
    try {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await fastdl.download(msg, part, { onProgress: (n) => { current.received = n; } });
                const hash = await sha256(part);
                const same = downloads.bySha(hash);
                if (same) {
                    // Identical content: delete the just-downloaded temp file and point the record at the existing file (this message is skipped next time)
                    fs.rmSync(part, { force: true });
                    stats.skipped++;
                    record(same.path, hash);
                    log(`略過 #${msg.id}：內容和 ${same.path} 完全相同`);
                    return true;
                }
                fs.renameSync(part, target);
                record(target, hash);
                stats.downloaded++;
                log(`下載 #${msg.id} → ${target}`);
                return true;
            } catch (e) {
                fs.rmSync(part, { force: true });
                if (attempt === 2) {
                    stats.failed++;
                    log(`下載 #${msg.id} 失敗：${e.errorMessage || e.message}`);
                    failures.add({ chat_id: key, msg_id: msg.id, chat_title: chatTitle, task_id: task && task.id, file_name: info.name,
                        size: info.size, media_type: info.type, error: e.errorMessage || e.message });
                    return false;
                }
            }
        }
        return false;
    } finally {
        reservedPaths.delete(target);
        if (info.key) inflightKeys.delete(info.key);
        if (active) active.delete(`${key}:${msg.id}`);
    }
}

/**
 * Download specific messages (media wall selection). items = [{ chat, id, taskId? }]
 * opts.force: download anyway, skips the duplicate checks (except for this exact message already downloaded)
 */
async function runBatch(job) {
    const browse = require('./browse');
    const stats = { scanned: 0, downloaded: 0, skipped: 0, failed: 0 };
    const runId = runs.start(job.taskId || null, job.trigger || 'batch');
    state.cancel = false;
    state.running = { taskId: job.taskId || null, taskName: job.label, runId, ...stats, active: new Map() };
    let status = 'ok';
    const files = fastdl.pool(fastdl.fileWorkers);
    for (const it of job.items) {
        if (state.cancel) {
            status = 'cancelled';
            break;
        }
        stats.scanned++;
        await files.add(async () => {
            try {
                const { msg } = await browse.getMessage(it.chat, it.id);
                const { key, title } = await tg.resolveChat(it.chat);
                const info = mediaInfo(msg);
                if (!info) return;
                const owner = it.taskId ? tasks.get(it.taskId) : null;
                const chatTitle = (owner && owner.chat_title) || title;
                const pre = await precheck(key, msg, info, !!job.force);
                if (pre.skip) {
                    stats.skipped++;
                    failures.remove(key, msg.id);
                    if (!/已下載過/.test(pre.skip)) log(`略過 #${msg.id}：${pre.skip}`);
                    return;
                }
                await downloadOne({ task: owner, msg, info, key, chatTitle, dir: destDir(owner, chatTitle), stats });
            } catch (e) {
                stats.failed++;
                log(`下載 #${it.id} 失敗：${e.errorMessage || e.message}`);
                failures.add({ chat_id: it.chat, msg_id: it.id, task_id: it.taskId, error: e.errorMessage || e.message });
            } finally {
                if (state.running) Object.assign(state.running, stats);
            }
        });
        if (state.running) Object.assign(state.running, stats);
    }
    await files.drain();
    Object.assign(state.running, stats);
    if (stats.failed && status === 'ok') status = 'partial';
    runs.finish(runId, { status, ...stats, message: job.label });
    log(`結束${job.label}：下載 ${stats.downloaded}、略過重複 ${stats.skipped}、失敗 ${stats.failed}`);
}

// ---- Queue ----
// Media wall downloads jump the queue (right after the job that is currently running)
function enqueueBatch(items, label = '下載選取的媒體', { force = false, front = true, trigger = 'batch', taskId = null } = {}) {
    if (!items || !items.length) throw new Error('沒有選取任何媒體');
    const job = { taskId: null, batch: { items, label, force, trigger, taskId }, label };
    if (front) state.queue.unshift(job);
    else state.queue.push(job);
    pump();
    return true;
}

async function pump() {
    if (state.running || !state.queue.length) return;
    const job = state.queue.shift();
    try {
        if (job.batch) await runBatch(job.batch);
    } catch (e) {
        log(`工作異常：${e.message}`);
    } finally {
        state.running = null;
        setImmediate(pump);
    }
}

function stop(clearQueue = true) {
    if (clearQueue) state.queue = [];
    state.cancel = true;
}

function snapshot() {
    let running = null;
    if (state.running) {
        // Files downloading at the same time are merged into one progress bar
        const active = [...state.running.active.values()];
        const { active: _omit, ...rest } = state.running;
        running = {
            ...rest,
            current: active.length ? {
                name: active.length === 1 ? active[0].name : `${active.length} 個檔案同時下載中`,
                size: active.reduce((n, a) => n + (a.size || 0), 0),
                received: active.reduce((n, a) => n + (a.received || 0), 0),
            } : null,
        };
    }
    return {
        running,
        queue: state.queue.map((q) => ({ taskId: q.taskId, trigger: q.trigger, taskName: q.label || (tasks.get(q.taskId) || {}).name })),
        log: logLines.slice(-200),
    };
}

module.exports = {
    MEDIA_TYPES, mediaInfo, enqueueBatch, stop, snapshot, log, fileNameFor,
};
