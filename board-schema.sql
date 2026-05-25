-- Mark Upper 掲示板（2ch型）: Supabase セットアップSQL
-- SQL Editor で1回だけ実行。プロジェクトは site-review（hiccejzetnmmvyopyykw）
-- 旧・単純掲示板は撤去してスレッド型に置き換える

drop table if exists mu_board_posts;

-- スレッド
create table mu_threads (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  version text,                          -- 対象バージョン（任意）
  created_at timestamptz default now(),
  bumped_at timestamptz default now()    -- 最終レス時刻（一覧の並び順用）
);

-- レス（スレ内の投稿。num はスレごとの連番 1,2,3...）
create table mu_posts (
  id uuid default gen_random_uuid() primary key,
  thread_id uuid references mu_threads(id) on delete cascade not null,
  num int not null default 0,
  name text not null default '名無しさん',
  text text not null,
  image_url text,
  created_at timestamptz default now()
);

create index mu_posts_thread_idx on mu_posts(thread_id, num);

-- 連番を自動付与（挿入前）
create or replace function mu_set_num() returns trigger as $$
begin
  select coalesce(max(num),0)+1 into new.num from mu_posts where thread_id = new.thread_id;
  return new;
end; $$ language plpgsql security definer;
create trigger trg_mu_set_num before insert on mu_posts
  for each row execute function mu_set_num();

-- レスが付いたらスレの最終更新を上げる（挿入後）
create or replace function mu_bump() returns trigger as $$
begin
  update mu_threads set bumped_at = now() where id = new.thread_id;
  return new;
end; $$ language plpgsql security definer;
create trigger trg_mu_bump after insert on mu_posts
  for each row execute function mu_bump();

-- RLS（誰でも閲覧・投稿。更新/削除は非公開＝他人の投稿を消せない）
alter table mu_threads enable row level security;
alter table mu_posts enable row level security;
create policy "select threads" on mu_threads for select using (true);
create policy "insert threads" on mu_threads for insert with check (true);
create policy "select posts" on mu_posts for select using (true);
create policy "insert posts" on mu_posts for insert with check (true);
-- 社内向け：全員が全投稿を編集・削除できる
create policy "update threads" on mu_threads for update using (true) with check (true);
create policy "delete threads" on mu_threads for delete using (true);
create policy "update posts" on mu_posts for update using (true) with check (true);
create policy "delete posts" on mu_posts for delete using (true);

-- 画像ストレージ（公開バケット）
insert into storage.buckets (id, name, public)
  values ('board-images','board-images', true)
  on conflict (id) do nothing;
create policy "board img read"   on storage.objects for select using (bucket_id = 'board-images');
create policy "board img upload" on storage.objects for insert with check (bucket_id = 'board-images');
create policy "board img delete" on storage.objects for delete using (bucket_id = 'board-images');
