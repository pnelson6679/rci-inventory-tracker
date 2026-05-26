/**
 * BigQuery.gs — Data access layer + business logic for RCI Inventory Tracker.
 *
 * Design notes:
 *   - All reads and writes go through bqRun_(), a parameterized query runner. Using
 *     query parameters (not string interpolation) keeps free-text fields like
 *     descriptions and notes safe from SQL injection / quoting bugs.
 *   - Writes use DML (INSERT/UPDATE) rather than the streaming insertAll API. The app
 *     frequently needs to read or UPDATE a row right after writing it (bump a vehicle's
 *     reading, recalc its schedules). Rows in BigQuery's streaming buffer cannot be
 *     touched by DML for up to ~90 minutes, so streaming would break those flows. DML
 *     writes are immediately queryable and updatable — the right fit for this low-volume
 *     fleet app.
 *   - On success these functions return plain JSON-serializable data (objects/arrays).
 *     On failure they throw; the frontend's google.script.run .withFailureHandler()
 *     receives the error message. (See scripts.html callServer.)
 *
 * Requires the BigQuery advanced service (declared in appsscript.json) and the
 * BigQuery API enabled on the linked GCP project.
 */

/* -------------------------------------------------------------------------- */
/* Low-level query runner                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs a standard-SQL statement (SELECT or DML) with optional named parameters and
 * returns SELECT rows as an array of plain, type-coerced objects. DML statements
 * return an empty array.
 *
 * @param {string} sql       Standard SQL. Use @name placeholders for parameters.
 * @param {Object[]} [params] Query parameters built with param_() / paramArray_().
 * @return {Object[]}        One object per row, keyed by column name.
 */
function bqRun_(sql, params) {
  var projectId = CONFIG.GCP_PROJECT_ID;
  var request = {
    query: sql,
    useLegacySql: false,
    timeoutMs: 30000
  };
  if (params && params.length) {
    request.parameterMode = 'NAMED';
    request.queryParameters = params;
  }

  var resp = BigQuery.Jobs.query(request, projectId);
  var jobRef = resp.jobReference;
  var jobId = jobRef.jobId;
  var location = jobRef.location;
  var getOpts = location ? { location: location } : {};

  // Poll until the job finishes (query() only blocks up to timeoutMs).
  var attempts = 0;
  while (!resp.jobComplete && attempts < 40) {
    Utilities.sleep(500);
    resp = BigQuery.Jobs.getQueryResults(projectId, jobId, getOpts);
    attempts++;
  }
  if (!resp.jobComplete) {
    throw new Error('BigQuery query timed out after ~20s. Job: ' + jobId);
  }

  var fields = (resp.schema && resp.schema.fields) || [];
  var rows = resp.rows || [];

  // Page through large result sets.
  var pageToken = resp.pageToken;
  while (pageToken) {
    var pageOpts = { pageToken: pageToken };
    if (location) pageOpts.location = location;
    var page = BigQuery.Jobs.getQueryResults(projectId, jobId, pageOpts);
    rows = rows.concat(page.rows || []);
    pageToken = page.pageToken;
  }

  return rows.map(function (row) { return _rowToObject(fields, row); });
}

/** Back-compat alias: run a parameter-less query. */
function bqQuery_(sql) {
  return bqRun_(sql, []);
}

/** Convert one BigQuery REST row (all values are strings) into a typed object. */
function _rowToObject(fields, row) {
  var obj = {};
  row.f.forEach(function (cell, i) {
    var field = fields[i];
    obj[field.name] = _coerceCell(field, cell.v);
  });
  return obj;
}

/** Coerce a raw string cell value to a JS type based on the column's BigQuery type. */
function _coerceCell(field, raw) {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'INTEGER':
    case 'INT64':
      return raw === '' ? null : parseInt(raw, 10);
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return raw === '' ? null : parseFloat(raw);
    case 'BOOLEAN':
    case 'BOOL':
      return raw === true || raw === 'true';
    default:
      // STRING, DATE, TIMESTAMP (we format timestamps to ISO in SQL) stay as strings.
      return raw;
  }
}

/* -------------------------------------------------------------------------- */
/* Query-parameter helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a scalar named query parameter.
 * @param {string} name  Parameter name (matches @name in SQL).
 * @param {string} type  BigQuery type: STRING|INT64|FLOAT64|BOOL|DATE|TIMESTAMP.
 * @param {*} value      JS value; null/undefined becomes SQL NULL.
 */
