-- Supabase incremental update (safe to re-run)
-- Run this file in Supabase SQL Editor when updating an existing project.

-- Ensure leaderboard table exists
create table if not exists player_stats (
  player_id text primary key,
  player_name text not null,
  net_chips bigint not null default 0,
  hands_played int not null default 0,
  hands_won int not null default 0,
  last_seen timestamptz default now()
);

-- Index for leaderboard ordering
create index if not exists idx_player_stats_net_chips on player_stats(net_chips desc);

-- Add tables to Realtime publication only if not already added
DO $$
BEGIN
  IF to_regclass('public.rooms') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'rooms'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms';
  END IF;

  IF to_regclass('public.room_players') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'room_players'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.room_players';
  END IF;

  IF to_regclass('public.game_state') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'game_state'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.game_state';
  END IF;

  IF to_regclass('public.game_actions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'game_actions'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.game_actions';
  END IF;

  IF to_regclass('public.player_stats') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'player_stats'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.player_stats';
  END IF;
END
$$;

-- Keep RLS enabled
alter table if exists rooms enable row level security;
alter table if exists room_players enable row level security;
alter table if exists game_state enable row level security;
alter table if exists game_actions enable row level security;
alter table if exists player_stats enable row level security;

-- Create permissive policies only if missing
DO $$
BEGIN
  IF to_regclass('public.rooms') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'rooms' AND policyname = 'Allow all for rooms'
     ) THEN
    EXECUTE 'CREATE POLICY "Allow all for rooms" ON public.rooms FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF to_regclass('public.room_players') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'room_players' AND policyname = 'Allow all for room_players'
     ) THEN
    EXECUTE 'CREATE POLICY "Allow all for room_players" ON public.room_players FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF to_regclass('public.game_state') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'game_state' AND policyname = 'Allow all for game_state'
     ) THEN
    EXECUTE 'CREATE POLICY "Allow all for game_state" ON public.game_state FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF to_regclass('public.game_actions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'game_actions' AND policyname = 'Allow all for game_actions'
     ) THEN
    EXECUTE 'CREATE POLICY "Allow all for game_actions" ON public.game_actions FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF to_regclass('public.player_stats') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'player_stats' AND policyname = 'Allow all for player_stats'
     ) THEN
    EXECUTE 'CREATE POLICY "Allow all for player_stats" ON public.player_stats FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END
$$;
