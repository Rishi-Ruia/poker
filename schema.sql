-- Poker Game Schema for Supabase
-- Run this in the Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Rooms table
create table if not exists rooms (
  id text primary key,
  host_id text not null,
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  max_players int not null default 6,
  small_blind int not null default 10,
  big_blind int not null default 20,
  starting_chips int not null default 1000,
  created_at timestamptz default now()
);

-- Players table
create table if not exists room_players (
  id text primary key,
  room_id text not null references rooms(id) on delete cascade,
  name text not null,
  chips int not null default 1000,
  seat int not null,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'folded', 'all_in', 'out', 'sitting_out')),
  is_connected bool not null default true,
  created_at timestamptz default now(),
  unique(room_id, seat)
);

-- Game state table (one row per room, stores full game state as JSON)
create table if not exists game_state (
  room_id text primary key references rooms(id) on delete cascade,
  state jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Action log table
create table if not exists game_actions (
  id bigserial primary key,
  room_id text not null references rooms(id) on delete cascade,
  player_id text not null,
  player_name text not null,
  action text not null,
  amount int default 0,
  created_at timestamptz default now()
);

-- Enable Realtime for all tables (idempotent)
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
END
$$;

-- Indexes for performance
create index if not exists idx_room_players_room_id on room_players(room_id);
create index if not exists idx_game_actions_room_id on game_actions(room_id);
create index if not exists idx_game_actions_created_at on game_actions(created_at desc);

-- Player stats table (lifetime leaderboard)
create table if not exists player_stats (
  player_id text primary key,
  player_name text not null,
  net_chips bigint not null default 0,
  hands_played int not null default 0,
  hands_won int not null default 0,
  last_seen timestamptz default now()
);

-- Enable Realtime for player_stats (idempotent)
DO $$
BEGIN
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

-- Index for leaderboard ordering
create index if not exists idx_player_stats_net_chips on player_stats(net_chips desc);

-- RLS Policies (disable RLS for simplicity - enable anon key access)
alter table rooms enable row level security;
alter table room_players enable row level security;
alter table game_state enable row level security;
alter table game_actions enable row level security;
alter table player_stats enable row level security;

-- Allow all operations for anon users (for a public game) (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rooms' AND policyname = 'Allow all for rooms'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for rooms" ON public.rooms FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'room_players' AND policyname = 'Allow all for room_players'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for room_players" ON public.room_players FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'game_state' AND policyname = 'Allow all for game_state'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for game_state" ON public.game_state FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'game_actions' AND policyname = 'Allow all for game_actions'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for game_actions" ON public.game_actions FOR ALL USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'player_stats' AND policyname = 'Allow all for player_stats'
  ) THEN
    EXECUTE 'CREATE POLICY "Allow all for player_stats" ON public.player_stats FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END
$$;
