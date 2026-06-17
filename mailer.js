// mailer.js — Resend email service
const https = require('https');

function sendViaResend(to, subject, html) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      from: 'Bolt Fleet Dashboard <onboarding@resend.dev>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(body);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`Resend greška ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function eur(val) {
  if (val == null || isNaN(val)) return '—';
  return new Intl.NumberFormat('hr-HR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(val);
}
function pct(val) { return (val == null || isNaN(val)) ? '—' : val.toFixed(1) + '%'; }
function km(val)  { return (val == null || isNaN(val)) ? '—' : val.toFixed(0) + ' km'; }
function hrs(val) {
  if (!val || val === 0) return '0h';
  const h = Math.floor(val), m = Math.round((val - h) * 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function buildEmailHTML(drivers, date) {
  const active = drivers.filter(d => !d.error && (d.onlineHours > 0 || d.ridesCount > 0));
  const totalRevenue  = active.reduce((s, d) => s + (d.netRevenue || 0), 0);
  const totalKm       = active.reduce((s, d) => s + (d.kmDriven  || 0), 0);
  const avgAccept     = active.length ? active.reduce((s, d) => s + (d.acceptRate || 0), 0) / active.length : 0;
  const totalAlerts   = drivers.reduce((s, d) => s + (d.alerts?.length || 0), 0);
  const driversAlerts = drivers.filter(d => d.hasAlerts).length;

  const dateObj = new Date(date + 'T12:00:00');
  const dateCroatian = dateObj.toLocaleDateString('hr-HR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const colors = { danger: { bg: '#FEE2E2', color: '#991B1B', icon: '🔴' }, warning: { bg: '#FEF3C7', color: '#92400E', icon: '🟡' }, info: { bg: '#DBEAFE', color: '#1E40AF', icon: '🔵' } };

  const driversRows = drivers.map(d => {
    if (d.error) return `<tr><td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;font-weight:600;">${d.name}</td><td colspan="8" style="padding:12px 14px;border-bottom:1px solid #E5E7EB;color:#9CA3AF;font-style:italic;">Podaci nisu dostupni</td></tr>`;

    const alertCodes = new Set((d.alerts || []).map(a => a.code));
    const rowBg = d.hasAlerts ? 'background:#FFFBEB;' : '';
    const alertsHTML = d.alerts?.length
      ? d.alerts.map(a => { const c = colors[a.type] || colors.info; return `<div style="background:${c.bg};color:${c.color};padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:3px;display:inline-block;margin-right:4px;">${c.icon} ${a.msg}</div>`; }).join('')
      : '<span style="color:#059669;font-size:12px;font-weight:600;">✓ Bez alarma</span>';

    return `<tr style="${rowBg}">
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;"><div style="font-weight:700;">${d.name}</div><div style="font-size:12px;color:#6B7280;">${d.phone}</div></td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;color:${alertCodes.has('low_revenue') ? '#D97706' : '#111827'};font-weight:${alertCodes.has('low_revenue') ? 700 : 500};">${eur(d.netRevenue)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;color:${alertCodes.has('low_hourly') ? '#DC2626' : '#111827'};font-weight:${alertCodes.has('low_hourly') ? 700 : 500};">${eur(d.netHourly)}/h</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;">${hrs(d.onlineHours)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;color:${alertCodes.has('low_drive_hrs') ? '#D97706' : '#111827'};font-weight:${alertCodes.has('low_drive_hrs') ? 700 : 500};">${hrs(d.drivingHours)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;color:${alertCodes.has('low_km') || alertCodes.has('high_km') ? '#D97706' : '#111827'};font-weight:${alertCodes.has('low_km') || alertCodes.has('high_km') ? 700 : 500};">${km(d.kmDriven)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;color:${alertCodes.has('low_accept') ? '#DC2626' : '#111827'};font-weight:${alertCodes.has('low_accept') ? 700 : 500};">${pct(d.acceptRate)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;text-align:right;">${pct(d.utilisation)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #E5E7EB;min-width:200px;">${alertsHTML}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:1000px;margin:0 auto;padding:24px;">
  <div style="background:#1C1C2E;border-radius:12px 12px 0 0;padding:28px 32px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div><div style="font-size:22px;font-weight:800;color:white;">⚡ Bolt Fleet — Dnevni izvještaj</div>
      <div style="color:#9CA3AF;margin-top:6px;">${dateCroatian}</div></div>
      ${totalAlerts > 0 ? `<div style="background:#DC2626;color:white;padding:8px 18px;border-radius:20px;font-weight:700;">⚠️ ${totalAlerts} alarm${totalAlerts === 1 ? '' : 'a'} · ${driversAlerts} vozač${driversAlerts === 1 ? '' : 'a'}</div>` : `<div style="background:#059669;color:white;padding:8px 18px;border-radius:20px;font-weight:700;">✓ Sve u redu</div>`}
    </div>
  </div>
  <div style="background:#34D399;padding:18px 32px;display:flex;gap:28px;flex-wrap:wrap;">
    <div><div style="font-size:11px;font-weight:700;color:#064E3B;text-transform:uppercase;">Ukupni neto</div><div style="font-size:22px;font-weight:800;color:#064E3B;">${eur(totalRevenue)}</div></div>
    <div style="border-left:1px solid #10B981;padding-left:28px;"><div style="font-size:11px;font-weight:700;color:#064E3B;text-transform:uppercase;">Ukupno km</div><div style="font-size:22px;font-weight:800;color:#064E3B;">${km(totalKm)}</div></div>
    <div style="border-left:1px solid #10B981;padding-left:28px;"><div style="font-size:11px;font-weight:700;color:#064E3B;text-transform:uppercase;">Prosj. prihvaćenost</div><div style="font-size:22px;font-weight:800;color:#064E3B;">${pct(avgAccept)}</div></div>
    <div style="border-left:1px solid #10B981;padding-left:28px;"><div style="font-size:11px;font-weight:700;color:#064E3B;text-transform:uppercase;">Vozači</div><div style="font-size:22px;font-weight:800;color:#064E3B;">${active.length}</div></div>
  </div>
  <div style="background:white;border-radius:0 0 12px 12px;overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;min-width:780px;">
      <thead><tr style="background:#F9FAFB;">
        ${['Vozač','Neto promet','Neto/sat','Online sati','Sati u vožnji','Km','Prihvaćenost','Utilisation','Alarmi']
          .map((h,i) => `<th style="padding:10px 14px;text-align:${i===0||i===8?'left':'right'};font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;border-bottom:2px solid #E5E7EB;">${h}</th>`)
          .join('')}
      </tr></thead>
      <tbody>${driversRows}</tbody>
    </table>
  </div>
  <div style="text-align:center;padding:16px;color:#9CA3AF;font-size:12px;margin-top:8px;">
    Bolt Fleet Dashboard · ${new Date().toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' })}
  </div>
</div>
</body></html>`;
}

async function sendDailyReport(drivers, date) {
  const recipients = (process.env.REPORT_RECIPIENTS || 'patricia.enterpomak@gmail.com,info.enterpomak@gmail.com,vidovic.perica84@gmail.com').split(',').map(e => e.trim());
  const totalAlerts = drivers.reduce((s, d) => s + (d.alerts?.length || 0), 0);
  const active = drivers.filter(d => !d.error && (d.onlineHours > 0 || d.ridesCount > 0));
  const totalRevenue = active.reduce((s, d) => s + (d.netRevenue || 0), 0);

  const dateObj = new Date(date + 'T12:00:00');
  const shortDate = dateObj.toLocaleDateString('hr-HR', { day: 'numeric', month: 'numeric', year: 'numeric' });

  const subject = totalAlerts > 0
    ? `⚠️ Bolt Fleet ${shortDate} — ${totalAlerts} alarm${totalAlerts === 1 ? '' : 'a'} | Neto: ${totalRevenue.toFixed(2)} €`
    : `✅ Bolt Fleet ${shortDate} — Sve u redu | Neto: ${totalRevenue.toFixed(2)} €`;

  const html = buildEmailHTML(drivers, date);

  // Resend šalje samo na jednu adresu po pozivu na besplatnom planu
  // pa šaljemo svima odjednom u to[] array
  await sendViaResend(recipients, subject, html);
  console.log(`📧 Izvještaj poslan na: ${recipients.join(', ')}`);
}

module.exports = { sendDailyReport };
