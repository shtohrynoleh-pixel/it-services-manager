// Fuel Incentive Period Calculation Engine
// Finance-grade: deterministic, auditable, immutable after approval

const { getEffectiveTarget } = require('./fuel-baseline');

/**
 * Calculate payouts for all drivers in a period.
 * Returns array of ledger rows ready to insert.
 */
function calculatePeriod(db, companyId, periodId) {
  const period = db.prepare('SELECT * FROM fuel_payout_periods WHERE id = ? AND company_id = ?').get(periodId, companyId);
  if (!period) throw new Error('Period not found');
  if (period.status === 'approved' || period.status === 'closed') throw new Error('Period is ' + period.status + ' — cannot recalculate');

  const config = db.prepare('SELECT * FROM fuel_config WHERE company_id = ?').get(companyId);
  if (!config) throw new Error('Fuel config not found');

  // Snapshot config into period for immutability
  const configSnapshot = {
    billing_mode: config.billing_mode,
    split_driver_pct: config.split_driver_pct || 50,
    split_company_pct: config.split_company_pct || 50,
    platform_pct: config.billing_mode === 'performance' ? (config.platform_pct || 0) : 0,
    fuel_price: config.fuel_price_manual || 0,
    fuel_price_source: config.fuel_price_source,
    min_miles: config.min_miles_qualify || 500,
    ceiling_bonus_per_gallon: config.ceiling_bonus_per_gallon || 0.50,
    floor_penalty_per_gallon: config.floor_penalty_per_gallon || 0
  };

  // If fuel price from company average, compute it
  if (config.fuel_price_source === 'company-average') {
    const avg = db.prepare('SELECT AVG(total_cost / gallons) as avg_price FROM fleet_fuel WHERE company_id = ? AND gallons > 0').get(companyId);
    if (avg && avg.avg_price) configSnapshot.fuel_price = Math.round(avg.avg_price * 1000) / 1000;
  }

  // Get all drivers with measurements in this period
  const driverRows = db.prepare(
    'SELECT DISTINCT driver_id FROM fuel_measurements_daily WHERE company_id = ? AND date >= ? AND date <= ? AND driver_id IS NOT NULL ' +
    'UNION SELECT DISTINCT m.driver_id FROM fuel_driver_group_map m WHERE m.company_id = ?'
  ).all(companyId, period.period_start, period.period_end, companyId);

  // Also get drivers assigned to vehicles that have measurements
  const vehicleDrivers = db.prepare(
    "SELECT DISTINCT fv.driver_id FROM fleet_vehicles fv WHERE fv.company_id = ? AND fv.driver_id IS NOT NULL AND fv.id IN (SELECT vehicle_id FROM fuel_measurements_daily WHERE company_id = ? AND date >= ? AND date <= ?)"
  ).all(companyId, companyId, period.period_start, period.period_end);

  const allDriverIds = new Set();
  driverRows.forEach(r => { if (r.driver_id) allDriverIds.add(r.driver_id); });
  vehicleDrivers.forEach(r => { if (r.driver_id) allDriverIds.add(r.driver_id); });

  // Clear existing ledger rows for this period (re-calc)
  db.prepare('DELETE FROM fuel_payout_ledgers WHERE period_id = ? AND company_id = ?').run(periodId, companyId);

  const ledgers = [];
  let totals = { drivers: 0, eligible: 0, driverPayout: 0, companyShare: 0, platformFee: 0, kpiBonus: 0, savings: 0 };

  for (const driverId of allDriverIds) {
    const driver = db.prepare('SELECT * FROM company_users WHERE id = ?').get(driverId);
    if (!driver) continue;

    const ledger = calculateDriverPayout(db, companyId, driverId, period, configSnapshot);
    ledger.driver_name = driver.name;
    ledger.period_id = periodId;
    ledger.company_id = companyId;

    // Insert ledger row
    db.prepare(
      'INSERT INTO fuel_payout_ledgers (company_id, period_id, driver_id, driver_name, group_id, group_name, status, total_miles, total_gallons, actual_mpg, mpg_method, baseline_mpg, target_mpg, target_source, kpi_bonus_usd, kpi_earned, savings_gallons, fuel_price, savings_usd, driver_share_pct, company_share_pct, platform_share_pct, driver_share_usd, company_share_usd, platform_fee_usd, driver_payout, explanation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      companyId, periodId, driverId, driver.name, ledger.group_id, ledger.group_name, ledger.status,
      ledger.total_miles, ledger.total_gallons, ledger.actual_mpg, ledger.mpg_method,
      ledger.baseline_mpg, ledger.target_mpg, ledger.target_source,
      ledger.kpi_bonus_usd, ledger.kpi_earned ? 1 : 0, ledger.savings_gallons,
      ledger.fuel_price, ledger.savings_usd, ledger.driver_share_pct, ledger.company_share_pct,
      ledger.platform_share_pct, ledger.driver_share_usd, ledger.company_share_usd,
      ledger.platform_fee_usd, ledger.driver_payout, JSON.stringify(ledger.explanation)
    );

    ledgers.push(ledger);
    totals.drivers++;
    if (ledger.status === 'eligible') totals.eligible++;
    totals.driverPayout += ledger.driver_payout;
    totals.companyShare += ledger.company_share_usd;
    totals.platformFee += ledger.platform_fee_usd;
    totals.kpiBonus += (ledger.kpi_earned ? ledger.kpi_bonus_usd : 0);
    totals.savings += ledger.savings_usd;
  }

  // Update period with totals + config snapshot
  db.prepare(
    "UPDATE fuel_payout_periods SET config_snapshot = ?, total_drivers = ?, total_eligible = ?, total_driver_payout = ?, total_company_share = ?, total_platform_fee = ?, total_kpi_bonus = ?, total_savings = ?, calculated_at = datetime('now'), calculated_by = ?, status = 'calculated' WHERE id = ?"
  ).run(
    JSON.stringify(configSnapshot), totals.drivers, totals.eligible,
    r2(totals.driverPayout), r2(totals.companyShare), r2(totals.platformFee),
    r2(totals.kpiBonus), r2(totals.savings), 'system', periodId
  );

  return { ledgers, totals };
}

