// poker.js - Poker hand evaluation and deck management

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['s','h','d','c']; // spades, hearts, diamonds, clubs
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// Hand rank names
const HAND_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind',
  'Straight Flush', 'Royal Flush'
];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(rank + suit);
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function parseCard(card) {
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  return { rank, suit, value: RANK_VALUES[rank] };
}

// Evaluate best 5-card hand from an array of cards (5-7 cards)
function evaluateHand(cards) {
  if (cards.length < 5) return null;

  // Get all combinations of 5 cards
  const combos = getCombinations(cards, 5);
  let best = null;

  for (const combo of combos) {
    const score = score5CardHand(combo);
    if (!best || compareScores(score, best.score) > 0) {
      best = { score, cards: combo };
    }
  }

  return {
    rank: best.score[0],
    name: HAND_NAMES[best.score[0]],
    score: best.score,
    cards: best.cards
  };
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = getCombinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

// Returns score array [handRank, ...tiebreakers]
function score5CardHand(cards) {
  const parsed = cards.map(parseCard).sort((a, b) => b.value - a.value);
  const values = parsed.map(c => c.value);
  const suits = parsed.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(values);
  const relCounts = getRelCounts(values);

  if (isFlush && isStraight) {
    const highVal = isStraight === 'wheel' ? 5 : values[0];
    return highVal === 14 ? [9, 14] : [8, highVal]; // Royal Flush or Straight Flush
  }
  if (relCounts[0][1] === 4) return [7, relCounts[0][0], relCounts[1][0]]; // Four of a Kind
  if (relCounts[0][1] === 3 && relCounts[1][1] === 2) return [6, relCounts[0][0], relCounts[1][0]]; // Full House
  if (isFlush) return [5, ...values]; // Flush
  if (isStraight) {
    const highVal = isStraight === 'wheel' ? 5 : values[0];
    return [4, highVal]; // Straight
  }
  if (relCounts[0][1] === 3) return [3, relCounts[0][0], ...relCounts.slice(1).map(r => r[0])]; // Three of a Kind
  if (relCounts[0][1] === 2 && relCounts[1][1] === 2) {
    const pairs = relCounts.filter(r => r[1] === 2).map(r => r[0]).sort((a,b) => b-a);
    const kicker = relCounts.find(r => r[1] === 1)[0];
    return [2, pairs[0], pairs[1], kicker]; // Two Pair
  }
  if (relCounts[0][1] === 2) return [1, relCounts[0][0], ...relCounts.slice(1).map(r => r[0])]; // One Pair
  return [0, ...values]; // High Card
}

function checkStraight(sortedValues) {
  // Check wheel (A-2-3-4-5)
  if (sortedValues[0] === 14 && sortedValues[1] === 5 &&
      sortedValues[2] === 4 && sortedValues[3] === 3 && sortedValues[4] === 2) {
    return 'wheel';
  }
  for (let i = 0; i < 4; i++) {
    if (sortedValues[i] - sortedValues[i+1] !== 1) return false;
  }
  return true;
}

function getRelCounts(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts)
    .map(([v, c]) => [parseInt(v), c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Determine winners from a set of players with their hands + community cards
function determineWinners(players, communityCards) {
  // players: [{ id, cards: [card1, card2] }, ...]
  const evaluations = players.map(p => ({
    id: p.id,
    eval: evaluateHand([...p.cards, ...communityCards])
  }));

  let best = null;
  for (const e of evaluations) {
    if (!best || compareScores(e.eval.score, best) > 0) {
      best = e.eval.score;
    }
  }

  const winners = evaluations.filter(e => compareScores(e.eval.score, best) === 0);
  return {
    winners: winners.map(w => w.id),
    evaluations: evaluations.map(e => ({ id: e.id, hand: e.eval }))
  };
}

// Format card for display
function cardDisplay(card) {
  if (!card) return '';
  const parsed = parseCard(card);
  const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return { rank: parsed.rank, suit: suitSymbols[parsed.suit], suitCode: parsed.suit };
}

// Return the subset of cards from myCards+communityCards that form the best hand.
// For High Card: returns only the single highest card.
// For all other hands: returns the cards composing the hand (2-5 cards depending on type).
function getHighlightCards(myCards, communityCards) {
  if (!myCards || myCards.length < 2) return [];
  const allCards = [...myCards, ...communityCards];
  if (allCards.length < 5) return myCards; // pre-flop: highlight both hole cards

  const result = evaluateHand(allCards);
  if (!result) return [];

  const bestCards = result.cards; // best 5-card combo
  const handRank = result.rank;

  if (handRank === 0) {
    // High Card — highlight only the single highest card in the best hand
    const sorted = [...bestCards].map(c => ({ c, v: RANK_VALUES[parseCard(c).rank] }))
      .sort((a, b) => b.v - a.v);
    return [sorted[0].c];
  }

  // For pair/two-pair/trips/etc: return only the cards that matter
  const parsed = bestCards.map(c => ({ c, ...parseCard(c) }));
  const valueCounts = {};
  for (const p of parsed) valueCounts[p.value] = (valueCounts[p.value] || 0) + 1;

  switch (handRank) {
    case 1: { // One Pair — 2 cards
      const pairVal = Object.entries(valueCounts).find(([, c]) => c === 2)?.[0];
      return parsed.filter(p => String(p.value) === pairVal).map(p => p.c);
    }
    case 2: { // Two Pair — 4 cards
      const pairVals = Object.entries(valueCounts).filter(([, c]) => c === 2).map(([v]) => v);
      return parsed.filter(p => pairVals.includes(String(p.value))).map(p => p.c);
    }
    case 3: { // Three of a Kind — 3 cards
      const tripVal = Object.entries(valueCounts).find(([, c]) => c === 3)?.[0];
      return parsed.filter(p => String(p.value) === tripVal).map(p => p.c);
    }
    case 4: // Straight — all 5
    case 5: // Flush — all 5
      return bestCards;
    case 6: { // Full House — all 5
      return bestCards;
    }
    case 7: { // Four of a Kind — 4 cards
      const quadVal = Object.entries(valueCounts).find(([, c]) => c === 4)?.[0];
      return parsed.filter(p => String(p.value) === quadVal).map(p => p.c);
    }
    case 8: // Straight Flush — all 5
    case 9: // Royal Flush — all 5
      return bestCards;
    default:
      return bestCards;
  }
}

// Get next player seat (active players only)
function getNextPlayer(seats, currentSeat, activePlayers) {
  const activeSeats = activePlayers.map(p => p.seat).sort((a,b) => a-b);
  if (activeSeats.length === 0) return null;
  const currentIndex = activeSeats.indexOf(currentSeat);
  return activeSeats[(currentIndex + 1) % activeSeats.length];
}

// Calculate side pots from player contributions
function calculatePots(contributions, activePlayers) {
  // contributions: { player_id: total_amount_put_in }
  const contribs = Object.entries(contributions)
    .map(([id, amount]) => ({ id, amount }))
    .sort((a, b) => a.amount - b.amount);

  const pots = [];
  let processed = 0;

  while (contribs.some(c => c.amount > processed)) {
    const level = contribs.find(c => c.amount > processed)?.amount;
    if (!level) break;

    const eligible = contribs.filter(c => c.amount >= level).map(c => c.id);
    const potAmount = Math.min(level - processed, level - processed) *
      contribs.filter(c => c.amount > processed).length;

    // More accurate calculation
    const contribution = Math.min(level - processed, level);
    const contributors = contribs.filter(c => c.amount > processed);
    const pot = contributors.length * Math.min(level - processed, level - processed);

    // Simple approach: just track main pot and side pots
    const actualContrib = level - processed;
    const actualPot = contribs.filter(c => c.amount >= level).length * actualContrib +
      contribs.filter(c => c.amount > processed && c.amount < level).length *
      contribs.filter(c => c.amount > processed && c.amount < level).reduce((s, c) => s + (c.amount - processed), 0) / contribs.filter(c => c.amount > processed && c.amount < level).length;

    pots.push({ amount: contribs.filter(c => c.amount > processed).length * (level - processed), eligible });
    processed = level;
  }

  return pots;
}
