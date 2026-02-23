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
  if (room.status === 'playing') throw new Error('Game already in progress');

  // Check player count
  const { data: players } = await supabaseClient.from('room_players').select('*').eq('room_id', roomId);
  if (players && players.length >= room.max_players) throw new Error('Room is full');

  // Check if already in room
  const existing = players?.find(p => p.id === myPlayerId);
  if (!existing) {
    await joinRoomAsPlayer(roomId, playerName, room.starting_chips);
  } else {
    // Update name
    await supabaseClient.from('room_players').update({ name: playerName, is_connected: true }).eq('id', myPlayerId);
  }
  return room;
}

async function joinRoomAsPlayer(roomId, playerName, chips) {
  const { data: players } = await supabaseClient.from('room_players').select('seat').eq('room_id', roomId).order('seat');
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

async function fetchRooms() {
  const { data } = await supabaseClient.from('rooms').select('*, room_players(count)').eq('status', 'waiting').order('created_at', { ascending: false }).limit(20);
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

  const newState = {
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

  // Reset player statuses
  for (const p of sorted) {
    await supabaseClient.from('room_players').update({
      status: 'active',
      chips: p.chips - (p.id === sbPlayer.id ? sbBet : p.id === bbPlayer.id ? bbBet : 0)
    }).eq('id', p.id);
  }

  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);

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

// ─── Player Actions ───────────────────────────────────────────────
async function playerAction(action, amount = 0) {
  if (isProcessingAction) return;
  if (!gameState || gameState.current_player_id !== myPlayerId) {
    showToast("It's not your turn", 'error');
    return;
  }

  isProcessingAction = true;
  try {
    const state = { ...gameState };
    const player = allPlayers.find(p => p.id === myPlayerId);
    if (!player) return;

    let betAmount = 0;
    let newState = { ...state };
    newState.player_bets = { ...state.player_bets };
    newState.player_contributions = { ...state.player_contributions };
    newState.acting_order = [...state.acting_order.slice(1)]; // remove current player
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
          newState.all_in_players.push(myPlayerId);
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
        const activePlayers = allPlayers.filter(p =>
          p.status === 'active' && p.id !== myPlayerId
        );
        // Order them starting from the player after current
        const sortedBySeat = activePlayers.sort((a, b) => a.seat - b.seat);
        const currentSeat = player.seat;
        const myIdx = sortedBySeat.findIndex(p => p.seat > currentSeat);
        const reordered = myIdx >= 0
          ? [...sortedBySeat.slice(myIdx), ...sortedBySeat.slice(0, myIdx)]
          : sortedBySeat;
        newState.acting_order = reordered.map(p => p.id);

        await supabaseClient.from('room_players').update({ chips: player.chips - additional }).eq('id', myPlayerId);
        if (player.chips - additional === 0) {
          newState.all_in_players.push(myPlayerId);
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
          const activePlayers = allPlayers.filter(p => p.status === 'active' && p.id !== myPlayerId);
          const sortedBySeat = activePlayers.sort((a, b) => a.seat - b.seat);
          const currentSeat = player.seat;
          const myIdx = sortedBySeat.findIndex(p => p.seat > currentSeat);
          const reordered = myIdx >= 0
            ? [...sortedBySeat.slice(myIdx), ...sortedBySeat.slice(0, myIdx)]
            : sortedBySeat;
          newState.acting_order = reordered.map(p => p.id);
        }
        betAmount = allChips;
        newState.all_in_players.push(myPlayerId);
        newState.active_player_ids = state.active_player_ids.filter(id => id !== myPlayerId);
        await supabaseClient.from('room_players').update({ chips: 0, status: 'all_in' }).eq('id', myPlayerId);
        await logAction(currentRoom.id, myPlayerId, player.name, 'goes all-in', allChips);
        break;
      }
    }

    // Check if betting round is over
    const activePlayers = allPlayers.filter(p => p.status === 'active');
    const stillToAct = newState.acting_order.filter(id =>
      allPlayers.find(p => p.id === id && p.status === 'active')
    );

    // Filter out just-folded player
    const newActivePlayers = newState.active_player_ids || [];
    const nonFoldedNonAllin = newActivePlayers.filter(id =>
      !newState.all_in_players.includes(id)
    );

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
      await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
    }
  } finally {
    isProcessingAction = false;
  }
}

