// Bill Tracker settings.
// Current setup: sync Worker "bill-tracker-sync" on Cloudflare, site at
// https://alphadivine.github.io/bill-tracker/. This file ships filled in,
// so uploading a new version never turns sync off.
// Set syncUrl to "" to keep everything on one device only.
window.BILL_TRACKER_CONFIG = {
  syncUrl: "https://bill-tracker-sync.quentinclayton643.workers.dev"
};
