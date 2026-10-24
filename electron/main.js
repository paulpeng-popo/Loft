// Loft desktop app (Electron): the server runs inside this process and the window loads http://127.0.0.1:8787.
// Provides the tray icon, native notifications, minimize-to-tray on close, and start at login.
// All data (login session, settings, caches, window position, the built-in browser's cache) lives in one folder.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ---- Data folder: must be decided before the app is ready ----
function writable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function pickDataDir() {
    // For testing: point at another folder (e.g. an empty one, so it doesn't share a login session with a running Loft)
    if (process.env.LOFT_DATA_DIR) return process.env.LOFT_DATA_DIR;
    // In development (npm run app): share the project's data folder with the CLI version
    if (!app.isPackaged) return path.join(__dirname, '..', 'data');
    // A macOS .app can't write next to itself (it would break the signature): use the system location
    if (IS_MAC) return path.join(app.getPath('appData'), 'Loft');
    // Linux AppImage: the app itself is a read-only mount, so use a folder next to the AppImage file
    if (process.env.APPIMAGE) {
        const dir = path.join(path.dirname(process.env.APPIMAGE), 'Loft-data');
        if (writable(dir)) return dir;
    }
    // Unpacked Windows / Linux build: the data folder next to the executable (portable: move the folder, take everything)
    const portable = path.join(path.dirname(process.execPath), 'data');
    if (writable(portable)) return portable;
    // Installed somewhere read-only (e.g. Program Files): fall back to the user's app data folder
    return path.join(app.getPath('appData'), 'Loft');
}

const DATA_DIR = pickDataDir();
const CHROMIUM_DIR = path.join(DATA_DIR, 'chromium');
fs.mkdirSync(CHROMIUM_DIR, { recursive: true });
process.env.LOFT_DATA_DIR = DATA_DIR;
// Redirect the built-in browser's (Chromium) cache, cookies and crash dumps here instead of scattering them in AppData
app.setPath('userData', CHROMIUM_DIR);
app.setPath('sessionData', CHROMIUM_DIR);
app.setPath('crashDumps', path.join(CHROMIUM_DIR, 'Crashpad'));
// Windows shows this ID as the app name in notifications (true for any app without a registered name), so call it Loft
if (IS_WIN) app.setAppUserModelId('Loft');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

const startHidden = process.argv.includes('--hidden'); // started at login: tray only, no window

// Single instance: opening it again brings the existing window to the front
// (two processes must never connect to Telegram with the same session)
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    main();
}

