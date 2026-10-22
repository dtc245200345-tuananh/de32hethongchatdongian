const fs = require('node:fs');
const crypto = require('node:crypto');
fs.mkdirSync('.secrets', { recursive: true });
for (const name of [
  'app_runtime_password',
  'pgadmin_admin_password',
  'grafana_admin_password',
  'postgres_exporter_password'
]) {
  const file = '.secrets/' + name;
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
console.log('Application, admin, and monitoring secret files ready; existing secrets preserved.');
