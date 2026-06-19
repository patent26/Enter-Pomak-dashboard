// csv-parser.js — Parsira Bolt Fleet CSV izvještaje

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
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

// Prepoznaj tip CSV-a po zaglavlju
function detectCSVType(csvText) {
  const first = csvText.split('\n')[0].toLowerCase();
  // Zarada CSV ima "neto zarada" i "provizija"
  if (first.includes('neto zarada') || first.includes('provizija') || first.includes('bruto zarada')) return 'earnings';
  // Performance CSV
  if (first.includes('efektivna') && first.includes('uspje')) return 'performance';
  // Rides CSV
  if (first.includes('ruta') || (first.includes('status') && first.includes('udaljenost'))) return 'rides';
  // Activity CSV
  if (first.includes('smjena') || first.includes('shift')) return 'activity';
  return 'rides';
}

// Parser: "Povijest vožnji" CSV
function parseRidesCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV je prazan');

  const driverMap = {};
  let csvDate = null;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 13) continue;

    const dateStr    = row[0]?.trim();
    const driverName = row[3]?.trim();
    const phone      = row[21]?.trim();
    if (!driverName) continue;

    // Datum iz prvog stupca — uzmi najmanji (prvi dan u CSV-u)
    if (dateStr && dateStr.match(/\d{4}-\d{2}-\d{2}/)) {
      const d = dateStr.split(' ')[0];
      if (!csvDate || d < csvDate) csvDate = d;
    }

    const status     = row[12]?.trim();
    const distanceKm = pf(row[14]);
    const ridePrice  = pf(row[16]);
    const cancelFee  = pf(row[20]);
    const drivingMin = pf(row[10]);

    if (!driverMap[driverName]) {
      driverMap[driverName] = {
        name: driverName, phone: phone || '-',
        completed: 0, userCancelled: 0, userNoShow: 0,
        driverCancelled: 0, driverRejected: 0, driverNoResponse: 0,
        totalKm: 0, grossRevenue: 0, drivingMin: 0,
      };
    }

    const d = driverMap[driverName];
    if      (status === 'Završeno')                   { d.completed++;       d.totalKm += distanceKm; d.grossRevenue += ridePrice; d.drivingMin += drivingMin; }
    else if (status === 'Putnik je otkazao')           { d.userCancelled++;   d.grossRevenue += cancelFee; }
    else if (status === 'Putnik se nije pojavio')      { d.userNoShow++;      d.grossRevenue += cancelFee; }
    else if (status === 'Vozač je otkazao')            { d.driverCancelled++; }
    else if (status === 'Vozač je odbio')              { d.driverRejected++;  }
    else if (status === 'Vozač nije odgovorio')        { d.driverNoResponse++; }
  }

  return { driverMap, csvDate };
}

// Parser: "Evidencija aktivnosti" CSV
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

    if (dateStr && !csvDate) {
      // Format može biti "17.06.2026" ili "2026-06-17"
      if (dateStr.match(/\d{4}-\d{2}-\d{2}/)) csvDate = dateStr.split(' ')[0];
      else if (dateStr.match(/\d{2}\.\d{2}\.\d{4}/)) {
        const parts = dateStr.split('.');
        csvDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }

    const onlineMin = pf(row[6]);
    const activeMin = pf(row[7]);

    if (!driverMap[driverName]) {
      driverMap[driverName] = { name: driverName, onlineMin: 0, activeMin: 0 };
    }
    driverMap[driverName].onlineMin += onlineMin;
    driverMap[driverName].activeMin += activeMin;
  }

  return { driverMap, csvDate };
}


// Parser: "Vozači Učinak" CSV — direktno Boltovi izračuni
// Stupci: Vozač, Status, Kategorije, Email, Telefon, Gotovina,
//         Uspješnost|%, Završene vožnje, Ukupna stopa prihvaćanja|%,
//         Efektivna stopa prihvaćanja|%, Vrijeme na mreži (min),
//         Aktivno vrijeme na mreži (min), Učinkovitost|%,
//         Stopa završenih (sve)|%, Stopa završenih (prihvaćene)|%,
//         Prosj. udaljenost|km, Ukupna udaljenost|km, Ocjena, ID, UUID
function parsePerformanceCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Performance CSV je prazan');

  const driverMap = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 17) continue;

    const driverName = row[0]?.trim();
    const phone      = row[4]?.trim();
    if (!driverName) continue;

    const ridesCount   = parseInt(row[7])  || 0;
    const acceptRate   = pf(row[8]);   // Ukupna stopa prihvaćanja
    const effectiveAcc = pf(row[9]);   // Efektivna stopa prihvaćanja
    const onlineMin    = pf(row[10]);  // Vrijeme na mreži (min)
    const activeMin    = pf(row[11]);  // Aktivno vrijeme na mreži (min)
    const utilisation  = pf(row[12]);  // Učinkovitost %
    const avgKm        = pf(row[15]);  // Prosj. udaljenost vožnje
    const totalKm      = pf(row[16]);  // Ukupna udaljenost vožnje

    if (!driverMap[driverName]) {
      driverMap[driverName] = {
        name: driverName,
        phone: phone || '-',
        ridesCount, acceptRate, effectiveAcc,
        onlineMin, activeMin, utilisation,
        avgKm, totalKm,
      };
    }
  }

  return { driverMap, csvDate: null };
}


