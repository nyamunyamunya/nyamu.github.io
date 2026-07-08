// Album tracks with CJK titles must each get a unique id (no merge on load).

const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("✓ " + msg);
}

(async () => {
  const tracks = ["晴天", "七里香", "稻香", "夜曲", "发如雪", "东风破"];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.locator('.tab[data-view="songs"]').dispatchEvent("click");
  await page.locator('.form-switch[data-form="album"]').click();
  await page.fill("#field-album-title", "叶惠美");
  await page.fill("#field-album-artist", "周杰伦");
  await page.fill("#field-album-tracks", tracks.join("\n"));
  await page.click("#btn-add-album");
  await page.waitForSelector(".album-row");

  const after = await page.evaluate(() => {
    const songs = JSON.parse(localStorage.getItem("song-ranker.custom-songs.v1") || "[]");
    return {
      count: parseInt(document.getElementById("stat-songs").textContent, 10),
      ids: songs.map((s) => s.id),
      titles: songs.map((s) => s.title),
    };
  });

  assert(after.count === tracks.length, `song count is ${tracks.length} (${after.count})`);
  assert(new Set(after.ids).size === tracks.length, `unique ids (${new Set(after.ids).size})`);
  assert(
    after.titles.slice().sort().join("|") === tracks.slice().sort().join("|"),
    "all track titles preserved"
  );

  console.log("\n✓ CJK album tracks stay separate.");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
