const $ = (s) => document.querySelector(s);
const TYPE_LABELS = {
    photo: '圖片', video: '影片', gif: 'GIF', document: '檔案', image: '圖檔',
    audio: '音樂', voice: '語音', video_note: '圓形影片',
};
const CHAT_TYPES = { channel: '頻道', group: '群組', user: '私訊' };

let settings = { media_types: ['photo', 'video', 'gif', 'document', 'audio', 'voice', 'video_note'] };
let taskList = [];

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
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-TW', { hour12: false }) : '-');
// A time that fits on one line: within the same year show only month/day hour:minute
function shortStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    const md = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}
// Small icon buttons in tables (with a tooltip on hover)
const iconBtn = (icon, title, attrs, cls = '') => `<button class="ibtn ${cls}" title="${esc(title)}" ${attrs}>${ico(icon)}</button>`;

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
async function promptBox(message, value = '', title = '請輸入') {
    const r = await ask(title, `<p style="white-space:pre-wrap">${esc(message)}</p><input id="ask-input" value="${esc(value)}">`,
        [{ label: '取消', value: null }, { label: '確定', value: 'ok', cls: 'primary' }]);
    return r === 'ok' ? $('#ask-input').value : null;
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
    if (name === 'tasks') guard(loadTasks)();
    if (name === 'log') pollStatus();
    if (name === 'settings') {
        guard(loadCacheSize)();
        guard(loadHiddenCount)();
    }
    try { localStorage.setItem('tab', name); } catch { /* private mode */ }
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Status polling: login state, download progress bar, log ----
let lastAuth = null;
let pollBusy = false;
let wasRunning = false;
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

        const now = $('#now');
        if (s.running) {
            const r = s.running;
            const cur = r.current;
            let text = `${r.taskName}｜掃描 ${r.scanned}・下載 ${r.downloaded}・略過 ${r.skipped}・失敗 ${r.failed}`;
            if (cur) text += `｜${cur.name} ${fmtSize(cur.received)} / ${fmtSize(cur.size)}`;
            if (s.queue.length) text += `｜排隊：${s.queue.map((q) => q.taskName).join('、')}`;
            now.querySelector('.now-text').textContent = text;
            now.querySelector('.bar div').style.width = cur && cur.size ? `${Math.min(100, (cur.received / cur.size) * 100)}%` : '0';
            now.classList.remove('hidden');
        } else {
            now.classList.add('hidden');
        }
        // Downloads finished: refresh the task list and the media wall's downloaded marks
        if (wasRunning && !s.running) {
            if (currentTab === 'tasks') guard(loadTasks)();
            if (typeof refreshStatuses === 'function') refreshStatuses();
        }
        wasRunning = !!s.running;

        const logEl = $('#log');
        const lastLine = s.log.length ? s.log[s.log.length - 1].time + s.log.length : '';
        if (currentTab === 'log' && logEl.dataset.last !== lastLine) {
            const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 10;
            logEl.textContent = s.log.map((l) => `${fmtTime(l.time)}  ${l.msg}`).join('\n');
            logEl.dataset.last = lastLine;
            if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
        pollBusy = !!s.running || s.queue.length > 0;
    } catch {
        $('#auth-badge').textContent = '伺服器離線';
        $('#auth-badge').className = 'badge bad';
    }
}
$('#btn-stop').addEventListener('click', guard(async () => {
    await api('POST', '/api/stop');
    toast('已要求停止，正在下載的檔案抓完就會停');
}));

// ---- Settings ----
async function loadSettings() {
    settings = await api('GET', '/api/settings');
    $('#set-api-id').value = settings.api_id;
    $('#set-api-hash').placeholder = settings.has_api_hash ? '已儲存（要更換才填）' : '';
    $('#set-root').value = settings.download_root;
    $('#set-template').value = settings.name_template || '';
    $('#set-file-workers').value = settings.dl_file_workers;
    $('#set-part-workers').value = settings.dl_part_workers;
    $('#set-speed').value = settings.dl_speed_limit || '0';
}
$('#btn-save-dl').addEventListener('click', guard(async () => {
    await api('PUT', '/api/settings', {
        download_root: $('#set-root').value,
        name_template: $('#set-template').value,
        dl_file_workers: $('#set-file-workers').value,
        dl_part_workers: $('#set-part-workers').value,
        dl_speed_limit: $('#set-speed').value,
    });
    await loadSettings();
    toast('下載設定已儲存');
}));
$('#btn-pick-root').addEventListener('click', guard(async () => {
    toast('已開啟選擇資料夾的視窗（可能在瀏覽器後面）');
    const p = (await api('POST', '/api/pick-folder')).path;
    if (p) $('#set-root').value = p;
}));
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
    if (!(await confirmBox('確定登出？排程任務在重新登入前都不會執行。', { ok: '登出', danger: true }))) return;
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

