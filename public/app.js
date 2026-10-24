const $ = (s) => document.querySelector(s);
const TYPE_LABELS = {
    photo: '圖片', video: '影片', gif: 'GIF', document: '檔案', image: '圖檔',
    audio: '音樂', voice: '語音', video_note: '圓形影片',
};
const CHAT_TYPES = { channel: '頻道', group: '群組', user: '私訊' };

let settings = { media_types: ['photo', 'video', 'gif', 'document', 'audio', 'voice', 'video_note'] };

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { fromServer: true });
    return data;
}

function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const fmtSize = (n) => {
    if (!n) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
// A time that fits on one line: within the same year show only month/day hour:minute
function shortStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    const md = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

const guard = (fn) => async (...args) => {
    try {
        await fn(...args);
    } catch (e) {
        if (!e.fromServer) console.error(e);
        toast(`錯誤：${e.message}`);
    }
};

// ---- Prompt dialogs (not the native confirm / prompt, which the built-in browser blocks) ----
function ask(title, html, buttons) {
    return new Promise((resolve) => {
        const d = $('#ask-dialog');
        $('#ask-title').textContent = title;
        $('#ask-body').innerHTML = html;
        $('#ask-buttons').innerHTML = '<span class="spacer"></span>'
            + buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('');
        const onClick = (e) => {
            const b = e.target.closest('button[data-i]');
            if (b) done(buttons[Number(b.dataset.i)].value);
        };
        const done = (v) => {
            $('#ask-buttons').removeEventListener('click', onClick);
            d.removeEventListener('close', onClose);
            if (d.open) d.close();
            resolve(v);
        };
        const onClose = () => done(null);
        $('#ask-buttons').addEventListener('click', onClick);
        d.addEventListener('close', onClose);
        d.showModal();
        const input = $('#ask-input');
        if (input) {
            input.focus();
            input.select();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    done(buttons[buttons.length - 1].value);
                }
            });
        } else {
            const last = $('#ask-buttons').querySelector('button:last-child');
            if (last) last.focus();
        }
    });
}
async function confirmBox(message, { ok = '確定', danger = false, title = '請確認' } = {}) {
    const r = await ask(title, `<p style="white-space:pre-wrap">${esc(message)}</p>`,
        [{ label: '取消', value: false }, { label: ok, value: true, cls: danger ? 'danger' : 'primary' }]);
    return r === true;
}

// ---- UI preferences (stored only in this window) ----
const prefs = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('prefs') || '{}'); } catch { /* private mode */ }
    return { fontSize: 16, theme: 'auto', ...saved };
})();
function savePrefs() {
    try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* private mode */ }
}
function applyPrefs() {
    document.documentElement.style.setProperty('--fs', `${prefs.fontSize}px`);
    if (prefs.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = prefs.theme;
    $('#theme-toggle').innerHTML = ico({ auto: 'auto', light: 'sun', dark: 'moon' }[prefs.theme]);
    $('#theme-toggle').title = `深淺色：${{ auto: '跟隨系統', light: '淺色', dark: '深色' }[prefs.theme]}（點一下切換）`;
}
function setFont(delta) {
    prefs.fontSize = Math.min(24, Math.max(12, prefs.fontSize + delta));
    savePrefs();
    applyPrefs();
    toast(`字體大小 ${prefs.fontSize}px`);
}
$('#font-up').addEventListener('click', () => setFont(1));
$('#font-down').addEventListener('click', () => setFont(-1));
$('#theme-toggle').addEventListener('click', () => {
    prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme];
    savePrefs();
    applyPrefs();
});
document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setFont(1); }
    if (e.key === '-') { e.preventDefault(); setFont(-1); }
});

