/**
 * Utils.gs — Shared configuration and utility helpers.
 */

/**
 * Project configuration. Update these three values before first deploy.
 */
var CONFIG = {
  // Your Google Cloud project ID (billing project for BigQuery jobs).
  GCP_PROJECT_ID: 'rci-inventory',

  // BigQuery dataset created in Step 5 of the README.
  BQ_DATASET: 'rci_inventory_tracker_db',

  // Drive folder ID that holds one sub-folder per vehicle for photos.
  // Create a folder in Drive, open it, and copy the ID from the URL.
  // https://drive.google.com/drive/folders/16sSxaVBXUHcW7y807gomEUqjII_0fH9o?usp=drive_link
  DRIVE_ROOT_FOLDER_ID: '16sSxaVBXUHcW7y807gomEUqjII_0fH9o',

  // Email allowlist — only these accounts can open the web app.
  // Add the whole crew here. Case-insensitive. After editing, run ./release.sh
  // (or clasp push + redeploy) — no GCP/console change is needed to add a person.
  ALLOWLIST: [
    'pnelson6679@gmail.com',
    'davvradd@gmail.com'
    // , 'crewmember@gmail.com'   ← add the rest of the crew here
  ]
};

/** Fully-qualified table reference: `project.dataset.table` */
function tableRef_(table) {
  return '`' + CONFIG.GCP_PROJECT_ID + '.' + CONFIG.BQ_DATASET + '.' + table + '`';
}

/** Returns the accessing user's email (lowercased), or '' if unavailable. */
function getActiveUserEmail_() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  return email;
}

/** True if the email is on the allowlist. */
function isAllowed_(email) {
  if (!email) return false;
  var lower = email.toLowerCase();
  return CONFIG.ALLOWLIST.some(function (e) {
    return e.toLowerCase() === lower;
  });
}

/** Generate a RFC4122-ish UUID for use as a primary key. */
function uuid_() {
  return Utilities.getUuid();
}

/** Current timestamp as a BigQuery-friendly UTC string. */
function nowTs_() {
  return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/** Format a Date as a BigQuery DATE string (yyyy-MM-dd). */
function toDateStr_(date) {
  return Utilities.formatDate(date, CONFIG_TZ_(), 'yyyy-MM-dd');
}

/** Project timezone helper (kept in sync with appsscript.json). */
function CONFIG_TZ_() {
  return Session.getScriptTimeZone() || 'America/New_York';
}

/** Escape a string for safe inline use in a SQL string literal. */
function sqlEscape_(value) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* -------------------------------------------------------------------------- */
/* Date helpers (used by status calc + schedule recalculation)                */
/* -------------------------------------------------------------------------- */

/** Today's date in the project timezone, as a BigQuery DATE string (yyyy-MM-dd). */
function todayStr_() {
  return Utilities.formatDate(new Date(), CONFIG_TZ_(), 'yyyy-MM-dd');
}

/** First day of the current month in the project timezone (yyyy-MM-01). */
function monthStartStr_() {
  return Utilities.formatDate(new Date(), CONFIG_TZ_(), 'yyyy-MM') + '-01';
}

/**
 * Adds a whole number of months to a yyyy-MM-dd date string, clamping the day to
 * the last valid day of the target month (e.g. Jan 31 + 1 month -> Feb 28/29).
 * @param {string} dateStr  'yyyy-MM-dd'
 * @param {number} months   Integer months to add (rounded).
 * @return {string} 'yyyy-MM-dd'
 */
function addMonths_(dateStr, months) {
  var p = String(dateStr).split('-');
  var y = parseInt(p[0], 10);
  var m = parseInt(p[1], 10) - 1; // 0-based
  var d = parseInt(p[2], 10);

  var add = Math.round(Number(months) || 0);
  var total = m + add;
  var targetYear = y + Math.floor(total / 12);
  var targetMonth = ((total % 12) + 12) % 12; // 0-based, always positive

  // Clamp day to the last day of the target month.
  var lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  var day = Math.min(d, lastDay);

  var dt = new Date(Date.UTC(targetYear, targetMonth, day));
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}

/**
 * Whole-day difference (b - a) between two yyyy-MM-dd date strings.
 * Positive when b is later than a.
 * @return {number}
 */
function daysBetween_(aStr, bStr) {
  var a = _parseDateUtc(aStr);
  var b = _parseDateUtc(bStr);
  return Math.round((b - a) / 86400000);
}

/** Parse a yyyy-MM-dd string to a UTC-midnight Date. */
function _parseDateUtc(dateStr) {
  var p = String(dateStr).split('-');
  return new Date(Date.UTC(
    parseInt(p[0], 10),
    parseInt(p[1], 10) - 1,
    parseInt(p[2], 10)
  ));
}
