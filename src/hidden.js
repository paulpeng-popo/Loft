// Hidden media: the right-click hide (including look-alikes) action. This file and images / videos that look the same, in any chat, are neither shown on the media wall nor downloaded.
const { hidden: store } = require('./db');
const similar = require('./similar');

let cache = null; // [{ key, fp }]
const load = () => cache || (cache = store.list().map((r) => ({
    key: r.file_key,
    row: r,
    fp: { key: r.file_key, kind: r.kind, phash: r.phash, aspect: r.aspect, w: r.w, h: r.h, duration: r.duration, size: r.size },
})));

const keys = () => new Set(load().map((h) => h.key));

/** The same file (known instantly, no fingerprint needed) */
function isKeyHidden(key) {
    return !!key && load().some((h) => h.key === key);
}

/** Looks the same: compare fingerprints (must already be computed) */
function matchFp(fp) {
    if (!fp) return false;
    return load().some((h) => h.key === fp.key || (h.fp.phash || h.fp.size) && similar.compare(fp, h.fp, 'normal').similar);
}

/** Whether to hide a message: compare the file id first, then the fingerprint (computed from a small thumbnail) */
async function check(msg) {
    const key = similar.fileKeyOf(msg);
    if (!key || !load().length) return false;
    if (isKeyHidden(key)) return true;
    if (!similar.kindOf(msg)) return false;
    const fp = await similar.fingerprint(msg).catch(() => null);
    return matchFp(fp);
}

async function hide(msg, chatKey) {
    const key = similar.fileKeyOf(msg);
    if (!key) throw new Error('這則訊息沒有可以隱藏的媒體');
    const fp = similar.kindOf(msg) ? await similar.fingerprint(msg).catch(() => null) : null;
    store.add({ ...(fp || {}), key, chat_id: chatKey, msg_id: msg.id });
    cache = null;
    return { key };
}

function unhide(key) {
    store.remove(key);
    cache = null;
}

const list = () => load().map((h) => ({ key: h.key, chat: h.row.chat_id, msg: h.row.msg_id, kind: h.row.kind, at: h.row.hidden_at }));

module.exports = { isKeyHidden, matchFp, check, hide, unhide, list, keys };