async function processEndOfBettingRound(state) {
  const activeFolded = allPlayers.filter(p => p.status === 'active' || p.status === 'all_in');
  const nonFolded = state.active_player_ids || activeFolded.map(p => p.id);

  // Reset per-round bets
  const newPlayerBets = {};
  for (const id of Object.keys(state.player_bets)) newPlayerBets[id] = 0;

  // Check if only one player left (everyone else folded)
  if (nonFolded.filter(id => !state.all_in_players?.includes(id)).length === 0 && nonFolded.length === 1) {
    // One player wins without showdown
    await awardPot(state, [nonFolded[0]], false);
    return;
  }

  if (nonFolded.length <= 1 && (state.all_in_players?.length > 0 || nonFolded.length === 1)) {
    // Run out the board
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
  const flop = [state.deck.pop(), state.deck.pop(), state.deck.pop()];
  const newState = {
    ...state,
    phase: 'flop',
    community_cards: flop,
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'Flop dealt', 0);
}

async function advanceToTurn(state, newPlayerBets) {
  const turn = state.deck.pop();
  const newState = {
    ...state,
    phase: 'turn',
    community_cards: [...state.community_cards, turn],
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'Turn dealt', 0);
}

async function advanceToRiver(state, newPlayerBets) {
  const river = state.deck.pop();
  const newState = {
    ...state,
    phase: 'river',
    community_cards: [...state.community_cards, river],
    current_bet: 0,
    player_bets: newPlayerBets,
    acting_order: buildPostflopOrder(state),
    last_aggressor_id: null
  };
  newState.current_player_id = newState.acting_order[0];
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await logAction(currentRoom.id, 'system', 'Dealer', 'River dealt', 0);
}

async function runOutBoard(state) {
  // Run all remaining community cards
  let community = [...state.community_cards];
  const deck = [...state.deck];
  while (community.length < 5) community.push(deck.pop());

  const newState = { ...state, community_cards: community, deck, phase: 'showdown' };
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);
  await doShowdown(newState);
}

async function doShowdown(state) {
  // Evaluate hands for all non-folded players
  const nonFolded = state.active_player_ids || [];
  const allIn = state.all_in_players || [];
  const showdownPlayers = [...new Set([...nonFolded, ...allIn])];

  if (showdownPlayers.length === 0) return;
  if (showdownPlayers.length === 1) {
    await awardPot(state, showdownPlayers, false);
    return;
  }

  const playerHandData = showdownPlayers.map(id => ({
    id,
    cards: state.hands[id] || []
  })).filter(p => p.cards.length === 2);

  const { winners, evaluations } = determineWinners(playerHandData, state.community_cards);

  await logAction(currentRoom.id, 'system', 'Dealer', 'Showdown!', 0);

  const newState = { ...state, phase: 'showdown', winners, evaluations };
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);

  await awardPot(state, winners, true, evaluations);
}

