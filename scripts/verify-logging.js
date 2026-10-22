const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const grafana='http://127.0.0.1:3001', chat='http://localhost:8080';
const password=fs.readFileSync('.secrets/grafana_admin_password','utf8').trim();
const headers={Authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')};
const proxy=grafana+'/api/datasources/proxy/uid/chat-loki';
const evidence={checks:[],queries:[]};
async function json(url, options={}) {
  const response=await fetch(url,{headers,...options,signal:AbortSignal.timeout(10000)});
  assert.ok(response.ok,'HTTP '+response.status+' from logging/Grafana API');return response.json();
}
async function ready() {
  for(let n=0;n<60;n++) {
    try {
      const r=await fetch(proxy+'/ready',{headers,signal:AbortSignal.timeout(3000)});
      if(r.ok && (await r.text()).trim()==='ready') return;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Loki readiness timeout');
}
const exec=args=>cp.execFileSync('docker',['compose',...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
async function logql(query, instant=false) {
  const params=new URLSearchParams({query,limit:'1000',start:String(BigInt(Date.now()-900000)*1000000n),end:String(BigInt(Date.now())*1000000n)});
  const result=await json(proxy+'/loki/api/v1/'+(instant?'query':'query_range')+'?'+params);
  assert.equal(result.status,'success');return result.data.result;
}
const validLine=/^(http method=(GET|POST|HEAD|OPTIONS|PUT|DELETE|PATCH|OTHER) route=(\/|\/health|\/api\/me|\/api\/register|\/api\/login|\/api\/logout|\/api\/rooms\/members|unmatched) status=[0-9]{3} duration=[0-9.]+( bytes=[0-9]+)?|socket_connected|socket_disconnected|server_started)$/;
async function main() {
  await ready();evidence.checks.push('PASS: Loki /ready HTTP 200 ready via private Grafana proxy');
  const health=await json(grafana+'/api/datasources/uid/chat-loki/health');assert.equal(health.status,'OK');
  evidence.checks.push('PASS: Grafana Loki datasource health OK');
  const prom=await json(grafana+'/api/datasources/uid/chat-prometheus');assert.equal(prom.isDefault,true);
  const secretCanary='PRIVATE_LOG_CANARY_'+Date.now().toString(36);
  const registration=await fetch(chat+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'logtest_'+Date.now().toString(36),password:secretCanary})});
  assert.equal(registration.status,201);const cookie=registration.headers.get('set-cookie').split(';')[0];
  const socket=io(chat,{autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Cookie:cookie}});
  try {
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);socket.connect();});
    const room='private-'+secretCanary;
    assert.equal((await socket.timeout(5000).emitWithAck('join-room',room)).ok,true);
    assert.equal((await socket.timeout(5000).emitWithAck('chat-message',{room,message:secretCanary})).ok,true);
    for(const path of ['/','/health','/api/me','/'+secretCanary+'?token='+secretCanary]) {
      const r=await fetch(chat+path,{headers:{Cookie:'privacy_probe='+secretCanary,Authorization:'Bearer '+secretCanary}});await r.text();
    }
    await fetch(chat+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:secretCanary,password:secretCanary})});
  } finally {
    socket.disconnect();await fetch(chat+'/api/logout',{method:'POST',headers:{Cookie:cookie}});
  }
  let nginx=[], node=[];
  for(let n=0;n<45;n++) {
    nginx=await logql('{job="nginx"}');node=await logql('{job="nodejs"}');
    if(nginx.some(s=>s.values.length)&&node.some(s=>s.values.some(v=>v[1].includes('route=/health')))) break;
    await fetch(chat+'/health');await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(nginx.length && node.length,'Missing source logs');
  for(const query of ['{job="nginx"}','{job="nginx"} |= "GET"','sum(count_over_time({job="nginx"}[5m]))','{job="nodejs"}']) {
    const instant=query.startsWith('sum('), rows=await logql(query,instant);
    assert.ok(rows.length,'EMPTY LogQL query');
    const count=instant?Number(rows[0].value[1]):rows.reduce((sum,row)=>sum+row.values.length,0);assert.ok(count>0);
    evidence.queries.push({query,status:'PASS',streams:rows.length,count,sample:instant?rows[0].value[1]:rows[0].values.slice(0,2),labels:instant?undefined:rows.map(r=>r.stream)});
  }
  for(const stream of [...nginx,...node]) {
    assert.ok(Object.keys(stream.stream).every(key=>['job','project','service','service_name'].includes(key)), 'Unexpected log label');
    for(const [,line] of stream.values) assert.match(line,validLine,'Unsafe log record in Loki');
  }
  const leaked=await logql('{job=~"nginx|nodejs"} |= "'+secretCanary+'"');assert.equal(leaked.length,0);
  // Check cookies only in memory: never send a cookie literal in a LogQL query,
  // since Loki's own diagnostic logs can contain query text.
  const cookieValue=cookie.slice(cookie.indexOf('=')+1);
  for(const stream of [...nginx,...node]) for(const [,line] of stream.values) assert.ok(!line.includes(cookieValue),'Cookie found in log');
  evidence.checks.push('PASS: password/token/cookie/path/room/message canaries absent; every returned log follows safe vocabulary');
  const targets=exec(['exec','-T','grafana','wget','-qO-','http://promtail:9080/targets']);
  fs.writeFileSync('evidence/promtail-targets.html',targets);
  const groups=[...targets.matchAll(/\((\d+)\/(\d+) ready\)/g)];
  assert.ok(groups.length && groups.reduce((n,m)=>n+Number(m[1]),0)>=2);
  assert.ok(groups.every(m=>m[1]===m[2]));
  assert.equal(exec(['exec','-T','grafana','wget','-qO-','http://promtail:9080/ready']).trim(),'Ready');
  const metrics=exec(['exec','-T','grafana','wget','-qO-','http://promtail:9080/metrics']);
  const sent=metrics.split('\n').filter(line=>line.startsWith('promtail_sent_entries_total'));
  assert.ok(sent.some(line=>Number(line.trim().split(/\s+/).at(-1))>0));
  evidence.promtail={ready:true,readyTargets:groups.reduce((n,m)=>n+Number(m[1]),0),sentMetrics:sent};
  const config=JSON.parse(exec(['config','--format','json']));
  for(const service of ['loki','promtail'])assert.ok(!config.services[service].ports?.length);
  assert.equal(config.networks.logging.internal,true);
  evidence.checks.push('PASS: Loki/Promtail have no host ports, logging network internal');
  const preserved=nginx[0].values[0];
  const positions=exec(['exec','-T','promtail','cat','/var/lib/promtail/positions.yml']);
  const cursors=positions.match(/cursor-[a-f0-9]+/g)||[];
  assert.ok(positions.includes('positions:') && cursors.length>=2);
  console.log('Checking Loki WAL/volume and Promtail positions across logging service restart...');
  exec(['restart','loki','promtail']);await ready();
  const restored=exec(['exec','-T','promtail','cat','/var/lib/promtail/positions.yml']);
  assert.ok(cursors.every(cursor=>restored.includes(cursor)),'Promtail positions lost');
  const after=await logql('{job="nginx"}');
  assert.ok(after.some(row=>row.values.some(v=>v[0]===preserved[0]&&v[1]===preserved[1])),'Pre-restart log was lost');
  evidence.checks.push('PASS: exact pre-restart log timestamp+line survives Loki/Promtail restart');
  assert.equal((await fetch(chat)).status,200);evidence.checks.push('PASS: Chat HTTP 200');
  evidence.status='PASS';
}
main().catch(error=>{evidence.status='FAIL';evidence.error=error.message;process.exitCode=1;}).finally(()=>{
  fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/logging.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
});
