// Verify add-album flow: bulk tracks, persistence after reload, delete album.

const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("✓ " + msg);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("dialog", (d) => d.accept());

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.locator('.tab[data-view="songs"]').dispatchEvent("click");
  await page.waitForFunction(() => !document.getElementById("view-songs").hidden);

  const baseCount = await page.evaluate(
    () => parseInt(document.getElementById("stat-songs").textContent, 10)
  );

  await page.locator('.form-switch[data-form="album"]').click();
  await page.waitForFunction(() => !document.getElementById("add-album-form").hidden);

  await page.fill("#field-album-title", "Abbey Road");
  await page.fill("#field-album-artist", "The Beatles");
  await page.fill("#field-album-year", "1969");
  await page.fill(
    "#field-album-tracks",
    "Come Together\nSomething\nHere Comes the Sun\nOh! Darling"
  );
  await page.click("#btn-add-album");
  await page.waitForSelector("#album-form-error:not([hidden])");
  const successMsg = await page.textContent("#album-form-error");
  assert(/Created.*4 track/i.test(successMsg), `success message: ${successMsg}`);

  const afterAdd = await page.evaluate(() => ({
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
    albums: JSON.parse(localStorage.getItem("song-ranker.custom-albums.v1") || "[]"),
    customSongs: JSON.parse(localStorage.getItem("song-ranker.custom-songs.v1") || "[]"),
  }));
  assert(afterAdd.songs === baseCount + 4, `song count +4 (${afterAdd.songs})`);
  assert(afterAdd.albums.length === 1, "one album in localStorage");
  assert(
    afterAdd.customSongs.filter((s) => s.album === "Abbey Road").length === 4,
    "4 tracks tagged with album name"
  );

  await page.locator('.album-row button[data-action="delete-album"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".album-row").length === 0
  );
  const afterDelete = await page.evaluate(() => ({
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
    albums: JSON.parse(localStorage.getItem("song-ranker.custom-albums.v1") || "[]"),
  }));
  assert(afterDelete.songs === baseCount, "all album tracks removed");
  assert(afterDelete.albums.length === 0, "album removed from storage");

  // Re-add and test reload persistence
  await page.fill("#field-album-title", "Test Album");
  await page.fill("#field-album-artist", "Test Artist");
  await page.fill("#field-album-tracks", "Track One\nTrack Two");
  await page.click("#btn-add-album");
  await page.waitForSelector(".album-row");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.tab[data-view="songs"]').dispatchEvent("click");
  await page.waitForSelector(".album-row");
  const afterReload = await page.evaluate(() => ({
    albums: JSON.parse(localStorage.getItem("song-ranker.custom-albums.v1") || "[]"),
    songs: parseInt(document.getElementById("stat-songs").textContent, 10),
  }));
  assert(afterReload.albums.length === 1, "album persists after reload");
  assert(afterReload.songs === baseCount + 2, "album tracks persist after reload");

  console.log("\n✓ Album flow passes.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