async function awardPot(state, winnerIds, isShowdown, evaluations = []) {
  const pot = state.pot;
  const perWinner = Math.floor(pot / winnerIds.length);
  const remainder = pot % winnerIds.length;

  // Fetch current chips
  const { data: players } = await supabaseClient.from('room_players').select('*').eq('room_id', currentRoom.id);

  for (let i = 0; i < winnerIds.length; i++) {
    const winner = players?.find(p => p.id === winnerIds[i]);
    if (winner) {
      const won = perWinner + (i === 0 ? remainder : 0);
      await supabaseClient.from('room_players').update({ chips: winner.chips + won }).eq('id', winner.id);
      const eval_ = evaluations.find(e => e.id === winner.id);
      await logAction(currentRoom.id, winner.id, winner.name,
        `wins ${won} chips${isShowdown && eval_?.hand ? ' with ' + eval_.hand.name : ''}`, won);
    }
  }

  // Mark round done
  const newState = {
    ...state,
    phase: 'showdown',
    winners: winnerIds,
    evaluations,
    round_done: true
  };
  await supabaseClient.from('game_state').update({ state: newState, updated_at: new Date().toISOString() }).eq('room_id', currentRoom.id);

  // Auto-start next hand after delay
  setTimeout(async () => {
    const { data: currentPlayers } = await supabaseClient.from('room_players').select('*').eq('room_id', currentRoom.id);
    const eligible = currentPlayers?.filter(p => p.chips > 0 && p.status !== 'out');
    if (eligible && eligible.length >= 2) {
      // Reset statuses
      for (const p of eligible) {
        await supabaseClient.from('room_players').update({ status: 'waiting' }).eq('id', p.id);
      }
      await dealNewHand(eligible, state.dealer_seat, (state.round_number || 0) + 1);
    } else {
      // Game over
      await supabaseClient.from('rooms').update({ status: 'finished' }).eq('id', currentRoom.id);
      await logAction(currentRoom.id, 'system', 'Dealer', 'Game over!', 0);
    }
  }, 5000);
}

function buildPostflopOrder(state) {
  // Post-flop order: start from first active player after dealer
  // Use state.active_player_ids to avoid stale allPlayers status
  const activeIds = state.active_player_ids || [];
  const activePlayers = allPlayers.filter(p => activeIds.includes(p.id)).sort((a, b) => a.seat - b.seat);
  const dealerSeat = state.dealer_seat;
  const afterDealer = activePlayers.findIndex(p => p.seat > dealerSeat);
  const ordered = afterDealer >= 0
    ? [...activePlayers.slice(afterDealer), ...activePlayers.slice(0, afterDealer)]
    : activePlayers;
  return ordered.map(p => p.id);
}

async function logAction(roomId, playerId, playerName, action, amount) {
  await supabaseClient.from('game_actions').insert({ room_id: roomId, player_id: playerId, player_name: playerName, action, amount });
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
      await refreshPlayers();
      renderGame();
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
  }
}

// ─── UI Rendering ─────────────────────────────────────────────────
function renderGame() {
  if (!gameState || !allPlayers.length) return;

  renderTableSeats();
  renderCommunityCards();
  renderPot();
  renderMyHand();
  renderSidebarPlayers();
  renderActionPanel();
  renderPhase();
  checkAndShowWinner();
}

function renderTableSeats() {
  const seatContainer = document.getElementById('seat-container');
  if (!seatContainer) return;
  seatContainer.innerHTML = '';

  const maxSeats = 7;
  for (let i = 0; i < maxSeats; i++) {
    const player = allPlayers.find(p => p.seat === i);
    const div = document.createElement('div');
    div.className = `player-seat seat-${i}`;

    if (!player) {
      div.classList.add('empty');
      div.innerHTML = `
        <div class="player-avatar">+</div>
        <div class="player-info" style="opacity:0.3">
          <div class="player-name">Empty</div>
        </div>
      `;
    } else {
      const isMe = player.id === myPlayerId;
      const isTurn = gameState.current_player_id === player.id && gameState.phase !== 'waiting' && gameState.phase !== 'showdown';
      const isFolded = player.status === 'folded';
      const isDealer = gameState.dealer_seat === player.seat;
      const isSB = gameState.small_blind_player_id === player.id;
      const isBB = gameState.big_blind_player_id === player.id;
      const currentBet = gameState.player_bets?.[player.id];

      if (isMe) div.classList.add('is-me');
      if (isTurn) div.classList.add('is-turn');
      if (isFolded) div.classList.add('folded');

      const avatarEmoji = getPlayerAvatar(player.name);
      const betDisplay = currentBet > 0 && gameState.phase !== 'waiting' && gameState.phase !== 'showdown'
        ? `<div class="player-bet-display">$${currentBet}</div>` : '';

      // Show cards for this player (if revealed during showdown, or it's me)
      let cardsHtml = '';
      if (gameState.phase !== 'waiting' && gameState.hands) {
        if (isMe || (gameState.phase === 'showdown' && !isFolded)) {
          const cards = gameState.hands[player.id];
          if (cards) {
            cardsHtml = `<div class="seat-cards">${cards.map(c => renderPocketCard(c, true)).join('')}</div>`;
          }
        } else if (!isFolded) {
          cardsHtml = `<div class="seat-cards">
            <div class="pocket-card">🂠</div>
            <div class="pocket-card">🂠</div>
          </div>`;
        }
        if (isFolded) {
          cardsHtml = `<div class="folded-text">Folded</div>`;
        }
      }

      div.innerHTML = `
        <div class="player-avatar">
          ${avatarEmoji}
          ${isDealer ? '<div class="dealer-btn">D</div>' : ''}
          ${isSB ? '<div class="blind-badge sb-badge">SB</div>' : ''}
          ${isBB ? '<div class="blind-badge bb-badge">BB</div>' : ''}
        </div>
        ${cardsHtml}
        <div class="player-info">
          <div class="player-name">${escHtml(player.name)}${isMe ? ' ★' : ''}</div>
          <div class="player-chips-display">$${player.chips}</div>
        </div>
        ${betDisplay}
      `;
    }
    seatContainer.appendChild(div);
  }
}

