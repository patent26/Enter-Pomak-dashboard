// storage.js — JSONBin.io persistent storage
// Sve se sprema direktno u jedan master bin
const https = require('https');

const API_KEY = process.env.JSONBIN_API_KEY;
const MASTER_BIN_ID = process.env.JSONBIN_MASTER_BIN;

let localCache = null;
let localCacheTime = 0;

function request(method, path, data) {
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
    const req = https.request(options, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch(e) { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function readMaster() {
  if (!API_KEY || !MASTER_BIN_ID) return {};
  if (localCache && Date.now() - localCacheTime < 2 * 60 * 1000) return localCache;
  try {
    const r = await request('GET', `/v3/b/${MASTER_BIN_ID}/latest`);
    if (r.status === 200) {
      localCache = r.data.record || {};
      localCacheTime = Date.now();
      console.log(`💾 Master bin učitan, datumi: ${Object.keys(localCache).filter(k => k.match(/\d{4}-\d{2}-\d{2}/)).join(', ') || 'nema'}`);
      return localCache;
    }
  } catch(e) { console.error('💾 Read greška:', e.message); }
  return localCache || {};
}

async function writeMaster(data) {
  if (!API_KEY || !MASTER_BIN_ID) return false;
  try {
    const r = await request('PUT', `/v3/b/${MASTER_BIN_ID}`, data);
    if (r.status === 200) {
      localCache = data;
      localCacheTime = Date.now();
      return true;
    }
    console.error('💾 Write greška status:', r.status, JSON.stringify(r.data));
  } catch(e) { console.error('💾 Write greška:', e.message); }
  return false;
}

async function saveReport(date, reportData) {
  try {
    const master = await readMaster();
    master[date] = { date, data: reportData, savedAt: Date.now() };
    const ok = await writeMaster(master);
    if (ok) console.log(`💾 Spremljeno u master bin za ${date}`);
    return ok;
  } catch(e) {
    console.error('💾 saveReport greška:', e.message);
    return false;
  }
}

async function loadReport(date) {
  if (date === '_init_') { await readMaster(); return null; }
  try {
    const master = await readMaster();
    const entry = master[date];
    if (entry && entry.data) {
      console.log(`💾 Učitan iz master bina za ${date}`);
      return entry;
    }
    return null;
  } catch(e) {
    console.error('💾 loadReport greška:', e.message);
    return null;
  }
}

module.exports = { saveReport, loadReport };
