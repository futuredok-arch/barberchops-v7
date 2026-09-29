# Barberchops Online Booking

A real, running booking system for Barberchops: clients book from their phones, pay the $5 booking fee
through Stripe (cards and Apple Pay), and you, your barbers and your shop TV each see only what they should.

- **Clients** book at your website address. They never see anyone else's information.
- **Barbers** sign in with a personal link and a 6-digit PIN. They see their own appointments with **first names only**. No phone numbers, emails or last names.
- **Shop TV** ("Shop screen") shows a spreadsheet-style board: barbers across the top, times down the side, clients as first name + last initial.
- **Owner** (you) sees everything: bookings, customers, text-list export, photos, settings, security log.
- **Emails** (through Resend): every booking is emailed to the address you choose, clients get a confirmation and a 24-hour reminder.
- **Payments**: a booking is only confirmed after Stripe itself tells the server the payment succeeded (signature-checked). Card and Apple Pay details never touch this app.

You need to create four free/cheap accounts yourself (GitHub, Render, Stripe, Resend). Nobody else, including me, should ever
see your passwords or secret keys. **Never paste a secret key (`sk_live_...`, `whsec_...`, Resend key) into a chat, email or text.** You type them only into Render's "Environment" page.

---

## Part 1: Put it online (about 30 minutes)

### 1. Upload the code to GitHub
1. Create a free account at github.com and click **New repository**. Name it `barberchops-booking`, choose **Private**.
2. Click **uploading an existing file** and drag in everything from this folder **except** `node_modules` (it will be ignored automatically if you use GitHub Desktop; if you drag files by hand, skip that folder).
3. Commit.

