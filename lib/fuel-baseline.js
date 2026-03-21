// Fuel Baseline Computation Engine

/**
 * Compute baseline MPG for a group over a window period.
 *
 * Method 1 (preferred): total_miles / total_gallons
 *   - Used when gallons data exists
 *
 * Method 2 (fallback): weighted harmonic mean
 *   - total_miles / SUM(miles_i / mpg_i)
 *   - Used when only MPG per-record exists without raw gallons
 *
 * @param {Database} db
 * @param {number} companyId
 * @param {number} groupId
 * @param {number} windowDays
 * @param {string} computedBy - who triggered the computation
 * @returns {object} { ok, baseline_mpg, method, snapshot }
 */
function computeGroupBaseline(db, companyId, groupId, windowDays, computedBy) {
  const periodEnd = new Date().toISOString().slice(0, 10);
  const periodStart = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

  // Get vehicles in this group
  const vehicleIds = db.prepare('SELECT vehicle_id FROM fuel_truck_group_map WHERE group_id = ? AND company_id = ?').all(groupId, companyId).map(r => r.vehicle_id);

  if (vehicleIds.length === 0) {
    return { ok: false, error: 'No vehicles in group' };
  }

  const placeholders = vehicleIds.map(() => '?').join(',');

  // Get all daily measurements for these vehicles in the window
  const measurements = db.prepare(
    'SELECT * FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id IN (' + placeholders + ') AND date >= ? AND date <= ?'
  ).all(companyId, ...vehicleIds, periodStart, periodEnd);

  if (measurements.length === 0) {
    return { ok: false, error: 'No measurements in the ' + windowDays + '-day window' };
  }

  let totalMiles = 0;
  let totalGallons = 0;
  let hasGallons = false;
  let weightedDenom = 0; // for harmonic mean fallback

  for (const m of measurements) {
    totalMiles += (m.miles || 0);
    if (m.gallons && m.gallons > 0) {
      totalGallons += m.gallons;
      hasGallons = true;
    }
    if (m.mpg && m.mpg > 0 && m.miles > 0) {
      weightedDenom += m.miles / m.mpg;
    }
  }

  let baselineMpg = 0;
  let method = 'none';

  if (hasGallons && totalGallons > 0) {
    // Method 1: direct calculation
    baselineMpg = totalMiles / totalGallons;
    method = 'miles_over_gallons';
  } else if (weightedDenom > 0) {
    // Method 2: weighted harmonic mean
    baselineMpg = totalMiles / weightedDenom;
    method = 'weighted_harmonic';
  }

  baselineMpg = Math.round(baselineMpg * 100) / 100;

  // Mark old snapshots as not current
  db.prepare('UPDATE fuel_baseline_snapshots SET is_current = 0 WHERE company_id = ? AND group_id = ? AND scope = ?').run(companyId, groupId, 'group');

  // Store new snapshot
  const r = db.prepare('INSERT INTO fuel_baseline_snapshots (company_id, group_id, scope, period_start, period_end, window_days, total_miles, total_gallons, baseline_mpg, method, vehicle_count, measurement_count, is_current, computed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)').run(
    companyId, groupId, 'group', periodStart, periodEnd, windowDays,
    Math.round(totalMiles * 10) / 10, Math.round(totalGallons * 100) / 100,
    baselineMpg, method, vehicleIds.length, measurements.length, computedBy
  );

  // Also update the group's baseline_mpg field
  db.prepare('UPDATE fuel_groups SET baseline_mpg = ? WHERE id = ? AND company_id = ?').run(baselineMpg, groupId, companyId);

  return {
    ok: true,
    baseline_mpg: baselineMpg,
    method,
    snapshot: {
      id: r.lastInsertRowid,
      period_start: periodStart,
      period_end: periodEnd,
      total_miles: totalMiles,
      total_gallons: totalGallons,
      vehicle_count: vehicleIds.length,
      measurement_count: measurements.length
    }
  };
}

/**
 * Get the effective target for a driver on a given date.
 * Precedence: driver override > group policy > null
 */
function getEffectiveTarget(db, companyId, driverId, date) {
  // 1. Check driver override
  const override = db.prepare(
    "SELECT * FROM fuel_target_overrides WHERE company_id = ? AND driver_id = ? AND is_active = 1 AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1"
  ).get(companyId, driverId, date, date);

  if (override) {
    return {
      source: 'driver_override',
      target_mpg: override.target_mpg,
      kpi_bonus_usd: override.kpi_bonus_usd,
      penalty_usd: override.penalty_usd,
      override_id: override.id,
      reason: override.reason
    };
  }

  // 2. Check group policy via driver-group mapping
  const driverGroup = db.prepare('SELECT group_id FROM fuel_driver_group_map WHERE company_id = ? AND driver_id = ?').get(companyId, driverId);
  if (driverGroup) {
    const policy = db.prepare(
      "SELECT * FROM fuel_target_policies WHERE company_id = ? AND group_id = ? AND is_active = 1 AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1"
    ).get(companyId, driverGroup.group_id, date, date);

    if (policy) {
      return {
        source: 'group_policy',
        target_mpg: policy.target_mpg,
        kpi_bonus_usd: policy.kpi_bonus_usd,
        penalty_usd: policy.penalty_usd,
        policy_id: policy.id,
        group_id: driverGroup.group_id
      };
    }
  }

  // 3. No target
  return { source: 'none', target_mpg: null, kpi_bonus_usd: 0, penalty_usd: 0 };
}

/**
 * Compute all group baselines for a company
 */
function computeAllBaselines(db, companyId, windowDays, computedBy) {
  const groups = db.prepare('SELECT * FROM fuel_groups WHERE company_id = ? AND is_active = 1').all(companyId);
  const results = [];
  for (const g of groups) {
    try {
      const r = computeGroupBaseline(db, companyId, g.id, windowDays, computedBy);
      results.push({ group: g.name, ...r });
    } catch(e) {
      results.push({ group: g.name, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { computeGroupBaseline, computeAllBaselines, getEffectiveTarget };
