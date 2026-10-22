const fs = require('node:fs');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { execFileSync } = require('node:child_process');
const prom = 'http://127.0.0.1:9090';
const grafana = 'http://127.0.0.1:3001';
const chat = 'http://localhost:8080';
const password = fs.readFileSync('.secrets/grafana_admin_password','utf8').trim();
const authorization = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
const evidence = { targets: [], panels: [], checks: [] };
async function json(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(10000)});
  assert.ok(response.ok, url + ' status ' + response.status);
  return response.json();
}
async function query(expr) {
  const result = await json(prom + '/api/v1/query?query=' + encodeURIComponent(expr));
  assert.equal(result.status, 'success');
  assert.ok(result.data.result.length > 0, 'EMPTY metric: ' + expr);
  assert.ok(result.data.result.every(row=>Number.isFinite(Number(row.value[1]))), 'Non-finite metric: ' + expr);
  return result.data.result;
}
async function main() {
  // Give new targets time to register; never call an empty/down target PASS.
  for (let n=0;n<30;n++) {
    const data = await json(prom + '/api/v1/targets');
    evidence.targets = data.data.activeTargets.map(t=>({job:t.labels.job,url:t.scrapeUrl,health:t.health,error:t.lastError}));
    if(evidence.targets.length === 5 && evidence.targets.every(t=>t.health==='up')) break;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  assert.equal(evidence.targets.length,5);
  assert.ok(evidence.targets.every(t=>t.health==='up'),JSON.stringify(evidence.targets));
  const headers = { Authorization: authorization };
  const datasource = await json(grafana + '/api/datasources/uid/chat-prometheus/health',{headers});
  assert.equal(datasource.status,'OK');
  evidence.checks.push('PASS: Grafana datasource health OK');
  const dashboard = await json(grafana + '/api/dashboards/uid/de32-chat-monitoring',{headers});
  assert.equal(dashboard.dashboard.panels.length,12);

  const username='monitor_'+Date.now().toString(36);
  const registration=await fetch(chat+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'Monitoring-test-password'})});
  assert.equal(registration.status,201);
  const cookie=registration.headers.get('set-cookie').split(';')[0];
  const socket=io(chat,{autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Cookie:cookie}});
  const traffic=setInterval(()=>fetch(chat+'/health').catch(()=>{}),1000);
  try {
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);socket.connect();});
    // Rate/histogram queries require multiple scrapes after traffic begins.
    await fetch(chat+'/health');
    await fetch(chat+'/private-path-'+username+'?username='+username);
    for(let n=0;n<30;n++) {
      try {
        const rows=await query('chat_socketio_connections{job="chat-app"}');
        assert.ok(rows.some(row=>Number(row.value[1])>=1));
        const requests=await query('sum(rate(chat_http_requests_total{job="chat-app"}[1m]))');
        assert.ok(Number(requests[0].value[1])>0);
        await query('histogram_quantile(0.95,sum by (le) (rate(chat_http_request_duration_seconds_bucket{job="chat-app"}[1m])))');
        // Grafana aligns range-query steps; keep traffic across several steps too.
        if(n<15) { await new Promise(resolve=>setTimeout(resolve,1000)); continue; }
        break;
      } catch(error) {
        if(n===29) throw error;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    for(const panel of dashboard.dashboard.panels) {
      const expr=panel.targets[0].expr;
      const rows=await query(expr);
      const payload={from:String(Date.now()-120000),to:String(Date.now()),queries:[{refId:'A',expr,datasource:{type:'prometheus',uid:'chat-prometheus'},intervalMs:5000,maxDataPoints:100,range:true}]};
      const result=await json(grafana+'/api/ds/query',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const frames=result.results?.A?.frames||[];
      assert.ok(!result.results?.A?.error,'Grafana query error: '+panel.title);
      assert.ok(frames.some(frame=>frame.data?.values?.some((values,index)=>frame.schema.fields[index]?.type==='number' && values.some(value=>typeof value==='number' && Number.isFinite(value)))), 'Empty Grafana frame: '+panel.title);
      evidence.panels.push({title:panel.title,expr,series:rows.length,sample:rows.slice(0,2).map(row=>({labels:row.metric,value:row.value[1]})),grafanaFrames:frames.length,status:'PASS'});
    }
    const pg=await query('pg_up{job="postgres"}');assert.equal(pg[0].value[1],'1');
    const nginx=await query('nginx_up{job="nginx"}');assert.equal(nginx[0].value[1],'1');
    const containers=await query('container_memory_working_set_bytes{job="cadvisor",container_label_com_docker_compose_project="detai32_chat",image!=""}');
    for(const service of ['app','postgres','nginx']) assert.ok(containers.some(row=>row.metric.container_label_com_docker_compose_service===service),service+' container missing');
    const http=await query('chat_http_requests_total{job="chat-app"}');
    const routes=['/','/health','/api/me','/api/register','/api/login','/api/logout','/api/rooms/members','unmatched'];
    for(const row of http) {
      assert.deepEqual(Object.keys(row.metric).sort(),['__name__','instance','job','method','route','status_code'].sort());
      assert.ok(routes.includes(row.metric.route),'Unbounded/sensitive route label');
    }
    const sockets=await query('chat_socketio_connections{job="chat-app"}');assert.ok(Number(sockets[0].value[1])>=1);
    evidence.checks.push('PASS: real container series for app/PostgreSQL/Nginx, HTTP labels bounded, socket gauge >=1');
  } finally {
    clearInterval(traffic);socket.disconnect();
    await fetch(chat+'/api/logout',{method:'POST',headers:{Cookie:cookie}});
  }
  for(const path of ['/metrics','/metrics/','/MeTrIcS','/stub_status']) assert.equal((await fetch(chat+path)).status,404);
  evidence.checks.push('PASS: public metrics/stub_status are 404');
  const config=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{encoding:'utf8'}));
  for(const name of ['app','postgres','cadvisor','postgres-exporter','nginx-exporter']) assert.ok(!config.services[name].ports?.length,name+' must not publish ports');
  for(const name of ['prometheus','grafana']) assert.ok(config.services[name].ports.every(p=>p.host_ip==='127.0.0.1'));
  evidence.checks.push('PASS: admin ports loopback only; database/exporters not published');
  const privileges=execFileSync('docker',['compose','exec','-T','postgres','psql','-U','chatuser','-d','chatdb','-Atc',"SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,pg_has_role(rolname,'pg_monitor','MEMBER'),has_table_privilege(rolname,'users','SELECT') FROM pg_roles WHERE rolname='chat_metrics'"],{encoding:'utf8'}).trim();
  assert.equal(privileges,'f|f|f|f|t|f');evidence.checks.push('PASS: PostgreSQL metrics role pg_monitor; no superuser/createdb/createrole/replication or SELECT users');
  assert.equal((await fetch(chat)).status,200);evidence.checks.push('PASS: Chat HTTP 200');
  evidence.status='PASS';
}
main().catch(error=>{evidence.status='FAIL';evidence.error=error.message;process.exitCode=1;}).finally(()=>{
  fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/monitoring.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
});
