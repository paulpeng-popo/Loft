// Telegram connection, login, chat list
const fs = require('node:fs');
const path = require('node:path');
const { TelegramClient, Api, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Logger } = require('telegram/extensions');
const { DATA_DIR, getSetting } = require('./db');
const { log } = require('./log');

const SESSION_FILE = path.join(DATA_DIR, 'session.txt');

let client = null;
let connecting = null;
let pendingLogin = null;
let me = null;
let dialogCache = { at: 0, list: [], entities: new Map() };
// Chats seen before but not in the chat list (e.g. public channels)
const extraEntities = new Map();

const selfId = () => (me ? me.id.toString() : null);

// Topic id of a message in a forum group (the General topic is 1)
function topicOf(msg) {
    const r = msg.replyTo;
    if (!r || !r.forumTopic) return null;
    return r.replyToTopId || r.replyToMsgId || null;
}

// All topics of a forum group (paged when there are more than 100)
async function forumTopics(c, entity) {
    const all = [];
    let offset = { offsetDate: 0, offsetId: 0, offsetTopic: 0 };
    for (let page = 0; page < 20; page++) {
        const r = await c.invoke(new Api.channels.GetForumTopics({ channel: entity, ...offset, limit: 100 }));
        const topics = r.topics.filter((t) => t instanceof Api.ForumTopic);
        all.push(...topics);
        if (topics.length < 100 || all.length >= r.count) break;
        const last = topics[topics.length - 1];
        const lm = r.messages.find((m) => m.id === last.topMessage);
        offset = { offsetDate: lm ? lm.date : 0, offsetId: last.topMessage, offsetTopic: last.id };
    }
    return all;
}

function rememberEntity(key, entity) {
    if (!dialogCache.entities.has(key)) extraEntities.set(key, entity);
}

function credentials() {
    const apiId = parseInt(getSetting('api_id'), 10);
    const apiHash = getSetting('api_hash');
    if (!apiId || !apiHash) throw new Error('請先到「設定」填入 api_id 與 api_hash');
    return { apiId, apiHash };
}

function readSession() {
    try {
        return fs.readFileSync(SESSION_FILE, 'utf8').trim();
    } catch {
        return '';
    }
}

function saveSession() {
    fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf8');
}

async function getClient() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
        const { apiId, apiHash } = credentials();
        const c = new TelegramClient(new StringSession(readSession()), apiId, apiHash, {
            connectionRetries: 5,
            floodSleepThreshold: 300,
            baseLogger: new Logger('error'),
        });
        await c.connect();
        client = c;
        return c;
    })();
    try {
        return await connecting;
    } finally {
        connecting = null;
    }
}

async function resetClient() {
    const c = client;
    client = null;
    clearAuthCache();
    me = null;
    pendingLogin = null;
    dialogCache = { at: 0, list: [], entities: new Map() };
    if (c) {
        try {
            await c.destroy();
        } catch {
            // A failed disconnect doesn't stop the rebuild
        }
    }
}

// Cache the login state for 60 seconds: the page polls /api/status constantly, so don't ask Telegram every time
let authCache = { at: 0, value: null };
async function authStatus() {
    if (authCache.value && Date.now() - authCache.at < 60000) return authCache.value;
    let value;
    try {
        const c = await getClient();
        if (!(await c.checkAuthorization())) value = { authorized: false, pending: !!pendingLogin };
        else {
            if (!me) me = await c.getMe();
            value = {
                authorized: true,
                user: {
                    name: [me.firstName, me.lastName].filter(Boolean).join(' '),
                    username: me.username || null,
                },
            };
        }
    } catch (e) {
        value = { authorized: false, error: e.message };
    }
    // Don't cache while logged out, so changes during the login flow show up
    authCache = value.authorized ? { at: Date.now(), value } : { at: 0, value: null };
    return value;
}
const clearAuthCache = () => { authCache = { at: 0, value: null }; };

async function sendCode(phone) {
    const c = await getClient();
    const r = await c.sendCode(credentials(), phone);
    pendingLogin = { phone, phoneCodeHash: r.phoneCodeHash };
    log(`已傳送驗證碼（${r.isCodeViaApp ? 'Telegram App' : '簡訊'}）`);
    return { viaApp: r.isCodeViaApp };
}