function param_(name, type, value) {
  return {
    name: name,
    parameterType: { type: type },
    parameterValue: {
      value: (value === null || value === undefined) ? null : String(value)
    }
  };
}

/**
 * Build an ARRAY named query parameter (for `WHERE col IN UNNEST(@ids)`).
 * @param {string} name      Parameter name.
 * @param {string} elemType  Element type, e.g. 'STRING'.
 * @param {Array} values     Element values.
 */
function paramArray_(name, elemType, values) {
  return {
    name: name,
    parameterType: { type: 'ARRAY', arrayType: { type: elemType } },
    parameterValue: {
      arrayValues: (values || []).map(function (v) { return { value: String(v) }; })
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Column lists (timestamps formatted to ISO; dates cast to yyyy-MM-dd)       */
/* -------------------------------------------------------------------------- */

var VEHICLE_COLS_ =
  'id, name, type, make, model, year, vin_serial, license_plate, ' +
  'odometer_unit, current_reading, photo_url, status, notes, ' +
  "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at, 'UTC') AS created_at";

var SCHEDULE_COLS_ =
  'id, vehicle_id, rule_label, interval_type, interval_value, ' +
  'CAST(last_service_date AS STRING) AS last_service_date, last_service_reading, ' +
  'CAST(next_due_date AS STRING) AS next_due_date, next_due_reading, ' +
  'is_manual_flag, active, ' +
  "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at, 'UTC') AS created_at";

var RECORD_COLS_ =
  'id, vehicle_id, CAST(service_date AS STRING) AS service_date, service_type, ' +
  'odometer_at_service, description, technician_name, photo_urls, ' +
  "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at, 'UTC') AS created_at";

/* -------------------------------------------------------------------------- */
/* Read endpoints                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Dashboard payload: metric cards, fleet status list (sorted by urgency), and the
 * recent activity feed.
 * @return {{metrics: Object, fleet: Object[], recentActivity: Object[]}}
 */
function BQ_getDashboard() {
  var vehicles = bqRun_(
    'SELECT ' + VEHICLE_COLS_ + ' FROM ' + tableRef_('vehicles') +
    " WHERE status = 'active'",
    []
  );

  var fleet = _enrichVehicles(vehicles);

  // Metric counts.
  var overdue = 0, dueSoon = 0;
  fleet.forEach(function (v) {
    if (v.status === 'overdue') overdue++;
    else if (v.status === 'due_soon') dueSoon++;
  });

  var servicedRows = bqRun_(
    'SELECT COUNT(*) AS n FROM ' + tableRef_('service_records') +
    ' WHERE service_date >= @monthStart',
    [param_('monthStart', 'DATE', monthStartStr_())]
  );
  var servicedThisMonth = (servicedRows[0] && servicedRows[0].n) || 0;

  var recentActivity = bqRun_(
    'SELECT r.id AS id, r.vehicle_id AS vehicle_id, v.name AS vehicle_name, ' +
    'r.service_type AS service_type, CAST(r.service_date AS STRING) AS service_date, ' +
    'r.technician_name AS technician_name, r.odometer_at_service AS odometer_at_service, ' +
    "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', r.created_at, 'UTC') AS created_at " +
    'FROM ' + tableRef_('service_records') + ' r ' +
    'JOIN ' + tableRef_('vehicles') + ' v ON r.vehicle_id = v.id ' +
    'ORDER BY r.created_at DESC LIMIT 15',
    []
  );

  // Sort fleet by urgency, then name.
  var order = { overdue: 0, due_soon: 1, up_to_date: 2, no_schedule: 3 };
  fleet.sort(function (a, b) {
    var d = (order[a.status] - order[b.status]);
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name));
  });

  return {
    metrics: {
      total: fleet.length,
      overdue: overdue,
      due_soon: dueSoon,
      serviced_this_month: servicedThisMonth
    },
    fleet: fleet,
    recentActivity: recentActivity
  };
}

/**
 * Fleet view list with optional filters.
 * @param {{type?: string, status?: string, search?: string}} filters
 *   type: 'vehicle' | 'machinery'
 *   status: 'overdue' | 'due_soon' | 'up_to_date' | 'no_schedule' (computed status)
 *   search: matches name / make / model / vin_serial / license_plate
 * @return {Object[]} enriched vehicle cards
 */
function BQ_listVehicles(filters) {
  filters = filters || {};
  var where = [];
  var params = [];

  // Lifecycle filter (vehicle.status, distinct from computed service status).
  // 'active' (default) | 'inactive' | 'all'.
  var lifecycle = filters.lifecycle || 'active';
  if (lifecycle === 'active') where.push("status = 'active'");
  else if (lifecycle === 'inactive') where.push("status = 'inactive'");
  // 'all' -> no status restriction

  if (filters.type) {
    where.push('type = @type');
    params.push(param_('type', 'STRING', filters.type));
  }

  if (filters.search) {
    where.push(
      '(LOWER(name) LIKE @q OR LOWER(IFNULL(make, "")) LIKE @q OR ' +
      'LOWER(IFNULL(model, "")) LIKE @q OR LOWER(IFNULL(vin_serial, "")) LIKE @q OR ' +
      'LOWER(IFNULL(license_plate, "")) LIKE @q)'
    );
    params.push(param_('q', 'STRING', '%' + String(filters.search).toLowerCase() + '%'));
  }

  var whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  var vehicles = bqRun_(
    'SELECT ' + VEHICLE_COLS_ + ' FROM ' + tableRef_('vehicles') +
    whereSql + ' ORDER BY name',
    params
  );

  var enriched = _enrichVehicles(vehicles);

  // Service-status filter is applied in JS since status is computed, not stored.
  if (filters.status) {
    enriched = enriched.filter(function (v) { return v.status === filters.status; });
  }
  return enriched;
}

/**
 * One vehicle with its active schedule rules, full service history, and computed status.
 * @param {string} vehicleId
 * @return {{vehicle: Object, status: string, schedules: Object[], records: Object[]}}
 */
function BQ_getVehicle(vehicleId) {
  if (!vehicleId) throw new Error('vehicleId is required');

  var vehicles = bqRun_(
    'SELECT ' + VEHICLE_COLS_ + ' FROM ' + tableRef_('vehicles') +
    ' WHERE id = @id LIMIT 1',
    [param_('id', 'STRING', vehicleId)]
  );
  if (!vehicles.length) throw new Error('Vehicle not found: ' + vehicleId);
  var vehicle = vehicles[0];

  // Active rules drive the status badge; show them in the schedule panel.
  var schedules = bqRun_(
    'SELECT ' + SCHEDULE_COLS_ + ' FROM ' + tableRef_('service_schedules') +
    ' WHERE vehicle_id = @id AND active = TRUE ORDER BY created_at',
    [param_('id', 'STRING', vehicleId)]
  );

  var records = bqRun_(
    'SELECT ' + RECORD_COLS_ + ' FROM ' + tableRef_('service_records') +
    ' WHERE vehicle_id = @id ORDER BY service_date DESC, created_at DESC',
    [param_('id', 'STRING', vehicleId)]
  );

  return {
    vehicle: vehicle,
    status: computeStatus_(vehicle, schedules),
    schedules: schedules,
    records: records
  };
}

/**
 * Lists service records across the fleet with optional filters.
 * Joins with vehicles so every row includes the vehicle name and type.
 *
 * @param {{vehicle_id?: string, date_from?: string, date_to?: string,
 *           service_type?: string, search?: string}} filters
 *   date_from / date_to: ISO date strings 'YYYY-MM-DD'
 *   search: matched against vehicle name, service type, technician, description
 * @return {Object[]} records newest-first, max 500
 */
function BQ_listServiceRecords(filters) {
  filters = filters || {};
  var where = [];
  var params = [];

  if (filters.vehicle_id) {
    where.push('r.vehicle_id = @vid');
    params.push(param_('vid', 'STRING', filters.vehicle_id));
  }
  if (filters.date_from) {
    where.push('r.service_date >= @date_from');
    params.push(param_('date_from', 'DATE', filters.date_from));
  }
  if (filters.date_to) {
    where.push('r.service_date <= @date_to');
    params.push(param_('date_to', 'DATE', filters.date_to));
  }
  if (filters.service_type) {
    where.push('r.service_type = @stype');
    params.push(param_('stype', 'STRING', filters.service_type));
  }
  if (filters.search) {
    where.push(
      '(LOWER(v.name) LIKE @q OR LOWER(IFNULL(r.service_type, "")) LIKE @q OR ' +
      'LOWER(IFNULL(r.technician_name, "")) LIKE @q OR LOWER(IFNULL(r.description, "")) LIKE @q)'
    );
    params.push(param_('q', 'STRING', '%' + String(filters.search).toLowerCase() + '%'));
  }

  var whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  return bqRun_(
    'SELECT r.id AS id, r.vehicle_id AS vehicle_id, v.name AS vehicle_name, ' +
    'v.type AS vehicle_type, v.odometer_unit AS odometer_unit, ' +
    'CAST(r.service_date AS STRING) AS service_date, r.service_type AS service_type, ' +
    'r.odometer_at_service AS odometer_at_service, r.description AS description, ' +
    'r.technician_name AS technician_name, r.photo_urls AS photo_urls, ' +
    "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', r.created_at, 'UTC') AS created_at " +
    'FROM ' + tableRef_('service_records') + ' r ' +
    'JOIN ' + tableRef_('vehicles') + ' v ON r.vehicle_id = v.id' +
    whereSql + ' ORDER BY r.service_date DESC, r.created_at DESC LIMIT 500',
    params
  );
}

/* -------------------------------------------------------------------------- */
/* Write endpoints                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Inserts a new vehicle.
 * @param {Object} vehicle  Plain object matching the vehicles schema (minus id/status/created_at).
 * @return {Object} The inserted vehicle row (with generated id).
 */
function BQ_insertVehicle(vehicle) {
  if (!vehicle || !vehicle.name) throw new Error('Vehicle name is required');
  if (!vehicle.type) throw new Error('Vehicle type is required');
  if (!vehicle.odometer_unit) throw new Error('Odometer unit is required');

  var id = uuid_();
  var sql =
    'INSERT INTO ' + tableRef_('vehicles') +
    ' (id, name, type, make, model, year, vin_serial, license_plate, odometer_unit, ' +
    'current_reading, photo_url, status, notes, created_at) VALUES ' +
    "(@id, @name, @type, @make, @model, @year, @vin, @plate, @unit, @reading, @photo, " +
    "'active', @notes, CURRENT_TIMESTAMP())";

  bqRun_(sql, [
    param_('id', 'STRING', id),
    param_('name', 'STRING', vehicle.name),
    param_('type', 'STRING', vehicle.type),
    param_('make', 'STRING', vehicle.make || null),
    param_('model', 'STRING', vehicle.model || null),
    param_('year', 'INT64', _toIntOrNull(vehicle.year)),
    param_('vin', 'STRING', vehicle.vin_serial || null),
    param_('plate', 'STRING', vehicle.license_plate || null),
    param_('unit', 'STRING', vehicle.odometer_unit),
    param_('reading', 'FLOAT64', _toNum(vehicle.current_reading, 0)),
    param_('photo', 'STRING', vehicle.photo_url || null),
    param_('notes', 'STRING', vehicle.notes || null)
  ]);

  return BQ_getVehicle(id).vehicle;
}

/**
 * Updates an existing vehicle's editable fields.
 * @param {Object} vehicle  Must include `id`.
 * @return {Object} The updated vehicle row.
 */
function BQ_updateVehicle(vehicle) {
  if (!vehicle || !vehicle.id) throw new Error('Vehicle id is required');

  var sql =
    'UPDATE ' + tableRef_('vehicles') + ' SET ' +
    'name = @name, type = @type, make = @make, model = @model, year = @year, ' +
    'vin_serial = @vin, license_plate = @plate, odometer_unit = @unit, ' +
    'current_reading = @reading, photo_url = @photo, notes = @notes, ' +
    'status = @status WHERE id = @id';

  bqRun_(sql, [
    param_('id', 'STRING', vehicle.id),
    param_('name', 'STRING', vehicle.name),
    param_('type', 'STRING', vehicle.type),
    param_('make', 'STRING', vehicle.make || null),
    param_('model', 'STRING', vehicle.model || null),
    param_('year', 'INT64', _toIntOrNull(vehicle.year)),
    param_('vin', 'STRING', vehicle.vin_serial || null),
    param_('plate', 'STRING', vehicle.license_plate || null),
    param_('unit', 'STRING', vehicle.odometer_unit),
    param_('reading', 'FLOAT64', _toNum(vehicle.current_reading, 0)),
    param_('photo', 'STRING', vehicle.photo_url || null),
    param_('notes', 'STRING', vehicle.notes || null),
    param_('status', 'STRING', vehicle.status || 'active')
  ]);

  return BQ_getVehicle(vehicle.id).vehicle;
}

/**
 * Sets a vehicle's lifecycle status ('active' or 'inactive'). This is a soft
 * delete/retire: the row and all its service history are preserved, but inactive
 * vehicles drop out of the dashboard and the default fleet view.
 * @param {string} vehicleId
 * @param {string} status  'active' | 'inactive'
 * @return {{vehicle: Object, status: string, schedules: Object[], records: Object[]}}
 */
function BQ_setVehicleStatus(vehicleId, status) {
  if (!vehicleId) throw new Error('vehicleId is required');
  var valid = ['active', 'inactive'];
  if (valid.indexOf(status) === -1) {
    throw new Error('Invalid status: ' + status + " (expected 'active' or 'inactive')");
  }

  bqRun_(
    'UPDATE ' + tableRef_('vehicles') + ' SET status = @status WHERE id = @id',
    [param_('status', 'STRING', status), param_('id', 'STRING', vehicleId)]
  );

  return BQ_getVehicle(vehicleId);
}

/**
 * Logs a service record. Server-side this also:
 *   1) inserts the record,
 *   2) bumps vehicles.current_reading if the service reading is higher,
 *   3) recalculates next_due_date / next_due_reading on all active rules.
 * Wrapped in a script lock so concurrent logs don't corrupt the schedule recalc.
 *
 * @param {Object} record  { vehicle_id, service_date, service_type, odometer_at_service,
 *                           description, technician_name, photo_urls (Array|JSON string) }
 * @return {{record: Object, vehicle: Object, status: string, schedules: Object[]}}
 */
function BQ_insertServiceRecord(record) {
  if (!record || !record.vehicle_id) throw new Error('vehicle_id is required');
  if (!record.service_type) throw new Error('service_type is required');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Confirm the vehicle exists and grab its current reading.
    var vRows = bqRun_(
      'SELECT id, current_reading FROM ' + tableRef_('vehicles') +
      ' WHERE id = @id LIMIT 1',
      [param_('id', 'STRING', record.vehicle_id)]
    );
    if (!vRows.length) throw new Error('Vehicle not found: ' + record.vehicle_id);
    var currentReading = _toNum(vRows[0].current_reading, 0);

    var serviceDate = record.service_date || todayStr_();
    var odometer = (record.odometer_at_service === '' || record.odometer_at_service == null)
      ? null
      : _toNum(record.odometer_at_service, null);

    // photo_urls is stored as a JSON-array string.
    var photoJson = _normalizePhotoUrls(record.photo_urls);

    var id = uuid_();
    bqRun_(
      'INSERT INTO ' + tableRef_('service_records') +
      ' (id, vehicle_id, service_date, service_type, odometer_at_service, description, ' +
      'technician_name, photo_urls, created_at) VALUES ' +
      '(@id, @vid, @sd, @stype, @odo, @desc, @tech, @photos, CURRENT_TIMESTAMP())',
      [
        param_('id', 'STRING', id),
        param_('vid', 'STRING', record.vehicle_id),
        param_('sd', 'DATE', serviceDate),
        param_('stype', 'STRING', record.service_type),
        param_('odo', 'FLOAT64', odometer),
        param_('desc', 'STRING', record.description || null),
        param_('tech', 'STRING', record.technician_name || null),
        param_('photos', 'STRING', photoJson)
      ]
    );

    // Bump the odometer if this service reading is higher.
    if (odometer !== null && odometer > currentReading) {
      bqRun_(
        'UPDATE ' + tableRef_('vehicles') + ' SET current_reading = @r WHERE id = @id',
        [param_('r', 'FLOAT64', odometer), param_('id', 'STRING', record.vehicle_id)]
      );
    }

    // Recalculate schedules for all active rules.
    recalcSchedules_(record.vehicle_id, serviceDate, odometer);

    var fresh = BQ_getVehicle(record.vehicle_id);
    var inserted = fresh.records.filter(function (r) { return r.id === id; })[0] || null;

    return {
      record: inserted,
      vehicle: fresh.vehicle,
      status: fresh.status,
      schedules: fresh.schedules
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates or updates a service schedule rule for a vehicle, computing its initial
 * (or refreshed) next_due_date / next_due_reading from the vehicle's most recent
 * service (falling back to today / current reading).
 *
 * @param {Object} rule  { id?, vehicle_id, rule_label, interval_type, interval_value,
 *                         active? }
 * @return {Object} The saved schedule rule row.
 */
function BQ_saveScheduleRule(rule) {
  if (!rule || !rule.vehicle_id) throw new Error('vehicle_id is required');
  if (!rule.interval_type) throw new Error('interval_type is required');
  var validTypes = ['time', 'mileage', 'hours', 'manual'];
  if (validTypes.indexOf(rule.interval_type) === -1) {
    throw new Error('Invalid interval_type: ' + rule.interval_type);
  }
  if (rule.interval_type !== 'manual' &&
      (rule.interval_value == null || _toNum(rule.interval_value, 0) <= 0)) {
    throw new Error('interval_value must be a positive number for ' + rule.interval_type + ' rules');
  }

  // Baseline for the first due-date/reading calculation.
  var base = _serviceBaseline(rule.vehicle_id);
  var due = _computeRuleDue(rule, base.date, base.reading);
  var active = (rule.active === false) ? false : true;

  var id;
  if (rule.id) {
    id = rule.id;
    bqRun_(
      'UPDATE ' + tableRef_('service_schedules') + ' SET ' +
      'rule_label = @label, interval_type = @itype, interval_value = @ival, ' +
      'last_service_date = @lsd, last_service_reading = @lsr, ' +
      'next_due_date = @ndd, next_due_reading = @ndr, ' +
      'is_manual_flag = @manual, active = @active WHERE id = @id AND vehicle_id = @vid',
      _ruleParams(id, rule, due, active)
    );
  } else {
    id = uuid_();
    bqRun_(
      'INSERT INTO ' + tableRef_('service_schedules') +
      ' (id, vehicle_id, rule_label, interval_type, interval_value, last_service_date, ' +
      'last_service_reading, next_due_date, next_due_reading, is_manual_flag, active, ' +
      'created_at) VALUES ' +
      '(@id, @vid, @label, @itype, @ival, @lsd, @lsr, @ndd, @ndr, @manual, @active, ' +
      'CURRENT_TIMESTAMP())',
      _ruleParams(id, rule, due, active)
    );
  }

  var saved = bqRun_(
    'SELECT ' + SCHEDULE_COLS_ + ' FROM ' + tableRef_('service_schedules') +
    ' WHERE id = @id LIMIT 1',
    [param_('id', 'STRING', id)]
  );
  return saved[0] || null;
}

/** Builds the shared parameter list for the schedule insert/update statements. */
function _ruleParams(id, rule, due, active) {
  return [
    param_('id', 'STRING', id),
    param_('vid', 'STRING', rule.vehicle_id),
    param_('label', 'STRING', rule.rule_label || _defaultRuleLabel(rule.interval_type)),
    param_('itype', 'STRING', rule.interval_type),
    param_('ival', 'FLOAT64', rule.interval_type === 'manual' ? null : _toNum(rule.interval_value, null)),
    param_('lsd', 'DATE', due.last_service_date),
    param_('lsr', 'FLOAT64', due.last_service_reading),
    param_('ndd', 'DATE', due.next_due_date),
    param_('ndr', 'FLOAT64', due.next_due_reading),
    param_('manual', 'BOOL', due.is_manual_flag),
    param_('active', 'BOOL', active)
  ];
}

/* -------------------------------------------------------------------------- */
/* Business logic helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Computes a vehicle's status from its active rules.
 * @param {Object} vehicle      Needs current_reading and odometer_unit.
 * @param {Object[]} activeRules Active service_schedules rows for the vehicle.
 * @return {'overdue'|'due_soon'|'up_to_date'|'no_schedule'}
 *
 * Per spec:
 *   overdue    — today > next_due_date, OR current_reading > next_due_reading,
 *                OR an active manual "needs service" flag.
 *   due_soon   — within 30 days, OR within 500 miles / 25 hours of next_due_reading.
 *   up_to_date — has active rules, none overdue or due-soon.
 *   no_schedule— no active rules.
 * Most-urgent rule wins when multiple rules are active.
 */
function computeStatus_(vehicle, activeRules) {
  if (!activeRules || !activeRules.length) return 'no_schedule';

  var today = todayStr_();
  var reading = _toNum(vehicle.current_reading, 0);
  var readingThreshold = (vehicle.odometer_unit === 'hours') ? 25 : 500;
  var status = 'up_to_date';

  for (var i = 0; i < activeRules.length; i++) {
    var r = activeRules[i];

    // Manual "needs service" flag — always counts as overdue while active.
    if (r.is_manual_flag === true || r.is_manual_flag === 'true') {
      return 'overdue';
    }

    // Overdue checks (return immediately — most urgent).
    if (r.next_due_date && r.next_due_date < today) return 'overdue';
    if (r.next_due_reading != null && reading > _toNum(r.next_due_reading, Infinity)) {
      return 'overdue';
    }

    // Due-soon checks (accumulate; overdue may still win on a later rule).
    if (r.next_due_date) {
      if (daysBetween_(today, r.next_due_date) <= 30) status = 'due_soon';
    }
    if (r.next_due_reading != null) {
      if ((_toNum(r.next_due_reading, Infinity) - reading) <= readingThreshold) {
        status = 'due_soon';
      }
    }
  }
  return status;
}

/**
 * Recalculates next_due_date / next_due_reading for all active rules on a vehicle
 * after a service record is saved.
 *   time-based:    last_service_date = service_date; next_due_date = +interval months
 *   mileage/hours: last_service_reading = odometer;  next_due_reading = odometer + interval
 *   manual:        cleared (the "needs service" flag is satisfied by logging the service)
 *
 * @param {string} vehicleId
 * @param {string} serviceDate         yyyy-MM-dd
 * @param {number|null} odometerAtService
 */
function recalcSchedules_(vehicleId, serviceDate, odometerAtService) {
  // Time-based rules: roll the due date forward from the service date.
  bqRun_(
    'UPDATE ' + tableRef_('service_schedules') + ' SET ' +
    'last_service_date = @sd, ' +
    'next_due_date = DATE_ADD(@sd, INTERVAL CAST(ROUND(interval_value) AS INT64) MONTH) ' +
    "WHERE vehicle_id = @vid AND active = TRUE AND interval_type = 'time'",
    [param_('sd', 'DATE', serviceDate), param_('vid', 'STRING', vehicleId)]
  );

  // Mileage/hour rules: roll the due reading forward from the service reading.
  if (odometerAtService !== null && odometerAtService !== undefined) {
    bqRun_(
      'UPDATE ' + tableRef_('service_schedules') + ' SET ' +
      'last_service_reading = @r, next_due_reading = @r + interval_value ' +
      "WHERE vehicle_id = @vid AND active = TRUE AND interval_type IN ('mileage', 'hours')",
      [param_('r', 'FLOAT64', odometerAtService), param_('vid', 'STRING', vehicleId)]
    );
  }

  // Manual flags: satisfied by this service — clear and deactivate them.
  bqRun_(
    'UPDATE ' + tableRef_('service_schedules') + ' SET ' +
    'is_manual_flag = FALSE, active = FALSE, last_service_date = @sd ' +
    "WHERE vehicle_id = @vid AND active = TRUE AND interval_type = 'manual'",
    [param_('sd', 'DATE', serviceDate), param_('vid', 'STRING', vehicleId)]
  );
}

/**
 * Computes the next-due values for a single rule given a baseline date/reading.
 * @return {{last_service_date, last_service_reading, next_due_date, next_due_reading, is_manual_flag}}
 */
function _computeRuleDue(rule, baseDate, baseReading) {
  var out = {
    last_service_date: null,
    last_service_reading: null,
    next_due_date: null,
    next_due_reading: null,
    is_manual_flag: false
  };
  var interval = _toNum(rule.interval_value, 0);

  if (rule.interval_type === 'time') {
    out.last_service_date = baseDate;
    out.next_due_date = addMonths_(baseDate, interval);
  } else if (rule.interval_type === 'mileage' || rule.interval_type === 'hours') {
    out.last_service_reading = baseReading;
    out.next_due_reading = baseReading + interval;
  } else if (rule.interval_type === 'manual') {
    out.is_manual_flag = true;
  }
  return out;
}

/**
 * Finds the baseline (most recent service date and reading) for seeding a new rule's
 * due calculation. Falls back to today and the vehicle's current reading.
 * @return {{date: string, reading: number}}
 */
function _serviceBaseline(vehicleId) {
  var rows = bqRun_(
    'SELECT CAST(MAX(service_date) AS STRING) AS last_date FROM ' +
    tableRef_('service_records') + ' WHERE vehicle_id = @id',
    [param_('id', 'STRING', vehicleId)]
  );
  var lastDate = (rows[0] && rows[0].last_date) || null;

  var vRows = bqRun_(
    'SELECT current_reading FROM ' + tableRef_('vehicles') + ' WHERE id = @id LIMIT 1',
    [param_('id', 'STRING', vehicleId)]
  );
  var reading = (vRows.length) ? _toNum(vRows[0].current_reading, 0) : 0;

  return { date: lastDate || todayStr_(), reading: reading };
}

/**
 * Enriches raw vehicle rows with computed status, last-serviced date, and a next-due
 * summary. Shared by the dashboard and the fleet list. Uses a small number of batched
 * queries (one for schedules, one for last-service dates) regardless of fleet size.
 * @param {Object[]} vehicleRows
 * @return {Object[]}
 */
function _enrichVehicles(vehicleRows) {
  if (!vehicleRows.length) return [];

  var ids = vehicleRows.map(function (v) { return v.id; });

  var schedules = bqRun_(
    'SELECT ' + SCHEDULE_COLS_ + ' FROM ' + tableRef_('service_schedules') +
    ' WHERE vehicle_id IN UNNEST(@ids) AND active = TRUE',
    [paramArray_('ids', 'STRING', ids)]
  );

  var lastSvc = bqRun_(
    'SELECT vehicle_id, CAST(MAX(service_date) AS STRING) AS last_service_date FROM ' +
    tableRef_('service_records') + ' WHERE vehicle_id IN UNNEST(@ids) GROUP BY vehicle_id',
    [paramArray_('ids', 'STRING', ids)]
  );

  var schedBy = {};
  schedules.forEach(function (s) {
    (schedBy[s.vehicle_id] = schedBy[s.vehicle_id] || []).push(s);
  });
  var lastBy = {};
  lastSvc.forEach(function (r) { lastBy[r.vehicle_id] = r.last_service_date; });

  return vehicleRows.map(function (v) {
    var rules = schedBy[v.id] || [];
    var nd = _summarizeNextDue(rules);
    return {
      id: v.id,
      name: v.name,
      type: v.type,
      make: v.make,
      model: v.model,
      year: v.year,
      odometer_unit: v.odometer_unit,
      current_reading: v.current_reading,
      photo_url: v.photo_url,
      lifecycle: v.status, // raw 'active'|'inactive' (status below is computed service status)
      status: computeStatus_(v, rules),
      last_service_date: lastBy[v.id] || null,
      next_due_date: nd.next_due_date,
      next_due_reading: nd.next_due_reading
    };
  });
}

/** Summarizes the soonest next_due_date and lowest next_due_reading across rules. */
function _summarizeNextDue(rules) {
  var nextDate = null, nextReading = null;
  rules.forEach(function (r) {
    if (r.next_due_date && (!nextDate || r.next_due_date < nextDate)) {
      nextDate = r.next_due_date;
    }
    if (r.next_due_reading != null) {
      var val = _toNum(r.next_due_reading, null);
      if (val !== null && (nextReading === null || val < nextReading)) nextReading = val;
    }
  });
  return { next_due_date: nextDate, next_due_reading: nextReading };
}

/* -------------------------------------------------------------------------- */
/* Small value helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Coerce to number, or return fallback when not parseable. */
function _toNum(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  var n = Number(value);
  return isNaN(n) ? fallback : n;
}

/** Coerce to integer, or null. */
function _toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

/** Normalize photo_urls input (array or string) into a JSON-array string. */
function _normalizePhotoUrls(photoUrls) {
  if (!photoUrls) return '[]';
  if (Array.isArray(photoUrls)) return JSON.stringify(photoUrls);
  // Already a string — trust it if it parses as JSON, else wrap a single URL.
  try {
    var parsed = JSON.parse(photoUrls);
    return JSON.stringify(Array.isArray(parsed) ? parsed : [photoUrls]);
  } catch (e) {
    return JSON.stringify([photoUrls]);
  }
}

/** Friendly default label when the user doesn't name a rule. */
function _defaultRuleLabel(intervalType) {
  switch (intervalType) {
    case 'time': return 'Time-based service';
    case 'mileage': return 'Mileage-based service';
    case 'hours': return 'Hour-based service';
    case 'manual': return 'Needs service (manual flag)';
    default: return 'Service rule';
  }
}
