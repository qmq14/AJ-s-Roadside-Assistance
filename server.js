// Roadside Assistance booking site — zero-dependency Node.js server (Node 18+)
// Run: ADMIN_PASSWORD=yourpassword node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendMail } = require('./lib/mailer');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('rs:' + ADMIN_PASSWORD).digest('hex');

if (ADMIN_PASSWORD === 'changeme') console.warn('\n⚠️  ADMIN_PASSWORD is not set — using "changeme". Set it before going live!\n');

// ---------------------------------------------------------------- storage
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  business: {
    name: "AJ's Roadside Assistance",
    phone: '(555) 555-0123',
    tagline: 'Fast, friendly roadside help — day or night.',
    baseAddress: '',
    baseLat: null,
    baseLng: null,
  },
  services: [
    { id: 'lockout', name: 'Lockout Service', description: 'Locked out? We\u2019ll get you back in your vehicle without damage.', price: 65, enabled: true, icon: 'key' },
    { id: 'jumpstart', name: 'Jump Start', description: 'Dead battery? We\u2019ll jump it and get you moving.', price: 55, enabled: true, icon: 'bolt' },
    { id: 'fuel', name: 'Fuel Delivery', description: 'Ran out of gas? We bring fuel to you.', price: 50, enabled: true, icon: 'fuel',
      perGallon: 5.5, maxGallons: 5, fuelTypes: ['Regular', 'Premium', 'Diesel'] },
    { id: 'air', name: 'Air Delivery', description: 'Low or flat tire? We\u2019ll inflate it on the spot.', price: 45, enabled: true, icon: 'air' },
    { id: 'fluid', name: 'Fluid Delivery', description: 'Oil, coolant, washer fluid and more, delivered.', price: 50, enabled: true, icon: 'drop',
      fluidTypes: ['Motor oil', 'Coolant / antifreeze', 'Windshield washer fluid', 'Brake fluid', 'Transmission fluid', 'Power steering fluid'] },
  ],
  mileage: {
    perMile: 2.5,       // $ per mile beyond the free miles
    freeMiles: 10,      // miles included in the base price
    maxMiles: 60,       // furthest you'll travel (0 = no limit)
    roundTrip: false,   // charge mileage both ways
  },
  fees: {
    asapFee: 0,         // extra charge for ASAP (priority) service
    afterHoursFee: 25,  // extra for jobs outside business hours
    businessStart: '07:00',
    businessEnd: '19:00',
    taxPercent: 0,
  },
  notifications: {
    toEmail: 'quincyquerfurth97@gmail.com',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    fromName: "AJ's Roadside Assistance Bookings",
    sendCustomerConfirmation: true,
  },
  square: {
    environment: 'sandbox', // 'sandbox' or 'production'
    applicationId: '',
    locationId: '',
    accessToken: '',
    captureMode: 'capture', // 'capture' = charge now, 'authorize' = hold now, charge when job is done
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const getSettings = () => deepMerge(DEFAULT_SETTINGS, readJSON(SETTINGS_FILE, {}));
const saveSettings = (s) => writeJSON(SETTINGS_FILE, s);
const getBookings = () => readJSON(BOOKINGS_FILE, []);
const saveBookings = (b) => writeJSON(BOOKINGS_FILE, b);

const squareReady = (s) => !!(s.square.applicationId && s.square.locationId && s.square.accessToken);
const emailReady = (s) => !!(s.notifications.smtpUser && s.notifications.smtpPass && s.notifications.toEmail);

// ---------------------------------------------------------------- geo
async function geocode(address) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(address);
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': 'RoadsideBookingSite/1.0' }, signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error('Our address lookup is temporarily unavailable. Tap “Use my location”, or try again in a moment.'); }
  if (!r.ok) throw new Error('Our address lookup is temporarily unavailable. Tap “Use my location”, or try again in a moment.');
  const j = await r.json();
  if (!j.length) return null;
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': 'RoadsideBookingSite/1.0' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return j.display_name || null;
  } catch { return null; }
}
function haversineMiles(a, b) {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function drivingMiles(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.routes && j.routes[0]) return { miles: j.routes[0].distance / 1609.344, method: 'driving' };
  } catch {}
  return { miles: haversineMiles(from, to) * 1.25, method: 'estimate' }; // straight line + 25% for roads
}

