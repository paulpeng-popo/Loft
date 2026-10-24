// Server log: written to server.log in the data folder, rotated past 5MB keeping the last 3 old files (server.log.1 newest, .3 oldest), about 20MB at most.
// Also filters out the connection-timeout noise the Telegram library prints itself (it reconnects on its own, nothing breaks).
// Must load first: the first require in server.js.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const DIR = process.env.LOFT_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'server.log');
const MAX = 5 * 1024 * 1024;
const KEEP = 3;

fs.mkdirSync(DIR, { recursive: true });
let size = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
let dropped = 0;

function rotate() {
    try {
        for (let i = KEEP - 1; i >= 1; i--) {
            const from = `${FILE}.${i}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${FILE}.${i + 1}`);
        }
        fs.renameSync(FILE, `${FILE}.1`);
        size = 0;
    } catch {
        // File is held open by another program and can't be renamed: try again next time
        size = MAX - 64 * 1024;
    }
}

const rawOut = process.stdout.write.bind(process.stdout);

function write(line) {
    // Lines from the app's own logger (log.js) already carry a timestamp
    const stamp = new Date().toLocaleString('sv-SE', { hour12: false });
    const text = /^\[\d{4}-\d{2}-\d{2}/.test(line) ? `${line}\n` : `[${stamp}] ${line}\n`;
    try {
        fs.appendFileSync(FILE, text);
        size += Buffer.byteLength(text);
        if (size > MAX) rotate();
    } catch {
        // Another process redirected our output into server.log and holds the file: keep writing to the original output, it ends up there anyway
        try {
            rawOut(text);
        } catch {
            // If nothing can be written, give up: logging must never take the server down
        }
    }
}

// gramjs update-loop timeouts and reconnect messages: only counted, summarized once an hour
const NOISE = /(^|\s)(Error: )?TIMEOUT\b|Disconnecting from|Connection closed while receiving|Not connected|Reconnecting|Started reconnecting/;
const isNoise = (text) => NOISE.test(text) && !/\[(GET|POST|PUT|DELETE) /.test(text);
setInterval(() => {
    if (dropped) write(`(Left out ${dropped} Telegram timeout / reconnect messages in the past hour; it reconnects on its own)`);
    dropped = 0;
}, 60 * 60 * 1000).unref();

const tty = process.stdout.isTTY; // Running in a terminal: also print to the screen
for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
        const text = util.format(...args);
        if (isNoise(text)) {
            dropped++;
            return;
        }
        write(level === 'error' || level === 'warn' ? `${level.toUpperCase()} ${text}` : text);
        if (tty) orig(...args);
    };
}

// A real crash: log it and exit, and let the outer process restart (the desktop app relaunches itself)
process.on('uncaughtException', (e) => {
    write(`Unexpected error, the server exits: ${e && e.stack ? e.stack : e}`);
    if (process.versions.electron && process.type === 'browser') {
        const { app } = require('electron');
        app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat('--hidden') });
        app.exit(1);
        return;
    }
    process.exit(1);
});
process.on('unhandledRejection', (e) => {
    const text = e && e.stack ? e.stack : String(e);
    if (isNoise(text)) {
        dropped++;
        return;
    }
    write(`Unhandled error: ${text}`);
});

module.exports = { FILE };
