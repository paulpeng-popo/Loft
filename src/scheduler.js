const cron = require('node-cron');
const { tasks } = require('./db');
const downloader = require('./downloader');

const jobs = new Map();

function reload() {
    for (const job of jobs.values()) job.stop();
    jobs.clear();
    for (const t of tasks.list()) {
        if (!t.enabled || !t.cron) continue;
        if (!cron.validate(t.cron)) {
            downloader.log(`任務「${t.name}」的排程格式不正確：${t.cron}`);
            continue;
        }
        jobs.set(t.id, cron.schedule(t.cron, () => downloader.enqueue(t.id, 'schedule')));
    }
    downloader.log(`排程已載入 ${jobs.size} 個任務`);
}

module.exports = { reload, validate: (expr) => cron.validate(expr) };
