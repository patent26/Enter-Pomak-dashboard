// server.js — Bolt Fleet Dashboard server
require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { buildDailyReport } = require('./bolt-api');
const { parseRidesCSV, parseActivityCSV, parsePerformanceCSV, parseEarningsCSV, detectCSVType, buildCombinedReport } = require('./csv-parser');
const { saveReport, loadReport } = require('./storage');
const { sendDailyReport } = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3000;

let reportCache = { date: null, data: null, fetchedAt: null };

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

app.use('/api', (req, res, next) => {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return next();
  const auth = req.headers['x-dashboard-key'] || req.query.key;
  if (auth !== pass) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Dohvati report
app.get('/api/report', async (req, res) => {
  try {
    const date = req.query.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const now  = Date.now();

    // 1. JSONBin — CSV podaci imaju prioritet
    const stored = await loadReport(date);
    if (stored && stored.data) {
      console.log(`💾 Učitan iz JSONBin za ${date}`);
      reportCache = { date, data: stored.data, fetchedAt: stored.savedAt || now };
      return res.json({ data: stored.data, date, cached: true, fetchedAt: stored.savedAt || now, source: 'csv' });
    }

    // 2. Memorijski cache
    if (reportCache.date === date && reportCache.fetchedAt && (now - reportCache.fetchedAt) < 30 * 60 * 1000) {
      return res.json({ data: reportCache.data, date, cached: true, fetchedAt: reportCache.fetchedAt, source: 'cache' });
    }

    // 3. API fallback
    console.log(`📊 Dohvaćam API report za ${date}...`);
    const data = await buildDailyReport(date);
    reportCache = { date, data, fetchedAt: now };
    res.json({ data, date, cached: false, fetchedAt: now, source: 'api' });
  } catch (err) {
    console.error('API greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Refresh
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

// Pošalji mail
app.post('/api/send-report', async (req, res) => {
  try {
    const date = req.body.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    console.log(`📧 Slanje maila za ${date}...`);
    let data = reportCache.data;
    if (!data || reportCache.date !== date) {
      const stored = await loadReport(date);
      data = stored?.data || await buildDailyReport(date);
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

// CSV upload — jedan ili više fajlova, svaki za svoj datum
app.post('/api/upload-csv', async (req, res) => {
  try {
    const { csvFiles, date } = req.body;
    if (!csvFiles || !csvFiles.length) return res.status(400).json({ error: 'Nema CSV podataka' });

    const savedDates = [];
    let lastData = null;
    let lastDate = null;

    for (const file of csvFiles) {
      try {
        const type = detectCSVType(file.content);
        console.log(`📄 CSV: ${file.name} → tip: ${type}`);

        let fileDate = date;
        let data = null;

        // Izvuci datum iz naziva fajla (format: DD-lip-YYYY ili DD lip YYYY)
        if (!fileDate) {
          const m = file.name.match(/(\d{2})[-_\s]lip[-_\s](\d{4})/i);
          if (m) fileDate = `${m[2]}-06-${m[1].padStart(2,'0')}`;
          const m2 = file.name.match(/(\d{4})-(\d{2})-(\d{2})/);
          if (m2) fileDate = `${m2[1]}-${m2[2]}-${m2[3]}`;
        }

        if (type === 'earnings') {
          const { driverMap, csvDate } = parseEarningsCSV(file.content);
          fileDate = fileDate || csvDate || dayjs().subtract(1,'day').format('YYYY-MM-DD');
          data = buildCombinedReport(null, null, fileDate, null, driverMap);
        } else if (type === 'performance') {
          const { driverMap } = parsePerformanceCSV(file.content);
          fileDate = fileDate || dayjs().subtract(1,'day').format('YYYY-MM-DD');
          data = buildCombinedReport(null, null, fileDate, driverMap, null);
        } else if (type === 'rides') {
          const { driverMap, csvDate } = parseRidesCSV(file.content);
          fileDate = fileDate || csvDate || dayjs().subtract(1,'day').format('YYYY-MM-DD');
          data = buildCombinedReport(driverMap, null, fileDate, null, null);
        } else {
          const { driverMap, csvDate } = parseActivityCSV(file.content);
          fileDate = fileDate || csvDate || dayjs().subtract(1,'day').format('YYYY-MM-DD');
          data = buildCombinedReport(null, driverMap, fileDate, null, null);
        }

        if (data && fileDate) {
          await saveReport(fileDate, data);
          savedDates.push(fileDate);
          lastData = data;
          lastDate = fileDate;
          console.log(`📄 Spremljeno za ${fileDate}: ${data.length} vozača`);
        }
      } catch (fileErr) {
        console.error(`📄 Greška za ${file.name}:`, fileErr.message);
      }
    }

    if (lastData && lastDate) {
      reportCache = { date: lastDate, data: lastData, fetchedAt: Date.now() };
    }

    res.json({ 
      data: lastData || [], 
      date: lastDate, 
      savedDates,
      cached: false, 
      fetchedAt: Date.now(), 
      source: 'csv' 
    });
  } catch (err) {
    console.error('CSV greška:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Cron — svaki dan u 9:30
cron.schedule('30 9 * * *', async () => {
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  console.log(`⏰ Cron: izvještaj za ${yesterday}...`);
  try {
    const stored = await loadReport(yesterday);
    const data = stored?.data || await buildDailyReport(yesterday);
    reportCache = { date: yesterday, data, fetchedAt: Date.now() };
    await sendDailyReport(data, yesterday);
    console.log(`✅ Cron završen za ${yesterday}.`);
  } catch (err) {
    console.error('❌ Cron greška:', err.message);
  }
}, { timezone: 'Europe/Zagreb' });

app.get('*', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.listen(PORT, () => {
  console.log(`🚀 Bolt Fleet Dashboard pokrenut na portu ${PORT}`);
  console.log(`📅 Cron izvještaj: svaki dan u 09:30 (Europe/Zagreb)`);
});

// Init storage
setTimeout(() => { loadReport('_init_').catch(() => {}); }, 2000);
