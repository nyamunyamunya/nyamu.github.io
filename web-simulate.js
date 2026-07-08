// Drive the running site with Playwright: cast a bunch of real clicks,
// screenshot key screens, and print the final leaderboard the DOM shows.

const { chromium } = require("playwright");
const fs = require("fs");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const N_VOTES = parseInt(process.argv[2] || "80", 10);
const OUT_DIR = "screenshots";

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  console.log(`→ Opening ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');

  // Wipe any prior localStorage state so the run is clean.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');

  // Screenshot: fresh vote screen.
  await page.screenshot({ path: `${OUT_DIR}/01-vote-initial.png`, fullPage: true });
  console.log(`✓ Loaded — saved ${OUT_DIR}/01-vote-initial.png`);

  // Load the song list to build hidden true qualities for simulated preference.
  const songs = JSON.parse(fs.readFileSync("songs.json", "utf8"));
  const shuffled = [...songs].sort(() => Math.random() - 0.5);
  const trueQuality = {};
  shuffled.forEach((s, i) => {
    trueQuality[s.id] = 1250 - i * (500 / (songs.length - 1));
  });

  const titleToId = Object.fromEntries(songs.map((s) => [s.title, s.id]));

  console.log(`→ Casting ${N_VOTES} votes...`);
  const t0 = Date.now();
  for (let i = 0; i < N_VOTES; i++) {
    const [titleA, titleB] = await page.evaluate(() => [
      document.querySelector('.song-card[data-side="a"] .song-title').textContent,
      document.querySelector('.song-card[data-side="b"] .song-title').textContent,
    ]);
    const qa = trueQuality[titleToId[titleA]];
    const qb = trueQuality[titleToId[titleB]];
    const pA = expectedScore(qa, qb);
    const side = Math.random() < pA ? "a" : "b";

    // Use keyboard shortcut to be gentler than click animations.
    await page.keyboard.press(side === "a" ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(240); // matches the 220ms vote animation
  }
  console.log(`✓ Voting done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Screenshot: vote screen after many votes (stats bar updated).
  await page.screenshot({ path: `${OUT_DIR}/02-vote-after.png`, fullPage: true });
  console.log(`✓ Saved ${OUT_DIR}/02-vote-after.png`);

  // Switch to leaderboard.
  await page.locator('.tab[data-view="leaderboard"]').dispatchEvent("click");
  await page.waitForFunction(
    () => !document.getElementById("view-leaderboard").hidden
  );
  await page.waitForSelector("#leaderboard-body tr", { state: "attached" });
  await page.screenshot({ path: `${OUT_DIR}/03-leaderboard.png`, fullPage: true });
  console.log(`✓ Saved ${OUT_DIR}/03-leaderboard.png`);

  // Scrape the leaderboard the DOM is showing.
  const rows = await page.$$eval("#leaderboard-body tr", (trs) =>
    trs.map((tr) => {
      const cells = tr.querySelectorAll("td");
      return {
        rank: cells[0].innerText.trim(),
        title: tr.querySelector(".song-cell-title")?.innerText.trim(),
        artist: tr.querySelector(".song-cell-artist")?.innerText.trim(),
        rating: cells[2].innerText.trim(),
        record: cells[3].innerText.trim(),
        winrate: cells[4].innerText.trim(),
      };
    })
  );

  // Also verify stat counters.
  const stats = await page.evaluate(() => ({
    votes: document.getElementById("stat-votes").textContent,
    songs: document.getElementById("stat-songs").textContent,
  }));

  const trueOrder = [...songs]
    .map((s) => ({ id: s.id, title: s.title, q: trueQuality[s.id] }))
    .sort((a, b) => b.q - a.q);
  const trueRank = {};
  trueOrder.forEach((s, i) => (trueRank[s.title] = i + 1));

  console.log("\nBrowser-scraped leaderboard:");
  console.log("─".repeat(80));
  console.log(" #  song".padEnd(46) + "rating  W-L-T      true#  Δ");
  console.log("─".repeat(80));
  let dispSum = 0;
  rows.forEach((r) => {
    const dRank = parseInt(r.rank.replace(/\D/g, ""), 10);
    const tRank = trueRank[r.title];
    const delta = dRank - tRank;
    dispSum += Math.abs(delta);
    const label = `${String(dRank).padStart(2)}  ${(r.title + " — " + (r.artist || "")).slice(
      0,
      42
    )}`.padEnd(46);
    const arrow = delta === 0 ? "·" : delta > 0 ? `↓${delta}` : `↑${-delta}`;
    console.log(
      `${label}${r.rating.padStart(5)}   ${r.record.padEnd(10)}${String(tRank).padStart(4)}   ${arrow}`
    );
  });
  console.log("─".repeat(80));

  const n = rows.length;
  const meanDisp = dispSum / n;

  // Spearman + Kendall.
  let d2 = 0;
  rows.forEach((r) => {
    const dRank = parseInt(r.rank.replace(/\D/g, ""), 10);
    const tRank = trueRank[r.title];
    d2 += (dRank - tRank) ** 2;
  });
  const spearman = 1 - (6 * d2) / (n * (n * n - 1));

  let conc = 0,
    disc = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const ri = trueRank[rows[i].title];
      const rj = trueRank[rows[j].title];
      if (ri < rj) conc++;
      else if (ri > rj) disc++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const kendall = (conc - disc) / pairs;

  console.log(`\nDOM stats bar says:      ${stats.votes} votes across ${stats.songs} songs`);
  console.log(`Mean rank displacement:  ${meanDisp.toFixed(2)} positions`);
  console.log(`Spearman ρ:              ${spearman.toFixed(3)}`);
  console.log(`Kendall τ:               ${kendall.toFixed(3)}`);
  console.log(`Concordant pairs:        ${conc} / ${pairs} (${((100 * conc) / pairs).toFixed(1)}%)`);

  // Verify About tab renders.
  await page.locator('.tab[data-view="about"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-about").hidden);
  await page.waitForSelector("#view-about pre code", { state: "attached" });
  await page.screenshot({ path: `${OUT_DIR}/04-about.png`, fullPage: true });
  console.log(`\n✓ Saved ${OUT_DIR}/04-about.png`);

  // Mobile viewport.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('.tab[data-view="vote"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-vote").hidden);
  await page.waitForSelector(".song-card", { state: "attached" });
  await page.screenshot({ path: `${OUT_DIR}/05-mobile-vote.png`, fullPage: true });
  console.log(`✓ Saved ${OUT_DIR}/05-mobile-vote.png (mobile viewport)`);

  await page.locator('.tab[data-view="leaderboard"]').dispatchEvent("click");
  await page.waitForFunction(
    () => !document.getElementById("view-leaderboard").hidden
  );
  await page.screenshot({ path: `${OUT_DIR}/06-mobile-leaderboard.png`, fullPage: true });
  console.log(`✓ Saved ${OUT_DIR}/06-mobile-leaderboard.png (mobile viewport)`);

  if (consoleErrors.length) {
    console.log("\n⚠️  Console errors captured:");
    consoleErrors.forEach((e) => console.log("   " + e));
  } else {
    console.log("\n✓ No console errors.");
  }

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
