(() => {
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => '$' + Number(n || 0).toFixed(2);
  const ICONS = {
    key: '<path d="M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"/><path d="M12 11v10M12 15h3M12 18h2"/>',
    bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
    fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M15 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3M7 8h5"/>',
    air: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  };
  const COLORS = [['White', '#fff'], ['Black', '#111'], ['Silver', '#c0c3c7'], ['Gray', '#6d7176'], ['Red', '#c62828'], ['Blue', '#1e4fa3'], ['Green', '#2e7d32'], ['Brown', '#6d4c35'], ['Beige', '#d9c8a5'], ['Gold', '#c9a43b'], ['Orange', '#ef6c00'], ['Yellow', '#f4d03f'], ['Other', 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)']];
  const MAKES = ['Acura','Alfa Romeo','Audi','BMW','Buick','Cadillac','Chevrolet','Chrysler','Dodge','Fiat','Ford','Genesis','GMC','Honda','Hyundai','Infiniti','Jaguar','Jeep','Kia','Land Rover','Lexus','Lincoln','Mazda','Mercedes-Benz','Mini','Mitsubishi','Nissan','Pontiac','Porsche','Ram','Rivian','Saturn','Scion','Subaru','Tesla','Toyota','Volkswagen','Volvo'];

  const st = { cfg: null, service: null, timing: 'asap', color: '', located: null, quote: null, card: null, busy: false };

  // ---------- init
  fetch('/api/config').then((r) => r.json()).then(init).catch(() => showErr('Couldn’t load the booking form. Please refresh or call us.'));

  function init(cfg) {
    st.cfg = cfg;
    document.querySelectorAll('[data-biz]').forEach((el) => (el.textContent = cfg.business[el.dataset.biz] || el.textContent));
    document.title = `${cfg.business.name} — Book Help Now`;
    const tel = 'tel:' + (cfg.business.phone || '').replace(/[^\d+]/g, '');
    $('#call-link').href = tel; $('#done-call').href = tel; $('#done-call').textContent = 'Call ' + cfg.business.phone;

    $('#services').innerHTML = cfg.services.map((s) => `
      <button type="button" class="svc" data-id="${s.id}" aria-pressed="false">
        <span class="svc-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.icon] || ICONS.bolt}</svg></span>
        <span class="svc-name">${esc(s.name)}</span>
        <span class="svc-desc">${esc(s.description)}</span>
        <span class="svc-price">${fmt(s.price)} ${s.id === 'fuel' ? `<small>+ fuel ${fmt(s.perGallon)}/gal</small>` : ''}</span>
      </button>`).join('');
    $('#services').addEventListener('click', (e) => { const b = e.target.closest('.svc'); if (b) pickService(b.dataset.id); });

    const fuel = cfg.services.find((s) => s.id === 'fuel');
    if (fuel) {
      $('#fuelType').innerHTML = (fuel.fuelTypes || ['Regular']).map((t) => `<option>${esc(t)}</option>`).join('');
      $('#gallons').innerHTML = Array.from({ length: fuel.maxGallons || 5 }, (_, i) => `<option value="${i + 1}" ${i === 1 ? 'selected' : ''}>${i + 1} gallon${i ? 's' : ''} (+${fmt((i + 1) * fuel.perGallon)})</option>`).join('');
    }
    const fluid = cfg.services.find((s) => s.id === 'fluid');
    if (fluid) $('#fluidType').innerHTML = (fluid.fluidTypes || []).map((t) => `<option>${esc(t)}</option>`).join('');
    ['#gallons', '#fuelType', '#fluidType'].forEach((s) => $(s).addEventListener('change', refresh));

    if (cfg.fees.asapFee > 0) $('#asap-sub').textContent = `Dispatch now (+${fmt(cfg.fees.asapFee)})`;
    $('#hours-hint').textContent = cfg.fees.afterHoursFee > 0 ? `Regular hours ${to12(cfg.fees.businessStart)}–${to12(cfg.fees.businessEnd)}. Outside those hours add ${fmt(cfg.fees.afterHoursFee)}.` : '';
    $('#timing').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      st.timing = b.dataset.timing;
      $('#timing').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      $('#sched-wrap').classList.toggle('hidden', st.timing !== 'scheduled');
      if (st.timing === 'scheduled' && !$('#scheduledAt').value) {
        const d = new Date(Date.now() + 2 * 3600e3); d.setMinutes(0, 0, 0); $('#scheduledAt').value = localISO(d);
      }
      refresh();
    });
    $('#scheduledAt').min = localISO(new Date());
    $('#scheduledAt').addEventListener('change', refresh);

    // location
    $('#address').addEventListener('input', () => { st.located = null; $('#loc-found').classList.remove('show'); renderSummary(); });
    $('#address').addEventListener('change', () => locateAddress());
    $('#address').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); locateAddress(); } });
    $('#geo-btn').addEventListener('click', useGPS);

    // vehicle
    const y = new Date().getFullYear() + 1;
    $('#vYear').innerHTML = '<option value="">Year</option>' + Array.from({ length: y - 1979 }, (_, i) => `<option>${y - i}</option>`).join('');
    $('#makes').innerHTML = MAKES.map((m) => `<option value="${m}">`).join('');
    $('#colors').innerHTML = COLORS.map(([n, c]) => `<button type="button" class="color" data-color="${n}" aria-pressed="false"><i style="background:${c}"></i>${n}</button>`).join('');
    $('#colors').addEventListener('click', (e) => {
      const b = e.target.closest('.color'); if (!b) return;
      st.color = b.dataset.color;
      $('#colors').querySelectorAll('.color').forEach((x) => x.setAttribute('aria-pressed', x === b));
      $('#vColorOther').classList.toggle('hidden', st.color !== 'Other');
      if (st.color === 'Other') $('#vColorOther').focus();
      $('#colors').classList.remove('invalid');
    });

    // payment
    if (cfg.payments.enabled) { $('#pay-ready').classList.remove('hidden'); setupSquare(cfg.payments); }
    else $('#pay-off').classList.remove('hidden');

    $('#book-form').addEventListener('submit', submit);
    $('#mbar-btn').addEventListener('click', () => $('#summary').scrollIntoView({ behavior: 'smooth' }));
    document.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', () => el.classList.remove('invalid')));
    $('#agree').addEventListener('change', () => $('#policy').classList.remove('invalid'));
    if (cfg.services.length === 1) pickService(cfg.services[0].id);
    renderSummary();
  }

  function pickService(id) {
    st.service = st.cfg.services.find((s) => s.id === id);
    $('#services').querySelectorAll('.svc').forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === id));
    $('#extra-fuel').classList.toggle('hidden', id !== 'fuel');
    $('#extra-fluid').classList.toggle('hidden', id !== 'fluid');
    refresh();
  }

  // ---------- location
  function locateAddress() {
    const a = $('#address').value.trim();
    if (a.length < 4 || (st.located && st.located.address === a)) return;
    st.located = { address: a, pending: true };
    quote();
  }
  function useGPS() {
    if (!navigator.geolocation) return showErr('Your browser can’t share location. Please type your address.');
    const btn = $('#geo-btn'); btn.disabled = true; btn.querySelector('.geo-label').innerHTML = '<span class="spin"></span>';
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false; btn.querySelector('.geo-label').textContent = 'Use my location';
      st.located = { lat: pos.coords.latitude, lng: pos.coords.longitude, pending: true, gps: true };
      quote();
    }, () => {
      btn.disabled = false; btn.querySelector('.geo-label').textContent = 'Use my location';
      showErr('We couldn’t get your location. Please allow location access or type your address.');
    }, { enableHighAccuracy: true, timeout: 12000 });
  }

  // ---------- pricing
  let qSeq = 0;
  function refresh() { if (st.located && !st.located.error) quote(); else renderSummary(); }
  async function quote() {
    if (!st.service || !st.located) return renderSummary();
    const seq = ++qSeq;
    $('#sum-meta').innerHTML = '<span class="spin"></span> Calculating…';
    try {
      const r = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadBase()) });
      const j = await r.json();
      if (seq !== qSeq) return;
      if (!r.ok) throw new Error(j.error);
      st.quote = j.quote;
      st.located = { address: st.located.gps ? j.location.address : st.located.address, lat: j.location.lat, lng: j.location.lng, miles: j.location.miles, gps: st.located.gps };
      if (st.located.gps) $('#address').value = j.location.address;
      const lf = $('#loc-found'); lf.className = 'loc-found show';
      lf.textContent = '📍 ' + (j.location.miles != null ? `Found — about ${j.location.miles.toFixed(1)} miles from us.` : 'Location found.');
      hideErr(); renderSummary();
    } catch (e) {
      if (seq !== qSeq) return;
      st.quote = null; st.located = { ...st.located, error: true };
      const lf = $('#loc-found'); lf.className = 'loc-found show bad';
      lf.textContent = e.message || 'Couldn’t find that location.';
      renderSummary();
    }
  }
  function localPreview() {
    const s = st.service, c = st.cfg; const lines = [{ label: s.name, amount: s.price }];
    if (s.id === 'fuel') { const g = +$('#gallons').value || 1; lines.push({ label: `Fuel (${g} gal × ${fmt(s.perGallon)})`, amount: g * s.perGallon }); }
    lines.push({ label: 'Mileage', pending: c.business.hasBase ? 'Enter location' : null, amount: 0 });
    if (st.timing === 'asap' && c.fees.asapFee > 0) lines.push({ label: 'ASAP priority dispatch', amount: c.fees.asapFee });
    return lines.filter((l) => !(l.label === 'Mileage' && !l.pending));
  }
  function renderSummary() {
    const ul = $('#sum-lines');
    if (!st.service) { ul.innerHTML = ''; $('#sum-total').textContent = $('#mbar-total').textContent = '$0.00'; $('#sum-meta').textContent = 'Choose a service to see your price.'; $('#policy-amt').textContent = ''; return; }
    const usingQuote = st.quote && st.located && !st.located.error && !st.located.pending;
    const lines = usingQuote ? st.quote.lines : localPreview();
    ul.innerHTML = lines.map((l) => `<li class="${l.pending ? 'pending' : ''}"><span>${esc(l.label)}</span><span>${l.pending ? l.pending : fmt(l.amount)}</span></li>`).join('')
      + (usingQuote && st.quote.tax ? `<li><span>Tax (${st.quote.taxPercent}%)</span><span>${fmt(st.quote.tax)}</span></li>` : '');
    const total = usingQuote ? st.quote.total : lines.reduce((a, l) => a + (l.amount || 0), 0);
    $('#sum-total').textContent = $('#mbar-total').textContent = fmt(total) + (usingQuote ? '' : '+');
    $('#policy-amt').textContent = usingQuote ? ` (${fmt(total / 2)} on this booking)` : '';
    const when = st.timing === 'asap' ? 'ASAP' : ($('#scheduledAt').value ? new Date($('#scheduledAt').value).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Scheduled');
    $('#sum-meta').textContent = `${st.service.name} · ${when}` + (usingQuote ? '' : ' · add your location for the final price');
    if (!usingQuote && st.located && st.located.pending) $('#sum-meta').innerHTML = '<span class="spin"></span> Calculating…';
  }

  // ---------- square
  async function setupSquare(p) {
    try {
      await loadScript(p.environment === 'production' ? 'https://web.squarecdn.com/v1/square.js' : 'https://sandbox.web.squarecdn.com/v1/square.js');
      const payments = window.Square.payments(p.applicationId, p.locationId);
      st.card = await payments.card({ style: { '.input-container': { borderRadius: '10px', borderColor: '#e2ded4' }, '.input-container.is-focus': { borderColor: '#e59f00' } } });
      await st.card.attach('#card-container');
    } catch (e) {
      console.error(e);
      $('#card-container').innerHTML = '<div class="notice err">The secure card form couldn’t load. Please refresh the page, or call us to book.</div>';
    }
  }
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });

  // ---------- submit
  function payloadBase() {
    const loc = st.located || {};
    return {
      serviceId: st.service?.id, timing: st.timing,
      scheduledAt: st.timing === 'scheduled' && $('#scheduledAt').value ? new Date($('#scheduledAt').value).toISOString() : null,
      gallons: $('#gallons').value, fuelType: $('#fuelType').value, fluidType: $('#fluidType').value,
      location: loc.lat != null ? { lat: loc.lat, lng: loc.lng, address: loc.address, details: $('#locDetails').value } : { address: $('#address').value, details: $('#locDetails').value },
    };
  }
  function validate() {
    const bad = [];
    const need = (sel, ok) => { if (!ok) { $(sel).classList.add('invalid'); bad.push(sel); } };
    if (!st.service) bad.push('#services');
    if (st.timing === 'scheduled') need('#scheduledAt', $('#scheduledAt').value && new Date($('#scheduledAt').value) > new Date());
    need('#address', $('#address').value.trim() || (st.located && st.located.lat != null));
    need('#vYear', $('#vYear').value); need('#vMake', $('#vMake').value.trim()); need('#vModel', $('#vModel').value.trim());
    const color = st.color === 'Other' ? $('#vColorOther').value.trim() : st.color;
    if (!color) { $('#colors').classList.add('invalid'); bad.push('#colors'); }
    if (!$('#agree').checked) { $('#policy').classList.add('invalid'); bad.push('#policy'); }
    need('#cName', $('#cName').value.trim()); need('#cPhone', $('#cPhone').value.replace(/\D/g, '').length >= 10);
    if ($('#cEmail').value.trim()) need('#cEmail', /^\S+@\S+\.\S+$/.test($('#cEmail').value.trim()));
    if (bad.length) {
      const msgs = { '#policy': 'read and agree to the cancellation & service policy', '#services': 'choose a service', '#address': 'enter your location', '#colors': 'pick your vehicle color', '#cPhone': 'enter a valid phone number', '#scheduledAt': 'pick a future date and time' };
      showErr('Please ' + (bad.map((b) => msgs[b]).filter(Boolean)[0] || 'fill in the highlighted fields') + '.');
      document.querySelector(bad[0]).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !bad.length ? color : null;
  }
  async function submit(e) {
    e.preventDefault(); if (st.busy) return; hideErr();
    const color = validate(); if (!color) return;
    const btn = $('#book-btn'); st.busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Booking…';
    try {
      if (!st.quote || !st.located || st.located.error || st.located.pending) {
        st.located = st.located && st.located.lat != null && !st.located.error ? st.located : { address: $('#address').value.trim() };
        await quote();
      }
      if (!st.quote || st.located?.error) throw new Error($('#loc-found').textContent || 'Please check your location.');
      let sourceId = null;
      if (st.cfg.payments.enabled) {
        if (!st.card) throw new Error('The card form hasn’t loaded. Please refresh and try again.');
        const t = await st.card.tokenize();
        if (t.status !== 'OK') throw new Error((t.errors && t.errors[0] && t.errors[0].message) || 'Please check your card details.');
        sourceId = t.token;
      }
      const body = { ...payloadBase(), sourceId, expectedTotal: st.quote.total, notes: $('#notes').value, agreedToPolicy: $('#agree').checked,
        customer: { name: $('#cName').value, phone: $('#cPhone').value, email: $('#cEmail').value },
        vehicle: { year: $('#vYear').value, make: $('#vMake').value, model: $('#vModel').value, color, plate: $('#vPlate').value.toUpperCase() } };
      const r = await fetch('/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 409) { st.quote = j.quote; renderSummary(); throw new Error(j.error); }
      if (!r.ok) throw new Error(j.error);
      $('#booking-view').classList.add('hidden'); $('#mbar').classList.add('hidden'); document.querySelector('.hero').classList.add('hidden');
      $('#done-view').classList.remove('hidden');
      $('#done-ref').textContent = 'Booking #' + j.ref;
      $('#done-msg').textContent = st.timing === 'asap'
        ? `We’ve got your request and we’re on it. We’ll call or text ${$('#cPhone').value} with your ETA.`
        : `You’re scheduled for ${new Date($('#scheduledAt').value).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}. We’ll reach out to confirm.`;
      $('#done-pay').innerHTML = esc(j.payment.statusLabel) + (j.payment.receiptUrl ? ` · <a href="${esc(j.payment.receiptUrl)}" target="_blank" rel="noopener">View receipt</a>` : '');
      window.scrollTo({ top: 0 });
    } catch (err) {
      showErr(err.message || 'Something went wrong. Please try again or call us.');
    } finally { st.busy = false; btn.disabled = false; btn.textContent = 'Book now'; }
  }

  // ---------- utils
  function showErr(m) { const el = $('#form-error'); el.textContent = m; el.classList.add('show'); }
  function hideErr() { $('#form-error').classList.remove('show'); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function localISO(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  function to12(t) { const [h, m] = t.split(':').map(Number); return `${(h % 12) || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; }
})();
