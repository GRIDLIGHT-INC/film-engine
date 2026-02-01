/**
 * Auto-migration on startup
 * Reads and applies pending migrations from db/migrations/
 */
const fs = require('fs');
const path = require('path');
const { db } = require('./database');

function ensureSchema() {
    // Create migration tracking table
    db.exec(`
        CREATE TABLE IF NOT EXISTS _film_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    `);

    const applied = db.prepare('SELECT name FROM _film_migrations ORDER BY name').all();
    const appliedSet = new Set(applied.map(r => r.name));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
        if (appliedSet.has(file)) continue;

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        const migrate = db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO _film_migrations (name) VALUES (?)').run(file);
        });

        try {
            migrate();
            console.log(`  Migration applied: ${file}`);
            count++;
        } catch (err) {
            console.error(`  Migration failed (${file}):`, err.message);
            throw err;
        }
    }

    if (count > 0) console.log(`  ${count} migration(s) applied.`);
    else console.log('  Database schema up to date.');
}

module.exports = { ensureSchema };
