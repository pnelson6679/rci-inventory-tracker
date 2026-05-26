/**
 * Code.gs — Main Apps Script entry point for RCI Inventory Tracker (Fleet Service Tracker).
 *
 * Responsibilities:
 *   - doGet(): serve the web app + complete the Google sign-in callback
 *   - include(): HtmlService partial-include helper (styles/scripts)
 *   - Thin server-side endpoints the frontend calls via google.script.run
 *
 * ACCESS MODEL
 *   The app is deployed "Execute as: me", so every client endpoint runs with the
 *   owner's Drive/BigQuery access. Because of that, EVERY client-callable function
 *   below takes the caller's session token as its first argument and calls
 *   requireAuth_(token) before doing anything. The page itself is just a shell —
 *   real access control happens per-call. See Auth.gs for the sign-in flow.
 *
 * The heavy lifting (status calculation, schedule recalculation, BigQuery reads/writes)
 * lives in BigQuery.gs and is filled in by the JS Engineer. This file is the router and
 * access gate only.
 */

/**
 * Entry point for every GET. Two jobs:
 *   1. If Google redirected back with ?code=, finish sign-in (see Auth.gs).
 *   2. Otherwise serve the SPA shell. The shell decides — client-side — whether to
 *      show the sign-in screen or the app, based on the stored session token.
 */
function doGet(e) {
  e = e || {};
  var p = e.parameter || {};

  // 1) OAuth sign-in callback.
  if (p.code) {
    return handleOAuthCallback_(p);
  }

  // 2) Serve the app shell. AUTH_URL is read by the client to power the
  //    "Sign in with Google" button. No server-side identity gating here —
  //    the individual endpoints enforce the allowlist on every call.
  var tmpl = HtmlService.createTemplateFromFile('frontend/Index');
  tmpl.AUTH_URL = buildAuthUrl_();
  return tmpl.evaluate()
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
/*                                                                            */
/* SECURITY: every function takes the caller's session `token` as its first   */
/* argument and calls requireAuth_(token) first. Because the app executes as  */
/* the owner, an unguarded endpoint would let any logged-in stranger run      */
/* Drive/BigQuery operations as you — so the guard is mandatory, not optional.*/
/* The frontend's callServer() prepends the token automatically.              */
/* -------------------------------------------------------------------------- */

/** Returns dashboard payload: metric cards, fleet status list, recent activity. */
function getDashboard(token) {
  requireAuth_(token);
  return BQ_getDashboard();
}

/** Returns all vehicles (optionally filtered) for the Fleet view. */
function listVehicles(token, filters) {
  requireAuth_(token);
  return BQ_listVehicles(filters || {});
}

/** Returns one vehicle with its schedule rules and full service history. */
function getVehicle(token, vehicleId) {
  requireAuth_(token);
  return BQ_getVehicle(vehicleId);
}

/** Inserts a new vehicle. `vehicle` is a plain object matching the vehicles schema. */
function addVehicle(token, vehicle) {
  requireAuth_(token);
  return BQ_insertVehicle(vehicle);
}

/** Updates an existing vehicle. */
function updateVehicle(token, vehicle) {
  requireAuth_(token);
  return BQ_updateVehicle(vehicle);
}

/**
 * Retires or reactivates a vehicle (soft delete). `status` is 'active' or 'inactive'.
 * Inactive vehicles keep their full service history but drop out of the dashboard
 * and the default fleet view.
 */
function setVehicleStatus(token, vehicleId, status) {
  requireAuth_(token);
  return BQ_setVehicleStatus(vehicleId, status);
}

/**
 * Logs a service record. Server-side this should also:
 *   - bump vehicles.current_reading if odometer_at_service is higher
 *   - recalculate next_due_date / next_due_reading on all active rules
 * (see BigQuery.gs)
 */
function logService(token, record) {
  requireAuth_(token);
  return BQ_insertServiceRecord(record);
}

/** Creates / updates a service schedule rule for a vehicle. */
function saveScheduleRule(token, rule) {
  requireAuth_(token);
  return BQ_saveScheduleRule(rule);
}

/**
 * Uploads a photo to Drive (one folder per vehicle ID) and returns the share URL.
 * `dataUrl` is a base64 data URL from the browser's file input.
 */
function uploadPhoto(token, vehicleId, dataUrl, filename) {
  requireAuth_(token);
  return Drive_savePhoto(vehicleId, dataUrl, filename);
}
