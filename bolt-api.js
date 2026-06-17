// bolt-api.js — Bolt Fleet API klijent
const axios = require('axios');
const dayjs = require('dayjs');

const BASE_URL = 'https://api.bolt.eu/fleet/v1';

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${process.env.BOLT_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// Povuci sve vozače u floti
async function getDrivers() {
  try {
    const response = await client.get(`/fleets/${process.env.BOLT_FLEET_ID}/drivers`);
    return response.data.drivers || response.data || [];
  } catch (err) {
    console.error('Greška pri dohvaćanju vozača:', err.response?.data || err.message);
    throw err;
  }
}

// Povuci statistike za određeni datum
async function getDriverStats(driverId, date) {
  const from = `${date}T00:00:00Z`;
  const to   = `${date}T23:59:59Z`;
  try {
    const response = await client.get(`/fleets/${process.env.BOLT_FLEET_ID}/drivers/${driverId}/statistics`, {
      params: { from, to }
    });
    return response.data;
  } catch (err) {
    console.error(`Greška statistike za vozača ${driverId}:`, err.response?.data || err.message);
    return null;
  }
}

// Povuci smjene za određeni datum
async function getDriverShifts(driverId, date) {
  const from = `${date}T00:00:00Z`;
  const to   = `${date}T23:59:59Z`;
  try {
    const response = await client.get(`/fleets/${process.env.BOLT_FLEET_ID}/drivers/${driverId}/shifts`, {
      params: { from, to }
    });
    return response.data.shifts || response.data || [];
  } catch (err) {
    return [];
  }
}

// Parsira naziv smjene iz Bolt API odgovora
// Bolt koristi: "morning_shift", "afternoon_shift", "weekend_shift" ili
//               "Morning Shift", "Afternoon Shift", "Weekend Shift"
function parseShiftName(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[_\s]/g, '');
  if (s.includes('morning'))   return 'Morning Shift';
  if (s.includes('afternoon')) return 'Afternoon Shift';
  if (s.includes('weekend'))   return 'Weekend Shift';
  return raw; // vrati original ako nije prepoznato
}

// Izgradi kompletan report za sve vozače za određeni datum
async function buildDailyReport(date) {
  const drivers = await getDrivers();
  const results = [];

  for (const driver of drivers) {
    const [stats, shifts] = await Promise.all([
      getDriverStats(driver.id, date),
      getDriverShifts(driver.id, date),
    ]);

    if (!stats) {
      results.push({
        id: driver.id,
        name: `${driver.first_name} ${driver.last_name}`,
        phone: driver.phone || '-',
        error: true,
        date,
      });
      continue;
    }

    // ── Prihodi — NETO (nakon Bolt provizije) ──────────────────────────
    // Bolt API polja za neto (nakon što Bolt uzme svoju proviziju):
    //   net_earnings, net_revenue, earnings.net, driver_earnings_net
    // Bruto polja (koje NE koristimo): gross_revenue, total_revenue, earnings.gross
    const netRevenue = (
      stats.net_earnings          ??   // najčešće ime u novijim verzijama
      stats.net_revenue           ??
      stats.earnings?.net         ??
      stats.driver_earnings_net   ??
      stats.driver_earnings       ??
      0
    );

    // ── Sati ───────────────────────────────────────────────────────────
    // online_hours  = ukupno online (čekanje + vožnja)
    // driving_hours = sati stvarne vožnje s putnicima / u vožnji
    const onlineHours  = stats.online_hours   ?? stats.hours_worked ?? stats.working_hours ?? 0;
    const drivingHours = (
      stats.driving_hours       ??
      stats.trip_hours          ??
      stats.in_ride_hours       ??
      stats.active_hours        ??
      onlineHours               // fallback na online ako driving nije dostupno
    );

    // ── Ostale metrike ─────────────────────────────────────────────────
    const kmDriven   = stats.distance_km ?? stats.total_distance_km ?? (stats.distance_meters ? stats.distance_meters / 1000 : 0);
    const acceptRate = stats.acceptance_rate ?? stats.order_acceptance_rate ?? 0;
    const ridesCount = stats.completed_rides ?? stats.trips_completed ?? stats.rides ?? 0;

    // ── Neto po satu (na bazi online sati, jer je to standard) ─────────
    const netHourly = onlineHours > 0 ? netRevenue / onlineHours : 0;

    // ── Smjene ─────────────────────────────────────────────────────────
    // Bolt šalje smjene kao: { name: "Morning Shift", status: "completed"|"missed"|"active", ... }
    let assignedShiftName = null;
    let shiftStatus       = null; // 'completed' | 'missed' | 'active' | null

    if (shifts.length > 0) {
      // Uzmi prvu/jedinu smjenu za taj dan
      const shift = shifts[0];
      assignedShiftName = parseShiftName(
        shift.name ?? shift.shift_name ?? shift.type ?? shift.shift_type
      );
      const rawStatus = (shift.status ?? shift.state ?? '').toLowerCase();
      if (rawStatus.includes('complet'))  shiftStatus = 'completed';
      else if (rawStatus.includes('miss')) shiftStatus = 'missed';
      else if (rawStatus.includes('activ') || rawStatus.includes('progress')) shiftStatus = 'active';
      else shiftStatus = rawStatus || null;
    }

    // ── Alarmi ────────────────────────────────────────────────────────
    const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY  || 15);
    const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE || 180);
    const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM          || 150);
    const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM          || 300);
    const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE  || 85);
    const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS || 8);

    const alerts = [];
    const wasActive = onlineHours > 0 || ridesCount > 0;

    if (wasActive) {
      if (netHourly < MIN_HOURLY)
        alerts.push({ type: 'danger',  code: 'low_hourly',   msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });

      if (netRevenue < MIN_REVENUE)
        alerts.push({ type: 'warning', code: 'low_revenue',  msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });

      if (kmDriven < MIN_KM)
        alerts.push({ type: 'warning', code: 'low_km',       msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });

      if (kmDriven > MAX_KM)
        alerts.push({ type: 'info',    code: 'high_km',      msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });

      if (acceptRate < MIN_ACCEPT && ridesCount > 0)
        alerts.push({ type: 'danger',  code: 'low_accept',   msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });

      if (drivingHours < MIN_DRIVE_HRS)
        alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    // Alarm za smjenu — ako je dodijeljena smjena a status je 'missed'
    if (shiftStatus === 'missed')
      alerts.push({ type: 'danger', code: 'shift_missed', msg: `Nije odradio smjenu (${assignedShiftName || 'zadana smjena'})` });

    results.push({
      id:            driver.id,
      name:          `${driver.first_name} ${driver.last_name}`,
      phone:         driver.phone || '-',
      date,
      // Financije — sve NETO (nakon Bolt provizije)
      netRevenue:    Math.round(netRevenue    * 100) / 100,
      netHourly:     Math.round(netHourly     * 100) / 100,
      // Sati
      onlineHours:   Math.round(onlineHours   * 10) / 10,
      drivingHours:  Math.round(drivingHours  * 10) / 10,
      // Ostalo
      kmDriven:      Math.round(kmDriven      * 10) / 10,
      acceptRate:    Math.round(acceptRate     * 10) / 10,
      ridesCount,
      // Smjena
      assignedShiftName,
      shiftStatus,
      // Alarmi
      alerts,
      hasAlerts: alerts.length > 0,
    });
  }

  return results;
}

module.exports = { buildDailyReport, getDrivers };
