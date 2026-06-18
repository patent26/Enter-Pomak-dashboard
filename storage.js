// storage.js — JSONBin.io persistent storage
const https = require('https');

const API_KEY = process.env.JSONBIN_API_KEY;
const BASE_URL = 'api.jsonbin.io';

function request(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: BASE_URL,
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
        catch(e) { resolve(body); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Spremi report za datum
async function saveReport(date, data) {
  try {
    // Provjeri postoji li već bin za ovaj datum
    const binId = process.env[`JSONBIN_BIN_${date.replace(/-/g, '_')}`];
    
    if (binId) {
      // Ažuriraj postojeći
      await request('PUT', `/v3/b/${binId}`, { date, data, savedAt: Date.now() });
      console.log(`💾 Report ažuriran za ${date} (bin: ${binId})`);
    } else {
      // Kreiraj novi bin
      const res = await request('POST', '/v3/b', { date, data, savedAt: Date.now() });
      const newBinId = res.metadata?.id;
      if (newBinId) {
        console.log(`💾 Report spremljen za ${date} (novi bin: ${newBinId})`);
        // Spremi bin ID u memoriju za ovaj session
        process.env[`JSONBIN_BIN_${date.replace(/-/g, '_')}`] = newBinId;
        
        // Ažuriraj index bin
        await updateIndex(date, newBinId);
      }
    }
    return true;
  } catch (err) {
    console.error('💾 Greška pri spremanju:', err.message);
    return false;
  }
}

// Dohvati report za datum
async function loadReport(date) {
  try {
    const binId = process.env[`JSONBIN_BIN_${date.replace(/-/g, '_')}`];
    if (!binId) {
      // Pokušaj naći u indexu
      const indexBinId = process.env.JSONBIN_INDEX_BIN;
      if (!indexBinId) return null;
      
      const index = await request('GET', `/v3/b/${indexBinId}/latest`);
      const dateEntry = index.record?.[date];
      if (!dateEntry) return null;
      
      process.env[`JSONBIN_BIN_${date.replace(/-/g, '_')}`] = dateEntry;
      return await loadByBinId(dateEntry);
    }
    return await loadByBinId(binId);
  } catch (err) {
    console.error('💾 Greška pri učitavanju:', err.message);
    return null;
  }
}

async function loadByBinId(binId) {
  const res = await request('GET', `/v3/b/${binId}/latest`);
  return res.record || null;
}

// Index bin — čuva mapu datum → bin ID
async function updateIndex(date, binId) {
  try {
    let indexBinId = process.env.JSONBIN_INDEX_BIN;
    
    if (!indexBinId) {
      // Kreiraj index bin
      const res = await request('POST', '/v3/b', { [date]: binId });
      indexBinId = res.metadata?.id;
      process.env.JSONBIN_INDEX_BIN = indexBinId;
      console.log(`💾 Index bin kreiran: ${indexBinId}`);
    } else {
      // Dohvati postojeći index i dodaj novi datum
      const existing = await request('GET', `/v3/b/${indexBinId}/latest`);
      const updated = { ...(existing.record || {}), [date]: binId };
      await request('PUT', `/v3/b/${indexBinId}`, updated);
    }
  } catch (err) {
    console.error('💾 Index greška:', err.message);
  }
}

module.exports = { saveReport, loadReport };
