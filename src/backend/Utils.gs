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
  // Add the whole crew here. Case-insensitive.
  ALLOWLIST: [
    'pnelson6679@gmail.com'
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
