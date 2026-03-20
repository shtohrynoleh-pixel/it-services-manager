// Gamification XP System
const XP_ACTIONS = {
  'add_user':       { xp: 10, label: 'Added team member' },
  'add_server':     { xp: 15, label: 'Added server' },
  'add_subscription': { xp: 10, label: 'Added subscription' },
  'add_asset':      { xp: 10, label: 'Added digital asset' },
  'add_inventory':  { xp: 10, label: 'Added equipment' },
  'create_task':    { xp: 5,  label: 'Created task' },
  'complete_task':  { xp: 20, label: 'Completed task' },
  'create_project': { xp: 25, label: 'Created project' },
  'create_sop':     { xp: 30, label: 'Created SOP' },
  'create_policy':  { xp: 30, label: 'Created security policy' },
  'create_flow':    { xp: 25, label: 'Created process flow' },
  'add_flow_node':  { xp: 5,  label: 'Added flow node' },
  'add_password':   { xp: 10, label: 'Added to vault' },
  'upload_file':    { xp: 5,  label: 'Uploaded file' },
  'ack_sop':        { xp: 15, label: 'Acknowledged SOP' },
  'ack_policy':     { xp: 15, label: 'Acknowledged policy' },
  'send_message':   { xp: 1,  label: 'Chat message' },
  'create_channel': { xp: 10, label: 'Created channel' },
  'add_monitor':    { xp: 15, label: 'Added monitor' },
  'create_invoice': { xp: 10, label: 'Created invoice' },
  'add_contact':    { xp: 5,  label: 'Added contact' },
  'add_location':   { xp: 10, label: 'Added location' },
  'csv_import':     { xp: 20, label: 'Imported CSV data' },
  'grant_portal':   { xp: 15, label: 'Granted portal access' },
  'daily_login':    { xp: 5,  label: 'Daily login' },
};

const RANKS = [
  { min: 0,    name: 'Rookie',      icon: '🌱', color: '#94a3b8' },
  { min: 50,   name: 'Technician',  icon: '🔧', color: '#0891b2' },
  { min: 150,  name: 'Specialist',  icon: '⚡', color: '#8b5cf6' },
  { min: 300,  name: 'Expert',      icon: '🎯', color: '#f59e0b' },
  { min: 500,  name: 'Master',      icon: '🏆', color: '#10b981' },
  { min: 1000, name: 'Legend',       icon: '👑', color: '#ef4444' },
  { min: 2000, name: 'Grandmaster', icon: '💎', color: '#6366f1' },
];

function getRank(totalXp) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (totalXp >= r.min) rank = r;
  }
  const nextRank = RANKS[RANKS.indexOf(rank) + 1];
  const progress = nextRank ? Math.round((totalXp - rank.min) / (nextRank.min - rank.min) * 100) : 100;
  return { ...rank, totalXp, progress, nextRank };
}

function awardXP(db, username, action, customDesc) {
  const cfg = XP_ACTIONS[action];
  if (!cfg) return null;
  try {
    db.prepare('INSERT INTO user_xp (username, action, xp, description) VALUES (?,?,?,?)').run(
      username, action, cfg.xp, customDesc || cfg.label
    );
    return cfg.xp;
  } catch(e) { return null; }
}

function getUserXP(db, username) {
  try {
    const row = db.prepare('SELECT SUM(xp) as total FROM user_xp WHERE username = ?').get(username);
    return (row && row.total) || 0;
  } catch(e) { return 0; }
}

function getLeaderboard(db, limit) {
  try {
    return db.prepare('SELECT username, SUM(xp) as total, COUNT(*) as actions FROM user_xp GROUP BY username ORDER BY total DESC LIMIT ?').all(limit || 20);
  } catch(e) { return []; }
}

function getRecentXP(db, username, limit) {
  try {
    return db.prepare('SELECT * FROM user_xp WHERE username = ? ORDER BY created_at DESC LIMIT ?').all(username, limit || 10);
  } catch(e) { return []; }
}

// Check daily login bonus (only once per day)
function checkDailyLogin(db, username) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.prepare("SELECT id FROM user_xp WHERE username = ? AND action = 'daily_login' AND created_at >= ?").get(username, today);
    if (!existing) {
      awardXP(db, username, 'daily_login');
      return true;
    }
  } catch(e) {}
  return false;
}

module.exports = { XP_ACTIONS, RANKS, getRank, awardXP, getUserXP, getLeaderboard, getRecentXP, checkDailyLogin };