// ---- Tabs ----
let currentTab = null;
function showTab(name) {
    currentTab = name;
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${name}`));
    if (name === 'media' && typeof loadChats === 'function') guard(loadChats)();
    if (name === 'settings') {
        guard(loadCacheSize)();
    }
    try { localStorage.setItem('tab', name); } catch { /* private mode */ }
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Status polling: login state ----
let lastAuth = null;
async function pollStatus() {
    try {
        const s = await api('GET', '/api/status');
        const badge = $('#auth-badge');
        if (s.auth.authorized) {
            badge.textContent = `已登入：${s.auth.user.name}`;
            badge.className = 'badge ok';
        } else {
            badge.textContent = s.auth.error ? '未設定 API' : '未登入';
            badge.className = 'badge bad';
        }
        $('#login-done').classList.toggle('hidden', !s.auth.authorized);
        $('#login-form').classList.toggle('hidden', s.auth.authorized);
        if (s.auth.authorized) $('#login-user').textContent = s.auth.user.name + (s.auth.user.username ? ` (@${s.auth.user.username})` : '');
        if (lastAuth === false && s.auth.authorized && typeof loadChats === 'function') guard(loadChats)(true);
        lastAuth = s.auth.authorized;
    } catch {
        $('#auth-badge').textContent = '伺服器離線';
        $('#auth-badge').className = 'badge bad';
    }
}

// ---- Settings ----
async function loadSettings() {
    settings = await api('GET', '/api/settings');
    $('#set-api-id').value = settings.api_id;
    $('#set-api-hash').placeholder = settings.has_api_hash ? '已儲存（要更換才填）' : '';
}
$('#btn-save-api').addEventListener('click', guard(async () => {
    const credsChanged = $('#set-api-id').value.trim() !== String(settings.api_id || '') || !!$('#set-api-hash').value;
    if (credsChanged && lastAuth && !(await confirmBox('你正在更換 API 憑證。\n儲存後會中斷目前的 Telegram 連線，正在跑的下載會失敗，可能需要重新登入。確定？', { ok: '儲存', danger: true }))) return;
    await api('PUT', '/api/settings', { api_id: $('#set-api-id').value, api_hash: $('#set-api-hash').value || undefined });
    $('#set-api-hash').value = '';
    await loadSettings();
    toast('API 憑證已儲存');
    pollStatus();
}));

function loginStep(name) {
    ['phone', 'code', 'password'].forEach((s) => $(`#step-${s}`).classList.toggle('hidden', s !== name && !(s === 'phone' && name === 'code')));
}
$('#btn-send-code').addEventListener('click', guard(async () => {
    const r = await api('POST', '/api/auth/send-code', { phone: $('#login-phone').value });
    $('#code-hint').textContent = r.viaApp ? '（驗證碼會出現在你其他裝置的 Telegram App 裡）' : '（以簡訊寄送）';
    loginStep('code');
    $('#login-code').focus();
}));
$('#btn-sign-in').addEventListener('click', guard(async () => {
    const r = await api('POST', '/api/auth/sign-in', { code: $('#login-code').value });
    if (r.needPassword) {
        loginStep('password');
        $('#login-password').focus();
        return;
    }
    toast('登入成功');
    loginStep('phone');
    pollStatus();
}));
$('#btn-password').addEventListener('click', guard(async () => {
    await api('POST', '/api/auth/password', { password: $('#login-password').value });
    $('#login-password').value = '';
    toast('登入成功');
    loginStep('phone');
    pollStatus();
}));
$('#btn-logout').addEventListener('click', guard(async () => {
    if (!(await confirmBox('確定登出？', { ok: '登出', danger: true }))) return;
    await api('POST', '/api/auth/logout');
    pollStatus();
}));

async function loadCacheSize() {
    const r = await api('GET', '/api/cache');
    $('#cache-size').textContent = `${fmtSize(r.bytes)}（${r.files} 個檔案）`;
}
$('#btn-clear-cache').addEventListener('click', guard(async () => {
    if (!(await confirmBox('清除縮圖和預覽的快取？已下載的檔案不受影響，之後看媒體牆時會重新抓縮圖。', { ok: '清除', danger: true }))) return;
    await api('DELETE', '/api/cache');
    toast('快取已清除');
    loadCacheSize();
}));

// ---- Startup ----
window.addEventListener('DOMContentLoaded', () => {
    applyIcons();
    applyPrefs();
    guard(loadSettings)();
    let startTab = 'media';
    try { startTab = localStorage.getItem('tab') || 'media'; } catch { /* private mode */ }
    if (!document.querySelector(`nav button[data-tab="${startTab}"]`)) startTab = 'media';
    showTab(startTab);
    pollStatus();
    // Refresh every 5 seconds
    const loop = async () => {
        await pollStatus();
        setTimeout(loop, 5000);
    };
    setTimeout(loop, 1500);
});
