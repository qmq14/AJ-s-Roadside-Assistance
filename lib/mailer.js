// Minimal SMTP client (no dependencies). Supports implicit TLS (port 465) and STARTTLS (port 587).
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

function sendMail({ host, port = 465, user, pass, secure }, { from, to, replyTo, subject, html }) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiting = null;
    const timer = setTimeout(() => fail(new Error('Email server timed out')), 20000);
    const fail = (e) => { clearTimeout(timer); try { sock && sock.destroy(); } catch {} reject(e); };

    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split('\r\n');
      // a complete reply ends with a line "NNN text" (space, not dash)
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiting; waiting = null; w && w(reply);
          return;
        }
      }
    };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); };
    const expect = (codes) => new Promise((res, rej) => { waiting = (r) => (codes.includes(+r.slice(0, 3)) ? res(r) : rej(new Error('Email server said: ' + r.split('\n').pop()))); });
    const cmd = (line, codes) => { const p = expect(codes); sock.write(line + '\r\n'); return p; };

    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
    const msg = [
      `From: ${encWord(from.name || '')} <${from.email}>`,
      `To: <${to}>`,
      replyTo ? `Reply-To: <${replyTo}>` : null,
      `Subject: ${encWord(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${(from.email.split('@')[1] || 'localhost')}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(html).replace(/.{76}/g, '$&\r\n'),
    ].filter((l) => l !== null).join('\r\n');

    (async () => {
      const implicit = secure ?? +port === 465;
      attach(implicit ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
      await expect([220]);
      await cmd('EHLO roadside-site', [250]);
      if (!implicit) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        attach(tls.connect({ socket: sock, servername: host }));
        await cmd('EHLO roadside-site', [250]);
      }
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(user), [334]);
      await cmd(b64(pass), [235]).catch(() => { throw new Error('Email login failed — check the email address and app password.'); });
      await cmd(`MAIL FROM:<${from.email}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(msg.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
      sock.write('QUIT\r\n'); clearTimeout(timer); sock.end(); resolve(true);
    })().catch(fail);
  });
}
module.exports = { sendMail };
