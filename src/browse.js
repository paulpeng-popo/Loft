// Chat list: avatars and folders (read-only, never marks messages as read)
const fs = require('node:fs');
const path = require('node:path');
const { Api, utils } = require('telegram');
const { DATA_DIR } = require('./db');
const tg = require('./tg');

const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DIRS = {
    avatar: path.join(CACHE_DIR, 'avatars'),
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

// When the same file is requested several times at once, download it only once
const inflight = new Map();
function once(key, fn) {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
}

const safeId = (s) => String(s).replace(/[^\w-]/g, '_');

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

module.exports = {
    avatar, folders,
};
