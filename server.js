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

// ---------- tiny JSON storage ----------
const DATA = path.join(__dirname, 'data');
const JOBS_DIR = path.join(DATA, 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
let db = { orders: {}, jobs: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));

const price = (pages, copies, duplex) =>
  duplex ? Math.ceil(pages / 2) * copies * PRICE_DUPLEX : pages * copies * PRICE_SINGLE;

const app = express();
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
  const code = String(Math.floor(1000 + Math.random() * 9000));
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
const shopAuth = (req, res, next) =>
  (req.get('x-shop-pin') || req.query.pin) === SHOP_PIN ? next() : res.status(401).json({ error: 'Wrong PIN' });

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
  `QR Print running on ${PUBLIC_URL}\n  Customer page: ${PUBLIC_URL}/\n  Shop dashboard: ${PUBLIC_URL}/shop.html (PIN ${SHOP_PIN})\n  Payments: ${DEMO ? 'DEMO mode (add Razorpay keys for real payments)' : 'Razorpay LIVE/TEST keys loaded'}`));
