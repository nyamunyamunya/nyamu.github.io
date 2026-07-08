// Verify all library songs can appear in voting (album tracks + extras).

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
    trackNumber: albumId ? parseInt(id.split("-").pop(), 10) || 1 : null,
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

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ songs }) => {
      localStorage.clear();
      localStorage.setItem("song-ranker.custom-songs.v1", JSON.stringify(songs));
      localStorage.setItem(
        "song-ranker.custom-albums.v1",
        JSON.stringify([
          {
            id: "custom-album-test-album-test-artist",
            title: "Test Album",
            artist: "Test Artist",
            year: 2020,
            cover: "",
            trackCount: 6,
          },
        ])
      );
    },
    { songs: allSongs }
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');

  const songCount = await page.evaluate(
    () => parseInt(document.getElementById("stat-songs").textContent, 10)
  );
  assert(songCount === 10, `library has 10 songs (${songCount})`);

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

  console.log(`Seen ${seenTitles.size}/${expectedTitles.size} unique songs in ${N_VOTES} votes`);
  if (missing.length) {
    console.log("Missing from vote pool:", missing.join(", "));
  }

  assert(
    missing.length === 0,
    `all 10 songs appeared in voting (missing: ${missing.join(", ") || "none"})`
  );

  console.log("\n✓ Vote pool covers full library.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
