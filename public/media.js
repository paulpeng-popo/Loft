// Media (main screen): group list on the left, media wall on the right.
const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];

let chats = [];
let folders = [];
let activeFolder = 'all';
let cur = null; // the group currently open
let items = []; // items loaded on the media wall so far
let cursor = 0; // where the next page continues from (null = no more)
let loading = false;
let wallSeq = 0; // bumped whenever the group or filters change; stale responses are dropped

function avatarHtml(chat) {
    const color = AVATAR_COLORS[Math.abs(parseInt(String(chat.id).slice(-4), 10) || 0) % AVATAR_COLORS.length];
    const initials = esc([...(chat.title || '?').trim()].slice(0, 1).join('').toUpperCase());
    const img = chat.hasPhoto !== false ? `<img loading="lazy" decoding="async" src="/api/chat/${enc(chat.id)}/avatar" alt="" onerror="this.remove()">` : '';
    return `<span class="avatar" style="background:${color}">${chat.self ? ico('bookmark') : initials}${chat.self ? '' : img}</span>`;
}

const fmtDuration = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

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
$('#c-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const d = chats.find((x) => x.id === li.dataset.id);
    if (d) guard(openChat)(d);
});

// =====================================================================
// Right: media wall
// =====================================================================
async function openChat(d) {
    cur = d;
    document.querySelectorAll('#c-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === d.id));
    $('.browse').classList.add('open');
    $('#m-empty').classList.add('hidden');
    $('#m-chat').classList.remove('hidden');
    $('#m-avatar').outerHTML = avatarHtml(d).replace('class="avatar"', 'id="m-avatar" class="avatar"');
    $('#m-title').textContent = d.title;
    $('#m-sub').textContent = [CHAT_TYPES[d.type], d.username ? `@${d.username}` : '', d.noforwards ? '禁止儲存的頻道（一樣可以下載）' : ''].filter(Boolean).join('・');
    // Forum groups: topic menu
    const topicSel = $('#m-topic');
    topicSel.classList.add('hidden');
    topicSel.innerHTML = '<option value="">全部話題</option>';
    if (d.forum) {
        api('GET', `/api/chat/${enc(d.id)}/topics`).then((topics) => {
            if (cur !== d) return;
            topicSel.innerHTML += topics.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
            topicSel.classList.remove('hidden');
        }).catch(() => {});
    }
    await reloadWall();
}
$('#m-back').addEventListener('click', () => {
    $('.browse').classList.remove('open');
});

function wallParams() {
    return {
        type: $('#m-type').value,
        topic: $('#m-topic').value,
        from: $('#m-from').value,
        to: $('#m-to').value,
        minMB: $('#m-min').value,
        order: $('#m-order').value,
        notDownloaded: $('#m-notdl').checked ? '1' : '',
        q: $('#m-q').value.trim(),
    };
}

async function reloadWall() {
    if (!cur) return;
    wallSeq++;
    items = [];
    cursor = 0;
    $('#m-grid').innerHTML = Array.from({ length: 24 }, () => '<div class="tile skeleton"></div>').join('');
    $('#m-end').textContent = '';
    $('#m-wall').scrollTop = 0;
    await loadMore();
}

async function loadMore() {
    // loading remembers which round is loading; after a group / filter change the old round doesn't block the new one
    if (!cur || loading === wallSeq || cursor === null) return;
    loading = wallSeq;
    const seq = wallSeq;
    const chat = cur;
    $('#m-end').textContent = '載入中…';
    try {
        const params = new URLSearchParams({ ...wallParams(), cursor: cursor || 0, limit: 60 });
        const r = await api('GET', `/api/chat/${enc(chat.id)}/media?${params}`);
        if (seq !== wallSeq) return;
        if (!items.length) $('#m-grid').innerHTML = '';
        const added = r.items.filter((it) => !items.some((x) => x.id === it.id));
        items.push(...added);
        appendTiles(added);
        cursor = r.cursor;
        $('#m-end').textContent = cursor === null ? (items.length ? `共 ${items.length} 個` : '這裡沒有符合條件的媒體') : '';
    } finally {
        if (loading === seq) loading = false;
    }
    // If the first page is too short to fill the screen, fetch another
    if (seq === wallSeq && cursor !== null && $('#m-wall').scrollHeight <= $('#m-wall').clientHeight + 200) loadMore();
}

const dayKey = (iso) => new Date(iso).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });

function tileHtml(it) {
    const flag = it.status === 'done' ? `<span class="flag done" title="已下載：${esc(it.path || '')}">${ico('check')}已下載</span>`
        : it.status === 'dup' || it.status === 'similar' ? `<span class="flag dup" title="${esc(`${it.dupOf ? it.dupOf.why : '重複'}：${it.dupOf ? it.dupOf.path : ''}`)}">重複</span>` : '';
    let info = '';
    if (it.kind === 'video' || it.kind === 'video_note') info = `${ico('play')}${fmtDuration(it.duration)}`;
    else if (it.kind === 'gif') info = 'GIF';
    else if (!['photo'].includes(it.kind)) info = fmtSize(it.size);
    const icon = { audio: 'music', voice: 'mic', document: 'file', image: 'image', video: 'play', video_note: 'play', gif: 'play' }[it.kind] || 'file';
    const body = it.thumb
        ? `<img loading="lazy" decoding="async" src="/api/chat/${enc(it.chat)}/thumb/${it.id}?s=small" alt="" onload="this.classList.add('loaded')" onerror="this.remove()">`
        : `<div class="noimg">${ico(icon)}<span class="fn">${esc(it.name || it.title || TYPE_LABELS[it.kind] || '檔案')}</span></div>`;
    return `<div class="tile${it.status === 'dup' || it.status === 'similar' ? ' is-dup' : ''}" data-id="${it.id}"
        style="${it.blur ? `background-image:url(${it.blur})` : ''}" title="${esc([shortStamp(it.date), it.sender, it.caption].filter(Boolean).join('\n'))}">
        ${body}${flag}${info ? `<span class="info">${info}</span>` : ''}</div>`;
}

// Append to the end of the media wall, grouped by date
function appendTiles(list) {
    const grid = $('#m-grid');
    let lastDay = grid.dataset.lastDay || '';
    let html = '';
    for (const it of list) {
        const day = dayKey(it.date);
        if (day !== lastDay) {
            html += `<div class="wall-day">${esc(day)}</div>`;
            lastDay = day;
        }
        html += tileHtml(it);
    }
    grid.insertAdjacentHTML('beforeend', html);
    grid.dataset.lastDay = lastDay;
}

// Reload as soon as a filter changes
let filterTimer;
for (const id of ['#m-type', '#m-topic', '#m-from', '#m-to', '#m-order', '#m-notdl']) {
    $(id).addEventListener('change', () => guard(reloadWall)());
}
for (const id of ['#m-min', '#m-q']) {
    $(id).addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => guard(reloadWall)(), 500);
    });
}
$('#m-reload').addEventListener('click', () => guard(reloadWall)());

// Near the bottom: load the next page
$('#m-wall').addEventListener('scroll', () => {
    const w = $('#m-wall');
    if (w.scrollTop + w.clientHeight >= w.scrollHeight - 600) guard(loadMore)();
});
