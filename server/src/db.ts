import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.resolve(process.env.DATABASE_PATH ?? './data/app.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS viewer_tokens (
 id TEXT PRIMARY KEY,
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 token_hash TEXT UNIQUE NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 event TEXT NOT NULL,
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 metadata TEXT
);
`);
try { db.exec('ALTER TABLE rooms ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0'); } catch {}

export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function logEvent(roomId: string, event: string, actor: string, metadata?: unknown) {
 db.prepare('INSERT INTO access_logs(room_id,event,actor,created_at,metadata) VALUES(?,?,?,?,?)')
   .run(roomId, event, actor, now(), metadata ? JSON.stringify(metadata) : null);
}
