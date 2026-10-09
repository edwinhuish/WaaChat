-- 归档索引
--
-- 由 archive/store.ts 在打开数据库时执行（幂等，全部 IF NOT EXISTS）。
-- 改动本文件后必须同步 test/unit/ 里对查询行为的断言。
--
-- 关于分词器：用 trigram 而不是 unicode61。
-- 原因是 unicode61 按空白/标点切词，而中文文件名（如 "2026年第三季度合同.pdf"）
-- 整串会被当成一个 token，导致按子串搜索完全失效。trigram 支持任意子串匹配，
-- 代价是查询长度必须 >= 3 个字符 —— 更短的查询由 store.ts 回退到 LIKE。

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 内容哈希：这份内容的**身份**（不是文件名，见 stored_name）
  hash        TEXT    NOT NULL,
  -- 打开时的原始文件名（展示与搜索用这个）
  name        TEXT    NOT NULL,
  -- 磁盘上的实际文件名：原文名，同名冲突时带一小段哈希后缀（ADR-0031）。
  -- 为 NULL 表示旧布局 —— 那个文件当时以内容哈希命名，读取时回落到 hash。
  stored_name TEXT,
  bytes       INTEGER NOT NULL,
  mime        TEXT    NOT NULL DEFAULT '',
  -- 归档时间（Unix 毫秒）
  opened_at   INTEGER NOT NULL,
  -- 会话标签。可空：我们不读取页面内部数据，来源不保证可得
  chat_label  TEXT
);

-- 同一份内容可能被多次打开，因此 hash 不唯一；
-- 但同一个 (hash, name) 重复打开时应更新 opened_at 而不是新增行（见 store.ts）。
CREATE INDEX IF NOT EXISTS idx_files_hash ON files (hash);
CREATE INDEX IF NOT EXISTS idx_files_opened_at ON files (opened_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5 (
  name,
  content = 'files',
  content_rowid = 'id',
  tokenize = 'trigram'
);

-- FTS 与主表的同步。external content 表必须用 'delete' 命令维护删除，
-- 直接 DELETE 会破坏索引一致性（表现为"搜得到但记录已不存在"）。
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts (rowid, name) VALUES (new.id, new.name);
END;

CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;

CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.id, old.name);
  INSERT INTO files_fts (rowid, name) VALUES (new.id, new.name);
END;