// Parser: "Zarada po vozaču" CSV — ima SVE direktno iz Bolta
// Stupci: Vozač, Email, Telefon, Bruto(ukupno), Bruto(app), Bruto(gotovina),
//         Prikupljena gotovina, Napojnice, Promocije, Povrat, Otkazne, Cestarina,
//         Naknade rezerv., Ukupne naknade, Provizija, Povrati, Ostale naknade,
//         Neto zarada, Procijenjena isplata, Bruto/sat, Neto/sat,
//         Popust(app), Popust(gotovina), ID vozača, UUID, Razina, Kategorije,
//         Gotovina, Uspješnost, Završene vožnje, Ukupna prihvaćenost,
//         Efektivna prihvaćenost, Vrijeme na mreži(min), Aktivno(min),
//         Učinkovitost, Stopa završenih(sve), Stopa završenih(prihvaćene),
//         Prosj.km, Ukupno km, Ocjena
function parseEarningsCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Earnings CSV je prazan');

  const driverMap = {};

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 20) continue;

    const driverName = row[0]?.trim();
    const phone      = row[2]?.trim();
    if (!driverName) continue;

    driverMap[driverName] = {
      name:          driverName,
      phone:         phone || '-',
      grossRevenue:  pf(row[3]),   // Bruto zarada ukupno
      netRevenue:    pf(row[17]),  // Neto zarada
      netHourly:     pf(row[20]),  // Neto zarada po satu
      onlineMin:     pf(row[32]),  // Vrijeme na mreži (min)
      activeMin:     pf(row[33]),  // Aktivno vrijeme na mreži (min)
      utilisation:   pf(row[34]),  // Učinkovitost %
      ridesCount:    parseInt(row[29]) || 0,  // Završene vožnje
      acceptRate:    pf(row[30]),  // Ukupna stopa prihvaćanja %
      effectiveAcc:  pf(row[31]),  // Efektivna stopa prihvaćanja %
      totalKm:       pf(row[38]),  // Ukupna udaljenost vožnje
    };
  }

  return { driverMap, csvDate: null };
}

