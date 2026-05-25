/**
 * Code.gs — Main Apps Script entry point for RCI Inventory Tracker (Fleet Service Tracker).
 *
 * Responsibilities:
 *   - doGet(): serve the web app, gated by an email allowlist
 *   - include(): HtmlService partial-include helper (styles/scripts)
 *   - Thin server-side endpoints the frontend calls via google.script.run
 *
 * The heavy lifting (status calculation, schedule recalculation, BigQuery reads/writes)
 * lives in BigQuery.gs and is filled in by the JS Engineer. This file is the router and
 * access gate only.
 */

/**
 * Serves the single-page web app.
 * Access is restricted to emails in CONFIG.ALLOWLIST (see Utils.gs).
 */
function doGet(e) {
  var email = getActiveUserEmail_();

  if (!isAllowed_(email)) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>Access denied</h2>' +
      '<p>The account <b>' + (email || 'unknown') + '</b> is not authorized to use this app.</p>' +
      '<p>Ask the fleet admin to add you to the allowlist.</p>' +
      '</div>'
    ).setTitle('RCI Inventory Tracker');
  }

  return HtmlService.createTemplateFromFile('frontend/Index')
    .evaluate()
    .setTitle('RCI Inventory Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Include partial HTML files (styles.html, scripts.html) inside Index.html.
 * Usage in Index.html: <?!= include('styles'); ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* -------------------------------------------------------------------------- */
/* Client-callable endpoints (google.script.run)                              */
/* These are thin wrappers; real implementations go in BigQuery.gs.           */
/* -------------------------------------------------------------------------- */

/** Returns dashboard payload: metric cards, fleet status list, recent activity. */
function getDashboard() {
  return BQ_getDashboard();
}

/** Returns all vehicles (optionally filtered) for the Fleet view. */
function listVehicles(filters) {
  return BQ_listVehicles(filters || {});
}

/** Returns one vehicle with its schedule rules and full service history. */
function getVehicle(vehicleId) {
  return BQ_getVehicle(vehicleId);
}

/** Inserts a new vehicle. `vehicle` is a plain object matching the vehicles schema. */
function addVehicle(vehicle) {
  return BQ_insertVehicle(vehicle);
}

/** Updates an existing vehicle. */
function updateVehicle(vehicle) {
  return BQ_updateVehicle(vehicle);
}

/**
 * Retires or reactivates a vehicle (soft delete). `status` is 'active' or 'inactive'.
 * Inactive vehicles keep their full service history but drop out of the dashboard
 * and the default fleet view.
 */
function setVehicleStatus(vehicleId, status) {
  return BQ_setVehicleStatus(vehicleId, status);
}

/**
 * Logs a service record. Server-side this should also:
 *   - bump vehicles.current_reading if odometer_at_service is higher
 *   - recalculate next_due_date / next_due_reading on all active rules
 * (see BigQuery.gs)
 */
function logService(record) {
  return BQ_insertServiceRecord(record);
}

/** Creates / updates a service schedule rule for a vehicle. */
function saveScheduleRule(rule) {
  return BQ_saveScheduleRule(rule);
}

/**
 * Uploads a photo to Drive (one folder per vehicle ID) and returns the share URL.
 * `dataUrl` is a base64 data URL from the browser's file input.
 */
function uploadPhoto(vehicleId, dataUrl, filename) {
  return Drive_savePhoto(vehicleId, dataUrl, filename);
}
