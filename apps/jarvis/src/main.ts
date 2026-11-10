// Jarvis process. Milestone 1: config, storage, retention job and a health endpoint on the console port.
// The console (chat, voice, admin pages) comes in milestone 2 on this same server.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { createLlm } from './brain/llm';
import { loadConfig } from './config';
import { openDb, purgeHistory, schemaVersion } from './store/db';

const cfg = loadConfig();
const db = openDb(path.join(cfg.dataDir, 'jarvis.db'));
const llm = createLlm(cfg.llm);

const purge = () => {
  const n = purgeHistory(db, cfg.historyDays);
  if (n) console.log(`[jarvis] history: removed ${n} conversation(s) older than ${cfg.historyDays} days`);
};
purge();
const purgeTimer = setInterval(purge, 6 * 3_600_000);
purgeTimer.unref();

function authorized(req: IncomingMessage) {
  if (!cfg.console.token) return true;
  const given = Buffer.from(String(req.headers['x-jarvis-token'] ?? ''));
  const want = Buffer.from(cfg.console.token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const server = createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'unauthorized' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ status: 'ok', llm: { provider: llm.name, model: llm.model }, api: cfg.apiBase, schema: schemaVersion(db) }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'not_found' }));
});

server.listen(cfg.console.port, cfg.console.host, () => {
  console.log(`[jarvis] http://${cfg.console.host}:${cfg.console.port} · llm ${llm.name}/${llm.model} · api ${cfg.apiBase}`);
});

const stop = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
