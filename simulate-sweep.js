// Convergence sweep: run the simulator at increasing vote counts and
// average results across multiple trials to smooth out RNG noise.

const fs = require("fs");
const songs = JSON.parse(fs.readFileSync("songs.json", "utf8"));

const INITIAL_RATING = 1000;
const K_FACTOR = 32;

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function runOne(nVotes) {
  const shuffled = [...songs].sort(() => Math.random() - 0.5);
  const trueQuality = {};
  shuffled.forEach((s, i) => {
    trueQuality[s.id] = 1250 - i * (500 / (songs.length - 1));
  });
  const trueRank = {};
  [...songs]
    .map((s) => ({ id: s.id, q: trueQuality[s.id] }))
    .sort((a, b) => b.q - a.q)
    .forEach((s, i) => (trueRank[s.id] = i + 1));

  const stats = {};
  for (const s of songs)
    stats[s.id] = { rating: INITIAL_RATING, wins: 0, losses: 0, ties: 0 };

  function pickMatchup() {
    const totals = songs.map((s) => {
      const st = stats[s.id];
      return st.wins + st.losses + st.ties;
    });
    const maxV = Math.max(...totals, 0);
    const weights = totals.map((v) => maxV - v + 1);
    const total = weights.reduce((s, w) => s + w, 0);
    function pick(items, ws) {
      const t = ws.reduce((s, w) => s + w, 0);
      let r = Math.random() * t;
      for (let i = 0; i < items.length; i++) {
        r -= ws[i];
        if (r <= 0) return i;
      }
      return items.length - 1;
    }
    const iA = pick(songs, weights);
    const others = songs.filter((_, i) => i !== iA);
    const oW = weights.filter((_, i) => i !== iA);
    const iB = pick(others, oW);
    return [songs[iA], others[iB]];
  }

  function apply(a, b, s) {
    const eA = expectedScore(stats[a].rating, stats[b].rating);
    const eB = 1 - eA;
    const sB = 1 - s;
    stats[a].rating = Math.round(stats[a].rating + K_FACTOR * (s - eA));
    stats[b].rating = Math.round(stats[b].rating + K_FACTOR * (sB - eB));
    if (s === 1) {
      stats[a].wins++;
      stats[b].losses++;
    } else if (s === 0) {
      stats[b].wins++;
      stats[a].losses++;
    } else {
      stats[a].ties++;
      stats[b].ties++;
    }
  }

  for (let i = 0; i < nVotes; i++) {
    const [a, b] = pickMatchup();
    const pA = expectedScore(trueQuality[a.id], trueQuality[b.id]);
    const s = Math.random() < pA ? 1 : 0;
    apply(a.id, b.id, s);
  }

  const derived = songs
    .map((s) => ({ id: s.id, rating: stats[s.id].rating }))
    .sort((a, b) => b.rating - a.rating);

  let dSum = 0;
  let totalDisp = 0;
  derived.forEach((row, i) => {
    const dRank = i + 1;
    const tRank = trueRank[row.id];
    dSum += (dRank - tRank) ** 2;
    totalDisp += Math.abs(dRank - tRank);
  });
  const n = songs.length;
  const spearman = 1 - (6 * dSum) / (n * (n * n - 1));

  let concordant = 0,
    discordant = 0;
  for (let i = 0; i < derived.length; i++) {
    for (let j = i + 1; j < derived.length; j++) {
      const ri = trueRank[derived[i].id];
      const rj = trueRank[derived[j].id];
      if (ri < rj) concordant++;
      else if (ri > rj) discordant++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const kendall = (concordant - discordant) / pairs;

  return { spearman, kendall, meanDisp: totalDisp / n };
}

const voteCounts = [25, 50, 100, 200, 400, 800];
const TRIALS = 40;

console.log(
  `Convergence sweep (${TRIALS} trials each, averaged) — ${songs.length} songs\n`
);
console.log("votes    Spearman ρ    Kendall τ    Mean rank error");
console.log("─".repeat(58));

for (const n of voteCounts) {
  let sp = 0,
    ke = 0,
    md = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = runOne(n);
    sp += r.spearman;
    ke += r.kendall;
    md += r.meanDisp;
  }
  sp /= TRIALS;
  ke /= TRIALS;
  md /= TRIALS;
  console.log(
    `${String(n).padStart(5)}    ${sp.toFixed(3).padEnd(13)}${ke
      .toFixed(3)
      .padEnd(13)}${md.toFixed(2)} positions`
  );
}
