// server.js — Bolt Fleet Dashboard server
require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { buildDailyReport } = require('./bolt-api');
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

    // Vrati cache ako je isti dan i mlađi od 30 min
    if (reportCache.date === date && reportCache.fetchedAt && (now - reportCache.fetchedAt) < 30 * 60 * 1000) {
      return res.json({ data: reportCache.data, date, cached: true, fetchedAt: reportCache.fetchedAt });
    }

    console.log(`📊 Dohvaćam report za ${date}...`);
    const data = await buildDailyReport(date);
    reportCache = { date, data, fetchedAt: now };

    res.json({ data, date, cached: false, fetchedAt: now });
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
    let data = reportCache.data;
    if (!data || reportCache.date !== date) {
      data = await buildDailyReport(date);
      reportCache = { date, data, fetchedAt: Date.now() };
    }
    await sendDailyReport(data, date);
    res.json({ ok: true, message: `Izvještaj poslan za ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Cron job — svaki dan u 8:00 ──────────────────────────────
// '0 8 * * *' = 08:00 svaki dan (server timezone)
cron.schedule('0 8 * * *', async () => {
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
  console.log(`📅 Cron izvještaj: svaki dan u 08:00 (Europe/Zagreb)`);
});
