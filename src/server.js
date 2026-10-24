require('./logfile'); // load first: log rotation, filters connection-timeout noise
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { getSetting, setSetting, downloads } = require('./db');
const fastdl = require('./fastdl');
const tg = require('./tg');
const downloader = require('./downloader');
const browse = require('./browse');

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
app.get('/api/status', wrap(async () => ({ auth: await tg.authStatus(), ...downloader.snapshot() })));

app.get('/api/settings', wrap(() => ({
    api_id: getSetting('api_id', ''),
    has_api_hash: !!getSetting('api_hash'),
    download_root: getSetting('download_root', ''),
    name_template: getSetting('name_template', ''),
    dl_part_workers: getSetting('dl_part_workers', '4'),
    dl_file_workers: getSetting('dl_file_workers', '2'),
    dl_speed_limit: getSetting('dl_speed_limit', '0'),
    media_types: downloader.MEDIA_TYPES,
})));

app.put('/api/settings', wrap(async (req) => {
    const b = req.body;
    if (b.dl_part_workers !== undefined) setSetting('dl_part_workers', Math.min(8, Math.max(1, Number(b.dl_part_workers) || 4)));
    if (b.dl_file_workers !== undefined) setSetting('dl_file_workers', Math.min(5, Math.max(1, Number(b.dl_file_workers) || 2)));
    if (b.dl_speed_limit !== undefined) setSetting('dl_speed_limit', Math.min(1000, Math.max(0, Number(b.dl_speed_limit) || 0)));
    if (b.name_template !== undefined) setSetting('name_template', String(b.name_template).trim());
    if (b.download_root !== undefined) setSetting('download_root', String(b.download_root).trim());
    const credsChanged = (b.api_id !== undefined && String(b.api_id) !== getSetting('api_id', '')) || !!b.api_hash;
    if (b.api_id !== undefined) setSetting('api_id', String(b.api_id).trim());
    if (b.api_hash) setSetting('api_hash', String(b.api_hash).trim());
    if (credsChanged) await tg.resetClient();
    downloader.log(credsChanged ? '設定已更新（API 憑證變更，重新連線）' : '設定已更新');
}));

// Open the Windows folder picker
app.post('/api/pick-folder', wrap(() => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
        reject(new Error('這個系統只能直接貼上路徑'));
        return;
    }
    const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = "Minimized" }',
        '$owner.Show(); $owner.Hide()',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "選擇資料夾"',
        'if ($d.ShowDialog($owner) -eq "OK") { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps],
        { windowsHide: false, encoding: 'utf8', timeout: 10 * 60 * 1000 },
        (err, stdout) => (err ? reject(new Error('開不了選擇資料夾的視窗，請直接貼上路徑')) : resolve({ path: String(stdout || '').trim() })));
})));

// ---- Login ----
app.post('/api/auth/send-code', wrap((req) => tg.sendCode(String(req.body.phone || '').trim())));
app.post('/api/auth/sign-in', wrap((req) => tg.signIn(req.body.code)));
app.post('/api/auth/password', wrap((req) => tg.signInPassword(String(req.body.password || ''))));
app.post('/api/auth/logout', wrap(() => tg.logout()));

// ---- Chat list ----
app.get('/api/dialogs', wrap(async (req) => {
    const list = await tg.listDialogs(req.query.refresh === '1');
    return list.filter((d) => !d.migrated);
}));
app.get('/api/folders', wrap(() => browse.folders()));
app.post('/api/resolve', wrap(async (req) => {
    const { key, title } = await tg.resolveChat(req.body.chat);
    return { id: key, title };
}));

// ---- Media wall ----
function sniffImage(file) {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    return 'image/jpeg';
}

// Image responses: cached in the browser for a week; 404 when there is no image
const sendImage = (getFile) => (req, res) => {
    getFile(req)
        .then((file) => {
            if (!file) return res.status(404).end();
            res.set('Cache-Control', 'private, max-age=604800');
            res.type(sniffImage(file)).sendFile(file);
        })
        .catch((e) => res.status(400).json({ error: e.errorMessage || e.message }));
};

