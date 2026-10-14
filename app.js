/* Bill Tracker — app.js
 * Everything runs in the browser. Your data is encrypted with a key made from
 * your passcode before it is saved on this device or sent to the sync Worker.
 */
(function () {
  "use strict";

  const CFG = window.BILL_TRACKER_CONFIG || {};
  const SYNC_URL = String(CFG.syncUrl || "").trim().replace(/\/+$/, "");
  const VERSION = "1.0.0";
  const COLS = ["bills", "payments", "goals", "holds", "checks"];
  const PBKDF2_ITER = 250000;
  const SALT = "bill-tracker/v1";

  const CATEGORIES = ["Housing", "Utilities", "Transportation", "Insurance", "Debt", "Subscriptions", "Health", "Personal", "Other"];
  const TEMPLATES = [
    { name: "Rent", cat: "Housing", day: 1 },
    { name: "Mortgage", cat: "Housing", day: 1 },
    { name: "Electric", cat: "Utilities", day: 18, varies: true },
    { name: "Gas / heat", cat: "Utilities", day: 20, varies: true },
    { name: "Water", cat: "Utilities", day: 20, varies: true },
    { name: "Internet", cat: "Utilities", day: 25 },
    { name: "Phone", cat: "Utilities", day: 5 },
    { name: "Car payment", cat: "Transportation", day: 15 },
    { name: "Car insurance", cat: "Insurance", day: 22 },
    { name: "Renter's insurance", cat: "Insurance", day: 1 },
    { name: "Credit card", cat: "Debt", day: 28 },
    { name: "Student loan", cat: "Debt", day: 10 },
    { name: "Streaming", cat: "Subscriptions", day: 8 },
    { name: "Gym", cat: "Health", day: 1 },
    { name: "Car registration", cat: "Transportation", repeat: "yearly" },
    { name: "Something else", cat: "Other", blank: true },
  ];
  const REPEATS = { monthly: "Every month", yearly: "Every year", biweekly: "Every 2 weeks", once: "Just once" };
  const FREQS = { biweekly: "Every 2 weeks", weekly: "Every week", semimonthly: "Twice a month", monthly: "Once a month" };
  const LOCKS = { close: "When I close the app", "5": "5 minutes", "15": "15 minutes", "60": "1 hour", never: "Never on this device" };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOWL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /* ---------------- small helpers ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const r2 = (n) => Math.round((+n || 0) * 100) / 100;
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + (typeof f === "function" ? f(x) : x[f]), 0));
  const store = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); } catch (e) {} },
    del(k) { try { window[kind].removeItem(k); } catch (e) {} },
  });
  const LS = store("localStorage");
  const SS = store("sessionStorage");
  const readJSON = (k, s) => { try { return JSON.parse((s || LS).get(k) || "null"); } catch (e) { return null; } };

  function money(n, opts) {
    const v = r2(n);
    const cents = Math.abs(v % 1) > 0.001;
    const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
    return (v < 0 ? "−" : opts && opts.plus && v > 0 ? "+" : "") + "$" + s;
  }
  const moneyK = (n) => (n >= 1000 ? "$" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : "$" + Math.round(n));
  function parseMoney(s) {
    const v = parseFloat(String(s == null ? "" : s).replace(/[^0-9.\-]/g, ""));
    return isFinite(v) ? r2(v) : NaN;
  }
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

  /* ---------------- dates (all local, as YYYY-MM-DD strings) ---------------- */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const utc = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return iso(d); };
  const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const dim = (y, m0) => new Date(y, m0 + 1, 0).getDate();
  const ymd = (y, m0, d) => { while (m0 < 0) { m0 += 12; y--; } while (m0 > 11) { m0 -= 12; y++; } return y + "-" + pad(m0 + 1) + "-" + pad(Math.min(d, dim(y, m0))); };
  const addMonths = (mk, n) => { let [y, m] = mk.split("-").map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + "-" + pad(m); };
  const monthEnd = (mk) => { const [y, m] = mk.split("-").map(Number); return mk + "-" + pad(dim(y, m - 1)); };
  const fmtShort = (s) => { const d = parseD(s); return MON[d.getMonth()] + " " + d.getDate(); };
  const fmtDow = (s) => { const d = parseD(s); return DOW[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate(); };
  const fmtLong = (s) => { const d = parseD(s); return DOWL[d.getDay()] + ", " + MONTH[d.getMonth()] + " " + d.getDate(); };
  const fmtMonth = (mk) => { const [y, m] = mk.split("-").map(Number); return MONTH[m - 1] + " " + y; };
  const fmtMonShort = (mk) => { const [y, m] = mk.split("-").map(Number); return MON[m - 1] + " " + y; };
  const inDays = (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days");

  /* ---------------- icons ---------------- */
  const P = {
    home: '<path d="M4 11l8-7 8 7v9H4z"/>',
    pay: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    chart: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
    goal: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12l5 5L19 7"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    ext: '<path d="M7 17L17 7M9 7h8v8"/>',
    logo: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
    sync: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  };
  const icon = (n, s, w) => '<svg width="' + (s || 20) + '" height="' + (s || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[n] + "</svg>";

  /* ---------------- state ---------------- */
  let DB = null, KEY = null, JWK = null, VID = null, PID = null;
  let IDX = null;
  const sync = { v: 0, dirty: false, last: 0, status: SYNC_URL ? "idle" : "off" };
  const UI = {
    homeMonth: null, calMonth: null, calSel: null,
    insMode: "month", insMonth: null, insYear: null,
    whatIf: {}, draft: null, draftFor: null,
    auth: { step: "", error: "", busy: false, msg: "" },
    pendingRender: false,
  };

  /* ---------------- crypto ---------------- */
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

  async function derive(pass) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(SALT), iterations: PBKDF2_ITER, hash: "SHA-256" }, base, 512));
    const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", true, ["encrypt", "decrypt"]);
    const id = hex(await crypto.subtle.digest("SHA-256", bits.slice(32)));
    return { key, id };
  }
  async function encryptObj(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key || KEY, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptObj(blob, key) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key || KEY, unb64(blob.ct));
    return JSON.parse(dec.decode(pt));
  }

  /* ---------------- data model ---------------- */
  function newDB() {
    return {
      schema: 1,
      settings: {
        name: "",
        pay: { amount: 0, freq: "biweekly", anchor: "", day1: 1, day2: 15, shift: "before" },
        reminders: { payday: true, due: true, price: true, days: 3 },
        startedOn: today(),
        updatedAt: Date.now(),
      },
      keyring: { pid: "", rid: "", updatedAt: 0 },
      bills: [], payments: [], goals: [], holds: [], checks: [],
    };
  }
  function normalize(db) {
    const base = newDB();
    db = db && typeof db === "object" ? db : base;
    db.schema = 1;
    db.settings = Object.assign({}, base.settings, db.settings || {});
    db.settings.pay = Object.assign({}, base.settings.pay, db.settings.pay || {});
    db.settings.reminders = Object.assign({}, base.settings.reminders, db.settings.reminders || {});
    db.keyring = Object.assign({ pid: "", rid: "", updatedAt: 0 }, db.keyring || {});
    for (const c of COLS) if (!Array.isArray(db[c])) db[c] = [];
    return db;
  }
  function mergeCol(a, b) {
    const m = new Map();
    for (const x of a.concat(b)) {
      if (!x || !x.id) continue;
      const c = m.get(x.id);
      if (!c || (x.updatedAt || 0) > (c.updatedAt || 0)) m.set(x.id, x);
    }
    return Array.from(m.values());
  }
  function merge(a, b) {
    a = normalize(a); b = normalize(b);
    const out = {
      schema: 1,
      settings: (b.settings.updatedAt || 0) > (a.settings.updatedAt || 0) ? b.settings : a.settings,
      keyring: (b.keyring.updatedAt || 0) > (a.keyring.updatedAt || 0) ? b.keyring : a.keyring,
    };
    for (const c of COLS) out[c] = mergeCol(a[c], b[c]);
    return out;
  }
  function fingerprint(db) {
    const parts = ["s:" + (db.settings.updatedAt || 0), "k:" + ((db.keyring && db.keyring.updatedAt) || 0)];
    for (const c of COLS) parts.push(c + "=" + (db[c] || []).map((x) => x.id + ":" + (x.updatedAt || 0)).sort().join(","));
    return parts.join("|");
  }
  const touch = (o) => { o.updatedAt = Date.now(); return o; };
  function upsert(col, obj) {
    touch(obj);
    const arr = DB[col];
    const i = arr.findIndex((x) => x.id === obj.id);
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    return obj;
  }
  function settingsChanged() { DB.settings.updatedAt = Date.now(); }

  function rebuildIndex() {
    const pay = new Map(), byBill = new Map();
    for (const p of DB.payments) {
      if (p.deleted) continue;
      pay.set(p.id, p);
      if (!byBill.has(p.billId)) byBill.set(p.billId, []);
      byBill.get(p.billId).push(p);
    }
    for (const list of byBill.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
    IDX = {
      pay, byBill,
      bills: DB.bills.filter((b) => !b.deleted),
      billById: new Map(DB.bills.map((b) => [b.id, b])),
      holds: new Map(DB.holds.filter((h) => !h.deleted).map((h) => [h.id, h])),
      checks: new Map(DB.checks.filter((h) => !h.deleted).map((h) => [h.id, h])),
      goals: DB.goals.filter((g) => !g.deleted),
    };
  }

  /* ---------------- local save + session ---------------- */
  const readMeta = () => readJSON("bt_meta");
  async function saveLocal() {
    if (!DB || !KEY) return;
    const blob = await encryptObj(DB);
    LS.set("bt_data", JSON.stringify(blob));
    LS.set("bt_sync", JSON.stringify({ v: sync.v, dirty: sync.dirty, last: sync.last }));
  }
  const lockPolicy = () => LS.get("bt_lock") || "15";
  let lastActivity = Date.now(), lastTouchSaved = 0;
  function saveSession() {
    if (!JWK) return;
    const pol = lockPolicy();
    if (pol === "close") {
      SS.set("bt_session", JSON.stringify({ jwk: JWK }));
      LS.del("bt_session");
    } else {
      LS.set("bt_session", JSON.stringify({ jwk: JWK, last: Date.now() }));
      SS.del("bt_session");
    }
    lastTouchSaved = Date.now();
  }
  function noteActivity() {
    lastActivity = Date.now();
    if (DB && lockPolicy() !== "close" && Date.now() - lastTouchSaved > 20000) saveSession();
  }
  async function tryResume(meta) {
    const pol = lockPolicy();
    let sess = null;
    if (pol === "close") sess = readJSON("bt_session", SS);
    else {
      sess = readJSON("bt_session");
      if (sess && pol !== "never" && Date.now() - (sess.last || 0) > Number(pol) * 60000) sess = null;
    }
    if (!sess || !sess.jwk) { LS.del("bt_session"); return false; }
    try {
      const key = await crypto.subtle.importKey("jwk", sess.jwk, "AES-GCM", true, ["encrypt", "decrypt"]);
      const blob = readJSON("bt_data");
      if (!blob) return false;
      const db = await decryptObj(blob, key);
      KEY = key; JWK = sess.jwk; VID = meta.vid; PID = meta.pid || null; DB = normalize(db);
      return true;
    } catch (e) { return false; }
  }
  // key = the data key (random, never changes); vid = where the data lives on the
  // sync server; pid = the "door" id your passcode opens.
  async function startSession(key, vid, db, pid) {
    KEY = key; VID = vid; PID = pid; DB = normalize(db);
    JWK = await crypto.subtle.exportKey("jwk", key);
    LS.set("bt_meta", JSON.stringify({ vid, pid, v: 2 }));
    saveSession();
    await saveLocal();
  }

  /* ---------------- doors: passcode + recovery code ----------------
   * Your bills are encrypted with a random data key. That key is stored twice,
   * each copy locked by something only you have: your passcode and your
   * recovery code. Either one can open the data. The copies are saved on this
   * device and (if sync is on) on the sync server, which can't open them.
   */
  const RC_ALPHA = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  function makeRecoveryCode() {
    const b = crypto.getRandomValues(new Uint8Array(20));
    let s = "";
    for (let i = 0; i < 20; i++) s += RC_ALPHA[b[i] % RC_ALPHA.length] + (i % 4 === 3 && i < 19 ? "-" : "");
    return s;
  }
  const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const deriveCode = (code) => derive("recovery:" + cleanCode(code));
  async function newDataKey() { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); }
  async function keyToB64(k) { return b64(await crypto.subtle.exportKey("raw", k)); }
  async function keyFromB64(s) { return crypto.subtle.importKey("raw", unb64(s), "AES-GCM", true, ["encrypt", "decrypt"]); }
  async function doorBlob(lockKey, vid, dataKey) { return encryptObj({ vid, k: await keyToB64(dataKey) }, lockKey); }
  async function openDoorBlob(blob, lockKey) {
    const d = await decryptObj(blob, lockKey);
    if (!d || !d.k || !d.vid) throw new Error("bad door");
    return { vid: d.vid, key: await keyFromB64(d.k) };
  }
  // Remote doors live at /v/<door id> on the Worker, just like the data.
  async function putDoor(id, blob) {
    if (!SYNC_URL) return "ok";
    const r = await fetch(SYNC_URL + "/v/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base: 0, blob }) });
    if (r.status === 409) return "exists";
    if (!r.ok) throw new Error("door " + r.status);
    return "ok";
  }
  async function getDoor(id, lockKey) {
    const r = await fetch(SYNC_URL + "/v/" + id, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("door " + r.status);
    return openDoorBlob((await r.json()).blob, lockKey);
  }
  async function dropDoor(id) { if (SYNC_URL && id) { try { await fetch(SYNC_URL + "/v/" + id, { method: "DELETE" }); } catch (e) {} } }
  async function fetchVault(vid, key) {
    const r = await fetch(SYNC_URL + "/v/" + vid, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("vault " + r.status);
    const j = await r.json();
    return { v: j.v, db: await decryptObj(j.blob, key) };
  }
  // Find the data key with a passcode or recovery code: this device first, then the server.
  async function openWith(secretDerived, which) {
    const local = readJSON(which === "r" ? "bt_rdoor" : "bt_door");
    const meta = readMeta();
    const myId = which === "r" ? meta && meta.rid : meta && meta.pid;
    if (local && myId === secretDerived.id) {
      try { return Object.assign(await openDoorBlob(local, secretDerived.key), { from: "local" }); } catch (e) {}
    }
    if (!SYNC_URL) return null;
    const d = await getDoor(secretDerived.id, secretDerived.key);
    return d ? Object.assign(d, { from: "remote" }) : null;
  }
  async function saveDoorsLocal(pd, rd, dataKey, vid) {
    if (pd) LS.set("bt_door", JSON.stringify(await doorBlob(pd.key, vid, dataKey)));
    if (rd) LS.set("bt_rdoor", JSON.stringify(await doorBlob(rd.key, vid, dataKey)));
    const m = readMeta() || {};
    LS.set("bt_meta", JSON.stringify({ vid, pid: pd ? pd.id : m.pid, rid: rd ? rd.id : m.rid, v: 2 }));
  }
  // Load the data for an opened door: local copy if it matches, otherwise from the server.
  async function loadData(opened) {
    const meta = readMeta();
    const blob = readJSON("bt_data");
    if (blob && meta && meta.vid === opened.vid) {
      try { return await decryptObj(blob, opened.key); } catch (e) {}
    }
    if (!SYNC_URL) return null;
    const got = await fetchVault(opened.vid, opened.key);
    if (!got) return null;
    LS.del("bt_data");
    sync.v = got.v; sync.dirty = false; sync.last = Date.now();
    return got.db;
  }

  // Door changes wait in a queue until the sync server can be reached.
  function queueDoorOp(op) {
    if (!SYNC_URL) return;
    const q = (readJSON("bt_doorq") || []).filter((x) => x.id !== op.id);
    q.push(op);
    LS.set("bt_doorq", JSON.stringify(q));
    flushDoors();
  }
  let flushing = false;
  async function flushDoors() {
    if (!SYNC_URL || flushing) return;
    flushing = true;
    try {
      const failed = new Set();
      for (;;) {
        const op = (readJSON("bt_doorq") || []).find((x) => !failed.has(JSON.stringify(x)));
        if (!op) break;
        try {
          if (op.drop) { const r = await fetch(SYNC_URL + "/v/" + op.id, { method: "DELETE" }); if (!r.ok) throw new Error(); }
          else await putDoor(op.id, op.blob);
          // Remove just this op; others may have been queued meanwhile.
          LS.set("bt_doorq", JSON.stringify((readJSON("bt_doorq") || []).filter((x) => JSON.stringify(x) !== JSON.stringify(op))));
        } catch (e) { failed.add(JSON.stringify(op)); }
      }
    } finally { flushing = false; }
  }
  // If the app was set up while sync was off (or offline), the passcode and
  // recovery "doors" were only saved on this device. Upload those same locked
  // copies once sync is available, so other devices can find the data.
  async function ensureDoors() {
    if (!SYNC_URL || !DB || !PID) return;
    const meta = readMeta() || {};
    const tag = SYNC_URL + "|" + meta.pid + "|" + (meta.rid || "");
    if (LS.get("bt_doors_up") === tag) return;
    if (meta.pid !== PID || (DB.keyring.pid && DB.keyring.pid !== PID)) return;
    const pd = readJSON("bt_door"), rd = readJSON("bt_rdoor");
    if (pd) await putDoor(meta.pid, pd);
    if (rd && meta.rid && (!DB.keyring.rid || DB.keyring.rid === meta.rid)) await putDoor(meta.rid, rd);
    LS.set("bt_doors_up", tag);
  }
  function clearDevice() {
    ["bt_meta", "bt_data", "bt_sync", "bt_session", "bt_door", "bt_rdoor", "bt_doorq", "bt_doors_up"].forEach((k) => LS.del(k));
    SS.del("bt_session");
  }
  // "Email it to me": on a phone, open the mail app (Gmail on Android); on a PC, open Gmail in the browser
  // (Windows often has no mail app set up). Either way, put your own address in the To line.
  function emailCodeLink(code) {
    const subject = "Bill Tracker recovery code";
    const body = "My Bill Tracker recovery code:\n\n" + code + "\n\nIf I forget my passcode: open Bill Tracker, tap \"Forgot passcode?\" and enter this code. " +
      "On a new phone: \"I already use it on another device\" → \"Forgot passcode? Use your recovery code\".\n\n" +
      "Saved " + today() + ". If I make a new code in Settings, this one stops working.";
    const phone = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    return phone
      ? { href: "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body), blank: false }
      : { href: "https://mail.google.com/mail/?view=cm&fs=1&su=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body), blank: true };
  }
  function codeBox(code) {
    const mail = emailCodeLink(code);
    return '<div class="codebox" aria-label="Recovery code">' + esc(code) + "</div>" +
      '<div class="headactions"><a class="btn small primary" href="' + esc(mail.href) + '"' + (mail.blank ? ' target="_blank" rel="noopener"' : "") + ">Email it to me</a>" +
      '<button class="btn small" type="button" data-act="downloadCode" data-code="' + esc(code) + '">Download as a file</button><button class="btn small" type="button" data-act="copyCode" data-code="' + esc(code) + '">Copy</button></div>' +
      '<span class="small muted">If you ever forget your passcode, this code unlocks your bills and lets you pick a new passcode, on any device. <b>Email it to me</b> opens a message with the code filled in: type your own email address in the To line and send it. Later, search your inbox for “Bill Tracker recovery code”. Anyone who can see the code can open your bills, so only send it to your own private email.</span>';
  }

  function lockNow(msg) {
    DB = null; KEY = null; JWK = null; IDX = null; PID = null;
    LS.del("bt_session"); SS.del("bt_session");
    closeSheet();
    UI.auth = { step: readMeta() ? "lock" : "welcome", error: "", busy: false, msg: msg || "" };
    renderAuth();
  }

  /* ---------------- sync ---------------- */
  let syncBusy = false, syncAgain = false, syncTimer = null;
  function setSyncStatus(s) {
    sync.status = s;
    $$("[data-sync]").forEach((el) => { el.innerHTML = syncLine(); });
  }
  function syncLine() {
    if (!SYNC_URL) return '<span class="dot off"></span>This device only · sync is off';
    if (sync.status === "busy") return '<span class="dot busy"></span>Syncing…';
    if (sync.status === "error") return '<span class="dot warn"></span>' + (navigator.onLine === false ? "Offline · will sync later" : "Couldn't sync · tap to retry");
    if (sync.last) return '<span class="dot"></span>Synced · locked with passcode';
    return '<span class="dot off"></span>Not synced yet';
  }
  function scheduleSync() {
    sync.dirty = true;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 1200);
  }
  async function syncNow() {
    if (!SYNC_URL || !KEY || !VID) return;
    if (syncBusy) { syncAgain = true; return; }
    syncBusy = true;
    setSyncStatus("busy");
    const myVid = VID;
    try {
      await flushDoors();
      let done = false;
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        const r = await fetch(SYNC_URL + "/v/" + myVid, { cache: "no-store" });
        let remote = null, rv = 0;
        if (r.status === 200) {
          const j = await r.json();
          rv = j.v;
          remote = await decryptObj(j.blob);
        } else if (r.status !== 404) throw new Error("GET " + r.status);
        if (!DB || VID !== myVid) return;
        let changed = false;
        if (remote) {
          const before = fingerprint(DB);
          DB = normalize(merge(DB, remote));
          changed = fingerprint(DB) !== before;
          if (DB.keyring.pid && PID && DB.keyring.pid !== PID) {
            await saveLocal();
            lockNow("Your passcode was changed on another device. Enter the new passcode.");
            return;
          }
        }
        const needPush = sync.dirty || !remote || fingerprint(DB) !== fingerprint(normalize(remote));
        if (needPush) {
          const blob = await encryptObj(DB);
          const p = await fetch(SYNC_URL + "/v/" + myVid, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base: rv, blob }) });
          if (p.status === 409) continue;
          if (!p.ok) throw new Error("PUT " + p.status);
          sync.v = (await p.json()).v;
        } else sync.v = rv;
        sync.dirty = false;
        sync.last = Date.now();
        done = true;
        try { await ensureDoors(); } catch (e) { console.warn("[bill-tracker] couldn't upload unlock keys yet", e); }
        await saveLocal();
        if (changed) { rebuildIndex(); softRender(); }
      }
      setSyncStatus(done ? "ok" : "error");
    } catch (e) {
      console.warn("[bill-tracker] sync failed", e);
      setSyncStatus("error");
    } finally {
      syncBusy = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }
  // Autopay bills pay themselves: once the due date arrives, record the payment.
  // If you mark one unpaid, that choice is remembered and it isn't re-added.
  function autopayCatchUp() {
    const t = today();
    const known = new Set(DB.payments.map((p) => p.id));
    let n = 0;
    for (const b of IDX.bills) {
      if (!b.autopay) continue;
      for (const d of billDates(b, addDays(t, -70), addDays(t, 7))) {
        const key = b.id + "|" + d;
        if (known.has(key)) continue;
        const o = makeOcc(b, d);
        if (o.date > t || o.date < addDays(t, -62)) continue;
        upsert("payments", { id: key, billId: b.id, date: d, amount: o.amount, paidOn: o.date, name: b.name, category: b.category, auto: true, deleted: false });
        n++;
      }
    }
    if (n) rebuildIndex();
    return n;
  }
  async function commit() {
    rebuildIndex();
    autopayCatchUp();
    render();
    scheduleSync();
    await saveLocal();
  }

  /* ---------------- bank holidays ----------------
   * US Federal Reserve holidays. One that lands on a Sunday is observed on the
   * Monday; one on a Saturday isn't moved (banks are open that Friday).
   */
  const HOLI = new Map();
  function holidaysFor(y) {
    if (HOLI.has(y)) return HOLI.get(y);
    const nth = (m0, dow, n) => { const d = new Date(y, m0, 1); const off = (dow - d.getDay() + 7) % 7; return iso(new Date(y, m0, 1 + off + (n - 1) * 7)); };
    const last = (m0, dow) => { const d = new Date(y, m0 + 1, 0); const off = (d.getDay() - dow + 7) % 7; return iso(new Date(y, m0 + 1, -off)); };
    const fixed = (m0, d) => { const dt = new Date(y, m0, d); if (dt.getDay() === 0) dt.setDate(dt.getDate() + 1); return iso(dt); };
    const list = [
      [fixed(0, 1), "New Year's Day"], [nth(0, 1, 3), "Martin Luther King Jr. Day"], [nth(1, 1, 3), "Presidents' Day"],
      [last(4, 1), "Memorial Day"], [fixed(5, 19), "Juneteenth"], [fixed(6, 4), "Independence Day"],
      [nth(8, 1, 1), "Labor Day"], [nth(9, 1, 2), "Columbus Day"], [fixed(10, 11), "Veterans Day"],
      [nth(10, 4, 4), "Thanksgiving"], [fixed(11, 25), "Christmas Day"],
    ];
    const m = new Map(list.filter(([d]) => parseD(d).getDay() !== 6));
    HOLI.set(y, m);
    return m;
  }
  const holidayName = (d) => holidaysFor(+d.slice(0, 4)).get(d) || null;
  const isBusinessDay = (d) => { const w = parseD(d).getDay(); return w !== 0 && w !== 6 && !holidayName(d); };
  function shiftDate(d, mode) {
    if (!mode || mode === "none") return d;
    let x = d, guard = 0;
    while (!isBusinessDay(x) && guard++ < 10) x = addDays(x, mode === "before" ? -1 : 1);
    return x;
  }
  const whyClosed = (d) => holidayName(d) || (parseD(d).getDay() === 0 ? "Sunday" : "Saturday");

  /* ---------------- schedule math ---------------- */
  function paydaysBetween(a, z) {
    // Paydays on a weekend or bank holiday move (by default to the business day before).
    const mode = (DB.settings.pay && DB.settings.pay.shift) || "before";
    const raw = rawPaydays(addDays(a, -7), addDays(z, 7));
    const out = [];
    for (const d of raw) { const s = shiftDate(d, mode); if (s >= a && s <= z && !out.includes(s)) out.push(s); }
    return out.sort();
  }
  function rawPaydays(a, z) {
    const p = DB.settings.pay;
    const out = [];
    if (!p || !p.freq) return out;
    if (p.freq === "weekly" || p.freq === "biweekly") {
      if (!p.anchor) return out;
      const step = p.freq === "weekly" ? 7 : 14;
      const k = Math.floor(diffDays(p.anchor, a) / step);
      let d = addDays(p.anchor, k * step);
      while (d < a) d = addDays(d, step);
      while (d <= z) { out.push(d); d = addDays(d, step); }
    } else {
      const days = p.freq === "semimonthly" ? [Number(p.day1) || 1, Number(p.day2) || 15] : [Number(p.day1) || 1];
      let mk = a.slice(0, 7);
      while (mk <= z.slice(0, 7)) {
        const [y, m] = mk.split("-").map(Number);
        for (const dd of days) { const s = ymd(y, m - 1, dd); if (s >= a && s <= z && !out.includes(s)) out.push(s); }
        mk = addMonths(mk, 1);
      }
      out.sort();
    }
    return out;
  }
  const paydayOnOrBefore = (t) => { const l = paydaysBetween(addDays(t, -40), t); return l[l.length - 1] || null; };
  const paydayAfter = (t) => paydaysBetween(addDays(t, 1), addDays(t, 40))[0] || null;
  const checkAmount = (d) => { const c = IDX.checks.get(d); return c ? c.amount : Number(DB.settings.pay.amount) || 0; };
  const payConfigured = () => { const p = DB.settings.pay; return !!(p && p.freq && (p.freq === "semimonthly" || p.freq === "monthly" || p.anchor)); };

  function billDates(b, a, z) {
    const out = [];
    if (!b || b.deleted) return out;
    const from = b.start || "0000-01-01";
    const until = b.until || "9999-12-31";
    const lo = a > from ? a : from;
    if (lo > z) return out;
    const ok = (d) => d >= lo && d <= z && d < until;
    if (b.repeat === "monthly") {
      let mk = lo.slice(0, 7);
      while (mk <= z.slice(0, 7)) {
        const [y, m] = mk.split("-").map(Number);
        const d = ymd(y, m - 1, Number(b.day) || 1);
        if (ok(d)) out.push(d);
        mk = addMonths(mk, 1);
      }
    } else if (b.repeat === "yearly") {
      for (let y = +lo.slice(0, 4); y <= +z.slice(0, 4); y++) { const d = ymd(y, Number(b.month) || 0, Number(b.day) || 1); if (ok(d)) out.push(d); }
    } else if (b.repeat === "biweekly") {
      if (!b.date) return out;
      let k = Math.max(0, Math.ceil(diffDays(b.date, lo) / 14));
      let d = addDays(b.date, k * 14);
      while (d <= z) { if (ok(d)) out.push(d); d = addDays(d, 14); }
    } else if (b.repeat === "once") {
      if (b.date && ok(b.date)) out.push(b.date);
    }
    return out;
  }
  function prevDate(b, d) {
    const [y, m, dd] = d.split("-").map(Number);
    if (b.repeat === "monthly") return ymd(y, m - 2, Number(b.day) || dd);
    if (b.repeat === "yearly") return ymd(y - 1, m - 1, Number(b.day) || dd);
    if (b.repeat === "biweekly") return addDays(d, -14);
    return null;
  }
  function lastPaidBefore(billId, d) {
    const list = IDX.byBill.get(billId) || [];
    let found = null;
    for (const p of list) if (p.date < d) found = p;
    return found;
  }
  // d is the scheduled due date (what the bill says). date is when it actually
  // comes due after moving off a weekend or bank holiday. Payments are stored
  // against the scheduled date, so changing the rule never loses them.
  const billShift = (b) => b.shift || "after";
  function makeOcc(b, d) {
    const key = b.id + "|" + d;
    const pay = IDX.pay.get(key) || null;
    let amount = Number(b.amount) || 0;
    if (pay) amount = pay.amount;
    else if (b.varies) { const lp = lastPaidBefore(b.id, d); if (lp) amount = lp.amount; }
    const date = shiftDate(d, billShift(b));
    return { b, date, nominal: d, moved: date !== d, key, pay, paid: !!pay, amount: r2(amount) };
  }
  function occurrences(a, z) {
    const out = [];
    for (const b of IDX.bills) for (const d of billDates(b, addDays(a, -7), addDays(z, 7))) { const o = makeOcc(b, d); if (o.date >= a && o.date <= z) out.push(o); }
    out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.b.name.localeCompare(y.b.name)));
    return out;
  }
  function priceChange(o) {
    const prev = prevDate(o.b, o.nominal || o.date);
    if (!prev) return null;
    const pp = IDX.pay.get(o.b.id + "|" + prev);
    let prevAmt = pp ? pp.amount : null;
    if (prevAmt == null && o.b.prevAmount != null && o.b.amountChangedOn && o.b.amountChangedOn > prev) prevAmt = o.b.prevAmount;
    if (prevAmt == null) return null;
    const diff = r2(o.amount - prevAmt);
    return Math.abs(diff) >= 1 ? { prev: prevAmt, diff, prevDate: prev } : null;
  }
  const monthlyEquiv = (b) => {
    const a = makeOcc(b, today()).amount;
    return b.repeat === "monthly" ? a : b.repeat === "yearly" ? a / 12 : b.repeat === "biweekly" ? (a * 26) / 12 : 0;
  };

  function saveGoalsFor(payday) {
    const out = [];
    for (const g of IDX.goals) {
      if (g.kind !== "save") continue;
      const remaining = r2((Number(g.target) || 0) - (Number(g.saved) || 0));
      const per = Number(g.perCheck) || 0;
      if (per <= 0 || remaining <= 0) continue;
      if (g.by && payday > g.by) continue;
      if (g.createdOn && payday < paydayOnOrBefore(g.createdOn)) continue;
      out.push({ g, amount: Math.min(per, remaining) });
    }
    return out;
  }
  function period(payday) {
    if (!payday) return null;
    const next = paydayAfter(payday);
    const end = next ? addDays(next, -1) : addDays(payday, 13);
    const prev = paydayOnOrBefore(addDays(payday, -1));
    const occs = occurrences(payday, end);
    const goals = saveGoalsFor(payday);
    const holdOut = IDX.holds.get(payday) ? IDX.holds.get(payday).amount : 0;
    const holdIn = prev && IDX.holds.get(prev) ? IDX.holds.get(prev).amount : 0;
    const income = checkAmount(payday);
    const billsTotal = sum(occs, "amount");
    const goalTotal = sum(goals, "amount");
    const left = r2(income + holdIn - billsTotal - goalTotal - holdOut);
    return { payday, end, next, income, occs, goals, goalTotal, billsTotal, holdOut, holdIn, left };
  }
  const currentPeriod = () => (payConfigured() ? period(paydayOnOrBefore(today())) : null);
  function holdSuggestion(cur, nxt) {
    if (!cur || !nxt || IDX.holds.get(cur.payday)) return null;
    const gap = cur.left - nxt.left;
    if (gap < 100) return null;
    let h = Math.floor(gap / 2 / 10) * 10;
    h = Math.min(h, Math.max(0, Math.floor(cur.left / 10) * 10));
    if (h < 20) return null;
    const big = nxt.occs.slice().sort((x, y) => y.amount - x.amount)[0];
    return { amount: h, big, nxt };
  }

  function debtInfo(g) {
    const since = g.createdOn || "0000-01-01";
    const billPaid = g.billId ? sum((IDX.byBill.get(g.billId) || []).filter((p) => p.date >= since), "amount") : 0;
    const extra = sum(g.extra || [], "amount");
    const start = Number(g.start) || 0;
    const balance = Math.max(0, r2(start - billPaid - extra));
    const bill = g.billId ? IDX.billById.get(g.billId) : null;
    const monthly = Number(g.payment) || (bill && !bill.deleted ? r2(monthlyEquiv(bill)) : 0);
    return { start, balance, monthly, bill, paidPct: start > 0 ? Math.min(100, Math.round(((start - balance) / start) * 100)) : 0 };
  }
  function payoff(balance, apr, monthly) {
    if (balance <= 0) return { months: 0, interest: 0 };
    const r = (Number(apr) || 0) / 1200;
    if (monthly <= 0 || monthly <= balance * r) return { months: Infinity, interest: 0 };
    let b = balance, m = 0, interest = 0;
    while (b > 0.005 && m < 600) { const i = b * r; interest += i; b = b + i - monthly; m++; }
    return { months: m, interest: r2(interest) };
  }
  const monthsLabel = (m) => { if (!isFinite(m)) return "never at this rate"; const mk = addMonths(today().slice(0, 7), m); return fmtMonShort(mk); };
  function saveGoalInfo(g) {
    const target = Number(g.target) || 0, saved = Number(g.saved) || 0, per = Number(g.perCheck) || 0;
    const remaining = Math.max(0, r2(target - saved));
    const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
    let eta = null, need = null;
    const upcoming = paydaysBetween(addDays(today(), 1), addDays(today(), 900));
    if (per > 0 && remaining > 0) { const n = Math.ceil(remaining / per); eta = upcoming[n - 1] || null; }
    if (g.by && remaining > 0) { const cnt = upcoming.filter((d) => d <= g.by).length; need = cnt > 0 ? Math.ceil(remaining / cnt) : remaining; }
    return { target, saved, per, remaining, pct, eta, need };
  }

  /* ---------------- labels ---------------- */
  function statusFor(o) {
    const t = today();
    const bits = [];
    let cls = "";
    if (o.paid) {
      bits.push("Paid " + fmtShort(o.pay.paidOn || o.date));
      cls = "paidtxt";
    } else {
      const n = diffDays(t, o.date);
      if (n < 0) { bits.push("Overdue · was due " + fmtShort(o.date)); cls = "warn"; }
      else if (n === 0) { bits.push("Due today"); cls = "warn"; }
      else if (n <= 7) { bits.push("Due " + fmtShort(o.date) + " · " + inDays(n)); cls = "warn"; }
      else bits.push("Due " + fmtShort(o.date));
    }
    if (o.moved && !o.paid) bits.push("moved from " + fmtShort(o.nominal) + " (" + whyClosed(o.nominal) + ")");
    if (o.b.autopay) bits.push("autopay");
    if (!o.paid && o.b.varies) bits.push("estimate");
    return { text: bits.join(" · "), cls };
  }
  function dueText(b) {
    if (b.repeat === "monthly") return "Every month on the " + ordinal(Number(b.day) || 1);
    if (b.repeat === "yearly") return "Every year on " + MON[Number(b.month) || 0] + " " + (Number(b.day) || 1);
    if (b.repeat === "biweekly") return "Every 2 weeks from " + fmtShort(b.date);
    return "Once, on " + fmtDow(b.date);
  }

  /* ---------------- routing + shell ---------------- */
  function route() {
    const h = (location.hash || "").replace(/^#\/?/, "");
    const [name, arg] = h.split("/");
    return { name: name || "home", arg: arg ? decodeURIComponent(arg) : "" };
  }
  const go = (path) => { if (location.hash !== "#/" + path) location.hash = "#/" + path; else render(); };
  const NAV = [
    ["home", "Home", "home"], ["paychecks", "Paychecks", "pay"], ["calendar", "Calendar", "cal"],
    ["insights", "Insights", "chart"], ["goals", "Goals", "goal"],
  ];

  function shell(active, content) {
    const side = NAV.concat([["settings", "Settings", "gear"]]).map(([k, label, ic]) =>
      '<a class="navlink' + (active === k ? " on" : "") + '" href="#/' + k + '"' + (active === k ? ' aria-current="page"' : "") + ">" + icon(ic) + label + "</a>").join("");
    const tabs = NAV.map(([k, label, ic]) =>
      '<a class="tab' + (active === k ? " on" : "") + '" href="#/' + k + '"' + (active === k ? ' aria-current="page"' : "") + ">" + icon(ic, 22) + label + "</a>").join("");
    return '<div class="shell">' +
      '<aside class="side" aria-label="Main menu"><div class="brand"><span class="logo">' + icon("logo", 18, 2.2) + "</span>Bill Tracker</div>" + side +
      '<div class="spacer"></div><button class="syncline" data-act="syncNow" data-sync title="Sync now">' + syncLine() + "</button></aside>" +
      '<div class="main"><main id="view">' + content + "</main></div>" +
      '<nav class="tabbar" aria-label="Main menu">' + tabs + "</nav></div>";
  }

  function render() {
    if (!DB) return renderAuth();
    if (!IDX) rebuildIndex();
    const r = route();
    let html = "", active = r.name;
    try {
      switch (r.name) {
        case "paychecks": html = viewPaychecks(); break;
        case "calendar": html = viewCalendar(); break;
        case "insights": html = viewInsights(); break;
        case "goals": html = viewGoals(); break;
        case "settings": html = viewSettings(); break;
        case "bill": html = viewBillForm(r.arg); active = "home"; break;
        default: html = viewHome(); active = "home";
      }
    } catch (e) {
      console.error(e);
      html = '<div class="card"><h2>Something went wrong drawing this page.</h2><p class="muted">' + esc(e.message) + '</p><a class="btn" href="#/home">Go home</a></div>';
    }
    const y = window.scrollY;
    $("#root").innerHTML = shell(active, html);
    if (UI.keepScroll) { window.scrollTo(0, y); UI.keepScroll = false; }
    UI.pendingRender = false;
  }
  function softRender() {
    // Re-draw after a background sync without wiping a half-filled form.
    if (route().name === "bill" || $("#sheetroot").innerHTML) { UI.pendingRender = true; return; }
    UI.keepScroll = true;
    render();
  }

  /* ---------------- shared pieces ---------------- */
  function billRow(o, opts) {
    const st = statusFor(o);
    const pc = !o.paid || o.date.slice(0, 7) === today().slice(0, 7) ? priceChange(o) : null;
    const up = pc && pc.diff > 0 ? '<span class="badge warn">+' + money(pc.diff) + "</span>" : "";
    return '<div class="billrow' + (o.paid ? " paid" : "") + '">' +
      '<button class="check' + (o.paid ? " on" : "") + '" data-act="togglePaid" data-key="' + esc(o.key) + '" aria-pressed="' + o.paid + '" aria-label="' + esc((o.paid ? "Mark unpaid: " : "Mark paid: ") + o.b.name + " " + fmtShort(o.date)) + '"><span class="ring">' + (o.paid ? icon("check", 14, 3) : "") + "</span></button>" +
      '<button class="billmain" data-act="openBill" data-key="' + esc(o.key) + '">' +
      '<span><span class="billname">' + esc(o.b.name) + '</span><span class="billmeta dueonphone ' + st.cls + '">' + esc(st.text) + "</span></span>" +
      '<span class="billcat">' + esc(o.b.category || "Other") + "</span>" +
      '<span class="billdue ' + st.cls + '">' + esc(st.text) + "</span>" +
      '<span class="billamt">' + money(o.amount) + up + "</span></button></div>";
  }
  function billTable(occs) {
    return '<div class="bills table"><div class="tablehead desk-only"><span></span><span>Bill</span><span>Category</span><span>Due</span><span>Amount</span></div>' + occs.map((o) => billRow(o)).join("") + "</div>";
  }
  function monthNav(mk, act) {
    return '<div class="headactions"><button class="iconbtn" data-act="' + act + '" data-dir="-1" aria-label="Previous month">' + icon("left", 18, 2.2) + '</button><button class="iconbtn" data-act="' + act + '" data-dir="1" aria-label="Next month">' + icon("right", 18, 2.2) + "</button></div>";
  }
  function explainLeft(p) {
    const parts = [money(p.billsTotal) + " in bills"];
    if (p.goalTotal) parts.push(money(p.goalTotal) + " to savings");
    if (p.holdOut) parts.push(money(p.holdOut) + " held for next check");
    let s = "After " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]);
    if (p.holdIn) s += ", plus " + money(p.holdIn) + " held from last check";
    return s;
  }
  function templateChips() {
    return '<div class="chips">' + TEMPLATES.filter((t) => !t.blank).slice(0, 8).map((t) =>
      '<a class="chip" href="#/bill/new?t=' + encodeURIComponent(t.name) + '">' + icon("plus", 14, 2.4) + esc(t.name) + "</a>").join("") + "</div>";
  }

  /* ---------------- views: Home ---------------- */
  function viewHome() {
    const t = today();
    const mk = UI.homeMonth || t.slice(0, 7);
    const a = mk + "-01", z = monthEnd(mk);
    const occs = occurrences(a, z);
    const total = sum(occs, "amount"), paid = sum(occs.filter((o) => o.paid), "amount"), owed = r2(total - paid);
    const income = payConfigured() ? sum(paydaysBetween(a, z), (d) => checkAmount(d)) : 0;
    const cur = currentPeriod();
    const name = DB.settings.name ? "Hi " + esc(DB.settings.name) : "Your bills";

    const overdue = occurrences(addDays(t, -120), addDays(t, -1)).filter((o) => !o.paid);
    const soon = occurrences(t, addDays(t, 7)).filter((o) => !o.paid);
    const ups = occurrences(t.slice(0, 7) + "-01", monthEnd(t.slice(0, 7))).map((o) => ({ o, pc: priceChange(o) })).filter((x) => x.pc && x.pc.diff > 0);

    let hero;
    if (cur) {
      const short = cur.left < 0;
      hero = '<div class="hero"><span class="sub">' + (short ? "Short this paycheck" : "Safe to spend") + (cur.next ? " until " + fmtShort(cur.next) : "") + '</span>' +
        '<span class="huge">' + money(short ? -cur.left : cur.left) + "</span>" +
        '<span class="sub">' + (short ? "Bills and savings for this check add up to more than it pays. See Paychecks to rebalance." : esc(explainLeft(cur))) + "</span>" +
        '<div class="bar" role="img" aria-label="' + Math.round(total ? (paid / total) * 100 : 0) + '% of this month\'s bills paid"><span style="width:' + (total ? Math.round((paid / total) * 100) : 0) + '%"></span></div></div>';
    } else {
      hero = '<div class="hero"><span class="sub">Safe to spend</span><span class="big">Add your paycheck</span><span class="sub">Tell the app when you get paid and how much, and it works out what\'s safe to spend.</span><a class="btn" style="align-self:flex-start;margin-top:6px" href="#/settings">Set up paycheck</a></div>';
    }
    const kpis = '<div class="kpis">' + hero +
      '<div class="kpi"><span class="label">Total bills</span><span class="value">' + money(total) + '</span><span class="note desk-only">' + (income ? money(income - total) + " left of " + money(income) + " income" : occs.length + " bills this month") + "</span></div>" +
      '<div class="kpi"><span class="label">Paid so far</span><span class="value accent-text">' + money(paid) + '</span><div class="bar thin desk-only"><span style="width:' + (total ? Math.round((paid / total) * 100) : 0) + '%"></span></div></div>' +
      '<div class="kpi"><span class="label">Still owed</span><span class="value' + (owed > 0 ? " warn-text" : "") + '">' + money(owed) + '</span><span class="note desk-only">' + (soon.length ? soon.length + " due in the next 7 days" : "Nothing due this week") + "</span></div></div>";

    const alerts = [];
    if (overdue.length) alerts.push('<div class="banner warn">' + icon("alert") + '<span class="grow-text">' + overdue.length + (overdue.length === 1 ? " bill is" : " bills are") + " past due: " + esc(overdue.slice(0, 3).map((o) => o.b.name).join(", ")) + (overdue.length > 3 ? "…" : "") + ". Tick them off once they're paid.</span></div>");
    if (soon.length) alerts.push('<div class="banner warn">' + icon("clock") + '<span class="grow-text">' + soon.length + (soon.length === 1 ? " bill" : " bills") + " due in the next 7 days · " + money(sum(soon, "amount")) + "</span></div>");
    if (DB.settings.reminders.price && ups.length) alerts.push('<div class="banner warn">' + icon("up") + '<span class="grow-text">' + esc(ups.slice(0, 2).map((x) => x.o.b.name + " is " + money(x.pc.diff) + " higher than last time").join(", and ")) + (ups.length > 2 ? ", plus " + (ups.length - 2) + " more" : "") + ".</span></div>");

    let list;
    if (!IDX.bills.length) {
      list = '<div class="card empty"><h2>Add your first bill</h2><p>Pick a common one to start, or add your own. You can mark bills paid with one tap.</p>' + templateChips() + '<a class="btn primary" href="#/bill/new">' + icon("plus", 18, 2.4) + "Add a bill</a></div>";
    } else if (!occs.length) {
      list = '<div class="card empty"><p>No bills due in ' + fmtMonth(mk) + ".</p></div>";
    } else list = billTable(occs);

    let side = "";
    if (cur) {
      side += '<div class="card outline"><div class="cardhead"><div class="stack" style="gap:3px"><span class="kicker accent">Current paycheck</span><h3>' + fmtDow(cur.payday) + " · " + money(cur.income) + '</h3></div><a href="#/paychecks" class="small">Planner</a></div>' +
        cur.occs.slice(0, 6).map((o) => '<div class="line"><span>' + esc(o.b.name) + " · " + fmtShort(o.date) + '</span><span class="amt">' + money(o.amount) + "</span></div>").join("") +
        (cur.occs.length > 6 ? '<span class="small muted">+ ' + (cur.occs.length - 6) + " more</span>" : "") +
        cur.goals.map((x) => '<div class="line"><span>' + esc(x.g.name) + '</span><span class="amt">' + money(x.amount) + "</span></div>").join("") +
        (cur.holdOut ? '<div class="line"><span>Held for next check</span><span class="amt">' + money(cur.holdOut) + "</span></div>" : "") +
        '<div class="line total"><span class="muted">Safe to spend</span><span class="big accent-text" style="font-size:22px">' + money(cur.left) + "</span></div></div>";
    }
    const goals = IDX.goals.slice(0, 3);
    if (goals.length) {
      side += '<div class="card"><div class="cardhead"><h3>Goals</h3><a href="#/goals" class="small">All goals</a></div>' + goals.map((g) => {
        if (g.kind === "debt") { const d = debtInfo(g); return '<div class="cat"><div class="line"><span class="strong">' + esc(g.name) + '</span><span class="muted">' + money(d.balance) + ' left</span></div><div class="bar thin"><span class="teal" style="width:' + d.paidPct + '%"></span></div></div>'; }
        const s = saveGoalInfo(g);
        return '<div class="cat"><div class="line"><span class="strong">' + esc(g.name) + '</span><span class="muted">' + money(s.saved) + " / " + money(s.target) + '</span></div><div class="bar thin"><span style="width:' + s.pct + '%"></span></div></div>';
      }).join("") + "</div>";
    }
    const subs = IDX.bills.filter((b) => b.category === "Subscriptions" && !(b.until && b.until <= t));
    if (subs.length) {
      const m = sum(subs, monthlyEquiv);
      side += '<a class="banner warn" href="#/insights" style="justify-content:space-between"><span class="stack" style="gap:2px"><span class="strong">Subscriptions</span><span class="small">' + subs.length + " active · " + money(m) + ' a month</span></span><span class="big" style="font-size:22px">' + money(m * 12) + "/yr</span></a>";
    }

    return '<div class="pagehead"><div class="stack" style="gap:2px"><span class="sub">' + name + "</span><h1>" + fmtMonth(mk) + "</h1></div>" +
      '<div class="headactions">' + monthNav(mk, "homeMonth") +
      '<a class="btn primary desk-only" href="#/bill/new">' + icon("plus", 18, 2.4) + "Add bill</a>" +
      '<a class="iconbtn primary phone-only" href="#/bill/new" aria-label="Add a bill">' + icon("plus", 20, 2.4) + "</a>" +
      '<a class="iconbtn phone-only" href="#/settings" aria-label="Settings">' + icon("gear") + "</a></div></div>" +
      kpis + alerts.join("") +
      '<div class="row-wrap"><section class="grow stack" aria-label="Bills"><div class="cardhead phone-only"><h2>Bills this month</h2><span class="meta">Tap the circle to mark paid</span></div>' + list + "</section>" +
      (side ? '<div class="aside desk-only">' + side + "</div>" : "") + "</div>";
  }

  /* ---------------- views: Paychecks ---------------- */
  function periodCard(p, label, opts) {
    const isCur = opts && opts.current;
    const lines = p.occs.map((o) => {
      const pc = priceChange(o);
      return '<div class="line"><span>' + esc(o.b.name) + " · " + fmtShort(o.date) + (o.paid ? ' <span class="badge paid">paid</span>' : "") + (pc && pc.diff > 0 ? ' <span class="badge warn">+' + money(pc.diff) + "</span>" : "") + '</span><span class="amt">' + money(o.amount) + "</span></div>";
    }).join("") || '<span class="small muted">No bills due in this stretch.</span>';
    const goals = p.goals.map((x) => '<div class="line"><span>' + esc(x.g.name) + '</span><span class="amt">' + money(x.amount) + "</span></div>").join("");
    const hold = p.holdOut ? '<div class="line"><span>Held for next check <button class="linkbtn" data-act="removeHold" data-day="' + p.payday + '">Remove</button></span><span class="amt">' + money(p.holdOut) + "</span></div>" : "";
    const holdIn = p.holdIn ? '<div class="line accent-text"><span>Held from last check</span><span class="amt">+' + money(p.holdIn) + "</span></div>" : "";
    const spent = p.billsTotal + p.goalTotal + p.holdOut;
    const pctB = p.income > 0 ? Math.min(100, Math.round((p.billsTotal / (p.income + p.holdIn)) * 100)) : 0;
    const pctO = p.income > 0 ? Math.min(100 - pctB, Math.round(((p.goalTotal + p.holdOut) / (p.income + p.holdIn)) * 100)) : 0;
    return '<section class="card' + (isCur ? " outline" : "") + '"><div class="cardhead" style="align-items:flex-start"><div class="stack" style="gap:4px"><span class="kicker' + (isCur ? " accent" : "") + '">' + label + "</span><h3 style=\"font-size:18px\">" + fmtDow(p.payday) + '</h3><span class="small muted">Bills due ' + fmtShort(p.payday) + " – " + fmtShort(p.end) + '</span></div><div class="stack" style="gap:0;align-items:flex-end"><span class="strong" style="font-size:18px">' + money(p.income) + '</span><button class="linkbtn" data-act="editCheck" data-day="' + p.payday + '">Edit</button></div></div>' +
      lines + goals + hold + holdIn +
      (p.income ? '<div class="bar" aria-hidden="true"><span style="width:' + pctB + '%"></span><span class="soft" style="width:' + pctO + '%"></span></div>' : "") +
      '<div class="line total"><span class="muted">' + (p.left < 0 ? "Short by" : "Safe to spend") + '</span><span class="big ' + (p.left < 0 ? "warn-text" : isCur ? "accent-text" : "") + '" style="font-size:22px">' + money(Math.abs(p.left)) + "</span></div></section>";
  }
  function viewPaychecks() {
    if (!payConfigured()) {
      return '<div class="pagehead"><h1>Paycheck planner</h1></div><div class="card empty"><h2>Add your paycheck first</h2><p>Enter how much you get paid and when, and the planner shows which bills each check covers.</p><a class="btn primary" href="#/settings">Set up paycheck</a></div>';
    }
    const t = today();
    const curDay = paydayOnOrBefore(t);
    const prevDay = paydayOnOrBefore(addDays(curDay, -1));
    const nextDay = paydayAfter(curDay);
    const next2 = nextDay ? paydayAfter(nextDay) : null;
    const cur = period(curDay), nxt = period(nextDay);
    const sug = holdSuggestion(cur, nxt);
    const p = DB.settings.pay;
    let banner = "";
    if (sug) {
      banner = '<div class="banner tip wrap">' + icon("bulb") + '<span class="grow-text">' + (sug.big ? esc(sug.big.b.name) + " lands on the " + fmtShort(sug.nxt.payday) + " check. " : "The " + fmtShort(sug.nxt.payday) + " check is tighter. ") + "Holding " + money(sug.amount) + ' from this one evens them out.</span><button class="btn primary small" data-act="hold" data-day="' + cur.payday + '" data-amt="' + sug.amount + '">Hold ' + money(sug.amount) + "</button></div>";
    } else if (cur.left < 0) {
      banner = '<div class="banner warn">' + icon("alert") + '<span class="grow-text">This check is short by ' + money(-cur.left) + ". Moving a bill's due date, or holding money from the check before, would help.</span></div>";
    }
    const cards = [];
    if (prevDay) cards.push(periodCard(period(prevDay), "Paid out"));
    cards.push(periodCard(cur, "Current", { current: true }));
    if (nxt) cards.push(periodCard(nxt, "Next"));
    if (next2) cards.push(periodCard(period(next2), "After that"));

    const r = DB.settings.reminders;
    const preview = nxt ? '<div class="notif"><span class="logo">' + icon("logo", 18, 2.2) + '</span><span class="stack" style="gap:3px"><span class="t">Calendar · night before ' + fmtShort(nxt.payday) + '</span><span class="h">Payday tomorrow: ' + money(nxt.income) + '</span><span class="b">' + (nxt.occs.length ? "This check covers " + esc(nxt.occs.slice(0, 3).map((o) => o.b.name).join(", ")) + (nxt.occs.length > 3 ? " and more" : "") + " (" + money(nxt.billsTotal) + "). " : "No bills due before the next one. ") + "Safe to spend: " + money(nxt.left) + ".</span></span></div>" : "";
    return '<div class="pagehead"><div class="stack" style="gap:2px"><span class="sub">Paid ' + esc(FREQS[p.freq].toLowerCase()) + " · " + money(p.amount) + " per check</span><h1>Paycheck planner</h1></div></div>" +
      banner + '<div class="grid-auto">' + cards.join("") + "</div>" +
      '<div class="row-wrap"><section class="card" style="flex:1 1 340px"><div class="setting"><span class="txt">Payday reminders<span>' + (r.payday ? "On · a calendar alert the night before each payday" : "Off") + '</span></span><button class="switch" role="switch" aria-checked="' + !!r.payday + '" aria-label="Payday reminders" data-act="toggleReminder" data-k="payday"><span></span></button></div><span class="small muted">Reminders go through your phone\'s calendar. After changing this, download the calendar file again in <a href="#/settings">Settings</a>.</span></section>' +
      '<div style="flex:1 1 340px;min-width:0">' + preview + "</div></div>";
  }

  /* ---------------- views: Calendar ---------------- */
  function viewCalendar() {
    const t = today();
    const mk = UI.calMonth || t.slice(0, 7);
    const sel = UI.calSel && UI.calSel.slice(0, 7) === mk ? UI.calSel : mk === t.slice(0, 7) ? t : mk + "-01";
    const [y, m] = mk.split("-").map(Number);
    const first = new Date(y, m - 1, 1).getDay();
    const days = dim(y, m - 1);
    const occs = occurrences(mk + "-01", monthEnd(mk));
    const byDay = new Map();
    for (const o of occs) { if (!byDay.has(o.date)) byDay.set(o.date, []); byDay.get(o.date).push(o); }
    const paydays = new Set(payConfigured() ? paydaysBetween(mk + "-01", monthEnd(mk)) : []);
    let cells = "";
    for (let i = 0; i < first; i++) cells += '<span class="calcell blank" aria-hidden="true"></span>';
    for (let d = 1; d <= days; d++) {
      const ds = mk + "-" + pad(d);
      const list = byDay.get(ds) || [];
      const isPay = paydays.has(ds);
      const dots = (isPay ? '<i class="pay"></i>' : "") + list.slice(0, 3).map((o) => '<i class="' + (o.paid ? "paid" : "") + '"></i>').join("");
      const hol = holidayName(ds);
      const chips = (hol ? '<span class="hol">' + esc(hol) + "</span>" : "") + (isPay ? '<span class="pay">Payday</span>' : "") + list.slice(0, 3).map((o) => '<span class="' + (o.paid ? "paid" : "due") + '">' + esc(o.b.name) + " " + money(o.amount) + "</span>").join("") + (list.length > 3 ? '<span class="small muted">+' + (list.length - 3) + " more</span>" : "");
      const label = fmtLong(ds) + (hol ? ", " + hol + ", banks closed" : "") + (isPay ? ", payday" : "") + (list.length ? ", " + list.length + (list.length === 1 ? " bill" : " bills") : "");
      cells += '<button class="calcell' + (hol ? " holiday" : "") + (ds === t ? " today" : "") + (ds === sel ? " sel" : "") + '" data-act="calSel" data-day="' + ds + '" aria-label="' + esc(label) + '" aria-pressed="' + (ds === sel) + '"><span class="num">' + d + '</span><span class="dots">' + dots + '</span><span class="calchips">' + chips + "</span></button>";
    }
    const items = byDay.get(sel) || [];
    let detail = "";
    if (holidayName(sel)) detail += '<div class="banner tip">' + icon("cal") + '<span class="grow-text">' + esc(holidayName(sel)) + ". Banks are closed. Bills set to move off holidays show on their new day; any still listed here are set to keep the date.</span></div>";
    if (paydays.has(sel)) {
      const p = period(sel);
      detail += '<div class="card"><div class="line"><span class="strong" style="font-size:16px">Payday</span><span class="big teal-text" style="font-size:20px">+' + money(p.income) + '</span></div><span class="small muted">Covers ' + p.occs.length + " bill" + (p.occs.length === 1 ? "" : "s") + " through " + fmtShort(p.end) + " · safe to spend " + money(p.left) + "</span></div>";
    }
    for (const o of items) {
      const st = statusFor(o);
      detail += '<div class="card"><div class="line"><span class="strong" style="font-size:16px">' + esc(o.b.name) + '</span><span class="big" style="font-size:20px">' + money(o.amount) + "</span></div>" +
        '<span class="small strong ' + (o.paid ? "accent-text" : "warn-text") + '">' + esc(st.text) + "</span>" +
        (o.b.notes ? '<div class="notebox">' + esc(o.b.notes) + "</div>" : "") +
        '<div class="headactions"><button class="btn small' + (o.paid ? "" : " primary") + '" data-act="togglePaid" data-key="' + esc(o.key) + '">' + (o.paid ? "Mark unpaid" : "Mark paid") + "</button>" +
        (o.b.link ? '<a class="btn small" href="' + esc(safeUrl(o.b.link)) + '" target="_blank" rel="noopener">Pay site ' + icon("ext", 14, 2.4) + "</a>" : "") +
        '<a class="btn small" href="#/bill/' + esc(o.b.id) + '">Edit</a></div></div>';
    }
    if (!detail) detail = '<div class="card"><span class="muted">Nothing due this day.</span></div>';
    return '<div class="pagehead"><h1>' + fmtMonth(mk) + "</h1>" +
      '<div class="headactions"><div class="legend desk-only"><span><i style="background:var(--accent)"></i>Paid</span><span><i style="background:var(--warn)"></i>Due</span><span><i style="background:var(--teal)"></i>Payday</span></div>' + monthNav(mk, "calMonth") + "</div></div>" +
      '<div class="row-wrap"><section class="card grow" aria-label="Month"><div class="calwrap"><div class="calhead" aria-hidden="true">' + DOW.map((d) => "<span>" + d + "</span>").join("") + '</div><div class="calgrid">' + cells + "</div></div>" +
      '<div class="legend phone-only" style="justify-content:center"><span><i style="background:var(--accent);border-radius:5px"></i>Paid</span><span><i style="background:var(--warn);border-radius:5px"></i>Due</span><span><i style="background:var(--teal)"></i>Payday</span></div></section>' +
      '<div class="aside"><h2>' + fmtLong(sel) + "</h2>" + detail + "</div></div>";
  }

  /* ---------------- views: Insights ---------------- */
  function viewInsights() {
    const t = today();
    const mode = UI.insMode;
    const seg = '<div class="seg" role="group" aria-label="Range"><button data-act="insMode" data-mode="month" aria-pressed="' + (mode === "month") + '">Month</button><button data-act="insMode" data-mode="year" aria-pressed="' + (mode === "year") + '">Year</button></div>';
    if (!IDX.bills.length && !DB.payments.length) {
      return '<div class="pagehead"><h1>Insights</h1></div><div class="card empty"><h2>Nothing to show yet</h2><p>Once you add bills, this page shows where your money goes, your subscriptions, price changes and a year-end summary.</p><a class="btn primary" href="#/bill/new">Add a bill</a></div>';
    }
    if (mode === "year") return viewYear(seg);

    const mk = UI.insMonth || t.slice(0, 7);
    const occs = occurrences(mk + "-01", monthEnd(mk));
    const total = sum(occs, "amount");
    const cats = {};
    for (const o of occs) cats[o.b.category || "Other"] = r2((cats[o.b.category || "Other"] || 0) + o.amount);
    const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => {
      const pct = total ? Math.max(1, Math.round((v / total) * 100)) : 0;
      return '<div class="cat"><div class="line"><span class="strong">' + esc(c) + '</span><span class="muted">' + money(v) + " · " + pct + '%</span></div><div class="bar"><span style="width:' + pct + '%"></span></div></div>';
    }).join("") || '<span class="muted small">No bills this month.</span>';

    const startMk = (DB.settings.startedOn || t).slice(0, 7);
    const months = [];
    for (let i = 5; i >= 0; i--) { const k = addMonths(mk, -i); if (k >= startMk) months.push(k); }
    const vals = months.map((k) => sum(occurrences(k + "-01", monthEnd(k)), "amount"));
    const maxV = Math.max(1, ...vals);
    const trend = '<div class="cols" style="grid-template-columns:repeat(' + Math.max(months.length, 3) + ',minmax(0,1fr))">' + months.map((k, i) =>
      '<div class="col"><span class="v">' + moneyK(vals[i]) + '</span><span class="b' + (k === mk ? " cur" : "") + '" style="height:' + Math.round((vals[i] / maxV) * 120) + 'px"></span><span class="l">' + MON[+k.slice(5) - 1] + "</span></div>").join("") + "</div>";
    let trendNote = "";
    if (months.length >= 2) { const d = r2(vals[vals.length - 1] - vals[vals.length - 2]); trendNote = d === 0 ? "Same as last month" : money(Math.abs(d)) + (d < 0 ? " less" : " more") + " than " + MON[+months[months.length - 2].slice(5) - 1]; }
    else trendNote = "Builds up as you use the app";

    const subs = IDX.bills.filter((b) => b.category === "Subscriptions" && !(b.until && b.until <= t));
    const subRows = subs.map((b) => { const mth = monthlyEquiv(b); return "<tr><td>" + esc(b.name) + '</td><td class="r">' + money(mth) + '</td><td class="r strong">' + money(mth * 12) + "</td></tr>"; }).join("");
    const subM = sum(subs, monthlyEquiv);
    const subCard = '<section class="card"><div class="cardhead"><h2>Subscriptions</h2><span class="meta">' + subs.length + " active</span></div>" +
      (subs.length ? '<table class="tbl"><thead><tr><th>Service</th><th class="r">Month</th><th class="r">Year</th></tr></thead><tbody>' + subRows + '</tbody></table><div class="banner warn" style="justify-content:space-between"><span>Total per year</span><span class="big" style="font-size:20px">' + money(subM * 12) + "</span></div>" : '<span class="muted small">Bills in the Subscriptions category show up here with their yearly cost.</span>') + "</section>";

    const changes = [];
    for (const b of IDX.bills) {
      const list = billDates(b, addDays(t, -120), monthEnd(addMonths(t.slice(0, 7), 1))).map((d) => makeOcc(b, d)).reverse();
      for (const o of list) { const pc = priceChange(o); if (pc) { if (pc.diff > 0) changes.push({ o, pc }); break; } }
    }
    const impact = sum(changes, (x) => (x.o.b.repeat === "yearly" ? x.pc.diff / 12 : x.o.b.repeat === "biweekly" ? (x.pc.diff * 26) / 12 : x.o.b.repeat === "monthly" ? x.pc.diff : 0));
    const changeCard = '<section class="card"><h2>Price changes</h2>' + (changes.length ? changes.map((x) => '<div class="line" style="min-height:34px;align-items:center"><span>' + esc(x.o.b.name) + ' <span class="small muted">· ' + fmtShort(x.o.date) + '</span></span><span class="amt warn-text">' + money(x.pc.prev) + " → " + money(x.o.amount) + "</span></div>").join("") + (impact > 0 ? '<span class="small muted">Together these add about ' + money(impact) + " a month, or " + money(impact * 12) + " a year.</span>" : "") : '<span class="muted small">No bills have gone up lately. When one does, it shows here.</span>') + "</section>";

    return '<div class="pagehead"><h1>Insights</h1><div class="headactions">' + seg + monthNav(mk, "insMonth") + "</div></div>" +
      '<div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">' +
      '<section class="card"><div class="cardhead"><h2>Where bills go</h2><span class="meta">' + fmtMonShort(mk) + " · " + money(total) + "</span></div>" + catRows + "</section>" +
      '<section class="card"><div class="cardhead"><h2>Monthly bills</h2><span class="meta">' + trendNote + "</span></div>" + trend + "</section>" +
      subCard + changeCard + "</div>";
  }
  function yearData(y) {
    const pays = DB.payments.filter((p) => !p.deleted && p.date.slice(0, 4) === String(y));
    const cats = {}, bills = {};
    for (const p of pays) {
      const b = IDX.billById.get(p.billId);
      const c = (b && !b.deleted && b.category) || p.category || "Other";
      const n = (b && !b.deleted && b.name) || p.name || "Deleted bill";
      cats[c] = r2((cats[c] || 0) + p.amount);
      const k = p.billId;
      if (!bills[k]) bills[k] = { name: n, cat: c, count: 0, total: 0 };
      bills[k].count++; bills[k].total = r2(bills[k].total + p.amount);
    }
    return { total: sum(pays, "amount"), count: pays.length, cats: Object.entries(cats).sort((a, b) => b[1] - a[1]), bills: Object.values(bills).sort((a, b) => b.total - a.total) };
  }
  function viewYear(seg) {
    const y = UI.insYear || +today().slice(0, 4);
    const yd = yearData(y);
    const curY = +today().slice(0, 4);
    const rangeTxt = y === curY ? "Jan – " + MON[new Date().getMonth()] : "Full year";
    return '<div class="pagehead"><h1>Insights</h1><div class="headactions">' + seg +
      '<button class="iconbtn" data-act="insYear" data-dir="-1" aria-label="Previous year">' + icon("left", 18, 2.2) + '</button><button class="iconbtn" data-act="insYear" data-dir="1" aria-label="Next year">' + icon("right", 18, 2.2) + "</button></div></div>" +
      '<section class="yearband"><div class="stack" style="gap:4px;flex:1 1 200px"><span class="kicker" style="color:var(--hero-sub)">' + y + (y === curY ? " so far" : "") + '</span><span class="huge">' + money(yd.total) + '</span><span class="sub">paid in bills, ' + rangeTxt + "</span></div>" +
      '<div class="cats">' + (yd.cats.map(([c, v]) => '<div class="stack" style="gap:2px"><span class="sub">' + esc(c) + '</span><span class="strong" style="font-size:17px">' + money(v) + "</span></div>").join("") || '<span class="sub">Nothing paid yet this year.</span>') + "</div>" +
      '<button class="btn" data-act="downloadYear" data-year="' + y + '">Download year summary</button></section>' +
      '<section class="card"><div class="cardhead"><h2>Every bill in ' + y + '</h2><span class="meta">' + yd.count + " payments</span></div>" +
      (yd.bills.length ? '<div class="calwrap"><table class="tbl"><thead><tr><th>Bill</th><th>Category</th><th class="r">Times paid</th><th class="r">Total</th></tr></thead><tbody>' + yd.bills.map((b) => "<tr><td class=\"strong\">" + esc(b.name) + "</td><td class=\"muted\">" + esc(b.cat) + '</td><td class="r">' + b.count + '</td><td class="r strong">' + money(b.total) + "</td></tr>").join("") + "</tbody></table></div>" : '<span class="muted small">Bills you mark paid are counted here. Good for taxes and for seeing your year at a glance.</span>') + "</section>";
  }

  /* ---------------- views: Goals ---------------- */
  function viewGoals() {
    const saves = IDX.goals.filter((g) => g.kind === "save");
    const debts = IDX.goals.filter((g) => g.kind === "debt");
    const saveCards = saves.map((g) => {
      const s = saveGoalInfo(g);
      let note;
      if (s.remaining <= 0) note = '<span class="small strong teal-text">Goal reached</span>';
      else if (s.need && s.per < s.need) note = '<span class="small strong warn-text">Need ' + money(s.need) + " per paycheck to hit " + fmtShort(g.by) + "</span>";
      else if (s.eta) note = '<span class="small muted">' + money(s.per) + " per paycheck · on track for " + fmtMonShort(s.eta.slice(0, 7)) + "</span>";
      else note = '<span class="small muted">Set an amount per paycheck to see when you\'ll get there.</span>';
      return '<section class="card"><div class="cardhead"><h3 style="font-size:16px">' + esc(g.name) + '</h3><button class="linkbtn" data-act="editGoal" data-id="' + esc(g.id) + '">Edit</button></div><span class="big">' + money(s.saved) + ' <span class="small muted strong">of ' + money(s.target) + '</span></span><div class="bar"><span style="width:' + s.pct + '%"></span></div>' + note +
        '<div class="headactions"><button class="btn small primary" data-act="addMoney" data-id="' + esc(g.id) + '">Add money</button>' + (s.per > 0 && s.remaining > 0 ? '<button class="btn small" data-act="quickAdd" data-id="' + esc(g.id) + '">+' + money(Math.min(s.per, s.remaining)) + "</button>" : "") + "</div></section>";
    }).join("");
    const debtCards = debts.map((g) => {
      const d = debtInfo(g);
      const extra = UI.whatIf[g.id] || 0;
      const base = payoff(d.balance, g.apr, d.monthly);
      const withX = payoff(d.balance, g.apr, d.monthly + extra);
      const sooner = isFinite(base.months) && isFinite(withX.months) ? base.months - withX.months : null;
      const chips = [0, 25, 50, 100].map((e) => '<button class="chip" data-act="whatIf" data-id="' + esc(g.id) + '" data-amt="' + e + '" aria-pressed="' + (extra === e) + '">' + (e ? "+$" + e + "/mo" : "No extra") + "</button>").join("");
      return '<section class="card"><div class="cardhead"><h3 style="font-size:16px">' + esc(g.name) + '</h3><button class="linkbtn" data-act="editGoal" data-id="' + esc(g.id) + '">Edit</button></div>' +
        '<span class="big">' + money(d.balance) + ' <span class="small muted strong">left</span></span><div class="bar"><span class="teal" style="width:' + d.paidPct + '%"></span></div>' +
        '<span class="small muted">' + d.paidPct + "% paid · " + (d.monthly ? money(d.monthly) + "/mo" : "set a monthly payment") + (d.bill ? " from " + esc(d.bill.name) + " bill" : "") + " · started at " + money(d.start) + "</span>" +
        (d.balance > 0 && d.monthly > 0 ? '<div class="stack" style="background:var(--bg);border-radius:14px;padding:14px;gap:10px"><span class="kicker accent">What if I pay extra?</span><div class="chips">' + chips + '</div><div class="fields" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="stack" style="gap:2px"><span class="small muted">Paid off by</span><span class="strong teal-text" style="font-size:20px">' + monthsLabel(withX.months) + '</span></div><div class="stack" style="gap:2px"><span class="small muted">Sooner by</span><span class="strong" style="font-size:20px">' + (sooner ? sooner + (sooner === 1 ? " month" : " months") : "—") + "</span></div></div>" +
          '<span class="small muted">' + (g.apr ? "Includes " + g.apr + "% interest" + (extra && withX.interest < base.interest ? ", saving about " + money(base.interest - withX.interest) + " in interest" : "") + "." : "Add the interest rate (APR) in Edit for a more exact date.") + (extra ? " Costs about " + money((extra * 12) / 26) + " per paycheck." : "") + "</span></div>" : "") +
        '<div class="headactions"><button class="btn small" data-act="extraPay" data-id="' + esc(g.id) + '">Record extra payment</button></div></section>';
    }).join("");
    const empty = !saves.length && !debts.length;
    return '<div class="pagehead"><h1>Goals</h1><div class="headactions"><button class="btn primary" data-act="newGoal">' + icon("plus", 18, 2.4) + "New goal</button></div></div>" +
      (empty ? '<div class="card empty"><h2>Save for something, or pay something off</h2><p>Savings goals set aside a little from each paycheck. Debt goals track a balance going down as you pay the bill.</p><div class="headactions" style="justify-content:center"><button class="btn primary" data-act="newGoal" data-kind="save">Savings goal</button><button class="btn" data-act="newGoal" data-kind="debt">Debt to pay off</button></div></div>' : "") +
      (saves.length ? '<h2>Saving for</h2><div class="grid-auto">' + saveCards + "</div>" : "") +
      (debts.length ? '<h2>Paying off</h2><div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">' + debtCards + "</div>" : "");
  }

  /* ---------------- views: Bill form ---------------- */
  function draftFrom(b) {
    return { name: b.name, amount: String(b.amount), category: b.category || "Other", repeat: b.repeat || "monthly", day: Number(b.day) || 1, month: Number(b.month) || 0, date: b.date || today(), remind: b.remind == null ? DB.settings.reminders.days : b.remind, shift: b.shift || "after", autopay: !!b.autopay, varies: !!b.varies, link: b.link || "", notes: b.notes || "", tpl: "" };
  }
  function viewBillForm(arg) {
    const [idPart, query] = String(arg || "new").split("?");
    const isNew = idPart === "new";
    const bill = isNew ? null : IDX.billById.get(idPart);
    if (!isNew && (!bill || bill.deleted)) return '<div class="card empty"><h2>That bill isn\'t here anymore.</h2><a class="btn" href="#/home">Back to Home</a></div>';
    if (UI.draftFor !== (location.hash || "")) {
      UI.draftFor = location.hash || "";
      UI.draft = isNew ? { name: "", amount: "", category: "Housing", repeat: "monthly", day: 1, month: new Date().getMonth(), date: today(), remind: DB.settings.reminders.days, shift: "after", autopay: false, varies: false, link: "", notes: "", tpl: "" } : draftFrom(bill);
      const tq = new URLSearchParams(query || "").get("t");
      if (isNew && tq) applyTemplate(tq);
    }
    const d = UI.draft;
    const tpls = isNew ? '<section class="card" style="flex:1 1 300px"><div class="stack" style="gap:4px"><h2>Quick add</h2><span class="small muted">Pick a common bill and the form fills itself in.</span></div><div class="templates">' +
      TEMPLATES.map((t) => '<button class="tpl" data-act="tpl" data-name="' + esc(t.name) + '" aria-pressed="' + (d.tpl === t.name) + '"><b>' + esc(t.name) + "</b><span>" + esc(t.cat) + (t.varies ? " · varies" : "") + "</span></button>").join("") + "</div></section>" : "";
    const dayOpts = Array.from({ length: 31 }, (_, i) => '<option value="' + (i + 1) + '"' + (Number(d.day) === i + 1 ? " selected" : "") + ">" + ordinal(i + 1) + (i + 1 >= 29 ? " (or last day)" : "") + "</option>").join("");
    let dueField;
    if (d.repeat === "monthly") dueField = '<label class="field">Due day<select data-draft="day">' + dayOpts + "</select></label>";
    else if (d.repeat === "yearly") dueField = '<label class="field">Due month<select data-draft="month">' + MONTH.map((mn, i) => '<option value="' + i + '"' + (Number(d.month) === i ? " selected" : "") + ">" + mn + "</option>").join("") + '</select></label><label class="field">Due day<select data-draft="day">' + dayOpts + "</select></label>";
    else dueField = '<label class="field">' + (d.repeat === "once" ? "Due date" : "Next due date") + '<input type="date" data-draft="date" value="' + esc(d.date) + '" required></label>';
    const remindOpts = [[7, "A week before"], [3, "3 days before"], [1, "1 day before"], [0, "Day of"], [-1, "No reminder"]].map(([v, l]) => '<option value="' + v + '"' + (Number(d.remind) === v ? " selected" : "") + ">" + l + "</option>").join("");
    const form = '<form class="card form" style="flex:999 1 420px;padding:22px" data-form="bill" novalidate>' +
      '<div class="fields">' +
      '<label class="field">Bill name<input type="text" data-draft="name" value="' + esc(d.name) + '" maxlength="60" required autocomplete="off"></label>' +
      '<label class="field">Amount' + (d.varies ? ' <span class="hint">your best guess</span>' : "") + '<span class="money-input"><input type="text" inputmode="decimal" data-draft="amount" value="' + esc(d.amount) + '" placeholder="0.00" autocomplete="off"></span></label>' +
      '<label class="field">Category<select data-draft="category">' + CATEGORIES.map((c) => "<option" + (d.category === c ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
      '<label class="field">Repeats<select data-draft="repeat" data-rerender>' + Object.entries(REPEATS).map(([k, l]) => '<option value="' + k + '"' + (d.repeat === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      dueField +
      '<label class="field">Remind me<select data-draft="remind">' + remindOpts + "</select></label>" +
      '<label class="field">If it\'s due on a weekend or holiday<select data-draft="shift">' + Object.entries(SHIFTS).map(([k, l]) => '<option value="' + k + '"' + ((d.shift || "after") === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label></div>" +
      '<div class="chips" style="gap:4px 22px"><label class="checkline"><input type="checkbox" data-draft="autopay"' + (d.autopay ? " checked" : "") + '>Paid by autopay</label><label class="checkline"><input type="checkbox" data-draft="varies" data-rerender' + (d.varies ? " checked" : "") + ">Amount changes each month</label></div>" +
      '<div class="stack" style="border-top:1px solid var(--line);padding-top:16px;gap:14px"><h2 style="font-size:15px">Notes and pay link <span class="small muted">· optional</span></h2>' +
      '<label class="field">Where to pay (website link)<input type="url" inputmode="url" data-draft="link" value="' + esc(d.link) + '" placeholder="https://" autocomplete="off"></label>' +
      '<label class="field">Notes<textarea rows="3" data-draft="notes" maxlength="500" placeholder="Late fee after the 5th, call to lower the rate in spring…">' + esc(d.notes) + "</textarea></label>" +
      '<span class="note-safe">' + icon("lock", 16) + "Don't put passwords or card numbers here. The link just opens the site so you can sign in there.</span></div>" +
      '<div class="error" id="billerr" role="alert"></div>' +
      '<div class="formactions">' + (isNew ? "" : '<div class="left"><button type="button" class="btn danger small" data-act="deleteBill" data-id="' + esc(bill.id) + '">Delete</button>' + (bill.repeat !== "once" ? '<button type="button" class="btn small" data-act="stopBill" data-id="' + esc(bill.id) + '">' + (bill.until ? "Restart" : "Stop (keep history)") + "</button>" : "") + "</div>") +
      '<a class="btn" href="#/home">Cancel</a><button type="submit" class="btn primary">' + (isNew ? "Save bill" : "Save changes") + "</button></div></form>";
    return '<div class="pagehead"><div class="stack" style="gap:2px"><a href="#/home" class="small">← Back to Home</a><h1>' + (isNew ? "Add a bill" : "Edit " + esc(bill.name)) + "</h1>" + (bill && bill.until ? '<span class="badge plain" style="align-self:flex-start">Stopped ' + fmtShort(bill.until) + "</span>" : "") + "</div></div>" +
      '<div class="row-wrap" style="align-items:flex-start">' + tpls + form + "</div>";
  }
  function applyTemplate(name) {
    const t = TEMPLATES.find((x) => x.name === name);
    if (!t || !UI.draft) return;
    const d = UI.draft;
    d.tpl = t.name;
    d.name = t.blank ? "" : t.name;
    d.category = t.cat;
    d.repeat = t.repeat || "monthly";
    if (t.day) d.day = t.day;
    d.varies = !!t.varies;
  }

  /* ---------------- views: Settings ---------------- */
  function payFields(p, prefix) {
    const dayOpt = (v) => Array.from({ length: 31 }, (_, i) => '<option value="' + (i + 1) + '"' + (Number(v) === i + 1 ? " selected" : "") + ">" + ordinal(i + 1) + (i + 1 >= 29 ? " (or last day)" : "") + "</option>").join("");
    let when;
    if (p.freq === "semimonthly") when = '<label class="field">First payday<select id="' + prefix + 'day1">' + dayOpt(p.day1 || 1) + '</select></label><label class="field">Second payday<select id="' + prefix + 'day2">' + dayOpt(p.day2 || 15) + "</select></label>";
    else if (p.freq === "monthly") when = '<label class="field">Payday<select id="' + prefix + 'day1">' + dayOpt(p.day1 || 1) + "</select></label>";
    else when = '<label class="field">Next payday <span class="hint">use the normal day, even if this one moves for a holiday</span><input type="date" id="' + prefix + 'anchor" value="' + esc(p.anchor || "") + '"></label>';
    const shift = p.shift || "before";
    when += '<label class="field">If payday is a weekend or holiday<select id="' + prefix + 'shift">' + [["before", "Paid the business day before"], ["after", "Paid the business day after"], ["none", "Paid that day anyway"]].map(([k, l]) => '<option value="' + k + '"' + (shift === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>";
    return '<label class="field">Amount per check <span class="hint">after taxes (take-home)</span><span class="money-input"><input type="text" inputmode="decimal" id="' + prefix + 'amount" value="' + (p.amount ? esc(String(p.amount)) : "") + '" placeholder="0.00"></span></label>' +
      '<label class="field">How often<select id="' + prefix + 'freq" data-act-change="payFreq" data-prefix="' + prefix + '">' + Object.entries(FREQS).map(([k, l]) => '<option value="' + k + '"' + (p.freq === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" + when;
  }
  function readPayFields(prefix) {
    const v = (id) => { const el = document.getElementById(prefix + id); return el ? el.value : ""; };
    const amount = parseMoney(v("amount"));
    const freq = v("freq") || "biweekly";
    const p = { amount: isFinite(amount) ? amount : 0, freq, anchor: v("anchor") || (UI.payDraft && UI.payDraft.anchor) || "", day1: Number(v("day1")) || 1, day2: Number(v("day2")) || 15, shift: ["before", "after", "none"].includes(v("shift")) ? v("shift") : "before" };
    let err = "";
    if (!isFinite(amount) || amount <= 0) err = "Enter how much each paycheck is.";
    else if ((freq === "weekly" || freq === "biweekly") && !p.anchor) err = "Pick your next payday.";
    else if (freq === "semimonthly" && p.day1 === p.day2) err = "Pick two different paydays.";
    return { p, err };
  }
  function viewSettings() {
    const s = DB.settings;
    const theme = LS.get("bt_theme") || "auto";
    const themes = [["light", "Light", "#F6F4FA", "#5B3FA8", "#FFFFFF"], ["dark", "Dark", "#15111F", "#A890F4", "#241D35"], ["auto", "Match device", "linear-gradient(90deg,#F6F4FA 50%,#15111F 50%)", "#7B62CC", "#B8ADD3"]].map(([k, l, bg, bar, card]) =>
      '<button class="themeopt" data-act="theme" data-theme="' + k + '" aria-pressed="' + (theme === k) + '"><span class="swatch" style="background:' + bg + '"><i style="background:' + bar + '"></i><b style="background:' + card + '"></b></span>' + l + "</button>").join("");
    const r = s.reminders;
    const sw = (k, label, hint) => '<div class="setting"><span class="txt">' + label + "<span>" + hint + '</span></span><button class="switch" role="switch" aria-checked="' + !!r[k] + '" aria-label="' + label + '" data-act="toggleReminder" data-k="' + k + '"><span></span></button></div>';
    const pay = UI.payDraft || s.pay;
    const lock = lockPolicy();
    return '<div class="pagehead"><h1>Settings</h1></div>' +
      '<div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))">' +
      '<section class="card"><h2>Appearance</h2><div class="themes">' + themes + '</div><span class="small muted">Match device follows your phone or computer\'s light/dark setting. This is saved per device.</span></section>' +
      '<section class="card" id="paycheck"><h2>Paycheck</h2><div class="fields" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><label class="field">Your first name <span class="hint">for the greeting</span><input type="text" id="setname" value="' + esc(s.name) + '" maxlength="30"></label>' + payFields(pay, "set") + '</div><div class="error" id="payerr" role="alert"></div><div class="formactions"><span class="small muted" style="margin-right:auto">Got paid a different amount once? Use Edit on that check in Paychecks.</span><button class="btn primary" data-act="savePay">Save paycheck</button></div></section>' +
      '<section class="card" id="reminders"><h2>Reminders</h2>' +
      sw("payday", "Payday reminders", "Night before payday, 8:00 PM") +
      sw("due", "Bill due reminders", "Uses each bill's own setting") +
      sw("price", "Price change alerts", "Shows a banner when a bill comes in higher") +
      '<div class="stack" style="gap:10px;padding-top:6px"><button class="btn primary" data-act="downloadIcs">' + icon("cal", 18) + 'Download calendar file</button>' +
      '<ol class="steps"><li>On your PC, open <b>calendar.google.com</b> and sign in with the account on your phone.</li><li>Make a calendar just for this: <b>Settings → Add calendar → Create new calendar</b>, name it <b>Bills</b>.</li><li>In that calendar\'s settings, set <b>All-day event notifications</b> to “1 day before at 8 PM” (or what you like).</li><li><b>Settings → Import & export → Import</b>: pick the downloaded file and the Bills calendar.</li><li>Your Android phone gets the alerts through the Google Calendar app.</li></ol>' +
      '<span class="small muted">After you add or change bills, download and import again. The events keep the same IDs, so Google should update them instead of doubling up. If you ever see doubles, delete the Bills calendar and import fresh. Each bill also has an “Add to Google Calendar” button for adding one at a time on your phone.</span></div></section>' +
      '<section class="card"><h2>Security and sync</h2>' +
      '<div class="setting"><span class="txt">Passcode<span>Needed on each new device</span></span><button class="btn small" data-act="changePass">Change</button></div>' +
      '<label class="setting"><span class="txt">Lock after<span>On this device</span></span><select class="input" style="width:auto;min-height:44px" data-act-change="lockPolicy">' + Object.entries(LOCKS).map(([k, l]) => '<option value="' + k + '"' + (lock === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      '<div class="setting"><span class="txt">Sync<span data-sync style="display:flex;gap:8px;align-items:center">' + syncLine() + "</span></span>" + (SYNC_URL ? '<button class="btn small" data-act="syncNow">' + icon("sync", 16) + "Sync now</button>" : "") + "</div>" +
      (SYNC_URL ? "" : '<span class="small muted">Sync is off, so data stays on this device. To use the app on your phone and PC, set up the sync Worker (see the setup guide) and paste its address into config.js.</span>') +
      '<div class="setting"><span class="txt">Recovery code<span>Unlocks your bills if you forget your passcode</span></span><button class="btn small" data-act="newRecovery">Make a new code</button></div>' +
      '<div class="setting"><span class="txt">Lock now<span>Asks for your passcode again</span></span><button class="btn small" data-act="lockNow">' + icon("lock", 16) + "Lock</button></div></section>" +
      '<section class="card"><h2>Your data</h2><div class="headactions"><button class="btn small" data-act="exportCsv">Export to spreadsheet</button><button class="btn small" data-act="backup">Download backup</button><label class="btn small" style="cursor:pointer">Restore backup<input type="file" accept=".json,application/json" class="sr-only" data-act-change="restore"></label></div>' +
      '<span class="small muted">A backup is one file with everything in it. It is <b>not</b> locked with your passcode, so keep it somewhere private. It is how you get your data back if you ever forget your passcode.</span>' +
      '<div class="setting"><span class="txt">Erase everything<span>Deletes your bills from this device' + (SYNC_URL ? " and the sync server" : "") + '</span></span><button class="btn small danger" data-act="erase">Erase</button></div></section>' +
      '<section class="card"><h2>About</h2><span class="small muted">Bill Tracker ' + VERSION + ". Your data is encrypted with your passcode before it leaves this screen. Nobody else, including the sync server, can read it.</span></section></div>";
  }

  /* ---------------- sheets + toast ---------------- */
  let sheetReturnFocus = null;
  function openSheet(title, body, opts) {
    sheetReturnFocus = document.activeElement;
    $("#sheetroot").innerHTML = '<div class="overlay" data-act="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheettitle"><div class="sheethead"><div class="stack" style="gap:3px">' + (opts && opts.kicker ? '<span class="kicker accent">' + esc(opts.kicker) + "</span>" : "") + '<h2 id="sheettitle" style="font-size:20px">' + esc(title) + '</h2></div><button class="closebtn" data-act="closeSheet" aria-label="Close">' + icon("x", 22) + "</button></div>" + body + "</div></div>";
    const f = $("#sheetroot .sheet input:not([type=hidden]), #sheetroot .sheet select, #sheetroot .sheet .btn.primary");
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeSheet() {
    $("#sheetroot").innerHTML = "";
    if (sheetReturnFocus && document.body.contains(sheetReturnFocus)) try { sheetReturnFocus.focus(); } catch (e) {}
    if (UI.pendingRender && DB) { UI.keepScroll = true; render(); }
  }
  let toastTimer = null;
  function toast(msg, undo) {
    clearTimeout(toastTimer);
    $("#toastroot").innerHTML = '<div class="toast" role="status"><span>' + esc(msg) + "</span>" + (undo ? '<button data-act="undo">Undo</button>' : '<button data-act="dismissToast" aria-label="Dismiss">OK</button>') + "</div>";
    UI.undo = undo || null;
    toastTimer = setTimeout(() => { $("#toastroot").innerHTML = ""; UI.undo = null; }, undo ? 6000 : 3500);
  }

  function billSheet(key) {
    const [id, date] = key.split("|");
    const b = IDX.billById.get(id);
    if (!b) return;
    const o = makeOcc(b, date);
    const st = statusFor(o);
    const pc = priceChange(o);
    const hist = (IDX.byBill.get(b.id) || []).slice(-6).reverse();
    const body =
      '<div class="line"><span class="small strong ' + (o.paid ? "accent-text" : st.cls === "warn" ? "warn-text" : "muted") + '">' + esc(st.text) + '</span><span class="big">' + money(o.amount) + "</span></div>" +
      (o.moved ? '<div class="banner tip">' + icon("cal") + '<span class="grow-text">Normally due ' + fmtDow(o.nominal) + ", but that's " + esc(whyClosed(o.nominal)) + ", so it's due " + fmtDow(o.date) + ".</span></div>" : "") +
      (pc && pc.diff > 0 ? '<div class="banner warn">' + icon("up") + '<span class="grow-text">' + money(pc.diff) + " higher than " + fmtShort(pc.prevDate) + " (" + money(pc.prev) + ")</span></div>" : "") +
      '<span class="small muted">' + esc(dueText(b)) + " · " + esc(b.category || "Other") + (b.autopay ? " · autopay" : "") + "</span>" +
      (o.paid ? '<label class="field">Amount paid<span class="money-input"><input type="text" inputmode="decimal" id="paidamt" value="' + o.amount + '"></span></label>' : b.varies ? '<label class="field">Actual amount <span class="hint">this bill changes each month</span><span class="money-input"><input type="text" inputmode="decimal" id="paidamt" value="' + o.amount + '"></span></label>' : "") +
      (b.notes ? '<div class="notebox">' + esc(b.notes) + "</div>" : "") +
      '<div class="headactions">' + (o.paid ? '<button class="btn" data-act="saveAmt" data-key="' + esc(key) + '">Save amount</button><button class="btn" data-act="togglePaid" data-key="' + esc(key) + '" data-close="1">Mark unpaid</button>' : '<button class="btn primary" data-act="markPaid" data-key="' + esc(key) + '">' + icon("check", 18, 2.6) + "Mark paid</button>") +
      (b.link ? '<a class="btn" href="' + esc(safeUrl(b.link)) + '" target="_blank" rel="noopener">Pay site ' + icon("ext", 14, 2.4) + "</a>" : "") + "</div>" +
      '<div class="headactions"><a class="btn small" href="#/bill/' + esc(b.id) + '" data-act="closeSheet">Edit bill</a><a class="btn small" href="' + esc(gcalLink(b)) + '" target="_blank" rel="noopener">' + icon("cal", 16) + "Add to Google Calendar</a></div>" +
      (hist.length ? '<div class="stack" style="gap:6px;border-top:1px solid var(--line);padding-top:12px"><span class="kicker">Recent payments</span>' + hist.map((p) => '<div class="line"><span>' + fmtShort(p.date) + ' <span class="small muted">· paid ' + fmtShort(p.paidOn || p.date) + '</span></span><span class="amt">' + money(p.amount) + "</span></div>").join("") + "</div>" : "");
    openSheet(b.name, body, { kicker: fmtDow(o.date) });
  }

  function goalSheet(g, kind) {
    const isNew = !g;
    kind = g ? g.kind : kind || "save";
    const debtBills = IDX.bills.filter((b) => b.repeat !== "once");
    const kindToggle = isNew ? '<div class="seg" role="group" aria-label="Goal type"><button data-act="goalKind" data-kind="save" aria-pressed="' + (kind === "save") + '">Saving for</button><button data-act="goalKind" data-kind="debt" aria-pressed="' + (kind === "debt") + '">Paying off</button></div>' : "";
    let fields;
    if (kind === "save") {
      fields = '<label class="field">Name<input id="g_name" type="text" maxlength="40" value="' + esc(g ? g.name : "") + '" placeholder="Emergency fund"></label>' +
        '<div class="fields" style="grid-template-columns:repeat(2,minmax(0,1fr))"><label class="field">Goal amount<span class="money-input"><input id="g_target" type="text" inputmode="decimal" value="' + esc(g ? g.target : "") + '"></span></label>' +
        '<label class="field">Saved so far<span class="money-input"><input id="g_saved" type="text" inputmode="decimal" value="' + esc(g ? g.saved : "0") + '"></span></label>' +
        '<label class="field">Set aside per paycheck<span class="money-input"><input id="g_per" type="text" inputmode="decimal" value="' + esc(g ? g.perCheck : "") + '" placeholder="0"></span></label>' +
        '<label class="field">Need it by <span class="hint">optional</span><input id="g_by" type="date" value="' + esc(g && g.by ? g.by : "") + '"></label></div>' +
        '<span class="small muted">The per-paycheck amount comes out of “safe to spend” in the planner. Tip: for yearly bills like car registration, a goal here means it\'s never a surprise.</span>';
    } else {
      fields = '<label class="field">Name<input id="g_name" type="text" maxlength="40" value="' + esc(g ? g.name : "") + '" placeholder="Credit card"></label>' +
        '<div class="fields" style="grid-template-columns:repeat(2,minmax(0,1fr))"><label class="field">Balance ' + (isNew ? "today" : "when added") + '<span class="money-input"><input id="g_start" type="text" inputmode="decimal" value="' + esc(g ? g.start : "") + '"></span></label>' +
        '<label class="field">Interest rate (APR) <span class="hint">optional</span><input id="g_apr" type="text" inputmode="decimal" value="' + esc(g && g.apr ? g.apr : "") + '" placeholder="e.g. 24.99"></label></div>' +
        '<label class="field">Paid by this bill <span class="hint">payments you mark paid lower the balance</span><select id="g_bill"><option value="">None, I\'ll record payments here</option>' + debtBills.map((b) => '<option value="' + esc(b.id) + '"' + (g && g.billId === b.id ? " selected" : "") + ">" + esc(b.name) + " · " + money(b.amount) + "</option>").join("") + "</select></label>" +
        '<label class="field">Monthly payment <span class="hint">leave empty to use the bill amount</span><span class="money-input"><input id="g_pay" type="text" inputmode="decimal" value="' + esc(g && g.payment ? g.payment : "") + '"></span></label>';
    }
    openSheet(isNew ? "New goal" : "Edit goal", '<div class="form">' + kindToggle + fields + '<div class="error" id="goalerr" role="alert"></div><div class="formactions">' + (isNew ? "" : '<div class="left"><button class="btn small danger" data-act="deleteGoal" data-id="' + esc(g.id) + '">Delete</button></div>') + '<button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="saveGoal" data-id="' + (g ? esc(g.id) : "") + '" data-kind="' + kind + '">Save goal</button></div></div>');
  }

  function amountSheet(title, label, act, id, hint) {
    openSheet(title, '<div class="form"><label class="field">' + esc(label) + '<span class="money-input"><input id="amt" type="text" inputmode="decimal" placeholder="0.00"></span></label>' + (hint ? '<span class="small muted">' + esc(hint) + "</span>" : "") + '<div class="error" id="amterr" role="alert"></div><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="' + act + '" data-id="' + esc(id) + '">Save</button></div></div>');
  }

  /* ---------------- calendar exports ---------------- */
  function safeUrl(u) {
    u = String(u || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; }
  }
  function rrule(b) {
    if (b.repeat === "monthly") {
      const d = Number(b.day) || 1;
      if (d <= 28) return "FREQ=MONTHLY;BYMONTHDAY=" + d;
      if (d === 31) return "FREQ=MONTHLY;BYMONTHDAY=-1";
      const set = []; for (let i = d; i <= 31; i++) set.push(i);
      return "FREQ=MONTHLY;BYMONTHDAY=" + set.join(",") + ",-1;BYSETPOS=1";
    }
    if (b.repeat === "yearly") return "FREQ=YEARLY";
    if (b.repeat === "biweekly") return "FREQ=WEEKLY;INTERVAL=2";
    return "";
  }
  const nextDue = (b) => billDates(b, today(), addDays(today(), 800))[0] || billDates(b, "0000-01-01", addDays(today(), 800)).pop() || today();
  const SHIFTS = { after: "Move to the next business day", before: "Move to the business day before", none: "Keep the date" };
  function billDetails(b) {
    const lines = ["Amount: " + money(makeOcc(b, nextDue(b)).amount) + (b.varies ? " (estimate)" : "") + (b.autopay ? " · autopay" : "")];
    if (billShift(b) !== "none") lines.push("If the due date is a weekend or bank holiday: " + (billShift(b) === "before" ? "pay the business day before" : "it moves to the next business day") + ". Bill Tracker shows the exact date.");
    if (b.notes) lines.push(b.notes);
    if (b.link) lines.push("Pay at: " + safeUrl(b.link));
    lines.push("From Bill Tracker");
    return lines.join("\n");
  }
  function gcalLink(b) {
    const d = nextDue(b);
    const ds = d.replace(/-/g, ""), de = addDays(d, 1).replace(/-/g, "");
    const q = new URLSearchParams({ action: "TEMPLATE", text: "Bill due: " + b.name, dates: ds + "/" + de, details: billDetails(b) });
    const rr = rrule(b);
    if (rr) q.set("recur", "RRULE:" + rr + (b.until ? ";UNTIL=" + b.until.replace(/-/g, "") : ""));
    return "https://calendar.google.com/calendar/render?" + q.toString();
  }
  function icsEsc(s) { return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;"); }
  function fold(line) {
    const out = []; let cur = "";
    for (const ch of line) { if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = " " + ch; } else cur += ch; }
    out.push(cur);
    return out.join("\r\n");
  }
  function buildIcs() {
    const r = DB.settings.reminders;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bill Tracker//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Bills"];
    let count = 0;
    if (r.due) {
      // One event per due date for the next 12 months, so weekend and holiday moves are exact.
      const t = today(), end = addDays(t, 365);
      for (const b of IDX.bills) {
        const days = b.remind == null ? r.days : Number(b.remind);
        for (const d of billDates(b, addDays(t, -7), addDays(end, 7))) {
          const o = makeOcc(b, d);
          if (o.date < t || o.date > end) continue;
          const ev = ["BEGIN:VEVENT", "UID:bill-" + b.id + "-" + d + "@bill-tracker", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + o.date.replace(/-/g, ""), "DTEND;VALUE=DATE:" + addDays(o.date, 1).replace(/-/g, ""),
            "SUMMARY:" + icsEsc("Bill due: " + b.name + " (" + money(o.amount) + ")"),
            "DESCRIPTION:" + icsEsc((o.moved ? "Moved from " + fmtDow(d) + " (" + whyClosed(d) + ").\n" : "") + billDetails(b)), "TRANSP:TRANSPARENT"];
          if (b.link && safeUrl(b.link)) ev.push("URL:" + safeUrl(b.link));
          if (days >= 0) ev.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(b.name + " is due " + (days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days")), "TRIGGER:" + (days === 0 ? "PT9H" : "-PT" + (days * 24 - 9) + "H"), "END:VALARM");
          ev.push("END:VEVENT");
          L.push.apply(L, ev); count++;
        }
      }
    }
    if (r.payday && payConfigured()) {
      const days = paydaysBetween(addDays(today(), 1), addDays(today(), 370));
      for (const d of days) {
        const p = period(d);
        const desc = (p.occs.length ? "This check covers: " + p.occs.map((o) => o.b.name + " " + money(o.amount) + " (" + fmtShort(o.date) + ")").join(", ") + ". " : "No bills due before the next payday. ") + "Safe to spend: " + money(p.left) + ". (Based on your bills on " + fmtShort(today()) + ".)";
        L.push("BEGIN:VEVENT", "UID:payday-" + d + "@bill-tracker", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + d.replace(/-/g, ""), "DTEND;VALUE=DATE:" + addDays(d, 1).replace(/-/g, ""), "SUMMARY:" + icsEsc("Payday: " + money(p.income)), "DESCRIPTION:" + icsEsc(desc), "TRANSP:TRANSPARENT",
          "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc("Payday tomorrow: " + money(p.income) + ". " + desc), "TRIGGER:-PT4H", "END:VALARM", "END:VEVENT");
        count++;
      }
    }
    L.push("END:VCALENDAR");
    return { text: L.map(fold).join("\r\n") + "\r\n", count };
  }

  /* ---------------- files ---------------- */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const csvCell = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = (rows) => "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  function exportCsv() {
    const start = (DB.settings.startedOn || today()).slice(0, 7) + "-01";
    const end = monthEnd(today().slice(0, 7));
    const rows = [["Due date", "Scheduled date", "Bill", "Category", "Amount", "Status", "Paid on", "Autopay", "Repeats", "Notes"]];
    for (const o of occurrences(start, end)) rows.push([o.date, o.nominal, o.b.name, o.b.category, o.amount.toFixed(2), o.paid ? "Paid" : o.date < today() ? "Overdue" : "Unpaid", o.paid ? o.pay.paidOn || "" : "", o.b.autopay ? "Yes" : "No", REPEATS[o.b.repeat], o.b.notes || ""]);
    download("bill-tracker-" + today() + ".csv", csv(rows), "text/csv");
  }
  function downloadYear(y) {
    const yd = yearData(y);
    const rows = [["Bill Tracker year summary", String(y)], ["Total paid", yd.total.toFixed(2)], [], ["Category", "Total paid"]];
    for (const [c, v] of yd.cats) rows.push([c, v.toFixed(2)]);
    rows.push([], ["Bill", "Category", "Times paid", "Total paid"]);
    for (const b of yd.bills) rows.push([b.name, b.cat, b.count, b.total.toFixed(2)]);
    rows.push([], ["Date", "Bill", "Category", "Amount", "Paid on"]);
    DB.payments.filter((p) => !p.deleted && p.date.slice(0, 4) === String(y)).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((p) => {
      const b = IDX.billById.get(p.billId);
      rows.push([p.date, (b && b.name) || p.name || "", (b && b.category) || p.category || "", p.amount.toFixed(2), p.paidOn || ""]);
    });
    download("bill-tracker-" + y + "-summary.csv", csv(rows), "text/csv");
  }

  /* ---------------- actions ---------------- */
  function setPaid(key, amount) {
    const [id, date] = key.split("|");
    const b = IDX.billById.get(id);
    const existing = DB.payments.find((p) => p.id === key);
    const rec = Object.assign(existing || {}, { id: key, billId: id, date, amount: r2(amount), paidOn: today(), name: b ? b.name : "", category: b ? b.category : "", deleted: false });
    upsert("payments", rec);
  }
  function setUnpaid(key) {
    const p = DB.payments.find((x) => x.id === key);
    if (p) { p.deleted = true; touch(p); }
  }
  function snapshot() { return JSON.stringify(DB); }
  function restoreSnapshot(s) { const old = JSON.parse(s); const now = Date.now(); bumpAll(old, now); DB = old; }
  function bumpAll(db, now) {
    // Make an undo win over the change it reverses when devices sync.
    db.settings.updatedAt = now;
    for (const c of COLS) for (const x of db[c]) x.updatedAt = now;
  }
  function undoable(label, fn) {
    const before = snapshot();
    fn();
    commit();
    toast(label, () => {
      const cur = JSON.parse(snapshot());
      const old = JSON.parse(before);
      const now = Date.now();
      // Only bump items that actually changed, so other edits aren't overwritten.
      for (const c of COLS) {
        const oldMap = new Map(old[c].map((x) => [x.id, x]));
        for (const x of cur[c]) {
          const o = oldMap.get(x.id);
          if (!o) { x.deleted = true; x.updatedAt = now; }
          else if (JSON.stringify(o) !== JSON.stringify(x)) { Object.keys(x).forEach((k) => delete x[k]); Object.assign(x, o, { updatedAt: now }); }
        }
      }
      if (JSON.stringify(old.settings) !== JSON.stringify(cur.settings)) cur.settings = Object.assign(old.settings, { updatedAt: now });
      DB = cur;
      commit();
    });
  }

  const ACT = {
    overlay(el, e) { if (e.target === el) closeSheet(); },
    closeSheet() { closeSheet(); },
    dismissToast() { $("#toastroot").innerHTML = ""; },
    undo() { const u = UI.undo; $("#toastroot").innerHTML = ""; UI.undo = null; if (u) u(); },
    syncNow() { if (SYNC_URL) syncNow(); else go("settings"); },
    homeMonth(el) { UI.homeMonth = addMonths(UI.homeMonth || today().slice(0, 7), +el.dataset.dir); render(); },
    calMonth(el) { UI.calMonth = addMonths(UI.calMonth || today().slice(0, 7), +el.dataset.dir); UI.calSel = null; render(); },
    calSel(el) { UI.calSel = el.dataset.day; UI.keepScroll = true; render(); const a = $(".aside h2"); if (a && window.innerWidth < 900) a.scrollIntoView({ behavior: "smooth", block: "start" }); },
    insMode(el) { UI.insMode = el.dataset.mode; render(); },
    insMonth(el) { UI.insMonth = addMonths(UI.insMonth || today().slice(0, 7), +el.dataset.dir); render(); },
    insYear(el) { UI.insYear = (UI.insYear || +today().slice(0, 4)) + +el.dataset.dir; render(); },
    openBill(el) { billSheet(el.dataset.key); },
    togglePaid(el) {
      const key = el.dataset.key;
      const [id, date] = key.split("|");
      const b = IDX.billById.get(id);
      if (!b) return;
      const o = makeOcc(b, date);
      if (el.dataset.close) closeSheet();
      if (o.paid) { UI.keepScroll = true; undoable(b.name + " marked unpaid", () => setUnpaid(key)); }
      else if (b.varies && !el.closest(".sheet")) billSheet(key);
      else { UI.keepScroll = true; undoable(b.name + " marked paid", () => setPaid(key, o.amount)); }
    },
    markPaid(el) {
      const key = el.dataset.key;
      const [id, date] = key.split("|");
      const b = IDX.billById.get(id);
      const inp = $("#paidamt");
      let amt = inp ? parseMoney(inp.value) : makeOcc(b, date).amount;
      if (!isFinite(amt) || amt < 0) { inp.focus(); return; }
      closeSheet();
      UI.keepScroll = true;
      undoable(b.name + " marked paid", () => setPaid(key, amt));
    },
    saveAmt(el) {
      const key = el.dataset.key;
      const amt = parseMoney($("#paidamt").value);
      if (!isFinite(amt) || amt < 0) return;
      const p = DB.payments.find((x) => x.id === key);
      if (p) { p.amount = amt; touch(p); }
      closeSheet(); UI.keepScroll = true; commit(); toast("Amount updated");
    },
    tpl(el, e) { e.preventDefault(); readDraftInputs(); applyTemplate(el.dataset.name); render(); const n = $('[data-draft="amount"]'); if (n) n.focus(); },
    deleteBill(el) {
      const b = IDX.billById.get(el.dataset.id);
      openSheet("Delete " + b.name + "?", '<p class="muted" style="margin:0">This removes the bill and its payment history from Insights. To keep the history but stop future due dates, use “Stop” instead.</p><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="confirmDeleteBill" data-id="' + esc(b.id) + '">Delete bill</button></div>');
    },
    confirmDeleteBill(el) {
      const b = IDX.billById.get(el.dataset.id);
      closeSheet();
      undoable(b.name + " deleted", () => {
        b.deleted = true; touch(b);
        for (const p of DB.payments) if (p.billId === b.id && !p.deleted) { p.deleted = true; touch(p); }
      });
      go("home");
    },
    stopBill(el) {
      const b = IDX.billById.get(el.dataset.id);
      const restarting = !!b.until;
      undoable(restarting ? b.name + " restarted" : b.name + " stopped", () => { b.until = restarting ? null : addDays(today(), 1); touch(b); });
      go("home");
    },
    hold(el) { const day = el.dataset.day, amt = +el.dataset.amt; UI.keepScroll = true; undoable("Holding " + money(amt) + " for the next check", () => upsert("holds", { id: day, amount: amt, deleted: false })); },
    removeHold(el) { const h = DB.holds.find((x) => x.id === el.dataset.day); if (!h) return; UI.keepScroll = true; undoable("Hold removed", () => { h.deleted = true; touch(h); }); },
    editCheck(el) {
      const day = el.dataset.day;
      openSheet("Paycheck on " + fmtShort(day), '<div class="form"><label class="field">Amount for this check<span class="money-input"><input id="amt" type="text" inputmode="decimal" value="' + checkAmount(day) + '"></span></label><span class="small muted">Only changes this one paycheck. Your usual amount is ' + money(DB.settings.pay.amount) + '.</span><div class="formactions">' + (IDX.checks.get(day) ? '<div class="left"><button class="btn small" data-act="resetCheck" data-day="' + day + '">Use usual amount</button></div>' : "") + '<button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="saveCheck" data-day="' + day + '">Save</button></div></div>');
    },
    saveCheck(el) { const amt = parseMoney($("#amt").value); if (!isFinite(amt) || amt < 0) return; closeSheet(); UI.keepScroll = true; upsert("checks", { id: el.dataset.day, amount: amt, deleted: false }); commit(); },
    resetCheck(el) { const c = DB.checks.find((x) => x.id === el.dataset.day); if (c) { c.deleted = true; touch(c); } closeSheet(); UI.keepScroll = true; commit(); },
    toggleReminder(el) { const k = el.dataset.k; DB.settings.reminders[k] = !DB.settings.reminders[k]; settingsChanged(); UI.keepScroll = true; commit(); },
    whatIf(el) { UI.whatIf[el.dataset.id] = +el.dataset.amt; UI.keepScroll = true; render(); },
    newGoal(el) { goalSheet(null, el.dataset.kind || "save"); },
    goalKind(el) { goalSheet(null, el.dataset.kind); },
    editGoal(el) { goalSheet(IDX.goals.find((g) => g.id === el.dataset.id)); },
    saveGoal(el) {
      const kind = el.dataset.kind;
      const g = el.dataset.id ? Object.assign({}, DB.goals.find((x) => x.id === el.dataset.id)) : { id: uid(), kind, createdOn: today() };
      const err = (m) => { $("#goalerr").textContent = m; };
      g.name = $("#g_name").value.trim();
      if (!g.name) return err("Give the goal a name.");
      if (kind === "save") {
        g.target = parseMoney($("#g_target").value); g.saved = parseMoney($("#g_saved").value || "0"); g.perCheck = parseMoney($("#g_per").value || "0"); g.by = $("#g_by").value || null;
        if (!isFinite(g.target) || g.target <= 0) return err("Enter the goal amount.");
        if (!isFinite(g.saved) || g.saved < 0) g.saved = 0;
        if (!isFinite(g.perCheck) || g.perCheck < 0) g.perCheck = 0;
      } else {
        g.start = parseMoney($("#g_start").value); g.apr = parseFloat($("#g_apr").value) || 0; g.billId = $("#g_bill").value || null; g.payment = parseMoney($("#g_pay").value || "0");
        if (!isFinite(g.start) || g.start <= 0) return err("Enter the balance.");
        if (!isFinite(g.payment) || g.payment < 0) g.payment = 0;
        g.extra = g.extra || [];
      }
      g.deleted = false;
      upsert("goals", g);
      closeSheet(); UI.keepScroll = true; commit(); toast("Goal saved");
    },
    deleteGoal(el) { const g = DB.goals.find((x) => x.id === el.dataset.id); closeSheet(); UI.keepScroll = true; undoable(g.name + " deleted", () => { g.deleted = true; touch(g); }); },
    addMoney(el) { amountSheet("Add to " + IDX.goals.find((g) => g.id === el.dataset.id).name, "Amount to add", "saveAddMoney", el.dataset.id, "Use a negative number to take money out."); },
    quickAdd(el) { const g = DB.goals.find((x) => x.id === el.dataset.id); const s = saveGoalInfo(g); const amt = Math.min(s.per, s.remaining); UI.keepScroll = true; undoable("Added " + money(amt) + " to " + g.name, () => { g.saved = r2((Number(g.saved) || 0) + amt); touch(g); }); },
    saveAddMoney(el) { const amt = parseMoney($("#amt").value); if (!isFinite(amt) || amt === 0) { $("#amterr").textContent = "Enter an amount."; return; } const g = DB.goals.find((x) => x.id === el.dataset.id); closeSheet(); UI.keepScroll = true; undoable("Added " + money(amt) + " to " + g.name, () => { g.saved = Math.max(0, r2((Number(g.saved) || 0) + amt)); touch(g); }); },
    extraPay(el) { amountSheet("Extra payment", "Amount paid on top of the regular bill", "saveExtra", el.dataset.id, "Regular payments come from the linked bill when you mark it paid."); },
    saveExtra(el) { const amt = parseMoney($("#amt").value); if (!isFinite(amt) || amt <= 0) { $("#amterr").textContent = "Enter an amount."; return; } const g = DB.goals.find((x) => x.id === el.dataset.id); closeSheet(); UI.keepScroll = true; undoable("Recorded " + money(amt) + " extra", () => { g.extra = (g.extra || []).concat([{ d: today(), amount: amt }]); touch(g); }); },
    theme(el) { LS.set("bt_theme", el.dataset.theme); applyTheme(); UI.keepScroll = true; render(); },
    savePay() {
      const { p, err } = readPayFields("set");
      if (err) { $("#payerr").textContent = err; return; }
      DB.settings.pay = p;
      DB.settings.name = $("#setname").value.trim();
      settingsChanged(); UI.payDraft = null; UI.keepScroll = true; commit(); toast("Paycheck saved");
    },
    downloadIcs() {
      const { text, count } = buildIcs();
      if (!count) { toast("Nothing to add yet. Turn on a reminder or add a bill."); return; }
      download("bill-tracker-calendar.ics", text, "text/calendar");
      toast("Calendar file downloaded (" + count + " events)");
    },
    downloadYear(el) { downloadYear(+el.dataset.year); },
    exportCsv() { exportCsv(); },
    backup() { download("bill-tracker-backup-" + today() + ".json", JSON.stringify({ app: "bill-tracker", exported: new Date().toISOString(), data: DB }, null, 1), "application/json"); toast("Backup downloaded. Keep it somewhere private."); },
    lockNow() { lockNow(); },
    changePass() {
      openSheet("Change passcode", '<div class="form"><label class="field">Current passcode<input id="p_old" type="password" autocomplete="current-password"></label><label class="field">New passcode <span class="hint">at least 8 characters</span><input id="p_new" type="password" autocomplete="new-password"></label><label class="field">New passcode again<input id="p_new2" type="password" autocomplete="new-password"></label><span class="small muted">Your other devices will ask for the new passcode next time they sync. Your recovery code keeps working.</span><div class="error" id="perr" role="alert"></div><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="savePass">Change passcode</button></div></div>');
    },
    async savePass(el) {
      const err = (m) => { $("#perr").textContent = m; el.disabled = false; el.textContent = "Change passcode"; };
      const oldP = $("#p_old").value, n1 = $("#p_new").value, n2 = $("#p_new2").value;
      if (n1.length < 8) return err("The new passcode needs at least 8 characters.");
      if (n1 !== n2) return err("The new passcodes don't match.");
      el.disabled = true; el.textContent = "Changing…";
      try {
        const old = await derive(oldP);
        if (old.id !== PID) return err("The current passcode isn't right.");
        const nw = await derive(n1);
        if (nw.id === PID) return err("That's the same passcode.");
        const res = await putDoor(nw.id, await doorBlob(nw.key, VID, KEY));
        if (res === "exists") return err("Please pick a different new passcode.");
        queueDoorOp({ id: PID, drop: true });
        DB.keyring = Object.assign({}, DB.keyring, { pid: nw.id, updatedAt: Date.now() });
        await saveDoorsLocal(nw, null, KEY, VID);
        PID = nw.id;
        closeSheet(); toast("Passcode changed");
        commit();
      } catch (e) { err("Couldn't reach the sync server, so your passcode wasn't changed. Try again when you're online."); }
    },
    newRecovery() {
      openSheet("Make a new recovery code", '<div class="form"><p class="muted" style="margin:0">Your old recovery code will stop working. Enter your passcode to continue.</p><label class="field">Passcode<input id="p_old" type="password" autocomplete="current-password"></label><div class="error" id="perr" role="alert"></div><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="saveRecovery">Make new code</button></div></div>');
    },
    async saveRecovery(el) {
      const err = (m) => { $("#perr").textContent = m; el.disabled = false; el.textContent = "Make new code"; };
      el.disabled = true; el.textContent = "Making…";
      try {
        const p = await derive($("#p_old").value);
        if (p.id !== PID) return err("That passcode isn't right.");
        const code = makeRecoveryCode();
        const rd = await deriveCode(code);
        const res = await putDoor(rd.id, await doorBlob(rd.key, VID, KEY));
        if (res === "exists") return err("Please try again.");
        const oldRid = DB.keyring.rid || (readMeta() || {}).rid;
        if (oldRid) queueDoorOp({ id: oldRid, drop: true });
        DB.keyring = Object.assign({}, DB.keyring, { rid: rd.id, updatedAt: Date.now() });
        await saveDoorsLocal(null, rd, KEY, VID);
        commit();
        openSheet("Your new recovery code", codeBox(code) + '<div class="formactions"><button class="btn primary" data-act="closeSheet">I saved it</button></div>');
      } catch (e) { err("Couldn't reach the sync server. Try again when you're online."); }
    },
    downloadCode(el) {
      download("bill-tracker-recovery-code.txt", "Bill Tracker recovery code\r\n\r\n" + el.dataset.code + "\r\n\r\nIf you forget your passcode, open Bill Tracker, tap \"Forgot passcode?\" and enter this code.\r\nKeep it somewhere private. Anyone with this code can open your bills.\r\nMade " + today() + "\r\n", "text/plain");
      toast("Recovery code downloaded");
    },
    async copyCode(el) {
      try { await navigator.clipboard.writeText(el.dataset.code); toast("Copied. Paste it somewhere safe."); }
      catch (e) { toast("Couldn't copy. Write it down or download it instead."); }
    },
    erase() {
      openSheet("Erase everything?", '<div class="form"><p class="muted" style="margin:0">This deletes all your bills, payments and goals from this device' + (SYNC_URL ? " and the sync server, so your other devices lose them too" : "") + '. It can\'t be undone. Download a backup first if you might want them back.</p><label class="field">Type ERASE to confirm<input id="erase_c" type="text" autocomplete="off"></label><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn danger" data-act="confirmErase">Erase everything</button></div></div>');
    },
    async confirmErase() {
      if ($("#erase_c").value.trim().toUpperCase() !== "ERASE") { $("#erase_c").focus(); return; }
      const meta = readMeta() || {};
      if (SYNC_URL) {
        for (const id of [VID, PID, DB.keyring.rid, meta.rid]) if (id) { try { await fetch(SYNC_URL + "/v/" + id, { method: "DELETE" }); } catch (e) {} }
      }
      clearDevice();
      DB = null; KEY = null; VID = null; JWK = null; PID = null;
      closeSheet();
      location.hash = "";
      UI.auth = { step: "welcome", error: "", busy: false, msg: "Everything was erased." };
      renderAuth();
    },
    async confirmRestore(el) {
      const mode = el.dataset.mode;
      const incoming = normalize(UI.restoreData);
      incoming.keyring = DB.keyring; // a backup never changes which passcode opens the app
      if (mode === "replace") {
        const now = Date.now();
        for (const c of COLS) {
          const keep = new Set(incoming[c].map((x) => x.id));
          for (const x of DB[c]) if (!keep.has(x.id)) { x.deleted = true; x.updatedAt = now; incoming[c].push(x); }
        }
        bumpAll(incoming, now);
        DB = incoming;
      } else {
        const kr = DB.keyring;
        bumpAll(incoming, Date.now());
        DB = normalize(merge(DB, incoming));
        DB.keyring = kr;
      }
      UI.restoreData = null;
      closeSheet(); commit(); toast("Backup restored");
    },
    // auth screens
    authStep(el) { UI.auth.step = el.dataset.step; UI.auth.error = ""; renderAuth(); },
    async createPass(el) {
      const a = $("#a_p1").value, b = $("#a_p2").value;
      if (a.length < 8) return authError("Use at least 8 characters. A short phrase works well, like “purple rent day 42”.");
      if (a !== b) return authError("Those don't match. Type the same passcode twice.");
      authBusy(el, "Setting up…");
      const d = await derive(a);
      if (SYNC_URL) {
        try {
          const opened = await getDoor(d.id, d.key);
          if (opened) {
            const db = await loadData(opened);
            if (db) {
              await startSession(opened.key, opened.vid, db, d.id);
              await saveDoorsLocal(d, null, opened.key, opened.vid);
              return enterApp("Found your synced data. Welcome back!");
            }
          }
        } catch (e) {}
      }
      UI.auth.pending = { pd: d, code: makeRecoveryCode() };
      UI.auth.step = "code";
      UI.auth.error = "";
      renderAuth();
    },
    codeSaved() {
      if (!$("#code_ok").checked) return authError("Save your recovery code first, then tick the box.");
      UI.auth.step = "pay";
      UI.auth.error = "";
      UI.payDraft = { amount: 0, freq: "biweekly", anchor: "", day1: 1, day2: 15 };
      renderAuth();
    },
    async finishSetup(el) {
      const { p, err } = readPayFields("on");
      if (err && !el.dataset.skip) return authError(err);
      const pend = UI.auth.pending;
      if (!pend) { UI.auth.step = "welcome"; return renderAuth(); }
      authBusy(el, "Finishing…");
      const db = newDB();
      if (!el.dataset.skip) db.settings.pay = p;
      db.settings.name = ($("#on_name") && $("#on_name").value.trim()) || "";
      const key = await newDataKey();
      const vid = hex(crypto.getRandomValues(new Uint8Array(32)));
      const rd = await deriveCode(pend.code);
      db.keyring = { pid: pend.pd.id, rid: rd.id, updatedAt: Date.now() };
      clearDevice();
      sync.v = 0; sync.dirty = true; sync.last = 0;
      UI.payDraft = null;
      await startSession(key, vid, db, pend.pd.id);
      await saveDoorsLocal(pend.pd, rd, key, vid);
      queueDoorOp({ id: pend.pd.id, blob: await doorBlob(pend.pd.key, vid, key) });
      queueDoorOp({ id: rd.id, blob: await doorBlob(rd.key, vid, key) });
      UI.auth.pending = null;
      enterApp(el.dataset.skip ? "You can add your paycheck later in Settings." : "You're set. Add your first bill!");
    },
    async restoreRemote(el) {
      const pass = $("#a_p1").value;
      if (!pass) return authError("Enter your passcode.");
      authBusy(el, "Looking for your data…");
      try {
        const d = await derive(pass);
        const opened = await getDoor(d.id, d.key);
        if (!opened) return authError("No synced data was found for that passcode. Check it, or use your recovery code.");
        clearDevice();
        const db = await loadData(opened);
        if (!db) return authError("Your passcode worked, but the data wasn't on the sync server yet. Open the app on your other device so it can sync, then try again.");
        await startSession(opened.key, opened.vid, db, d.id);
        await saveDoorsLocal(d, null, opened.key, opened.vid);
        enterApp("Your data is here. Welcome back!");
      } catch (e) { authError("Couldn't reach the sync server. Check your connection."); }
    },
    async unlock(el) {
      const pass = $("#a_p1").value;
      if (!pass) return authError("Enter your passcode.");
      authBusy(el, "Unlocking…");
      try {
        const d = await derive(pass);
        let opened = null;
        try { opened = await openWith(d, "p"); } catch (e) { return authError("Couldn't reach the sync server to check that passcode. Check your connection."); }
        if (!opened) return authError("That passcode isn't right.");
        if (opened.from === "local" && SYNC_URL) {
          // If the passcode was changed on another device, the old one stops working here too.
          let still = true;
          try { still = !!(await getDoor(d.id, d.key)); } catch (e) { still = true; }
          if (!still) return authError("Your passcode was changed on another device. Enter the new passcode.");
        }
        const db = await loadData(opened);
        if (!db) return authError("Couldn't open your data on this device. Check your connection and try again.");
        await startSession(opened.key, opened.vid, db, d.id);
        if (opened.from === "remote") await saveDoorsLocal(d, null, opened.key, opened.vid);
        enterApp(opened.from === "remote" && readJSON("bt_data") ? "Unlocked with your new passcode." : "");
      } catch (e) { authError("That passcode isn't right."); }
    },
    forgot() { UI.auth.step = "forgot"; UI.auth.error = ""; renderAuth(); },
    async recoverUnlock(el) {
      const code = cleanCode($("#a_code").value);
      if (code.length < 20) return authError("Recovery codes have 20 letters and numbers, like ABCD-EFGH-JKMN-PQRS-TVWX.");
      authBusy(el, "Checking…");
      try {
        const rd = await deriveCode(code);
        const opened = await openWith(rd, "r");
        if (!opened) return authError("That recovery code didn't work. Check it, including any newer code you made in Settings.");
        const db = await loadData(opened);
        if (!db) return authError("Couldn't load your data. Check your connection and try again.");
        UI.auth.recovered = { opened, db, rd };
        UI.auth.step = "newpass";
        UI.auth.error = "";
        renderAuth();
      } catch (e) { authError("Couldn't reach the sync server. Check your connection."); }
    },
    async setNewPass(el) {
      const a = $("#a_p1").value, b = $("#a_p2").value;
      if (a.length < 8) return authError("Use at least 8 characters.");
      if (a !== b) return authError("Those don't match. Type the same passcode twice.");
      const rec = UI.auth.recovered;
      if (!rec) { UI.auth.step = "forgot"; return renderAuth(); }
      authBusy(el, "Saving…");
      try {
        const nw = await derive(a);
        const db = normalize(rec.db);
        if (nw.id !== db.keyring.pid) {
          const res = await putDoor(nw.id, await doorBlob(nw.key, rec.opened.vid, rec.opened.key));
          if (res === "exists") {
            const same = await getDoor(nw.id, nw.key).catch(() => null);
            if (!same || same.vid !== rec.opened.vid) return authError("Please pick a different passcode.");
          }
          if (db.keyring.pid) queueDoorOp({ id: db.keyring.pid, drop: true });
          db.keyring = Object.assign({}, db.keyring, { pid: nw.id, rid: db.keyring.rid || rec.rd.id, updatedAt: Date.now() });
        }
        if (rec.opened.from === "remote") { clearDevice(); sync.v = 0; }
        await startSession(rec.opened.key, rec.opened.vid, db, nw.id);
        await saveDoorsLocal(nw, rec.rd, rec.opened.key, rec.opened.vid);
        UI.auth.recovered = null;
        sync.dirty = true;
        await saveLocal();
        enterApp("New passcode set. Your recovery code still works.");
      } catch (e) { authError("Couldn't reach the sync server, so the passcode wasn't changed. Try again when you're online."); }
    },
    async resetDevice() {
      clearDevice();
      UI.auth = { step: "welcome", error: "", busy: false, msg: "This device was reset." };
      renderAuth();
    },
  };
  const CHANGE = {
    lockPolicy(el) { LS.set("bt_lock", el.value); saveSession(); toast("Lock setting saved for this device"); },
    payFreq(el) {
      const prefix = el.dataset.prefix;
      const cur = readPayFields(prefix).p;
      cur.freq = el.value;
      UI.payDraft = cur;
      if (prefix === "set") { UI.keepScroll = true; const name = $("#setname") ? $("#setname").value : ""; render(); if ($("#setname")) $("#setname").value = name; }
      else { const name = $("#on_name") ? $("#on_name").value : ""; renderAuth(); if ($("#on_name")) $("#on_name").value = name; }
      const f = document.getElementById(prefix + "freq"); if (f) f.focus();
    },
    restore(el) {
      const file = el.files && el.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const j = JSON.parse(reader.result);
          const data = j && j.app === "bill-tracker" ? j.data : j;
          if (!data || !data.settings || !Array.isArray(data.bills)) throw new Error("bad");
          UI.restoreData = data;
          openSheet("Restore backup", '<div class="form"><p class="muted" style="margin:0">This backup has ' + data.bills.filter((b) => !b.deleted).length + " bills and " + (data.payments || []).filter((p) => !p.deleted).length + ' payments. <b>Combine</b> keeps what\'s here and adds anything missing. <b>Replace</b> makes the app match the backup exactly.</p><div class="formactions"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn" data-act="confirmRestore" data-mode="replace">Replace</button><button class="btn primary" data-act="confirmRestore" data-mode="merge">Combine</button></div></div>');
        } catch (e) { toast("That file isn't a Bill Tracker backup."); }
      };
      reader.readAsText(file);
      el.value = "";
    },
  };

  function readDraftInputs() {
    if (!UI.draft) return;
    $$("[data-draft]").forEach((el) => { UI.draft[el.dataset.draft] = el.type === "checkbox" ? el.checked : el.value; });
  }
  function saveBillForm() {
    readDraftInputs();
    const d = UI.draft;
    const errEl = $("#billerr");
    const err = (m, sel) => { errEl.textContent = m; const f = sel && $(sel); if (f) f.focus(); };
    const name = String(d.name || "").trim();
    const amount = parseMoney(d.amount);
    if (!name) return err("Give the bill a name.", '[data-draft="name"]');
    if (!isFinite(amount) || amount < 0) return err("Enter the amount, like 85 or 120.50.", '[data-draft="amount"]');
    if ((d.repeat === "once" || d.repeat === "biweekly") && !d.date) return err("Pick the due date.", '[data-draft="date"]');
    const id = route().arg.split("?")[0];
    const isNew = id === "new";
    const b = isNew ? { id: uid(), createdOn: today() } : Object.assign({}, IDX.billById.get(id));
    if (!isNew && Number(b.amount) !== amount && !d.varies) { b.prevAmount = Number(b.amount); b.amountChangedOn = today(); }
    Object.assign(b, {
      name, amount, category: d.category, repeat: d.repeat, day: Number(d.day) || 1, month: Number(d.month) || 0,
      date: d.repeat === "once" || d.repeat === "biweekly" ? d.date : null,
      remind: Number(d.remind), shift: SHIFTS[d.shift] ? d.shift : "after", autopay: !!d.autopay, varies: !!d.varies,
      link: String(d.link || "").trim(), notes: String(d.notes || "").trim(), deleted: false,
    });
    if (isNew || !b.start) b.start = d.repeat === "once" || d.repeat === "biweekly" ? d.date : today().slice(0, 7) + "-01";
    if (!isNew && (d.repeat === "once" || d.repeat === "biweekly")) b.start = d.date < b.start ? d.date : b.start;
    upsert("bills", b);
    UI.draft = null; UI.draftFor = null;
    commit();
    toast(isNew ? name + " added" : "Changes saved");
    go("home");
  }

  /* ---------------- auth screens ---------------- */
  function authError(m) { UI.auth.error = m; UI.auth.busy = false; renderAuth(); }
  function authBusy(el, label) { UI.auth.error = ""; el.disabled = true; el.textContent = label; const e = $("#autherr"); if (e) e.textContent = ""; }
  function renderAuth() {
    const a = UI.auth;
    const logo = '<span class="logo">' + icon("logo", 26, 2.2) + "</span>";
    const err = '<div class="error" id="autherr" role="alert">' + esc(a.error || "") + "</div>";
    const msg = a.msg ? '<div class="banner tip">' + esc(a.msg) + "</div>" : "";
    let body = "";
    if (a.step === "welcome") {
      body = logo + "<h1>Bill Tracker</h1><p>Keep track of your bills, see what each paycheck covers, and know what's safe to spend.</p>" + msg +
        '<button class="btn primary block" data-act="authStep" data-step="create">Get started</button>' +
        (SYNC_URL ? '<button class="btn block" data-act="authStep" data-step="restore">I already use it on another device</button>' : "") +
        '<span class="note-safe">' + icon("lock", 16) + "Everything is locked with a passcode only you know.</span>";
    } else if (a.step === "create") {
      body = '<div class="steps-dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div><h1>Pick a passcode</h1><p>You\'ll use it to open the app' + (SYNC_URL ? " and to get your data on your other devices" : "") + '. A short phrase is easiest to remember and hard to guess.</p>' +
        '<form class="form" data-form="create" novalidate><label class="field">Passcode<input id="a_p1" type="password" autocomplete="new-password" required></label><label class="field">Same passcode again<input id="a_p2" type="password" autocomplete="new-password" required></label>' + err +
        '<button class="btn primary block" type="submit" data-act="createPass">Continue</button><button class="btn block" type="button" data-act="authStep" data-step="welcome">Back</button></form>';
    } else if (a.step === "code") {
      const code = a.pending ? a.pending.code : "";
      body = '<div class="steps-dots" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i></div><h1>Save your recovery code</h1><p>This is your way back in if you ever forget your passcode. You\'ll only see it here, so save it now.</p>' +
        codeBox(code) +
        '<form class="form" data-form="code" novalidate><label class="checkline"><input type="checkbox" id="code_ok">I saved my recovery code somewhere safe</label>' + err +
        '<button class="btn primary block" type="submit" data-act="codeSaved">Continue</button></form>';
    } else if (a.step === "pay") {
      const p = UI.payDraft || { freq: "biweekly" };
      body = '<div class="steps-dots" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i></div><h1>Your paycheck</h1><p>This is how the app works out what each paycheck covers and what\'s safe to spend.</p>' +
        '<form class="form" data-form="pay" novalidate><label class="field">Your first name <span class="hint">optional</span><input id="on_name" type="text" maxlength="30" autocomplete="given-name"></label>' + payFields(p, "on") + err +
        '<button class="btn primary block" type="submit" data-act="finishSetup">Finish</button><button class="btn block" type="button" data-act="finishSetup" data-skip="1">Skip for now</button></form>';
    } else if (a.step === "restore") {
      body = logo + "<h1>Welcome back</h1><p>Enter the passcode you use on your other device. Your bills will download here.</p>" +
        '<form class="form" data-form="restore" novalidate><label class="field">Passcode<input id="a_p1" type="password" autocomplete="current-password" required></label>' + err +
        '<button class="btn primary block" type="submit" data-act="restoreRemote">Get my data</button><button class="btn block" type="button" data-act="authStep" data-step="welcome">Back</button></form>' +
        '<button class="linkbtn" data-act="forgot" style="align-self:center">Forgot passcode? Use your recovery code</button>';
    } else if (a.step === "forgot") {
      const back = readMeta() ? "lock" : SYNC_URL ? "restore" : "welcome";
      body = logo + "<h1>Forgot your passcode?</h1><p>Enter the recovery code you saved when you set up the app. It unlocks your bills so you can pick a new passcode.</p><p class=\"small\">Emailed it to yourself? Search your inbox for <b>Bill Tracker recovery code</b>.</p>" +
        '<form class="form" data-form="forgot" novalidate><label class="field">Recovery code<input id="a_code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JKMN-PQRS-TVWX" style="font-family:ui-monospace,Consolas,monospace;letter-spacing:0.06em"></label>' + err +
        '<button class="btn primary block" type="submit" data-act="recoverUnlock">Unlock with recovery code</button><button class="btn block" type="button" data-act="authStep" data-step="' + back + '">Back</button></form>' +
        '<details class="small muted"><summary style="cursor:pointer;font-weight:700;min-height:32px">Lost the recovery code too?</summary><p class="small" style="margin-top:8px">Then your bills can\'t be unlocked, not even by the app. That\'s what keeps them private. If you have a backup file, reset this device, set up again, and restore the backup in Settings.' + (SYNC_URL ? " Resetting this device doesn\'t touch the copy on the sync server." : "") + '</p>' + (readMeta() ? '<button class="btn danger small" data-act="resetDevice" style="margin-top:8px">Reset this device</button>' : "") + "</details>";
    } else if (a.step === "newpass") {
      body = logo + "<h1>Pick a new passcode</h1><p>Your recovery code worked. Choose a new passcode for opening the app. Your other devices will ask for it next time.</p>" +
        '<form class="form" data-form="newpass" novalidate><label class="field">New passcode<input id="a_p1" type="password" autocomplete="new-password" required></label><label class="field">Same passcode again<input id="a_p2" type="password" autocomplete="new-password" required></label>' + err +
        '<button class="btn primary block" type="submit" data-act="setNewPass">Save and open</button></form>';
    } else {
      body = logo + "<h1>Welcome back</h1>" + msg +
        '<form class="form" data-form="unlock" novalidate><label class="field">Passcode<input id="a_p1" type="password" autocomplete="current-password" required></label>' + err +
        '<button class="btn primary block" type="submit" data-act="unlock">' + icon("lock", 18) + 'Unlock</button></form><button class="linkbtn" data-act="forgot" style="align-self:center">Forgot passcode?</button>';
    }
    $("#root").innerHTML = '<div class="auth"><main class="authcard">' + body + "</main></div>";
    const f = $("#root input");
    if (f) f.focus();
    UI.auth.msg = a.step === "lock" ? UI.auth.msg : "";
  }

  function enterApp(msg) {
    UI.auth = { step: "", error: "", busy: false, msg: "" };
    lastActivity = Date.now();
    rebuildIndex();
    if (autopayCatchUp()) { scheduleSync(); saveLocal(); }
    if (!location.hash || location.hash === "#") location.hash = "#/home";
    render();
    if (msg) toast(msg);
    syncNow();
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    const t = LS.get("bt_theme") || "auto";
    const dark = t === "dark" || (t === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const m = $('meta[name="theme-color"]');
    if (m) m.setAttribute("content", dark ? "#15111F" : "#5B3FA8");
  }

  /* ---------------- events ---------------- */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const fn = ACT[el.dataset.act];
    if (!fn) return;
    if (el.tagName === "BUTTON" && el.type === "submit") e.preventDefault();
    if (el.tagName === "A" && el.dataset.act === "closeSheet") { closeSheet(); return; }
    fn(el, e);
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-form]");
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === "bill") return saveBillForm();
    const btn = form.querySelector('[type="submit"][data-act]');
    if (btn && !btn.disabled) ACT[btn.dataset.act](btn, e);
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.actChange && CHANGE[el.dataset.actChange]) return CHANGE[el.dataset.actChange](el, e);
    if (el.dataset && el.dataset.draft != null && UI.draft) {
      readDraftInputs();
      if (el.hasAttribute("data-rerender")) { UI.keepScroll = true; render(); const f = $('[data-draft="' + el.dataset.draft + '"]'); if (f) f.focus(); }
    }
  });
  document.addEventListener("input", (e) => { if (e.target.dataset && e.target.dataset.draft != null && UI.draft) UI.draft[e.target.dataset.draft] = e.target.type === "checkbox" ? e.target.checked : e.target.value; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#sheetroot").innerHTML) closeSheet(); });
  ["pointerdown", "keydown"].forEach((t) => document.addEventListener(t, noteActivity, { passive: true }));
  window.addEventListener("hashchange", () => {
    if (!DB) return;
    closeSheetQuiet();
    if (route().name !== "settings") UI.payDraft = null;
    render();
    window.scrollTo(0, 0);
  });
  function closeSheetQuiet() { $("#sheetroot").innerHTML = ""; }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !DB) return;
    if (checkLock()) return;
    if (today() !== UI.lastDay) { UI.lastDay = today(); if (autopayCatchUp()) { scheduleSync(); saveLocal(); } softRender(); }
    syncNow();
  });
  window.addEventListener("online", () => { if (DB) syncNow(); });
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyTheme(); });
  function checkLock() {
    const pol = lockPolicy();
    if (!DB || pol === "never" || pol === "close") return false;
    if (Date.now() - lastActivity > Number(pol) * 60000) { lockNow(); return true; }
    return false;
  }
  setInterval(checkLock, 15000);
  setInterval(() => { if (DB && document.visibilityState === "visible") syncNow(); }, 5 * 60000);

  /* ---------------- boot ---------------- */
  async function boot() {
    applyTheme();
    UI.lastDay = today();
    if (!window.crypto || !crypto.subtle) {
      $("#root").innerHTML = '<div class="auth"><div class="authcard"><h1>Bill Tracker</h1><p>This browser can\'t lock your data safely. Open the app from its https:// address in Chrome, Edge, Safari or Firefox.</p></div></div>';
      return;
    }
    let meta = readMeta();
    if (meta && meta.v !== 2) { clearDevice(); meta = null; } // pre-release format
    if (meta) {
      const s = readJSON("bt_sync") || {};
      sync.v = s.v || 0; sync.dirty = !!s.dirty; sync.last = s.last || 0;
      if (await tryResume(meta)) { enterApp(); return; }
      UI.auth.step = "lock";
    } else UI.auth.step = "welcome";
    renderAuth();
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  // Exposed for testing in the browser console only.
  window.__billTracker = { get db() { return DB; }, period: (d) => period(d), syncNow };
  boot();
})();
