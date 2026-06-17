# ⚡ Bolt Fleet Dashboard — Upute za postavljanje

## Što aplikacija prati

Za svakog vozača, za prethodni dan:

| Metrika | Opis |
|---|---|
| **Neto promet** | Zarada NAKON Bolt provizije (€) |
| **Neto / sat** | Neto promet ÷ online sati (€/h) |
| **Online sati** | Ukupno vrijeme online u Bolt aplikaciji |
| **Sati u vožnji** | Stvarno vrijeme provedeno u vožnji s putnicima |
| **Kilometraža** | Ukupno odvezenih km |
| **Stopa prihvaćanja** | % prihvaćenih poziva |
| **Smjena** | Morning / Afternoon / Weekend Shift — odvezena ili propuštena |

## Alarmi

| Alarm | Uvjet | Razina |
|---|---|---|
| Neto/sat | < 15 €/h | 🔴 Kritično |
| Neto promet | < 180 € | 🟡 Upozorenje |
| Kilometraža premalo | < 150 km | 🟡 Upozorenje |
| Kilometraža previše | > 300 km | 🔵 Info |
| Stopa prihvaćanja | < 85% | 🔴 Kritično |
| Sati u vožnji | < 8 sati | 🟡 Upozorenje |
| Smjena propuštena | status = missed | 🔴 Kritično |

---

## Korak 1 — GitHub repo

1. Idi na [github.com](https://github.com) → **New repository**
2. Naziv: `bolt-fleet-dashboard` (može biti private)
3. Uploadaj sve fajlove iz ovog foldera

---

## Korak 2 — Gmail App lozinka

1. Google Account → **Sigurnost** → Dvostupanjska provjera (mora biti ON)
2. Traži **"App passwords"** (Lozinke za aplikacije)
3. Kreiraj novu → odaberi Mail → generiraj
4. Spremi 16-znakovnu lozinku — prikazuje se samo jednom!

---

## Korak 3 — Bolt Fleet API

1. Prijavi se na Bolt Fleet portal
2. Settings → API → kopiraj **API ključ** i **Fleet ID**

---

## Korak 4 — Deploy na Render.com

1. [render.com](https://render.com) → **New Web Service** → poveži GitHub repo
2. Render prepozna `render.yaml` automatski
3. Unesi u **Environment Variables**:

| Varijabla | Vrijednost |
|---|---|
| `BOLT_API_KEY` | Tvoj Bolt API ključ |
| `BOLT_FLEET_ID` | ID flote iz Bolt portala |
| `GMAIL_USER` | Gmail adresa s koje se šalje |
| `GMAIL_APP_PASSWORD` | 16-znakovna app lozinka |
| `DASHBOARD_PASSWORD` | Lozinka za pristup dashboardu |

Ostale varijable su već postavljene u render.yaml.

4. **Deploy** → za ~2 minute aplikacija je živa

---

## Korak 5 — Testiranje

- Otvori URL koji Render da (npr. `https://bolt-fleet-dashboard.onrender.com`)
- Odaberi jučerašnji datum
- Gumb **"Pošalji mail"** — provjeri dolazi li na sve 3 adrese
- Automatski dolazi svaki dan u **08:00 (Europe/Zagreb)**

---

## Mailovi idu na

- patricia.enterpomak@gmail.com
- info.enterpomak@gmail.com
- vidovic.perica84@gmail.com

*(Može se promijeniti u REPORT_RECIPIENTS varijabli bez ponovnog deploya)*

---

## Promjena pragova alarma

Sve se mijenja u Render → Environment Variables, bez promjene koda:

```
ALERT_MIN_NET_HOURLY=15      # €/h
ALERT_MIN_NET_REVENUE=180    # €
ALERT_MIN_KM=150             # km
ALERT_MAX_KM=300             # km
ALERT_MIN_ACCEPTANCE=85      # %
ALERT_MIN_DRIVING_HRS=8      # sati
```
