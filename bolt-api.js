// bolt-api.js — Bolt Fleet API klijent (Fleet Integration Gateway)
const axios = require('axios');

const OIDC_URL   = 'https://oidc.bolt.eu/token';
const API_URL    = 'https://node.bolt.eu/fleet-integration-gateway';
const COMPANY_ID = 318363;

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 30000) return tokenCache.token;
  const params = new URLSearchParams();
  params.append('client_id',     process.env.BOLT_API_KEY);
  params.append('client_secret', process.env.BOLT_CLIENT_SECRET);
  params.append('grant_type',    'client_credentials');
  params.append('scope',         'fleet-integration:api');
  const res = await axios.post(OIDC_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  tokenCache.token     = res.data.access_token;
  tokenCache.expiresAt = now + (res.data.expires_in || 600) * 1000;
  console.log('✅ OAuth2 token dohvaćen');
  return tokenCache.token;
}

async function apiPost(endpoint, body = {}) {
  const token = await getToken();
  console.log(`🔵 POST ${endpoint}`, JSON.stringify(body));
  try {
    const res = await axios.post(`${API_URL}${endpoint}`, body, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    console.log(`🟢 ${endpoint} kod: ${res.data.code} msg: ${res.data.message}`);
    if (res.data.code !== 0) throw new Error(`Bolt greška ${res.data.code}: ${res.data.message}`);
    return res.data.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`🔴 ${endpoint} [${err.response?.status}]: ${detail}`);
    throw new Error(detail);
  }
}

async function getDrivers(startTs, endTs) {
  const data = await apiPost('/fleetIntegration/v1/getDrivers', {
    company_ids: [COMPANY_ID],
    start_ts: startTs,
    end_ts: endTs,
    limit: 1000,
    offset: 0,
  });
  return data.drivers || [];
}

async function getOrders(startTs, endTs) {
  const orders = [];
  let offset = 0;
  while (true) {
    const data = await apiPost('/fleetIntegration/v1/getFleetOrders', {
      company_ids: [COMPANY_ID],
      start_ts: startTs,
      end_ts: endTs,
      limit: 1000,
      offset,
    });
    const batch = data.orders || [];
    orders.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return orders;
}

async function getStateLogs(startTs, endTs) {
  const logs = [];
  let offset = 0;
  while (true) {
    const data = await apiPost('/fleetIntegration/v1/getFleetStateLogs', {
      company_ids: [COMPANY_ID],
      start_ts: startTs,
      end_ts: endTs,
      limit: 1000,
      offset,
    });
    const batch = data.state_logs || [];
    logs.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return logs;
}

function calcHoursFromLogs(logs, driverUuid, startMs, endMs) {
  const driverLogs = logs.filter(l => l.driver_uuid === driverUuid).sort((a, b) => a.created - b.created);
  let onlineMs = 0, drivingMs = 0;
  for (let i = 0; i < driverLogs.length; i++) {
    const curr = driverLogs[i];
    const next = driverLogs[i + 1];
    const from = Math.max(curr.created * 1000, startMs);
    const to   = next ? Math.min(next.created * 1000, endMs) : endMs;
    const dur  = Math.max(0, to - from);
    const state = (curr.state || '').toLowerCase();
    if (['waiting', 'online', 'accepted'].includes(state)) onlineMs  += dur;
    if (['on_ride', 'accepted'].includes(state))            drivingMs += dur;
  }
  return { onlineHours: onlineMs / 3600000, drivingHours: drivingMs / 3600000 };
}

function calcAcceptRate(driverOrders) {
  if (!driverOrders.length) return 0;
  const cancelled = driverOrders.filter(o =>
    o.order_status === 'driver_cancelled' || o.driver_cancelled_reason
  ).length;
  return ((driverOrders.length - cancelled) / driverOrders.length) * 100;
}

async function buildDailyReport(date) {
  const dayStart = new Date(`${date}T00:00:00+02:00`);
  const dayEnd   = new Date(`${date}T23:59:59+02:00`);
  const startTs  = Math.floor(dayStart.getTime() / 1000);
  const endTs    = Math.floor(dayEnd.getTime()   / 1000);

  console.log(`📊 Dohvaćam podatke za ${date} (${startTs} - ${endTs})`);

  const [drivers, orders, stateLogs] = await Promise.all([
    getDrivers(startTs, endTs),
    getOrders(startTs, endTs),
    getStateLogs(startTs, endTs),
  ]);
  console.log(`👥 ${drivers.length} vozača, 🚗 ${orders.length} narudžbi, 📋 ${stateLogs.length} logova`);

  const results = [];
  for (const driver of drivers) {
    const uuid = driver.driver_uuid;
    const name = `${driver.first_name} ${driver.last_name}`.trim();
    const driverOrders    = orders.filter(o => o.driver_uuid === uuid);
    const completedOrders = driverOrders.filter(o =>
      o.order_status === 'finished' || o.order_drop_off_timestamp > 0
    );
    const hasLogs = stateLogs.some(l => l.driver_uuid === uuid);
    if (!completedOrders.length && !driverOrders.length && !hasLogs) continue;

    const netRevenue = completedOrders.reduce((s, o) => s + (o.order_price?.net_earnings || 0), 0);
    const kmDriven   = completedOrders.reduce((s, o) => s + (o.ride_distance || 0), 0) / 1000;
    const { onlineHours, drivingHours } = calcHoursFromLogs(stateLogs, uuid, dayStart.getTime(), dayEnd.getTime());
    const netHourly  = onlineHours > 0 ? netRevenue / onlineHours : 0;
    const acceptRate = calcAcceptRate(driverOrders);
    const ridesCount = completedOrders.length;

    const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY   || 15);
    const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE  || 180);
    const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM           || 150);
    const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM           || 300);
    const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE   || 85);
    const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS  || 8);

    const wasActive = onlineHours > 0 || ridesCount > 0;
    const alerts = [];
    if (wasActive) {
      if (netHourly    < MIN_HOURLY)                   alerts.push({ type: 'danger',  code: 'low_hourly',    msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });
      if (netRevenue   < MIN_REVENUE)                  alerts.push({ type: 'warning', code: 'low_revenue',   msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });
      if (kmDriven     < MIN_KM)                       alerts.push({ type: 'warning', code: 'low_km',        msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (kmDriven     > MAX_KM)                       alerts.push({ type: 'info',    code: 'high_km',       msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (acceptRate   < MIN_ACCEPT && ridesCount > 0) alerts.push({ type: 'danger',  code: 'low_accept',    msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });
      if (drivingHours < MIN_DRIVE_HRS)                alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    results.push({
      id: uuid, name, phone: driver.phone || '-', date,
      netRevenue:   Math.round(netRevenue   * 100) / 100,
      netHourly:    Math.round(netHourly    * 100) / 100,
      onlineHours:  Math.round(onlineHours  * 10)  / 10,
      drivingHours: Math.round(drivingHours * 10)  / 10,
      kmDriven:     Math.round(kmDriven     * 10)  / 10,
      acceptRate:   Math.round(acceptRate   * 10)  / 10,
      ridesCount, assignedShiftName: null, shiftStatus: null,
      alerts, hasAlerts: alerts.length > 0,
    });
  }

  results.sort((a, b) => (b.hasAlerts - a.hasAlerts) || (b.netRevenue - a.netRevenue));
  return results;
}

module.exports = { buildDailyReport };
