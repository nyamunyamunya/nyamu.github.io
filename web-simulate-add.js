// End-to-end verification of the "add song" flow.
// - Clears state, adds two songs via the UI (one valid, one duplicate),
// - Casts a few votes and confirms the new songs entered the matchup rotation,
// - Reloads and checks that the added songs persisted in localStorage,
// - Deletes an added song and confirms it disappears.

const { chromium } = require("playwright");
const fs = require("fs");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const OUT_DIR = "screenshots";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("✓ " + msg);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');

  // Handle the eventual delete confirmation dialog.
  page.on("dialog", (d) => d.accept());

  const baseSongCount = await page.evaluate(
    () => parseInt(document.getElementById("stat-songs").textContent, 10)
  );
  console.log(`\nBase song count: ${baseSongCount}`);

  // ---- Open Songs tab ----
  await page.locator('.tab[data-view="songs"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-songs").hidden);
  await page.screenshot({
    path: `${OUT_DIR}/07-songs-empty.png`,
    fullPage: true,
  });
  console.log(`✓ Saved ${OUT_DIR}/07-songs-empty.png`);

  // ---- Add first custom song ----
  await page.fill("#field-title", "Yesterday");
  await page.fill("#field-artist", "The Beatles");
  await page.fill("#field-year", "1965");
  await page.click("#btn-add-song");
  await page.waitForSelector('.song-row[data-id^="custom-"]', { state: "attached" });

  let stats = await page.evaluate(() => ({
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
    customSongsRaw: localStorage.getItem("song-ranker.custom-songs.v1"),
  }));
  assert(stats.songs === baseSongCount + 1, "stat-songs incremented by 1");
  assert(
    stats.customSongsRaw &&
      JSON.parse(stats.customSongsRaw).some((s) => s.title === "Yesterday"),
    "Yesterday persisted to localStorage"
  );

  // ---- Add a second custom song ----
  await page.fill("#field-title", "Dreams");
  await page.fill("#field-artist", "Fleetwood Mac");
  await page.click("#btn-add-song");
  await page.waitForFunction(
    () => parseInt(document.getElementById("stat-songs").textContent, 10) >= 2
  );
  assert(
    (
      await page.evaluate(
        () => parseInt(document.getElementById("stat-songs").textContent, 10)
      )
    ) === baseSongCount + 2,
    "stat-songs is now baseSongCount + 2 after adding Dreams"
  );

  await page.screenshot({
    path: `${OUT_DIR}/08-songs-added.png`,
    fullPage: true,
  });
  console.log(`✓ Saved ${OUT_DIR}/08-songs-added.png`);

  // ---- Duplicate rejection ----
  await page.fill("#field-title", "Yesterday");
  await page.fill("#field-artist", "The Beatles");
  await page.click("#btn-add-song");
  await page.waitForSelector("#form-error:not([hidden])");
  const errorText = await page.textContent("#form-error");
  assert(
    /already/i.test(errorText),
    `Duplicate rejected with message: "${errorText}"`
  );

  // ---- Required-field validation ----
  await page.locator('#add-song-form button[type="reset"]').click();
  await page.fill("#field-title", "  ");
  await page.fill("#field-artist", "Someone");
  await page.click("#btn-add-song");
  await page.waitForSelector("#form-error:not([hidden])");
  const emptyErr = await page.textContent("#form-error");
  assert(/title/i.test(emptyErr), `Blank title rejected: "${emptyErr}"`);
  await page.locator('#add-song-form button[type="reset"]').click();

  // ---- Filter tabs ----
  await page.locator('.filter-tab[data-filter="custom"]').click();
  const customVisible = await page.$$eval(".song-row", (rows) =>
    rows.map((r) => r.dataset.id)
  );
  assert(
    customVisible.every((id) => id.startsWith("custom-")),
    `"Yours" filter shows only custom songs (${customVisible.length} rows)`
  );
  assert(customVisible.length === 2, "exactly 2 custom songs shown");

  await page.locator('.filter-tab[data-filter="builtin"]').click();
  const builtinVisible = await page.$$eval(".song-row", (rows) =>
    rows.map((r) => r.dataset.id)
  );
  assert(
    builtinVisible.every((id) => !id.startsWith("custom-")),
    `"Built-in" filter excludes custom songs`
  );
  assert(
    builtinVisible.length === baseSongCount,
    `"Built-in" filter shows all ${baseSongCount} base songs`
  );

  await page.locator('.filter-tab[data-filter="all"]').click();

  // ---- Confirm custom songs appear as matchup candidates ----
  await page.locator('.tab[data-view="vote"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-vote").hidden);

  const seenTitles = new Set();
  for (let i = 0; i < 60; i++) {
    const [tA, tB] = await page.evaluate(() => [
      document.querySelector('.song-card[data-side="a"] .song-title').textContent,
      document.querySelector('.song-card[data-side="b"] .song-title').textContent,
    ]);
    seenTitles.add(tA);
    seenTitles.add(tB);
    await page.keyboard.press(Math.random() < 0.5 ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(240);
  }
  assert(seenTitles.has("Yesterday"), "Yesterday appeared in a matchup");
  assert(seenTitles.has("Dreams"), "Dreams appeared in a matchup");

  const votes = await page.evaluate(
    () => parseInt(document.getElementById("stat-votes").textContent, 10)
  );
  assert(votes === 60, `60 votes recorded (stat-votes = ${votes})`);

  // ---- Reload — persistence check ----
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.song-card[data-side="a"] .song-title:not(:empty)');
  const afterReload = await page.evaluate(() => ({
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
    votes: parseInt(document.getElementById("stat-votes").textContent, 10),
    customSongs: JSON.parse(
      localStorage.getItem("song-ranker.custom-songs.v1") || "[]"
    ),
  }));
  assert(
    afterReload.songs === baseSongCount + 2,
    `after reload, song count still ${baseSongCount + 2}`
  );
  assert(afterReload.votes === 60, `after reload, votes still 60`);
  assert(
    afterReload.customSongs.length === 2,
    "custom songs list still contains 2 entries after reload"
  );

  // ---- Delete a custom song ----
  await page.locator('.tab[data-view="songs"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-songs").hidden);

  const yesterdayId = afterReload.customSongs.find((s) => s.title === "Yesterday").id;
  await page.locator(`button[data-action="delete-song"][data-id="${yesterdayId}"]`).click();
  await page.waitForFunction(
    (id) => !document.querySelector(`.song-row[data-id="${id}"]`),
    yesterdayId
  );
  const afterDelete = await page.evaluate(() => ({
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
    customSongs: JSON.parse(
      localStorage.getItem("song-ranker.custom-songs.v1") || "[]"
    ),
  }));
  assert(
    afterDelete.songs === baseSongCount + 1,
    "song count decremented after delete"
  );
  assert(
    afterDelete.customSongs.length === 1 &&
      afterDelete.customSongs[0].title === "Dreams",
    "only Dreams remains in custom songs"
  );

  await page.screenshot({
    path: `${OUT_DIR}/09-after-delete.png`,
    fullPage: true,
  });
  console.log(`✓ Saved ${OUT_DIR}/09-after-delete.png`);

  // Mobile view of the add-song form.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({
    path: `${OUT_DIR}/10-mobile-songs.png`,
    fullPage: true,
  });
  console.log(`✓ Saved ${OUT_DIR}/10-mobile-songs.png`);

  if (consoleErrors.length) {
    console.log("\n⚠️  Console errors captured:");
    consoleErrors.forEach((e) => console.log("   " + e));
    process.exitCode = 1;
  } else {
    console.log("\n✓ No console errors — full add-song flow passes.");
  }

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
