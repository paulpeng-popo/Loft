// Queue of download done / failed notifications. The desktop app polls it every 2 seconds and shows them natively.
let seq = 0;
const queue = [];

function push({ title, body, kind = 'done' }) {
    queue.push({ id: ++seq, title, body: body || '', kind, at: Date.now() });
    if (queue.length > 50) queue.shift();
}

function since(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0) return { last: seq, items: [] };
    return { last: seq, items: queue.filter((q) => q.id > n) };
}

// The settings page's test button (shown even while the window is in front)
function test() {
    push({ title: 'Loft', body: '這是測試通知，看得到就代表通知正常。', kind: 'test' });
    return { ok: true };
}

module.exports = { push, since, test };