const bool = (v) => v === '1' || v === 'true' || v === true;
app.get('/api/chat/:chat/avatar', sendImage((req) => browse.avatar(req.params.chat)));
app.get('/api/chat/:chat/media', wrap((req) => browse.media(req.params.chat, {
    ...req.query, notDownloaded: bool(req.query.notDownloaded),
})));
// After downloads, update the media wall's "downloaded / duplicate" marks: items = [{ id, key }]
app.post('/api/chat/:chat/status', wrap((req) => {
    const out = {};
    for (const it of (req.body.items || []).slice(0, 500)) {
        const own = downloads.byMessage(req.params.chat, it.id);
        if (own) out[it.id] = { status: 'done', path: own.path };
        else {
            const same = it.key && downloads.byKey(it.key);
            if (same) out[it.id] = { status: 'dup', dupOf: { chat: same.chat_title || same.chat_id, path: same.path, why: '同一個檔案' } };
        }
    }
    return out;
}));
app.get('/api/chat/:chat/topics', wrap((req) => browse.topics(req.params.chat)));
app.get('/api/chat/:chat/thumb/:msg', sendImage((req) => browse.thumb(req.params.chat, req.params.msg, req.query.s === 'small' ? 'small' : 'large')));
app.get('/api/chat/:chat/file/:msg', (req, res) => {
    browse.original(req.params.chat, req.params.msg)
        .then(({ file, name }) => {
            if (req.query.save === '1') return res.download(file, name);
            res.sendFile(file);
        })
        .catch((e) => res.status(400).json({ error: e.errorMessage || e.message }));
});
// Streaming: only fetch the range the browser asks for, without waiting for the whole file (1MB per response)
const STREAM_CHUNK = 1024 * 1024;
app.get('/api/chat/:chat/stream/:msg', async (req, res) => {
    try {
        const { msg } = await browse.getMessage(req.params.chat, req.params.msg);
        const info = fastdl.documentLocation(msg);
        if (!info) return res.redirect(`/api/chat/${encodeURIComponent(req.params.chat)}/file/${req.params.msg}`);
        const size = info.size;
        const type = msg.document.mimeType || 'application/octet-stream';
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (!m) {
            res.status(200).set({ 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
            for (let pos = 0; pos < size && !res.destroyed; pos += STREAM_CHUNK) {
                const buf = await fastdl.readRange(msg, pos, Math.min(size, pos + STREAM_CHUNK) - 1);
                if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
            }
            return res.end();
        }
        const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
        end = Math.min(end, size - 1, start + STREAM_CHUNK - 1);
        if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end();
        const buf = await fastdl.readRange(msg, start, end);
        res.status(206).set({
            'Content-Type': type,
            'Content-Length': buf.length,
            'Content-Range': `bytes ${start}-${start + buf.length - 1}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
        }).end(buf);
    } catch (e) {
        if (!res.headersSent) res.status(400).json({ error: e.errorMessage || e.message });
        else res.destroy();
    }
});

// ---- Downloads ----
// Selected on the media wall (jumps the queue); force = download anyway, skips duplicate checks
app.post('/api/download', wrap((req) => ({
    queued: downloader.enqueueBatch((req.body.items || []).map((x) => ({ chat: String(x.chat), id: Number(x.id) })),
        req.body.label || '下載選取的媒體', { force: !!req.body.force }),
})));

app.get('/api/cache', wrap(() => browse.cacheSize()));
app.delete('/api/cache', wrap(() => {
    browse.clearCache(['thumb', 'file', 'avatar']);
    downloader.log('已清除快取');
}));

app.post('/api/stop', wrap(() => downloader.stop(true)));

/**
 * Starts the web server, and only connects to Telegram once that succeeds. Returns { url }.
 * Port in use means a Loft is already running: fail right away, never connect to Telegram again with the same session (two connections at once can invalidate it)
 */
function start() {
    return new Promise((resolve, reject) => {
        const httpServer = app.listen(PORT, '127.0.0.1', () => {
            const url = `http://127.0.0.1:${PORT}`;
            downloader.log(`Web 介面：${url}`);
            // If there is a login, connect right away
            tg.authStatus().then((s) => {
                downloader.log(s.authorized ? `已登入：${s.user.name}` : '尚未登入 Telegram');
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
