const lines = [];

function log(msg) {
    const line = { time: new Date().toISOString(), msg };
    lines.push(line);
    if (lines.length > 500) lines.splice(0, lines.length - 500);
    console.log(`[${line.time}] ${msg}`);
}

module.exports = { log, lines };
