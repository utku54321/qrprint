# QR Print — scan, pay, auto-crop, print (Epson M2170)

Customers scan a QR at your counter → upload photos/PDFs → pay with Razorpay (UPI/cards) →
review auto-cropped, B&W-cleaned A4 pages → job lands in your shop dashboard → print on the M2170.

## Run it
```
npm install
npm start
```
- Customer page: http://localhost:3000/
- Shop dashboard: http://localhost:3000/shop.html (PIN 1234)

With no Razorpay keys it runs in **demo payment mode** so you can test the full flow.

## Settings (environment variables)
| Variable | Meaning | Default |
|---|---|---|
| `PUBLIC_URL` | Public address the QR points to (e.g. https://print.yourshop.in) | http://localhost:3000 |
| `SHOP_NAME` | Shown to customers | Quick Print Shop |
| `SHOP_PIN` | Dashboard password — **change it** | 1234 |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | From Razorpay Dashboard → API Keys (use test keys first) | empty = demo |
| `PRICE_SINGLE` | ₹ per page, one side | 2 |
| `PRICE_DUPLEX` | ₹ per sheet, both sides | 3 |

Example (Windows PowerShell):
```
$env:PUBLIC_URL="https://print.yourshop.in"; $env:SHOP_PIN="7391"; $env:RAZORPAY_KEY_ID="rzp_test_..."; $env:RAZORPAY_KEY_SECRET="..."; npm start
```

## Hosting
Customers' phones must reach the server over **HTTPS** (Razorpay needs it). Easiest options:
- Render / Railway / a small VPS: deploy this folder, set the env vars, add a persistent disk for `data/`.
- Or run it on the shop PC and expose it with Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`).
(Vercel's serverless setup won't keep uploaded files — use one of the above.)

## Printer setup — Epson M2170
1. Install the Epson M2170 driver on the shop PC, set it as the **default printer**, paper A4.
2. Open the dashboard in Chrome. Click **Print** on a job → choose M2170 → Margins: None, Scale: 100%.
   For jobs marked **Both sides**, tick "Print on both sides" (the M2170 does auto duplex).
3. **Fully automatic printing**: start Chrome with silent printing, open the dashboard and tick
   "Auto-print new jobs":
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing http://localhost:3000/shop.html
   ```
   Paid jobs then print the moment they arrive, using the printer's default settings.
   Tip: in Windows, add the M2170 a second time as "M2170 Duplex" with 2-sided as default if you
   want to print duplex jobs without touching settings.

## How the pieces work
- Price is calculated on the server, and uploads are refused unless the Razorpay payment signature
  was verified and the page count matches what was paid.
- Auto-crop finds the sheet of paper in a phone photo (cuts away table/background); for scans and
  screenshots it trims the empty border. Customers can drag corners, rotate, or turn crop/clean-up off.
- Every page is sent as a grayscale A4 image (200 dpi) with a ~7 mm safe margin, so it prints the
  same on the M2170 every time.
- Customers get a 4-digit pickup code; the page shows "Printed ✓" when you print it.
