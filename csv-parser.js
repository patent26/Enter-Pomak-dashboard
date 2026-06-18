// csv-parser.js — Parsira Bolt Fleet CSV izvještaje
// Podržava: "Povijest vožnji" i "Evidencija aktivnosti" CSV

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function pf(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
}

// ── Parser 1: "Povijest vožnji" ───────────────────────────────
// Stupci: Datum, Cijena finalizirana, Kreirano od, Vozač, Reg, Model,
//         Ruta, Vozač stigao, Završena, Dolazak(min), Trajanje(min),
//         Kategorija, Status, Opcionalne, Udaljenost|km, Napojnice|€,
//         Cijena vožnje|€, Plaćanje, Naknada rezerv.|€, Cestarina|€,
//         Otkazna naknada|€, Tel, UUID, Vrsta
function parseRidesCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Rides CSV je prazan');

  const driverMap = {};
  let csvDate = null;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 13) continue;

    const dateStr    = row[0]?.trim();
    const driverName = row[3]?.trim();
    const phone      = row[21]?.trim();
    if (!driverName) continue;

    // Izvuci datum iz prvog stupca (format: "2026-06-17 HH:MM")
    if (!csvDate && dateStr) csvDate = dateStr.split(' ')[0];

    const status      = row[12]?.trim();
    const distanceKm  = pf(row[14]);
    const ridePrice   = pf(row[16]);
    const cancelFee   = pf(row[20]);
    const drivingMin  = pf(row[10]);

    if (!driverMap[driverName]) {
      driverMap[driverName] = {
        name: driverName, phone: phone || '-',
        completed: 0, userCancelled: 0, userNoShow: 0,
        driverCancelled: 0, driverRejected: 0, driverNoResponse: 0,
        totalKm: 0, grossRevenue: 0, drivingMin: 0,
      };
    }

    const d = driverMap[driverName];
    if      (status === 'Završeno')               { d.completed++;       d.totalKm += distanceKm; d.grossRevenue += ridePrice; d.drivingMin += drivingMin; }
    else if (status === 'Putnik je otkazao')       { d.userCancelled++;   d.grossRevenue += cancelFee; }
    else if (status === 'Putnik se nije pojavio')  { d.userNoShow++;      d.grossRevenue += cancelFee; }
    else if (status === 'Vozač je otkazao')        { d.driverCancelled++; }
    else if (status === 'Vozač je odbio')          { d.driverRejected++;  }
    else if (status === 'Vozač nije odgovorio')    { d.driverNoResponse++; }
  }

  return { driverMap, csvDate };
}

// ── Parser 2: "Evidencija aktivnosti" / "Shift activity log" ──
// Stupci: Datum, Vozač, Vozilo, Detalji smjene, Ukupno trajanje smjene,
//         Trajanje smjene, Vrijeme na mreži (min), Aktivno vrijeme na mreži (min),
//         Trajanje odmora (min), Ukupni broj vožnji, Završeno, Korisnik otkazao,
//         Vozač otkazao, Ukupna plaćanja, ...
function parseActivityCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Activity CSV je prazan');

  const driverMap = {};
  let csvDate = null;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 8) continue;

    const dateStr    = row[0]?.trim();
    const driverName = row[1]?.trim();
    if (!driverName) continue;

    if (!csvDate && dateStr) csvDate = dateStr.split(' ')[0]?.split('.').reverse().join('-') || dateStr.split(' ')[0];

    const onlineMin  = pf(row[6]);  // Vrijeme na mreži (min)
    const activeMin  = pf(row[7]);  // Aktivno vrijeme na mreži (min)

    if (!driverMap[driverName]) {
      driverMap[driverName] = { name: driverName, onlineMin: 0, activeMin: 0 };
    }

    driverMap[driverName].onlineMin += onlineMin;
    driverMap[driverName].activeMin += activeMin;
  }

  return { driverMap, csvDate };
}

// ── Prepoznaj tip CSV-a po zaglavlju ───────────────────────────
function detectCSVType(csvText) {
  const firstLine = csvText.split('\n')[0].toLowerCase();
  if (firstLine.includes('status') || firstLine.includes('udaljenost') || firstLine.includes('ruta')) return 'rides';
  if (firstLine.includes('aktivno') || firstLine.includes('smjena') || firstLine.includes('shift')) return 'activity';
  // Fallback po nazivu (ne možemo znati ovdje, ali pokušaj rides)
  return 'rides';
}

