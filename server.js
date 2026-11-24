// QR Print — scan, upload, pay, auto-crop, print (built for Epson M2170, B&W A4 + auto duplex)
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// ---------- config (set these as environment variables) ----------
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`; // the address customers open from the QR
const SHOP_NAME = process.env.SHOP_NAME || 'Quick Print Shop';
const SHOP_PIN = process.env.SHOP_PIN || '1234';                          // password for the shop dashboard
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const PRICE_SINGLE = Number(process.env.PRICE_SINGLE || 2);   // ₹ per page, one-sided
const PRICE_DUPLEX = Number(process.env.PRICE_DUPLEX || 3);   // ₹ per sheet, both sides
const MAX_PAGES = 100, MAX_COPIES = 20;
const DEMO = !(RZP_KEY_ID && RZP_KEY_SECRET);                 // no keys → fake payment for testing

// ---------- safety checks before starting ----------
// "Local" = the QR points at this machine only, so nobody outside can reach it.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(PUBLIC_URL);
const die = msg => { console.error('\nQR Print will not start:\n  ' + msg + '\n'); process.exit(1); };
if (!!RZP_KEY_ID !== !!RZP_KEY_SECRET)
  die('Set BOTH RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (only one is set).');
if (DEMO && !LOCAL && process.env.DEMO_MODE !== '1')
  die(`No Razorpay keys, but PUBLIC_URL (${PUBLIC_URL}) is public — every order would be accepted as paid.\n` +
    '  Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or set DEMO_MODE=1 if you really want fake payments.');
if (!LOCAL && (SHOP_PIN === '1234' || SHOP_PIN.length < 8))
  die('SHOP_PIN must be set to at least 8 characters (and not 1234) when the server is public.');

// ---------- tiny JSON storage ----------
const DATA = path.join(__dirname, 'data');
const JOBS_DIR = path.join(DATA, 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
let db = { orders: {}, jobs: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch (e) {
  // A missing file is normal on first run; a broken one must not be silently replaced with an empty database.
  if (e.code !== 'ENOENT') die(`${DB_FILE} could not be read (${e.message}). Fix or restore it from ${DB_FILE}.bak.`);
}
// Write to a temp file and rename, so a crash or power cut mid-write never leaves a half-written db.json.
const save = () => {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch {}
  fs.renameSync(tmp, DB_FILE);
};

// 4-digit pickup code, cryptographically random and never shared with another job still waiting to be collected
function newPickupCode() {
  const inUse = new Set(Object.values(db.jobs).filter(j => j.status !== 'collected').map(j => j.code));
  if (inUse.size >= 9000) throw new Error('No free pickup codes — mark collected jobs as collected');
  let code;
  do code = String(crypto.randomInt(1000, 10000)); while (inUse.has(code));
  return code;
}

const price = (pages, copies, duplex) =>
  duplex ? Math.ceil(pages / 2) * copies * PRICE_DUPLEX : pages * copies * PRICE_SINGLE;

const app = express();
// Behind Cloudflare Tunnel / Render / a reverse proxy, read the real client IP (used for PIN lockout).
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({
  shopName: SHOP_NAME, demo: DEMO, keyId: RZP_KEY_ID,
  priceSingle: PRICE_SINGLE, priceDuplex: PRICE_DUPLEX, maxPages: MAX_PAGES, maxCopies: MAX_COPIES,
}));

// 1) create a payment order — the amount is always computed here, never trusted from the browser
app.post('/api/order', async (req, res) => {
  const pages = parseInt(req.body.pages, 10), copies = parseInt(req.body.copies, 10);
  const duplex = !!req.body.duplex;
  if (!(pages >= 1 && pages <= MAX_PAGES && copies >= 1 && copies <= MAX_COPIES))
    return res.status(400).json({ error: 'Invalid pages or copies' });
  const amount = price(pages, copies, duplex);
  let id;
  if (DEMO) id = 'demo_' + crypto.randomBytes(6).toString('hex');
  else {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64') },
      body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt: 'qp_' + Date.now() }),
    });
    const o = await r.json();
    if (!r.ok) return res.status(502).json({ error: o.error?.description || 'Payment gateway error' });
    id = o.id;
  }
  db.orders[id] = { id, amount, pages, copies, duplex, status: 'created', createdAt: Date.now() };
  save();
  res.json({ orderId: id, amount, keyId: RZP_KEY_ID, demo: DEMO });
});

// 2) verify the payment signature from Razorpay Checkout
app.post('/api/verify', (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  const o = db.orders[orderId];
  if (!o) return res.status(404).json({ error: 'Order not found' });
  let ok = false;
  if (DEMO) ok = orderId.startsWith('demo_');
  else {
    const expected = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    ok = typeof signature === 'string' && signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
  if (!ok) return res.status(400).json({ error: 'Payment could not be verified' });
  o.status = 'paid'; o.paymentId = paymentId || 'demo'; o.paidAt = Date.now();
  save();
  res.json({ ok: true });
});

// 3) after payment, the browser uploads the cropped, print-ready pages
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8e6, files: MAX_PAGES } });
app.post('/api/jobs', upload.array('pages', MAX_PAGES), (req, res) => {
  const o = db.orders[req.body.orderId];
  if (!o || o.status !== 'paid') return res.status(402).json({ error: 'Order is not paid' });
  if (o.jobId) return res.json({ jobId: o.jobId, code: db.jobs[o.jobId].code });
  const files = req.files || [];
  if (files.length !== o.pages) return res.status(400).json({ error: `Expected ${o.pages} pages, got ${files.length}` });
  if (files.some(f => f.mimetype !== 'image/jpeg')) return res.status(400).json({ error: 'Pages must be JPEG' });
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir);
  files.forEach((f, i) => fs.writeFileSync(path.join(dir, `${i + 1}.jpg`), f.buffer));
  let code;
  try { code = newPickupCode(); } catch (e) { return res.status(503).json({ error: e.message }); }
  db.jobs[id] = { id, code, orderId: o.id, pages: o.pages, copies: o.copies, duplex: o.duplex,
    amount: o.amount, status: 'queued', createdAt: Date.now(), name: String(req.body.name || '').slice(0, 40) };
  o.jobId = id; o.status = 'used';
  save();
  res.json({ jobId: id, code });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = db.jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ status: j.status, code: j.code });
});

// ---------- shop side (PIN protected) ----------
// The PIN is only accepted in the x-shop-pin header (never in the URL, where it would end up in logs).
// After 5 wrong PINs from one IP, that IP is locked out for 15 minutes.
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const fails = new Map();   // ip -> { n, until }
const pinHash = s => crypto.createHash('sha256').update(String(s)).digest();
const PIN_HASH = pinHash(SHOP_PIN);
const shopAuth = (req, res, next) => {
  const ip = req.ip, f = fails.get(ip), now = Date.now();
  if (f && f.until > now) {
    res.set('Retry-After', String(Math.ceil((f.until - now) / 1000)));
    return res.status(429).json({ error: 'Too many wrong PINs — try again in 15 minutes' });
  }
  const given = req.get('x-shop-pin');
  if (given && crypto.timingSafeEqual(pinHash(given), PIN_HASH)) { fails.delete(ip); return next(); }
  const n = (f && f.until <= now && f.n >= MAX_FAILS ? 0 : f?.n || 0) + 1;
  fails.set(ip, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
  if (fails.size > 10000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
  res.status(401).json({ error: 'Wrong PIN' });
};

app.get('/api/shop/jobs', shopAuth, (req, res) =>
  res.json(Object.values(db.jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)));

app.get('/api/shop/jobs/:id/page/:n', shopAuth, (req, res) => {
  const j = db.jobs[req.params.id], n = parseInt(req.params.n, 10);
  if (!j || !(n >= 1 && n <= j.pages)) return res.sendStatus(404);
  res.sendFile(path.join(JOBS_DIR, j.id, `${n}.jpg`));
});

app.post('/api/shop/jobs/:id/status', shopAuth, (req, res) => {
  const j = db.jobs[req.params.id];
  if (!j || !['queued', 'printed', 'collected'].includes(req.body.status)) return res.sendStatus(400);
  j.status = req.body.status; save();
  res.json(j);
});

app.get('/api/shop/qr.svg', async (req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(PUBLIC_URL, { type: 'svg', margin: 1, width: 600 }));
});

app.listen(PORT, () => console.log(
  `QR Print running on ${PUBLIC_URL}\n  Customer page: ${PUBLIC_URL}/\n  Shop dashboard: ${PUBLIC_URL}/shop.html \n  Payments: ${DEMO ? 'DEMO mode (add Razorpay keys for real payments)' : 'Razorpay LIVE/TEST keys loaded'}`));
