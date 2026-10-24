// Media (main screen): group list on the left.
const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];

let chats = [];
let folders = [];
let activeFolder = 'all';
let cur = null; // the group currently open

function avatarHtml(chat) {
    const color = AVATAR_COLORS[Math.abs(parseInt(String(chat.id).slice(-4), 10) || 0) % AVATAR_COLORS.length];
    const initials = esc([...(chat.title || '?').trim()].slice(0, 1).join('').toUpperCase());
    const img = chat.hasPhoto !== false ? `<img loading="lazy" decoding="async" src="/api/chat/${enc(chat.id)}/avatar" alt="" onerror="this.remove()">` : '';
    return `<span class="avatar" style="background:${color}">${chat.self ? ico('bookmark') : initials}${chat.self ? '' : img}</span>`;
}

// =====================================================================
// Left: group list
// =====================================================================
async function loadChats(refresh = false) {
    if (!lastAuth && lastAuth !== null) {
        $('#c-list').innerHTML = '<li class="muted" style="justify-content:center">還沒登入。請到「設定」登入 Telegram。</li>';
        return;
    }
    if (!chats.length) $('#c-list').innerHTML = '<li class="muted" style="justify-content:center">讀取中…</li>';
    chats = await api('GET', `/api/dialogs${refresh ? '?refresh=1' : ''}`);
    if (!folders.length || refresh) folders = await api('GET', '/api/folders').catch(() => []);
    renderChats();
}

function inFolder(d, f) {
    if (f.exclude.includes(d.id)) return false;
    if (f.include.includes(d.id)) return true;
    const typeOk = (f.contacts && d.type === 'user' && d.contact && !d.bot)
        || (f.nonContacts && d.type === 'user' && !d.contact && !d.bot)
        || (f.groups && d.type === 'group') || (f.broadcasts && d.type === 'channel') || (f.bots && d.bot);
    if (!typeOk) return false;
    if (f.excludeMuted && d.muted) return false;
    if (f.excludeArchived && d.archived) return false;
    return true;
}

function renderChats() {
    const q = $('#c-q').value.trim().toLowerCase();
    const type = $('#c-type').value;
    const folder = folders.find((f) => String(f.id) === activeFolder);
    $('#c-folders').innerHTML = [{ id: 'all', title: '全部' }, ...folders.map((f) => ({ id: String(f.id), title: `${f.emoticon ? `${f.emoticon} ` : ''}${f.title}` }))]
        .map((f) => `<button data-folder="${esc(f.id)}" class="${f.id === activeFolder ? 'active' : ''}">${esc(f.title)}</button>`).join('');
    $('#c-folders').classList.toggle('hidden', !folders.length);
    const list = chats.filter((d) => {
        if (folder ? !inFolder(d, folder) : d.archived !== $('#c-archived').checked) return false;
        if (type && d.type !== type) return false;
        return !q || d.title.toLowerCase().includes(q) || (d.username || '').toLowerCase().includes(q);
    });
    $('#c-list').innerHTML = list.map((d) => `<li data-id="${esc(d.id)}" class="${cur && cur.id === d.id ? 'active' : ''}">
        ${avatarHtml(d)}
        <div class="c-body">
            <div class="c-title"><span class="t">${esc(d.title)}</span></div>
            <div class="c-sub muted">${esc([CHAT_TYPES[d.type], d.forum ? '論壇' : '', d.username ? `@${d.username}` : ''].filter(Boolean).join('・'))}</div>
        </div>
    </li>`).join('') || '<li class="muted" style="justify-content:center">這裡沒有群組</li>';
}

$('#c-q').addEventListener('input', renderChats);
$('#c-type').addEventListener('change', renderChats);
$('#c-archived').addEventListener('change', renderChats);
$('#c-refresh').addEventListener('click', guard(() => loadChats(true)));
$('#c-folders').addEventListener('click', (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    activeFolder = b.dataset.folder;
    renderChats();
});
