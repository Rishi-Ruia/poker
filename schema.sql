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

-- Enable Realtime for all tables
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table room_players;
alter publication supabase_realtime add table game_state;
alter publication supabase_realtime add table game_actions;

-- Indexes for performance
create index if not exists idx_room_players_room_id on room_players(room_id);
create index if not exists idx_game_actions_room_id on game_actions(room_id);
create index if not exists idx_game_actions_created_at on game_actions(created_at desc);

-- RLS Policies (disable RLS for simplicity - enable anon key access)
alter table rooms enable row level security;
alter table room_players enable row level security;
alter table game_state enable row level security;
alter table game_actions enable row level security;

-- Allow all operations for anon users (for a public game)
create policy "Allow all for rooms" on rooms for all using (true) with check (true);
create policy "Allow all for room_players" on room_players for all using (true) with check (true);
create policy "Allow all for game_state" on game_state for all using (true) with check (true);
create policy "Allow all for game_actions" on game_actions for all using (true) with check (true);
