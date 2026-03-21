// Lightweight migration runner
// Reads numbered SQL files from /db/migrations/ and runs them in order
// Tracks which migrations have been applied in a `migrations` table

const fs = require('fs');
const path = require('path');

function runMigrations(db) {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    console.log('  📁 Created migrations directory');
    return;
  }

  // Get all .sql files sorted by name
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) return;

  // Get already applied migrations
  const applied = new Set();
  try {
    db.prepare('SELECT name FROM migrations').all().forEach(r => applied.add(r.name));
  } catch(e) {}

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8').trim();
    if (!sql) continue;

    try {
      // Run each statement separately
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      const transaction = db.transaction(() => {
        for (const stmt of statements) {
          db.exec(stmt);
        }
        db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
      });
      transaction();
      count++;
      console.log('  ✅ Migration applied:', file);
    } catch(e) {
      console.error('  ❌ Migration failed:', file, '-', e.message);
      // Don't stop — continue with other migrations
    }
  }

  if (count > 0) console.log(`  📦 Applied ${count} migration(s)`);
}

module.exports = { runMigrations };