function main() {
    let server;
    let notify;
    let win = null;
    let tray = null;
    let origin = '';
    let quitting = false;

    // ---- Window position ----
    const WIN_FILE = path.join(DATA_DIR, 'window.json');
    const loadBounds = () => {
        try {
            return JSON.parse(fs.readFileSync(WIN_FILE, 'utf8'));
        } catch {
            return { width: 1360, height: 880 };
        }
    };
    const saveBounds = () => {
        if (!win || win.isDestroyed()) return;
        const b = { ...win.getNormalBounds(), maximized: win.isMaximized() };
        try {
            fs.writeFileSync(WIN_FILE, `${JSON.stringify(b, null, 4)}\n`);
        } catch {
            // Not fatal if it can't be written
        }
    };

    // ---- Other small bits of state to remember (e.g. whether a hint was already shown) ----
    const STATE_FILE = path.join(DATA_DIR, 'state.json');
    const loadState = () => {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch {
            return {};
        }
    };
    const saveState = (patch) => {
        try {
            fs.writeFileSync(STATE_FILE, `${JSON.stringify({ ...loadState(), ...patch }, null, 4)}\n`);
        } catch {
            // Not fatal if it can't be written
        }
    };

    const isApp = (url) => url === origin || url.startsWith(`${origin}/`);
    const openOutside = (url) => {
        if (/^(https?|tg|mailto|tel):/i.test(url)) shell.openExternal(url);
    };

    function guard(w) {
        // New windows: Loft's own pages open as new app windows; any other URL goes to the system browser
        w.webContents.setWindowOpenHandler(({ url }) => {
            if (isApp(url)) return { action: 'allow', overrideBrowserWindowOptions: windowOptions() };
            openOutside(url);
            return { action: 'deny' };
        });
        // App windows can't be navigated to outside sites
        w.webContents.on('will-navigate', (e, url) => {
            if (!isApp(url)) {
                e.preventDefault();
                openOutside(url);
            }
        });
        // F12 / Ctrl+Shift+I: developer tools; Ctrl+R / F5: reload
        w.webContents.on('before-input-event', (e, input) => {
            if (input.type !== 'keyDown') return;
            const key = input.key.toLowerCase();
            const mod = input.control || input.meta;
            if (key === 'f12' || (mod && input.shift && key === 'i')) w.webContents.toggleDevTools();
            else if (key === 'f5' || (mod && key === 'r')) w.webContents.reload();
        });
        w.webContents.on('did-create-window', (child) => guard(child));
    }

    function windowOptions() {
        return {
            backgroundColor: '#0f1216',
            autoHideMenuBar: true,
            icon: ICON,
            title: 'Loft',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false, // keep the media wall live while hidden in the tray
            },
        };
    }

    // ---- Notifications: a tray balloon on Windows (needs no Start menu shortcut or registry entry), native elsewhere ----
    let notifyIcon = null;
    function showNotice(title, body, onClick) {
        if (!notifyIcon) notifyIcon = nativeImage.createFromPath(ICON).resize({ width: 64, height: 64 });
        if (IS_WIN) {
            if (!tray) return;
            balloonClick = onClick || null;
            tray.displayBalloon({ title, content: body, icon: notifyIcon, iconType: 'custom', respectQuietTime: true });
            return;
        }
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body, icon: notifyIcon, silent: false });
        n.on('click', () => (onClick ? onClick() : showWindow()));
        n.show();
    }

    function createWindow(show) {
        const b = loadBounds();
        win = new BrowserWindow({ ...windowOptions(), x: b.x, y: b.y, width: b.width || 1360, height: b.height || 880, show: false });
        if (b.maximized) win.maximize();
        guard(win);
        if (show) win.once('ready-to-show', () => win.show());
        // Closing the window doesn't quit, it goes to the tray (like Telegram); quit from the tray menu
        win.on('close', (e) => {
            saveBounds();
            if (quitting) return;
            e.preventDefault();
            win.hide();
            // Show the "still running" hint only the first time; remembered in the data folder
            if (!loadState().trayHintShown && tray) {
                saveState({ trayHintShown: true });
                showNotice('Loft 還在背景執行', '排程和自動下載照樣會跑。要完全結束請在系統列圖示的選單按「結束」。', () => showWindow());
            }
        });
        win.on('closed', () => {
            win = null;
        });
        win.loadURL(origin);
    }

    function showWindow() {
        if (!win) createWindow(true);
        else {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    }

    // ---- Start at login (Windows and macOS; Electron doesn't support it on Linux) ----
    const AUTO_START_SUPPORTED = IS_WIN || IS_MAC;
    const loginArgs = () => (app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']);
    // The login item is always named "Loft": readable in Task Manager, and unchecking removes that same entry
    const LOGIN = () => ({ path: process.execPath, args: loginArgs(), name: 'Loft' });
    // On Windows, openAtLogin can't be trusted: Electron drops --hidden when reading the args back, so the
    // comparison always fails. Match on name + executable path instead
    const autoStart = () => {
        if (!AUTO_START_SUPPORTED) return false;
        const s = app.getLoginItemSettings(LOGIN());
        if (!IS_WIN) return s.openAtLogin;
        return (s.launchItems || []).some((i) => i.name === 'Loft' && i.enabled !== false
            && path.resolve(i.path).toLowerCase() === path.resolve(process.execPath).toLowerCase());
    };
    const setAutoStart = (on) => {
        if (AUTO_START_SUPPORTED) app.setLoginItemSettings({ ...LOGIN(), openAtLogin: on });
    };

    // ---- Tray ----
    let balloonClick = null;
    function buildTray() {
        // macOS menu bar icons are smaller
        const size = IS_MAC ? 18 : 32;
        tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
        tray.setToolTip('Loft');
        const menu = () => Menu.buildFromTemplate([
            { label: '開啟 Loft', click: () => showWindow() },
            { type: 'separator' },
            ...(AUTO_START_SUPPORTED
                ? [{ label: '開機自動執行', type: 'checkbox', checked: autoStart(), click: (m) => setAutoStart(m.checked) }]
                : []),
            { label: '開啟資料夾', click: () => shell.openPath(DATA_DIR) },
            { label: '重新啟動', click: () => { quitting = true; app.relaunch(); app.quit(); } },
            { type: 'separator' },
            { label: '結束', click: () => { quitting = true; app.quit(); } },
        ]);
        tray.setContextMenu(menu());
        tray.on('right-click', () => tray.setContextMenu(menu())); // refresh the checkbox when the menu reopens
        if (!IS_MAC) {
            // On macOS a click opens the menu; elsewhere it opens the window
            tray.on('click', () => showWindow());
            tray.on('double-click', () => showWindow());
        }
        tray.on('balloon-click', () => {
            const fn = balloonClick;
            balloonClick = null;
            (fn || showWindow)();
        });
    }

    // ---- Download notifications: poll the server's notification queue every 2 seconds ----
    let lastNotify = -1;
    function pollNotifications() {
        try {
            const r = notify.since(lastNotify);
            lastNotify = r.last;
            if (!r.items.length) return;
            // Skip while the window is in front (the progress bar already shows it), except for the test notification
            const front = win && !win.isDestroyed() && win.isVisible() && win.isFocused();
            if (front && !r.items.some((i) => i.kind === 'test')) return;
            // Only one can be shown at a time: show the latest and mention how many others there were
            const it = r.items[r.items.length - 1];
            let body = it.body || '';
            if (r.items.length > 1) body += `\n（另外還有 ${r.items.length - 1} 則下載通知）`;
            showNotice(it.title || 'Loft', body || '下載完成');
        } catch {
            // A failed notification doesn't affect anything else
        }
    }

    // ---- Desktop features exposed to the page ----
    ipcMain.handle('pick-folder', async (e, title) => {
        const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, {
            title: title || '選擇資料夾', properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('show-in-folder', (e, p) => {
        if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    });
    ipcMain.handle('open-data', () => shell.openPath(DATA_DIR));
    ipcMain.handle('app-info', () => ({
        version: app.getVersion(), dataDir: DATA_DIR, platform: process.platform,
        autoStartSupported: AUTO_START_SUPPORTED, autoStart: autoStart(),
    }));
    ipcMain.handle('set-auto-start', (e, on) => {
        setAutoStart(!!on);
        return autoStart();
    });

    app.on('second-instance', () => showWindow());
    // macOS: clicking the Dock icon brings the window back
    app.on('activate', () => showWindow());

    app.on('before-quit', () => {
        quitting = true;
    });

    app.whenReady().then(async () => {
        // macOS needs an app menu, or Cmd+C / Cmd+V / Cmd+Q stop working
        if (IS_MAC) {
            Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
        } else {
            Menu.setApplicationMenu(null);
        }
        try {
            // The real location of the system Downloads folder (may have been moved to another drive or OneDrive)
            try {
                process.env.LOFT_DOWNLOADS_DIR = app.getPath('downloads');
            } catch { /* if unavailable, use Downloads in the home folder */ }
            // Load the server only after the environment variables are set
            server = require('../src/server');
            notify = require('../src/notify');
            ({ url: origin } = await server.start());
        } catch (e) {
            dialog.showErrorBox('Loft 無法啟動', e.code === 'EADDRINUSE'
                ? '已經有另一個 Loft 在執行（可能是命令列的 npm start）。\n請先結束它再開啟桌面版。'
                : String(e && e.stack ? e.stack : e));
            quitting = true;
            app.quit();
            return;
        }
        buildTray();
        createWindow(!startHidden);
        lastNotify = notify.since(-1).last; // don't replay notifications from before startup
        setInterval(pollNotifications, 2000);
    });

    // Don't quit when every window is closed (Loft stays in the tray); only the tray menu's quit item really quits
    app.on('window-all-closed', () => {});
}