### 2. Create the server on Render
1. Create an account at render.com (choose **Sign up with GitHub**) and turn on two-factor sign-in.
2. Click **New +, Blueprint**, connect your GitHub if asked, and pick the `barberchops-booking` repository. Render reads the `render.yaml` file and prepares the server plus a 1 GB **persistent disk** (where your bookings database and barber photos live, so they survive restarts). The disk needs a paid plan: about $7.25 a month in total.
3. Render asks for **one** secret value: `SETUP_KEY`. Make up a long random phrase of 20+ characters (a password manager can generate it) and save it somewhere private. You use it once, in Step 3, to create your owner login.
4. Click **Apply** and wait 3 to 6 minutes while it builds. When the service shows **Live**, click its name. At the top is your address, something like `https://barberchops-booking-abcd.onrender.com`.
5. Open that address on your phone. **You should now see the Barberchops booking page. That is your running booking link.** Bookings are free to make at this point (payment isn't switched on until Part 3), which is exactly right for testing.

If the build fails, click the failed deploy and read the last lines of the log. Send me the last 20 lines (they contain no secrets) and I'll fix it.

### 3. Turn on your owner login
1. Open your Render address followed by `/#owner` (for example `https://barberchops-booking-abcd.onrender.com/#owner`).
2. First visit shows **first-time setup**: enter your `SETUP_KEY`, your email, and a password of 10+ characters. Use a password you don't use anywhere else.
3. After that, this screen becomes a normal sign-in. Setup can't be run again by anyone else.
4. In **Settings**: set the **Owner email** (receives every booking), then press **Send test email**. Also set the **Shop screen PIN** (6 digits) for the TV.

### 4. Add your barbers
Owner, **Team**: add each barber, then create their one-time sign-in link (you can email it or copy and text it). It works once, for 7 days; they choose their own 6-digit PIN. If someone forgets their PIN, tap **Reset login** and send a new link.

### 5. Set up the shop TV
On the TV's browser open `https://your-address/#board` (or tap **Shop screen** at the bottom of the site), enter the 6-digit screen PIN. That TV stays signed in for 30 days. Press **Full screen** for a 60-inch display. Changing the PIN in Settings signs every TV out.

---

## Part 2: Use your own address and add the Book Now button

1. In Render, open your service, **Settings, Custom Domains, Add** and enter `book.barberchops.com`. Render shows a DNS record to add.
2. Add that record where your domain's DNS is managed. **If Wix manages your domain:** in your Wix account go to **Domains**, click the three-dot/Domain Actions icon next to barberchops.com, choose **Manage DNS Records**, and under **CNAME** click **+ Add Record**. Host Name is `book`, Value is the address Render shows you, then save. This only adds the `book.` address; your Wix website keeps working exactly as before. (If your domain is registered elsewhere and only *pointed* at Wix, add the record at that registrar instead.) Wait until Render shows it as verified (minutes to a few hours). HTTPS is automatic.
3. In Render, Environment, **add** a setting `BASE_URL` with the value `https://book.barberchops.com` and save. (Do this only after the address works. The Render address keeps working too.)
4. In the Wix Editor add a **button** (Add, Button), choose **Link, Web Address**, paste `https://book.barberchops.com`, and set it to open in the same tab. (The booking page can't be embedded inside a Wix page frame: Stripe's payment page and iPhone privacy settings don't work reliably inside frames, so a button is the right, safe way.) That's the whole "Book Now" button. Clients book on their phones from there, and it can also be your Google Business profile "Book" link and Instagram bio link.

---

## Part 3: Stripe (the $5 fee)

1. Create an account at stripe.com and finish **activating** it (business details, bank account for payouts). Stripe handles that; this app never sees any of it.
2. **API key:** Developers, API keys. Best practice: create a **Restricted key** with only *Checkout Sessions: Write* and *Refunds: Write* (the second one lets the **Refund** button on your owner page work), then copy it into Render as `STRIPE_SECRET_KEY`. (Copying the standard "Secret key" also works.)
3. **Webhook:** Developers, Webhooks, **Add endpoint**.
   - Endpoint URL: `https://book.barberchops.com/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - After saving, reveal the **Signing secret** (`whsec_...`) and put it into Render as `STRIPE_WEBHOOK_SECRET`.
4. **Apple Pay:** Settings, Payment methods: make sure Cards and Apple Pay/Google Pay are on. Stripe's own payment page shows them automatically on supported phones.
5. **Switch payment on:** in Render, Environment, change `REQUIRE_PAYMENT` from `false` to `true` and save. From then on, a booking is only confirmed after the $5 is paid.
6. **Test first:** In Stripe switch to *Test mode*, use the test keys, and book with card `4242 4242 4242 4242` (any future date, any CVC). Check that the booking shows up and the emails arrive. Then switch to live keys and update both Render settings.
7. **Refunds:** When a booking fee is due back, it shows in a red **Refund needed** box at the top of your owner page (Bookings tab) and you get an email. That happens when a customer cancels at least 12 hours ahead from their email link, or when someone pays but the time was taken a moment before (rare). Press **Refund $5**, confirm, and the app refunds exactly that one booking fee through Stripe and emails the customer. You can also press **Refund** on any paid appointment card. If you refunded it in Stripe yourself, press **Already refunded in Stripe**.

---

## Part 4: Email (Resend)

1. Create an account at resend.com, **Domains, Add Domain** for `barberchops.com`, and add the DNS records it shows (same place as Part 2).
2. **API Keys, Create** (sending access only) and put it in Render as `RESEND_API_KEY`.
3. Set `MAIL_FROM` to something like `Barberchops <bookings@barberchops.com>`.
4. In the owner **Settings**, press **Send test email** to confirm. If email is down, messages wait in a queue and retry automatically, so nothing is lost.

---

## Cancel or reschedule link, review requests, calling clients

- **Cancel or reschedule:** every confirmation and reminder email has a private link. Customers can move each appointment to another time with the same barber (their booking fee goes with it, nothing more to pay) or cancel it. At least 12 hours ahead (the number is your Cancel window in Settings), a cancel is flagged for you to refund. Inside that window they can still cancel to free the chair, but the fee is kept and rescheduling is blocked (they call the shop). Each appointment in a multi-appointment order is handled separately.
- **Google review requests:** in Owner, Settings, paste your Google review link. About 2 hours after you press **Complete** on an appointment, the client gets one email asking for a review (never more than one every 30 days, and only between 9 AM and 8 PM). Leave the link blank to turn it off.
- **Schedule changed after people booked?** Turning a day off, blocking time, or shortening hours never cancels anyone behind your back. Instead, a red **Needs a new time** box appears at the top of the Bookings tab for every appointment that no longer fits, with Call, Text and **Reschedule** buttons, and a heads-up shows right when you save the change.
- **Reschedule button (owner):** on every upcoming or no-show appointment, and in that red box. Pick the same barber, another barber, or Any barber, then a day and time. The booking fee moves with the client (no new charge, nothing lost), and they get an email with the new time (you can untick that if you called them).
- **Phone number is required** at checkout. On your owner page, every appointment and every customer has one-tap **Call** and **Text** buttons, so you can reach someone who is late or a no-show. Barbers and the TV never see phone numbers.

## Text list (Textedly) and marketing consent

- The booking form has a **pre-ticked** consent box with a short plain-language notice (texts and emails, reply STOP, no selling of information). Clients can untick it.
- Owner, **Customers**, **Download text list (CSV)** gives first name, last name, phone (10 digits), email and when they opted in, **only for people who agreed**, and never for blocked numbers. Import that file into Textedly. Each export is recorded in the security log.
- Have your lawyer or Textedly's compliance page confirm the wording meets current rules for your state and for text messaging (TCPA/CTIA). I'm not a lawyer.

---

## What protects your customers' data

- Barbers, the TV and the public are **restricted on the server**. The private fields are never sent to them, so hiding it in the page isn't what protects it.
- Passwords and PINs are stored only as salted scrypt hashes. Sign-in sessions are random tokens in HttpOnly, Secure cookies. Lockouts after repeated wrong tries. Cross-site request checks. A strict content-security policy blocks injected scripts.
- All secrets live only in Render's environment. Nothing secret is in the code or the browser.
- Photos: JPEG only, size-limited, served so browsers can't run them as code.
- An independent attack test against the running server (auth bypass, data leaks, injection, cross-site tricks, forged Stripe payment messages, double-booking races, file uploads) found no exploitable problems. Automated safety tests and a browser test of every screen run on every change (`npm test`, `npm run e2e`).

**Honest limits.** The database file sits on Render's persistent disk and is not additionally encrypted by the app, so anyone who controls your Render account can reach it. Protect your Render, GitHub, Stripe and email accounts with **two-factor authentication**, and use a unique password for each. Keep your owner password private and change it if a staff member who knew it leaves.

## Backups and upkeep

- Owner, **Customers**, **Download full backup** saves everything as a file (no passwords or secrets inside). Do it monthly. Render can also snapshot the disk automatically.
- Deploys: updating the code on GitHub redeploys automatically.
- Old security-log entries and expired holds are cleaned up automatically.

## Running it on your own computer (optional)

```
npm install
npm start          # http://localhost:3000, uses a fake payment page and no emails
npm test           # automated safety tests
npm run e2e        # full browser test (needs Playwright's Chromium)
```
