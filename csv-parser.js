// csv-parser.js — Parsira Bolt Fleet CSV izvještaj
// Format: Datum, Vozač, Vozilo, Detalji, Ukupno trajanje smjene, Trajanje smjene,
//         Vrijeme na mreži (min), Aktivno vrijeme na mreži (min), Trajanje odmora (min),
//         Ukupni broj vožnji, Završeno, Korisnik je otkazao, Vozač je otkazao,
//         Ukupna plaćanja, Gotovina, Terminal za kartice, Aplikacijsko plaćanje, Business

function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV je prazan');

  // Parse header
  const header = parseCSVLine(lines[0]);

  // Group rows by driver name
  const driverMap = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 10) continue;

    const driverName    = row[1]?.trim();
    if (!driverName) continue;

    const onlineMin     = parseFloat(row[6])  || 0; // Vrijeme na mreži (min)
    const activeMin     = parseFloat(row[7])  || 0; // Aktivno vrijeme na mreži (min)
    const breakMin      = parseFloat(row[8])  || 0; // Trajanje odmora (min)
    const totalRides    = parseInt(row[9])    || 0; // Ukupni broj vožnji
    const completed     = parseInt(row[10])   || 0; // Završeno
    const userCancelled = parseInt(row[11])   || 0; // Korisnik je otkazao
    const driverCancelled = parseInt(row[12]) || 0; // Vozač je otkazao
    const totalPayment  = parseFloat(row[13]?.replace(',', '.')) || 0; // Ukupna plaćanja

    if (!driverMap[driverName]) {
      driverMap[driverName] = {
        name: driverName,
        onlineMin: 0,
        activeMin: 0,
        breakMin: 0,
        totalRides: 0,
        completed: 0,
        userCancelled: 0,
        driverCancelled: 0,
        grossRevenue: 0,
        shifts: [],
      };
    }

    driverMap[driverName].onlineMin      += onlineMin;
    driverMap[driverName].activeMin      += activeMin;
    driverMap[driverName].breakMin       += breakMin;
    driverMap[driverName].totalRides     += totalRides;
    driverMap[driverName].completed      += completed;
    driverMap[driverName].userCancelled  += userCancelled;
    driverMap[driverName].driverCancelled += driverCancelled;
    driverMap[driverName].grossRevenue   += totalPayment;
    driverMap[driverName].shifts.push(row[5]?.trim()); // Trajanje smjene
  }

  return driverMap;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Bolt provizija — izračunaj neto iz bruta
// Bolt uzima ~27% provizije (može varirati)
// Bolje: neto = bruto * (1 - provizija)
// Ali iz CSV-a nemamo direktno neto, pa koristimo API neto ako imamo
// Inače procjenimo: neto ≈ bruto * 0.73
const BOLT_COMMISSION = parseFloat(process.env.BOLT_COMMISSION || 0.27);

function buildReportFromCSV(driverMap, date, apiDrivers = []) {
  const results = [];

  const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY   || 15);
  const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE  || 180);
  const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM           || 150);
  const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM           || 300);
  const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE   || 85);
  const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS  || 8);

  for (const [name, d] of Object.entries(driverMap)) {
    // Neto iz API-ja ako imamo, inače procjenimo
    const apiDriver = apiDrivers.find(a => a.name === name);
    const netRevenue = apiDriver?.netRevenue || d.grossRevenue * (1 - BOLT_COMMISSION);

    // Sati
    const onlineHours  = d.onlineMin / 60;
    const drivingHours = d.activeMin / 60; // Aktivno = u vožnji

    // Neto po satu
    const netHourly = onlineHours > 0 ? netRevenue / onlineHours : 0;

    // Acceptance rate = završeno / (završeno + vozač otkazao)
    const denominator = d.completed + d.driverCancelled;
    const acceptRate  = denominator > 0 ? (d.completed / denominator) * 100 : 100;

    // Utilisation = aktivno / online * 100
    const utilisation = d.onlineMin > 0 ? (d.activeMin / d.onlineMin) * 100 : 0;

    // Kilometraža iz API-ja (CSV nema km direktno)
    const kmDriven = apiDriver?.kmDriven || 0;

    const wasActive = d.completed > 0 || d.totalRides > 0;
    const alerts = [];

    if (wasActive) {
      if (netHourly    < MIN_HOURLY)                   alerts.push({ type: 'danger',  code: 'low_hourly',    msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });
      if (netRevenue   < MIN_REVENUE)                  alerts.push({ type: 'warning', code: 'low_revenue',   msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });
      if (kmDriven > 0 && kmDriven < MIN_KM)           alerts.push({ type: 'warning', code: 'low_km',        msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (kmDriven > MAX_KM)                           alerts.push({ type: 'info',    code: 'high_km',       msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (acceptRate   < MIN_ACCEPT)                   alerts.push({ type: 'danger',  code: 'low_accept',    msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });
      if (drivingHours < MIN_DRIVE_HRS)                alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    results.push({
      id:            name.replace(/\s/g, '_'),
      name,
      phone:         apiDriver?.phone || '-',
      date,
      netRevenue:    Math.round(netRevenue    * 100) / 100,
      grossRevenue:  Math.round(d.grossRevenue * 100) / 100,
      netHourly:     Math.round(netHourly     * 100) / 100,
      onlineHours:   Math.round(onlineHours   * 10)  / 10,
      drivingHours:  Math.round(drivingHours  * 10)  / 10,
      kmDriven:      Math.round(kmDriven      * 10)  / 10,
      acceptRate:    Math.round(acceptRate    * 10)  / 10,
      utilisation:   Math.round(utilisation   * 10)  / 10,
      ridesCount:    d.completed,
      totalRides:    d.totalRides,
      userCancelled: d.userCancelled,
      driverCancelled: d.driverCancelled,
      assignedShiftName: null,
      shiftStatus: null,
      alerts,
      hasAlerts: alerts.length > 0,
    });
  }

  results.sort((a, b) => (b.hasAlerts - a.hasAlerts) || (b.netRevenue - a.netRevenue));
  return results;
}

module.exports = { parseCSV, buildReportFromCSV };