// ── Kombinirani report iz oba CSV-a ───────────────────────────
function buildCombinedReport(ridesData, activityData, date) {
  const BOLT_COMMISSION = parseFloat(process.env.BOLT_COMMISSION || 0.27);
  const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY   || 15);
  const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE  || 180);
  const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM           || 150);
  const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM           || 300);
  const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE   || 85);
  const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS  || 8);

  // Spoji sve vozače iz oba CSV-a
  const allNames = new Set([
    ...Object.keys(ridesData || {}),
    ...Object.keys(activityData || {}),
  ]);

  const results = [];

  for (const name of allNames) {
    const r = ridesData?.[name]   || {};
    const a = activityData?.[name] || {};

    const grossRevenue = r.grossRevenue || 0;
    const netRevenue   = grossRevenue * (1 - BOLT_COMMISSION);
    const kmDriven     = r.totalKm || 0;

    // Sati — preferiramo activity CSV (točniji), fallback na rides
    const onlineHours  = a.onlineMin ? a.onlineMin / 60 : (r.drivingMin || 0) / 60 * 1.05;
    const drivingHours = a.activeMin ? a.activeMin / 60 : (r.drivingMin || 0) / 60;

    const netHourly   = onlineHours > 0 ? netRevenue / onlineHours : 0;
    const utilisation = onlineHours > 0 ? (drivingHours / onlineHours) * 100 : 0;

    // Acceptance rate iz rides CSV-a
    const accepted  = (r.completed || 0) + (r.userCancelled || 0) + (r.userNoShow || 0) + (r.driverCancelled || 0);
    const rejected  = (r.driverRejected || 0) + (r.driverNoResponse || 0);
    const acceptRate = (accepted + rejected) > 0 ? (accepted / (accepted + rejected)) * 100 : 100;

    const ridesCount = r.completed || 0;
    const wasActive  = ridesCount > 0 || onlineHours > 0;

    const alerts = [];
    if (wasActive) {
      if (netHourly    < MIN_HOURLY)              alerts.push({ type: 'danger',  code: 'low_hourly',    msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });
      if (netRevenue   < MIN_REVENUE)             alerts.push({ type: 'warning', code: 'low_revenue',   msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });
      if (kmDriven > 0 && kmDriven < MIN_KM)      alerts.push({ type: 'warning', code: 'low_km',        msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (kmDriven > MAX_KM)                      alerts.push({ type: 'info',    code: 'high_km',       msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (acceptRate  < MIN_ACCEPT)               alerts.push({ type: 'danger',  code: 'low_accept',    msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });
      if (drivingHours < MIN_DRIVE_HRS)           alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    results.push({
      id:              name.replace(/\s/g, '_'),
      name,
      phone:           r.phone || '-',
      date,
      netRevenue:      Math.round(netRevenue    * 100) / 100,
      grossRevenue:    Math.round(grossRevenue  * 100) / 100,
      netHourly:       Math.round(netHourly     * 100) / 100,
      onlineHours:     Math.round(onlineHours   * 10)  / 10,
      drivingHours:    Math.round(drivingHours  * 10)  / 10,
      kmDriven:        Math.round(kmDriven      * 10)  / 10,
      acceptRate:      Math.round(acceptRate    * 10)  / 10,
      utilisation:     Math.round(utilisation   * 10)  / 10,
      ridesCount,
      completed:       r.completed        || 0,
      userCancelled:   r.userCancelled    || 0,
      userNoShow:      r.userNoShow       || 0,
      driverCancelled: r.driverCancelled  || 0,
      driverRejected:  r.driverRejected   || 0,
      driverNoResponse: r.driverNoResponse || 0,
      assignedShiftName: null, shiftStatus: null,
      alerts, hasAlerts: alerts.length > 0,
    });
  }

  results.sort((a, b) => (b.hasAlerts - a.hasAlerts) || (b.netRevenue - a.netRevenue));
  return results;
}

// Legacy exports
function parseCSV(t) { return {}; }
function buildReportFromCSV(d, date) { return []; }
function parseRidesCSV(t) { return parseRidesCSVFull(t); }
function parseRidesCSVFull(t) { const { driverMap } = parseRidesCSVWithDate(t); return driverMap; }
function parseRidesCSVWithDate(t) { return { driverMap: parseRidesCSVInternal(t), csvDate: null }; }
function parseRidesCSVInternal(csvText) {
  const { driverMap } = parseRidesCSV(csvText);
  return driverMap;
}
function buildReportFromRidesCSV(driverMap, date) {
  return buildCombinedReport(driverMap, null, date);
}

module.exports = {
  parseRidesCSV,
  parseActivityCSV,
  detectCSVType,
  buildCombinedReport,
  // Legacy
  parseCSV,
  buildReportFromCSV,
  buildReportFromRidesCSV,
};
