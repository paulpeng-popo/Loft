// Loft.exe launcher: the only file packed into it. At runtime it finds the Loft project folder it sits in and runs that project's electron/main.js.
// Why: Task Manager, the taskbar and login items show "Loft" with its icon, and code changes need no repackaging (just restart Loft).
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

// Walk up from Loft.exe: the folder with package.json (name: loft) and electron/main.js is the project
function findProject() {
    let dir = path.dirname(process.execPath);
    for (let i = 0; i < 6; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.name === 'loft' && fs.existsSync(path.join(dir, 'electron', 'main.js'))) return dir;
        } catch {
            // Not at this level, go up
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

const root = findProject();
if (!root) {
    app.whenReady().then(() => {
        dialog.showErrorBox('Loft 無法啟動', 'Loft.exe 要放在 Loft 專案資料夾裡面（例如 Loft\\runtime\\）才能執行。');
        app.quit();
    });
} else {
    // Use the project's data folder, shared with the CLI version and npm run app
    process.env.LOFT_DATA_DIR = process.env.LOFT_DATA_DIR || path.join(root, 'data');
    require(path.join(root, 'electron', 'main.js'));
}
