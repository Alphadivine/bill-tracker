# Bill Tracker

A personal app for keeping track of monthly bills and budgeting around your paycheck. It works on your phone and your PC, syncs between them, and keeps everything locked with a passcode only you know.

**Live app:** https://alphadivine.github.io/bill-tracker/

## What it does

- **Home** shows what's **safe to spend** until your next payday, your bills for the month, and what's paid and still owed. Tap the circle to mark a bill paid (with Undo).
- **Paycheck planner** splits your bills by paycheck (every 2 weeks, weekly, twice a month or monthly), shows what each check covers, and suggests **holding** some money from one check when the next one is heavier.
- **Calendar** shows due dates and paydays for the month. Pick a day to see its bills, notes and a link to the pay site.
- **Insights** shows where your money goes by category, your monthly trend, every **subscription** with its yearly cost, **price changes** when a bill goes up, and a **year-end summary** you can download.
- **Goals** tracks savings goals (a set amount per paycheck, with an on-track date) and debts (the balance drops when you mark the linked bill paid). A **what-if** shows how much sooner you'd be debt-free paying a little extra.
- **Quick add** fills in common bills like rent, electric, phone and car insurance in one tap.
- **Bill notes and pay links** keep late-fee reminders and the website to pay at with each bill.
- **Weekends and bank holidays** are handled for you. Each bill can move to the next business day (the default, like autopay), the business day before, or keep its date. Paydays on a weekend or holiday move to the business day before (changeable in Settings). Moved dates say why, and the calendar marks the 11 US bank holidays.
- **Autopay** bills mark themselves paid on their (business-day) due date.
- **Varying bills** like electric ask for the real amount when you mark them paid.
- **Reminders** go through your calendar. Download one calendar file with every bill due date and payday (each with an alert) and import it into Google Calendar, or add single bills from their details.
- **Light, dark or match device**, chosen separately on each device.
- **Forgot passcode?** A recovery code from setup unlocks your bills and lets you choose a new passcode. **Email it to me** sends the code to your own inbox so it's easy to find later.
- **Export** to a spreadsheet, download or restore a **backup**, and **erase everything**.

## Privacy

Everything is encrypted in your browser (AES-256-GCM) before it is saved on the device or sent to the sync server. The encryption key is itself locked twice: once with your passcode and once with your recovery code (each stretched with PBKDF2, 250,000 rounds), so either one can open it. The sync server only ever stores scrambled data. Nobody, including the server, can read your bills without the passcode. Forgot your passcode? When you set up the app you get a **recovery code**. On the lock screen tap **Forgot passcode?**, enter the code, and pick a new passcode, on any device. You can make a new code anytime in Settings (the old one stops working). Without the passcode or the recovery code, nobody can open the data, so keep the code somewhere private.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `app.js` | All the app logic |
| `styles.css` | Look and feel, including dark mode |
| `config.js` | Your sync Worker address |
| `sw.js`, `manifest.webmanifest`, icons | Offline support and "Add to Home screen" |

The sync Worker lives in the `Worker` folder of the bundle, not on GitHub Pages. See `Docs/Setup guide.md`.

---

Last updated: October 2026 (v1.0.1)