function renderPocketCard(cardStr, revealed) {
  if (!revealed) return `<div class="pocket-card">🂠</div>`;
  const { rank, suit, suitCode } = cardDisplay(cardStr);
  const isRed = suitCode === 'h' || suitCode === 'd';
  return `<div class="pocket-card revealed ${isRed ? 'red' : ''}">${rank}${suit}</div>`;
}

function renderCommunityCards() {
  const container = document.getElementById('community-cards');
  if (!container) return;
  container.innerHTML = '';

  const cards = gameState.community_cards || [];
  for (let i = 0; i < 5; i++) {
    const div = document.createElement('div');
    if (i < cards.length) {
      const { rank, suit, suitCode } = cardDisplay(cards[i]);
      const isRed = suitCode === 'h' || suitCode === 'd';
      div.className = `community-card ${isRed ? 'red' : 'black'}`;
      div.innerHTML = `
        <div class="card-rank">${rank}</div>
        <div class="card-suit">${suit}</div>
        <div class="card-center-suit">${suit}</div>
      `;
    } else {
      div.className = 'community-card placeholder';
    }
    container.appendChild(div);
  }
}

function renderPot() {
  const el = document.getElementById('pot-amount');
  if (el) el.textContent = `$${gameState.pot || 0}`;
}

function renderMyHand() {
  const container = document.getElementById('my-cards');
  const handName = document.getElementById('hand-name');
  if (!container) return;
  container.innerHTML = '';

  if (!gameState.hands || !gameState.hands[myPlayerId]) {
    container.innerHTML = `
      <div class="my-card face-down"><div class="card-rank">?</div></div>
      <div class="my-card face-down"><div class="card-rank">?</div></div>
    `;
    if (handName) handName.textContent = '';
    return;
  }

  const cards = gameState.hands[myPlayerId];
  for (const cardStr of cards) {
    const { rank, suit, suitCode } = cardDisplay(cardStr);
    const isRed = suitCode === 'h' || suitCode === 'd';
    const div = document.createElement('div');
    div.className = `my-card ${isRed ? 'red' : 'black'}`;
    div.innerHTML = `
      <div class="card-rank">${rank}</div>
      <div class="card-suit">${suit}</div>
      <div class="card-center-suit">${suit}</div>
    `;
    container.appendChild(div);
  }

  // Show hand strength if community cards present
  if (gameState.community_cards?.length >= 3 && handName) {
    const allCards = [...cards, ...gameState.community_cards];
    const ev = evaluateHand(allCards);
    handName.textContent = ev ? ev.name : '';
  } else if (handName) {
    handName.textContent = '';
  }

  // Update my chips
  const chipsEl = document.getElementById('my-chips-big');
  if (chipsEl && myPlayer) chipsEl.textContent = `$${myPlayer.chips}`;
}

