const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `sentinel_${new Date().toISOString().slice(0, 10)}.log`);

function timestamp() {
  return new Date().toISOString();
}

function write(level, msg, data) {
  const line = `[${timestamp()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

module.exports = {
  info:  (msg, data) => write('INFO',  msg, data),
  warn:  (msg, data) => write('WARN',  msg, data),
  error: (msg, data) => write('ERROR', msg, data),
  alert: (msg, data) => write('ALERT', msg, data),
};
