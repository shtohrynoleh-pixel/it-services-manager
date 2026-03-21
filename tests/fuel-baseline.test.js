// Unit tests for fuel baseline + target precedence
// Run: node tests/fuel-baseline.test.js

const Database = require('better-sqlite3');
const { computeGroupBaseline, getEffectiveTarget } = require('../lib/fuel-baseline');

let db;
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.log('  ❌ FAIL: ' + msg); }
}

function setup() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE company_users (id INTEGER PRIMARY KEY, company_id INTEGER, name TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE fleet_vehicles (id INTEGER PRIMARY KEY, company_id INTEGER, unit_number TEXT);
    CREATE TABLE fuel_groups (id INTEGER PRIMARY KEY, company_id INTEGER, name TEXT, baseline_mpg REAL DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE fuel_truck_group_map (id INTEGER PRIMARY KEY, company_id INTEGER, vehicle_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_driver_group_map (id INTEGER PRIMARY KEY, company_id INTEGER, driver_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_measurements_daily (id INTEGER PRIMARY KEY, company_id INTEGER, integration_id INTEGER, vehicle_id INTEGER, driver_id INTEGER, date TEXT, miles REAL, gallons REAL, mpg REAL, idle_hours REAL, idle_gallons REAL, odometer_start REAL, odometer_end REAL, provider TEXT, provider_vehicle_id TEXT, raw_data TEXT, created_at TEXT);
    CREATE TABLE fuel_baseline_snapshots (id INTEGER PRIMARY KEY, company_id INTEGER, group_id INTEGER, driver_id INTEGER, scope TEXT, period_start TEXT, period_end TEXT, window_days INTEGER, total_miles REAL, total_gallons REAL, baseline_mpg REAL, method TEXT, vehicle_count INTEGER, measurement_count INTEGER, is_current INTEGER, computed_by TEXT, computed_at TEXT);
    CREATE TABLE fuel_target_policies (id INTEGER PRIMARY KEY, company_id INTEGER, group_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_by TEXT, created_at TEXT);
    CREATE TABLE fuel_target_overrides (id INTEGER PRIMARY KEY, company_id INTEGER, driver_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, reason TEXT, is_active INTEGER DEFAULT 1, created_by TEXT, created_at TEXT);
  `);

  // Seed data
  db.prepare('INSERT INTO companies (id, name) VALUES (1, "Test Fleet")').run();
  db.prepare('INSERT INTO company_users VALUES (1, 1, "Driver A", 1)').run();
  db.prepare('INSERT INTO company_users VALUES (2, 1, "Driver B", 1)').run();
  db.prepare('INSERT INTO fleet_vehicles VALUES (1, 1, "T001")').run();
  db.prepare('INSERT INTO fleet_vehicles VALUES (2, 1, "T002")').run();
  db.prepare('INSERT INTO fuel_groups VALUES (1, 1, "Sleepers", 0, 1)').run();
  db.prepare('INSERT INTO fuel_truck_group_map VALUES (1, 1, 1, 1)').run();
  db.prepare('INSERT INTO fuel_truck_group_map VALUES (2, 1, 2, 1)').run();
  db.prepare('INSERT INTO fuel_driver_group_map VALUES (1, 1, 1, 1)').run();
  db.prepare('INSERT INTO fuel_driver_group_map VALUES (2, 1, 2, 1)').run();
}

function testBaseline() {
  console.log('\n📊 Baseline Computation Tests:');

  // Add measurements (recent dates)
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Truck 1: 300 miles, 50 gallons = 6.0 MPG
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (1, 1, ?, 300, 50, 6.0)').run(today);
  // Truck 2: 400 miles, 57.14 gallons = 7.0 MPG
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (1, 2, ?, 400, 57.14, 7.0)').run(today);
  // More data yesterday
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (1, 1, ?, 250, 41.67, 6.0)').run(yesterday);
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (1, 2, ?, 350, 50, 7.0)').run(yesterday);

  // Method 1: miles_over_gallons
  const result = computeGroupBaseline(db, 1, 1, 90, 'test');
  assert(result.ok === true, 'Baseline computed successfully');
  assert(result.method === 'miles_over_gallons', 'Uses miles/gallons method when gallons available');
  // Total: 1300 miles / 198.81 gallons = ~6.54 MPG
  assert(result.baseline_mpg > 6.0 && result.baseline_mpg < 7.0, 'Baseline MPG is between 6-7 (got ' + result.baseline_mpg + ')');
  assert(result.snapshot.vehicle_count === 2, 'Includes 2 vehicles');
  assert(result.snapshot.measurement_count === 4, 'Uses 4 measurements');

  // Verify snapshot stored
  const snap = db.prepare('SELECT * FROM fuel_baseline_snapshots WHERE is_current = 1 AND group_id = 1').get();
  assert(snap !== undefined, 'Snapshot stored in DB');
  assert(snap.baseline_mpg === result.baseline_mpg, 'Snapshot MPG matches');

  // Verify group updated
  const group = db.prepare('SELECT baseline_mpg FROM fuel_groups WHERE id = 1').get();
  assert(group.baseline_mpg === result.baseline_mpg, 'Group baseline_mpg updated');

  // Test no data
  const empty = computeGroupBaseline(db, 1, 999, 90, 'test');
  assert(empty.ok === false, 'Returns error for empty group');

  // Test Method 2: weighted harmonic mean (no gallons)
  db.prepare('INSERT INTO fuel_groups VALUES (2, 1, "Daycabs", 0, 1)').run();
  db.prepare('INSERT INTO fleet_vehicles VALUES (3, 1, "T003")').run();
  db.prepare('INSERT INTO fuel_truck_group_map VALUES (3, 1, 3, 2)').run();
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, date, miles, gallons, mpg) VALUES (1, 3, ?, 500, 0, 5.5)').run(today);
  const result2 = computeGroupBaseline(db, 1, 2, 90, 'test');
  assert(result2.ok === true, 'Harmonic mean baseline computed');
  assert(result2.method === 'weighted_harmonic', 'Uses weighted harmonic when no gallons');
  assert(result2.baseline_mpg === 5.5, 'Harmonic MPG correct (got ' + result2.baseline_mpg + ')');

  // Recompute replaces old snapshot
  const result3 = computeGroupBaseline(db, 1, 1, 90, 'test2');
  const oldSnaps = db.prepare('SELECT COUNT(*) as c FROM fuel_baseline_snapshots WHERE group_id = 1 AND is_current = 1').get();
  assert(oldSnaps.c === 1, 'Only one current snapshot per group');
}

function testTargetPrecedence() {
  console.log('\n🎯 Target Precedence Tests:');

  const today = new Date().toISOString().slice(0, 10);

  // Test 1: No targets set
  const t1 = getEffectiveTarget(db, 1, 1, today);
  assert(t1.source === 'none', 'No target → source=none');
  assert(t1.target_mpg === null, 'No target → target_mpg=null');

  // Test 2: Group policy only
  db.prepare("INSERT INTO fuel_target_policies (company_id, group_id, target_mpg, kpi_bonus_usd, penalty_usd, effective_from, is_active) VALUES (1, 1, 6.5, 0.10, 0.05, '2020-01-01', 1)").run();
  const t2 = getEffectiveTarget(db, 1, 1, today);
  assert(t2.source === 'group_policy', 'Group policy → source=group_policy');
  assert(t2.target_mpg === 6.5, 'Group target = 6.5');
  assert(t2.kpi_bonus_usd === 0.10, 'Group bonus = $0.10');

  // Driver B also gets group policy (same group)
  const t2b = getEffectiveTarget(db, 1, 2, today);
  assert(t2b.source === 'group_policy', 'Driver B also gets group policy');
  assert(t2b.target_mpg === 6.5, 'Driver B target = 6.5');

  // Test 3: Driver override takes precedence
  db.prepare("INSERT INTO fuel_target_overrides (company_id, driver_id, target_mpg, kpi_bonus_usd, penalty_usd, effective_from, reason, is_active) VALUES (1, 1, 7.0, 0.15, 0, '2020-01-01', 'Experienced driver', 1)").run();
  const t3 = getEffectiveTarget(db, 1, 1, today);
  assert(t3.source === 'driver_override', 'Override → source=driver_override');
  assert(t3.target_mpg === 7.0, 'Override target = 7.0 (not group 6.5)');
  assert(t3.kpi_bonus_usd === 0.15, 'Override bonus = $0.15');
  assert(t3.reason === 'Experienced driver', 'Override reason preserved');

  // Driver B still gets group policy (no override)
  const t3b = getEffectiveTarget(db, 1, 2, today);
  assert(t3b.source === 'group_policy', 'Driver B still uses group policy');
  assert(t3b.target_mpg === 6.5, 'Driver B still target = 6.5');

  // Test 4: Expired override falls back to group
  db.prepare("UPDATE fuel_target_overrides SET effective_to = '2020-06-01' WHERE driver_id = 1").run();
  const t4 = getEffectiveTarget(db, 1, 1, today);
  assert(t4.source === 'group_policy', 'Expired override → falls back to group');
  assert(t4.target_mpg === 6.5, 'Fallback to group target = 6.5');

  // Test 5: Inactive override ignored
  db.prepare("UPDATE fuel_target_overrides SET effective_to = NULL, is_active = 0 WHERE driver_id = 1").run();
  const t5 = getEffectiveTarget(db, 1, 1, today);
  assert(t5.source === 'group_policy', 'Inactive override → group policy');

  // Test 6: Future policy not yet effective
  db.prepare("INSERT INTO fuel_target_policies (company_id, group_id, target_mpg, kpi_bonus_usd, effective_from, is_active) VALUES (1, 1, 8.0, 0.20, '2099-01-01', 1)").run();
  const t6 = getEffectiveTarget(db, 1, 1, today);
  assert(t6.target_mpg === 6.5, 'Future policy ignored (still 6.5, not 8.0)');

  // Test 7: Driver not in any group
  db.prepare('INSERT INTO company_users VALUES (3, 1, "Driver C", 1)').run();
  const t7 = getEffectiveTarget(db, 1, 3, today);
  assert(t7.source === 'none', 'Ungrouped driver → no target');
}

// Run tests
console.log('🧪 Fuel Baseline & Target Tests\n');
setup();
testBaseline();
testTargetPrecedence();
console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
