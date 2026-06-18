// csv-parser.js — Parsira Bolt Fleet "Povijest vožnji" CSV
// Stupci: Datum, Cijena finalizirana, Kreirano od, Vozač, Reg. oznaka, Model,
//         Ruta, Vozač stigao, Vožnja završena, Trajanje dolaska (min), Trajanje vožnje (min),
//         Kategorija, Status, Opcionalne vožnje, Udaljenost|km, Napojnice|€, Cijena vožnje|€,
//         Način plaćanja, Naknade rezervaciju|€, Cestarina|€, Otkazne naknade|€,
//         Tel. broj vozača, Jedinstveni identifikator, Vrsta

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

function parseFloat2(val) {
  if (!val) return 0;
  return parseFloat(val.replace(',', '.')) || 0;
}

// Acceptance rate: vozač je prihvatio = sve osim "Vozač je odbio" i "Vozač nije odgovorio"
// Bolt formula: prihvaćeno / (prihvaćeno + odbijeno + nije odgovorio) * 100
function calcAcceptRate(stats) {
  const accepted = stats.completed + stats.userCancelled + stats.userNoShow + stats.driverCancelled;
  const rejected = stats.driverRejected + stats.driverNoResponse;
  const total = accepted + rejected;
  return total > 0 ? (accepted / total) * 100 : 100;
}

function parseRidesCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV je prazan');

  const driverMap = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 13) continue;

    const driverName = row[3]?.trim();
    const phone      = row[21]?.trim();
    if (!driverName) continue;

    const status      = row[12]?.trim();
    const distanceKm  = parseFloat2(row[14]);
    const ridePrice   = parseFloat2(row[16]);
    const cancelFee   = parseFloat2(row[20]);
    const drivingMin  = parseFloat2(row[10]);

    if (!driverMap[driverName]) {
      driverMap[driverName] = {
        name: driverName,
        phone: phone || '-',
        completed: 0,
        userCancelled: 0,
        userNoShow: 0,
        driverCancelled: 0,
        driverRejected: 0,
        driverNoResponse: 0,
        totalKm: 0,
        grossRevenue: 0,
        drivingMin: 0,
      };
    }

    const d = driverMap[driverName];

    // Kategorije statusa
    if (status === 'Završeno')              { d.completed++;      d.totalKm += distanceKm; d.grossRevenue += ridePrice; d.drivingMin += drivingMin; }
    else if (status === 'Putnik je otkazao') { d.userCancelled++;  d.grossRevenue += cancelFee; }
    else if (status === 'Putnik se nije pojavio') { d.userNoShow++; d.grossRevenue += cancelFee; }
    else if (status === 'Vozač je otkazao') { d.driverCancelled++; }
    else if (status === 'Vozač je odbio')   { d.driverRejected++;  }
    else if (status === 'Vozač nije odgovorio') { d.driverNoResponse++; }
  }

  return driverMap;
}

function buildReportFromRidesCSV(driverMap, date, onlineHoursMap = {}) {
  const results = [];

  const BOLT_COMMISSION = parseFloat(process.env.BOLT_COMMISSION || 0.27);
  const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY   || 15);
  const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE  || 180);
  const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM           || 150);
  const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM           || 300);
  const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE   || 85);
  const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS  || 8);

  for (const [name, d] of Object.entries(driverMap)) {
    const netRevenue   = d.grossRevenue * (1 - BOLT_COMMISSION);
    const kmDriven     = d.totalKm;
    const drivingHours = d.drivingMin / 60;

    // Online sati iz API-ja ako imamo, inače procjenimo
    const onlineHours  = onlineHoursMap[name] || drivingHours * 1.05;
    const netHourly    = onlineHours > 0 ? netRevenue / onlineHours : 0;
    const acceptRate   = calcAcceptRate(d);
    const utilisation  = onlineHours > 0 ? (drivingHours / onlineHours) * 100 : 0;
    const ridesCount   = d.completed;

    const totalRides = d.completed + d.userCancelled + d.userNoShow +
                       d.driverCancelled + d.driverRejected + d.driverNoResponse;

    const wasActive = ridesCount > 0 || totalRides > 0;
    const alerts = [];

    if (wasActive) {
      if (netHourly    < MIN_HOURLY)                   alerts.push({ type: 'danger',  code: 'low_hourly',    msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });
      if (netRevenue   < MIN_REVENUE)                  alerts.push({ type: 'warning', code: 'low_revenue',   msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });
      if (kmDriven     < MIN_KM && kmDriven > 0)       alerts.push({ type: 'warning', code: 'low_km',        msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (kmDriven     > MAX_KM)                       alerts.push({ type: 'info',    code: 'high_km',       msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (acceptRate   < MIN_ACCEPT)                   alerts.push({ type: 'danger',  code: 'low_accept',    msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });
      if (drivingHours < MIN_DRIVE_HRS)                alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    results.push({
      id:             name.replace(/\s/g, '_'),
      name,
      phone:          d.phone,
      date,
      netRevenue:     Math.round(netRevenue    * 100) / 100,
      grossRevenue:   Math.round(d.grossRevenue * 100) / 100,
      netHourly:      Math.round(netHourly     * 100) / 100,
      onlineHours:    Math.round(onlineHours   * 10)  / 10,
      drivingHours:   Math.round(drivingHours  * 10)  / 10,
      kmDriven:       Math.round(kmDriven      * 10)  / 10,
      acceptRate:     Math.round(acceptRate    * 10)  / 10,
      utilisation:    Math.round(utilisation   * 10)  / 10,
      ridesCount,
      totalRides,
      completed:      d.completed,
      userCancelled:  d.userCancelled,
      userNoShow:     d.userNoShow,
      driverCancelled: d.driverCancelled,
      driverRejected: d.driverRejected,
      driverNoResponse: d.driverNoResponse,
      assignedShiftName: null,
      shiftStatus: null,
      alerts,
      hasAlerts: alerts.length > 0,
    });
  }

  results.sort((a, b) => (b.hasAlerts - a.hasAlerts) || (b.netRevenue - a.netRevenue));
  return results;
}

// Za kompatibilnost — stari CSV parser
function parseCSV(csvText) { return {}; }
function buildReportFromCSV(d, date) { return []; }

module.exports = { parseRidesCSV, buildReportFromRidesCSV, parseCSV, buildReportFromCSV };
