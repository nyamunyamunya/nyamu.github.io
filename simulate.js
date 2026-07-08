// Standalone simulator for the Song Ranker.
// Runs the same Elo logic that script.js uses against songs.json,
// assigning each song a hidden "true quality" score and having
// simulated voters make noisy pairwise choices. Reports how well
// the derived leaderboard matches the true ranking.

const fs = require("fs");

const INITIAL_RATING = 1000;
const K_FACTOR = 32;

const songs = JSON.parse(fs.readFileSync("songs.json", "utf8"));

// Hidden "true" quality for each song, uniformly spread on an Elo-ish scale.
// We shuffle the assignment so alphabetical order can't cheat.
const shuffled = [...songs].sort(() => Math.random() - 0.5);
const trueQuality = {};
shuffled.forEach((s, i) => {
  // Spread across a 500-point band.
  trueQuality[s.id] = 1250 - i * (500 / (songs.length - 1));
});

const stats = {};
for (const s of songs) {
  stats[s.id] = { rating: INITIAL_RATING, wins: 0, losses: 0, ties: 0 };
}

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function applyElo(idA, idB, scoreA) {
  const a = stats[idA];
  const b = stats[idB];
  const eA = expectedScore(a.rating, b.rating);
  const eB = 1 - eA;
  const scoreB = 1 - scoreA;
  a.rating = Math.round(a.rating + K_FACTOR * (scoreA - eA));
  b.rating = Math.round(b.rating + K_FACTOR * (scoreB - eB));
  if (scoreA === 1) {
    a.wins++;
    b.losses++;
  } else if (scoreA === 0) {
    b.wins++;
    a.losses++;
  } else {
    a.ties++;
    b.ties++;
  }
}

function weightedPick(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickMatchup() {
  const totals = songs.map((s) => {
    const st = stats[s.id];
    return st.wins + st.losses + st.ties;
  });
  const maxVotes = Math.max(...totals, 0);
  const weights = totals.map((v) => maxVotes - v + 1);
  const a = weightedPick(songs, weights);
  const others = songs.filter((s) => s.id !== a.id);
  const otherWeights = weights.filter((_, i) => songs[i].id !== a.id);
  const b = weightedPick(others, otherWeights);
  return [a, b];
}

// Simulated voter: picks the higher-true-quality song with probability
// derived from their gap (same Elo formula), so weaker gaps produce ties/upsets.
function simulatedVote(a, b) {
  const qa = trueQuality[a.id];
  const qb = trueQuality[b.id];
  const pA = expectedScore(qa, qb);
  const r = Math.random();
  const TIE_BAND = 0.03; // small chance of ties when very close
  if (Math.abs(pA - 0.5) < TIE_BAND && Math.random() < 0.15) return 0.5;
  return r < pA ? 1 : 0;
}

const N_VOTES = parseInt(process.argv[2] || "400", 10);
console.log(`Running ${N_VOTES} simulated votes across ${songs.length} songs...\n`);

for (let i = 0; i < N_VOTES; i++) {
  const [a, b] = pickMatchup();
  const s = simulatedVote(a, b);
  applyElo(a.id, b.id, s);
}

// Rank by derived Elo.
const derived = songs
  .map((s) => ({
    song: s,
    rating: stats[s.id].rating,
    wins: stats[s.id].wins,
    losses: stats[s.id].losses,
    ties: stats[s.id].ties,
    trueQ: trueQuality[s.id],
  }))
  .sort((a, b) => b.rating - a.rating);

// Rank by true quality for comparison.
const trueOrder = [...songs]
  .map((s) => ({ id: s.id, title: s.title, trueQ: trueQuality[s.id] }))
  .sort((a, b) => b.trueQ - a.trueQ);
const trueRank = {};
trueOrder.forEach((s, i) => (trueRank[s.id] = i + 1));

console.log("Final leaderboard (sorted by derived Elo):");
console.log("─".repeat(78));
console.log(
  " #  song".padEnd(40) +
    "rating  W-L-T      true#  Δ"
);
console.log("─".repeat(78));

let totalDisplacement = 0;
derived.forEach((row, i) => {
  const derivedRank = i + 1;
  const tRank = trueRank[row.song.id];
  const delta = derivedRank - tRank;
  totalDisplacement += Math.abs(delta);
  const title = `${row.song.title}`.slice(0, 30);
  const artist = ` — ${row.song.artist}`.slice(0, 25);
  const label = `${String(derivedRank).padStart(2)}  ${title}${artist}`.padEnd(
    40
  );
  const record = `${row.wins}-${row.losses}-${row.ties}`.padEnd(10);
  const arrow = delta === 0 ? "·" : delta > 0 ? `↓${delta}` : `↑${-delta}`;
  console.log(
    `${label}${String(row.rating).padStart(5)}   ${record} ${String(
      tRank
    ).padStart(4)}   ${arrow}`
  );
});

console.log("─".repeat(78));

// Metrics.
const meanDisplacement = totalDisplacement / songs.length;

// Spearman rank correlation.
const n = songs.length;
let dSum = 0;
derived.forEach((row, i) => {
  const derivedRank = i + 1;
  const tRank = trueRank[row.song.id];
  dSum += (derivedRank - tRank) ** 2;
});
const spearman = 1 - (6 * dSum) / (n * (n * n - 1));

// Kendall tau: fraction of concordant pairs.
let concordant = 0;
let discordant = 0;
for (let i = 0; i < derived.length; i++) {
  for (let j = i + 1; j < derived.length; j++) {
    const ri = trueRank[derived[i].song.id];
    const rj = trueRank[derived[j].song.id];
    if (ri < rj) concordant++;
    else if (ri > rj) discordant++;
  }
}
const totalPairs = (n * (n - 1)) / 2;
const kendall = (concordant - discordant) / totalPairs;

console.log(`\nVotes cast:            ${N_VOTES}`);
console.log(`Songs:                 ${songs.length}`);
console.log(
  `Mean rank displacement: ${meanDisplacement.toFixed(2)} positions`
);
console.log(`Spearman ρ:            ${spearman.toFixed(3)} (1.0 = perfect)`);
console.log(`Kendall τ:             ${kendall.toFixed(3)} (1.0 = perfect)`);
console.log(
  `Concordant pairs:      ${concordant} / ${totalPairs} (${(
    (100 * concordant) /
    totalPairs
  ).toFixed(1)}%)`
);
