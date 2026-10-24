const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// The desktop app (Electron) sets the folder via LOFT_DATA_DIR; the CLI version uses the project's data folder
const DATA_DIR = process.env.LOFT_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    chat_title TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    cron TEXT,
    filters TEXT NOT NULL DEFAULT '{}',
    dest_dir TEXT,
    name_template TEXT,
    last_msg_id INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    chat_id TEXT NOT NULL,
    chat_title TEXT,
    msg_id INTEGER NOT NULL,
    file_key TEXT,
    file_name TEXT,
    size INTEGER,
    sha256 TEXT,
    media_type TEXT,
    path TEXT,
    msg_date TEXT,
    downloaded_at TEXT NOT NULL,
    UNIQUE (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_dl_key ON downloads (file_key);
CREATE INDEX IF NOT EXISTS idx_dl_sha ON downloads (sha256);
CREATE TABLE IF NOT EXISTS fingerprints (
    file_key TEXT PRIMARY KEY,
    kind TEXT,
    phash TEXT,
    aspect REAL,
    w INTEGER,
    h INTEGER,
    duration INTEGER,
    size INTEGER,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS failures (
    chat_id TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    chat_title TEXT,
    task_id INTEGER,
    file_name TEXT,
    size INTEGER,
    media_type TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    failed_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, msg_id)
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    trigger TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT,
    scanned INTEGER DEFAULT 0,
    downloaded INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    message TEXT
);
`);

// Tables and settings left over from before the redesign (filter rules, forwarding, folder upload, notifications, inbox): no longer used, drop them
db.exec('DROP TABLE IF EXISTS rules; DROP TABLE IF EXISTS mirrors; DROP TABLE IF EXISTS uploads;');
db.prepare(`DELETE FROM settings WHERE key IN ('notify_enabled', 'notify_preview', 'notify_muted', 'inbox_enabled', 'inbox_tag',
    'inbox_album', 'inbox_last_id')`).run();

// Add missing columns to old databases: auto = task created by the auto-download new media switch
const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (!taskCols.includes('auto')) db.exec('ALTER TABLE tasks ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
// Old columns from before the redesign: duplicate-check settings (now built in), forwarding task settings
for (const col of ['dedupe', 'action', 'target_chat', 'target_title', 'mirror']) {
    if (taskCols.includes(col)) db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
}

const now = () => new Date().toISOString();

function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
}

function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value == null ? null : String(value));
}

function parseTask(row) {
    if (!row) return null;
    return { ...row, enabled: !!row.enabled, auto: !!row.auto, filters: JSON.parse(row.filters || '{}') };
}

const TASK_FIELDS = ['name', 'chat_id', 'chat_title', 'enabled', 'cron', 'filters', 'dest_dir', 'name_template', 'auto'];

function taskValues(t) {
    return {
        name: t.name || t.chat_title || t.chat_id,
        chat_id: String(t.chat_id),
        chat_title: t.chat_title || null,
        enabled: t.enabled === false ? 0 : 1,
        cron: t.cron || null,
        filters: JSON.stringify(t.filters || {}),
        dest_dir: t.dest_dir || null,
        name_template: t.name_template || null,
        auto: t.auto ? 1 : 0,
    };
}

const tasks = {
    list: () => db.prepare('SELECT * FROM tasks ORDER BY id').all().map(parseTask),
    get: (id) => parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)),
    create(t) {
        const v = taskValues(t);
        const r = db.prepare(`INSERT INTO tasks (${TASK_FIELDS.join(', ')}, created_at) VALUES (${TASK_FIELDS.map(() => '?').join(', ')}, ?)`)
            .run(...TASK_FIELDS.map((f) => v[f]), now());
        return tasks.get(Number(r.lastInsertRowid));
    },
    update(id, t) {
        const v = taskValues({ ...tasks.get(id), ...t });
        db.prepare(`UPDATE tasks SET ${TASK_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
            .run(...TASK_FIELDS.map((f) => v[f]), id);
        return tasks.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM tasks WHERE id = ?').run(id),
    setProgress: (id, lastMsgId) => db.prepare('UPDATE tasks SET last_msg_id = ? WHERE id = ?').run(lastMsgId, id),
    setResult: (id, result) => db.prepare('UPDATE tasks SET last_run_at = ?, last_result = ? WHERE id = ?').run(now(), result, id),
};

const downloads = {
    byMessage: (chatId, msgId) => db.prepare('SELECT * FROM downloads WHERE chat_id = ? AND msg_id = ?').get(String(chatId), Number(msgId)),
    byKey: (key) => db.prepare('SELECT * FROM downloads WHERE file_key = ? LIMIT 1').get(key),
    bySha: (sha) => db.prepare('SELECT * FROM downloads WHERE sha256 = ? LIMIT 1').get(sha),
    add(d) {
        const r = db.prepare(`INSERT OR REPLACE INTO downloads
            (task_id, chat_id, chat_title, msg_id, file_key, file_name, size, sha256, media_type, path, msg_date, downloaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(d.task_id, d.chat_id, d.chat_title, d.msg_id, d.file_key, d.file_name, d.size, d.sha256, d.media_type, d.path, d.msg_date, now());
        // Remove from the failure list once it succeeds
        db.prepare('DELETE FROM failures WHERE chat_id = ? AND msg_id = ?').run(d.chat_id, d.msg_id);
        return Number(r.lastInsertRowid);
    },
    search({ q = '', taskId = null, page = 1, pageSize = 50 }) {
        const where = [];
        const args = [];
        if (q) {
            where.push('(file_name LIKE ? OR chat_title LIKE ? OR path LIKE ?)');
            args.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (taskId) {
            where.push('task_id = ?');
            args.push(taskId);
        }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = db.prepare(`SELECT COUNT(*) AS n FROM downloads ${w}`).get(...args).n;
        const rows = db.prepare(`SELECT * FROM downloads ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
            .all(...args, pageSize, (page - 1) * pageSize);
        return { total, rows };
    },
    remove: (id) => db.prepare('DELETE FROM downloads WHERE id = ?').run(id),
};

const runs = {
    start: (taskId, trigger) => Number(db.prepare('INSERT INTO runs (task_id, trigger, started_at, status) VALUES (?, ?, ?, ?)')
        .run(taskId, trigger, now(), 'running').lastInsertRowid),
    finish: (id, s) => db.prepare('UPDATE runs SET finished_at = ?, status = ?, scanned = ?, downloaded = ?, skipped = ?, failed = ?, message = ? WHERE id = ?')
        .run(now(), s.status, s.scanned, s.downloaded, s.skipped, s.failed, s.message || null, id),
    recent: (limit = 50) => db.prepare(`SELECT runs.*, tasks.name AS task_name FROM runs
        LEFT JOIN tasks ON tasks.id = runs.task_id ORDER BY runs.id DESC LIMIT ?`).all(limit),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
    // Clear: keep the one that is running
    clear: () => Number(db.prepare("DELETE FROM runs WHERE status != 'running'").run().changes),
    // Keep only the latest 1000 automatically so the database doesn't keep growing
    prune: () => db.prepare('DELETE FROM runs WHERE id <= (SELECT id FROM runs ORDER BY id DESC LIMIT 1 OFFSET 1000)').run(),
};

const fingerprints = {
    get: (key) => db.prepare('SELECT * FROM fingerprints WHERE file_key = ?').get(key),
    put(fp) {
        db.prepare(`INSERT OR REPLACE INTO fingerprints (file_key, kind, phash, aspect, w, h, duration, size, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(fp.key, fp.kind, fp.phash, fp.aspect, fp.w, fp.h, fp.duration, fp.size, now());
    },
    // Fingerprints of downloaded files (for duplicate checks)
    downloaded: () => db.prepare(`SELECT d.id AS download_id, d.path, d.chat_id, d.chat_title, d.msg_id, f.*
        FROM downloads d JOIN fingerprints f ON f.file_key = d.file_key
        WHERE d.path NOT LIKE '(%'`).all(),
};

// Download failures: one row per message, with the failure count and the last error
const failures = {
    add(f) {
        db.prepare(`INSERT INTO failures (chat_id, msg_id, chat_title, task_id, file_name, size, media_type, error, failed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, msg_id) DO UPDATE SET attempts = attempts + 1, error = excluded.error, failed_at = excluded.failed_at,
                task_id = COALESCE(excluded.task_id, task_id), chat_title = COALESCE(excluded.chat_title, chat_title)`)
            .run(String(f.chat_id), Number(f.msg_id), f.chat_title || null, f.task_id || null, f.file_name || null,
                f.size || null, f.media_type || null, String(f.error || '').slice(0, 300), now());
    },
    list: () => db.prepare('SELECT * FROM failures ORDER BY failed_at DESC LIMIT 1000').all(),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM failures').get().n,
    remove: (chatId, msgId) => db.prepare('DELETE FROM failures WHERE chat_id = ? AND msg_id = ?').run(String(chatId), Number(msgId)),
    clear: () => db.prepare('DELETE FROM failures').run(),
};

// Runs that were still going when the app was last closed
db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());

module.exports = { db, DATA_DIR, getSetting, setSetting, tasks, downloads, runs, fingerprints, failures };
