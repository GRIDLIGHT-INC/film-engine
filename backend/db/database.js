/**
 * Shared SQLite database connection
 * Stores data in apps/film-engine/data/film-engine.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Database file lives in the app's data directory
const DATA_DIR = process.env.FILM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'film-engine.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Generate a UUID v4 */
function generateId() {
    return crypto.randomUUID();
}

module.exports = { db, generateId };
