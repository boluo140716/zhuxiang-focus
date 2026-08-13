-- 篆香多端同步 D1 表结构
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_items (
  id TEXT NOT NULL,           -- 与本地业务记录 id（UUID）相同
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- todo / session / distraction / diary / setting
  payload TEXT NOT NULL,      -- JSON 快照
  updated_at TEXT NOT NULL,   -- ISO 时间戳（后写覆盖依据）
  deleted INTEGER DEFAULT 0,  -- 软删除墓碑
  PRIMARY KEY (user_id, entity_type, id)
);

CREATE INDEX IF NOT EXISTS idx_sync_user_time ON sync_items (user_id, updated_at);
