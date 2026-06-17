// server.js — Bolt Fleet Dashboard server
require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { buildDailyReport } = require('./bolt-api');
const { sendDailyReport }  = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3000;

let reportCache = { date: null, data: null, fetchedAt: null };

app.use(express.json());
app.use(express.static('public'));

app.use('/api', (req, res, next) => {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return next();
  const auth = req.headers['x-dashboard-key'] || req.query.key;
  if (auth !== pass) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/api/report', async (req, res) => {
  try {
    const date = req.query.date || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const now  = Date.now();
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

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

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
}, { timezone: 'Europe/Zagreb' });

app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
  console.log(`🚀 Bolt Fleet Dashboard pokrenut na portu ${PORT}`);
  console.log(`📅 Cron izvještaj: svaki dan u 08:00 (Europe/Zagreb)`);
});