// ---------------------------------------------------------------- pricing
const money = (n) => Math.round(n * 100) / 100;
function isAfterHours(s, timing, scheduledAt) {
  const d = timing === 'scheduled' && scheduledAt ? new Date(scheduledAt) : new Date();
  // Times are interpreted in the business's local timezone (TZ env var on the server)
  const mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = s.fees.businessStart.split(':').map(Number);
  const [eh, em] = s.fees.businessEnd.split(':').map(Number);
  return mins < sh * 60 + sm || mins >= eh * 60 + em;
}
function buildQuote(s, { serviceId, gallons, miles, timing, scheduledAt }) {
  const svc = s.services.find((x) => x.id === serviceId && x.enabled);
  if (!svc) throw new Error('Please choose a service.');
  const lines = [{ label: svc.name, amount: money(svc.price) }];
  if (svc.id === 'fuel') {
    const g = Math.max(1, Math.min(Number(gallons) || 1, svc.maxGallons || 5));
    lines.push({ label: `Fuel (${g} gal × $${(+svc.perGallon).toFixed(2)})`, amount: money(g * svc.perGallon) });
  }
  if (miles != null) {
    const billedTrip = s.mileage.roundTrip ? miles * 2 : miles;
    const free = s.mileage.roundTrip ? s.mileage.freeMiles * 2 : s.mileage.freeMiles;
    const billable = Math.round(Math.max(0, billedTrip - free) * 10) / 10;
    lines.push({
      label: billable > 0
        ? `Mileage (${billable.toFixed(1)} mi × $${(+s.mileage.perMile).toFixed(2)}, first ${s.mileage.freeMiles} mi free)`
        : `Mileage (${miles.toFixed(1)} mi — within ${s.mileage.freeMiles} free miles)`,
      amount: money(billable * s.mileage.perMile),
    });
  }
  if (timing === 'asap' && s.fees.asapFee > 0) lines.push({ label: 'ASAP priority dispatch', amount: money(s.fees.asapFee) });
  if (s.fees.afterHoursFee > 0 && isAfterHours(s, timing, scheduledAt)) lines.push({ label: 'After-hours service', amount: money(s.fees.afterHoursFee) });
  const subtotal = money(lines.reduce((a, l) => a + l.amount, 0));
  const tax = money(subtotal * (s.fees.taxPercent || 0) / 100);
  return { lines, subtotal, taxPercent: s.fees.taxPercent || 0, tax, total: money(subtotal + tax) };
}
async function locate(s, loc) {
  if (!loc) throw new Error('Please enter your location.');
  let point = null, address = (loc.address || '').trim();
  if (loc.lat != null && loc.lng != null) {
    point = { lat: +loc.lat, lng: +loc.lng };
    if (!address) address = (await reverseGeocode(point.lat, point.lng)) || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  } else if (address) {
    const g = await geocode(address);
    if (!g) throw new Error('We couldn\u2019t find that address. Try adding the city and state, or use “Use my location”.');
    point = { lat: g.lat, lng: g.lng };
  } else throw new Error('Please enter your location.');
  let distance = null;
  if (s.business.baseLat != null) {
    distance = await drivingMiles({ lat: s.business.baseLat, lng: s.business.baseLng }, point);
    if (s.mileage.maxMiles > 0 && distance.miles > s.mileage.maxMiles)
      throw new Error(`Sorry, you’re about ${Math.round(distance.miles)} miles away — outside our ${s.mileage.maxMiles}-mile service area. Call us at ${s.business.phone} and we’ll see what we can do.`);
  }
  return { address, ...point, miles: distance ? money(distance.miles) : null, distanceMethod: distance?.method || null };
}

