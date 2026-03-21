// Fuel Ceiling Switch Engine
// Checks if a group has exceeded baseline for N consecutive periods
// and triggers billing mode switch from 'performance' to 'subscription'

const CONSECUTIVE_THRESHOLD = 3; // periods needed
const MPG_DELTA_THRESHOLD = 0.3; // MPG above baseline needed

/**
 * Check ceiling conditions after a period calculation.
 * @param {Database} db
 * @param {number} companyId
 * @param {number} periodId
 * @returns {Array} list of switch events
 */
function checkCeilingSwitch(db, companyId, periodId) {
  const config = db.prepare('SELECT * FROM fuel_config WHERE company_id = ?').get(companyId);
  if (!config || config.billing_mode === 'subscription') return []; // Already subscription

  const groups = db.prepare('SELECT * FROM fuel_groups WHERE company_id = ? AND is_active = 1').all(companyId);
  const events = [];

  for (const group of groups) {
    // Get last N period ledgers for this group (aggregated)
    const recentPeriods = db.prepare(`
      SELECT p.id, p.period_start, p.period_end,
        AVG(l.actual_mpg) as avg_mpg,
        AVG(l.baseline_mpg) as avg_baseline
      FROM fuel_payout_periods p
      JOIN fuel_payout_ledgers l ON l.period_id = p.id
      WHERE p.company_id = ? AND l.group_id = ? AND l.status = 'eligible'
        AND p.status IN ('calculated','approved','closed')
      GROUP BY p.id
      ORDER BY p.period_start DESC
      LIMIT ?
    `).all(companyId, group.id, CONSECUTIVE_THRESHOLD);

    if (recentPeriods.length < CONSECUTIVE_THRESHOLD) continue;

    // Check if ALL recent periods have MPG above baseline + delta
    const allAbove = recentPeriods.every(p =>
      p.avg_mpg && p.avg_baseline && (p.avg_mpg >= p.avg_baseline + MPG_DELTA_THRESHOLD)
    );

    if (allAbove) {
      const avgDelta = recentPeriods.reduce((s, p) => s + (p.avg_mpg - p.avg_baseline), 0) / recentPeriods.length;

      // Switch billing mode
      try {
        db.prepare("UPDATE fuel_config SET billing_mode = 'subscription' WHERE company_id = ?").run(companyId);
        db.prepare('INSERT INTO fuel_ceiling_log (company_id, group_id, consecutive_periods, avg_mpg_delta, old_billing_mode, new_billing_mode) VALUES (?,?,?,?,?,?)').run(
          companyId, group.id, CONSECUTIVE_THRESHOLD, Math.round(avgDelta * 100) / 100, config.billing_mode, 'subscription'
        );
        db.prepare('INSERT INTO fuel_audit_log (company_id, action, details, created_by) VALUES (?,?,?,?)').run(
          companyId, 'ceiling_switch',
          'Group "' + group.name + '": exceeded baseline by ≥' + MPG_DELTA_THRESHOLD + ' MPG for ' + CONSECUTIVE_THRESHOLD + ' consecutive periods (avg delta: +' + avgDelta.toFixed(2) + '). Billing switched to subscription.',
          'system'
        );
        events.push({
          group: group.name,
          consecutivePeriods: CONSECUTIVE_THRESHOLD,
          avgDelta: Math.round(avgDelta * 100) / 100,
          switched: true
        });
        console.log('  🔄 Ceiling switch: ' + group.name + ' → subscription mode');
      } catch(e) {
        console.error('Ceiling switch error:', e.message);
      }

      break; // One switch per company per check
    }
  }

  return events;
}

module.exports = { checkCeilingSwitch, CONSECUTIVE_THRESHOLD, MPG_DELTA_THRESHOLD };
