# ♠ Poker · Texas Hold'em Online
poker ha i barely know her (vibe coded ofc)

**Live:** http://rishi-ruia.github.io/poker

---

## Features

- Real-time multiplayer Texas Hold'em (up to 6 players)
- Create or join rooms with a 5-character code
- Configurable blinds and starting chip stacks
- Full hand evaluation — pairs through royal flushes
- Auto-advancing betting rounds and phases
- Live action log
- Split pots on ties, all-in side pots
- Next hand auto-deals after 5 seconds

## First-Time Setup (Supabase)

Run the database schema once before playing:

1. Open your [Supabase project](https://supabase.com) → **SQL Editor**
2. Paste the contents of `schema.sql` and click **Run**

This creates: `rooms`, `room_players`, `game_state`, `game_actions` tables with Realtime enabled.

## How to Play

1. Open the app — enter your name
2. **Create a Room** and share the 5-character code with friends
3. Everyone joins via **Join Room** or the **Browse** tab
4. Once 2+ players have joined, the host clicks **Start Game**
5. Take turns: **Fold / Check / Call / Raise / All-In**
6. Best 5-card hand wins the pot — next hand deals automatically

## Hosting on GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source: `main` branch, `/ (root)`
4. Live at `https://<username>.github.io/<repo>`

## Stack

- Vanilla HTML / CSS / JS (zero build step — works directly on GitHub Pages)
- [Supabase](https://supabase.com) — Postgres database + Realtime WebSocket subscriptions
- GitHub Pages — static hosting
