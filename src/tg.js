// Telegram connection, login
const fs = require('node:fs');
const path = require('node:path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Logger } = require('telegram/extensions');
const { DATA_DIR, getSetting } = require('./db');
const { log } = require('./log');

const SESSION_FILE = path.join(DATA_DIR, 'session.txt');

let client = null;
let connecting = null;
let pendingLogin = null;
let me = null;

const selfId = () => (me ? me.id.toString() : null);

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

module.exports = {
    getClient, resetClient, authStatus, sendCode, signIn, signInPassword, logout,
    selfId,
};
