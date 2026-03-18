// game.js - Main poker game logic with Supabase integration

const SUPABASE_URL = 'https://sflgqdhbuhpmxvykinbf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hxAzxcEQDM9cKgFKvW75-g_EsqZUo0C';

let supabaseClient;
let myPlayerId = null;
let myPlayer = null;
let currentRoom = null;
let gameState = null;
let allPlayers = [];
let subscriptions = [];
let isProcessingAction = false;
let lastSyncedMyChips = null;
let isSyncingMyStats = false;
let gameStateUpdatedAt = null;
let _roundAdvanceInFlight = false;
let _lastRoundAdvanceAttemptAt = 0;
let _roundAdvanceInterval = null;
let _turnTimeoutInFlight = false;
let _lastTurnTimeoutAttemptAt = 0;
let _unavailableTurnInFlight = false;
let _lastUnavailableTurnAttemptAt = 0;
let _turnRepairInFlight = false;
let _lastTurnRepairAttemptAt = 0;

const TURN_ACTION_SECONDS = 15;
const BETWEEN_HAND_DELAY_MS = 15000;

// ─── Init ─────────────────────────────────────────────────────────
function initSupabase() {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

function getOrCreatePlayerId() {
  let id = localStorage.getItem('poker_player_id');
  if (!id) {
    id = 'p_' + Math.random().toString(36).substr(2, 12);
    localStorage.setItem('poker_player_id', id);
  }
  return id;
}

// ─── Room Management ──────────────────────────────────────────────
async function createRoom(playerName, maxPlayers, smallBlind, bigBlind, startingChips) {
  const roomId = generateRoomCode();
  myPlayerId = getOrCreatePlayerId();

  // Create room
  const { error: roomErr } = await supabaseClient.from('rooms').insert({
    id: roomId,
    host_id: myPlayerId,
    status: 'waiting',
    max_players: maxPlayers,
    small_blind: smallBlind,
    big_blind: bigBlind,
    starting_chips: startingChips
  });
  if (roomErr) throw roomErr;

  // Create game_state row
  const { error: gsErr } = await supabaseClient.from('game_state').insert({
    room_id: roomId,
    state: { phase: 'waiting', community_cards: [], pot: 0, hands: {} }
  });
  if (gsErr) throw gsErr;

  // Join as player
  await joinRoomAsPlayer(roomId, playerName, startingChips);
  return roomId;
}

async function joinRoom(roomId, playerName) {
  myPlayerId = getOrCreatePlayerId();
  roomId = roomId.toUpperCase();

  // Check room exists
  const { data: room, error } = await supabaseClient.from('rooms').select('*').eq('id', roomId).single();
  if (error || !room) throw new Error('Room not found');
  if (room.status === 'finished') throw new Error('Game has already ended');

  // Check player count
  const { data: players } = await supabaseClient.from('room_players').select('*').eq('room_id', roomId);
  const activePlayers = (players || []).filter(p => p.status !== 'out');
  const existing = players?.find(p => p.id === myPlayerId);

  if (room.status === 'playing') {
    // Allow joining mid-game (new players start on next hand)
    if (!existing) {
      if (activePlayers.length >= room.max_players) throw new Error('Room is full');
      await joinRoomAsPlayer(roomId, playerName, room.starting_chips);
      await logAction(roomId, myPlayerId, playerName, 'joined in-progress game (next hand)', room.starting_chips);
      return { room, isRebuy: false };
    }
    if (existing.status === 'out') {
      // Player left — do a rebuy with a fresh starting stack
      await supabaseClient.from('room_players').update({
        name: playerName,
        chips: room.starting_chips,
        status: 'waiting',
        is_connected: true
      }).eq('id', myPlayerId).eq('room_id', roomId);
      await logAction(roomId, myPlayerId, playerName, `rejoined with rebuy ($${room.starting_chips})`, room.starting_chips);
      return { room, isRebuy: true };
    }
    // Player is still in the game — reconnect
    await supabaseClient.from('room_players').update({ name: playerName, is_connected: true }).eq('id', myPlayerId);
    return { room, isRebuy: false };
  }

  // Room is waiting
  if (!existing) {
    if (activePlayers.length >= room.max_players) throw new Error('Room is full');
    await joinRoomAsPlayer(roomId, playerName, room.starting_chips);
  } else {
    // Update name / reconnect
    await supabaseClient.from('room_players').update({ name: playerName, is_connected: true }).eq('id', myPlayerId);
  }
  return { room, isRebuy: false };
}

async function joinRoomAsPlayer(roomId, playerName, chips) {
  const { data: players } = await supabaseClient
    .from('room_players')
    .select('seat,status')
    .eq('room_id', roomId)
    .neq('status', 'out')
    .order('seat');
  const usedSeats = players ? players.map(p => p.seat) : [];
  const seat = findNextSeat(usedSeats);

  const { error } = await supabaseClient.from('room_players').upsert({
    id: myPlayerId,
    room_id: roomId,
    name: playerName,
    chips,
    seat,
    status: 'waiting',
    is_connected: true
  });
  if (error) throw error;
}

function findNextSeat(usedSeats) {
  for (let i = 0; i < 7; i++) {
    if (!usedSeats.includes(i)) return i;
  }
  return usedSeats.length;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function applyTurnDeadline(state, turnPlayerId = state?.current_player_id) {
  const inActionPhase = !!state
    && !state.round_done
    && state.phase !== 'waiting'
    && state.phase !== 'showdown';

  if (!inActionPhase || !turnPlayerId) {
    return {
      ...state,
      action_turn_player_id: null,
      action_deadline_at: null,
      timeout_action_lock: null
    };
  }

  return {
    ...state,
    action_turn_player_id: turnPlayerId,
    action_deadline_at: new Date(Date.now() + TURN_ACTION_SECONDS * 1000).toISOString(),
    timeout_action_lock: null
  };
}

function getActionDeadlineMs(state) {
  const ts = Date.parse(state?.action_deadline_at || '');
  return Number.isFinite(ts) ? ts : null;
}

function isActionPhaseState(state) {
  return !!state
    && !state.round_done
    && state.phase !== 'waiting'
    && state.phase !== 'showdown';
}

function getEligibleActionPlayerIds(state) {
  const active = state?.active_player_ids || [];
  const allIn = new Set(state?.all_in_players || []);
  return active.filter(id => !allIn.has(id));
}

function getPendingActionOrder(state) {
  const eligible = new Set(getEligibleActionPlayerIds(state));
  const pending = [];
  const seen = new Set();
  for (const id of (state?.acting_order || [])) {
    if (!eligible.has(id) || seen.has(id)) continue;
    seen.add(id);
    pending.push(id);
  }
  return pending;
}

function shouldRepairTurnState(state) {
  if (!isActionPhaseState(state)) return false;
  const pending = getPendingActionOrder(state);
  if (!pending.length) return false;

  const expectedPlayerId = pending[0];
  const deadlineMs = getActionDeadlineMs(state);
  return state.current_player_id !== expectedPlayerId
    || state.action_turn_player_id !== expectedPlayerId
    || !deadlineMs;
}

async function maybeRepairTurnState() {
  if (!currentRoom || currentRoom.status !== 'playing' || !gameState) return;
  if (_turnRepairInFlight || isProcessingAction || _turnTimeoutInFlight || _unavailableTurnInFlight) return;
  if (!shouldRepairTurnState(gameState)) return;

  const now = Date.now();
  if (now - _lastTurnRepairAttemptAt < 600) return;
  _lastTurnRepairAttemptAt = now;

  const expectedUpdatedAt = gameStateUpdatedAt;
  if (!expectedUpdatedAt) return;

  const pending = getPendingActionOrder(gameState);
  if (!pending.length) return;

  _turnRepairInFlight = true;
  try {
    const nextPlayerId = pending[0];
    const repairedState = applyTurnDeadline({
      ...gameState,
      acting_order: pending,
      current_player_id: nextPlayerId,
      timeout_action_lock: null
    }, nextPlayerId);

    const updatedAt = new Date().toISOString();
    const { data: repairedRow, error: repairErr } = await supabaseClient
      .from('game_state')
      .update({ state: repairedState, updated_at: updatedAt })
      .eq('room_id', currentRoom.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('state, updated_at')
      .maybeSingle();

    if (repairErr || !repairedRow) return;
    gameState = repairedRow.state || gameState;
    gameStateUpdatedAt = repairedRow.updated_at;
  } catch (e) {
    console.error('Turn state repair failed:', e);
  } finally {
    _turnRepairInFlight = false;
  }
}

async function fetchRooms() {
  const { data } = await supabaseClient.from('rooms').select('*, room_players(count)').in('status', ['waiting', 'playing']).order('created_at', { ascending: false }).limit(20);
  return data || [];
}

// ─── Game Start ───────────────────────────────────────────────────
async function startGame() {
  if (isProcessingAction) return;
  isProcessingAction = true;
  try {
    const { data: players } = await supabaseClient.from('room_players').select('*').eq('room_id', currentRoom.id).eq('status', 'waiting').order('seat');
    if (!players || players.length < 2) { showToast('Need at least 2 players', 'error'); return; }

    await supabaseClient.from('rooms').update({ status: 'playing' }).eq('id', currentRoom.id);
    await dealNewHand(players, -1, 0); // dealerSeat=-1 means seat 0 is dealer for first hand
  } finally {
    isProcessingAction = false;
  }
}

async function dealNewHand(activePlayers, prevDealerSeat, roundNumber) {
  const sorted = [...activePlayers].filter(p => p.chips > 0).sort((a, b) => a.seat - b.seat);
  if (sorted.length < 2) return;

  // Advance dealer
  const dealerSeat = getNextSeatInList(sorted, prevDealerSeat);
  const dealerIndex = sorted.findIndex(p => p.seat === dealerSeat);

  // Small blind = player after dealer, big blind = player after SB
  const sbIndex = (dealerIndex + 1) % sorted.length;
  const bbIndex = (dealerIndex + 2) % sorted.length;
  const sbPlayer = sorted[sbIndex];
  const bbPlayer = sorted[bbIndex];
  const sb = currentRoom.small_blind;
  const bb = currentRoom.big_blind;

  // Shuffle deck and deal
  const deck = shuffleDeck(createDeck());
  const hands = {};
  for (const p of sorted) {
    hands[p.id] = [deck.pop(), deck.pop()];
  }

  // Post blinds
  const sbBet = Math.min(sbPlayer.chips, sb);
  const bbBet = Math.min(bbPlayer.chips, bb);

  // Preflop acting order: starts from player after BB
  const actingOrder = buildActingOrder(sorted, bbIndex);
  // BB gets option even if no raises (add back at end if needed)

  const playerBets = {};
  const playerContributions = {};
  for (const p of sorted) { playerBets[p.id] = 0; playerContributions[p.id] = 0; }
  playerBets[sbPlayer.id] = sbBet;
  playerBets[bbPlayer.id] = bbBet;
  playerContributions[sbPlayer.id] = sbBet;
  playerContributions[bbPlayer.id] = bbBet;

  // Remove BB from acting_order initially (they act last preflop with option)
  // All players need to act; acting order for preflop: UTG...BTN, SB, BB
  // After BB posts, acting order is from player after BB going around to BB
  const preflopOrder = buildPreflopActingOrder(sorted, bbIndex);

  const baseState = {
    phase: 'preflop',
    deck: deck,
    hands,
    community_cards: [],
    pot: sbBet + bbBet,
    current_bet: bbBet,
    current_player_id: preflopOrder[0],
    dealer_seat: dealerSeat,
    small_blind: sb,
    big_blind: bb,
    small_blind_player_id: sbPlayer.id,
    big_blind_player_id: bbPlayer.id,
    player_bets: playerBets,
    player_contributions: playerContributions,
    acting_order: preflopOrder,
    last_aggressor_id: bbPlayer.id,
    round_number: roundNumber,
    all_in_players: [],
    active_player_ids: sorted.map(p => p.id),
    winners: null
  };
  const newState = applyTurnDeadline(baseState, baseState.current_player_id);

  // Reset player statuses
  for (const p of sorted) {
    await supabaseClient.from('room_players').update({
      status: 'active',
      chips: p.chips - (p.id === sbPlayer.id ? sbBet : p.id === bbPlayer.id ? bbBet : 0)
    }).eq('id', p.id);
  }

  const updatedAt = new Date().toISOString();
  await supabaseClient.from('game_state').update({ state: newState, updated_at: updatedAt }).eq('room_id', currentRoom.id);
  gameStateUpdatedAt = updatedAt;

  // Log
  await logAction(currentRoom.id, 'system', 'Dealer', `New hand #${roundNumber + 1} - Dealer: Seat ${dealerSeat}`, 0);
  await logAction(currentRoom.id, sbPlayer.id, sbPlayer.name, 'posts small blind', sbBet);
  await logAction(currentRoom.id, bbPlayer.id, bbPlayer.name, 'posts big blind', bbBet);
}

function getNextSeatInList(players, prevSeat) {
  if (prevSeat < 0) return players[0].seat;
  const idx = players.findIndex(p => p.seat === prevSeat);
  return players[(idx + 1) % players.length].seat;
}

function buildActingOrder(players, fromIndex) {
  const order = [];
  for (let i = 1; i <= players.length; i++) {
    order.push(players[(fromIndex + i) % players.length].id);
  }
  return order;
}

function buildPreflopActingOrder(players, bbIndex) {
  // Preflop: UTG first (player after BB), going around to BB
  const order = [];
  for (let i = 1; i <= players.length; i++) {
    order.push(players[(bbIndex + i) % players.length].id);
  }
  return order;
}

function sortPlayerIdsBySeat(ids) {
  const seatById = new Map(allPlayers.map(p => [p.id, p.seat]));
  return [...ids].sort((a, b) => {
    const aSeat = seatById.has(a) ? seatById.get(a) : Number.MAX_SAFE_INTEGER;
    const bSeat = seatById.has(b) ? seatById.get(b) : Number.MAX_SAFE_INTEGER;
    if (aSeat !== bSeat) return aSeat - bSeat;
    return String(a).localeCompare(String(b));
  });
}

function buildReopenedActingOrder(state, actingPlayerId) {
  const eligible = (state.active_player_ids || []).filter(id => id !== actingPlayerId);
  if (!eligible.length) return [];

  const seatById = new Map(allPlayers.map(p => [p.id, p.seat]));
  const actorSeat = seatById.get(actingPlayerId);
  const sorted = sortPlayerIdsBySeat(eligible);
  if (actorSeat === undefined) return sorted;

  const splitIdx = sorted.findIndex(id => (seatById.get(id) ?? 999) > actorSeat);
  return splitIdx >= 0
    ? [...sorted.slice(splitIdx), ...sorted.slice(0, splitIdx)]
    : sorted;
}

function cloneGameState(state) {
  if (!state) return state;
  if (typeof structuredClone === 'function') {
    return structuredClone(state);
  }
  return JSON.parse(JSON.stringify(state));
}

// ─── Player Actions ───────────────────────────────────────────────
async function playerAction(action, amount = 0) {
  if (isProcessingAction) return;
  if (!gameState || gameState.phase === 'waiting' || gameState.phase === 'showdown') return;
  if (!gameState || gameState.current_player_id !== myPlayerId) {
    showToast("It's not your turn", 'error');
    return;
  }

  isProcessingAction = true;
  try {
    const state = cloneGameState(gameState);
    const player = allPlayers.find(p => p.id === myPlayerId);
    if (!player) return;

    let betAmount = 0;
    let newState = { ...state };
    newState.player_bets = { ...state.player_bets };
    newState.player_contributions = { ...state.player_contributions };
    newState.acting_order = state.acting_order.filter(id => id !== myPlayerId); // remove current player robustly
    newState.all_in_players = [...(state.all_in_players || [])];

    switch (action) {
      case 'fold':
        // Mark as folded
        await supabaseClient.from('room_players').update({ status: 'folded' }).eq('id', myPlayerId);
        await logAction(currentRoom.id, myPlayerId, player.name, 'folds', 0);
        // Remove from active players
        newState.active_player_ids = state.active_player_ids.filter(id => id !== myPlayerId);
        newState.acting_order = newState.acting_order.filter(id => id !== myPlayerId);
        break;

      case 'check':
        if (state.player_bets[myPlayerId] !== state.current_bet) {
          showToast('Cannot check - must call or fold', 'error'); isProcessingAction = false; return;
        }
        await logAction(currentRoom.id, myPlayerId, player.name, 'checks', 0);
        break;

      case 'call': {
        const callAmount = Math.min(state.current_bet - state.player_bets[myPlayerId], player.chips);
        newState.pot = state.pot + callAmount;
        newState.player_bets[myPlayerId] = state.player_bets[myPlayerId] + callAmount;
        newState.player_contributions[myPlayerId] = (state.player_contributions[myPlayerId] || 0) + callAmount;
        betAmount = callAmount;
        await supabaseClient.from('room_players').update({ chips: player.chips - callAmount }).eq('id', myPlayerId);
        if (player.chips - callAmount === 0) {
          if (!newState.all_in_players.includes(myPlayerId)) newState.all_in_players.push(myPlayerId);
          newState.active_player_ids = state.active_player_ids.filter(id => id !== myPlayerId);
          await supabaseClient.from('room_players').update({ status: 'all_in' }).eq('id', myPlayerId);
        }
        await logAction(currentRoom.id, myPlayerId, player.name, 'calls', callAmount);
        break;
      }

      case 'raise': {
        const totalRaise = amount; // total bet amount (not additional)
        if (totalRaise <= state.current_bet) { showToast('Raise must be bigger than current bet', 'error'); isProcessingAction = false; return; }
        if (totalRaise > player.chips + state.player_bets[myPlayerId]) {
          showToast('Not enough chips', 'error'); isProcessingAction = false; return;
        }
        const additional = totalRaise - state.player_bets[myPlayerId];
        newState.pot = state.pot + additional;
        newState.current_bet = totalRaise;
        newState.player_bets[myPlayerId] = totalRaise;
        newState.player_contributions[myPlayerId] = (state.player_contributions[myPlayerId] || 0) + additional;
        newState.last_aggressor_id = myPlayerId;
        betAmount = additional;

        // Rebuild acting order: all other active non-folded players need to act again
        newState.acting_order = buildReopenedActingOrder(newState, myPlayerId);

        await supabaseClient.from('room_players').update({ chips: player.chips - additional }).eq('id', myPlayerId);
        if (player.chips - additional === 0) {
          if (!newState.all_in_players.includes(myPlayerId)) newState.all_in_players.push(myPlayerId);
          newState.active_player_ids = state.active_player_ids.filter(id => id !== myPlayerId);
          await supabaseClient.from('room_players').update({ status: 'all_in' }).eq('id', myPlayerId);
          await logAction(currentRoom.id, myPlayerId, player.name, 'raises all-in', additional);
        } else {
          await logAction(currentRoom.id, myPlayerId, player.name, 'raises to', totalRaise);
        }
        break;
      }

      case 'allin': {
        const allChips = player.chips;
        const totalBet = state.player_bets[myPlayerId] + allChips;
        newState.pot = state.pot + allChips;
        newState.player_bets[myPlayerId] = totalBet;
        newState.player_contributions[myPlayerId] = (state.player_contributions[myPlayerId] || 0) + allChips;
        if (totalBet > state.current_bet) {
          newState.current_bet = totalBet;
          newState.last_aggressor_id = myPlayerId;
          newState.acting_order = buildReopenedActingOrder(newState, myPlayerId);
        }
        betAmount = allChips;
        if (!newState.all_in_players.includes(myPlayerId)) newState.all_in_players.push(myPlayerId);
        newState.active_player_ids = state.active_player_ids.filter(id => id !== myPlayerId);
        await supabaseClient.from('room_players').update({ chips: 0, status: 'all_in' }).eq('id', myPlayerId);
        await logAction(currentRoom.id, myPlayerId, player.name, 'goes all-in', allChips);
        break;
      }
    }

    const contenders = getHandContenders(newState);
    if (contenders.length <= 1) {
      await processEndOfBettingRound(newState);
      return;
    }

    // Check if betting round is over
    const eligibleToAct = new Set(
      (newState.active_player_ids || []).filter(id => !(newState.all_in_players || []).includes(id))
    );
    const stillToAct = newState.acting_order.filter(id => eligibleToAct.has(id));

    // Check win conditions
    if (newState.active_player_ids.filter(id => !newState.all_in_players.includes(id)).length <= 1 &&
        stillToAct.length === 0) {
      // Only one active player left or everyone is all-in
      await processEndOfBettingRound(newState);
      return;
    }

    if (stillToAct.length === 0) {
      // Betting round over, advance phase
      await processEndOfBettingRound(newState);
    } else {
      // Continue to next player
      newState.current_player_id = stillToAct[0];
      const timedState = applyTurnDeadline(newState, newState.current_player_id);
      const updatedAt = new Date().toISOString();
      await supabaseClient.from('game_state').update({ state: timedState, updated_at: updatedAt }).eq('room_id', currentRoom.id);
      gameStateUpdatedAt = updatedAt;
    }
  } finally {
    isProcessingAction = false;
  }
}

async function processEndOfBettingRound(state) {
  const activePlayers = state.active_player_ids || [];
  const allInPlayers = state.all_in_players || [];
  const contenders = [...new Set([...activePlayers, ...allInPlayers])];
  const actionablePlayers = activePlayers.filter(id => !allInPlayers.includes(id));

  // Reset per-round bets
  const newPlayerBets = {};
  for (const id of Object.keys(state.player_bets)) newPlayerBets[id] = 0;

  // Check if only one player left (everyone else folded)
  if (contenders.length <= 1) {
    // One player remains in hand (wins immediately)
    await awardPot(state, contenders, false);
    return;
  }

  // If one or fewer players can still act, no further betting is possible.
  // Run out the board for showdown among remaining contenders.
  if (actionablePlayers.length <= 1) {
    await runOutBoard(state);
    return;
  }

  switch (state.phase) {
    case 'preflop':
      await advanceToFlop(state, newPlayerBets);
      break;
    case 'flop':
      await advanceToTurn(state, newPlayerBets);
      break;
    case 'turn':
      await advanceToRiver(state, newPlayerBets);
      break;
    case 'river':
      await doShowdown(state);
      break;
    default:
      break;
  }
}

async function advanceToFlop(state, newPlayerBets) {
  const deck = [...(state.deck || [])];
  const flop = [deck.pop(), deck.pop(), deck.pop()];
  const newState = {
    ...state,
    deck,
    phase: 'flop',
    community_cards: flop,
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  const timedState = applyTurnDeadline(newState, newState.current_player_id);
  await supabaseClient.from('game_state').update({ state: timedState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'Flop dealt', 0);
}

async function advanceToTurn(state, newPlayerBets) {
  const deck = [...(state.deck || [])];
  const turn = deck.pop();
  const newState = {
    ...state,
    deck,
    phase: 'turn',
    community_cards: [...state.community_cards, turn],
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  const timedState = applyTurnDeadline(newState, newState.current_player_id);
  await supabaseClient.from('game_state').update({ state: timedState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'Turn dealt', 0);
}

async function advanceToRiver(state, newPlayerBets) {
  const deck = [...(state.deck || [])];
  const river = deck.pop();
  const newState = {
    ...state,
    deck,
    phase: 'river',
    community_cards: [...state.community_cards, river],
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  const timedState = applyTurnDeadline(newState, newState.current_player_id);
  await supabaseClient.from('game_state').update({ state: timedState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'River dealt', 0);
}

async function runOutBoard(state) {
  // Run all remaining community cards
  let community = [...state.community_cards];
  const deck = [...state.deck];
  while (community.length < 5) community.push(deck.pop());

  const newState = applyTurnDeadline({ ...state, community_cards: community, deck, phase: 'showdown' }, null);
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await doShowdown(newState);
}

async function doShowdown(state) {
  const nonFolded = state.active_player_ids || [];
  const allIn = state.all_in_players || [];
  const showdownSet = new Set([...nonFolded, ...allIn]);
  const showdownPlayers = sortPlayerIdsBySeat([...showdownSet]);

  if (showdownPlayers.length === 0) return;
  if (showdownPlayers.length === 1) {
    await awardPot(state, showdownPlayers, false);
    return;
  }

  const isAllInOnlyShowdown = showdownPlayers.every(id => {
    const player = allPlayers.find(p => p.id === id);
    return player?.status === 'all_in';
  });

  if (isAllInOnlyShowdown) {
    const playerHandData = showdownPlayers
      .map(id => ({ id, cards: state.hands?.[id] || [] }))
      .filter(p => p.cards.length === 2);

    if (playerHandData.length === 0) {
      await awardPot(state, showdownPlayers, false);
      return;
    }

    const { winners, evaluations } = determineWinners(playerHandData, state.community_cards || []);
    await awardPot(state, winners, true, evaluations);
    return;
  }

  await logAction(currentRoom.id, 'system', 'Dealer', 'Showdown! Players decide show or muck in order.', 0);

  const newState = applyTurnDeadline({
    ...state,
    phase: 'showdown',
    showdown_needed: [...showdownPlayers],
    showdown_decisions: {},
    optional_reveals: {},
    showdown_current_player_id: showdownPlayers[0] || null
  }, null);
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
}

async function playerReveal(show) {
  if (!gameState || isProcessingAction) return;
  const needed = gameState.showdown_needed || [];
  const decisions = gameState.showdown_decisions || {};
  const currentShowdownPlayerId = gameState.showdown_current_player_id || needed.find(id => decisions[id] === undefined) || null;

  if (!needed.includes(myPlayerId)) {
    // Optional reveal for folded players in showdown OR winners after round is done
    const player = allPlayers.find(p => p.id === myPlayerId);
    const isWinnerPostRound = !!gameState.round_done && (gameState.winners || []).includes(myPlayerId);
    if (!isWinnerPostRound && player?.status !== 'folded') return;
    const optReveals = { ...(gameState.optional_reveals || {}), [myPlayerId]: show };
    const newState = { ...gameState, optional_reveals: optReveals };
    await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
    return;
  }

  if (currentShowdownPlayerId && myPlayerId !== currentShowdownPlayerId) return;
  if (decisions[myPlayerId] !== undefined) return;

  isProcessingAction = true;
  try {
    const newDecisions = { ...decisions, [myPlayerId]: show };
    // If this is the last player to decide and they want to muck but everyone else already mucked, force reveal
    const allOthersMucked = needed.filter(id => id !== myPlayerId).every(id => newDecisions[id] === false);
    if (allOthersMucked && !show) newDecisions[myPlayerId] = true;

    const nextPlayerId = needed.find(id => newDecisions[id] === undefined) || null;
    const newState = {
      ...gameState,
      showdown_decisions: newDecisions,
      showdown_current_player_id: nextPlayerId
    };
    const stillUndecided = needed.filter(id => newDecisions[id] === undefined);

    if (stillUndecided.length === 0) {
      await finalizeShowdown(newState);
    } else {
      await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
    }
  } finally {
    isProcessingAction = false;
  }
}

async function finalizeShowdown(state) {
  const needed = state.showdown_needed || [];
  const decisions = state.showdown_decisions || {};

  const revealers = needed.filter(id => decisions[id] === true);
  const muckers = needed.filter(id => decisions[id] === false);

  for (const id of muckers) {
    const p = allPlayers.find(pl => pl.id === id);
    await logAction(currentRoom.id, id, p?.name || id, 'mucks hand', 0);
  }

  if (revealers.length === 0) {
    await awardPot(state, needed, false);
    return;
  }

  const playerHandData = revealers
    .map(id => ({ id, cards: state.hands[id] || [] }))
    .filter(p => p.cards.length === 2);

  if (playerHandData.length === 0) {
    await awardPot(state, needed, false);
    return;
  }

  const { winners, evaluations } = determineWinners(playerHandData, state.community_cards);

  for (const ev of evaluations) {
    const p = allPlayers.find(pl => pl.id === ev.id);
    await logAction(currentRoom.id, ev.id, p?.name || ev.id, `shows — ${ev.hand?.name || ''}`, 0);
  }

  const newState = { ...state, winners, evaluations, showdown_resolved: true };
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);

  await awardPot(state, winners, true, evaluations);
}

function getHandContenders(state) {
  const activePlayers = state.active_player_ids || [];
  const allInPlayers = state.all_in_players || [];
  return [...new Set([...activePlayers, ...allInPlayers])];
}

function calculateSidePotsFromContributions(contributions = {}) {
  const contribs = Object.entries(contributions)
    .map(([id, amount]) => ({ id, amount: Number(amount || 0) }))
    .filter(c => c.amount > 0)
    .sort((a, b) => a.amount - b.amount);

  if (!contribs.length) return [];

  const levels = [...new Set(contribs.map(c => c.amount))];
  const pots = [];
  let previousLevel = 0;

  for (const level of levels) {
    const layer = level - previousLevel;
    if (layer <= 0) continue;

    const contributors = contribs.filter(c => c.amount >= level).map(c => c.id);
    if (!contributors.length) continue;

    pots.push({
      amount: layer * contributors.length,
      eligible: contributors
    });
    previousLevel = level;
  }

  return pots;
}

async function awardPot(state, winnerIds, isShowdown, evaluations = []) {
  const pot = Number(state.pot || 0);
  const contributions = state.player_contributions || {};
  const evaluationIds = (evaluations || []).map(e => e.id);
  const showdownEligibleIds = evaluationIds.length
    ? [...new Set(evaluationIds)]
    : [...new Set(winnerIds || [])];
  const sortedWinnerIds = sortPlayerIdsBySeat([...(winnerIds || [])]);
  const winningsById = {};

  function addWinnings(playerId, amount) {
    if (!playerId || amount <= 0) return;
    winningsById[playerId] = (winningsById[playerId] || 0) + amount;
  }

  if (isShowdown) {
    const sidePots = calculateSidePotsFromContributions(contributions);
    const effectivePots = sidePots.length > 0
      ? sidePots
      : [{ amount: pot, eligible: getHandContenders(state) }];

    for (const sidePot of effectivePots) {
      const eligible = sidePot.eligible.filter(id => showdownEligibleIds.includes(id));
      if (!eligible.length) continue;

      let sideWinners = [];
      if (eligible.length === 1) {
        sideWinners = [eligible[0]];
      } else {
        const sideHandData = eligible
          .map(id => ({ id, cards: state.hands?.[id] || [] }))
          .filter(p => p.cards.length === 2);

        if (sideHandData.length === 0) {
          sideWinners = sortPlayerIdsBySeat(eligible).slice(0, 1);
        } else if (sideHandData.length === 1) {
          sideWinners = [sideHandData[0].id];
        } else {
          const sideResult = determineWinners(sideHandData, state.community_cards || []);
          sideWinners = sideResult.winners?.length
            ? sortPlayerIdsBySeat(sideResult.winners)
            : sortPlayerIdsBySeat([sideHandData[0].id]);
        }
      }

      const perWinner = Math.floor(sidePot.amount / sideWinners.length);
      const remainder = sidePot.amount % sideWinners.length;
      sideWinners.forEach((id, idx) => addWinnings(id, perWinner + (idx === 0 ? remainder : 0)));
    }
  } else {
    const directWinners = sortedWinnerIds.length
      ? sortedWinnerIds
      : sortPlayerIdsBySeat(getHandContenders(state)).slice(0, 1);

    const perWinner = directWinners.length ? Math.floor(pot / directWinners.length) : 0;
    const remainder = directWinners.length ? pot % directWinners.length : pot;
    directWinners.forEach((id, idx) => addWinnings(id, perWinner + (idx === 0 ? remainder : 0)));
  }

  const distributed = Object.values(winningsById).reduce((sum, val) => sum + val, 0);
  if (distributed < pot) {
    const fallbackId = sortPlayerIdsBySeat([
      ...new Set([
        ...(sortedWinnerIds || []),
        ...showdownEligibleIds,
        ...getHandContenders(state)
      ])
    ])[0];
    addWinnings(fallbackId, pot - distributed);
  }

  const paidWinnerIds = Object.keys(winningsById).filter(id => winningsById[id] > 0);
  if (!paidWinnerIds.length) return;

  // Fetch current chips
  const { data: players } = await supabaseClient.from('room_players').select('*').eq('room_id', currentRoom.id);
  const handNameByPlayerId = new Map((evaluations || [])
    .filter(e => e?.id && e?.hand?.name)
    .map(e => [e.id, e.hand.name]));

  for (const winnerId of paidWinnerIds) {
    const winner = players?.find(p => p.id === winnerId);
    if (winner) {
      const won = winningsById[winnerId] || 0;
      await supabaseClient.from('room_players').update({ chips: winner.chips + won }).eq('id', winner.id);
      const handName = handNameByPlayerId.get(winner.id);
      await logAction(currentRoom.id, winner.id, winner.name,
        `wins ${won} chips${isShowdown && handName ? ' with ' + handName : ''}`, won);
    }
  }

  // Mark round done
  const newState = {
    ...state,
    phase: 'showdown',
    winners: paidWinnerIds,
    evaluations,
    winnings_by_player_id: winningsById,
    round_done: true,
    round_done_at: new Date().toISOString(),
    next_hand_at: new Date(Date.now() + BETWEEN_HAND_DELAY_MS).toISOString(),
    round_transition_lock: null,
    action_turn_player_id: null,
    action_deadline_at: null,
    timeout_action_lock: null
  };
  const updatedAt = new Date().toISOString();
  await supabaseClient.from('game_state').update({ state: newState, updated_at: updatedAt }).eq('room_id', currentRoom.id);
  gameStateUpdatedAt = updatedAt;

  // Update lifetime hand counters (net chips are synced live during play)
  await updatePlayerStats(state, paidWinnerIds, { updateNetChips: false });
  await maybeAdvanceRoundAfterPayout();
}

function getNextHandAtMs(state, fallbackUpdatedAt) {
  const explicitMs = Date.parse(state?.next_hand_at || '');
  if (Number.isFinite(explicitMs)) return explicitMs;

  const baseMs = Date.parse(state?.round_done_at || fallbackUpdatedAt || '');
  return Number.isFinite(baseMs) ? baseMs + BETWEEN_HAND_DELAY_MS : Date.now() + BETWEEN_HAND_DELAY_MS;
}

async function advanceRoundAfterPayout(lockedState) {
  const { data: currentPlayers } = await supabaseClient
    .from('room_players')
    .select('*')
    .eq('room_id', currentRoom.id);

  const bustedPlayers = (currentPlayers || []).filter(p => p.chips <= 0 && p.status !== 'out');
  for (const busted of bustedPlayers) {
    await supabaseClient
      .from('room_players')
      .update({ status: 'out' })
      .eq('id', busted.id)
      .eq('room_id', currentRoom.id);
    await logAction(currentRoom.id, busted.id, busted.name, 'busted out', 0);
  }

  const { data: refreshedPlayers } = await supabaseClient
    .from('room_players')
    .select('*')
    .eq('room_id', currentRoom.id);

  const eligible = (refreshedPlayers || []).filter(p => p.chips > 0 && p.status !== 'out');
  if (eligible.length >= 2) {
    for (const p of eligible) {
      await supabaseClient.from('room_players').update({ status: 'waiting' }).eq('id', p.id);
    }
    await dealNewHand(eligible, lockedState.dealer_seat, (lockedState.round_number || 0) + 1);
    return;
  }

  const gameWinner = eligible[0] || null;
  const finalState = {
    ...lockedState,
    game_over: true,
    game_winner_id: gameWinner?.id || null,
    game_winner_name: gameWinner?.name || null,
    game_winner_chips: Number(gameWinner?.chips || 0),
    game_finished_at: new Date().toISOString(),
    current_player_id: null,
    action_turn_player_id: null,
    action_deadline_at: null,
    timeout_action_lock: null,
    round_transition_lock: null
  };
  const finalUpdatedAt = new Date().toISOString();
  await supabaseClient
    .from('game_state')
    .update({ state: finalState, updated_at: finalUpdatedAt })
    .eq('room_id', currentRoom.id);
  gameState = finalState;
  gameStateUpdatedAt = finalUpdatedAt;

  await supabaseClient.from('rooms').update({ status: 'finished' }).eq('id', currentRoom.id);
  await logAction(
    currentRoom.id,
    'system',
    'Dealer',
    gameWinner ? `Game over! ${gameWinner.name} wins the table.` : 'Game over!',
    0
  );
}

async function maybeAdvanceRoundAfterPayout() {
  if (!currentRoom || currentRoom.status !== 'playing' || !gameState?.round_done) return;
  if (_roundAdvanceInFlight) return;

  const dueMs = getNextHandAtMs(gameState, gameStateUpdatedAt);
  if (Date.now() < dueMs) return;

  const now = Date.now();
  if (now - _lastRoundAdvanceAttemptAt < 1000) return;
  _lastRoundAdvanceAttemptAt = now;

  const expectedUpdatedAt = gameStateUpdatedAt;
  if (!expectedUpdatedAt) return;

  _roundAdvanceInFlight = true;
  try {
    const lockState = {
      ...gameState,
      round_transition_lock: { by: myPlayerId, at: new Date().toISOString() }
    };
    const lockUpdatedAt = new Date().toISOString();

    const { data: lockRow, error: lockErr } = await supabaseClient
      .from('game_state')
      .update({ state: lockState, updated_at: lockUpdatedAt })
      .eq('room_id', currentRoom.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('state, updated_at')
      .maybeSingle();

    if (lockErr || !lockRow) return;

    gameState = lockRow.state || gameState;
    gameStateUpdatedAt = lockRow.updated_at;
    await advanceRoundAfterPayout(lockRow.state || lockState);
  } catch (e) {
    console.error('Round advancement failed:', e);
  } finally {
    _roundAdvanceInFlight = false;
  }
}

async function processTimedOutTurn(lockedState, timedOutPlayerId) {
  if (!timedOutPlayerId || lockedState.current_player_id !== timedOutPlayerId) return;

  const player = allPlayers.find(p => p.id === timedOutPlayerId);
  const playerName = player?.name || timedOutPlayerId;
  const playerBet = Number(lockedState.player_bets?.[timedOutPlayerId] || 0);
  const currentBet = Number(lockedState.current_bet || 0);
  const canCheck = playerBet === currentBet;

  const newState = {
    ...lockedState,
    player_bets: { ...(lockedState.player_bets || {}) },
    player_contributions: { ...(lockedState.player_contributions || {}) },
    acting_order: (lockedState.acting_order || []).filter(id => id !== timedOutPlayerId),
    all_in_players: [...(lockedState.all_in_players || [])],
    timeout_action_lock: null
  };

  if (canCheck) {
    await logAction(currentRoom.id, timedOutPlayerId, playerName, 'checks (timeout)', 0);
  } else {
    await supabaseClient.from('room_players').update({ status: 'folded' }).eq('id', timedOutPlayerId);
    newState.active_player_ids = (lockedState.active_player_ids || []).filter(id => id !== timedOutPlayerId);
    await logAction(currentRoom.id, timedOutPlayerId, playerName, 'folds (timeout)', 0);
  }

  const contenders = getHandContenders(newState);
  if (contenders.length <= 1) {
    await processEndOfBettingRound(newState);
    return;
  }

  const eligibleToAct = new Set(
    (newState.active_player_ids || []).filter(id => !(newState.all_in_players || []).includes(id))
  );
  const stillToAct = newState.acting_order.filter(id => eligibleToAct.has(id));

  if (newState.active_player_ids.filter(id => !(newState.all_in_players || []).includes(id)).length <= 1 &&
      stillToAct.length === 0) {
    await processEndOfBettingRound(newState);
    return;
  }

  if (stillToAct.length === 0) {
    await processEndOfBettingRound(newState);
    return;
  }

  newState.current_player_id = stillToAct[0];
  const timedState = applyTurnDeadline(newState, newState.current_player_id);
  const updatedAt = new Date().toISOString();
  await supabaseClient.from('game_state').update({ state: timedState, updated_at: updatedAt }).eq('room_id', currentRoom.id);
  gameStateUpdatedAt = updatedAt;
}

async function maybeProcessTurnTimeout() {
  if (!currentRoom || currentRoom.status !== 'playing' || !gameState) return;
  if (_turnTimeoutInFlight || isProcessingAction) return;
  if (gameState.round_done || gameState.phase === 'waiting' || gameState.phase === 'showdown') return;

  const timedOutPlayerId = gameState.current_player_id;
  if (!timedOutPlayerId) return;
  if (gameState.action_turn_player_id && gameState.action_turn_player_id !== timedOutPlayerId) return;

  const deadlineMs = getActionDeadlineMs(gameState);
  if (!deadlineMs || Date.now() < deadlineMs) return;

  const now = Date.now();
  if (now - _lastTurnTimeoutAttemptAt < 800) return;
  _lastTurnTimeoutAttemptAt = now;

  const expectedUpdatedAt = gameStateUpdatedAt;
  if (!expectedUpdatedAt) return;

  _turnTimeoutInFlight = true;
  try {
    const lockState = {
      ...gameState,
      timeout_action_lock: {
        by: myPlayerId,
        at: new Date().toISOString(),
        for_player_id: timedOutPlayerId
      }
    };
    const lockUpdatedAt = new Date().toISOString();

    const { data: lockRow, error: lockErr } = await supabaseClient
      .from('game_state')
      .update({ state: lockState, updated_at: lockUpdatedAt })
      .eq('room_id', currentRoom.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('state, updated_at')
      .maybeSingle();

    if (lockErr || !lockRow) return;

    gameState = lockRow.state || gameState;
    gameStateUpdatedAt = lockRow.updated_at;
    await processTimedOutTurn(lockRow.state || lockState, timedOutPlayerId);
  } catch (e) {
    console.error('Turn timeout processing failed:', e);
  } finally {
    _turnTimeoutInFlight = false;
  }
}

async function processUnavailableCurrentTurn(lockedState, unavailablePlayerId) {
  if (!unavailablePlayerId || lockedState.current_player_id !== unavailablePlayerId) return;

  const player = allPlayers.find(p => p.id === unavailablePlayerId);
  const playerName = player?.name || unavailablePlayerId;

  const newState = {
    ...lockedState,
    player_bets: { ...(lockedState.player_bets || {}) },
    player_contributions: { ...(lockedState.player_contributions || {}) },
    acting_order: (lockedState.acting_order || []).filter(id => id !== unavailablePlayerId),
    all_in_players: (lockedState.all_in_players || []).filter(id => id !== unavailablePlayerId),
    active_player_ids: (lockedState.active_player_ids || []).filter(id => id !== unavailablePlayerId),
    timeout_action_lock: null,
    action_turn_player_id: null,
    action_deadline_at: null
  };

  await logAction(currentRoom.id, unavailablePlayerId, playerName, 'folds (left table)', 0);

  const contenders = getHandContenders(newState);
  if (contenders.length <= 1) {
    await processEndOfBettingRound(newState);
    return;
  }

  const eligibleToAct = new Set(
    (newState.active_player_ids || []).filter(id => !(newState.all_in_players || []).includes(id))
  );
  const stillToAct = (newState.acting_order || []).filter(id => eligibleToAct.has(id));

  if ((newState.active_player_ids || []).filter(id => !(newState.all_in_players || []).includes(id)).length <= 1 &&
      stillToAct.length === 0) {
    await processEndOfBettingRound(newState);
    return;
  }

  if (stillToAct.length === 0) {
    await processEndOfBettingRound(newState);
    return;
  }

  newState.current_player_id = stillToAct[0];
  const timedState = applyTurnDeadline(newState, newState.current_player_id);
  const updatedAt = new Date().toISOString();
  await supabaseClient.from('game_state').update({ state: timedState, updated_at: updatedAt }).eq('room_id', currentRoom.id);
  gameStateUpdatedAt = updatedAt;
}

async function maybeProcessUnavailableCurrentTurn() {
  if (!currentRoom || currentRoom.status !== 'playing' || !gameState) return;
  if (_unavailableTurnInFlight || isProcessingAction) return;
  if (gameState.round_done || gameState.phase === 'waiting' || gameState.phase === 'showdown') return;

  const turnPlayerId = gameState.current_player_id;
  if (!turnPlayerId) return;

  const turnPlayer = allPlayers.find(p => p.id === turnPlayerId);
  const hasLeftTable = !turnPlayer || turnPlayer.status === 'out';
  if (!hasLeftTable) return;

  const now = Date.now();
  if (now - _lastUnavailableTurnAttemptAt < 800) return;
  _lastUnavailableTurnAttemptAt = now;

  const expectedUpdatedAt = gameStateUpdatedAt;
  if (!expectedUpdatedAt) return;

  _unavailableTurnInFlight = true;
  try {
    const lockState = {
      ...gameState,
      timeout_action_lock: {
        by: myPlayerId,
        at: new Date().toISOString(),
        for_player_id: turnPlayerId,
        reason: 'left_table'
      }
    };
    const lockUpdatedAt = new Date().toISOString();

    const { data: lockRow, error: lockErr } = await supabaseClient
      .from('game_state')
      .update({ state: lockState, updated_at: lockUpdatedAt })
      .eq('room_id', currentRoom.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('state, updated_at')
      .maybeSingle();

    if (lockErr || !lockRow) return;

    gameState = lockRow.state || gameState;
    gameStateUpdatedAt = lockRow.updated_at;
    await processUnavailableCurrentTurn(lockRow.state || lockState, turnPlayerId);
  } catch (e) {
    console.error('Unavailable turn processing failed:', e);
  } finally {
    _unavailableTurnInFlight = false;
  }
}

function startRoundAdvanceWatcher() {
  if (_roundAdvanceInterval) clearInterval(_roundAdvanceInterval);
  _roundAdvanceInterval = setInterval(() => {
    maybeRepairTurnState();
    maybeProcessUnavailableCurrentTurn();
    maybeProcessTurnTimeout();
    maybeAdvanceRoundAfterPayout();
    patchTurnIndicator();
  }, 1000);
}

function buildPostflopOrder(state) {
  // Post-flop order: start from first active player after dealer
  const activeIds = state.active_player_ids || [];
  if (activeIds.length === 0) return [];

  const seatById = new Map(allPlayers.map(p => [p.id, p.seat]));
  const activePlayers = sortPlayerIdsBySeat(activeIds).map(id => ({ id, seat: seatById.get(id) }));
  const dealerSeat = state.dealer_seat;
  const afterDealer = activePlayers.findIndex(p => p.seat !== undefined && p.seat > dealerSeat);
  const ordered = afterDealer >= 0
    ? [...activePlayers.slice(afterDealer), ...activePlayers.slice(0, afterDealer)]
    : activePlayers;
  return ordered.map(p => p.id);
}

async function logAction(roomId, playerId, playerName, action, amount) {
  await supabaseClient.from('game_actions').insert({ room_id: roomId, player_id: playerId, player_name: playerName, action, amount });
}

// ─── Room Expiry ──────────────────────────────────────────────────
let _expiryInterval = null;

function startRoomExpiryCheck() {
  if (_expiryInterval) clearInterval(_expiryInterval);
  _expiryInterval = setInterval(checkRoomExpiry, 30000);
}

async function checkRoomExpiry() {
  if (!currentRoom || !gameState) return;

  const now = Date.now();

  if (currentRoom.status === 'waiting') {
    // Expire waiting rooms after 10 minutes if only 1 or 0 players
    const { data: room } = await supabaseClient.from('rooms').select('created_at').eq('id', currentRoom.id).single();
    if (!room) return;
    const age = now - new Date(room.created_at).getTime();
    if (age > 10 * 60 * 1000 && allPlayers.length <= 1) {
      await expireRoom('Waiting room closed — no players joined within 10 minutes.');
    }
    return;
  }

  if (currentRoom.status === 'playing') {
    // Expire active rooms after 1 hour of no state changes
    const { data: gs } = await supabaseClient.from('game_state').select('updated_at').eq('room_id', currentRoom.id).single();
    if (!gs) return;
    const idle = now - new Date(gs.updated_at).getTime();
    if (idle > 60 * 60 * 1000) {
      await expireRoom('Room closed due to 1 hour of inactivity.');
    }
  }
}

async function expireRoom(reason) {
  if (_expiryInterval) { clearInterval(_expiryInterval); _expiryInterval = null; }
  await syncMyLiveStats(true);
  await supabaseClient.from('rooms').update({ status: 'finished' }).eq('id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', reason, 0);
  showToast(reason, 'error');
  setTimeout(() => location.reload(), 4000);
}

// ─── Player Stats (Lifetime Leaderboard) ──────────────────────────
async function updatePlayerStats(state, winnerIds, options = {}) {
  const updateNetChips = options.updateNetChips !== false;
  const contributions = state.player_contributions || {};
  const allHandPlayerIds = Object.keys(contributions).filter(id => contributions[id] > 0 || winnerIds.includes(id));
  if (allHandPlayerIds.length === 0) return;

  // Fetch names from current room
  const { data: roomPlayers } = await supabaseClient.from('room_players').select('id, name').in('id', allHandPlayerIds).eq('room_id', currentRoom.id);
  const nameMap = {};
  if (roomPlayers) roomPlayers.forEach(p => nameMap[p.id] = p.name);

  // Fetch existing stats by player_id
  const { data: existingStats } = await supabaseClient.from('player_stats').select('*').in('player_id', allHandPlayerIds);
  const statsMap = {};
  if (existingStats) existingStats.forEach(s => statsMap[s.player_id] = s);

  // For players whose stats weren't found by ID, try a case-insensitive name lookup
  const missingIds = allHandPlayerIds.filter(id => !statsMap[id] && nameMap[id]);
  for (const pid of missingIds) {
    const { data: byName } = await supabaseClient
      .from('player_stats')
      .select('*')
      .ilike('player_name', nameMap[pid])
      .maybeSingle();
    if (byName) statsMap[pid] = byName; // key by original room player_id for lookup below
  }

  const perWinner = winnerIds.length > 0 ? Math.floor(state.pot / winnerIds.length) : 0;
  const upserts = [];

  for (let i = 0; i < allHandPlayerIds.length; i++) {
    const playerId = allHandPlayerIds[i];
    const contribution = contributions[playerId] || 0;
    const isWinner = winnerIds.includes(playerId);
    const winnings = isWinner ? perWinner + (winnerIds.indexOf(playerId) === 0 ? state.pot % winnerIds.length : 0) : 0;
    const netDelta = winnings - contribution;

    const current = statsMap[playerId] || { net_chips: 0, hands_played: 0, hands_won: 0 };
    // Use the canonical player_id from the matched stats row (handles name-based merges)
    const canonicalId = current.player_id || playerId;
    const row = {
      player_id: canonicalId,
      player_name: nameMap[playerId] || 'Unknown',
      hands_played: current.hands_played + 1,
      hands_won: current.hands_won + (isWinner ? 1 : 0),
      last_seen: new Date().toISOString()
    };

    if (updateNetChips) {
      row.net_chips = current.net_chips + netDelta;
    } else if (statsMap[playerId]) {
      row.net_chips = current.net_chips;
    }

    upserts.push(row);
  }

  if (upserts.length > 0) {
    await supabaseClient.from('player_stats').upsert(upserts);
  }
}

async function syncMyLiveStats(force = false) {
  if (!supabaseClient || !currentRoom || !myPlayerId || !myPlayer) return;
  if (isSyncingMyStats) return;

  isSyncingMyStats = true;
  try {
    const now = new Date().toISOString();
    const currentChips = Number(myPlayer.chips || 0);

    if (lastSyncedMyChips === null) {
      lastSyncedMyChips = currentChips;
    }

    const delta = currentChips - lastSyncedMyChips;
    if (!force && delta === 0) return;

    // Look up by player_id first; if missing, fall back to case-insensitive name match
    // so the same person playing from two different browsers merges into one row.
    let existing = null;
    const { data: byId } = await supabaseClient
      .from('player_stats')
      .select('player_id, net_chips, hands_played, hands_won')
      .eq('player_id', myPlayerId)
      .maybeSingle();

    if (byId) {
      existing = byId;
    } else if (myPlayer.name) {
      const { data: byName } = await supabaseClient
        .from('player_stats')
        .select('player_id, net_chips, hands_played, hands_won')
        .ilike('player_name', myPlayer.name)
        .maybeSingle();
      if (byName) {
        existing = byName;
      }
    }

    const canonicalId = existing?.player_id || myPlayerId;
    const nextNet = Number(existing?.net_chips || 0) + delta;
    await supabaseClient.from('player_stats').upsert({
      player_id: canonicalId,
      player_name: myPlayer.name || 'Unknown',
      net_chips: nextNet,
      hands_played: Number(existing?.hands_played || 0),
      hands_won: Number(existing?.hands_won || 0),
      last_seen: now
    });

    lastSyncedMyChips = currentChips;
  } finally {
    isSyncingMyStats = false;
  }
}

async function fetchLeaderboard() {
  const { data } = await supabaseClient.from('player_stats')
    .select('*')
    .order('net_chips', { ascending: false })
    .limit(15);
  return data || [];
}

function renderLeaderboard(players) {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  if (players.length === 0) {
    list.innerHTML = '<div class="lb-empty">No data yet. Play some hands!</div>';
    return;
  }

  const myId = getOrCreatePlayerId();
  list.innerHTML = players.map((p, i) => {
    const isMe = p.player_id === myId;
    const isPositive = p.net_chips >= 0;
    const winRate = p.hands_played > 0 ? Math.round((p.hands_won / p.hands_played) * 100) : 0;
    return `
      <div class="lb-row${isMe ? ' lb-me' : ''}">
        <div class="lb-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</div>
        <div class="lb-player">
          <div class="lb-name">${escHtml(p.player_name)}${isMe ? ' ★' : ''}</div>
          <div class="lb-meta">${p.hands_played} hands · ${winRate}% win rate</div>
        </div>
        <div class="lb-chips ${isPositive ? 'lb-positive' : 'lb-negative'}">
          ${isPositive ? '+' : ''}${p.net_chips.toLocaleString()}
        </div>
      </div>
    `;
  }).join('');
}

let _lbSubscription = null;

async function initLeaderboard() {
  const players = await fetchLeaderboard();
  renderLeaderboard(players);

  // Subscribe to realtime updates
  if (_lbSubscription) supabaseClient.removeChannel(_lbSubscription);
  _lbSubscription = supabaseClient.channel('player_stats_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'player_stats' }, async () => {
      const updated = await fetchLeaderboard();
      renderLeaderboard(updated);
    })
    .subscribe();
}

// ─── Realtime Subscriptions ───────────────────────────────────────
function subscribeToRoom(roomId) {
  // Unsubscribe previous
  for (const sub of subscriptions) {
    supabaseClient.removeChannel(sub);
  }
  subscriptions = [];

  // Subscribe to game_state
  const gsSub = supabaseClient.channel(`game_state:${roomId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'game_state',
      filter: `room_id=eq.${roomId}`
    }, async (payload) => {
      gameState = payload.new?.state || payload.new;
      gameStateUpdatedAt = payload.new?.updated_at || null;
      await refreshPlayers();
      renderGame();
      await maybeRepairTurnState();
      await maybeProcessUnavailableCurrentTurn();
      await maybeProcessTurnTimeout();
      await maybeAdvanceRoundAfterPayout();
    })
    .subscribe();

  // Subscribe to players
  const playerSub = supabaseClient.channel(`room_players:${roomId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'room_players',
      filter: `room_id=eq.${roomId}`
    }, async () => {
      await refreshPlayers();
      renderGame();
      updateWaitingPlayers();
    })
    .subscribe();

  // Subscribe to actions
  const actionSub = supabaseClient.channel(`game_actions:${roomId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'game_actions',
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      addActionEntry(payload.new);
    })
    .subscribe();

  // Subscribe to room status
  const roomSub = supabaseClient.channel(`rooms:${roomId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'rooms',
      filter: `id=eq.${roomId}`
    }, (payload) => {
      currentRoom = payload.new;
      if (currentRoom.status === 'playing') {
        hideWaitingOverlay();
      }
    })
    .subscribe();

  subscriptions = [gsSub, playerSub, actionSub, roomSub];
}

async function refreshPlayers() {
  const { data } = await supabaseClient.from('room_players').select('*').eq('room_id', currentRoom.id).order('seat');
  if (data) {
    allPlayers = data;
    myPlayer = data.find(p => p.id === myPlayerId);
    await syncMyLiveStats();
  }
}

// ─── UI Rendering (anti-flicker, keyed in-place updates) ──────────
// Track previously rendered values to skip no-op updates
let _rnd = 0; // render generation counter
let _prevCommunityCards = [];
let _prevMyCards = null;
let _prevPot = -1;
let _prevPhase = null;
let _prevRound = -1;
let _shownWinner = null;
let _shownGameWinner = null;
let _communityRevealVisibleCount = 0;
let _communityRevealTargetCount = 0;
let _communityRevealTimer = null;

function clearCommunityRevealTimer() {
  if (_communityRevealTimer) {
    clearInterval(_communityRevealTimer);
    _communityRevealTimer = null;
  }
}

function getVisibleCommunityCards() {
  const cards = gameState?.community_cards || [];
  const visible = Math.min(_communityRevealVisibleCount, cards.length);
  return cards.slice(0, visible);
}

function startCommunityRevealSequence() {
  if (_communityRevealTimer) return;
  _communityRevealTimer = setInterval(() => {
    const cards = gameState?.community_cards || [];
    const maxVisible = Math.min(_communityRevealTargetCount, cards.length);
    if (_communityRevealVisibleCount < maxVisible) {
      _communityRevealVisibleCount += 1;
      patchCommunityCards();
      patchMyHand();
      return;
    }
    clearCommunityRevealTimer();
  }, 360);
}

function getVisiblePlayers() {
  return allPlayers.filter(p => p.status !== 'out');
}

function renderGame() {
  if (!gameState || !allPlayers.length) return;
  _rnd++;

  maybeProcessTurnTimeout();
  maybeAdvanceRoundAfterPayout();

  patchTableSeats();
  patchTurnIndicator();
  patchCommunityCards();
  patchPot();
  patchMyHand();
  patchSidebarPlayers();
  renderActionPanel();
  renderPhase();
  checkAndShowWinner();
  checkAndShowGameWinner();
}

function patchTurnIndicator() {
  const el = document.getElementById('turn-indicator');
  if (!el) return;

  const isActionPhase = !!gameState
    && !gameState.round_done
    && gameState.phase !== 'waiting'
    && gameState.phase !== 'showdown';

  if (!isActionPhase || !gameState.current_player_id) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }

  const actingPlayer = allPlayers.find(p => p.id === gameState.current_player_id);
  if (!actingPlayer) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }

  const isMe = actingPlayer.id === myPlayerId;
  const deadlineMs = getActionDeadlineMs(gameState);
  const secondsLeft = deadlineMs
    ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
    : TURN_ACTION_SECONDS;
  el.style.display = '';
  el.textContent = isMe
    ? `YOUR TURN · ${secondsLeft}s`
    : `${actingPlayer.name.toUpperCase()} TO ACT · ${secondsLeft}s`;
}

// ── Seats: create once per slot, patch content each render ────────
function patchTableSeats() {
  const container = document.getElementById('seat-container');
  if (!container) return;

  for (let i = 0; i < 7; i++) {
    let el = document.getElementById(`seat-el-${i}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `seat-el-${i}`;
      el.className = `player-seat seat-${i}`;
      container.appendChild(el);
    }
    patchSeat(el, i);
  }
}

function patchSeat(el, seatIdx) {
  const player = getVisiblePlayers().find(p => p.seat === seatIdx);

  if (!player) {
    // Only rebuild if it wasn't already empty
    if (el.dataset.pid !== '') {
      el.className = `player-seat seat-${seatIdx} empty`;
      el.innerHTML = `<div class="player-avatar">+</div><div class="player-info" style="opacity:0.3"><div class="player-name">Empty</div></div>`;
      el.dataset.pid = '';
    }
    return;
  }

  const isMe = player.id === myPlayerId;
  const isTurn = gameState.current_player_id === player.id
    && gameState.phase !== 'waiting' && gameState.phase !== 'showdown';
  const isFolded = player.status === 'folded';
  const isAllIn = player.status === 'all_in';
  const isDealer = gameState.dealer_seat === player.seat;
  const isSB = gameState.small_blind_player_id === player.id;
  const isBB = gameState.big_blind_player_id === player.id;
  const currentBet = gameState.player_bets?.[player.id] || 0;

  // Build a key of everything that could visually change this seat
  const cardsKey = gameState.phase !== 'waiting' && gameState.hands
    ? JSON.stringify(gameState.hands[player.id]) + gameState.phase
    : 'none';
  const sdDecision = (gameState.showdown_decisions || {})[player.id];
  const optReveal = (gameState.optional_reveals || {})[player.id];
  const key = `${player.id}|${player.chips}|${player.status}|${isTurn}|${isDealer}|${isSB}|${isBB}|${currentBet}|${cardsKey}|${sdDecision}|${optReveal}`;

  if (el.dataset.key === key) return; // nothing changed
  el.dataset.key = key;
  el.dataset.pid = player.id;

  // Determine CSS classes (toggle, no full teardown)
  el.className = `player-seat seat-${seatIdx}${isMe ? ' is-me' : ''}${isTurn ? ' is-turn' : ''}${isFolded ? ' folded' : ''}`;

  const avatarEmoji = getPlayerAvatar(player.name);
  const betHtml = currentBet > 0 && gameState.phase !== 'waiting' && gameState.phase !== 'showdown'
    ? `<div class="player-bet-display">$${currentBet}</div>` : '';

  let cardsHtml = '';
  const inGame = gameState.phase !== 'waiting' && gameState.hands;
  if (inGame) {
    const decisions = gameState.showdown_decisions || {};
    const optReveals = gameState.optional_reveals || {};
    const showFaceUp = isMe ||
      (gameState.phase === 'showdown' && !isFolded && decisions[player.id] === true) ||
      (gameState.phase === 'showdown' && isFolded && optReveals[player.id] === true) ||
      (gameState.round_done && !isFolded && (decisions[player.id] === true || optReveals[player.id] === true));
    const playerCards = gameState.hands[player.id];
    if (isFolded) {
      cardsHtml = `<div class="folded-text">Folded</div>`;
    } else if (showFaceUp && playerCards) {
      const newHand = !el.dataset.cardsDealt || el.dataset.roundDealt !== String(gameState.round_number);
      const dealClass = newHand ? ' deal-in' : '';
      cardsHtml = `<div class="seat-cards">${playerCards.map((c, ci) => pocketCardHtml(c, true, dealClass, ci * 80)).join('')}</div>`;
      el.dataset.cardsDealt = '1';
      el.dataset.roundDealt = String(gameState.round_number);
      } else if (!isFolded && playerCards) {
      const newHand = !el.dataset.cardsDealt || el.dataset.roundDealt !== String(gameState.round_number);
      const dealClass = newHand ? ' deal-in' : '';
      cardsHtml = `<div class="seat-cards">
        <div class="pocket-card${dealClass}" style="animation-delay:0ms">🂠</div>
        <div class="pocket-card${dealClass}" style="animation-delay:80ms">🂠</div>
      </div>`;
      el.dataset.cardsDealt = '1';
      el.dataset.roundDealt = String(gameState.round_number);
    }
  }

  const allInBadge = isAllIn ? '<div class="all-in-badge">ALL-IN</div>' : '';
  const turnBadge = isTurn ? '<div class="turn-seat-badge">TURN</div>' : '';

  el.innerHTML = `
    <div class="player-avatar">
      ${avatarEmoji}
      ${turnBadge}
      ${isDealer ? '<div class="dealer-btn">D</div>' : ''}
      ${isSB ? '<div class="blind-badge sb-badge">SB</div>' : ''}
      ${isBB ? '<div class="blind-badge bb-badge">BB</div>' : ''}
    </div>
    ${cardsHtml}
    <div class="player-info">
      <div class="player-name">${escHtml(player.name)}${isMe ? ' ★' : ''}</div>
      <div class="player-chips-display">$${player.chips}</div>
      ${allInBadge}
    </div>
    ${betHtml}
  `;
}

function pocketCardHtml(cardStr, revealed, extraClass = '', delayMs = 0) {
  if (!revealed) return `<div class="pocket-card${extraClass}" style="animation-delay:${delayMs}ms">🂠</div>`;
  const { rank, suit, suitCode } = cardDisplay(cardStr);
  const isRed = suitCode === 'h' || suitCode === 'd';
  return `<div class="pocket-card revealed ${isRed ? 'red' : ''}${extraClass}" style="animation-delay:${delayMs}ms">${rank}${suit}</div>`;
}

// ── Community cards: only flip-animate newly added cards ──────────
function patchCommunityCards() {
  const container = document.getElementById('community-cards');
  if (!container) return;

  const cards = gameState.community_cards || [];
  const phase = gameState.phase;
  const baseVisibleSlots = phase === 'turn' ? 4 : (phase === 'river' || phase === 'showdown') ? 5 : 3;
  const visibleSlots = Math.max(baseVisibleSlots, cards.length);
  const isNewRound = gameState.round_number !== _prevRound;
  if (isNewRound) {
    clearCommunityRevealTimer();
    // On first load in the middle of a hand, show board immediately.
    const isFirstRender = _prevRound === -1;
    _communityRevealVisibleCount = isFirstRender ? cards.length : 0;
    _communityRevealTargetCount = cards.length;
    _prevCommunityCards = [];
    _prevRound = gameState.round_number;
    _shownWinner = null;
  }

  if (!isNewRound && cards.length > _communityRevealTargetCount) {
    const delta = cards.length - _communityRevealTargetCount;
    _communityRevealTargetCount = cards.length;

    if (delta > 1) {
      // Flop: reveal one immediately, then drip remaining cards.
      _communityRevealVisibleCount = Math.min(_communityRevealVisibleCount + 1, cards.length);
      startCommunityRevealSequence();
    } else {
      _communityRevealVisibleCount = cards.length;
      clearCommunityRevealTimer();
    }
  }

  if (cards.length < _communityRevealVisibleCount) {
    _communityRevealVisibleCount = cards.length;
    _communityRevealTargetCount = cards.length;
    clearCommunityRevealTimer();
  }

  const visibleCards = cards.slice(0, Math.min(_communityRevealVisibleCount, cards.length));

  const newlyRevealedIndexes = [];
  for (let i = 0; i < visibleCards.length; i++) {
    if (_prevCommunityCards[i] !== visibleCards[i]) newlyRevealedIndexes.push(i);
  }
  const revealDelayByIndex = new Map(
    newlyRevealedIndexes.map((cardIdx, revealOrder) => [cardIdx, revealOrder * 170])
  );

  for (let i = 0; i < 5; i++) {
    let el = document.getElementById(`cc-${i}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `cc-${i}`;
      container.appendChild(el);
    }

    el.style.display = i < visibleSlots ? '' : 'none';
    if (i >= visibleSlots) continue;

    if (i >= visibleCards.length) {
      if (el.className !== 'community-card placeholder') {
        el.className = 'community-card placeholder';
        el.innerHTML = '';
        el.style.animationDelay = '0ms';
        _prevCommunityCards[i] = null;
      }
      continue;
    }

    // Card exists — only update if it's newly placed (or round reset)
    if (_prevCommunityCards[i] === visibleCards[i]) continue;
    _prevCommunityCards[i] = visibleCards[i];

    const { rank, suit, suitCode } = cardDisplay(visibleCards[i]);
    const isRed = suitCode === 'h' || suitCode === 'd';
    const revealDelayMs = revealDelayByIndex.get(i) || 0;
    el.className = `community-card ${isRed ? 'red' : 'black'} card-flip-in`;
    el.style.animationDelay = `${revealDelayMs}ms`;
    el.innerHTML = `
      <div class="card-rank">${rank}</div>
      <div class="card-suit">${suit}</div>
      <div class="card-center-suit">${suit}</div>
    `;
    // Remove animation class after it completes so re-renders don't re-trigger it
    const captured = el;
    setTimeout(() => {
      captured.classList.remove('card-flip-in');
      captured.style.animationDelay = '0ms';
    }, 650 + revealDelayMs);
  }
}

// ── Pot: animate when value changes ──────────────────────────────
function patchPot() {
  const el = document.getElementById('pot-amount');
  if (!el) return;
  const newPot = gameState.pot || 0;
  if (newPot !== _prevPot) {
    if (_prevPot >= 0) {
      el.classList.remove('pot-bump');
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add('pot-bump');
    }
    el.textContent = `$${newPot}`;
    _prevPot = newPot;
  }
}

// ── My hand: only re-render when cards change ─────────────────────
function patchMyHand() {
  const container = document.getElementById('my-cards');
  const handName = document.getElementById('hand-name');
  if (!container) return;

  const cards = gameState.hands?.[myPlayerId] ?? null;
  const cardsKey = cards ? cards.join(',') : null;
  const isNewDeal = cardsKey !== _prevMyCards;
  _prevMyCards = cardsKey;

  if (!cards) {
    if (isNewDeal) {
      container.innerHTML = `
        <div class="my-card face-down"><div class="card-rank">?</div></div>
        <div class="my-card face-down"><div class="card-rank">?</div></div>
      `;
    }
    if (handName) handName.textContent = '';
    const chipsEl = document.getElementById('my-chips-big');
    if (chipsEl && myPlayer) chipsEl.textContent = `$${myPlayer.chips}`;
    return;
  }

  if (isNewDeal) {
    container.innerHTML = '';
    cards.forEach((cardStr, i) => {
      const { rank, suit, suitCode } = cardDisplay(cardStr);
      const isRed = suitCode === 'h' || suitCode === 'd';
      const div = document.createElement('div');
      div.className = `my-card ${isRed ? 'red' : 'black'} my-card-deal-in`;
      div.style.animationDelay = `${i * 120}ms`;
      div.innerHTML = `
        <div class="card-rank">${rank}</div>
        <div class="card-suit">${suit}</div>
        <div class="card-center-suit">${suit}</div>
      `;
      container.appendChild(div);
      setTimeout(() => div.classList.remove('my-card-deal-in'), 600 + i * 120);
    });
  }

  // Hand strength + highlight best-hand cards
  const community = getVisibleCommunityCards();
  if (handName) {
    if (community.length >= 3) {
      const ev = evaluateHand([...cards, ...community]);
      handName.textContent = ev ? ev.name : '';
    } else {
      handName.textContent = '';
    }
  }

  // Apply best-card highlights
  const highlightSet = community.length >= 3
    ? new Set(getHighlightCards(cards, community))
    : new Set();
  const cardEls = container.querySelectorAll('.my-card');
  cardEls.forEach((el, i) => {
    if (cards[i] && highlightSet.has(cards[i])) {
      el.classList.add('best-card');
    } else {
      el.classList.remove('best-card');
    }
  });

  // Highlight community cards
  for (let i = 0; i < 5; i++) {
    const ccEl = document.getElementById(`cc-${i}`);
    if (!ccEl) continue;
    const card = community[i];
    if (card && highlightSet.has(card)) {
      ccEl.classList.add('best-card');
    } else {
      ccEl.classList.remove('best-card');
    }
  }

  const chipsEl = document.getElementById('my-chips-big');
  if (chipsEl && myPlayer) chipsEl.textContent = `$${myPlayer.chips}`;
}

// ── Sidebar players: update rows in-place ─────────────────────────
function patchSidebarPlayers() {
  const list = document.getElementById('players-list');
  if (!list) return;
  const visiblePlayers = getVisiblePlayers();

  // Remove rows for players who left
  list.querySelectorAll('[data-player-row]').forEach(row => {
    if (!visiblePlayers.find(p => p.id === row.dataset.playerRow)) row.remove();
  });

  visiblePlayers.forEach((player, idx) => {
    const isMe = player.id === myPlayerId;
    const isTurn = gameState.current_player_id === player.id
      && !gameState.round_done
      && gameState.phase !== 'waiting'
      && gameState.phase !== 'showdown';
    const statusClass = player.status === 'folded' ? 'status-folded'
      : player.status === 'all_in' ? 'status-allin'
      : isTurn ? 'status-active' : '';
    const statusText = player.status === 'folded' ? 'Folded'
      : player.status === 'all_in' ? 'All-in'
      : isTurn ? '● Acting...' : '';

    let row = list.querySelector(`[data-player-row="${player.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'player-row';
      row.dataset.playerRow = player.id;
      list.appendChild(row);
    }

    row.classList.toggle('is-turn-row', isTurn);

    // Move to correct position
    const rows = [...list.querySelectorAll('[data-player-row]')];
    if (rows[idx] !== row) list.insertBefore(row, rows[idx] || null);

    const key = `${player.chips}|${player.status}|${isTurn}`;
    if (row.dataset.key === key) return;
    row.dataset.key = key;

    row.innerHTML = `
      <div class="player-row-avatar">${getPlayerAvatar(player.name)}</div>
      <div class="player-row-info">
        <div class="player-row-name">${escHtml(player.name)}</div>
        <div class="player-row-chips">$${player.chips}</div>
        ${statusText ? `<div class="player-row-status ${statusClass}">${statusText}</div>` : ''}
      </div>
      ${isMe ? '<div class="is-you-badge">You</div>' : ''}
    `;
  });
}

function renderActionPanel() {
  const panel = document.getElementById('action-panel');
  const statusText = document.getElementById('game-status-text');
  if (!panel || !statusText) return;

  const isMyTurn = gameState.current_player_id === myPlayerId;
  const myStatus = myPlayer?.status;

  // Helper to toggle betting vs showdown buttons
  const showBtn = document.getElementById('btn-show-hand');
  const muckBtn = document.getElementById('btn-muck-hand');
  const foldBtn = document.getElementById('btn-fold');
  const checkBtn = document.getElementById('btn-check');
  const callBtn = document.getElementById('btn-call');
  const raiseBtn = document.getElementById('btn-raise');
  const allinBtn = document.getElementById('btn-allin');
  const rebuyBtn = document.getElementById('btn-rebuy');
  const raiseControls = document.getElementById('raise-controls');
  const chipBtnsContainer = panel.querySelector('.chip-buttons');

  function showBettingButtons() {
    if (foldBtn) foldBtn.style.display = '';
    if (checkBtn) checkBtn.style.display = '';
    if (raiseBtn) raiseBtn.style.display = '';
    if (allinBtn) allinBtn.style.display = '';
    if (showBtn) showBtn.style.display = 'none';
    if (muckBtn) muckBtn.style.display = 'none';
    if (rebuyBtn) rebuyBtn.style.display = 'none';
    if (chipBtnsContainer) chipBtnsContainer.style.display = '';
  }

  function showShowdownButtons(showText, muckVisible) {
    if (foldBtn) foldBtn.style.display = 'none';
    if (checkBtn) checkBtn.style.display = 'none';
    if (callBtn) callBtn.style.display = 'none';
    if (raiseBtn) raiseBtn.style.display = 'none';
    if (allinBtn) allinBtn.style.display = 'none';
    if (rebuyBtn) rebuyBtn.style.display = 'none';
    if (raiseControls) raiseControls.classList.remove('visible');
    if (chipBtnsContainer) chipBtnsContainer.style.display = 'none';
    if (showBtn) { showBtn.style.display = ''; showBtn.textContent = showText; }
    if (muckBtn) muckBtn.style.display = muckVisible ? '' : 'none';
  }

  function hideAllButtons() {
    if (foldBtn) foldBtn.style.display = 'none';
    if (checkBtn) checkBtn.style.display = 'none';
    if (callBtn) callBtn.style.display = 'none';
    if (raiseBtn) raiseBtn.style.display = 'none';
    if (allinBtn) allinBtn.style.display = 'none';
    if (showBtn) showBtn.style.display = 'none';
    if (muckBtn) muckBtn.style.display = 'none';
    if (rebuyBtn) rebuyBtn.style.display = 'none';
    if (raiseControls) raiseControls.classList.remove('visible');
    if (chipBtnsContainer) chipBtnsContainer.style.display = 'none';
  }

  function showRebuyButton() {
    hideAllButtons();
    if (rebuyBtn) rebuyBtn.style.display = '';
    panel.classList.add('visible');
  }

  if (gameState.phase === 'waiting') {
    panel.classList.remove('visible');
    statusText.textContent = 'Waiting for game to start...';
    statusText.className = 'game-status-text';
    return;
  }

  if (currentRoom?.status === 'finished' || gameState.game_over) {
    panel.classList.remove('visible');
    hideAllButtons();
    const winnerName = gameState.game_winner_name;
    statusText.textContent = winnerName
      ? `${winnerName} wins the game!`
      : 'Game finished.';
    statusText.className = 'game-status-text highlight';
    return;
  }

  // Showdown ordered show/muck phase
  if (gameState.phase === 'showdown' && gameState.showdown_needed && !gameState.round_done) {
    const needed = gameState.showdown_needed || [];
    const decisions = gameState.showdown_decisions || {};
    const currentShowdownPlayerId = gameState.showdown_current_player_id || needed.find(id => decisions[id] === undefined) || null;
    const currentPlayer = allPlayers.find(p => p.id === currentShowdownPlayerId);
    const remaining = needed.filter(id => decisions[id] === undefined).length;

    if (myPlayerId === currentShowdownPlayerId) {
      panel.classList.add('visible');
      showShowdownButtons('Show Hand', true);
      statusText.textContent = 'Showdown: your turn to show or muck.';
      statusText.className = 'game-status-text highlight';
    } else {
      panel.classList.remove('visible');
      hideAllButtons();
      statusText.textContent = remaining > 0
        ? `Showdown: waiting for ${currentPlayer?.name || 'next player'} (${remaining} left)`
        : 'Showdown resolving...';
      statusText.className = 'game-status-text';
    }
    return;
  }

  if (gameState.round_done) {
    const winners = gameState.winners || [];
    const winnerNames = winners
      .map(id => allPlayers.find(p => p.id === id)?.name)
      .filter(Boolean);
    const evalById = new Map((gameState.evaluations || []).map(ev => [ev.id, ev]));
    const winnerHands = winners
      .map(id => evalById.get(id)?.hand?.name)
      .filter(Boolean);
    const splitText = winners.length > 1 ? 'split the pot' : 'wins the pot';
    const baseText = winnerNames.length
      ? `${winnerNames.join(' & ')} ${splitText}`
      : 'Hand complete';
    const handText = winnerHands.length ? ` with ${winnerHands.join(' / ')}` : '';
    const nextHandAtMs = getNextHandAtMs(gameState, gameStateUpdatedAt);
    const secsLeft = Math.max(0, Math.ceil((nextHandAtMs - Date.now()) / 1000));
    const nextHandText = secsLeft > 0
      ? ` Next hand in ${secsLeft}s...`
      : ' Next hand starting...';

    const canWinnerReveal = winners.includes(myPlayerId) && !!gameState.hands?.[myPlayerId];
    if (canWinnerReveal) {
      panel.classList.add('visible');
      showShowdownButtons('Show Hand', false);
      statusText.textContent = `${baseText}${handText}.${nextHandText}`;
      statusText.className = 'game-status-text highlight';
    } else {
      panel.classList.remove('visible');
      hideAllButtons();
      statusText.textContent = `${baseText}${handText}.${nextHandText}`;
      statusText.className = 'game-status-text highlight';
    }
    return;
  }

  if (myStatus === 'folded') {
    panel.classList.remove('visible');
    statusText.textContent = 'You folded. Watching...';
    statusText.className = 'game-status-text';
    return;
  }

  if (myStatus === 'all_in') {
    panel.classList.remove('visible');
    statusText.textContent = 'You are all-in!';
    statusText.className = 'game-status-text highlight';
    return;
  }

  if (myStatus === 'out') {
    showRebuyButton();
    statusText.textContent = 'You busted. Click Rebuy to join the next hand.';
    statusText.className = 'game-status-text highlight';
    return;
  }

  if (!isMyTurn) {
    panel.classList.remove('visible');
    const currentPlayer = allPlayers.find(p => p.id === gameState.current_player_id);
    statusText.textContent = currentPlayer ? `Waiting for ${currentPlayer.name}...` : 'Waiting...';
    statusText.className = 'game-status-text';
    return;
  }

  // It's my turn — show betting buttons
  panel.classList.add('visible');
  showBettingButtons();
  statusText.textContent = '';

  const myBet = gameState.player_bets?.[myPlayerId] || 0;
  const currentBet = gameState.current_bet || 0;
  const toCall = currentBet - myBet;

  // Show/hide check vs call
  if (checkBtn && callBtn) {
    if (toCall === 0) {
      checkBtn.style.display = '';
      callBtn.style.display = 'none';
    } else {
      checkBtn.style.display = 'none';
      callBtn.style.display = '';
      callBtn.textContent = `Call $${Math.min(toCall, myPlayer?.chips || 0)}`;
    }
  }

  // Update raise input min
  const raiseInput = document.getElementById('raise-input');
  if (raiseInput) {
    raiseInput.min = currentBet > 0 ? currentBet * 2 : (currentRoom?.big_blind || 20);
    raiseInput.placeholder = `Min: $${raiseInput.min}`;
  }

  // Chip quick buttons
  const bb = currentRoom?.big_blind || 20;
  const multipliers = [2, 3, 4];
  const chipBtns = document.querySelectorAll('.chip-size-btn');
  chipBtns.forEach((btn, i) => {
    const val = currentBet + (bb * multipliers[i]);
    btn.textContent = `${multipliers[i]}x BB`;
    btn.onclick = () => {
      if (raiseInput) raiseInput.value = val;
    };
  });
}

function renderPhase() {
  const el = document.getElementById('phase-badge');
  if (!el || !gameState.phase) return;
  const phaseNames = { waiting: 'Waiting', preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };
  el.textContent = phaseNames[gameState.phase] || gameState.phase;

  // Flash banner when phase changes (flop/turn/river/showdown)
  if (gameState.phase !== _prevPhase && ['flop','turn','river','showdown'].includes(gameState.phase)) {
    showPhaseBanner(phaseNames[gameState.phase]);
  }
  _prevPhase = gameState.phase;
}

function showPhaseBanner(text) {
  const existing = document.getElementById('phase-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'phase-banner';
  banner.className = 'phase-banner';
  banner.textContent = text;
  document.getElementById('table-center-wrap')?.appendChild(banner) ||
    document.querySelector('.table-center')?.appendChild(banner);
  setTimeout(() => banner.remove(), 1400);
}

function checkAndShowWinner() {
  if (!gameState?.round_done) return;
  const winners = gameState.winners || [];
  if (!winners.length) return;

  const winnerKey = `${gameState.round_number || 0}|${(winners || []).join(',')}|${gameState.round_done_at || ''}`;
  if (_shownWinner === winnerKey) return;
  _shownWinner = winnerKey;
}

function checkAndShowGameWinner() {
  if (!(currentRoom?.status === 'finished' || gameState?.game_over)) return;

  const winnerId = gameState?.game_winner_id || null;
  const key = `${currentRoom?.id || ''}|${winnerId || 'none'}|${gameState?.game_finished_at || ''}`;
  if (_shownGameWinner === key) return;
  _shownGameWinner = key;
}

// ─── Waiting Room ─────────────────────────────────────────────────
function showWaitingOverlay(roomId) {
  const overlay = document.getElementById('waiting-overlay');
  if (!overlay) return;
  document.getElementById('waiting-room-code').textContent = roomId;
  overlay.classList.add('visible');
  updateWaitingPlayers();
}

function hideWaitingOverlay() {
  const overlay = document.getElementById('waiting-overlay');
  if (overlay) overlay.classList.remove('visible');
}

async function updateWaitingPlayers() {
  if (!currentRoom) return;
  const list = document.getElementById('waiting-players-list');
  if (!list) return;
  const visiblePlayers = getVisiblePlayers();
  list.innerHTML = visiblePlayers.map(p => `
    <div class="waiting-player-item">
      <div class="waiting-player-dot"></div>
      <span>${escHtml(p.name)}${p.id === currentRoom.host_id ? ' (Host)' : ''}${p.id === myPlayerId ? ' (You)' : ''}</span>
    </div>
  `).join('');

  const startBtn = document.getElementById('waiting-start-btn');
  if (startBtn) {
    startBtn.style.display = myPlayerId === currentRoom?.host_id ? 'block' : 'none';
    startBtn.disabled = visiblePlayers.length < 2;
    startBtn.textContent = visiblePlayers.length < 2 ? 'Waiting for players...' : `Start Game (${visiblePlayers.length} players)`;
  }
}

async function rebuyMyPlayer() {
  if (!currentRoom || !myPlayer) return;
  if (myPlayer.status !== 'out') return;

  await supabaseClient.from('room_players').update({
    chips: currentRoom.starting_chips,
    status: 'waiting',
    is_connected: true
  }).eq('id', myPlayerId).eq('room_id', currentRoom.id);

  await logAction(currentRoom.id, myPlayerId, myPlayer.name, `rebuys ($${currentRoom.starting_chips})`, currentRoom.starting_chips);
  showToast(`Rebuy successful: $${currentRoom.starting_chips}`, 'success');
}

// ─── UI Helpers ───────────────────────────────────────────────────
function addActionEntry(entry) {
  const log = document.getElementById('action-log');
  if (!log) return;

  const div = document.createElement('div');
  div.className = `action-entry ${entry.player_id === 'system' ? 'system' : ''}`;

  if (entry.player_id === 'system') {
    div.innerHTML = `<span>${escHtml(entry.action)}</span>`;
  } else {
    div.innerHTML = `
      <span class="player-label">${escHtml(entry.player_name)}</span>
      <span class="action-label">${escHtml(entry.action)}</span>
      ${entry.amount > 0 ? `<span class="amount-label">$${entry.amount}</span>` : ''}
    `;
  }

  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3100);
}

function getPlayerAvatar(name) {
  const emojis = ['🎭','🃏','🦁','🐯','🦊','🐻','🦝','🦅','🐉','🦄','🎸','🚀'];
  const idx = name.charCodeAt(0) % emojis.length;
  return emojis[idx];
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ─── Main Lobby Logic ─────────────────────────────────────────────
async function initLobby() {
  await Promise.all([loadRoomsList(), initLeaderboard(), cleanupStaleRooms()]);
  // Auto-refresh rooms every 5s; sweep stale rooms every 2 minutes
  setInterval(loadRoomsList, 5000);
  setInterval(cleanupStaleRooms, 2 * 60 * 1000);
}

// Sweep rooms that are stuck in waiting/playing states with no activity.
// This runs on every lobby visit so stale rooms get cleared even when no
// player is actively inside them.
async function cleanupStaleRooms() {
  try {
    const now = Date.now();

    // ── Waiting rooms ──────────────────────────────────────────────
    // Close any waiting room that has been open longer than 30 minutes,
    // or longer than 5 minutes if it has zero connected players.
    const { data: waitingRooms } = await supabaseClient
      .from('rooms')
      .select('id, created_at')
      .eq('status', 'waiting')
      .lt('created_at', new Date(now - 5 * 60 * 1000).toISOString()); // skip rooms < 5 min old

    if (waitingRooms?.length) {
      for (const room of waitingRooms) {
        const age = now - new Date(room.created_at).getTime();

        // Count players that are still connected/waiting (not 'out')
        const { data: activePlayers } = await supabaseClient
          .from('room_players')
          .select('id')
          .eq('room_id', room.id)
          .neq('status', 'out')
          .eq('is_connected', true);

        const connected = activePlayers?.length || 0;

        const shouldClose =
          (connected === 0 && age > 5 * 60 * 1000) ||   // empty for 5 min
          (connected <= 1 && age > 15 * 60 * 1000) ||   // 1 player for 15 min
          age > 30 * 60 * 1000;                          // anyone for 30 min

        if (shouldClose) {
          await supabaseClient.from('rooms').update({ status: 'finished' }).eq('id', room.id);
        }
      }
    }

    // ── Playing rooms ──────────────────────────────────────────────
    // Close any playing room where the game_state hasn't been touched
    // for more than 1 hour.
    const { data: playingRooms } = await supabaseClient
      .from('rooms')
      .select('id')
      .eq('status', 'playing');

    if (playingRooms?.length) {
      const roomIds = playingRooms.map(r => r.id);
      const { data: gameStates } = await supabaseClient
        .from('game_state')
        .select('room_id, updated_at')
        .in('room_id', roomIds);

      const stalePlayingIds = (gameStates || [])
        .filter(gs => now - new Date(gs.updated_at).getTime() > 60 * 60 * 1000)
        .map(gs => gs.room_id);

      if (stalePlayingIds.length) {
        await supabaseClient.from('rooms').update({ status: 'finished' }).in('id', stalePlayingIds);
      }
    }
  } catch (e) {
    // Non-critical — silently ignore cleanup errors
  }
}

async function loadRoomsList() {
  const list = document.getElementById('rooms-list');
  if (!list) return;
  const rooms = await fetchRooms();
  if (rooms.length === 0) {
    list.innerHTML = '<div class="empty-rooms">No open rooms. Create one!</div>';
    return;
  }
  list.innerHTML = rooms.map(r => {
    const isPlaying = r.status === 'playing';
    const playerCount = r.room_players?.[0]?.count || 0;
    return `
      <div class="room-card${isPlaying ? ' room-playing' : ''}" onclick="quickJoinRoom('${r.id}')">
        <div class="room-info">
          <div class="room-name">Room ${r.id}</div>
          <div class="room-meta">Blinds: $${r.small_blind}/$${r.big_blind} · Chips: $${r.starting_chips}</div>
        </div>
        <div class="room-badge-group">
          ${isPlaying ? '<div class="room-status-badge playing">In Progress</div>' : ''}
          <div class="room-badge">${playerCount}/${r.max_players}</div>
        </div>
      </div>
    `;
  }).join('');
}

function quickJoinRoom(roomId) {
  document.getElementById('join-room-id').value = roomId;
  document.querySelector('[data-tab="join"]').click();
}

// ─── Event Handlers (called from HTML) ────────────────────────────
async function handleCreateRoom(e) {
  e.preventDefault();
  const name = document.getElementById('create-name').value.trim();
  const maxP = parseInt(document.getElementById('create-max-players').value);
  const sb = parseInt(document.getElementById('create-sb').value);
  const bb = parseInt(document.getElementById('create-bb').value);
  const chips = parseInt(document.getElementById('create-chips').value);

  if (!name) { showToast('Enter your name', 'error'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating...';

  try {
    const roomId = await createRoom(name, maxP, sb, bb, chips);
    await enterGame(roomId);
  } catch (err) {
    showToast(err.message || 'Failed to create room', 'error');
    btn.disabled = false; btn.textContent = 'Create Room';
  }
}

async function handleJoinRoom(e) {
  e.preventDefault();
  const name = document.getElementById('join-name').value.trim();
  const roomId = document.getElementById('join-room-id').value.trim().toUpperCase();

  if (!name) { showToast('Enter your name', 'error'); return; }
  if (!roomId) { showToast('Enter room code', 'error'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Joining...';

  try {
    const { room, isRebuy } = await joinRoom(roomId, name);
    currentRoom = room;
    if (isRebuy) showToast(`Rebuy! Rejoined with $${room.starting_chips}`, 'success');
    await enterGame(roomId);
  } catch (err) {
    showToast(err.message || 'Failed to join room', 'error');
    btn.disabled = false; btn.textContent = 'Join Room';
  }
}

async function enterGame(roomId) {
  // Fetch room if needed
  if (!currentRoom) {
    const { data } = await supabaseClient.from('rooms').select('*').eq('id', roomId).single();
    currentRoom = data;
  }

  lastSyncedMyChips = null;

  showScreen('game-screen');
  document.getElementById('room-code').textContent = roomId;

  // Fetch initial data
  await refreshPlayers();

  // Save session so we can auto-reconnect on page reload / DC
  if (myPlayer?.name) {
    localStorage.setItem('poker_last_room', roomId);
    localStorage.setItem('poker_last_name', myPlayer.name);
  }
  const { data: gsData } = await supabaseClient.from('game_state').select('*').eq('room_id', roomId).single();
  if (gsData) {
    gameState = gsData.state;
    gameStateUpdatedAt = gsData.updated_at || null;
  }

  // Subscribe to realtime
  subscribeToRoom(roomId);

  // Load recent actions
  const { data: actions } = await supabaseClient.from('game_actions').select('*').eq('room_id', roomId).order('created_at').limit(50);
  if (actions) actions.forEach(addActionEntry);

  // Show waiting overlay if game hasn't started
  if (!currentRoom || currentRoom.status === 'waiting') {
    showWaitingOverlay(roomId);
  }

  startRoomExpiryCheck();
  startRoundAdvanceWatcher();
  renderGame();
  hideLoading();
}

// Waiting overlay player refresh (realtime triggers this)
async function onPlayersChanged() {
  await refreshPlayers();
  updateWaitingPlayers();
  patchSidebarPlayers();
}

// ─── Auto-Reconnect ───────────────────────────────────────────────
async function tryAutoReconnect() {
  const lastRoom = localStorage.getItem('poker_last_room');
  const lastName = localStorage.getItem('poker_last_name');
  if (!lastRoom || !lastName) return false;

  try {
    myPlayerId = getOrCreatePlayerId();
    const { data: room } = await supabaseClient.from('rooms').select('*').eq('id', lastRoom).single();
    const { data: player } = await supabaseClient.from('room_players').select('*')
      .eq('id', myPlayerId).eq('room_id', lastRoom).maybeSingle();

    if (room && room.status !== 'finished' && player && player.status !== 'out') {
      currentRoom = room;
      await supabaseClient.from('room_players').update({ is_connected: true })
        .eq('id', myPlayerId).eq('room_id', lastRoom);
      showToast('Reconnecting to game...', 'success');
      await enterGame(lastRoom);
      return true;
    }
  } catch (e) {
    // Could not reconnect — fall through to lobby
  }

  localStorage.removeItem('poker_last_room');
  localStorage.removeItem('poker_last_name');
  return false;
}

// ─── Bootstrap ────────────────────────────────────────────────────
function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) { overlay.classList.add('hidden'); setTimeout(() => overlay.style.display = 'none', 500); }
}

window.addEventListener('DOMContentLoaded', async () => {
  initSupabase();

  // Try to silently reconnect to an in-progress game before showing the lobby
  const didReconnect = await tryAutoReconnect();
  if (!didReconnect) {
    showScreen('lobby-screen');
    await initLobby();
    hideLoading();
  }

  // Tab switching
  document.querySelectorAll('.lobby-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lobby-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab)?.classList.add('active');
    });
  });

  // Create room form
  document.getElementById('create-form')?.addEventListener('submit', handleCreateRoom);
  document.getElementById('join-form')?.addEventListener('submit', handleJoinRoom);

  // Action buttons
  document.getElementById('btn-fold')?.addEventListener('click', () => playerAction('fold'));
  document.getElementById('btn-check')?.addEventListener('click', () => playerAction('check'));
  document.getElementById('btn-call')?.addEventListener('click', () => playerAction('call'));
  document.getElementById('btn-allin')?.addEventListener('click', () => playerAction('allin'));

  document.getElementById('btn-raise')?.addEventListener('click', () => {
    const controls = document.getElementById('raise-controls');
    controls?.classList.toggle('visible');
  });

  document.getElementById('btn-confirm-raise')?.addEventListener('click', () => {
    const val = parseInt(document.getElementById('raise-input').value);
    if (!isNaN(val) && val > 0) {
      playerAction('raise', val);
      document.getElementById('raise-controls')?.classList.remove('visible');
    }
  });

  // Start game button (in game header)
  document.getElementById('start-game-btn')?.addEventListener('click', async () => {
    if (myPlayerId !== currentRoom?.host_id) { showToast('Only host can start', 'error'); return; }
    await startGame();
  });

  // Waiting start button
  document.getElementById('waiting-start-btn')?.addEventListener('click', async () => {
    await startGame();
    hideWaitingOverlay();
  });

  // Leave button
  document.getElementById('btn-leave')?.addEventListener('click', () => {
    if (confirm('Leave the game?')) {
      (async () => {
        await syncMyLiveStats(true);
        await supabaseClient.from('room_players').update({ is_connected: false, status: 'out' }).eq('id', myPlayerId);
        localStorage.removeItem('poker_last_room');
        localStorage.removeItem('poker_last_name');
        location.reload();
      })();
    }
  });

  // Copy room code
  document.getElementById('copy-room-code')?.addEventListener('click', () => {
    const code = document.getElementById('room-code')?.textContent;
    if (code) { navigator.clipboard.writeText(code); showToast('Room code copied!'); }
  });

  // Show/Muck buttons
  document.getElementById('btn-show-hand')?.addEventListener('click', () => playerReveal(true));
  document.getElementById('btn-muck-hand')?.addEventListener('click', () => playerReveal(false));
  document.getElementById('btn-rebuy')?.addEventListener('click', () => rebuyMyPlayer());

  // Hand rankings modal
  document.getElementById('btn-rankings')?.addEventListener('click', () => {
    document.getElementById('rankings-modal')?.classList.add('visible');
  });
  document.getElementById('close-rankings')?.addEventListener('click', () => {
    document.getElementById('rankings-modal')?.classList.remove('visible');
  });
  document.getElementById('rankings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
  });
});
