-- Mark Upper データベースセットアップ
-- Supabase の「SQL Editor」にこれをすべて貼り付けて「Run」を押してください

-- メンバーテーブル
CREATE TABLE IF NOT EXISTS members (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- コメントテーブル（返信もここで管理。parent_id があるものが返信）
CREATE TABLE IF NOT EXISTS comments (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_url         TEXT NOT NULL,
  x_percent        FLOAT,
  y_percent        FLOAT,
  element_selector TEXT,
  el_x_pct         FLOAT,
  el_y_pct         FLOAT,
  text             TEXT NOT NULL,
  author           TEXT NOT NULL,
  assignee         TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'fixed', 'verified', 'rejected')),
  device           TEXT NOT NULL DEFAULT 'pc'
                     CHECK (device IN ('pc', 'mobile')),
  parent_id        UUID REFERENCES comments(id) ON DELETE CASCADE,
  image_paths      TEXT[] DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- セキュリティ設定（社内ツールのため全操作を許可）
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON comments FOR ALL USING (true) WITH CHECK (true);

-- ストレージバケット（添付ファイル用）
-- Supabase ダッシュボード → Storage → New bucket で以下を作成してください:
--   バケット名: comment-images
--   Public: ON（チェックを入れる）
-- 作成後、バケットの「Policies」から「New policy」→「For full customization」で
-- 以下のポリシーを追加してください（Supabase SQL Editorでも可）:

INSERT INTO storage.buckets (id, name, public)
VALUES ('comment-images', 'comment-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "allow_all" ON storage.objects
  FOR ALL USING (bucket_id = 'comment-images') WITH CHECK (bucket_id = 'comment-images');
