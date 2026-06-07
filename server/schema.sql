-- 予定表アプリ スキーマ (SQLite)

-- ユーザー（家族など共有メンバー）
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,           -- UUID
    username      TEXT UNIQUE NOT NULL,       -- ログインID
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,              -- 表示名
    color         TEXT NOT NULL DEFAULT '#3b82f6',  -- 予定の色分け用
    is_admin      INTEGER NOT NULL DEFAULT 0, -- 管理者フラグ
    created_at    INTEGER NOT NULL            -- epoch ms
);

-- タグのマスタ（選択式コンボボックス用）
CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    created_at INTEGER NOT NULL
);

-- 予定（イベント）
CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,             -- UUID（クライアントでも生成可能 → オフライン作成対応）
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    start       TEXT NOT NULL,                -- ISO 8601 (例: "2026-06-06T09:00")
    end         TEXT,                         -- ISO 8601 / NULL
    all_day      INTEGER NOT NULL DEFAULT 0,  -- 0/1
    tags         TEXT NOT NULL DEFAULT '',    -- カンマ区切りのタグ（検索用）
    participants TEXT NOT NULL DEFAULT '',    -- カンマ区切りの参加者ユーザーID
    private      INTEGER NOT NULL DEFAULT 0,  -- 1=非公開（作成者と参加者のみに表示）
    color        TEXT,                        -- 個別指定が無ければ owner の色を使用
    owner_id     TEXT NOT NULL,               -- 作成者
    updated_at  INTEGER NOT NULL,             -- epoch ms（同期の Last-Write-Wins 判定に使用）
    deleted     INTEGER NOT NULL DEFAULT 0,   -- 論理削除（同期で削除を伝えるため）
    FOREIGN KEY (owner_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_events_updated ON events (updated_at);
CREATE INDEX IF NOT EXISTS idx_events_start   ON events (start);
