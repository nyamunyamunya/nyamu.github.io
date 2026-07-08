// Verify corrupt catalog data (duplicate ids, stale manual order) still shows
// every song in leaderboard drag order and voting.

const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const N_VOTES = parseInt(process.argv[2] || "80", 10);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("✓ " + msg);
}

function makeSong(id, title, artist, albumId) {
  return {
    id,
    title,
    artist,
    year: 2020,
    album: albumId ? "Test Album" : "",
    albumId: albumId || null,
    trackNumber: albumId ? parseInt(String(id).split("-").pop(), 10) || 1 : null,
    cover: "",
    hasAudio: false,
  };
}

(async () => {
  const albumId = "custom-album-test-album-test-artist";
  const albumTracks = Array.from({ length: 6 }, (_, i) =>
    makeSong(`${albumId}-track-${i + 1}`, `Track ${i + 1}`, "Test Artist", albumId)
  );
  const extras = [
    makeSong("custom-song-extra-one-solo", "Extra One", "Solo"),
    makeSong("custom-song-extra-two-solo", "Extra Two", "Solo"),
    makeSong("custom-song-extra-three-solo", "Extra Three", "Solo"),
    makeSong("custom-song-extra-four-solo", "Extra Four", "Solo"),
  ];
  const allSongs = [...albumTracks, ...extras];
  const corruptManualOrder = [
    albumTracks[0].id,
    albumTracks[0].id,
    albumTracks[1].id,
    albumTracks[1].id,
    albumTracks[2].id,
    albumTracks[2].id,
    albumTracks[3].id,
    albumTracks[3].id,
    albumTracks[4].id,
    albumTracks[4].id,
  ];
  const corruptCustomSongs = [
    ...allSongs,
    { ...extras[0] },
    { ...extras[1] },
  ];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ songs, manualLeaderboardOrder }) => {
      localStorage.clear();
      localStorage.setItem("song-ranker.custom-songs.v1", JSON.stringify(songs));
      localStorage.setItem(
        "song-ranker.v1",
        JSON.stringify({
          stats: {},
          voteCount: 0,
          seenPairKeys: [],
          shownSongIds: manualLeaderboardOrder.slice(0, 6),
          manualLeaderboardOrder,
        })
      );
    },
    { songs: corruptCustomSongs, manualLeaderboardOrder: corruptManualOrder }
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.tab[data-view="leaderboard"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-leaderboard").hidden);

  const leaderboardTitles = await page.$$eval(
    "#leaderboard-body tr[data-song-id] .song-cell-title",
    (nodes) => nodes.map((n) => n.textContent.trim())
  );
  assert(leaderboardTitles.length === 10, `leaderboard shows 10 rows (${leaderboardTitles.length})`);
  assert(
    new Set(leaderboardTitles).size === 10,
    `leaderboard has 10 unique songs (${new Set(leaderboardTitles).size})`
  );

  await page.locator('.tab[data-view="vote"]').dispatchEvent("click");
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');

  const seenTitles = new Set();
  for (let i = 0; i < N_VOTES; i++) {
    const titles = await page.evaluate(() => [
      document.querySelector('.song-card[data-side="a"] .song-title').textContent.trim(),
      document.querySelector('.song-card[data-side="b"] .song-title').textContent.trim(),
    ]);
    titles.forEach((t) => seenTitles.add(t));
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(240);
  }

  const expectedTitles = new Set(allSongs.map((s) => s.title));
  const missing = [...expectedTitles].filter((t) => !seenTitles.has(t));
  assert(
    missing.length === 0,
    `all songs voted (${missing.join(", ") || "none missing"})`
  );

  console.log("\n✓ Corrupt catalog repair passes.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
