/**
 * Database migration runner (CLI)
 * Runs SQL migrations in order, tracks applied migrations.
 *
 * Usage: node db/migrate.js
 */
const { ensureSchema } = require('./schema');

try {
    ensureSchema();
} catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
}
