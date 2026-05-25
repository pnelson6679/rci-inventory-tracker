/**
 * BigQuery.gs — Data access layer for RCI Inventory Tracker.
 *
 * These are SCAFFOLD stubs. The JS Engineer fills in the query bodies. They show the
 * intended shape of each call and the BigQuery advanced-service pattern so the rest of
 * the team can build against stable signatures.
 *
 * Requires the BigQuery advanced service (enabled in appsscript.json) and the
 * BigQuery API turned on in the GCP project.
 */

/* -------------------------------------------------------------------------- */
/* Low-level query runner                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs a standard-SQL query and returns rows as an array of plain objects.
 * @param {string} sql  Standard SQL.
 * @return {Object[]}   One object per row, keyed by column name.
 */
function bqQuery_(sql) {
  var request = { query: sql, useLegacySql: false };
  var queryResults = BigQuery.Jobs.query(request, CONFIG.GCP_PROJECT_ID);
  var jobId = queryResults.jobReference.jobId;

  // Poll until complete (queries here are small; large jobs should paginate).
  var sleepMs = 250;
  while (!queryResults.jobComplete) {
    Utilities.sleep(sleepMs);
    queryResults = BigQuery.Jobs.getQueryResults(CONFIG.GCP_PROJECT_ID, jobId);
  }

  var fields = (queryResults.schema && queryResults.schema.fields) || [];
  var rows = queryResults.rows || [];
  return rows.map(function (row) {
    var obj = {};
    row.f.forEach(function (cell, i) {
      obj[fields[i].name] = cell.v;
    });
    return obj;
  });
}

/**
 * Inserts rows via the streaming insertAll API.
 * @param {string} table  Table name (e.g. 'vehicles').
 * @param {Object[]} rows Array of row objects.
 */
function bqInsert_(table, rows) {
  var data = {
    rows: rows.map(function (r) { return { json: r }; })
  };
  return BigQuery.Tabledata.insertAll(
    data, CONFIG.GCP_PROJECT_ID, CONFIG.BQ_DATASET, table
  );
}

/* -------------------------------------------------------------------------- */
/* Read endpoints (TODO: JS Engineer)                                         */
/* -------------------------------------------------------------------------- */

function BQ_getDashboard() {
  // TODO: compute metric cards (total / overdue / due-soon / serviced-this-month),
  // fleet status list (sorted by urgency), and the recent activity feed.
  // Status logic lives in computeStatus_ below.
  throw new Error('BQ_getDashboard not implemented yet');
}

function BQ_listVehicles(filters) {
  // TODO: SELECT * FROM vehicles WHERE status = 'active' [+ type/status/search filters].
  throw new Error('BQ_listVehicles not implemented yet');
}

function BQ_getVehicle(vehicleId) {
  // TODO: join vehicle + its service_schedules + service_records (most recent first).
  throw new Error('BQ_getVehicle not implemented yet');
}

/* -------------------------------------------------------------------------- */
/* Write endpoints (TODO: JS Engineer)                                        */
/* -------------------------------------------------------------------------- */

function BQ_insertVehicle(vehicle) {
  var row = {
    id: uuid_(),
    name: vehicle.name,
    type: vehicle.type,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    vin_serial: vehicle.vin_serial || null,
    license_plate: vehicle.license_plate || null,
    odometer_unit: vehicle.odometer_unit,
    current_reading: vehicle.current_reading || 0,
    photo_url: vehicle.photo_url || null,
    status: 'active',
    notes: vehicle.notes || null,
    created_at: nowTs_()
  };
  bqInsert_('vehicles', [row]);
  return row;
}

function BQ_updateVehicle(vehicle) {
  // TODO: UPDATE vehicles SET ... WHERE id = @id  (BigQuery DML).
  throw new Error('BQ_updateVehicle not implemented yet');
}

function BQ_insertServiceRecord(record) {
  // TODO:
  //   1) insert into service_records
  //   2) if record.odometer_at_service > vehicle.current_reading, update vehicle
  //   3) recalc next_due_date / next_due_reading on all active rules (see recalcSchedules_)
  throw new Error('BQ_insertServiceRecord not implemented yet');
}

function BQ_saveScheduleRule(rule) {
  // TODO: upsert into service_schedules and compute initial next_due_* values.
  throw new Error('BQ_saveScheduleRule not implemented yet');
}

/* -------------------------------------------------------------------------- */
/* Business logic helpers (TODO: JS Engineer)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Computes a vehicle's status from its active rules.
 * @return {'overdue'|'due_soon'|'up_to_date'|'no_schedule'}
 *
 * Rules (from spec):
 *   overdue    — today > next_due_date OR current_reading > next_due_reading
 *   due_soon   — within 30 days OR within 500 miles / 25 hours of next_due_reading
 *   up_to_date — has active rules, none overdue or due-soon
 *   no_schedule— no active rules
 * Most-urgent rule wins when multiple rules are active.
 */
function computeStatus_(vehicle, activeRules) {
  // TODO: implement per spec "Business Logic & Rules".
  return 'no_schedule';
}

/**
 * Recalculates next_due_date / next_due_reading for all active rules on a vehicle
 * after a service record is saved.
 *   time-based:    next_due_date    = service_date + interval_value months
 *   mileage/hours: next_due_reading = odometer_at_service + interval_value
 */
function recalcSchedules_(vehicleId, serviceDate, odometerAtService) {
  // TODO: implement per spec "Schedule recalculation".
}