/**
 * Calculate payout for a single driver in a period
 */
function calculateDriverPayout(db, companyId, driverId, period, config) {
  const explanation = [];

  // Get driver's group
  const driverGroup = db.prepare('SELECT g.* FROM fuel_driver_group_map m JOIN fuel_groups g ON m.group_id = g.id WHERE m.company_id = ? AND m.driver_id = ?').get(companyId, driverId);
  const groupId = driverGroup ? driverGroup.id : null;
  const groupName = driverGroup ? driverGroup.name : null;

  // Aggregate measurements
  // First try driver_id direct, then via vehicle assignments
  let measurements = db.prepare(
    'SELECT * FROM fuel_measurements_daily WHERE company_id = ? AND driver_id = ? AND date >= ? AND date <= ?'
  ).all(companyId, driverId, period.period_start, period.period_end);

  // If no direct driver measurements, check via vehicle
  if (measurements.length === 0) {
    const vehicles = db.prepare('SELECT id FROM fleet_vehicles WHERE company_id = ? AND driver_id = ?').all(companyId, driverId);
    if (vehicles.length > 0) {
      const vids = vehicles.map(v => v.id);
      measurements = db.prepare(
        'SELECT * FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id IN (' + vids.map(() => '?').join(',') + ') AND date >= ? AND date <= ?'
      ).all(companyId, ...vids, period.period_start, period.period_end);
    }
  }

  let totalMiles = 0, totalGallons = 0, weightedDenom = 0, hasGallons = false;
  for (const m of measurements) {
    totalMiles += (m.miles || 0);
    if (m.gallons > 0) { totalGallons += m.gallons; hasGallons = true; }
    if (m.mpg > 0 && m.miles > 0) { weightedDenom += m.miles / m.mpg; }
  }

  // Compute actual MPG
  let actualMpg = 0, mpgMethod = 'none';
  if (hasGallons && totalGallons > 0) {
    actualMpg = totalMiles / totalGallons;
    mpgMethod = 'miles_over_gallons';
  } else if (weightedDenom > 0) {
    actualMpg = totalMiles / weightedDenom;
    mpgMethod = 'weighted_harmonic';
  }
  actualMpg = r2(actualMpg);

  explanation.push('Period: ' + period.period_start + ' to ' + period.period_end);
  explanation.push('Miles: ' + r2(totalMiles) + ', Gallons: ' + r2(totalGallons) + ', MPG: ' + actualMpg + ' (' + mpgMethod + ')');

  // Eligibility check
  if (totalMiles < config.min_miles) {
    explanation.push('INELIGIBLE: ' + r2(totalMiles) + ' miles < ' + config.min_miles + ' minimum');
    return {
      group_id: groupId, group_name: groupName, status: 'ineligible',
      total_miles: r2(totalMiles), total_gallons: r2(totalGallons), actual_mpg: actualMpg, mpg_method: mpgMethod,
      baseline_mpg: 0, target_mpg: null, target_source: 'none',
      kpi_bonus_usd: 0, kpi_earned: false, savings_gallons: 0, fuel_price: config.fuel_price,
      savings_usd: 0, driver_share_pct: 0, company_share_pct: 0, platform_share_pct: 0,
      driver_share_usd: 0, company_share_usd: 0, platform_fee_usd: 0, driver_payout: 0,
      explanation
    };
  }

  // Get baseline
  const baseline = groupId ? db.prepare('SELECT baseline_mpg FROM fuel_baseline_snapshots WHERE company_id = ? AND group_id = ? AND is_current = 1').get(companyId, groupId) : null;
  const baselineMpg = baseline ? baseline.baseline_mpg : (config.baseline_mpg || 0);
  explanation.push('Baseline MPG: ' + baselineMpg + (groupId ? ' (group: ' + groupName + ')' : ' (default)'));

  // Get target (with precedence)
  const midDate = period.period_start; // Use period start for target lookup
  const target = getEffectiveTarget(db, companyId, driverId, midDate);
  const targetMpg = target.target_mpg;
  const kpiBonusRate = target.kpi_bonus_usd || 0;
  explanation.push('Target: ' + (targetMpg || 'none') + ' MPG (source: ' + target.source + '), KPI bonus: $' + kpiBonusRate + '/gal');

  // KPI bonus: earned if actual >= target
  let kpiEarned = false;
  let kpiBonusUsd = 0;
  if (targetMpg && actualMpg >= targetMpg) {
    kpiEarned = true;
    // KPI bonus applied to gallons saved vs baseline
    if (baselineMpg > 0 && actualMpg > baselineMpg) {
      const galSaved = (totalMiles / baselineMpg) - (totalMiles / actualMpg);
      kpiBonusUsd = r2(Math.max(0, galSaved) * kpiBonusRate);
    }
    explanation.push('KPI EARNED: actual ' + actualMpg + ' >= target ' + targetMpg + ', bonus: $' + kpiBonusUsd);
  } else if (targetMpg) {
    explanation.push('KPI NOT EARNED: actual ' + actualMpg + ' < target ' + targetMpg);
  }

  // Savings calculation
  let savingsGallons = 0, savingsUsd = 0;
  if (baselineMpg > 0 && actualMpg > baselineMpg) {
    savingsGallons = (totalMiles / baselineMpg) - (totalMiles / actualMpg);
    savingsGallons = Math.max(0, savingsGallons);
    savingsUsd = r2(savingsGallons * config.fuel_price);
    explanation.push('Savings: ' + r2(savingsGallons) + ' gal × $' + config.fuel_price + '/gal = $' + savingsUsd);
  } else {
    explanation.push('No savings: actual ' + actualMpg + ' <= baseline ' + baselineMpg);
  }

  // Apply ceiling
  if (config.ceiling_bonus_per_gallon > 0 && savingsGallons > 0) {
    const ceiling = r2(savingsGallons * config.ceiling_bonus_per_gallon);
    if (savingsUsd > ceiling) {
      explanation.push('Ceiling applied: $' + savingsUsd + ' capped to $' + ceiling);
      savingsUsd = ceiling;
    }
  }

  // Split
  const driverSharePct = config.split_driver_pct;
  const companySharePct = config.split_company_pct;
  const platformPct = config.platform_pct || 0;
  const driverShareUsd = r2(savingsUsd * driverSharePct / 100);
  const companyShareUsd = r2(savingsUsd * companySharePct / 100);
  const platformFeeUsd = r2(savingsUsd * platformPct / 100);
  explanation.push('Split: driver ' + driverSharePct + '% = $' + driverShareUsd + ', company ' + companySharePct + '% = $' + companyShareUsd + (platformPct > 0 ? ', platform ' + platformPct + '% = $' + platformFeeUsd : ''));

  // Total driver payout
  const driverPayout = r2(kpiBonusUsd + driverShareUsd);
  explanation.push('DRIVER PAYOUT: $' + kpiBonusUsd + ' (KPI) + $' + driverShareUsd + ' (savings share) = $' + driverPayout);

  return {
    group_id: groupId, group_name: groupName, status: 'eligible',
    total_miles: r2(totalMiles), total_gallons: r2(totalGallons), actual_mpg: actualMpg, mpg_method: mpgMethod,
    baseline_mpg: baselineMpg, target_mpg: targetMpg, target_source: target.source,
    kpi_bonus_usd: kpiBonusUsd, kpi_earned: kpiEarned, savings_gallons: r2(savingsGallons), fuel_price: config.fuel_price,
    savings_usd: savingsUsd, driver_share_pct: driverSharePct, company_share_pct: companySharePct,
    platform_share_pct: platformPct, driver_share_usd: driverShareUsd, company_share_usd: companyShareUsd,
    platform_fee_usd: platformFeeUsd, driver_payout: driverPayout, explanation
  };
}

function r2(n) { return Math.round((n || 0) * 100) / 100; }

module.exports = { calculatePeriod, calculateDriverPayout };