// ---- Hidden media ----
async function loadHiddenCount() {
    $('#hidden-count').textContent = (await api('GET', '/api/hidden')).length;
}
async function renderHidden() {
    const list = await api('GET', '/api/hidden');
    $('#hidden-count').textContent = list.length;
    $('#hidden-grid').innerHTML = list.map((h) => `<div class="h-item" title="隱藏於 ${esc(fmtTime(h.at))}">
        <img loading="lazy" src="/api/hidden/${enc(h.key)}/thumb" alt="" onerror="this.remove()">
        <button data-unhide="${esc(h.key)}">取消隱藏</button></div>`).join('') || '<p class="muted">沒有隱藏任何媒體。</p>';
}
$('#btn-hidden').addEventListener('click', guard(async () => {
    $('#hidden-grid').innerHTML = '<p class="muted">讀取中…</p>';
    $('#hidden-dialog').showModal();
    await renderHidden();
}));
$('#hidden-close').addEventListener('click', () => $('#hidden-dialog').close());
$('#hidden-grid').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-unhide]');
    if (!b) return;
    await api('DELETE', `/api/hidden/${enc(b.dataset.unhide)}`);
    toast('已取消隱藏');
    await renderHidden();
    if (typeof reloadWall === 'function') reloadWall();
}));

// ---- Tasks ----
const RUN_STATUS = { ok: '完成', partial: '部分失敗', error: '錯誤', cancelled: '已停止', interrupted: '中斷', running: '執行中' };
const CRON_NAMES = {
    '*/15 * * * *': '每 15 分鐘', '*/30 * * * *': '每 30 分鐘', '0 * * * *': '每小時', '0 */6 * * *': '每 6 小時', '0 3 * * *': '每天 03:00',
};

async function loadTasks() {
    taskList = await api('GET', '/api/tasks');
    $('#task-rows').innerHTML = taskList.map((t) => {
        const [status, ...rest] = (t.last_result || '').split('｜');
        const result = rest.join('｜');
        const sched = t.auto ? '有新媒體就下載' : t.cron ? CRON_NAMES[t.cron] || t.cron : '';
        return `<tr>
            <td><input type="checkbox" data-toggle="${t.id}" ${t.enabled ? 'checked' : ''} title="啟用"></td>
            <td title="${esc(t.name)}"><b>${esc(t.name)}</b>${t.auto ? ' <span class="c-tag">自動</span>' : ''}</td>
            <td title="${esc(t.chat_title || t.chat_id)}" class="muted">${esc(t.chat_title || t.chat_id)}${t.filters.thread ? '（話題）' : ''}</td>
            <td title="${esc(t.cron || '')}">${sched ? esc(sched) : '<span class="muted">手動</span>'}</td>
            <td>${t.filters.incremental === false ? '<span class="muted">每次全掃</span>' : `#${t.last_msg_id}`}</td>
            <td title="${esc(t.last_run_at ? fmtTime(t.last_run_at) : '')}">${t.last_run_at ? shortStamp(t.last_run_at) : '<span class="muted">尚未執行</span>'}</td>
            <td title="${esc(result)}">${status ? `<span class="s-${esc(status)}">${RUN_STATUS[status] || esc(status)}</span> ${esc(result)}` : ''}</td>
            <td class="actions">${iconBtn('play', '立即執行', `data-run="${t.id}"`, 'primary')}${t.auto ? '' : iconBtn('edit', '編輯', `data-edit="${t.id}"`)}${iconBtn('refresh', '重設進度', `data-reset="${t.id}"`)}${iconBtn('trash', t.auto ? '關閉自動下載（刪除這個任務）' : '刪除任務', `data-del="${t.id}"`, 'danger')}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="8" class="muted" style="text-align:center">還沒有任務。到媒體牆按「建立排程任務」，或按上面的「新增排程任務」。</td></tr>';
}

$('#task-rows').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('button, input');
    if (!b) return;
    const id = Number(b.dataset.run || b.dataset.edit || b.dataset.reset || b.dataset.del || b.dataset.toggle);
    if (!id) return;
    const t = taskList.find((x) => x.id === id);
    if (b.dataset.run) {
        const r = await api('POST', `/api/tasks/${id}/run`);
        toast(r.queued ? `「${t.name}」已加入佇列` : `「${t.name}」已經在排隊了`);
        pollStatus();
    } else if (b.dataset.edit) {
        openTask(t);
    } else if (b.dataset.reset) {
        const v = await promptBox(`把「${t.name}」的進度設回第幾則訊息？\n0 = 從第一則重新掃（已下載的照樣會略過）`, '0', '重設進度');
        if (v === null) return;
        await api('POST', `/api/tasks/${id}/reset`, { lastMsgId: Number(v) || 0 });
        loadTasks();
    } else if (b.dataset.del) {
        if (!(await confirmBox(t.auto ? `關閉「${t.chat_title || t.name}」的自動下載新媒體？` : `刪除任務「${t.name}」？已下載的檔案和紀錄不會被刪。`, { ok: t.auto ? '關閉' : '刪除', danger: true }))) return;
        await api('DELETE', `/api/tasks/${id}`);
        loadTasks();
        if (typeof loadChats === 'function') guard(loadChats)();
    } else if (b.dataset.toggle) {
        await api('PUT', `/api/tasks/${id}`, { ...t, enabled: b.checked });
        toast(b.checked ? '已啟用' : '已停用');
        loadTasks();
    }
}));

