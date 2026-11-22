'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'tienda.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  guid TEXT,
  name TEXT,
  game TEXT,
  status INTEGER,
  status_desc TEXT,
  type_desc TEXT,
  formats TEXT,
  org_name TEXT,
  brand_image TEXT,
  start_date TEXT,
  last_pair TEXT,
  timer_state INTEGER,
  timer_end TEXT,
  current_phase_id INTEGER,
  rounds_total INTEGER,
  current_round INTEGER,
  first_seen TEXT DEFAULT (datetime('now')),
  synced_at TEXT,
  details_synced_at TEXT,
  final_synced INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  price_cents INTEGER,
  template_id INTEGER,
  notes TEXT,
  notified_new INTEGER DEFAULT 0,
  notified_round INTEGER DEFAULT 0,
  notified_final INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  phase_id INTEGER,
  phase_name TEXT,
  phase_sort INTEGER,
  name TEXT,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS players (
  team_id INTEGER NOT NULL,
  tournament_id INTEGER NOT NULL,
  player_id INTEGER,
  user_key TEXT,
  username TEXT,
  display_name TEXT,
  full_name TEXT,
  status INTEGER,
  status_desc TEXT,
  dropped_round INTEGER,
  paid INTEGER DEFAULT 0,
  checked_in INTEGER DEFAULT 0,
  registered_at TEXT,
  PRIMARY KEY (tournament_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_key);
CREATE TABLE IF NOT EXISTS matches (
  guid TEXT PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  round_id INTEGER,
  round_number INTEGER,
  phase_sort INTEGER,
  table_number INTEGER,
  published INTEGER,
  has_result INTEGER,
  is_bye INTEGER,
  team1 INTEGER,
  team2 INTEGER,
  wins1 INTEGER,
  wins2 INTEGER,
  draws INTEGER,
  result_string TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_matches_t ON matches(tournament_id, round_number);
CREATE TABLE IF NOT EXISTS standings (
  tournament_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  rank INTEGER,
  points INTEGER,
  match_record TEXT,
  game_record TEXT,
  omw REAL,
  gw REAL,
  ogw REAL,
  round_number INTEGER,
  PRIMARY KEY (tournament_id, team_id)
);
CREATE TABLE IF NOT EXISTS decklists (
  id TEXT PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  team_id INTEGER,
  name TEXT,
  format TEXT,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  game TEXT,
  melee_template_id INTEGER,
  price_cents INTEGER,
  player_cap INTEGER,
  prize_pct INTEGER,
  description TEXT,
  checklist TEXT,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  done_by TEXT,
  done_at TEXT,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  team_id INTEGER,
  label TEXT,
  kind TEXT,
  amount_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  game TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  pts_win INTEGER DEFAULT 3,
  pts_draw INTEGER DEFAULT 1,
  pts_loss INTEGER DEFAULT 0,
  pts_attend INTEGER DEFAULT 1,
  pts_bonus TEXT DEFAULT '3,2,1,1',
  public INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS season_excluded (
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL,
  PRIMARY KEY (season_id, tournament_id)
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  level TEXT,
  msg TEXT
);
`);

// Migraciones sencillas: añade columnas nuevas si faltan
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('tournaments', 'info', 'TEXT');
addColumn('tournaments', 'start_date_manual', 'INTEGER DEFAULT 0');
addColumn('prizes', 'cmd_event_id', 'INTEGER');
addColumn('prizes', 'cmd_player_id', 'INTEGER');

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

const DEFAULT_SETTINGS = {
  store_name: 'Mi tienda',
  base_url: '',
  accent: '#f47700',
  logo_url: '',
  address: '',
  calendar_url: '',
  show_game_img: '0',
  game_img_StarWarsUnlimited: '',
  game_img_CyberpunkTCG: '',
  game_img_MagicTheGathering: '',
  game_img_Riftbound: '',
  game_img_commander: '',
  show_real_names: '0',
  discord_webhook: '',
  telegram_token: '',
  telegram_chat: '',
  notify_new: '1',
  notify_rounds: '1',
  notify_final: '1',
  inactive_days: '30',
  default_price: '',
  default_prize_pct: '50',
  tv_page_seconds: '12',
  feature_prizes: '0',
  feature_cash: '0',
  feature_profiles: '1',
  feature_meta: '1',
  backup_keep: '14',
};

function setting(key) {
  const row = getSetting.get(key);
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? '');
}
function settings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  putSetting.run(key, value == null ? '' : String(value));
}

function log(level, msg) {
  db.prepare('INSERT INTO sync_log(level, msg) VALUES(?, ?)').run(level, String(msg).slice(0, 2000));
  db.prepare('DELETE FROM sync_log WHERE id < (SELECT MAX(id) - 1000 FROM sync_log)').run();
  if (level === 'error') console.error('[sync]', msg); else console.log('[sync]', msg);
}

const feature = name => setting('feature_' + name) === '1';

module.exports = { db, setting, settings, setSetting, log, DEFAULT_SETTINGS, addColumn, feature };
