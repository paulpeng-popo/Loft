// New media: the badges on the chat list (media added since the wall was last opened), live media wall updates, auto-download of new media.
// Tracked only inside Loft; never marks Telegram messages as read.
const { EventEmitter } = require('node:events');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { chatState, tasks } = require('./db');
const tg = require('./tg');
const { log } = require('./log');

const events = new EventEmitter();
events.setMaxListeners(50);

let presence = { chatId: null, visible: false, at: 0 };
const viewing = (chatId) => presence.visible && presence.chatId === chatId && Date.now() - presence.at < 60000;

function setPresence(p) {
    presence = { chatId: p.chatId || null, visible: !!p.visible, at: Date.now() };
}

const counts = () => Object.fromEntries(chatState.all().filter((r) => r.new_count > 0).map((r) => [r.chat_id, r.new_count]));

// Opening the media wall: reset the badge, count from this message on
async function seen(chatId, maxId) {
    let id = Number(maxId) || 0;
    if (!id) {
        const d = (await tg.listDialogs()).find((x) => x.id === String(chatId));
        id = d ? d.lastId : 0;
    }
    chatState.seen(chatId, id);
    events.emit('update', { type: 'count', chatId: String(chatId), count: 0 });
}

// An album arrives one message at a time: wait 3 seconds per chat and auto-download them as one batch
const pendingAuto = new Map(); // chatId -> { ids, timer }
function queueAuto(task, chatId, msgId) {
    let p = pendingAuto.get(chatId);
    if (!p) {
        p = { ids: [], timer: null };
        pendingAuto.set(chatId, p);
    }
    p.ids.push(msgId);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
        pendingAuto.delete(chatId);
        require('./downloader').enqueueBatch(p.ids.map((id) => ({ chat: chatId, id, taskId: task.id })),
            `自動下載：${task.chat_title || chatId}`, { front: false, trigger: 'auto', taskId: task.id });
    }, 3000);
}

function onIncoming({ msg, chatId }) {
    const info = require('./downloader').mediaInfo(msg);
    if (!info || msg.out) return;
    if (require('./hidden').isKeyHidden(info.key)) return;
    chatState.init(chatId, msg.id - 1);
    if (viewing(chatId)) chatState.seen(chatId, msg.id);
    else chatState.add(chatId, 1);
    const st = chatState.get(chatId);
    events.emit('update', { type: 'media', chatId, msgId: msg.id, count: st ? st.new_count : 0 });
    const auto = tasks.autoFor(chatId);
    if (auto && auto.enabled) queueAuto(auto, chatId, msg.id);
}

// How many media (images / videos + files) there are after a given message
async function mediaSince(c, entity, minId) {
    let n = 0;
    for (const F of [Api.InputMessagesFilterPhotoVideo, Api.InputMessagesFilterDocument]) {
        const r = await c.invoke(new Api.messages.Search({
            peer: entity, q: '', filter: new F(), minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 1, maxId: 0, minId, hash: bigInt(0),
        }));
        n += r.count != null ? r.count : (r.messages || []).length;
        await new Promise((res) => setTimeout(res, 300));
    }
    return n;
}

/**
 * After startup: chats seen for the first time start counting from now; chats with new messages while the app was closed get their counts caught up;
 * chats with auto-download on get the media from while the app was closed downloaded.
 */
async function catchUp() {
    const c = await tg.getClient();
    const list = await tg.listDialogs(true);
    const state = new Map(chatState.all().map((r) => [r.chat_id, r]));
    const todo = [];
    for (const d of list) {
        if (d.migrated || d.left) continue;
        const st = state.get(d.id);
        if (!st) chatState.init(d.id, d.lastId);
        else if (d.lastId > st.seen_id) todo.push(d);
    }
    for (const d of todo) {
        try {
            const { entity } = await tg.resolveChat(d.id);
            const st = chatState.get(d.id);
            const n = await mediaSince(c, entity, st.seen_id);
            if (n !== st.new_count) {
                chatState.setCount(d.id, n);
                events.emit('update', { type: 'count', chatId: d.id, count: n });
            }
        } catch {
            // One failed chat doesn't affect the others
        }
    }
    if (todo.length) log(`新媒體：補算 ${todo.length} 個對話`);
    // Auto-download: catch up on media from while the app was closed (the task only fetches what comes after its last position)
    const dl = require('./downloader');
    for (const t of tasks.list().filter((x) => x.auto && x.enabled)) dl.enqueue(t.id, 'auto');
}

/** Toggle auto-download of new media for a chat: on = create a task that only fetches media from now on; off = delete that task */
async function setAuto(chatId, on) {
    const existing = tasks.autoFor(chatId);
    if (!on) {
        if (existing) tasks.remove(existing.id);
        return { auto: false };
    }
    if (existing) {
        if (!existing.enabled) tasks.update(existing.id, { enabled: true });
        return { auto: true };
    }
    const { key, title } = await tg.resolveChat(chatId);
    const d = (await tg.listDialogs()).find((x) => x.id === key);
    const t = tasks.create({
        name: `自動下載：${title}`, chat_id: key, chat_title: title, auto: true, enabled: true, cron: null,
        filters: { incremental: true },
    });
    // From now on: earlier media isn't fetched (use download-all-matches for older ones)
    tasks.setProgress(t.id, d ? d.lastId : 0);
    log(`開啟自動下載新媒體：${title}`);
    return { auto: true };
}

const autoChats = () => tasks.autoChats();

function start() {
    tg.events.on('incoming', (e) => {
        try {
            onIncoming(e);
        } catch {
            // A failed count doesn't affect anything else
        }
    });
}

module.exports = { start, catchUp, seen, counts, setPresence, setAuto, autoChats, events };
