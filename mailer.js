// mailer.js — Gmail dnevni izvještaj
const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// Formatiranje valute — EUR, hr-HR locale
function eur(val) {
  if (val == null || isNaN(val)) return '—';
  return new Intl.NumberFormat('hr-HR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(val);
}

function pct(val) {
  if (val == null || isNaN(val)) return '—';
  return val.toFixed(1) + '%';
}

function km(val) {
  if (val == null || isNaN(val)) return '—';
  return val.toFixed(0) + ' km';
}

function hrs(val) {
  if (val == null || isNaN(val)) return '—';
  const h = Math.floor(val);
  const m = Math.round((val - h) * 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function shiftBadgeHTML(driver) {
  const { assignedShiftName, shiftStatus } = driver;
  if (!assignedShiftName) return '<span style="color:#9CA3AF;">—</span>';

  const label = assignedShiftName;
  if (shiftStatus === 'completed')
    return `<span style="background:#D1FAE5;color:#065F46;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700;">✓ ${label}</span>`;
  if (shiftStatus === 'missed')
    return `<span style="background:#FEE2E2;color:#991B1B;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700;">✗ ${label}</span>`;
  return `<span style="background:#F3F4F6;color:#374151;padding:2px 8px;border-radius:4px;font-size:12px;">${label}</span>`;
}

function alertsHTML(alerts) {
  if (!alerts || alerts.length === 0)
    return '<span style="color:#059669;font-size:12px;font-weight:600;">✓ Bez alarma</span>';

  const colors = {
    danger:  { bg: '#FEE2E2', color: '#991B1B', icon: '🔴' },
    warning: { bg: '#FEF3C7', color: '#92400E', icon: '🟡' },
    info:    { bg: '#DBEAFE', color: '#1E40AF', icon: '🔵' },
  };

  return alerts.map(a => {
    const c = colors[a.type] || colors.info;
    return `<div style="background:${c.bg};color:${c.color};padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:3px;display:inline-block;margin-right:4px;">${c.icon} ${a.msg}</div>`;
  }).join('');
}

function metricCell(value, alert, alignRight = true) {
  const color = alert ? '#DC2626' : '#111827';
  const align = alignRight ? 'text-align:right;' : '';
  return `<td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;${align}color:${color};font-weight:${alert ? 700 : 500};">${value}</td>`;
}

function buildEmailHTML(drivers, date) {
  const active = drivers.filter(d => !d.error && (d.onlineHours > 0 || d.ridesCount > 0));

  const totalRevenue   = active.reduce((s, d) => s + (d.netRevenue   || 0), 0);
  const totalKm        = active.reduce((s, d) => s + (d.kmDriven     || 0), 0);
  const avgHourly      = active.length ? active.reduce((s, d) => s + (d.netHourly  || 0), 0) / active.length : 0;
  const avgAccept      = active.length ? active.reduce((s, d) => s + (d.acceptRate || 0), 0) / active.length : 0;
  const totalAlerts    = drivers.reduce((s, d) => s + (d.alerts?.length || 0), 0);
  const driversAlerts  = drivers.filter(d => d.hasAlerts).length;

  // Formatiraj datum za prikaz: "ponedjeljak, 16. lipnja 2025."
  const dateObj = new Date(date + 'T12:00:00');
  const dateCroatian = dateObj.toLocaleDateString('hr-HR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const driversRows = drivers.map(d => {
    if (d.error) {
      return `<tr>
        <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;font-weight:600;">${d.name}</td>
        <td colspan="8" style="padding:12px 14px;border-bottom:1px solid #E5E7EB;color:#9CA3AF;font-style:italic;">Podaci nisu dostupni</td>
      </tr>`;
    }

    const alertCodes = new Set((d.alerts || []).map(a => a.code));
    const rowBg = d.hasAlerts ? 'background:#FFFBEB;' : '';

    return `<tr style="${rowBg}">
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;">
        <div style="font-weight:700;color:#111827;">${d.name}</div>
        <div style="font-size:12px;color:#6B7280;">${d.phone}</div>
      </td>
      ${metricCell(eur(d.netRevenue),  alertCodes.has('low_revenue'))}
      ${metricCell(eur(d.netHourly) + '/h', alertCodes.has('low_hourly'))}
      ${metricCell(hrs(d.onlineHours),  false)}
      ${metricCell(hrs(d.drivingHours), alertCodes.has('low_drive_hrs'))}
      ${metricCell(km(d.kmDriven),      alertCodes.has('low_km') || alertCodes.has('high_km'))}
      ${metricCell(pct(d.acceptRate),   alertCodes.has('low_accept'))}
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:center;">${shiftBadgeHTML(d)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;min-width:220px;">${alertsHTML(d.alerts)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="hr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:1000px;margin:0 auto;padding:24px;">

  <!-- Header -->
  <div style="background:#1C1C2E;border-radius:12px 12px 0 0;padding:28px 32px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:22px;font-weight:800;color:white;">⚡ Bolt Fleet — Dnevni izvještaj</div>
        <div style="color:#9CA3AF;margin-top:6px;font-size:15px;">${dateCroatian}</div>
      </div>
      ${totalAlerts > 0
        ? `<div style="background:#DC2626;color:white;padding:8px 18px;border-radius:20px;font-weight:700;">⚠️ ${totalAlerts} alarm${totalAlerts === 1 ? '' : 'a'} · ${driversAlerts} vozač${driversAlerts === 1 ? '' : 'a'}</div>`
        : `<div style="background:#059669;color:white;padding:8px 18px;border-radius:20px;font-weight:700;">✓ Sve u redu</div>`
      }
    </div>
  </div>

  <!-- Summary strip -->
  <div style="background:#34D399;padding:18px 32px;display:flex;gap:0;flex-wrap:wrap;">
    ${[
      ['Ukupni neto', eur(totalRevenue), `${active.length} aktivnih vozača`],
      ['Prosj. neto/sat', eur(avgHourly) + '/h', 'prosjek flote'],
      ['Ukupno km', km(totalKm), `prosj. ${km(totalKm / (active.length || 1))} / vozač`],
      ['Prosj. prihvaćenost', pct(avgAccept), 'prosjek flote'],
    ].map(([ label, value, sub ], i) => `
      <div style="${i > 0 ? 'border-left:1px solid #10B981;padding-left:28px;margin-left:28px;' : ''}">
        <div style="font-size:11px;font-weight:700;color:#064E3B;text-transform:uppercase;letter-spacing:.5px;">${label}</div>
        <div style="font-size:22px;font-weight:800;color:#064E3B;">${value}</div>
        <div style="font-size:12px;color:#047857;">${sub}</div>
      </div>`).join('')}
  </div>

  <!-- Table -->
  <div style="background:white;border-radius:0 0 12px 12px;overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;min-width:780px;">
      <thead>
        <tr style="background:#F9FAFB;">
          ${['Vozač','Neto promet','Neto/sat','Online sati','Sati u vožnji','Kilometraža','Prihvaćenost','Smjena','Alarmi']
            .map((h, i) => `<th style="padding:10px 14px;text-align:${i > 0 && i < 7 ? 'right' : i === 7 ? 'center' : 'left'};font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #E5E7EB;">${h}</th>`)
            .join('')}
        </tr>
      </thead>
      <tbody>${driversRows}</tbody>
    </table>
  </div>

  <!-- Legenda alarma -->
  <div style="background:white;border-radius:12px;padding:18px 24px;margin-top:16px;border:1px solid #E5E7EB;">
    <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Legenda alarma</div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;">
      <span>🔴 <strong>Kritično</strong> — neto/sat &lt; ${process.env.ALERT_MIN_NET_HOURLY || 15} €/h · prihvaćenost &lt; ${process.env.ALERT_MIN_ACCEPTANCE || 85}% · smjena propuštena</span>
      <span>🟡 <strong>Upozorenje</strong> — promet &lt; ${process.env.ALERT_MIN_NET_REVENUE || 180} € · km &lt; ${process.env.ALERT_MIN_KM || 150} · vožnja &lt; ${process.env.ALERT_MIN_DRIVING_HRS || 8}h</span>
      <span>🔵 <strong>Info</strong> — km &gt; ${process.env.ALERT_MAX_KM || 300}</span>
    </div>
  </div>

  <div style="text-align:center;padding:16px;color:#9CA3AF;font-size:12px;margin-top:8px;">
    Bolt Fleet Dashboard · Automatski izvještaj · ${new Date().toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' })}
  </div>
</div>
</body>
</html>`;
}

async function sendDailyReport(drivers, date) {
  const transporter = createTransport();

  // Sve tri adrese
  const recipients = process.env.REPORT_RECIPIENTS
    || 'patricia.enterpomak@gmail.com,info.enterpomak@gmail.com,vidovic.perica84@gmail.com';

  const totalAlerts = drivers.reduce((s, d) => s + (d.alerts?.length || 0), 0);
  const active = drivers.filter(d => !d.error && (d.onlineHours > 0 || d.ridesCount > 0));
  const totalRevenue = active.reduce((s, d) => s + (d.netRevenue || 0), 0);

  const dateObj = new Date(date + 'T12:00:00');
  const shortDate = dateObj.toLocaleDateString('hr-HR', { day: 'numeric', month: 'numeric', year: 'numeric' });

  const subject = totalAlerts > 0
    ? `⚠️ Bolt Fleet ${shortDate} — ${totalAlerts} alarm${totalAlerts === 1 ? '' : 'a'} | Neto: ${totalRevenue.toFixed(2)} €`
    : `✅ Bolt Fleet ${shortDate} — Sve u redu | Neto: ${totalRevenue.toFixed(2)} €`;

  await transporter.sendMail({
    from: `"Bolt Fleet Dashboard" <${process.env.GMAIL_USER}>`,
    to: recipients,
    subject,
    html: buildEmailHTML(drivers, date),
  });

  console.log(`📧 Izvještaj poslan: ${subject}`);
  console.log(`   Primatelji: ${recipients}`);
}

module.exports = { sendDailyReport };
