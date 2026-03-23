// Database adapter — supports SQLite (default) and PostgreSQL
// Set DATABASE_URL env var to use PostgreSQL, otherwise uses SQLite
//
// Provides the same synchronous-style API as better-sqlite3:
//   db.prepare(sql).all(...params)
//   db.prepare(sql).get(...params)
//   db.prepare(sql).run(...params)
//   db.exec(sql)
//   db.transaction(fn)
//   db.pragma(str)

const path = require('path');

function createAdapter() {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    return createPostgresAdapter(dbUrl);
  } else {
    return createSqliteAdapter();
  }
}

// ==================== SQLITE ====================
function createSqliteAdapter() {
  const Database = require('better-sqlite3');
  const DB_PATH = path.join(__dirname, 'app.db');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  console.log('  📦 Database: SQLite (' + DB_PATH + ')');
  return db;
}

// ==================== POSTGRESQL ====================
function createPostgresAdapter(connectionString) {
  let pg;
  try { pg = require('pg'); } catch(e) {
    console.error('  ❌ pg package not installed. Run: npm install pg');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  // Track connection
  pool.on('error', (err) => console.error('  ❌ PG pool error:', err.message));

  // Synchronous wrapper using deasync pattern
  // Since the app uses sync API everywhere, we need a sync bridge
  let deasync;
  try { deasync = require('deasync'); } catch(e) {
    console.error('  ❌ deasync package not installed. Run: npm install deasync');
    process.exit(1);
  }

  function querySync(sql, params) {
    let result = null, error = null, done = false;
    pool.query(sql, params || [])
      .then(r => { result = r; done = true; })
      .catch(e => { error = e; done = true; });
    deasync.loopWhile(() => !done);
    if (error) throw error;
    return result;
  }

  // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
  function convertPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => '$' + (++idx));
  }

  // Convert SQLite datetime('now') to PostgreSQL NOW()
  function convertSQL(sql) {
    let converted = sql
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/INSERT OR REPLACE/gi, 'INSERT')
      .replace(/INSERT OR IGNORE/gi, 'INSERT')
      .replace(/strftime\('%Y-%m',\s*(\w+)\)/gi, "to_char($1::timestamp, 'YYYY-MM')")
      .replace(/julianday\('now'\)\s*-\s*julianday\(([^)]+)\)/gi, "EXTRACT(EPOCH FROM NOW() - ($1)::timestamp) / 86400")
      .replace(/date\('now',\s*'([^']+)'\)/gi, (match, offset) => {
        return "NOW() + INTERVAL '" + offset + "'";
      });
    return convertPlaceholders(converted);
  }

  const adapter = {
    _pool: pool,
    _type: 'postgresql',

    prepare(sql) {
      const pgSql = convertSQL(sql);
      return {
        all(...params) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const result = querySync(pgSql, flatParams);
          return result.rows || [];
        },
        get(...params) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const limited = pgSql.toLowerCase().includes('limit') ? pgSql : pgSql + ' LIMIT 1';
          const result = querySync(limited, flatParams);
          return result.rows && result.rows[0] ? result.rows[0] : undefined;
        },
        run(...params) {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const result = querySync(pgSql, flatParams);
          return { changes: result.rowCount, lastInsertRowid: result.rows && result.rows[0] ? result.rows[0].id : null };
        }
      };
    },

    exec(sql) {
      // Handle multi-statement SQL
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of statements) {
        try {
          const pgStmt = convertSQL(stmt);
          querySync(pgStmt);
        } catch(e) {
          // Ignore "already exists" errors for CREATE TABLE IF NOT EXISTS
          if (!e.message.includes('already exists') && !e.message.includes('duplicate')) {
            console.error('  PG exec error:', e.message, '| SQL:', stmt.substring(0, 80));
          }
        }
      }
    },

    transaction(fn) {
      return (...args) => {
        querySync('BEGIN');
        try {
          const result = fn(...args);
          querySync('COMMIT');
          return result;
        } catch(e) {
          querySync('ROLLBACK');
          throw e;
        }
      };
    },

    pragma(str) {
      // PostgreSQL doesn't have pragma — silently ignore
      return null;
    },

    close() {
      pool.end();
    }
  };

  // Fix INSERT ... RETURNING id for lastInsertRowid support
  const originalPrepare = adapter.prepare.bind(adapter);
  adapter.prepare = function(sql) {
    const result = originalPrepare(sql);
    const isInsert = sql.trim().toUpperCase().startsWith('INSERT');

    if (isInsert) {
      const originalRun = result.run;
      result.run = function(...params) {
        // Add RETURNING id if not present
        let pgSql = convertSQL(sql);
        if (!pgSql.toLowerCase().includes('returning')) {
          pgSql += ' RETURNING id';
        }
        const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        try {
          const r = querySync(pgSql, flatParams);
          return { changes: r.rowCount, lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : null };
        } catch(e) {
          // Fallback without RETURNING if table has no id column
          if (e.message.includes('column "id" does not exist')) {
            const r = querySync(convertSQL(sql), flatParams);
            return { changes: r.rowCount, lastInsertRowid: null };
          }
          throw e;
        }
      };
    }

    return result;
  };

  console.log('  🐘 Database: PostgreSQL');
  return adapter;
}

module.exports = { createAdapter };
