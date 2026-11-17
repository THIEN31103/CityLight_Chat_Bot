// Jarvis process: config, storage, retention job, console server (chat + admin) on the console port.
import path from 'node:path';
import { AuditLog } from './audit/log';
import { createLlm } from './brain/llm';
import { loadConfig } from './config';
import { createConsoleServer } from './console/server';
import { openDb, purgeHistory } from './store/db';
import { getSettings } from './store/settings';
import { createVoice } from './voice/client';

const cfg = loadConfig();
const db = openDb(path.join(cfg.dataDir, 'jarvis.db'));
const audit = new AuditLog(path.join(cfg.dataDir, 'audit'));
const llm = createLlm(cfg.llm, cfg.groq);

const purge = () => {
  const days = getSettings(db, cfg).historyDays;
  const n = purgeHistory(db, days);
  if (n) console.log(`[jarvis] history: removed ${n} conversation(s) older than ${days} days`);
};
purge();
setInterval(purge, 6 * 3_600_000).unref();

const voice = await createVoice(cfg);
const { server, sessions } = createConsoleServer({ cfg, db, llm, audit, voice });
server.listen(cfg.console.port, cfg.console.host, () => {
  console.log(`[jarvis] console http://${cfg.console.host}:${cfg.console.port} · llm ${llm.name}/${llm.model} · stt ${cfg.voice.enabled ? `${cfg.stt.provider}/${cfg.stt.model}` : 'off'} · api ${cfg.apiBase}`);
});

const stop = () => {
  for (const s of sessions.all()) sessions.drop(s);
  server.close();
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
