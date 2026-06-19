const https = require('https');
const API_KEY = process.env.JSONBIN_API_KEY;
let MASTER_BIN_ID = process.env.JSONBIN_MASTER_BIN || null;
let masterCache = null;
let masterCacheTime = 0;

function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'api.jsonbin.io', port: 443, path, method,
      headers: {
        'X-Access-Key': API_KEY,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getMaster() {
  if (masterCache && Date.now() - masterCacheTime < 300000) return masterCache;
  if (!MASTER_BIN_ID) {
    console.log('💾 Kreiram master bin...');
    const res = await request('POST', '/v3/b', {});
    MASTER_BIN_ID = res.metadata?.id;
    console.log(`💾 DODAJ U RENDER ENV: JSONBIN_MASTER_BIN=${MASTER_BIN_ID}`);
    process.env.JSONBIN_MASTER_BIN = MASTER_BIN_ID;
    masterCache = {};
    masterCacheTime = Date.now();
    return masterCache;
  }
  const res = await request('GET', `/v3/b/${MASTER_BIN_ID}/latest`);
  masterCache = res.record || {};
  masterCacheTime = Date.now();
  return masterCache;
}

async function saveReport(date, data) {
  if (!API_KEY) return false;
  try {
    const master = await getMaster();
    master[date] = { date, data, savedAt: Date.now() };
    masterCache = master;
    await request('PUT', `/v3/b/${MASTER_BIN_ID}`, master);
    console.log(`💾 Spremljeno za ${date}`);
    return true;
  } catch(e) { console.error('💾 Greška:', e.message); return false; }
}

async function loadReport(date) {
  if (!API_KEY) return null;
  try {
    const master = await getMaster();
    return master[date] || null;
  } catch(e) { return null; }
}

module.exports = { saveReport, loadReport };
