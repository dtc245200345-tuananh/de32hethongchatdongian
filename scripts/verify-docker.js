// Explicit integration check: restarts only the app and retains all test data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { io } = require('socket.io-client');
const base = process.env.TEST_BASE_URL || 'http://localhost:8080';
const docker = args => execFileSync('docker', ['compose', ...args], { encoding: 'utf8' });
async function request(path, body, cookie) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {})
  }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, path + ': ' + response.status);
  return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const emit = (socket, name, data) => socket.timeout(5000).emitWithAck(name, data);
async function connect(cookie) {
  const socket = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
  });
  return socket;
}
async function main() {
  const runtimeRole=docker(['exec','-T','postgres','psql','-U','chatuser','-d','chatdb','-Atc',
    "SELECT rolcanlogin||'|'||rolsuper||'|'||rolcreatedb||'|'||rolcreaterole||'|'||rolreplication||'|'||rolbypassrls FROM pg_roles WHERE rolname='chat_runtime'"]);
  assert.equal(runtimeRole.trim(),'true|false|false|false|false|false','Application role must be login-only and non-privileged');
  const bootstrapRole=docker(['exec','-T','postgres','psql','-U','chatuser','-d','chatdb','-Atc',
    "SELECT rolsuper FROM pg_roles WHERE rolname='chatuser'"]);
  assert.equal(bootstrapRole.trim(),'t','Bootstrap role must remain unchanged');
  console.log('PASS: chat_runtime is non-superuser; bootstrap role unchanged');
  const suffix=Date.now().toString(36), schema='review_legacy_'+suffix;
  const migration=fs.readFileSync('init.sql','utf8');
  const sql=`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
    CREATE TABLE messages (id BIGSERIAL PRIMARY KEY,room VARCHAR(100) NOT NULL,message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO messages(room,message) VALUES ('legacy-room','Preserve this historical message');
    ${migration}\n${migration}
    DO $$ BEGIN
      IF (SELECT count(*) FROM messages WHERE message='Preserve this historical message') <> 1 THEN RAISE EXCEPTION 'History changed'; END IF;
      IF NOT EXISTS (SELECT 1 FROM rooms WHERE name='legacy-room' AND owner_id IS NULL) THEN RAISE EXCEPTION 'Legacy room missing'; END IF;
      INSERT INTO users(username,password_hash) VALUES ('migration_user','test-only');
      INSERT INTO messages(room,message,user_id,username) VALUES ('legacy-room','New schema works',1,'migration_user');
    END $$;`;
  execFileSync('docker',['compose','exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','chatuser','-d','chatdb'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});
  console.log('PASS: old schema migration twice, old message preserved, new columns writable; retained schema '+schema);
  const username='restart_'+suffix,password='Restart-test-password',room='restart-'+suffix;
  const user=await request('/api/register',{username,password});
  let socket=await connect(user.cookie);
  try {
    assert.equal((await emit(socket,'join-room',room)).ok,true);
    const saved=await emit(socket,'chat-message',{room,message:'Persistent after app restart'});
    assert.equal(saved.ok,true); socket.disconnect();
    docker(['restart','app']);
    let ready=false;
    for(let n=0;n<40;n++) {
      try { const response=await fetch(base+'/health'); if(response.ok) {ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(ready,'App ready after restart');
    assert.equal((await request('/api/me',undefined,user.cookie)).data.user.username,username);
    socket=await connect(user.cookie);
    const history=new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>reject(new Error('History timeout')),5000);
      socket.once('chat-history',rows=>{clearTimeout(timer);resolve(rows);});
    });
    assert.equal((await emit(socket,'join-room',room)).ok,true);
    assert.ok((await history).some(row=>row.id===saved.message.id));
    console.log('PASS: app restart preserves session, room ownership and persisted history');
    execFileSync('docker',['compose','exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','chatuser','-d','chatdb'],{
      input: `UPDATE session SET expire=NOW()-INTERVAL '1 second' WHERE sess->'user'->>'username'='${username}';`, encoding:'utf8',stdio:['pipe','pipe','pipe']
    });
    const disconnected=new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>reject(new Error('Expired session still connected')),5000);
      socket.once('disconnect',()=>{clearTimeout(timer);resolve();});
    });
    socket.emit('chat-message',{room,message:'Must not persist after expiry'});
    await disconnected;
    assert.equal((await request('/api/me',undefined,user.cookie)).data.user,null);
    const count=docker(['exec','-T','postgres','psql','-U','chatuser','-d','chatdb','-Atc',`SELECT count(*) FROM messages WHERE room='${room}' AND message='Must not persist after expiry'`]);
    assert.equal(count.trim(),'0');
    console.log('PASS: expired session disconnects socket and cannot write messages');
    await request('/api/logout',{},user.cookie);
  } finally { socket.disconnect(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