// ---- Task editor ----
let editing = null;
let pickedChat = null; // { id, title, forum }
$('#f-types').innerHTML = Object.entries(TYPE_LABELS).filter(([k]) => k !== 'image')
    .map(([k, v]) => `<label class="check"><input type="checkbox" value="${k}"> ${v}</label>`).join('');
$('#task-form').addEventListener('submit', (e) => e.preventDefault());

async function setChat(chat, topic = '') {
    pickedChat = chat;
    $('#f-chat-title').value = chat ? chat.title : '';
    if (chat && !$('#f-name').value) $('#f-name').placeholder = chat.title;
    // Forum groups can fetch just one topic
    const wrap = $('#f-topic-wrap');
    wrap.classList.add('hidden');
    $('#f-topic').innerHTML = '<option value="">全部話題</option>';
    if (!chat) return;
    try {
        const topics = await api('GET', `/api/chat/${enc(chat.id)}/topics`);
        if (topics.length) {
            $('#f-topic').innerHTML += topics.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
            wrap.classList.remove('hidden');
        }
    } catch {
        // If topics can't be read, only the whole group can be picked
    }
    $('#f-topic').value = topic ? String(topic) : '';
}

/** Open the task editor. t = existing task; preset = conditions carried over from the media wall (new task) */
function openTask(t, preset = null) {
    editing = t ? t.id : null;
    $('#task-dialog-title').textContent = t ? `編輯任務：${t.name}` : '新增排程任務';
    const f = (t && t.filters) || (preset && preset.filters) || {};
    const chat = t ? { id: t.chat_id, title: t.chat_title || t.chat_id } : preset ? preset.chat : null;
    $('#f-name').value = t ? t.name : '';
    $('#f-name').placeholder = '預設用群組名稱';
    setChat(chat, f.thread);
    const cron = (t && t.cron) || (preset ? '0 * * * *' : '');
    const presetCron = [...$('#f-cron-preset').options].some((o) => o.value === cron) ? cron : 'custom';
    $('#f-cron-preset').value = presetCron;
    $('#f-cron').value = cron;
    $('#f-cron').classList.toggle('hidden', presetCron !== 'custom');
    $('#f-enabled').checked = t ? t.enabled : true;
    const types = f.types && f.types.length ? f.types : ['photo', 'video', 'gif', 'document', 'audio'];
    document.querySelectorAll('#f-types input').forEach((i) => { i.checked = types.includes(i.value); });
    $('#f-min').value = f.minSizeMB || '';
    $('#f-max').value = f.maxSizeMB || '';
    $('#f-from').value = f.dateFrom || '';
    $('#f-to').value = f.dateTo || '';
    $('#f-include').value = f.include || '';
    $('#f-exclude').value = f.exclude || '';
    $('#f-ext').value = f.extensions || '';
    $('#f-max-per-run').value = f.maxPerRun || '';
    $('#f-incremental').checked = f.incremental !== false;
    $('#f-dest').value = (t && t.dest_dir) || '';
    $('#f-template').value = (t && t.name_template) || '';
    $('#preview').classList.add('hidden');
    $('#task-dialog').showModal();
}

