// Call log: the last 300 calls for the panel, and every call appended to calls.jsonl.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export function createLog(logFile) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const rows = [];

  function record(entry) {
    rows.push(entry);
    if (rows.length > 300) rows.shift();
    try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch { /* log file busy or full */ }
    events.emit('log', entry);
  }

  return { events, record, list: () => [...rows] };
}
