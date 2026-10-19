# AJ's Roadside Assistance — Booking Website

Customers pick a service, choose ASAP or a scheduled time, share their location and vehicle, see an itemized price, pay by card (Square), and you get an email with every detail.

- **Customer site:** `https://your-site.com/`
- **Owner dashboard:** `https://your-site.com/admin` — set rates, mileage, fees, Square, email, and manage bookings.

No third-party packages — it only needs **Node.js 18 or newer**.

---

## 1. Run it

```bash
ADMIN_PASSWORD="pick-a-strong-password" TZ="America/Detroit" node server.js
```

Open http://localhost:3000 (site) and http://localhost:3000/admin (dashboard).

| Setting | What it does |
|---|---|
| `ADMIN_PASSWORD` | **Required.** Your dashboard password. |
| `TZ` | Your time zone — used for business hours / after-hours fee. |
| `PORT` | Port to listen on (default 3000). Most hosts set this for you. |
| `DATA_DIR` | Where settings and bookings are saved (default `./data`). Point it at a persistent disk on your host. |

## 2. Put it online

Any host that runs Node works. Easy options:

- **Render.com** – New → Web Service → upload this folder (or connect a GitHub repo). Start command `node server.js`. Add the environment variables above. Add a **Disk** mounted at `/var/data` and set `DATA_DIR=/var/data` so bookings and settings survive restarts.
- **Railway.app** – similar: deploy, set variables, attach a volume, set `DATA_DIR` to its mount path.
- **Your own VPS** – run with `pm2` or systemd behind Nginx/Caddy with HTTPS.

**HTTPS is required** for taking card payments in production and for "Use my location" on phones. Render and Railway provide it automatically.

## 3. Set up in the dashboard (`/admin`)

1. **Business info** – name, phone, tagline, and your **base address** (mileage is measured from here).
2. **Service rates** – price for each service, fuel price per gallon, turn services on/off.
3. **Mileage & fees** – price per mile, free miles included, max distance, round-trip option, ASAP fee, after-hours fee, business hours, sales tax.
4. **Email alerts** – bookings go to `quincyquerfurth97@gmail.com` by default. To send them, enter a Gmail address and a **Gmail app password**:
   - Turn on 2-Step Verification in your Google account.
   - Visit https://myaccount.google.com/apppasswords, create one named "Booking website", paste the 16 characters.
   - Click **Send test email**.
5. **Square payments**
   - Go to https://developer.squareup.com/apps, sign in with your Square account, **Create an application**.
   - From **Credentials** copy the **Application ID** and **Access token**; from **Locations** copy the **Location ID**.
   - Start in **Sandbox** mode and test with card `4111 1111 1111 1111`, any future date, CVV `111`, ZIP `12345`.
   - When it works, switch to the **Production** credentials and mode.
   - Choose **Charge immediately** or **Hold at booking, charge when job is done** (you then click "Charge card" on the booking).

Until Square is linked, bookings still come through but are marked "payment not collected".

## How pricing works

```
Service price
+ fuel (gallons × price per gallon)          fuel delivery only
+ (miles − free miles) × price per mile      driving distance from your base
+ ASAP fee                                    if set and customer picks ASAP
+ after-hours fee                             if the job time is outside business hours
+ sales tax %
= Total  (shown to the customer before they book; recalculated on the server)
```

Driving distance comes from the free OpenStreetMap routing service; if it's unreachable, the site uses straight-line distance + 25%. Addresses are looked up with OpenStreetMap Nominatim.

## Security notes

- Card numbers never touch your server — Square's secure form turns them into a one-time token.
- Your Square access token and Gmail app password are stored only in `data/settings.json` on your server. Keep that folder private and backed up.
- Prices are always recalculated on the server, so customers can't change what they're charged.
- Logins are rate-limited (5 tries / 15 min).

## Files

```
server.js          web server, pricing, Square, bookings, dashboard API
lib/mailer.js      sends email (SMTP)
public/index.html  customer booking page
public/book.js     booking page logic
public/admin.html  owner dashboard
public/styles.css  styles
data/              settings.json + bookings.json (created automatically)
```
