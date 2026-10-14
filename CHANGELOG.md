# Changelog

## 2026-10 — Sync fixes (v1.0.1)

- Fix: if the app was set up while sync was off (for example, when an older blank config.js was still cached), the passcode and recovery code were only saved on that device, so other devices couldn't find the data. They now upload automatically the first time sync works.
- Fix: the app now checks for new versions of its files every time it opens, instead of keeping a cached copy for up to 10 minutes. A new config.js or app update shows up on the next reload.

## 2026-10 — First release (v1.0.0)

- Home with "safe to spend until payday", monthly totals, overdue / due-soon / price-change banners, and one-tap paid toggles with Undo.
- Paycheck planner: bills grouped by paycheck, per-check amount overrides, savings set-asides, and a "hold" suggestion that evens out a heavy check.
- Calendar with due dates, paydays, notes and pay-site links.
- Insights: spending by category, monthly trend, subscriptions with yearly cost, price changes, and a downloadable year-end summary.
- Goals: savings goals with on-track dates, debts linked to a bill, and a pay-extra what-if that includes interest.
- Add / edit bills with quick-add templates, monthly / yearly / every-2-weeks / one-time schedules, autopay, varying amounts, reminder timing, notes and pay links.
- Weekends and US bank holidays: each bill can move to the next business day (default), the business day before, or keep its date; paydays move to the business day before by default. Moved dates show the reason, the calendar marks holidays, and payments stay tied to the scheduled date so changing the rule never loses them.
- Autopay bills mark themselves paid on the due date.
- Calendar reminders: one .ics file with every bill due date and payday for the next 12 months (with alerts, holiday moves included) for Google Calendar, plus per-bill "Add to Google Calendar" links.
- Passcode lock with auto-lock options; all data encrypted on the device before saving or syncing.
- Forgot passcode: a recovery code shown once at setup unlocks the data on any device and lets you set a new passcode. "Email it to me" opens Gmail (PC) or your mail app (phone) with the code filled in, so it lands in your own inbox. Settings can make a new code (the old one stops working). Changing or resetting the passcode signs out the old one on every device.
- Sync between phone and PC through a Cloudflare Worker that only stores encrypted data; changes on both devices merge.
- Light, dark and match-device themes; works on phone and desktop; installable and opens offline.
- Export to CSV, backup / restore, change passcode, erase everything.
- config.js ships with the live sync Worker address, so uploads never need a manual edit.
