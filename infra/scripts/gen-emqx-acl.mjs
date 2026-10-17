// Renders infra/emqx/acl.conf (gitignored) from acl.conf.tmpl + infra/.env (MQTT_BACKEND_USER).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const env = Object.fromEntries(
  readFileSync(`${dir}/.env`, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const user = env.MQTT_BACKEND_USER;
if (!user || user.length < 20 || !/^[A-Za-z0-9_-]+$/.test(user)) {
  throw new Error('MQTT_BACKEND_USER in infra/.env must be a random token (>= 20 chars, [A-Za-z0-9_-])');
}
writeFileSync(`${dir}/emqx/acl.conf`, readFileSync(`${dir}/emqx/acl.conf.tmpl`, 'utf8').replace('{{MQTT_BACKEND_USER}}', user));
console.log('[infra] emqx/acl.conf rendered');
