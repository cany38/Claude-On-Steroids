// Approval queue and call log. A write, delete or command waits here for the
// panel; past the timeout it counts as denied.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export function createApprovals({ logFile, timeoutMs = 110_000 }) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const pending = new Map();   // id -> the waiting call and its resolve
  const log = [];              // last 300 calls, shown in the panel

  const publicView = (p) => ({ id: p.id, tool: p.tool, info: p.info, at: p.at, expiresAt: p.at + timeoutMs });

  function record(entry) {
    log.push(entry);
    if (log.length > 300) log.shift();
    try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch { /* log file busy or full */ }
    events.emit('log', entry);
  }

  // Ask the panel; resolves with { approved, reason }.
  function request(tool, args, info) {
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const p = { id, tool, args, info, at: Date.now(), resolve };
      p.timer = setTimeout(() => settle(id, false, 'timed out (nobody approved it in the panel)'), timeoutMs);
      pending.set(id, p);
      events.emit('pending', publicView(p));
    });
  }

  function settle(id, approved, reason) {
    const p = pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ approved, reason });
    events.emit('settled', { id, approved, reason });
    return true;
  }

  return {
    events,
    request,
    approve: (id) => settle(id, true, 'approved in the panel'),
    deny: (id, why) => settle(id, false, why || 'denied in the panel'),
    list: () => [...pending.values()].map(publicView),
    log: () => [...log],
    record,
    // On shutdown deny what still waits, so no client hangs.
    close: () => { for (const id of [...pending.keys()]) settle(id, false, 'the server is shutting down'); },
  };
}
