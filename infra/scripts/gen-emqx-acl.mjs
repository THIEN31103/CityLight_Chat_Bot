// Renders from infra/.env (both outputs gitignored):
//  - infra/emqx/acl.conf from acl.conf.tmpl (MQTT_BACKEND_USER: the backend's secret username)
//  - infra/emqx/device-users.csv: EMQX built-in database bootstrap for the cabinet port 1883
//    (MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD: one account shared by every cabinet for now, S43).
//    EMQX imports it at start for users that do not exist yet; a later password change: emqx-device-account.sh.
// No node on the VPS host: docker run --rm -v /opt/citylight/infra:/app/infra citylight-server:dev node /app/infra/scripts/gen-emqx-acl.mjs
// Trial customer broker (S60, trial-customer-bundle.sh): ENV_FILE=<infra/.env.trial> OUT_DIR=<bundle>/emqx CSV_HASH=1.
//  - MQTT_BACKEND_PASSWORD set: the backend account is added to the CSV (its listener checks passwords there).
//  - CSV_HASH=1: the CSV holds sha256(password + salt) instead of the passwords (EMQX bootstrap_type = hash), so the
//    copy on the customer machine carries no clear password.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const envFile = process.env.ENV_FILE ?? `${dir}/.env`;
const outDir = process.env.OUT_DIR ?? `${dir}/emqx`;
const hashed = process.env.CSV_HASH === '1';
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const user = env.MQTT_BACKEND_USER;
if (!user || user.length < 20 || !/^[A-Za-z0-9_-]+$/.test(user)) {
  throw new Error(`MQTT_BACKEND_USER in ${envFile} must be a random token (>= 20 chars, [A-Za-z0-9_-])`);
}
writeFileSync(`${outDir}/acl.conf`, readFileSync(`${dir}/emqx/acl.conf.tmpl`, 'utf8').replace('{{MQTT_BACKEND_USER}}', user));
console.log('[infra] emqx/acl.conf rendered');

// Device account. Letters / digits only in the password: it goes inside a quoted EC25 AT+QMTCONN argument.
const devUser = env.MQTT_DEVICE_USERNAME ?? '';
const devPass = env.MQTT_DEVICE_PASSWORD ?? '';
const backendPass = env.MQTT_BACKEND_PASSWORD ?? '';
const accounts = [];
if (devUser || devPass) {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(devUser)) throw new Error('MQTT_DEVICE_USERNAME: 3-32 chars [A-Za-z0-9_-]');
  if (!/^[A-Za-z0-9]{16,64}$/.test(devPass)) throw new Error('MQTT_DEVICE_PASSWORD: 16-64 letters / digits (no symbols: AT command quoting)');
  if (devUser === user) throw new Error('MQTT_DEVICE_USERNAME must differ from MQTT_BACKEND_USER');
  accounts.push([devUser, devPass]);
}
if (backendPass) {
  if (!/^[A-Za-z0-9]{20,64}$/.test(backendPass)) throw new Error('MQTT_BACKEND_PASSWORD: 20-64 letters / digits');
  accounts.push([user, backendPass]);
}
// salt_position = suffix, as EMQX_AUTHENTICATION in the compose files
const sha = (pass, salt) => createHash('sha256').update(pass + salt).digest('hex');
let csv = hashed ? 'user_id,password_hash,salt,is_superuser\n' : 'user_id,password,is_superuser\n';
for (const [u, p] of accounts) {
  if (hashed) {
    const salt = randomBytes(16).toString('hex');
    csv += `${u},${sha(p, salt)},${salt},false\n`;
  } else csv += `${u},${p},false\n`;
}
// readable by the EMQX container user (it is mounted read-only); the account itself is hashed inside EMQX
writeFileSync(`${outDir}/device-users.csv`, csv, { mode: 0o644 });
console.log(
  `[infra] emqx/device-users.csv rendered (${devUser ? `account ${devUser}` : 'no device account: port 1883 refuses every cabinet'}` +
    `${backendPass ? ' + backend account' : ''}${hashed ? ', hashed' : ''})`,
);
