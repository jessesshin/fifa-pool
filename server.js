const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'fifa-pool-data.txt');
const HTML_FILE = path.join(__dirname, 'fifa-pool-shared.html');

function defaultData(){ return { pool:[], actual:{}, slotMap:{}, updatedAt:new Date().toISOString() }; }
function readData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { const d = defaultData(); writeData(d); return d; }
}
function writeData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function send(res, code, body, type='application/json'){
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(body);
}
function collectJson(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e){ reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(req.method === 'GET' && (url.pathname === '/' || url.pathname === '/fifa-pool-shared.html')){
      return send(res, 200, fs.readFileSync(HTML_FILE, 'utf8'), 'text/html; charset=utf-8');
    }
    if(req.method === 'GET' && url.pathname === '/pool-data.txt'){
      return send(res, 200, JSON.stringify(readData(), null, 2), 'application/json; charset=utf-8');
    }
    if(req.method === 'POST' && url.pathname === '/api/submit'){
      const entry = await collectJson(req);
      if(!entry.name || !entry.picks) return send(res, 400, JSON.stringify({error:'Missing name or picks'}));
      const data = readData();
      data.pool = (data.pool || []).filter(p => p.name.toLowerCase() !== entry.name.toLowerCase());
      data.pool.push({ name:entry.name, picks:entry.picks, ts:entry.ts || Date.now() });
      data.updatedAt = new Date().toISOString();
      writeData(data);
      return send(res, 200, JSON.stringify(data));
    }
    if(req.method === 'POST' && url.pathname === '/api/state'){
      const incoming = await collectJson(req);
      const data = { pool:incoming.pool || [], actual:incoming.actual || {}, slotMap:incoming.slotMap || {}, updatedAt:new Date().toISOString() };
      writeData(data);
      return send(res, 200, JSON.stringify(data));
    }
    return send(res, 404, 'Not found', 'text/plain');
  }catch(e){
    return send(res, 500, JSON.stringify({error:e.message}));
  }
});
server.listen(PORT, () => console.log(`FIFA pool running: http://localhost:${PORT}`));
