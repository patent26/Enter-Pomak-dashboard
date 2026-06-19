// server.js — Bolt Fleet Dashboard server
require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { buildDailyReport } = require('./bolt-api');
const { parseRidesCSV, parseActivityCSV, parsePerformanceCSV, parseEarningsCSV, detectCSVType, buildCombinedReport } = require('./csv-parser');
const { saveReport, loadReport } = require('./storage');
const { sendDailyReport }  = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// Cache za zadnji report (da ne bi svaki refresh zvao API)
let reportCache = { date: null, data: null, fetchedAt: null };

// ─── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));

// Jednostavna lozinka zaštita (opcionalno)
app.use('/api', (req, res, next) => {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return next();
  const auth = req.headers['x-dashboard-key'] || req.query.key;
  if (auth !== pass) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── API rute ─────────────────────────────────────────────────

// Dohvati report (s cacheom od 30 min)
app.get('/api/report', async (req, res) => {
  try {
    const date = req.query.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const now  = Date.now();

    // 1. Provjeri trajni storage (JSONBin) — CSV podaci imaju prioritet!
    const stored = await loadReport(date);
    if (stored && stored.data) {
      console.log(`💾 Učitan iz JSONBin za ${date} (CSV podaci)`);
      reportCache = { date, data: stored.data, fetchedAt: stored.savedAt || now };
      return res.json({ data: stored.data, date, cached: true, fetchedAt: stored.savedAt || now, source: 'csv' });
    }

    // 2. Provjeri memorijski cache (samo ako nema JSONBin podataka)
    if (reportCache.date === date && reportCache.fetchedAt && (now - reportCache.fetchedAt) < 30 * 60 * 1000) {
      return res.json({ data: reportCache.data, date, cached: true, fetchedAt: reportCache.fetchedAt, source: 'cache' });
    }

    // 3. Fallback na API
    console.log(`📊 Dohvaćam API report za ${date}...`);
    const data = await buildDailyReport(date);
    reportCache = { date, data, fetchedAt: now };

    res.json({ data, date, cached: false, fetchedAt: now, source: 'api' });
  } catch (err) {
    console.error('API greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Forsiraj osvježavanje cachea
app.post('/api/refresh', async (req, res) => {
  try {
    const date = req.body.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const data = await buildDailyReport(date);
    reportCache = { date, data, fetchedAt: Date.now() };
    res.json({ data, date, cached: false, fetchedAt: reportCache.fetchedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ručno pošalji mail (za testiranje)
app.post('/api/send-report', async (req, res) => {
  try {
    const date = req.body.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    console.log(`📧 Slanje maila za ${date}...`);
    let data = reportCache.data;
    if (!data || reportCache.date !== date) {
      data = await buildDailyReport(date);
      reportCache = { date, data, fetchedAt: Date.now() };
    }
    console.log(`📧 Šaljem na: ${process.env.REPORT_RECIPIENTS}`);
    await sendDailyReport(data, date);
    console.log(`📧 Mail poslan uspješno!`);
    res.json({ ok: true, message: `Izvještaj poslan za ${date}` });
  } catch (err) {
    console.error('📧 GREŠKA pri slanju maila:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
// CSV upload endpoint — prima jedan ili dva CSV-a odjednom
app.post('/api/upload-csv', async (req, res) => {
  try {
    const { csvFiles, date } = req.body;
    // csvFiles = [{ name: 'filename.csv', content: '...' }, ...]
    if (!csvFiles || !csvFiles.length) return res.status(400).json({ error: 'Nema CSV podataka' });

    let ridesData    = null;
    let activityData = null;
    let csvDate      = null;

    let performanceData = null;
    let earningsData    = null;

    for (const file of csvFiles) {
      const type = detectCSVType(file.content);
      console.log(`📄 CSV: ${file.name} → tip: ${type}`);

      if (type === 'earnings') {
        const { driverMap } = parseEarningsCSV(file.content);
        earningsData = driverMap;
        console.log(`📄 Earnings CSV: ${Object.keys(driverMap).length} vozača`);
      } else if (type === 'performance') {
        const { driverMap } = parsePerformanceCSV(file.content);
        performanceData = driverMap;
        console.log(`📄 Performance CSV: ${Object.keys(driverMap).length} vozača`);
      } else if (type === 'rides') {
        const { driverMap, csvDate: d } = parseRidesCSV(file.content);
        ridesData = driverMap;
        if (d) csvDate = d;
      } else {
        const { driverMap, csvDate: d } = parseActivityCSV(file.content);
        activityData = driverMap;
        if (d) csvDate = d;
      }
    }

    const targetDate = date || csvDate || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    console.log(`📄 Generiram report za ${targetDate}...`);

    const data = buildCombinedReport(ridesData, activityData, targetDate, performanceData, earningsData);
    reportCache = { date: targetDate, data, fetchedAt: Date.now() };

    console.log(`📄 CSV parsiran: ${data.length} vozača`);
    
    // Spremi u trajni storage
    await saveReport(targetDate, data);
    
    res.json({ data, date: targetDate, cached: false, fetchedAt: Date.now(), source: 'csv' });
  } catch (err) {
    console.error('CSV greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Cron job — svaki dan u 8:00 ──────────────────────────────
// '0 8 * * *' = 08:00 svaki dan (server timezone)
cron.schedule('30 9 * * *', async () => {
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  console.log(`⏰ Cron: generiranje izvještaja za ${yesterday}...`);

  try {
    const data = await buildDailyReport(yesterday);
    reportCache = { date: yesterday, data, fetchedAt: Date.now() };
    await sendDailyReport(data, yesterday);
    console.log(`✅ Cron završen. Izvještaj poslan za ${yesterday}.`);
  } catch (err) {
    console.error('❌ Cron greška:', err.message);
  }
}, {
  timezone: 'Europe/Zagreb'
});

// ─── Serve dashboard ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
  console.log(`🚀 Bolt Fleet Dashboard pokrenut na portu ${PORT}`);
  console.log(`📅 Cron izvještaj: svaki dan u 09:30 (Europe/Zagreb)`);
});
