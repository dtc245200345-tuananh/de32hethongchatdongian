const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const base = process.env.TEST_BASE_URL || 'http://localhost:8080';
async function api(path, body, cookie) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, done); reject(new Error('Timeout: ' + name)); }, 5000);
    function done(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, done);
  });
}
async function connect(cookie, transport = 'websocket') {
  const socket = io(base, { autoConnect: false, reconnection: false, transports: [transport], extraHeaders: cookie ? { Cookie: cookie } : {} });
  const connected = event(socket, 'connect');
  socket.connect();
  try { await connected; return socket; } catch(error) { socket.disconnect(); throw error; }
}
const emit = (socket, name, data) => socket.timeout(5000).emitWithAck(name, data);
test('MVP: accounts, room permissions, realtime, history and session revocation', async t => {
  const sockets=[]; t.after(()=>sockets.forEach(s=>s.disconnect()));
  const suffix=Date.now().toString(36), room='test-'+suffix;
  const username='alice_'+suffix, bob='bob_'+suffix, password='Test-password-123';
  await t.test('health and authentication validation', async()=> {
    assert.equal((await api('/health')).status,200);
    assert.equal((await api('/api/register',{username:'x',password:'short'})).status,400);
    assert.equal((await api('/api/register',{username:'unicode_'+suffix,password:'ệ'.repeat(25)})).status,400);
    assert.equal((await api('/api/rooms/members',{room,username})).status,401);
    const socket=io(base,{autoConnect:false,reconnection:false}); sockets.push(socket);
    const rejected=event(socket,'connect_error');socket.connect();
    assert.equal((await rejected).message,'UNAUTHORIZED');socket.disconnect();
  });
  const a=await api('/api/register',{username,password});
  const b=await api('/api/register',{username:bob,password});
  await t.test('register, duplicate, wrong password, login and session',async()=> {
    assert.equal(a.status,201);assert.equal(b.status,201);
    assert.equal((await api('/api/register',{username,password})).status,409);
    assert.equal((await api('/api/login',{username,password:'incorrect'})).status,401);
    assert.equal((await api('/api/me',undefined,a.cookie)).data.user.username,username);
    const login=await api('/api/login',{username,password});assert.equal(login.status,200);
    assert.notEqual(login.cookie,a.cookie);
    const oldSocket=await connect(login.cookie);sockets.push(oldSocket);
    const disconnected=event(oldSocket,'disconnect');
    const rotated=await api('/api/login',{username,password},login.cookie);
    assert.equal(rotated.status,200);assert.notEqual(rotated.cookie,login.cookie);
    await disconnected;
    assert.equal((await api('/api/me',undefined,login.cookie)).data.user,null);
    await api('/api/logout',{},rotated.cookie);
  });
  const sa=await connect(a.cookie), sa2=await connect(a.cookie, 'polling'), sb=await connect(b.cookie);
  sockets.push(sa,sa2,sb);
  await t.test('private room denies outsider and owner grants membership',async()=> {
    assert.equal((await emit(sa,'join-room',room)).ok,true);
    assert.equal((await emit(sa2,'join-room',room)).ok,true);
    assert.equal((await emit(sb,'join-room',room)).error,'FORBIDDEN');
    assert.equal((await emit(sb,'chat-message',{room,message:'unauthorized'})).error,'FORBIDDEN');
    assert.equal((await api('/api/rooms/members',{room,username:bob},b.cookie)).status,403);
    assert.equal((await api('/api/rooms/members',{room,username:bob},a.cookie)).status,200);
    assert.equal((await emit(sb,'join-room',room)).ok,true);
  });
  let saved;
  await t.test('broadcast, sender identity, invalid messages and persisted history',async()=> {
    const receive=event(sb,'chat-message');
    const pollingReceive=event(sa2,'chat-message');
    const result=await emit(sa,'chat-message',{room,message:'Hello <script> & tiếng Việt',username:'forged'});
    assert.equal(result.ok,true);saved=result.message;
    assert.equal((await receive).id,saved.id);assert.equal(saved.username,username);
    assert.equal((await pollingReceive).id,saved.id);
    assert.equal(sa.io.engine.transport.name,'websocket');
    assert.equal(sa2.io.engine.transport.name,'polling');
    const websocketReceive=event(sb,'chat-message');
    const pollingSend=await emit(sa2,'chat-message',{room,message:'Message sent over polling'});
    assert.equal(pollingSend.ok,true);
    assert.equal((await websocketReceive).id,pollingSend.message.id);
    assert.equal((await emit(sa,'chat-message',{room,message:' '})).error,'INVALID_MESSAGE');
    assert.equal((await emit(sa,'chat-message',{room,message:'x'.repeat(2001)})).error,'INVALID_MESSAGE');
    const history=event(sb,'chat-history');await emit(sb,'join-room',room);
    assert.ok((await history).some(m=>m.id===saved.id && m.message===saved.message));
    await emit(sb,'join-room',room+'-other');
    assert.equal((await emit(sb,'chat-message',{room,message:'wrong room'})).error,'FORBIDDEN');
  });
  await t.test('logout disconnects every socket in session and blocks cookie reuse',async()=> {
    const disconnected=event(sa,'disconnect'), disconnected2=event(sa2,'disconnect');
    assert.equal((await api('/api/logout',{},a.cookie)).status,200);
    await Promise.all([disconnected,disconnected2]);
    assert.equal((await api('/api/me',undefined,a.cookie)).data.user,null);
    const socket=io(base,{autoConnect:false,reconnection:false,extraHeaders:{Cookie:a.cookie}});sockets.push(socket);
    const rejected=event(socket,'connect_error');socket.connect();assert.equal((await rejected).message,'UNAUTHORIZED');
    await api('/api/logout',{},b.cookie);
  });
});
