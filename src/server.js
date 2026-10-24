require('./logfile'); // load first: log rotation, filters connection-timeout noise
const path = require('node:path');
const express = require('express');
const { getSetting, setSetting } = require('./db');
const tg = require('./tg');
const { log } = require('./log');

const PORT = Number(process.env.PORT) || 8787;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => {
    Promise.resolve()
        .then(() => fn(req, res))
        .then((data) => res.json(data === undefined ? { ok: true } : data))
        .catch((e) => {
            // Program errors (not errors returned by Telegram): print the stack to the log for debugging
            if (!e.errorMessage && e.stack) console.error(`[${req.method} ${req.path}]`, e.stack);
            res.status(400).json({ error: e.errorMessage || e.message || String(e) });
        });
};

// ---- Status and settings ----
app.get('/api/status', wrap(async () => ({ auth: await tg.authStatus() })));

app.get('/api/settings', wrap(() => ({
    api_id: getSetting('api_id', ''),
    has_api_hash: !!getSetting('api_hash'),
})));

app.put('/api/settings', wrap(async (req) => {
    const b = req.body;
    const credsChanged = (b.api_id !== undefined && String(b.api_id) !== getSetting('api_id', '')) || !!b.api_hash;
    if (b.api_id !== undefined) setSetting('api_id', String(b.api_id).trim());
    if (b.api_hash) setSetting('api_hash', String(b.api_hash).trim());
    if (credsChanged) await tg.resetClient();
    log(credsChanged ? '設定已更新（API 憑證變更，重新連線）' : '設定已更新');
}));

// ---- Login ----
app.post('/api/auth/send-code', wrap((req) => tg.sendCode(String(req.body.phone || '').trim())));
app.post('/api/auth/sign-in', wrap((req) => tg.signIn(req.body.code)));
app.post('/api/auth/password', wrap((req) => tg.signInPassword(String(req.body.password || ''))));
app.post('/api/auth/logout', wrap(() => tg.logout()));

/**
 * Starts the web server, and only connects to Telegram once that succeeds. Returns { url }.
 * Port in use means a Loft is already running: fail right away, never connect to Telegram again with the same session (two connections at once can invalidate it)
 */
function start() {
    return new Promise((resolve, reject) => {
        const httpServer = app.listen(PORT, '127.0.0.1', () => {
            const url = `http://127.0.0.1:${PORT}`;
            log(`Web 介面：${url}`);
            // If there is a login, connect right away
            tg.authStatus().then((s) => {
                log(s.authorized ? `已登入：${s.user.name}` : '尚未登入 Telegram');
            });
            resolve({ url });
        });
        httpServer.on('error', (e) => {
            reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`埠號 ${PORT} 已被使用，應該已經有 Loft 在跑`), { code: 'EADDRINUSE' }) : e);
        });
    });
}

module.exports = { start };

// Started directly (npm start): start right away
if (require.main === module) {
    start().catch((e) => {
        console.error(`${e.message} (not starting this one)`);
        process.exit(1);
    });
}
