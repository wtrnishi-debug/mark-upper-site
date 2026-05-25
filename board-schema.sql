-- Mark Upper 掲示板（BBS）: Supabase セットアップSQL
-- Supabase の SQL Editor で1回だけ実行してください
-- プロジェクトは Site Review と同じ（hiccejzetnmmvyopyykw）を流用

create table mu_board_posts (
  id uuid default gen_random_uuid() primary key,
  text text not null,
  created_at timestamptz default now()
);

alter table mu_board_posts enable row level security;

-- 誰でも閲覧・投稿できる（匿名）。更新・削除は公開しない＝他人の投稿を消せない
create policy "Public select board" on mu_board_posts for select using (true);
create policy "Public insert board" on mu_board_posts for insert with check (true);
