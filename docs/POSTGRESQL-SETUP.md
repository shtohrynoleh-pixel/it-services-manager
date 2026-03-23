# PostgreSQL Setup Guide

## Quick Start

### 1. Install PostgreSQL on your server

**AWS EC2 (Amazon Linux):**
```bash
sudo dnf install -y postgresql15-server postgresql15
sudo postgresql-setup --initdb
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

**Ubuntu:**
```bash
sudo apt install -y postgresql postgresql-contrib
```

### 2. Create database and user

```bash
sudo -u postgres psql
```

```sql
CREATE USER itforge WITH PASSWORD 'your-strong-password';
CREATE DATABASE itforge OWNER itforge;
GRANT ALL PRIVILEGES ON DATABASE itforge TO itforge;
\q
```

### 3. Allow password authentication

Edit `/var/lib/pgsql/data/pg_hba.conf` (Amazon Linux) or `/etc/postgresql/15/main/pg_hba.conf` (Ubuntu):

Change `peer` and `ident` to `md5` for local connections:
```
local   all   all   md5
host    all   all   127.0.0.1/32   md5
```

Restart:
```bash
sudo systemctl restart postgresql
```

### 4. Run the schema

```bash
psql -U itforge -d itforge -f db/postgres-schema.sql
```

### 5. Install Node.js PostgreSQL packages

```bash
cd /opt/itm
npm install pg deasync
```

### 6. Set environment variable

Add to `.env`:
```
DATABASE_URL=postgresql://itforge:your-strong-password@localhost:5432/itforge
```

### 7. Restart the app

```bash
pm2 restart itm
```

The app auto-detects `DATABASE_URL` — if set, it uses PostgreSQL; if not, it uses SQLite.

---

## How It Works

The `db/adapter.js` module provides a compatibility layer:

- **No DATABASE_URL** → uses `better-sqlite3` (synchronous, file-based)
- **DATABASE_URL set** → uses `pg` pool with `deasync` for sync-compatible API

The adapter converts:
- `?` placeholders → `$1, $2, $3` (PostgreSQL numbered params)
- `datetime('now')` → `NOW()`
- `AUTOINCREMENT` → `SERIAL`
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT`
- `strftime()` → `to_char()`

---

## Scaling Notes

| Metric | SQLite | PostgreSQL |
|--------|--------|------------|
| Max concurrent writes | ~100/sec | ~10,000/sec |
| Max database size | ~1TB (practical ~10GB) | Unlimited |
| Max connections | 1 (WAL allows readers) | Pool of 20 (configurable) |
| Backup | Copy file | pg_dump |
| Replication | Not built-in | Streaming replication |
| Good for | 1-100 companies | 100-10,000+ companies |

---

## Switching Back to SQLite

Remove or comment out `DATABASE_URL` from `.env` and restart. The app will auto-fallback to SQLite.

---

## Backup (PostgreSQL)

```bash
# Full backup
pg_dump -U itforge itforge > backup_$(date +%Y%m%d).sql

# Restore
psql -U itforge itforge < backup_20260323.sql

# Add to crontab for daily backups
0 3 * * * pg_dump -U itforge itforge > /opt/itm/backups/pg_$(date +\%Y\%m\%d).sql
```
