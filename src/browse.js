// Media wall: list a chat's media, thumbnails, originals, topics and folders (read-only, never marks messages as read)
const fs = require('node:fs');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api, utils } = require('telegram');
const { DATA_DIR, downloads } = require('./db');
const tg = require('./tg');
const hidden = require('./hidden');

const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DIRS = {
    avatar: path.join(CACHE_DIR, 'avatars'),
    thumb: path.join(CACHE_DIR, 'thumbs'),
    file: path.join(CACHE_DIR, 'files'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// Limit concurrent downloads so hundreds of thumbnails at once don't trigger rate limits
function limiter(max) {
    let active = 0;
    const waiting = [];
    return async (fn) => {
        if (active >= max) await new Promise((r) => waiting.push(r));
        active++;
        try {
            return await fn();
        } finally {
            active--;
            if (waiting.length) waiting.shift()();
        }
    };
}
const avatarLimit = limiter(3);
const thumbLimit = limiter(8);

// When the same file is requested several times at once, download it only once
const inflight = new Map();
function once(key, fn) {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
}

const safeId = (s) => String(s).replace(/[^\w-]/g, '_');

// Message object cache: thumbnails, originals and downloads all need the original file reference
const msgCache = new Map();
function remember(chatKey, msg) {
    msgCache.set(`${chatKey}:${msg.id}`, msg);
    if (msgCache.size > 5000) msgCache.delete(msgCache.keys().next().value);
}
async function getMessage(chatId, msgId) {
    const { entity, key } = await tg.resolveChat(chatId);
    const cached = msgCache.get(`${key}:${msgId}`);
    if (cached) return { msg: cached, key };
    const c = await tg.getClient();
    const [msg] = await c.getMessages(entity, { ids: [Number(msgId)] });
    if (!msg) throw new Error('找不到訊息（可能已被刪除）');
    remember(key, msg);
    return { msg, key };
}

async function avatar(chatId) {
    const file = path.join(DIRS.avatar, `${safeId(chatId)}.jpg`);
    if (fs.existsSync(file)) return file;
    return once(file, () => avatarLimit(async () => {
        const { entity } = await tg.resolveChat(chatId);
        const c = await tg.getClient();
        const buf = await c.downloadProfilePhoto(entity, { isBig: false });
        if (!buf || !buf.length) return null;
        fs.writeFileSync(file, buf);
        return file;
    }));
}

const docAttr = (doc, cls) => (doc && doc.attributes ? doc.attributes.find((a) => a instanceof cls) : null);

// The ~40px blurred preview embedded in the message (no extra download), shown before the thumbnail loads
function strippedUri(sizes) {
    const s = (sizes || []).find((x) => x instanceof Api.PhotoStrippedSize);
    if (!s) return null;
    try {
        return `data:image/jpeg;base64,${utils.strippedPhotoToJpg(s.bytes).toString('base64')}`;
    } catch {
        return null;
    }
}

// Media kind; returns null for anything that isn't downloadable media (stickers, link previews, polls, ...)
function kindOf(msg) {
    const m = msg.media;
    if (!m) return null;
    if (m instanceof Api.MessageMediaPhoto && m.photo instanceof Api.Photo) return 'photo';
    if (!(m instanceof Api.MessageMediaDocument) || !(m.document instanceof Api.Document)) return null;
    const doc = m.document;
    if (docAttr(doc, Api.DocumentAttributeSticker)) return null;
    if (docAttr(doc, Api.DocumentAttributeAnimated)) return 'gif';
    const video = docAttr(doc, Api.DocumentAttributeVideo);
    if (video) return video.roundMessage ? 'video_note' : 'video';
    const audio = docAttr(doc, Api.DocumentAttributeAudio);
    if (audio) return audio.voice ? 'voice' : 'audio';
    if (/^image\//.test(doc.mimeType || '')) return 'image';
    return 'document';
}

function senderName(msg) {
    const s = msg.sender;
    if (s) return s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || null;
    return msg.postAuthor || null;
}

const fileKeyOf = (msg) => (msg.photo ? `p${msg.photo.id}` : msg.document ? `d${msg.document.id}` : null);

// Already downloaded / the same file was downloaded elsewhere (known instantly, no fingerprint needed)
function statusOf(chat, msg, key) {
    const own = downloads.byMessage(chat, msg.id);
    if (own) return { status: 'done', path: own.path };
    const same = key && downloads.byKey(key);
    if (same) return { status: 'dup', dupOf: { chat: same.chat_title || same.chat_id, path: same.path, why: '同一個檔案' } };
    return { status: null };
}

/** Data for one tile on the media wall */
function item(chat, msg) {
    const kind = kindOf(msg);
    const key = fileKeyOf(msg);
    const base = {
        id: msg.id,
        chat,
        date: new Date(msg.date * 1000).toISOString(),
        topic: tg.topicOf(msg),
        kind,
        key,
        caption: (msg.message || '').slice(0, 300),
        groupedId: msg.groupedId ? msg.groupedId.toString() : null,
        sender: senderName(msg),
        ...statusOf(chat, msg, key),
    };
    if (kind === 'photo') {
        const big = (msg.photo.sizes || []).filter((s) => 'w' in s).pop();
        const size = big ? big.size || (big.sizes ? Math.max(...big.sizes) : 0) : 0;
        return { ...base, w: big ? big.w : null, h: big ? big.h : null, size, name: null, mime: 'image/jpeg', blur: strippedUri(msg.photo.sizes), thumb: true };
    }
    const doc = msg.document;
    const v = docAttr(doc, Api.DocumentAttributeVideo);
    const a = docAttr(doc, Api.DocumentAttributeAudio);
    const n = docAttr(doc, Api.DocumentAttributeFilename);
    const size = Number(doc.size.toString());
    const hasThumb = (doc.thumbs || []).some((t) => !(t instanceof Api.PhotoPathSize));
    return {
        ...base,
        w: v ? v.w : null,
        h: v ? v.h : null,
        duration: v || a ? Math.round((v || a).duration || 0) : null,
        size,
        name: n ? n.fileName : null,
        mime: doc.mimeType,
        title: a ? [a.performer, a.title].filter(Boolean).join(' - ') || null : null,
        blur: strippedUri(doc.thumbs),
        thumb: hasThumb || (kind === 'image' && size < 3 * 1024 * 1024),
    };
}

// Type -> Telegram search filter
const FILTERS = {
    visual: Api.InputMessagesFilterPhotoVideo,
    photo: Api.InputMessagesFilterPhotos,
    video: Api.InputMessagesFilterVideo,
    gif: Api.InputMessagesFilterGif,
    document: Api.InputMessagesFilterDocument,
    music: Api.InputMessagesFilterMusic,
    voice: Api.InputMessagesFilterRoundVoice,
    all: Api.InputMessagesFilterEmpty,
};

// Messages returned by the raw API need sender / chat info filled in
function finishInit(c, r, entity) {
    const entities = new Map();
    for (const x of [...(r.users || []), ...(r.chats || [])]) {
        const key = utils.getPeerId(x).toString();
        entities.set(key, x);
        if (x instanceof Api.Channel || x instanceof Api.Chat) tg.rememberEntity(key, x);
    }
    const msgs = (r.messages || []).filter((m) => m instanceof Api.Message);
    for (const m of msgs) if (typeof m._finishInit === 'function') m._finishInit(c, entities, entity);
    return msgs;
}

/**
 * One page of search results (newest first or oldest first). cursor: id of the last message of the previous page (0 = from the start)
 */
/** Returns { msgs, exhausted }: exhausted = nothing left after this */
async function searchPage(c, entity, opts) {
    // Default (photos, videos, GIFs): no single Telegram filter covers all three, so query separately and merge by id
    if (!opts.type || opts.type === 'visual') {
        const lists = await Promise.all([
            searchOne(c, entity, { ...opts, type: 'photovideo' }),
            searchOne(c, entity, { ...opts, type: 'gif' }),
        ]);
        const seen = new Set();
        let msgs = lists.flat().filter((m) => !seen.has(m.id) && seen.add(m.id))
            .sort((x, y) => (opts.oldest ? x.id - y.id : y.id - x.id));
        // Whichever list has a next page may not have reached the range past the other list's last message yet: keep only the part both lists cover, the rest comes with the next page
        const full = lists.filter((l) => l.length >= opts.limit);
        if (full.length) {
            const bounds = full.map((l) => l[l.length - 1].id);
            const cut = opts.oldest ? Math.min(...bounds) : Math.max(...bounds);
            msgs = msgs.filter((m) => (opts.oldest ? m.id <= cut : m.id >= cut));
        }
        return { msgs, exhausted: !full.length };
    }
    const msgs = await searchOne(c, entity, opts);
    return { msgs, exhausted: msgs.length < opts.limit };
}

async function searchOne(c, entity, { type, q, topic, minDate, maxDate, cursor, oldest, limit }) {
    const Filter = type === 'photovideo' ? Api.InputMessagesFilterPhotoVideo : FILTERS[type] || FILTERS.visual;
    const req = {
        peer: entity, q: q || '', filter: new Filter(), minDate: minDate || 0, maxDate: maxDate || 0,
        limit, maxId: 0, minId: 0, hash: bigInt(0),
        // Oldest first: page from the cursor towards newer messages
        offsetId: oldest ? (cursor || 0) + 1 : cursor || 0,
        addOffset: oldest ? -limit : 0,
    };
    if (topic && Number(topic) !== 1) req.topMsgId = Number(topic);
    const r = await c.invoke(new Api.messages.Search(req));
    let msgs = finishInit(c, r, await c.getInputEntity(entity));
    msgs = oldest ? msgs.filter((m) => m.id > (cursor || 0)).sort((a, b) => a.id - b.id)
        : msgs.filter((m) => !cursor || m.id < cursor).sort((a, b) => b.id - a.id);
    return msgs;
}

/**
 * Yields messages of several media types in order (for tasks and previews). Each type is searched and paged on its own, then merged by message id, so text messages are never scanned.
 * kinds: search types (photovideo / photo / video / gif / document / music / voice)
 * opts: topic, minDate / maxDate (seconds), after (only messages after this id, used when oldest first), oldest (true = oldest first)
 */
async function* mediaStream(c, entity, kinds, { topic, minDate, maxDate, after = 0, oldest = true } = {}) {
    const streams = kinds.map((type) => ({ type, buf: [], cursor: oldest ? after : 0, done: false }));
    const seen = new Set();
    const fill = async (s) => {
        if (s.buf.length || s.done) return;
        const page = await searchOne(c, entity, { type: s.type, topic, minDate, maxDate, cursor: s.cursor, oldest, limit: 100 });
        if (page.length < 100) s.done = true;
        s.buf = page;
        if (page.length) s.cursor = page[page.length - 1].id;
    };
    for (;;) {
        await Promise.all(streams.map(fill));
        let best = null;
        for (const s of streams) {
            if (s.buf.length && (!best || (oldest ? s.buf[0].id < best.buf[0].id : s.buf[0].id > best.buf[0].id))) best = s;
        }
        if (!best) return;
        const m = best.buf.shift();
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        // The General topic of a forum: messages without a topic
        if (Number(topic) === 1 && m.replyTo && m.replyTo.forumTopic) continue;
        yield m;
    }
}

// Task types -> which searches to run
function searchKinds(types) {
    const t = new Set(types);
    const out = [];
    if (t.has('photo') && t.has('video')) out.push('photovideo');
    else if (t.has('photo')) out.push('photo');
    else if (t.has('video')) out.push('video');
    if (t.has('gif')) out.push('gif');
    if (t.has('document')) out.push('document');
    if (t.has('audio')) out.push('music');
    if (t.has('voice') || t.has('video_note')) out.push('voice');
    return out;
}

const dayStart = (s) => (s ? Math.floor(new Date(`${s}T00:00:00`).getTime() / 1000) : 0);
const dayEnd = (s) => (s ? Math.floor(new Date(`${s}T23:59:59`).getTime() / 1000) : 0);

/**
 * One page of the media wall. opts:
 *   type (visual / photo / video / gif / document / music / voice / all), topic, from / to (YYYY-MM-DD), minMB,
 *   order (new / old), notDownloaded, q (search captions and file names), cursor, limit, showHidden
 */
async function media(chatId, opts = {}) {
    const { entity, key } = await tg.resolveChat(chatId);
    const c = await tg.getClient();
    const limit = Math.min(Number(opts.limit) || 60, 100);
    const oldest = opts.order === 'old';
    const minBytes = Number(opts.minMB) > 0 ? Number(opts.minMB) * 1048576 : 0;
    const generalOnly = entity.forum && Number(opts.topic) === 1;
    const hiddenKeys = opts.showHidden ? new Set() : hidden.keys();
    const items = [];
    let cursor = Number(opts.cursor) || 0;
    let scanned = 0;
    let done = false;
    // Some conditions are filtered again here (not downloaded, size, General topic); page further if one page isn't enough, looking at 800 messages at most
    while (items.length < limit && scanned < 800) {
        const { msgs: page, exhausted } = await searchPage(c, entity, {
            type: opts.type, q: opts.q, topic: opts.topic, minDate: dayStart(opts.from), maxDate: dayEnd(opts.to), cursor, oldest, limit: 100,
        });
        if (!page.length) {
            done = true;
            break;
        }
        for (const m of page) {
            scanned++;
            cursor = m.id;
            remember(key, m);
            if (!kindOf(m)) continue;
            if (generalOnly && m.replyTo && m.replyTo.forumTopic) continue;
            const it = item(key, m);
            if (hiddenKeys.has(it.key)) continue;
            if (minBytes && (it.size || 0) < minBytes) continue;
            if (opts.notDownloaded && it.status) continue;
            items.push(it);
            if (items.length >= limit) break;
        }
        if (exhausted && items.length < limit) {
            done = true;
            break;
        }
    }
    return { items, cursor: done && items.length < limit ? null : cursor, scanned };
}

/**
 * Fills in "looks the same" checks in the background (needs small thumbnails for fingerprints, so it stays out of media() to keep the first render fast).
 * Returns { [msgId]: { hidden } or { status: 'similar', dupOf } }
 */
async function check(chatId, ids) {
    const similar = require('./similar');
    const out = {};
    await Promise.all(ids.slice(0, 120).map(async (id) => {
        try {
            const { msg, key } = await getMessage(chatId, id);
            if (!similar.kindOf(msg)) return;
            const fp = await similar.fingerprint(msg, key);
            if (!fp) return;
            if (hidden.matchFp(fp)) {
                out[id] = { hidden: true };
                return;
            }
            if (statusOf(key, msg, fp.key).status) return;
            const hit = similar.findDownloaded(fp, 'normal');
            if (hit && !(hit.row.chat_id === key && hit.row.msg_id === msg.id)) {
                out[id] = { status: 'similar', dupOf: { chat: hit.row.chat_title, path: hit.row.path, why: hit.exact ? '內容相同' : '看起來一樣' } };
            }
        } catch {
            // One failure doesn't affect the others
        }
    }));
    return out;
}

async function topics(chatId) {
    const { entity } = await tg.resolveChat(chatId);
    if (!entity.forum) return [];
    const c = await tg.getClient();
    const list = await tg.forumTopics(c, entity);
    return list.filter((t) => !t.hidden || t.id === 1).map((t) => ({
        id: t.id,
        title: t.title,
        pinned: !!t.pinned,
        closed: !!t.closed,
        color: t.iconColor,
    }));
}

const titleText = (t) => (typeof t === 'string' ? t : (t && t.text) || '');

// Telegram chat folders (DialogFilter), only used as tabs on the chat list
async function folders() {
    const c = await tg.getClient();
    const r = await c.invoke(new Api.messages.GetDialogFilters());
    const list = Array.isArray(r) ? r : r.filters || [];
    const ids = (peers) => (peers || []).map((p) => {
        try {
            return utils.getPeerId(p).toString();
        } catch {
            return null;
        }
    }).filter(Boolean);
    return list.filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist).map((f) => ({
        id: f.id,
        title: titleText(f.title),
        emoticon: f.emoticon || null,
        include: [...ids(f.pinnedPeers), ...ids(f.includePeers)],
        exclude: ids(f.excludePeers),
        contacts: !!f.contacts,
        nonContacts: !!f.nonContacts,
        groups: !!f.groups,
        broadcasts: !!f.broadcasts,
        bots: !!f.bots,
        excludeMuted: !!f.excludeMuted,
        excludeArchived: !!f.excludeArchived,
    }));
}

// Pick the largest thumbnail type no wider than maxW. small (~320px) for the media wall and similarity checks; large (~800px) for the viewer
const THUMB_MAX = { small: 400, large: 800 };
function pickThumbType(sizes, size = 'large') {
    const maxW = THUMB_MAX[size] || 800;
    const usable = (sizes || []).filter((s) => (s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive) && s.w);
    if (!usable.length) return undefined;
    usable.sort((a, b) => a.w - b.w);
    const fit = usable.filter((s) => s.w <= maxW);
    return (fit.length ? fit[fit.length - 1] : usable[0]).type;
}

const thumbPath = (key, msgId, size = 'large') => path.join(DIRS.thumb, `${safeId(key)}_${Number(msgId)}${size === 'small' ? '_s' : ''}`);

async function thumb(chatId, msgId, size = 'large') {
    const { key } = await tg.resolveChat(chatId);
    const file = thumbPath(key, msgId, size);
    if (fs.existsSync(file)) return file;
    const { msg } = await getMessage(chatId, msgId);
    return thumbForMsg(msg, key, size);
}

// Get a thumbnail straight from the message object (the media wall and similarity checks share one cache)
async function thumbForMsg(msg, key, size = 'large') {
    const file = thumbPath(key, msg.id, size);
    if (fs.existsSync(file)) return file;
    return once(file, () => thumbLimit(async () => {
        const c = await tg.getClient();
        const media = msg.media;
        let buf;
        if (media instanceof Api.MessageMediaPhoto) {
            buf = await c.downloadMedia(media.photo, { thumb: pickThumbType(media.photo.sizes, size) });
        } else if (media instanceof Api.MessageMediaDocument) {
            const doc = media.document;
            const type = pickThumbType(doc.thumbs, size);
            // Small images without a thumbnail: download the original; large files without one: give up
            if (type) buf = await c.downloadMedia(msg, { thumb: type });
            else if (Number(doc.size.toString()) < 3 * 1024 * 1024) buf = await c.downloadMedia(msg, {});
        }
        if (!buf || !buf.length) return null;
        fs.writeFileSync(file, buf);
        return file;
    }));
}

// Originals for the viewer (kept in the cache, not counted as downloads, not speed limited)
async function original(chatId, msgId) {
    const { msg, key } = await getMessage(chatId, msgId);
    const f = msg.file;
    const ext = (f && f.name && path.extname(f.name)) || (msg.photo ? '.jpg' : (f && f.ext) || '');
    const file = path.join(DIRS.file, `${safeId(key)}_${Number(msgId)}${ext}`);
    if (fs.existsSync(file)) return { file, name: (f && f.name) || path.basename(file) };
    await once(file, async () => {
        const part = `${file}.part`;
        await require('./fastdl').download(msg, part, { noLimit: true });
        fs.renameSync(part, file);
    });
    return { file, name: (f && f.name) || path.basename(file) };
}

function cacheSize() {
    let bytes = 0;
    let files = 0;
    for (const d of Object.values(DIRS)) {
        for (const n of fs.readdirSync(d)) {
            bytes += fs.statSync(path.join(d, n)).size;
            files++;
        }
    }
    return { bytes, files };
}

function clearCache(which = ['thumb', 'file']) {
    for (const k of which) {
        const d = DIRS[k];
        if (!d) continue;
        for (const n of fs.readdirSync(d)) fs.rmSync(path.join(d, n), { force: true });
    }
}

module.exports = {
    avatar, media, check, topics, folders, thumb, thumbForMsg, original, getMessage, remember, cacheSize, clearCache, kindOf, item,
    mediaStream, searchKinds,
};