function renderSidebarPlayers() {
  const list = document.getElementById('players-list');
  if (!list) return;
  list.innerHTML = '';

  for (const player of allPlayers) {
    const isMe = player.id === myPlayerId;
    const isTurn = gameState.current_player_id === player.id;
    const statusClass = player.status === 'folded' ? 'status-folded'
      : player.status === 'all_in' ? 'status-allin'
      : isTurn ? 'status-active' : '';
    const statusText = player.status === 'folded' ? 'Folded'
      : player.status === 'all_in' ? 'All-in'
      : isTurn ? '● Acting...' : '';

    const div = document.createElement('div');
    div.className = 'player-row';
    div.innerHTML = `
      <div class="player-row-avatar">${getPlayerAvatar(player.name)}</div>
      <div class="player-row-info">
        <div class="player-row-name">${escHtml(player.name)}</div>
        <div class="player-row-chips">$${player.chips}</div>
        ${statusText ? `<div class="player-row-status ${statusClass}">${statusText}</div>` : ''}
      </div>
      ${isMe ? '<div class="is-you-badge">You</div>' : ''}
    `;
    list.appendChild(div);
  }
}

function renderActionPanel() {
  const panel = document.getElementById('action-panel');
  const statusText = document.getElementById('game-status-text');
  if (!panel || !statusText) return;

  const isMyTurn = gameState.current_player_id === myPlayerId;
  const myStatus = myPlayer?.status;

  if (gameState.phase === 'waiting') {
    panel.classList.remove('visible');
    statusText.textContent = 'Waiting for game to start...';
    statusText.className = 'game-status-text';
    return;
  }

  if (gameState.phase === 'showdown' || gameState.round_done) {
    panel.classList.remove('visible');
    statusText.textContent = 'Showdown! Next hand starting...';
    statusText.className = 'game-status-text highlight';
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

  if (!isMyTurn) {
    panel.classList.remove('visible');
    const currentPlayer = allPlayers.find(p => p.id === gameState.current_player_id);
    statusText.textContent = currentPlayer ? `Waiting for ${currentPlayer.name}...` : 'Waiting...';
    statusText.className = 'game-status-text';
    return;
  }

  // It's my turn
  panel.classList.add('visible');
  statusText.textContent = '';

  const myBet = gameState.player_bets?.[myPlayerId] || 0;
  const currentBet = gameState.current_bet || 0;
  const toCall = currentBet - myBet;

  // Show/hide check vs call
  const checkBtn = document.getElementById('btn-check');
  const callBtn = document.getElementById('btn-call');
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
}

function checkAndShowWinner() {
  if (gameState.round_done && gameState.winners?.length) {
    showWinnerOverlay(gameState.winners, gameState.evaluations, gameState.pot, gameState.community_cards, gameState.hands);
  }
}

function showWinnerOverlay(winners, evaluations, pot, communityCards, hands) {
  const overlay = document.getElementById('winner-overlay');
  if (!overlay) return;

  const winnerPlayers = winners.map(id => allPlayers.find(p => p.id === id)).filter(Boolean);

  let handsHtml = '';
  if (evaluations?.length) {
    for (const ev of evaluations) {
      const player = allPlayers.find(p => p.id === ev.id);
      if (!player) continue;
      const isWinner = winners.includes(ev.id);
      handsHtml += `
        <div class="winner-hand-item">
          <div class="w-name">${isWinner ? '<span class="winner-crown">👑</span>' : ''}${escHtml(player.name)}</div>
          <div class="w-hand">${ev.hand?.name || ''}</div>
          <div class="w-cards">${(hands?.[ev.id] || []).join(' ')}</div>
        </div>
      `;
    }
  }

  overlay.innerHTML = `
    <div class="winner-box">
      <div class="winner-emoji">🏆</div>
      <div class="winner-title">${winnerPlayers.length > 1 ? 'Split Pot!' : 'Winner!'}</div>
      <div class="winner-name">${winnerPlayers.map(p => escHtml(p.name)).join(' & ')}</div>
      ${evaluations?.length ? `<div class="winner-hands-list">${handsHtml}</div>` : ''}
      <div class="winner-pot">+$${Math.floor(pot / winners.length)}</div>
      <div style="color: var(--text-muted); font-size: 0.82rem;">Next hand starting in 5 seconds...</div>
    </div>
  `;
  overlay.classList.add('visible');

  setTimeout(() => overlay.classList.remove('visible'), 5000);
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
  list.innerHTML = allPlayers.map(p => `
    <div class="waiting-player-item">
      <div class="waiting-player-dot"></div>
      <span>${escHtml(p.name)}${p.id === currentRoom.host_id ? ' (Host)' : ''}${p.id === myPlayerId ? ' (You)' : ''}</span>
    </div>
  `).join('');

  const startBtn = document.getElementById('waiting-start-btn');
  if (startBtn) {
    startBtn.style.display = myPlayerId === currentRoom?.host_id ? 'block' : 'none';
    startBtn.disabled = allPlayers.length < 2;
    startBtn.textContent = allPlayers.length < 2 ? 'Waiting for players...' : `Start Game (${allPlayers.length} players)`;
  }
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
  await loadRoomsList();
  // Auto-refresh rooms every 5s
  setInterval(loadRoomsList, 5000);
}

async function loadRoomsList() {
  const list = document.getElementById('rooms-list');
  if (!list) return;
  const rooms = await fetchRooms();
  if (rooms.length === 0) {
    list.innerHTML = '<div class="empty-rooms">No open rooms. Create one!</div>';
    return;
  }
  list.innerHTML = rooms.map(r => `
    <div class="room-card" onclick="quickJoinRoom('${r.id}')">
      <div class="room-info">
        <div class="room-name">Room ${r.id}</div>
        <div class="room-meta">Blinds: $${r.small_blind}/$${r.big_blind} · Chips: $${r.starting_chips}</div>
      </div>
      <div class="room-badge">${r.room_players?.[0]?.count || 0}/${r.max_players}</div>
    </div>
  `).join('');
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
    const room = await joinRoom(roomId, name);
    currentRoom = room;
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

  showScreen('game-screen');
  document.getElementById('room-code').textContent = roomId;

  // Fetch initial data
  await refreshPlayers();
  const { data: gsData } = await supabaseClient.from('game_state').select('*').eq('room_id', roomId).single();
  if (gsData) gameState = gsData.state;

  // Subscribe to realtime
  subscribeToRoom(roomId);

  // Load recent actions
  const { data: actions } = await supabaseClient.from('game_actions').select('*').eq('room_id', roomId).order('created_at').limit(50);
  if (actions) actions.forEach(addActionEntry);

  // Show waiting overlay if game hasn't started
  if (!currentRoom || currentRoom.status === 'waiting') {
    showWaitingOverlay(roomId);
  }

  renderGame();
  hideLoading();
}

// Waiting overlay player refresh (realtime triggers this)
async function onPlayersChanged() {
  await refreshPlayers();
  updateWaitingPlayers();
  renderSidebarPlayers();
}

// ─── Bootstrap ────────────────────────────────────────────────────
function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) { overlay.classList.add('hidden'); setTimeout(() => overlay.style.display = 'none', 500); }
}

window.addEventListener('DOMContentLoaded', async () => {
  initSupabase();
  showScreen('lobby-screen');
  await initLobby();
  hideLoading();

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
      supabaseClient.from('room_players').update({ is_connected: false, status: 'out' }).eq('id', myPlayerId);
      location.reload();
    }
  });

  // Copy room code
  document.getElementById('copy-room-code')?.addEventListener('click', () => {
    const code = document.getElementById('room-code')?.textContent;
    if (code) { navigator.clipboard.writeText(code); showToast('Room code copied!'); }
  });
});
