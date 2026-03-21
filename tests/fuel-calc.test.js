// Unit tests for fuel payout calculation engine
// Run: node tests/fuel-calc.test.js

const Database = require('better-sqlite3');
const { calculatePeriod } = require('../lib/fuel-calc');

let db, passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.log('  ❌ FAIL: ' + msg); }
}

function setup() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE company_users (id INTEGER PRIMARY KEY, company_id INTEGER, name TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE fleet_vehicles (id INTEGER PRIMARY KEY, company_id INTEGER, unit_number TEXT, driver_id INTEGER);
    CREATE TABLE fuel_groups (id INTEGER PRIMARY KEY, company_id INTEGER, name TEXT, baseline_mpg REAL DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE fuel_config (id INTEGER PRIMARY KEY, company_id INTEGER UNIQUE, enabled INTEGER, billing_mode TEXT, split_driver_pct REAL, split_company_pct REAL, baseline_window_days INTEGER, baseline_mpg REAL, fuel_price_source TEXT, fuel_price_manual REAL, min_miles_qualify INTEGER, ceiling_bonus_per_gallon REAL, floor_penalty_per_gallon REAL, pay_frequency TEXT, platform_pct REAL, notes TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE fuel_truck_group_map (id INTEGER PRIMARY KEY, company_id INTEGER, vehicle_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_driver_group_map (id INTEGER PRIMARY KEY, company_id INTEGER, driver_id INTEGER, group_id INTEGER);
    CREATE TABLE fuel_measurements_daily (id INTEGER PRIMARY KEY, company_id INTEGER, integration_id INTEGER, vehicle_id INTEGER, driver_id INTEGER, date TEXT, miles REAL, gallons REAL, mpg REAL, idle_hours REAL, idle_gallons REAL, odometer_start REAL, odometer_end REAL, provider TEXT, provider_vehicle_id TEXT, raw_data TEXT, created_at TEXT);
    CREATE TABLE fuel_baseline_snapshots (id INTEGER PRIMARY KEY, company_id INTEGER, group_id INTEGER, driver_id INTEGER, scope TEXT, period_start TEXT, period_end TEXT, window_days INTEGER, total_miles REAL, total_gallons REAL, baseline_mpg REAL, method TEXT, vehicle_count INTEGER, measurement_count INTEGER, is_current INTEGER, computed_by TEXT, computed_at TEXT);
    CREATE TABLE fuel_target_policies (id INTEGER PRIMARY KEY, company_id INTEGER, group_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, is_active INTEGER DEFAULT 1, notes TEXT, created_by TEXT, created_at TEXT);
    CREATE TABLE fuel_target_overrides (id INTEGER PRIMARY KEY, company_id INTEGER, driver_id INTEGER, target_mpg REAL, kpi_bonus_usd REAL DEFAULT 0, penalty_usd REAL DEFAULT 0, effective_from TEXT, effective_to TEXT, reason TEXT, is_active INTEGER DEFAULT 1, created_by TEXT, created_at TEXT);
    CREATE TABLE fuel_payout_periods (id INTEGER PRIMARY KEY, company_id INTEGER, period_start TEXT, period_end TEXT, status TEXT DEFAULT 'open', config_snapshot TEXT, total_drivers INTEGER, total_eligible INTEGER, total_driver_payout REAL, total_company_share REAL, total_platform_fee REAL, total_kpi_bonus REAL, total_savings REAL, calculated_at TEXT, calculated_by TEXT, approved_at TEXT, approved_by TEXT, closed_at TEXT, closed_by TEXT, notes TEXT, created_at TEXT);
    CREATE TABLE fuel_payout_ledgers (id INTEGER PRIMARY KEY, company_id INTEGER, period_id INTEGER, driver_id INTEGER, driver_name TEXT, group_id INTEGER, group_name TEXT, status TEXT, total_miles REAL, total_gallons REAL, actual_mpg REAL, mpg_method TEXT, baseline_mpg REAL, target_mpg REAL, target_source TEXT, kpi_bonus_usd REAL, kpi_earned INTEGER, savings_gallons REAL, fuel_price REAL, savings_usd REAL, driver_share_pct REAL, company_share_pct REAL, platform_share_pct REAL, driver_share_usd REAL, company_share_usd REAL, platform_fee_usd REAL, driver_payout REAL, explanation_json TEXT, created_at TEXT);
    CREATE TABLE fleet_fuel (id INTEGER PRIMARY KEY, company_id INTEGER, gallons REAL, total_cost REAL);
  `);

  // Seed: company, drivers, vehicles, groups
  db.prepare('INSERT INTO companies VALUES (1, "Test Fleet")').run();
  db.prepare('INSERT INTO company_users VALUES (1, 1, "Alice", 1)').run();
  db.prepare('INSERT INTO company_users VALUES (2, 1, "Bob", 1)').run();
  db.prepare('INSERT INTO company_users VALUES (3, 1, "Charlie", 1)').run();
  db.prepare('INSERT INTO fleet_vehicles VALUES (1, 1, "T001", 1)').run();
  db.prepare('INSERT INTO fleet_vehicles VALUES (2, 1, "T002", 2)').run();
  db.prepare('INSERT INTO fuel_groups VALUES (1, 1, "Sleepers", 6.0, 1)').run();
  db.prepare('INSERT INTO fuel_driver_group_map VALUES (1, 1, 1, 1)').run();
  db.prepare('INSERT INTO fuel_driver_group_map VALUES (2, 1, 2, 1)').run();
  db.prepare('INSERT INTO fuel_truck_group_map VALUES (1, 1, 1, 1)').run();
  db.prepare('INSERT INTO fuel_truck_group_map VALUES (2, 1, 2, 1)').run();

  // Config: 50/50 split, $4.00/gal, 500 mile minimum
  db.prepare("INSERT INTO fuel_config (company_id, enabled, billing_mode, split_driver_pct, split_company_pct, baseline_window_days, baseline_mpg, fuel_price_source, fuel_price_manual, min_miles_qualify, ceiling_bonus_per_gallon, floor_penalty_per_gallon, pay_frequency) VALUES (1, 1, 'per-truck', 50, 50, 90, 6.0, 'manual', 4.00, 500, 0.50, 0, 'monthly')").run();

  // Baseline: 6.0 MPG for the group
  db.prepare("INSERT INTO fuel_baseline_snapshots (company_id, group_id, scope, period_start, period_end, window_days, total_miles, total_gallons, baseline_mpg, method, vehicle_count, measurement_count, is_current) VALUES (1, 1, 'group', '2025-01-01', '2025-03-31', 90, 10000, 1666, 6.0, 'miles_over_gallons', 2, 60, 1)").run();

  // Target: 6.5 MPG with $0.10/gal KPI bonus
  db.prepare("INSERT INTO fuel_target_policies (company_id, group_id, target_mpg, kpi_bonus_usd, effective_from, is_active) VALUES (1, 1, 6.5, 0.10, '2025-01-01', 1)").run();

  // Period: March 2025
  db.prepare("INSERT INTO fuel_payout_periods (company_id, period_start, period_end, status) VALUES (1, '2025-03-01', '2025-03-31', 'open')").run();
}

function testEligibleDriver() {
  console.log('\n🧮 Test: Eligible driver with savings');
  // Alice: 3000 miles, 428.57 gallons = 7.0 MPG (above 6.0 baseline and 6.5 target)
  for (let d = 1; d <= 30; d++) {
    const date = '2025-03-' + String(d).padStart(2, '0');
    db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, driver_id, date, miles, gallons, mpg, provider) VALUES (1, 1, 1, ?, 100, 14.286, 7.0, "test")').run(date);
  }

  const result = calculatePeriod(db, 1, 1);
  const alice = result.ledgers.find(l => l.driver_name === 'Alice');

  assert(alice !== undefined, 'Alice found in ledgers');
  assert(alice.status === 'eligible', 'Alice is eligible (3000 mi > 500 min)');
  assert(alice.actual_mpg === 7.0, 'Actual MPG = 7.0 (got ' + alice.actual_mpg + ')');
  assert(alice.baseline_mpg === 6.0, 'Baseline = 6.0');
  assert(alice.target_mpg === 6.5, 'Target = 6.5');
  assert(alice.kpi_earned === true, 'KPI earned (7.0 >= 6.5)');

  // Savings: (3000/6.0) - (3000/7.0) = 500 - 428.57 = 71.43 gal
  // Savings USD: 71.43 * $4.00 = $285.71
  assert(Math.abs(alice.savings_gallons - 71.43) < 0.5, 'Savings ~71.4 gallons (got ' + alice.savings_gallons + ')');
  assert(Math.abs(alice.savings_usd - 285.71) < 2, 'Savings ~$285.71 (got $' + alice.savings_usd + ')');

  // Split 50/50
  assert(Math.abs(alice.driver_share_usd - 142.86) < 1, 'Driver share ~$142.86 (got $' + alice.driver_share_usd + ')');
  assert(Math.abs(alice.company_share_usd - 142.86) < 1, 'Company share ~$142.86 (got $' + alice.company_share_usd + ')');

  // KPI bonus: 71.43 gal * $0.10 = $7.14
  assert(Math.abs(alice.kpi_bonus_usd - 7.14) < 0.5, 'KPI bonus ~$7.14 (got $' + alice.kpi_bonus_usd + ')');

  // Total payout = KPI + driver share
  assert(alice.driver_payout > 149, 'Driver payout > $149 (got $' + alice.driver_payout + ')');

  // Period totals
  assert(result.totals.eligible >= 1, 'At least 1 eligible driver');
  assert(result.totals.driverPayout > 0, 'Total driver payout > 0');
}

function testIneligibleDriver() {
  console.log('\n🚫 Test: Ineligible driver (low miles)');
  // Charlie: no group, no measurements, or below minimum
  db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, driver_id, date, miles, gallons, mpg, provider) VALUES (1, NULL, 3, "2025-03-15", 100, 15, 6.67, "test")').run();
  db.prepare('INSERT INTO fuel_driver_group_map VALUES (3, 1, 3, 1)').run();

  // Re-calculate
  const result = calculatePeriod(db, 1, 1);
  const charlie = result.ledgers.find(l => l.driver_name === 'Charlie');

  assert(charlie !== undefined, 'Charlie found in ledgers');
  assert(charlie.status === 'ineligible', 'Charlie ineligible (100 mi < 500 min)');
  assert(charlie.driver_payout === 0, 'Ineligible payout = $0');
}

function testNoSavings() {
  console.log('\n📉 Test: Eligible but no savings (below baseline)');
  // Bob: 2000 miles, 400 gallons = 5.0 MPG (below 6.0 baseline)
  for (let d = 1; d <= 20; d++) {
    const date = '2025-03-' + String(d).padStart(2, '0');
    db.prepare('INSERT INTO fuel_measurements_daily (company_id, vehicle_id, driver_id, date, miles, gallons, mpg, provider) VALUES (1, 2, 2, ?, 100, 20, 5.0, "test")').run(date);
  }

  const result = calculatePeriod(db, 1, 1);
  const bob = result.ledgers.find(l => l.driver_name === 'Bob');

  assert(bob !== undefined, 'Bob found');
  assert(bob.status === 'eligible', 'Bob eligible (2000 mi > 500)');
  assert(bob.actual_mpg === 5.0, 'Bob MPG = 5.0');
  assert(bob.savings_usd === 0, 'No savings (below baseline)');
  assert(bob.kpi_earned === false, 'KPI not earned (5.0 < 6.5)');
  assert(bob.driver_payout === 0, 'No payout when no savings and no KPI');
}

function testImmutability() {
  console.log('\n🔒 Test: Immutability after approval');
  // Approve period
  db.prepare("UPDATE fuel_payout_periods SET status = 'approved' WHERE id = 1").run();

  let threw = false;
  try {
    calculatePeriod(db, 1, 1);
  } catch(e) {
    threw = true;
    assert(e.message.includes('approved'), 'Error mentions approved status');
  }
  assert(threw, 'Recalculation throws on approved period');

  // Verify ledger rows unchanged
  const ledgers = db.prepare('SELECT * FROM fuel_payout_ledgers WHERE period_id = 1').all();
  assert(ledgers.length > 0, 'Ledger rows preserved after failed recalc');
}

function testExplanationJson() {
  console.log('\n📋 Test: Explanation transparency');
  const ledger = db.prepare('SELECT * FROM fuel_payout_ledgers WHERE period_id = 1 AND driver_name = "Alice"').get();
  assert(ledger.explanation_json !== null, 'Explanation JSON stored');
  const exp = JSON.parse(ledger.explanation_json);
  assert(Array.isArray(exp), 'Explanation is an array of strings');
  assert(exp.length >= 5, 'Has multiple explanation lines (got ' + exp.length + ')');
  assert(exp.some(e => e.includes('DRIVER PAYOUT')), 'Includes final payout line');
}

// Run
console.log('🧪 Fuel Payout Calculation Tests\n');
setup();
testEligibleDriver();
testIneligibleDriver();
testNoSavings();
testImmutability();
testExplanationJson();
console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
