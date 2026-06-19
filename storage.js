// storage.js — JSONBin.io persistent storage
const https = require('https');

const API_KEY = process.env.JSONBIN_API_KEY;

// Jedan glavni bin koji sadrži sve reporte po datumu
// Format: { "2026-06-16": { date, data, savedAt }, ... }
let MASTER_BIN_ID = process.env.JSONBIN_MASTER_BIN || null;
let masterCache = null;
let masterCacheTime = 0;

function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'api.jsonbin.io',
      port: 443,
      path,
      method,
      headers: {
        'X-Access-Key': API_KEY,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({ error: body }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Dohvati master bin (s cacheom od 5 min)
async function getMaster() {
  if (masterCache && Date.now() - masterCacheTime < 5 * 60 * 1000) {
    return masterCache;
  }

  if (!MASTER_BIN_ID) {
    // Kreiraj novi master bin
    console.log('💾 Kreiram novi master bin...');
    const res = await request('POST', '/v3/b', {});
    MASTER_BIN_ID = res.metadata?.id;
    if (MASTER_BIN_ID) {
      console.log(`💾 Master bin kreiran: ${MASTER_BIN_ID}`);
      console.log(`💾 DODAJ U RENDER ENV: JSONBIN_MASTER_BIN=${MASTER_BIN_ID}`);
      process.env.JSONBIN_MASTER_BIN = MASTER_BIN_ID;
    }
    masterCache = {};
    masterCacheTime = Date.now();
    return masterCache;
  }

  try {
    const res = await request('GET', `/v3/b/${MASTER_BIN_ID}/latest`);
    masterCache = res.record || {};
    masterCacheTime = Date.now();
    return masterCache;
  } catch (err) {
    console.error('💾 Greška pri čitanju master bina:', err.message);
    return masterCache || {};
  }
}

// Spremi report za datum
async function saveReport(date, data) {
  try {
    if (!API_KEY) { console.log('💾 Nema JSONBIN_API_KEY, preskačem'); return false; }

    const master = await getMaster();
    master[date] = { date, data, savedAt: Date.now() };
    masterCache = master;

    await request('PUT', `/v3/b/${MASTER_BIN_ID}`, master);
    console.log(`💾 Report spremljen za ${date}`);
    return true;
  } catch (err) {
    console.error('💾 Greška pri spremanju:', err.message);
    return false;
  }
}

// Dohvati report za datum
async function loadReport(date) {
  try {
    if (!API_KEY) return null;

    const master = await getMaster();
    const entry = master[date];
    if (entry) {
      console.log(`💾 Učitan iz JSONBin za ${date}`);
      return entry;
    }
    return null;
  } catch (err) {
    console.error('💾 Greška pri učitavanju:', err.message);
    return null;
  }
}

module.exports = { saveReport, loadReport };