function readForm() {
    const preset = $('#f-cron-preset').value;
    return {
        name: $('#f-name').value.trim() || (pickedChat && pickedChat.title) || '',
        chat_id: pickedChat && pickedChat.id,
        chat_title: pickedChat && pickedChat.title,
        enabled: $('#f-enabled').checked,
        cron: preset === 'custom' ? $('#f-cron').value.trim() : preset,
        filters: {
            types: [...document.querySelectorAll('#f-types input:checked')].map((i) => i.value),
            minSizeMB: $('#f-min').value,
            maxSizeMB: $('#f-max').value,
            dateFrom: $('#f-from').value,
            dateTo: $('#f-to').value,
            include: $('#f-include').value,
            exclude: $('#f-exclude').value,
            extensions: $('#f-ext').value,
            thread: $('#f-topic').value,
            maxPerRun: $('#f-max-per-run').value,
            incremental: $('#f-incremental').checked,
        },
        dest_dir: $('#f-dest').value.trim(),
        name_template: $('#f-template').value.trim(),
    };
}

$('#f-cron-preset').addEventListener('change', () => {
    const custom = $('#f-cron-preset').value === 'custom';
    $('#f-cron').classList.toggle('hidden', !custom);
    if (custom) $('#f-cron').focus();
});
$('#btn-new-task').addEventListener('click', () => openTask(null));
$('#btn-cancel-task').addEventListener('click', () => $('#task-dialog').close());
$('#btn-save-task').addEventListener('click', guard(async () => {
    const body = readForm();
    if (editing) await api('PUT', `/api/tasks/${editing}`, body);
    else await api('POST', '/api/tasks', body);
    $('#task-dialog').close();
    toast('任務已儲存');
    if (currentTab === 'tasks') loadTasks();
}));
$('#btn-preview').addEventListener('click', guard(async () => {
    const box = $('#preview');
    box.classList.remove('hidden');
    box.innerHTML = '<p class="muted">讀取中…（從最新往回看，最多 3000 則）</p>';
    const r = await api('POST', '/api/preview', readForm());
    const fresh = r.items.filter((i) => !i.duplicate).length;
    box.innerHTML = `<p>在「${esc(r.chatTitle)}」最近 ${r.scanned} 則訊息中，符合 ${r.items.length} 個，其中 <b>${fresh}</b> 個會下載，${r.items.length - fresh} 個重複或已隱藏（劃線）。</p>
        <table class="list"><colgroup><col style="width:5rem"><col style="width:7.5rem"><col style="width:4.5rem"><col style="width:5.5rem"><col><col></colgroup>
        <thead><tr><th class="r">#</th><th>日期</th><th>類型</th><th class="r">大小</th><th>存成</th><th>略過原因</th></tr></thead><tbody>
        ${r.items.map((i) => `<tr class="${i.duplicate ? 'dup' : ''}">
            <td class="r">${i.msgId}</td><td>${shortStamp(i.date)}</td><td>${TYPE_LABELS[i.type] || i.type}</td><td class="r">${fmtSize(i.size)}</td>
            <td title="${esc(i.fileName)}">${esc(i.fileName)}</td><td title="${esc(i.duplicate || '')}">${esc(i.duplicate || '')}</td></tr>`).join('')}
        </tbody></table>`;
}));

// ---- Pick a group (for tasks) ----
let pickDialogs = [];
function renderPick() {
    const q = $('#chat-q').value.trim().toLowerCase();
    const list = pickDialogs.filter((d) => !q || d.title.toLowerCase().includes(q) || (d.username || '').toLowerCase().includes(q));
    $('#chat-list').innerHTML = list.slice(0, 300).map((d) => `<li data-id="${esc(d.id)}">
        <span>${esc(d.title)} ${d.username ? `<span class="muted">@${esc(d.username)}</span>` : ''}</span>
        <span class="muted">${CHAT_TYPES[d.type] || ''}</span></li>`).join('') || '<li class="muted">沒有符合的對話</li>';
}
$('#btn-pick-chat').addEventListener('click', guard(async () => {
    $('#chat-dialog').showModal();
    $('#chat-q').value = '';
    $('#chat-list').innerHTML = '<li class="muted">讀取中…</li>';
    pickDialogs = await api('GET', '/api/dialogs');
    renderPick();
    $('#chat-q').focus();
}));
$('#btn-chat-close').addEventListener('click', () => $('#chat-dialog').close());
$('#chat-q').addEventListener('input', renderPick);
$('#chat-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const d = pickDialogs.find((x) => x.id === li.dataset.id);
    setChat({ id: d.id, title: d.title });
    $('#chat-dialog').close();
});

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
    // Refresh every 1.5 seconds while a download is running or the log is open, otherwise every 5 seconds
    const loop = async () => {
        await pollStatus();
        setTimeout(loop, pollBusy || currentTab === 'log' ? 1500 : 5000);
    };
    setTimeout(loop, 1500);
});