// ---------------------------------------------------------------- square
function squareBase(s) { return s.square.environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com'; }
async function squareFetch(s, method, p, body) {
  const r = await fetch(squareBase(s) + p, {
    method,
    headers: { 'Square-Version': '2025-10-16', Authorization: `Bearer ${s.square.accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.errors?.[0];
    const friendly = { CARD_DECLINED: 'Your card was declined.', CVV_FAILURE: 'The security code (CVV) didn\u2019t match.', ADDRESS_VERIFICATION_FAILURE: 'The ZIP code didn\u2019t match your card.', INVALID_EXPIRATION: 'The card expiration date is invalid.', INSUFFICIENT_FUNDS: 'The card has insufficient funds.', GENERIC_DECLINE: 'Your card was declined.' }[e?.code];
    const err = new Error(friendly || e?.detail || `Square error (${r.status})`);
    err.square = j.errors; throw err;
  }
  return j;
}

// ---------------------------------------------------------------- email
const POLICY_TEXT = 'If you cancel your service, are not with your vehicle when our driver arrives, or the service is unsuccessful for any reason, a charge of 50% of the total cost of the service still applies. The remaining 50% will be refunded.';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (n) => '$' + Number(n).toFixed(2);
function bookingEmailHtml(b, s, forCustomer) {
  const row = (k, v) => v ? `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>` : '';
  const when = b.timing === 'asap' ? 'ASAP' : new Date(b.scheduledAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const map = `https://www.google.com/maps?q=${b.location.lat},${b.location.lng}`;
  const lines = b.quote.lines.map((l) => `<tr><td style="padding:4px 0">${esc(l.label)}</td><td style="padding:4px 0;text-align:right">${fmt$(l.amount)}</td></tr>`).join('')
    + (b.quote.tax ? `<tr><td style="padding:4px 0">Tax (${b.quote.taxPercent}%)</td><td style="text-align:right">${fmt$(b.quote.tax)}</td></tr>` : '')
    + `<tr><td style="padding:8px 0;border-top:1px solid #ddd;font-weight:700">Total</td><td style="padding:8px 0;border-top:1px solid #ddd;text-align:right;font-weight:700">${fmt$(b.quote.total)}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#111">
  <h2 style="margin:0 0 4px">${forCustomer ? 'Your roadside service is booked' : 'New booking: ' + esc(b.serviceName)} ${b.timing === 'asap' ? '🚨 ASAP' : ''}</h2>
  <p style="margin:0 0 16px;color:#666">Booking #${esc(b.ref)} · ${esc(new Date(b.createdAt).toLocaleString('en-US'))}</p>
  ${forCustomer ? `<p>Thanks, ${esc(b.customer.name)}! We’ve received your request${b.timing === 'asap' ? ' and are dispatching help now' : ''}. Questions? Call ${esc(s.business.phone)}.</p>` : ''}
  <h3 style="margin:16px 0 4px">Service</h3><table>${row('Service', b.serviceName)}${row('Fuel type', b.details.fuelType)}${row('Gallons', b.details.gallons)}${row('Fluid', b.details.fluidType)}${row('When', when)}${row('Notes', b.details.notes)}</table>
  ${forCustomer ? '' : `<h3 style="margin:16px 0 4px">Customer</h3><table>${row('Name', b.customer.name)}${row('Phone', b.customer.phone)}${row('Email', b.customer.email)}</table>`}
  <h3 style="margin:16px 0 4px">Location</h3><table>${row('Address', b.location.address)}${row('Landmark / details', b.location.details)}${row('Distance', b.location.miles != null ? b.location.miles + ' mi from base' : '')}</table>
  ${forCustomer ? '' : `<p><a href="${map}">Open in Google Maps</a> · <a href="https://www.google.com/maps/dir/?api=1&destination=${b.location.lat},${b.location.lng}">Get directions</a></p>`}
  <h3 style="margin:16px 0 4px">Vehicle</h3><table>${row('Vehicle', `${b.vehicle.year} ${b.vehicle.make} ${b.vehicle.model}`)}${row('Color', b.vehicle.color)}${row('License plate', b.vehicle.plate)}</table>
  <h3 style="margin:16px 0 4px">Price</h3><table style="width:100%;max-width:420px">${lines}</table>
  <h3 style="margin:16px 0 4px">Payment</h3><table>${row('Status', b.payment.statusLabel)}${row('Card', b.payment.card)}${forCustomer ? '' : row('Square payment ID', b.payment.id)}</table>
  <div style="margin-top:16px;padding:12px 14px;background:#fff4d1;border-radius:8px;font-size:13px;color:#4a3a0c">
    <b>Cancellation &amp; service policy${forCustomer ? '' : ' (customer agreed ' + esc(new Date(b.policyAcceptedAt || b.createdAt).toLocaleString('en-US')) + ')'}:</b>
    ${esc(POLICY_TEXT)} On this booking that is ${fmt$(b.quote.total / 2)} charged and ${fmt$(b.quote.total - money(b.quote.total / 2))} refunded.
  </div>
</div>`;
}
async function notify(b, s) {
  if (!emailReady(s)) { console.warn('Email not configured — booking saved but no email sent.'); return { owner: false }; }
  const cfg = { host: s.notifications.smtpHost, port: +s.notifications.smtpPort, user: s.notifications.smtpUser, pass: s.notifications.smtpPass };
  const from = { name: s.notifications.fromName || s.business.name, email: s.notifications.smtpUser };
  const out = { owner: false, customer: false };
  try {
    await sendMail(cfg, { from, to: s.notifications.toEmail, replyTo: b.customer.email || undefined,
      subject: `${b.timing === 'asap' ? '🚨 ASAP ' : ''}New booking: ${b.serviceName} — ${b.customer.name} (${fmt$(b.quote.total)})`, html: bookingEmailHtml(b, s, false) });
    out.owner = true;
  } catch (e) { console.error('Owner email failed:', e.message); out.ownerError = e.message; }
  if (s.notifications.sendCustomerConfirmation && b.customer.email) {
    try { await sendMail(cfg, { from, to: b.customer.email, subject: `Booking confirmed — ${s.business.name} #${b.ref}`, html: bookingEmailHtml(b, s, true) }); out.customer = true; }
    catch (e) { console.error('Customer email failed:', e.message); }
  }
  return out;
}

// ---------------------------------------------------------------- auth
function sign(v) { return v + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex'); }
function verify(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.'); const v = tok.slice(0, i);
  const good = sign(v);
  if (good.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(tok))) return false;
  return Number(v.split(':')[1]) > Date.now();
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0])); }
const isAdmin = (req) => verify(cookies(req).rs_admin);
const loginAttempts = new Map();

// ---------------------------------------------------------------- http helpers
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function publicConfig(s) {
  return {
    business: { name: s.business.name, phone: s.business.phone, tagline: s.business.tagline, hasBase: s.business.baseLat != null },
    services: s.services.filter((x) => x.enabled).map(({ id, name, description, price, icon, perGallon, maxGallons, fuelTypes, fluidTypes }) => ({ id, name, description, price, icon, perGallon, maxGallons, fuelTypes, fluidTypes })),
    mileage: { perMile: s.mileage.perMile, freeMiles: s.mileage.freeMiles, maxMiles: s.mileage.maxMiles },
    fees: { asapFee: s.fees.asapFee, afterHoursFee: s.fees.afterHoursFee, businessStart: s.fees.businessStart, businessEnd: s.fees.businessEnd },
    payments: squareReady(s) ? { enabled: true, environment: s.square.environment, applicationId: s.square.applicationId, locationId: s.square.locationId } : { enabled: false },
  };
}
function adminSettingsView(s) {
  const c = JSON.parse(JSON.stringify(s));
  c.square.accessTokenSet = !!c.square.accessToken; c.square.accessToken = c.square.accessToken ? '••••' + c.square.accessToken.slice(-4) : '';
  c.notifications.smtpPassSet = !!c.notifications.smtpPass; c.notifications.smtpPass = '';
  return c;
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---------- public API
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, publicConfig(getSettings()));

    if (p === '/api/quote' && req.method === 'POST') {
      const s = getSettings(); const b = await readBody(req);
      const loc = await locate(s, b.location);
      const quote = buildQuote(s, { serviceId: b.serviceId, gallons: b.gallons, miles: loc.miles, timing: b.timing, scheduledAt: b.scheduledAt });
      return send(res, 200, { location: loc, quote });
    }

    if (p === '/api/book' && req.method === 'POST') {
      const s = getSettings(); const b = await readBody(req);
      const c = b.customer || {}, v = b.vehicle || {};
      if (!str(c.name) || !str(c.phone)) throw new Error('Please enter your name and phone number.');
      if (b.agreedToPolicy !== true) throw new Error('Please read and agree to the cancellation & service policy.');
      if (!str(v.year) || !str(v.make) || !str(v.model) || !str(v.color)) throw new Error('Please enter your vehicle’s year, make, model and color.');
      if (b.timing === 'scheduled') {
        const t = new Date(b.scheduledAt);
        if (isNaN(t) || t.getTime() < Date.now() - 5 * 60e3) throw new Error('Please pick a future date and time.');
      }
      const loc = await locate(s, b.location);
      const quote = buildQuote(s, { serviceId: b.serviceId, gallons: b.gallons, miles: loc.miles, timing: b.timing, scheduledAt: b.scheduledAt });
      if (b.expectedTotal != null && Math.abs(Number(b.expectedTotal) - quote.total) > 0.009)
        return send(res, 409, { error: `The price changed to ${fmt$(quote.total)} — please review the updated breakdown and try again.`, quote, location: loc });
      const svc = s.services.find((x) => x.id === b.serviceId);
      const ref = Date.now().toString(36).toUpperCase().slice(-6) + crypto.randomBytes(1).toString('hex').toUpperCase();
      const booking = {
        id: crypto.randomUUID(), ref, createdAt: new Date().toISOString(), status: 'new',
        serviceId: svc.id, serviceName: svc.name, timing: b.timing === 'scheduled' ? 'scheduled' : 'asap',
        scheduledAt: b.timing === 'scheduled' ? new Date(b.scheduledAt).toISOString() : null,
        details: { fuelType: svc.id === 'fuel' ? str(b.fuelType, 40) : '', gallons: svc.id === 'fuel' ? Math.max(1, Math.min(+b.gallons || 1, svc.maxGallons)) : '', fluidType: svc.id === 'fluid' ? str(b.fluidType, 60) : '', notes: str(b.notes, 1000) },
        customer: { name: str(c.name, 100), phone: str(c.phone, 40), email: str(c.email, 120) },
        vehicle: { year: str(v.year, 4), make: str(v.make, 40), model: str(v.model, 60), color: str(v.color, 40), plate: str(v.plate, 15) },
        location: { address: loc.address, details: str(b.location?.details, 300), lat: loc.lat, lng: loc.lng, miles: loc.miles },
        quote, policyAcceptedAt: new Date().toISOString(), payment: { status: 'none', statusLabel: 'Not collected (Square not connected)' },
      };
      if (squareReady(s)) {
        if (!b.sourceId) throw new Error('Please enter your card details.');
        const pay = await squareFetch(s, 'POST', '/v2/payments', {
          source_id: b.sourceId, verification_token: b.verificationToken || undefined, idempotency_key: crypto.randomUUID(),
          amount_money: { amount: Math.round(quote.total * 100), currency: 'USD' },
          location_id: s.square.locationId, autocomplete: s.square.captureMode !== 'authorize',
          reference_id: ref, note: `${svc.name} — ${booking.vehicle.year} ${booking.vehicle.make} ${booking.vehicle.model}`.slice(0, 500),
          buyer_email_address: booking.customer.email || undefined,
        });
        const P = pay.payment;
        booking.payment = {
          id: P.id, status: P.status,
          statusLabel: P.status === 'APPROVED' ? `Authorized (on hold) — ${fmt$(quote.total)}, capture when the job is done` : P.status === 'COMPLETED' ? `Paid — ${fmt$(quote.total)}` : P.status,
          card: P.card_details?.card ? `${P.card_details.card.card_brand} ending ${P.card_details.card.last_4}` : '',
          receiptUrl: P.receipt_url || '',
        };
      }
      const all = getBookings(); all.unshift(booking); saveBookings(all);
      booking.emailed = await notify(booking, s);
      const all2 = getBookings(); const i = all2.findIndex((x) => x.id === booking.id); if (i >= 0) { all2[i].emailed = booking.emailed; saveBookings(all2); }
      return send(res, 200, { ok: true, ref, total: quote.total, payment: { statusLabel: booking.payment.statusLabel, receiptUrl: booking.payment.receiptUrl }, phone: s.business.phone });
    }

    // ---------- admin auth
    if (p === '/api/admin/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress; const a = loginAttempts.get(ip) || { n: 0, t: 0 };
      if (a.n >= 5 && Date.now() - a.t < 15 * 60e3) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { password } = await readBody(req);
      const ok = typeof password === 'string' && password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));
      if (!ok) { loginAttempts.set(ip, { n: a.n + 1, t: Date.now() }); return send(res, 401, { error: 'Wrong password.' }); }
      loginAttempts.delete(ip);
      const tok = sign('admin:' + (Date.now() + 7 * 864e5));
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `rs_admin=${encodeURIComponent(tok)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
    }
    if (p === '/api/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'rs_admin=; Path=/; Max-Age=0' });

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Please log in.' });

      if (p === '/api/admin/settings' && req.method === 'GET') {
        const s = getSettings();
        return send(res, 200, { settings: adminSettingsView(s), status: { square: squareReady(s), email: emailReady(s), base: s.business.baseLat != null, defaultPassword: ADMIN_PASSWORD === 'changeme' } });
      }
      if (p === '/api/admin/settings' && req.method === 'PUT') {
        const cur = getSettings(); const n = await readBody(req);
        const num = (v, d) => (v === '' || v == null || isNaN(+v) ? d : Math.max(0, +v));
        const next = JSON.parse(JSON.stringify(cur));
        if (n.business) {
          for (const k of ['name', 'phone', 'tagline']) if (k in n.business) next.business[k] = str(n.business[k], 200);
          if ('baseAddress' in n.business && str(n.business.baseAddress) !== cur.business.baseAddress) {
            next.business.baseAddress = str(n.business.baseAddress, 300);
            if (next.business.baseAddress) {
              const g = await geocode(next.business.baseAddress);
              if (!g) return send(res, 400, { error: 'Couldn’t find your base address. Include city and state.' });
              next.business.baseLat = g.lat; next.business.baseLng = g.lng;
            } else { next.business.baseLat = null; next.business.baseLng = null; }
          }
        }
        if (Array.isArray(n.services)) next.services = n.services.map((x, i) => {
          const old = cur.services.find((o) => o.id === x.id) || {};
          return { ...old, id: str(x.id || old.id || 'svc' + i, 40), name: str(x.name, 60) || old.name, description: str(x.description, 300), price: num(x.price, old.price || 0), enabled: !!x.enabled,
            ...(old.id === 'fuel' || x.perGallon != null ? { perGallon: num(x.perGallon, old.perGallon || 0), maxGallons: Math.max(1, Math.round(num(x.maxGallons, old.maxGallons || 5))) } : {}) };
        });
        if (n.mileage) next.mileage = { perMile: num(n.mileage.perMile, cur.mileage.perMile), freeMiles: num(n.mileage.freeMiles, cur.mileage.freeMiles), maxMiles: num(n.mileage.maxMiles, cur.mileage.maxMiles), roundTrip: !!n.mileage.roundTrip };
        if (n.fees) next.fees = { asapFee: num(n.fees.asapFee, cur.fees.asapFee), afterHoursFee: num(n.fees.afterHoursFee, cur.fees.afterHoursFee), businessStart: /^\d\d:\d\d$/.test(n.fees.businessStart) ? n.fees.businessStart : cur.fees.businessStart, businessEnd: /^\d\d:\d\d$/.test(n.fees.businessEnd) ? n.fees.businessEnd : cur.fees.businessEnd, taxPercent: num(n.fees.taxPercent, cur.fees.taxPercent) };
        if (n.notifications) {
          const nn = n.notifications;
          next.notifications = { ...cur.notifications, toEmail: str(nn.toEmail, 200), smtpHost: str(nn.smtpHost, 100), smtpPort: Math.round(num(nn.smtpPort, 465)), smtpUser: str(nn.smtpUser, 200), fromName: str(nn.fromName, 100), sendCustomerConfirmation: !!nn.sendCustomerConfirmation };
          if (nn.smtpPass) next.notifications.smtpPass = String(nn.smtpPass).replace(/\s+/g, '');
        }
        if (n.square) {
          const q = n.square;
          next.square = { ...cur.square, environment: q.environment === 'production' ? 'production' : 'sandbox', applicationId: str(q.applicationId, 100), locationId: str(q.locationId, 100), captureMode: q.captureMode === 'authorize' ? 'authorize' : 'capture' };
          if (q.accessToken && !q.accessToken.startsWith('••••')) next.square.accessToken = str(q.accessToken, 300);
          if (q.clearAccessToken) next.square.accessToken = '';
        }
        saveSettings(next);
        return send(res, 200, { ok: true, settings: adminSettingsView(next), status: { square: squareReady(next), email: emailReady(next), base: next.business.baseLat != null, defaultPassword: ADMIN_PASSWORD === 'changeme' } });
      }
      if (p === '/api/admin/test-square' && req.method === 'POST') {
        const s = getSettings();
        if (!squareReady(s)) return send(res, 400, { error: 'Fill in Application ID, Location ID and Access Token first, then Save.' });
        const j = await squareFetch(s, 'GET', '/v2/locations');
        const loc = (j.locations || []).find((l) => l.id === s.square.locationId);
        if (!loc) return send(res, 400, { error: `Token works, but Location ID ${s.square.locationId} wasn’t found. Your locations: ${(j.locations || []).map((l) => `${l.name} (${l.id})`).join(', ')}` });
        return send(res, 200, { ok: true, message: `Connected to Square (${s.square.environment}) — location “${loc.name}”, currency ${loc.currency}.` });
      }
      if (p === '/api/admin/test-email' && req.method === 'POST') {
        const s = getSettings();
        if (!emailReady(s)) return send(res, 400, { error: 'Fill in the email settings (including the app password) and Save first.' });
        await sendMail({ host: s.notifications.smtpHost, port: +s.notifications.smtpPort, user: s.notifications.smtpUser, pass: s.notifications.smtpPass },
          { from: { name: s.notifications.fromName, email: s.notifications.smtpUser }, to: s.notifications.toEmail, subject: 'Test email from your roadside booking site', html: '<p>✅ Email notifications are working. New bookings will arrive at this address.</p>' });
        return send(res, 200, { ok: true, message: `Test email sent to ${s.notifications.toEmail}.` });
      }
      if (p === '/api/admin/bookings' && req.method === 'GET') return send(res, 200, { bookings: getBookings() });

      const m = p.match(/^\/api\/admin\/bookings\/([\w-]+)\/(status|capture|void|refund|half)$/);
      if (m && req.method === 'POST') {
        const s = getSettings(); const all = getBookings(); const bk = all.find((x) => x.id === m[1]);
        if (!bk) return send(res, 404, { error: 'Booking not found' });
        const body = await readBody(req);
        if (m[2] === 'status') { if (!['new', 'dispatched', 'completed', 'cancelled'].includes(body.status)) throw new Error('Bad status'); bk.status = body.status; }
        else {
          if (!bk.payment?.id) throw new Error('No Square payment on this booking.');
          if (m[2] === 'capture') { const r = await squareFetch(s, 'POST', `/v2/payments/${bk.payment.id}/complete`, {}); bk.payment.status = r.payment.status; bk.payment.statusLabel = `Paid — ${fmt$(bk.quote.total)}`; }
          if (m[2] === 'void') { const r = await squareFetch(s, 'POST', `/v2/payments/${bk.payment.id}/cancel`, {}); bk.payment.status = r.payment.status; bk.payment.statusLabel = 'Hold released (voided)'; }
          if (m[2] === 'half') {
            const keep = Math.round(bk.quote.total * 100 / 2), back = Math.round(bk.quote.total * 100) - keep;
            if (bk.payment.status === 'APPROVED') {
              // Card is on hold: lower the hold to 50%, then charge it
              await squareFetch(s, 'PUT', `/v2/payments/${bk.payment.id}`, { idempotency_key: crypto.randomUUID(), payment: { amount_money: { amount: keep, currency: 'USD' } } });
              const r = await squareFetch(s, 'POST', `/v2/payments/${bk.payment.id}/complete`, {}); bk.payment.status = r.payment.status;
            } else if (bk.payment.status === 'COMPLETED') {
              await squareFetch(s, 'POST', '/v2/refunds', { idempotency_key: crypto.randomUUID(), payment_id: bk.payment.id, amount_money: { amount: back, currency: 'USD' }, reason: '50% refund per cancellation & service policy' });
              bk.payment.status = 'PARTIALLY_REFUNDED';
            } else throw new Error('This payment can’t take a cancellation fee in its current state.');
            bk.payment.statusLabel = `Cancellation fee ${fmt$(keep / 100)} charged · ${fmt$(back / 100)} refunded`;
            bk.status = 'cancelled';
          }
          if (m[2] === 'refund') { await squareFetch(s, 'POST', '/v2/refunds', { idempotency_key: crypto.randomUUID(), payment_id: bk.payment.id, amount_money: { amount: Math.round(bk.quote.total * 100), currency: 'USD' }, reason: 'Refund from admin dashboard' }); bk.payment.status = 'REFUNDED'; bk.payment.statusLabel = `Refunded — ${fmt$(bk.quote.total)}`; }
        }
        saveBookings(all); return send(res, 200, { ok: true, booking: bk });
      }
      return send(res, 404, { error: 'Not found' });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e.message);
    send(res, 400, { error: e.message || 'Something went wrong.' });
  }
});

server.listen(PORT, () => console.log(`Roadside site running → http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`));