// Kombinirani report iz oba CSV-a
function buildCombinedReport(ridesData, activityData, date, performanceData = null, earningsData = null) {
  const BOLT_COMMISSION = parseFloat(process.env.BOLT_COMMISSION || 0.27);
  const MIN_HOURLY    = parseFloat(process.env.ALERT_MIN_NET_HOURLY   || 15);
  const MIN_REVENUE   = parseFloat(process.env.ALERT_MIN_NET_REVENUE  || 180);
  const MIN_KM        = parseFloat(process.env.ALERT_MIN_KM           || 150);
  const MAX_KM        = parseFloat(process.env.ALERT_MAX_KM           || 300);
  const MIN_ACCEPT    = parseFloat(process.env.ALERT_MIN_ACCEPTANCE   || 85);
  const MIN_DRIVE_HRS = parseFloat(process.env.ALERT_MIN_DRIVING_HRS  || 8);

  const allNames = new Set([
    ...Object.keys(ridesData      || {}),
    ...Object.keys(activityData   || {}),
    ...Object.keys(performanceData || {}),
    ...Object.keys(earningsData   || {}),
  ]);

  const results = [];

  for (const name of allNames) {
    const r = ridesData?.[name]      || {};
    const a = activityData?.[name]   || {};
    const p = performanceData?.[name] || {};
    const e = earningsData?.[name]   || {};

    // EARNINGS CSV ima prioritet — direktno Boltovi podaci
    const netRevenue   = e.netRevenue   || r.grossRevenue * (1 - BOLT_COMMISSION) || 0;
    const grossRevenue = e.grossRevenue || r.grossRevenue || 0;
    const kmDriven     = e.totalKm      || p.totalKm || r.totalKm || 0;

    // Sati — earnings > performance > activity > rides
    const onlineHours  = e.onlineMin  ? e.onlineMin / 60  : (p.onlineMin  ? p.onlineMin / 60  : (a.onlineMin  ? a.onlineMin / 60  : (r.drivingMin || 0) / 60 * 1.05));
    const drivingHours = e.activeMin  ? e.activeMin / 60  : (p.activeMin  ? p.activeMin / 60  : (a.activeMin  ? a.activeMin / 60  : (r.drivingMin || 0) / 60));

    // Neto/sat — direktno iz earnings CSV
    const netHourly   = e.netHourly || (onlineHours > 0 ? netRevenue / onlineHours : 0);
    const utilisation = e.utilisation || p.utilisation || (onlineHours > 0 ? (drivingHours / onlineHours) * 100 : 0);
    const acceptRate  = e.acceptRate !== undefined ? e.acceptRate : (p.acceptRate !== undefined ? p.acceptRate :
                       (() => {
                         const completed  = r.completed || 0;
                         const driverFail = (r.driverNoResponse || 0) + (r.driverCancelled || 0);
                         return (completed + driverFail) > 0 ? (completed / (completed + driverFail)) * 100 : 100;
                       })());
    const ridesCount = e.ridesCount || p.ridesCount || r.completed || 0;
    const wasActive  = ridesCount > 0 || onlineHours > 0;

    const alerts = [];
    if (wasActive) {
      if (netHourly    < MIN_HOURLY)             alerts.push({ type: 'danger',  code: 'low_hourly',    msg: `Neto/sat ispod ${MIN_HOURLY} € — iznosi ${netHourly.toFixed(2)} €/h` });
      if (netRevenue   < MIN_REVENUE)            alerts.push({ type: 'warning', code: 'low_revenue',   msg: `Neto promet ispod ${MIN_REVENUE} € — iznosi ${netRevenue.toFixed(2)} €` });
      if (kmDriven > 0 && kmDriven < MIN_KM)     alerts.push({ type: 'warning', code: 'low_km',        msg: `Ispod ${MIN_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (kmDriven > MAX_KM)                     alerts.push({ type: 'info',    code: 'high_km',       msg: `Više od ${MAX_KM} km — odvezeno ${kmDriven.toFixed(0)} km` });
      if (acceptRate  < MIN_ACCEPT)              alerts.push({ type: 'danger',  code: 'low_accept',    msg: `Prihvaćenost ispod ${MIN_ACCEPT}% — iznosi ${acceptRate.toFixed(1)}%` });
      if (drivingHours < MIN_DRIVE_HRS)          alerts.push({ type: 'warning', code: 'low_drive_hrs', msg: `Manje od ${MIN_DRIVE_HRS}h u vožnji — iznosi ${drivingHours.toFixed(1)}h` });
    }

    results.push({
      id:               name.replace(/\s/g, '_'),
      name,
      phone:            r.phone || '-',
      date,
      netRevenue:       Math.round(netRevenue    * 100) / 100,
      grossRevenue:     Math.round(grossRevenue  * 100) / 100,
      netHourly:        Math.round(netHourly     * 100) / 100,
      onlineHours:      Math.round(onlineHours   * 10)  / 10,
      drivingHours:     Math.round(drivingHours  * 10)  / 10,
      kmDriven:         Math.round(kmDriven      * 10)  / 10,
      acceptRate:       Math.round(acceptRate    * 10)  / 10,
      utilisation:      Math.round(utilisation   * 10)  / 10,
      ridesCount,
      completed:        r.completed         || 0,
      userCancelled:    r.userCancelled     || 0,
      userNoShow:       r.userNoShow        || 0,
      driverCancelled:  r.driverCancelled   || 0,
      driverRejected:   r.driverRejected    || 0,
      driverNoResponse: r.driverNoResponse  || 0,
      assignedShiftName: null, shiftStatus: null,
      alerts, hasAlerts: alerts.length > 0,
    });
  }

  results.sort((a, b) => (b.hasAlerts - a.hasAlerts) || (b.netRevenue - a.netRevenue));
  return results;
}

module.exports = { parseRidesCSV, parseActivityCSV, parsePerformanceCSV, parseEarningsCSV, detectCSVType, buildCombinedReport };