async function signIn(code) {
    if (!pendingLogin) throw new Error('請先送出手機號碼取得驗證碼');
    const c = await getClient();
    try {
        await c.invoke(new Api.auth.SignIn({
            phoneNumber: pendingLogin.phone,
            phoneCodeHash: pendingLogin.phoneCodeHash,
            phoneCode: String(code).trim(),
        }));
    } catch (e) {
        if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            log('驗證碼正確，需要兩步驟驗證密碼');
            return { needPassword: true };
        }
        log(`登入失敗：${e.errorMessage || e.message}`);
        throw e;
    }
    await loggedIn();
    return { ok: true };
}

async function loggedIn() {
    pendingLogin = null;
    clearAuthCache();
    saveSession();
    me = await client.getMe();
    log(`登入成功：${[me.firstName, me.lastName].filter(Boolean).join(' ')}`);
}

async function signInPassword(password) {
    const c = await getClient();
    await c.signInWithPassword(credentials(), {
        password: async () => password,
        onError: async (e) => {
            log(`兩步驟驗證失敗：${e.errorMessage || e.message}`);
            throw e;
        },
    });
    await loggedIn();
    return { ok: true };
}

async function logout() {
    try {
        const c = await getClient();
        await c.invoke(new Api.auth.LogOut());
    } catch {
        // Clear an expired session the same way
    }
    fs.rmSync(SESSION_FILE, { force: true });
    await resetClient();
    log('已登出並刪除 session');
}

function dialogType(d) {
    if (d.isUser) return 'user';
    if (d.isChannel && !d.entity?.megagroup) return 'channel';
    return 'group';
}

async function listDialogs(refresh = false) {
    if (!refresh && dialogCache.list.length && Date.now() - dialogCache.at < 10 * 60 * 1000) return dialogCache.list;
    const c = await getClient();
    // The main list and the archive folder must be fetched separately; without a folder only the main list comes back
    const [main, archived] = await Promise.all([c.getDialogs({ archived: false }), c.getDialogs({ archived: true })]);
    const entities = new Map();
    const list = [];
    for (const d of [...main, ...archived]) {
        const id = d.id.toString();
        if (entities.has(id)) continue;
        entities.set(id, d.entity);
        const m = d.message;
        const e = d.entity || {};
        const photo = e.photo;
        list.push({
            id,
            title: e.self ? '已儲存的訊息' : d.title || d.name || id,
            type: dialogType(d),
            username: e.username || null,
            pinned: !!d.pinned,
            archived: !!d.archived,
            forum: !!e.forum,
            creator: !!e.creator,
            admin: !!e.adminRights,
            self: !!e.self,
            left: !!e.left,
            bot: !!e.bot,
            contact: !!e.contact,
            noforwards: !!e.noforwards,
            migrated: !!e.migratedTo,
            folderId: d.folderId || 0,
            muted: !!(d.dialog && d.dialog.notifySettings && d.dialog.notifySettings.muteUntil > Date.now() / 1000),
            hasPhoto: !!photo && !(photo instanceof Api.ChatPhotoEmpty) && !(photo instanceof Api.UserProfilePhotoEmpty),
            lastDate: m ? new Date(m.date * 1000).toISOString() : null,
            lastId: m ? m.id : 0,
        });
    }
    dialogCache = { at: Date.now(), list, entities };
    return list;
}

// chatId can be a dialog's numeric id, an @username or a t.me link
async function resolveChat(chatId) {
    const id = String(chatId).trim();
    const c = await getClient();
    if (!/^-?\d+$/.test(id)) {
        const name = id.replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '');
        const entity = await c.getEntity(name);
        const key = utils.getPeerId(entity).toString();
        rememberEntity(key, entity);
        return { entity, key, title: entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || name };
    }
    if (extraEntities.has(id) && !dialogCache.entities.has(id)) {
        const entity = extraEntities.get(id);
        return { entity, key: id, title: entity.title || entity.firstName || id };
    }
    if (!dialogCache.entities.has(id)) await listDialogs(true);
    const entity = dialogCache.entities.get(id);
    if (!entity) throw new Error(`對話列表裡找不到 ${id}（帳號可能已退出這個頻道）`);
    const d = dialogCache.list.find((x) => x.id === id);
    return { entity, key: id, title: d ? d.title : id };
}

module.exports = {
    getClient, resetClient, authStatus, sendCode, signIn, signInPassword, logout,
    listDialogs, resolveChat, rememberEntity, selfId, forumTopics, topicOf,
};
