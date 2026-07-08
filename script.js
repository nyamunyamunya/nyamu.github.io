/**
 * Song Ranker — pairwise voting with Elo ratings.
 * Matchups use weighted random selection over the full library (coverage +
 * similar-rating refinement). All state is kept in localStorage.
 */
(() => {
  "use strict";

  const t = (key, params) => window.I18n.t(key, params);

  const STORAGE_KEY = "song-ranker.v1";
  const CUSTOM_SONGS_KEY = "song-ranker.custom-songs.v1";
  const CUSTOM_ALBUMS_KEY = "song-ranker.custom-albums.v1";
  const FAVORITE_STORAGE_KEY = "song-ranker.favorite.v1";
  const INITIAL_RATING = 1000;
  const K_FACTOR = 32;
  // Minimum votes per song before the progress bar reads as "complete".
  const VOTES_PER_SONG_TARGET = 5;

  function computeVoteTargets(songCount) {
    const n = songCount;
    if (n < 2) {
      return { target: 0, perSong: 0 };
    }
    return { target: n * VOTES_PER_SONG_TARGET, perSong: VOTES_PER_SONG_TARGET };
  }

  function getAccurateVoteTarget() {
    return computeVoteTargets(state.songs.length).target;
  }

  function getVoteAccuracyInfo() {
    const n = state.songs.length;
    const { target, perSong } = computeVoteTargets(n);
    const votes = state.voteCount;
    const perSongCounts = state.songs.map((s) => voteTotalForId(s.id));
    const minVotes = perSongCounts.length ? Math.min(...perSongCounts) : 0;
    const unvoted = perSongCounts.filter((v) => v === 0).length;
    const allAtTarget = n >= 2 && minVotes >= perSong;
    const voteTargetMet = votes >= target && allAtTarget;

    return {
      songCount: n,
      target,
      votes,
      remaining: Math.max(0, target - votes),
      progress: target > 0 ? Math.min(1, votes / target) : 1,
      unvoted,
      minVotes,
      perSongTarget: perSong,
      allVoted: unvoted === 0,
      voteTargetMet,
      ready: voteTargetMet,
      perSong,
    };
  }

  const state = {
    customSongs: [], // saved in localStorage
    customAlbums: [],
    songs: [], // mirror of customSongs
    stats: {}, // id -> { rating, wins, losses, ties }
    voteCount: 0,
    current: null, // { a: id, b: id }
    lastPair: null, // avoid immediate repeats
    matchupHistory: [], // past pairs for ← / → navigation
    historyCursor: -1, // -1 = live; else index into matchupHistory
    liveCurrent: null, // current pair saved while browsing history
    seenPairKeys: [],
    shownSongIds: [],
    manualLeaderboardOrder: null,
    addFormMode: "song", // "song" | "album"
    leaderboardMode: "songs", // "songs" | "albums"
  };

  const favoriteState = {
    remainingIds: [],
    current: null, // { a: id, b: id }
    championId: null,
  };

  const CUSTOM_ID_PREFIX = "custom-";
  const CUSTOM_ALBUM_ID_PREFIX = "custom-album-";
  const MAX_COVER_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_COVER_DIM = 400;
  const MAX_COVER_DATA_URL_LEN = 220_000;
  const AUDIO_DB_NAME = "song-ranker.audio.v1";
  const AUDIO_STORE = "clips";
  const MAX_AUDIO_FILE_BYTES = 8 * 1024 * 1024;

  let activePreviewAudio = null;
  let activePreviewUrl = null;
  let activePreviewPlayer = null;
  let isScrubbing = false;
  let scrubState = null;

  function formatAudioTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function getPlayerParts(playerEl) {
    return {
      playBtn: playerEl.querySelector(".song-player-play"),
      icon: playerEl.querySelector(".song-player-icon"),
      fill: playerEl.querySelector(".song-scrub-fill"),
      thumb: playerEl.querySelector(".song-scrub-thumb"),
      scrub: playerEl.querySelector(".song-scrub"),
      current: playerEl.querySelector(".song-player-current"),
      duration: playerEl.querySelector(".song-player-duration"),
    };
  }

  function resetPlayerUI(playerEl) {
    if (!playerEl) return;
    const parts = getPlayerParts(playerEl);
    if (parts.icon) parts.icon.textContent = "▶";
    if (parts.playBtn) {
      parts.playBtn.classList.remove("is-playing");
      parts.playBtn.setAttribute("aria-label", t("vote.playPreview"));
    }
    if (parts.fill) parts.fill.style.width = "0%";
    if (parts.thumb) parts.thumb.style.left = "0%";
    if (parts.scrub) parts.scrub.setAttribute("aria-valuenow", "0");
    if (parts.current) parts.current.textContent = "0:00";
    if (parts.duration) parts.duration.textContent = "0:00";
  }

  function syncPlayerUI(playerEl, audio) {
    if (!playerEl || !audio) return;
    const parts = getPlayerParts(playerEl);
    const dur = audio.duration;
    const cur = audio.currentTime;
    const ratio = dur > 0 && Number.isFinite(dur) ? cur / dur : 0;
    const pct = `${Math.max(0, Math.min(100, ratio * 100))}%`;
    if (parts.fill) parts.fill.style.width = pct;
    if (parts.thumb) parts.thumb.style.left = pct;
    if (parts.scrub) {
      parts.scrub.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    }
    if (parts.current) parts.current.textContent = formatAudioTime(cur);
    if (parts.duration) parts.duration.textContent = formatAudioTime(dur);
    const playing = !audio.paused && !audio.ended;
    if (parts.icon) parts.icon.textContent = playing ? "⏸" : "▶";
    if (parts.playBtn) {
      parts.playBtn.classList.toggle("is-playing", playing);
      parts.playBtn.setAttribute(
        "aria-label",
        playing ? t("vote.pausePreview") : t("vote.playPreview")
      );
    }
  }

  function onPreviewTimeUpdate() {
    if (isScrubbing || !activePreviewPlayer || !activePreviewAudio) return;
    syncPlayerUI(activePreviewPlayer, activePreviewAudio);
  }

  function onPreviewMetadata() {
    if (!activePreviewPlayer || !activePreviewAudio) return;
    syncPlayerUI(activePreviewPlayer, activePreviewAudio);
  }

  function onPreviewEnded() {
    stopActivePreview();
  }

  function detachPreviewAudioListeners() {
    if (!activePreviewAudio) return;
    activePreviewAudio.removeEventListener("timeupdate", onPreviewTimeUpdate);
    activePreviewAudio.removeEventListener("loadedmetadata", onPreviewMetadata);
    activePreviewAudio.removeEventListener("ended", onPreviewEnded);
  }

  function attachPreviewAudioListeners() {
    if (!activePreviewAudio) return;
    activePreviewAudio.addEventListener("timeupdate", onPreviewTimeUpdate);
    activePreviewAudio.addEventListener("loadedmetadata", onPreviewMetadata);
    activePreviewAudio.addEventListener("ended", onPreviewEnded);
  }

  function openAudioDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(AUDIO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(AUDIO_STORE, { keyPath: "songId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveSongAudio(songId, file) {
    const isAudio =
      file.type.startsWith("audio/") ||
      /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || "");
    if (!isAudio) {
      throw new Error(t("error.audioType"));
    }
    if (file.size > MAX_AUDIO_FILE_BYTES) {
      throw new Error(t("error.audioSize"));
    }

    const db = await openAudioDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readwrite");
      tx.objectStore(AUDIO_STORE).put({
        songId,
        blob: file,
        mime: file.type || "audio/mpeg",
        name: file.name || "",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function getSongAudioBlob(songId) {
    try {
      const db = await openAudioDB();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIO_STORE, "readonly");
        const req = tx.objectStore(AUDIO_STORE).get(songId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return record?.blob || null;
    } catch {
      return null;
    }
  }

  async function deleteSongAudio(songId) {
    try {
      const db = await openAudioDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIO_STORE, "readwrite");
        tx.objectStore(AUDIO_STORE).delete(songId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }

  async function clearAllSongAudio() {
    try {
      const db = await openAudioDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIO_STORE, "readwrite");
        tx.objectStore(AUDIO_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      /* ignore */
    }
  }

  function stopActivePreview() {
    detachPreviewAudioListeners();
    if (activePreviewAudio) {
      activePreviewAudio.pause();
      activePreviewAudio = null;
    }
    if (activePreviewUrl) {
      URL.revokeObjectURL(activePreviewUrl);
      activePreviewUrl = null;
    }
    if (activePreviewPlayer) {
      resetPlayerUI(activePreviewPlayer);
      activePreviewPlayer = null;
    }
    isScrubbing = false;
    scrubState = null;
  }

  async function ensurePreviewAudio(songId, playerEl) {
    if (activePreviewPlayer === playerEl && activePreviewAudio) {
      return true;
    }

    stopActivePreview();
    const blob = await getSongAudioBlob(songId);
    if (!blob) return false;

    const url = URL.createObjectURL(blob);
    activePreviewUrl = url;
    activePreviewAudio = new Audio(url);
    activePreviewPlayer = playerEl;
    attachPreviewAudioListeners();
    return true;
  }

  async function startSongPreview(songId, playerEl) {
    const ready = await ensurePreviewAudio(songId, playerEl);
    if (!ready || !activePreviewAudio) return;

    try {
      await activePreviewAudio.play();
      syncPlayerUI(playerEl, activePreviewAudio);
    } catch {
      stopActivePreview();
    }
  }

  async function toggleSongPreview(songId, playerEl) {
    if (activePreviewPlayer === playerEl && activePreviewAudio) {
      if (activePreviewAudio.paused) {
        try {
          await activePreviewAudio.play();
        } catch {
          stopActivePreview();
          return;
        }
      } else {
        activePreviewAudio.pause();
      }
      syncPlayerUI(playerEl, activePreviewAudio);
      return;
    }

    await startSongPreview(songId, playerEl);
  }

  function getScrubRatio(scrubEl, clientX) {
    const track = scrubEl.querySelector(".song-scrub-track");
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  async function seekSongPreview(songId, playerEl, ratio) {
    if (activePreviewPlayer !== playerEl || !activePreviewAudio) {
      const ready = await ensurePreviewAudio(songId, playerEl);
      if (!ready) return;
    }
    seekPreviewPosition(ratio);
  }

  function seekPreviewPosition(ratio) {
    if (!activePreviewAudio || !activePreviewPlayer) return;
    const dur = activePreviewAudio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      activePreviewAudio.currentTime = Math.max(0, Math.min(dur, ratio * dur));
    }
    syncPlayerUI(activePreviewPlayer, activePreviewAudio);
  }

  // ---------- Storage ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          stats: state.stats,
          voteCount: state.voteCount,
          seenPairKeys: state.seenPairKeys,
          shownSongIds: state.shownSongIds,
          manualLeaderboardOrder: state.manualLeaderboardOrder,
        })
      );
    } catch {
      /* localStorage may be unavailable in private mode */
    }
  }

  function loadCustomSongs() {
    try {
      const raw = localStorage.getItem(CUSTOM_SONGS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const songs = [];
      const seen = new Set();
      for (const entry of parsed) {
        const song = normalizeSongRecord(entry);
        if (!song || !isValidSongShape(song) || seen.has(song.id)) continue;
        seen.add(song.id);
        songs.push(song);
      }
      return songs;
    } catch {
      return [];
    }
  }

  function saveCustomSongs() {
    try {
      localStorage.setItem(
        CUSTOM_SONGS_KEY,
        JSON.stringify(state.customSongs)
      );
    } catch {
      /* ignore */
    }
  }

  function loadCustomAlbums() {
    try {
      const raw = localStorage.getItem(CUSTOM_ALBUMS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidAlbumShape);
    } catch {
      return [];
    }
  }

  function saveCustomAlbums() {
    try {
      localStorage.setItem(
        CUSTOM_ALBUMS_KEY,
        JSON.stringify(state.customAlbums)
      );
    } catch {
      /* ignore */
    }
  }

  function isValidSongShape(obj) {
    return (
      obj &&
      typeof obj.id === "string" &&
      obj.id.length > 0 &&
      typeof obj.title === "string" &&
      typeof obj.artist === "string"
    );
  }

  function normalizeSongRecord(song) {
    if (!song || typeof song !== "object") return null;
    const id = typeof song.id === "string" ? song.id.trim() : String(song.id || "").trim();
    const title = typeof song.title === "string" ? song.title.trim() : "";
    const artist = typeof song.artist === "string" ? song.artist.trim() : "";
    if (!id || !title || !artist) return null;
    return { ...song, id, title, artist };
  }

  function getUniqueSongIds() {
    return dedupePreserveOrder(state.songs.map((song) => song.id));
  }

  function getSongsById() {
    const map = new Map();
    for (const song of state.songs) {
      if (!map.has(song.id)) map.set(song.id, song);
    }
    return map;
  }

  function isValidAlbumShape(obj) {
    return (
      obj &&
      typeof obj.id === "string" &&
      typeof obj.title === "string" &&
      typeof obj.artist === "string"
    );
  }

  // ---------- Data loading ----------
  function isAlbumTrack(song) {
    if (!song || !song.albumId) return false;
    return state.customAlbums.some((album) => album.id === song.albumId);
  }

  function getAlbumTracks(albumId) {
    return state.customSongs.filter(
      (song) => song.albumId === albumId && isAlbumTrack(song)
    );
  }

  function reconcileAlbums() {
    const validAlbumIds = new Set(state.customAlbums.map((album) => album.id));
    for (const song of state.customSongs) {
      if (song.albumId && !validAlbumIds.has(song.albumId)) {
        delete song.albumId;
        delete song.album;
        delete song.trackNumber;
      }
    }
    for (const album of state.customAlbums) {
      const count = getAlbumTracks(album.id).length;
      album.trackCount = count;
    }
    state.customAlbums = state.customAlbums.filter((a) => a.trackCount > 0);
    saveCustomSongs();
    saveCustomAlbums();
  }

  function mergeSongs() {
    const songs = [];
    const seen = new Set();
    for (const entry of state.customSongs) {
      const song = normalizeSongRecord(entry);
      if (!song || !isValidSongShape(song) || seen.has(song.id)) continue;
      seen.add(song.id);
      songs.push(song);
    }
    state.songs = songs;
    if (state.songs.length !== state.customSongs.length) {
      state.customSongs = [...state.songs];
      saveCustomSongs();
    }
    const valid = new Set(state.songs.map((s) => s.id));
    state.shownSongIds = state.shownSongIds.filter((id) => valid.has(id));
    validateManualLeaderboardOrder();
    reconcileSeenPairKeys();
  }

  function reconcileSeenPairKeys() {
    const valid = new Set(state.songs.map((s) => s.id));
    state.seenPairKeys = state.seenPairKeys.filter((key) => {
      const parts = key.split("::");
      if (parts.length !== 2) return false;
      const [a, b] = parts;
      return valid.has(a) && valid.has(b) && a !== b;
    });
  }

  function sanitizeStatsEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      rating: Number.isFinite(raw.rating) ? raw.rating : INITIAL_RATING,
      wins: Number.isFinite(raw.wins) ? raw.wins : 0,
      losses: Number.isFinite(raw.losses) ? raw.losses : 0,
      ties: Number.isFinite(raw.ties) ? raw.ties : 0,
      manualRank: Boolean(raw.manualRank),
    };
  }

  function sanitizeLoadedStats(stats) {
    const cleaned = {};
    for (const [id, entry] of Object.entries(stats || {})) {
      const st = sanitizeStatsEntry(entry);
      if (st) cleaned[id] = st;
    }
    return cleaned;
  }

  function clearStaleManualRanks() {
    for (const id of Object.keys(state.stats)) {
      const st = state.stats[id];
      if (st?.manualRank && !hasVoteHistory(id)) {
        st.manualRank = false;
        st.rating = INITIAL_RATING;
      }
    }
  }

  function ensureStats() {
    for (const song of state.songs) {
      if (!state.stats[song.id]) {
        state.stats[song.id] = {
          rating: INITIAL_RATING,
          wins: 0,
          losses: 0,
          ties: 0,
          manualRank: false,
        };
      }
    }
    // Drop stats for songs that no longer exist.
    const validIds = new Set(state.songs.map((s) => s.id));
    for (const id of Object.keys(state.stats)) {
      if (!validIds.has(id)) delete state.stats[id];
    }
  }

  function isCustomSong(id) {
    return typeof id === "string" && id.startsWith(CUSTOM_ID_PREFIX);
  }

  function isCustomAlbum(id) {
    return typeof id === "string" && id.startsWith(CUSTOM_ALBUM_ID_PREFIX);
  }

  function slugify(str) {
    return String(str)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  function generateCustomId(title, artist, albumId, trackNumber) {
    if (albumId && Number.isFinite(trackNumber)) {
      return generateAlbumTrackId(albumId, trackNumber, title);
    }
    const prefix = `${CUSTOM_ID_PREFIX}${slugify(title)}-${slugify(artist)}`;
    const base = prefix.replace(/--+/g, "-");
    const existing = new Set(state.songs.map((s) => s.id));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  function generateAlbumTrackId(albumId, trackNumber, title) {
    const existing = new Set(state.songs.map((s) => s.id));
    const numbered = `${albumId}-track-${trackNumber}`;
    if (!existing.has(numbered)) return numbered;

    const slug = slugify(title);
    if (slug) {
      const slugged = `${albumId}-${slug}`;
      if (!existing.has(slugged)) return slugged;
    }

    let n = 2;
    while (existing.has(`${numbered}-${n}`)) n++;
    return `${numbered}-${n}`;
  }

  function generateAlbumId(title, artist) {
    const base = `${CUSTOM_ALBUM_ID_PREFIX}${slugify(title)}-${slugify(artist)}`.replace(
      /--+/g,
      "-"
    );
    const existing = new Set(state.customAlbums.map((a) => a.id));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  function findDuplicate(title, artist, { albumId = null, allowAlbumTrack = false } = {}) {
    const t = title.trim().toLowerCase();
    const a = artist.trim().toLowerCase();
    return state.songs.find((s) => {
      if ((s.title || "").trim().toLowerCase() !== t) return false;
      if ((s.artist || "").trim().toLowerCase() !== a) return false;
      if (albumId) {
        return s.albumId === albumId;
      }
      if (allowAlbumTrack) return false;
      return !s.albumId;
    });
  }

  function findDuplicateAlbum(title, artist) {
    const t = title.trim().toLowerCase();
    const a = artist.trim().toLowerCase();
    return state.customAlbums.find(
      (album) =>
        (album.title || "").trim().toLowerCase() === t &&
        (album.artist || "").trim().toLowerCase() === a
    );
  }

  function addSong({ title, artist, year, cover, album, albumId, trackNumber, hasAudio }) {
    const cleanTitle = title.trim();
    const cleanArtist = artist.trim();
    if (!cleanTitle) throw new Error(t("error.titleRequired"));
    if (!cleanArtist) throw new Error(t("error.artistRequired"));

    const dup = findDuplicate(cleanTitle, cleanArtist);
    if (dup) {
      throw new Error(
        `"${cleanTitle}" by ${cleanArtist} is already in the list.`
      );
    }

    const song = {
      id: generateCustomId(cleanTitle, cleanArtist, albumId, trackNumber),
      title: cleanTitle,
      artist: cleanArtist,
    };
    if (year && Number.isFinite(Number(year))) {
      song.year = Number(year);
    }
    if (cover) {
      song.cover = cover;
    }
    if (album && album.trim() && albumId) {
      song.album = album.trim();
    }
    if (albumId) {
      song.albumId = albumId;
    }
    if (trackNumber && Number.isFinite(Number(trackNumber))) {
      song.trackNumber = Number(trackNumber);
    }
    if (hasAudio) {
      song.hasAudio = true;
    }

    state.customSongs.push(song);
    saveCustomSongs();
    mergeSongs();
    ensureStats();
    pruneVoteState();
    if (state.songs.length >= 2) {
      state.current = pickMatchup();
      saveState();
    }
    return song;
  }

  function parseAlbumTrackTitles(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function addAlbum({ title, artist, year, cover, trackTitles }) {
    const cleanTitle = title.trim();
    const cleanArtist = artist.trim();
    if (!cleanTitle) throw new Error(t("error.albumTitleRequired"));
    if (!cleanArtist) throw new Error(t("error.artistRequired"));

    const titles = parseAlbumTrackTitles(trackTitles);
    if (titles.length === 0) {
      throw new Error(t("error.enterTracks"));
    }

    const dupAlbum = findDuplicateAlbum(cleanTitle, cleanArtist);
    if (dupAlbum) {
      throw new Error(
        t("error.albumAlreadyInList", { title: cleanTitle, artist: cleanArtist })
      );
    }

    const albumId = generateAlbumId(cleanTitle, cleanArtist);

    const songs = titles.map((trackTitle, index) => {
      const trackNumber = index + 1;
      const song = {
        id: generateAlbumTrackId(albumId, trackNumber, trackTitle),
        title: trackTitle,
        artist: cleanArtist,
        albumId,
        album: cleanTitle,
        trackNumber,
      };
      if (year && Number.isFinite(Number(year))) {
        song.year = Number(year);
      }
      if (cover) {
        song.cover = cover;
      }
      return song;
    });

    const album = {
      id: albumId,
      title: cleanTitle,
      artist: cleanArtist,
      trackCount: songs.length,
    };
    if (year && Number.isFinite(Number(year))) {
      album.year = Number(year);
    }
    if (cover) {
      album.cover = cover;
    }

    for (const song of songs) {
      state.customSongs.push(song);
    }

    state.customAlbums.push(album);
    saveCustomSongs();
    saveCustomAlbums();
    mergeSongs();
    ensureStats();
    pruneVoteState();
    if (state.songs.length >= 2) {
      state.current = pickMatchup();
      saveState();
    }

    return { album, songs };
  }

  function removeSong(id) {
    const song = state.customSongs.find((s) => s.id === id);
    if (!song) return false;

    const before = state.customSongs.length;
    state.customSongs = state.customSongs.filter((s) => s.id !== id);
    if (state.customSongs.length === before) return false;

    saveCustomSongs();
    if (song.albumId) syncAlbumTrackCount(song.albumId);
    if (song.hasAudio) deleteSongAudio(id);

    delete state.stats[id];
    mergeSongs();
    pruneVoteState();

    if (
      state.current &&
      (state.current.a === id || state.current.b === id)
    ) {
      state.current = pickMatchup();
    }
    saveState();
    return true;
  }

  function clearAllSongs() {
    const count = state.songs.length;
    if (count === 0) return false;

    if (
      !confirm(
        t("confirm.clearAll", { count })
      )
    ) {
      return false;
    }

    const removedIds = state.songs.map((s) => s.id);

    state.customSongs = [];
    state.customAlbums = [];

    for (const id of removedIds) delete state.stats[id];
    clearAllSongAudio();

    saveCustomSongs();
    saveCustomAlbums();
    mergeSongs();

    state.lastPair = null;
    clearMatchupHistory();
    state.seenPairKeys = [];
    state.shownSongIds = [];
    state.manualLeaderboardOrder = null;
    state.current = state.songs.length >= 2 ? pickMatchup() : null;
    clearFavoriteState();
    saveState();
    return true;
  }

  function syncAlbumTrackCount(albumId) {
    const remaining = getAlbumTracks(albumId).length;
    if (remaining === 0) {
      state.customAlbums = state.customAlbums.filter((a) => a.id !== albumId);
      saveCustomAlbums();
      return;
    }
    const album = state.customAlbums.find((a) => a.id === albumId);
    if (album) {
      album.trackCount = remaining;
      saveCustomAlbums();
    }
  }

  function removeAlbum(albumId) {
    if (!isCustomAlbum(albumId)) return false;
    const before = state.customAlbums.length;
    const trackIds = state.customSongs
      .filter((s) => s.albumId === albumId)
      .map((s) => s.id);

    state.customAlbums = state.customAlbums.filter((a) => a.id !== albumId);
    if (state.customAlbums.length === before) return false;

    state.customSongs = state.customSongs.filter((s) => s.albumId !== albumId);
    for (const id of trackIds) {
      delete state.stats[id];
      deleteSongAudio(id);
    }

    saveCustomAlbums();
    saveCustomSongs();
    mergeSongs();
    pruneVoteState();

    if (
      state.current &&
      (trackIds.includes(state.current.a) || trackIds.includes(state.current.b))
    ) {
      state.current = pickMatchup();
    }
    saveState();
    return true;
  }

  // ---------- Elo ----------
  function expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  }

  /**
   * scoreA is 1 for A wins, 0 for B wins, 0.5 for a tie.
   * When the user has manually ordered songs, only W–L–T change — ratings stay
   * tied to drag order until the user reorders again.
   */
  function applyElo(idA, idB, scoreA) {
    const a = state.stats[idA];
    const b = state.stats[idB];

    if (scoreA === 1) {
      a.wins += 1;
      b.losses += 1;
    } else if (scoreA === 0) {
      b.wins += 1;
      a.losses += 1;
    } else {
      a.ties += 1;
      b.ties += 1;
    }

    if (hasManualRanking()) return;

    const eA = expectedScore(a.rating, b.rating);
    const eB = 1 - eA;
    const scoreB = 1 - scoreA;
    a.rating = Math.round(a.rating + K_FACTOR * (scoreA - eA));
    b.rating = Math.round(b.rating + K_FACTOR * (scoreB - eB));
  }

  function hasManualRanking() {
    return Boolean(state.manualLeaderboardOrder?.length);
  }

  function voteTotalForSong(song) {
    const st = state.stats[song.id];
    return st.wins + st.losses + st.ties;
  }

  function songById(id) {
    return state.songs.find((s) => s.id === id);
  }

  function songsAreComparable(aId, bId) {
    if (!aId || !bId || aId === bId) return false;
    return Boolean(songById(aId) && songById(bId));
  }

  function dedupePreserveOrder(ids) {
    const seen = new Set();
    return ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function voteTotalForId(id) {
    const st = state.stats[id];
    if (!st) return 0;
    return st.wins + st.losses + st.ties;
  }

  function winRateForId(id) {
    const st = state.stats[id];
    if (!st) return null;
    const total = st.wins + st.losses + st.ties;
    if (!total) return null;
    return (st.wins + st.ties * 0.5) / total;
  }

  function hasBeenShown(id) {
    return state.shownSongIds.includes(id);
  }

  function hasVoteHistory(id) {
    return voteTotalForId(id) > 0;
  }

  function songHasRank(id) {
    return hasVoteHistory(id) || Boolean(state.stats[id]?.manualRank);
  }

  function pruneVoteState() {
    reconcileSeenPairKeys();
    const valid = new Set(state.songs.map((s) => s.id));
    state.shownSongIds = state.shownSongIds.filter((id) => valid.has(id));
  }

  function isViewingHistory() {
    return state.historyCursor >= 0;
  }

  function isLiveMatchup() {
    return state.historyCursor === -1;
  }

  function clearMatchupHistory() {
    state.matchupHistory = [];
    state.historyCursor = -1;
    state.liveCurrent = null;
  }

  function recordCurrentInHistory() {
    if (!state.current || !isLiveMatchup()) return;
    const cur = state.current;
    const last = state.matchupHistory[state.matchupHistory.length - 1];
    if (last && last.a === cur.a && last.b === cur.b) return;
    state.matchupHistory.push({ a: cur.a, b: cur.b });
    if (state.matchupHistory.length > 100) {
      state.matchupHistory.shift();
    }
  }

  function goPreviousMatchup() {
    if (!state.matchupHistory.length) return false;

    if (state.historyCursor === -1) {
      state.liveCurrent = state.current ? { ...state.current } : null;
      state.historyCursor = state.matchupHistory.length - 1;
    } else if (state.historyCursor > 0) {
      state.historyCursor -= 1;
    } else {
      return false;
    }

    state.current = { ...state.matchupHistory[state.historyCursor] };
    renderMatchup();
    return true;
  }

  function goNextMatchup() {
    if (!isViewingHistory()) return false;

    if (state.historyCursor < state.matchupHistory.length - 1) {
      state.historyCursor += 1;
      state.current = { ...state.matchupHistory[state.historyCursor] };
    } else {
      state.historyCursor = -1;
      state.current = state.liveCurrent;
      state.liveCurrent = null;
      if (!state.current) {
        state.current = pickMatchup();
      }
    }

    renderMatchup();
    return true;
  }

  function updateMatchupNavControls() {
    if (els.matchup) {
      els.matchup.classList.toggle("is-viewing-history", isViewingHistory());
    }
  }

  // ---------- Favorite song (elimination, isolated from rankings) ----------
  function loadFavoriteState() {
    try {
      const raw = localStorage.getItem(FAVORITE_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.remainingIds)) {
        favoriteState.remainingIds = saved.remainingIds.filter(
          (id) => typeof id === "string"
        );
      }
      if (
        saved.current &&
        typeof saved.current.a === "string" &&
        typeof saved.current.b === "string"
      ) {
        favoriteState.current = { a: saved.current.a, b: saved.current.b };
      }
      if (typeof saved.championId === "string") {
        favoriteState.championId = saved.championId;
      }
    } catch {
      /* ignore */
    }
  }

  function saveFavoriteState() {
    try {
      localStorage.setItem(
        FAVORITE_STORAGE_KEY,
        JSON.stringify({
          remainingIds: favoriteState.remainingIds,
          current: favoriteState.current,
          championId: favoriteState.championId,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function clearFavoriteState() {
    favoriteState.remainingIds = [];
    favoriteState.current = null;
    favoriteState.championId = null;
    try {
      localStorage.removeItem(FAVORITE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function pickFavoriteMatchup() {
    const ids = favoriteState.remainingIds;
    if (ids.length < 2) return null;
    const i = Math.floor(Math.random() * ids.length);
    let j = Math.floor(Math.random() * (ids.length - 1));
    if (j >= i) j += 1;
    const aId = ids[i];
    const bId = ids[j];
    if (!songsAreComparable(aId, bId)) return null;
    return Math.random() < 0.5 ? { a: aId, b: bId } : { a: bId, b: aId };
  }

  function reconcileFavoriteWithLibrary() {
    const valid = new Set(getUniqueSongIds());
    favoriteState.remainingIds = dedupePreserveOrder(
      favoriteState.remainingIds.filter((id) => valid.has(id))
    );

    if (favoriteState.championId && !valid.has(favoriteState.championId)) {
      favoriteState.championId = null;
    }

    if (favoriteState.current) {
      const { a, b } = favoriteState.current;
      if (!valid.has(a) || !valid.has(b) || !songsAreComparable(a, b)) {
        favoriteState.current = null;
      }
    }

    if (favoriteState.championId) {
      if (!favoriteState.remainingIds.includes(favoriteState.championId)) {
        favoriteState.remainingIds = [favoriteState.championId];
      }
      favoriteState.current = null;
      return;
    }

    if (favoriteState.remainingIds.length === 1) {
      favoriteState.championId = favoriteState.remainingIds[0];
      favoriteState.current = null;
      return;
    }

    if (favoriteState.remainingIds.length >= 2 && !favoriteState.current) {
      favoriteState.current = pickFavoriteMatchup();
    }
  }

  function resetFavoriteRun({ confirmRestart = false } = {}) {
    if (confirmRestart && !confirm(t("confirm.restartFavorite"))) return;

    mergeSongs();
    const catalog = getUniqueSongIds();
    if (catalog.length < 2) {
      clearFavoriteState();
      renderFavoriteView();
      return;
    }

    favoriteState.championId = null;
    favoriteState.remainingIds = [...catalog];
    favoriteState.current = pickFavoriteMatchup();
    saveFavoriteState();
    renderFavoriteView();
  }

  function ensureFavoriteRun() {
    mergeSongs();
    const catalog = getUniqueSongIds();
    if (catalog.length < 2) {
      clearFavoriteState();
      return;
    }

    if (
      !favoriteState.remainingIds.length &&
      !favoriteState.championId &&
      !favoriteState.current
    ) {
      favoriteState.remainingIds = [...catalog];
      favoriteState.current = pickFavoriteMatchup();
      saveFavoriteState();
      return;
    }

    reconcileFavoriteWithLibrary();
    saveFavoriteState();
  }

  function favoritePick(side) {
    if (!favoriteState.current || favoriteState.championId) return;
    stopActivePreview();

    const { a, b } = favoriteState.current;
    const winnerId = side === "a" ? a : b;
    const loserId = side === "a" ? b : a;

    if (side === "a") {
      els.favoriteCardA.classList.add("is-picked");
      els.favoriteCardB.classList.add("is-loser");
    } else {
      els.favoriteCardB.classList.add("is-picked");
      els.favoriteCardA.classList.add("is-loser");
    }

    favoriteState.remainingIds = favoriteState.remainingIds.filter(
      (id) => id !== loserId
    );

    setTimeout(() => {
      if (favoriteState.remainingIds.length === 1) {
        favoriteState.championId = favoriteState.remainingIds[0];
        favoriteState.current = null;
      } else {
        favoriteState.current = pickFavoriteMatchup();
      }
      saveFavoriteState();
      renderFavoriteView();
    }, 220);
  }

  function renderFavoriteView() {
    mergeSongs();
    ensureFavoriteRun();

    const catalogCount = getUniqueSongIds().length;
    const canPlay = catalogCount >= 2;

    if (els.favoriteEmpty) {
      els.favoriteEmpty.hidden = canPlay;
    }
    if (els.favoriteActive) {
      els.favoriteActive.hidden = !canPlay;
    }
    if (!canPlay) {
      return;
    }

    const showingWinner = Boolean(favoriteState.championId);
    if (els.favoriteWinner) {
      els.favoriteWinner.hidden = !showingWinner;
    }
    if (els.favoriteMatchup) {
      els.favoriteMatchup.hidden = showingWinner;
    }
    if (els.btnFavoriteRestart) {
      els.btnFavoriteRestart.hidden = false;
    }

    if (els.favoriteStatus) {
      if (showingWinner) {
        els.favoriteStatus.textContent = "";
      } else {
        els.favoriteStatus.textContent = t("favorite.remaining", {
          count: favoriteState.remainingIds.length,
        });
      }
    }

    if (showingWinner) {
      renderCard(els.favoriteWinnerCard, favoriteState.championId);
      return;
    }

    if (favoriteState.current) {
      renderCard(els.favoriteCardA, favoriteState.current.a);
      renderCard(els.favoriteCardB, favoriteState.current.b);
    }
  }

  function isFavoriteViewActive() {
    return els.views.favorite && !els.views.favorite.hidden;
  }

  function attachFavoriteMatchupEvents() {
    if (!els.favoriteMatchup || !els.favoriteCardA || !els.favoriteCardB) return;

    els.favoriteCardA.addEventListener("click", (e) => {
      if (e.target.closest(".song-player")) return;
      favoritePick("a");
    });
    els.favoriteCardB.addEventListener("click", (e) => {
      if (e.target.closest(".song-player")) return;
      favoritePick("b");
    });
    els.favoriteCardA.addEventListener("keydown", (e) => {
      if (e.target.closest(".song-player")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        favoritePick("a");
      }
    });
    els.favoriteCardB.addEventListener("keydown", (e) => {
      if (e.target.closest(".song-player")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        favoritePick("b");
      }
    });

    els.favoriteMatchup.addEventListener("click", (e) => {
      const playBtn = e.target.closest(".song-player-play");
      if (!playBtn) return;
      e.stopPropagation();
      const player = playBtn.closest(".song-player");
      const songId = getSongIdFromPlayer(player);
      if (songId) toggleSongPreview(songId, player);
    });
    els.favoriteMatchup.addEventListener("pointerdown", handlePlayerScrubPointerDown);
    els.favoriteMatchup.addEventListener("pointermove", handlePlayerScrubPointerMove);
    els.favoriteMatchup.addEventListener("pointerup", handlePlayerScrubPointerUp);
    els.favoriteMatchup.addEventListener("pointercancel", handlePlayerScrubPointerUp);
    els.favoriteMatchup.addEventListener("keydown", handlePlayerScrubKeydown);
  }

  // ---------- Matchup selection (coverage + Elo refinement) ----------
  function pairKey(a, b) {
    return [a, b].sort().join("::");
  }

  function flipPair(aId, bId) {
    if (!songsAreComparable(aId, bId)) return null;
    if (Math.random() < 0.5) return { a: bId, b: aId };
    return { a: aId, b: bId };
  }

  function recordSeenPair(aId, bId) {
    const key = pairKey(aId, bId);
    if (!state.seenPairKeys.includes(key)) {
      state.seenPairKeys.push(key);
    }
  }

  function buildAvoidPairKeys() {
    const avoid = new Set(state.seenPairKeys);
    if (state.current) {
      avoid.add(pairKey(state.current.a, state.current.b));
    }
    return avoid;
  }

  function allSongPairs() {
    const pairs = [];
    const ids = getUniqueSongIds();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (songsAreComparable(ids[i], ids[j])) {
          pairs.push([ids[i], ids[j]]);
        }
      }
    }
    return pairs;
  }

  function filterFreshPairs(pairs, avoidKeys) {
    return pairs.filter(([a, b]) => {
      if (!songsAreComparable(a, b)) return false;
      return !avoidKeys.has(pairKey(a, b));
    });
  }

  function resolveFreshPairs(candidates, allPairs, avoidKeys) {
    let fresh = filterFreshPairs(candidates, avoidKeys);
    if (fresh.length) return fresh;

    // Every pair in this pool has been shown — start a new cycle.
    state.seenPairKeys = [];
    saveState();
    avoidKeys = buildAvoidPairKeys();

    fresh = filterFreshPairs(candidates, avoidKeys);
    if (fresh.length) return fresh;

    fresh = filterFreshPairs(allPairs, avoidKeys);
    if (fresh.length) return fresh;

    return allPairs.filter(([a, b]) => songsAreComparable(a, b));
  }

  function getUnshownSongIds() {
    return state.songs.filter((s) => !hasBeenShown(s.id)).map((s) => s.id);
  }

  function preferUnshownPairs(pairs) {
    const unshownIds = getUnshownSongIds();
    if (!unshownIds.length) return pairs;

    const unshownSet = new Set(unshownIds);
    if (unshownIds.length >= 2) {
      const bothUnshown = pairs.filter(
        ([a, b]) => unshownSet.has(a) && unshownSet.has(b)
      );
      if (bothUnshown.length) return bothUnshown;
    }

    const anyUnshown = pairs.filter(
      ([a, b]) => unshownSet.has(a) || unshownSet.has(b)
    );
    return anyUnshown.length ? anyUnshown : pairs;
  }

  function sortIdsForCoverage(ids) {
    return ids.slice().sort(
      (a, b) =>
        Number(hasBeenShown(a)) - Number(hasBeenShown(b)) ||
        voteTotalForId(a) - voteTotalForId(b) ||
        a.localeCompare(b)
    );
  }

  function matchupPairWeight(aId, bId) {
    const maxV = Math.max(...state.songs.map((s) => voteTotalForId(s.id)), 0);
    const va = voteTotalForId(aId);
    const vb = voteTotalForId(bId);
    const aUnshown = !hasBeenShown(aId);
    const bUnshown = !hasBeenShown(bId);

    // Coverage: keep every song in rotation; zero-vote tracks dominate early.
    let w = Math.pow(maxV - va + 1, 3) * Math.pow(maxV - vb + 1, 3);
    if (va === 0) w *= 12;
    if (vb === 0) w *= 12;
    if (aUnshown) w *= 16;
    if (bUnshown) w *= 16;

    // Refinement only after both songs have appeared at least once.
    if (va > 0 && vb > 0 && !aUnshown && !bUnshown) {
      const gap = Math.abs(getDisplayRating(aId) - getDisplayRating(bId));
      w *= 0.4 + Math.exp(-gap / 120) * 2.6;

      const wa = winRateForId(aId);
      const wb = winRateForId(bId);
      if (wa !== null && wb !== null) {
        const wrGap = Math.abs(wa - wb);
        w *= 1 + Math.exp(-wrGap / 0.14) * 0.35;
        if (wa >= 1 && wb >= 1) {
          w *= 1.3;
        } else if (Math.min(wa, wb) >= 0.95 && wrGap <= 0.05) {
          w *= 1.12;
        }
      }
    }

    return w;
  }

  function weightedPick(items, weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) return items[Math.floor(Math.random() * items.length)];
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function pickWeightedPair(pairs, allPairs, avoidKeys) {
    const fresh = resolveFreshPairs(pairs, allPairs, avoidKeys);
    if (!fresh.length) return null;
    const pool = preferUnshownPairs(fresh);
    const weights = pool.map(([a, b]) => matchupPairWeight(a, b));
    const [aId, bId] = weightedPick(pool, weights);
    return flipPair(aId, bId);
  }

  function pickCoverageMatchup(avoidKeys, { excludeCurrent = false } = {}) {
    const currentIds =
      excludeCurrent && state.current
        ? new Set([state.current.a, state.current.b])
        : new Set();
    const ids = getUniqueSongIds();
    const unshownIds = new Set(getUnshownSongIds());
    const needsCoverage = sortIdsForCoverage(
      ids.filter((id) => unshownIds.has(id) || voteTotalForId(id) === 0)
    );

    for (const focusId of needsCoverage) {
      if (excludeCurrent && currentIds.has(focusId)) continue;

      const partners = sortIdsForCoverage(
        ids.filter((id) => id !== focusId && songsAreComparable(focusId, id))
      );

      for (const partnerId of partners) {
        if (excludeCurrent && currentIds.has(partnerId)) continue;
        if (avoidKeys.has(pairKey(focusId, partnerId))) continue;
        const flipped = flipPair(focusId, partnerId);
        if (flipped) return flipped;
      }
    }

    return null;
  }

  function pickMatchup(mode = "normal") {
    if (state.songs.length < 2) return null;

    const allPairs = allSongPairs();
    if (!allPairs.length) return null;

    const avoidKeys = buildAvoidPairKeys();
    const excludeCurrent = mode === "skip" || mode === "soft";

    const coverage = pickCoverageMatchup(avoidKeys, { excludeCurrent });
    if (coverage) return coverage;

    function eligiblePairs() {
      const currentIds = state.current
        ? new Set([state.current.a, state.current.b])
        : new Set();
      return allPairs.filter(([a, b]) => {
        if (!songsAreComparable(a, b)) return false;
        if (excludeCurrent && (currentIds.has(a) || currentIds.has(b))) return false;
        return true;
      });
    }

    const pool = eligiblePairs();
    if (pool.length) {
      return pickWeightedPair(pool, allPairs, avoidKeys);
    }

    return pickWeightedPair(allPairs, allPairs, avoidKeys);
  }

  function ensureCurrentMatchupValid() {
    if (!state.current) return false;
    if (songsAreComparable(state.current.a, state.current.b)) return false;
    state.current = pickMatchup();
    return true;
  }

  function syncCatalogIntegrity() {
    mergeSongs();
    ensureStats();
    rebuildShownSongIds();
    validateManualLeaderboardOrder();
    pruneVoteState();
    restoreManualLeaderboardRatings();
    if (ensureCurrentMatchupValid() || !state.current) {
      state.current = pickMatchup();
    }
    saveState();
  }

  function markSongsShown(...ids) {
    let changed = false;
    for (const id of ids) {
      if (id && songById(id) && !state.shownSongIds.includes(id)) {
        state.shownSongIds.push(id);
        changed = true;
      }
    }
    if (changed) saveState();
  }

  function rebuildShownSongIds() {
    const shown = new Set(state.shownSongIds);
    for (const key of state.seenPairKeys) {
      const parts = key.split("::");
      if (parts.length === 2) {
        shown.add(parts[0]);
        shown.add(parts[1]);
      }
    }
    for (const song of state.songs) {
      if (voteTotalForId(song.id) > 0) shown.add(song.id);
    }
    if (state.current) {
      shown.add(state.current.a);
      shown.add(state.current.b);
    }
    state.shownSongIds = [...shown].filter((id) => songById(id));
  }

  function formatSongRating(id) {
    if (!songHasRank(id)) return String(INITIAL_RATING);
    return String(state.stats[id]?.rating ?? INITIAL_RATING);
  }

  function formatSongRecord(id) {
    if (!hasVoteHistory(id)) return "—";
    const st = state.stats[id];
    return `${st.wins} – ${st.losses} – ${st.ties}`;
  }

  function formatWinPct(id, winrate, total) {
    if (id && !hasVoteHistory(id)) return "—";
    if (!total) return "—";
    return `${Math.round(winrate * 100)}%`;
  }

  function getDisplayRating(id) {
    if (!songHasRank(id)) return INITIAL_RATING;
    return state.stats[id]?.rating ?? INITIAL_RATING;
  }

  function sortByDisplayRating(a, b) {
    const idA = a.song?.id ?? a.id;
    const idB = b.song?.id ?? b.id;
    if (state.manualLeaderboardOrder?.length) {
      const iA = state.manualLeaderboardOrder.indexOf(idA);
      const iB = state.manualLeaderboardOrder.indexOf(idB);
      if (iA !== -1 && iB !== -1 && iA !== iB) return iA - iB;
      if (iA !== -1 && iB === -1) return -1;
      if (iB !== -1 && iA === -1) return 1;
    }
    const rA = getDisplayRating(idA);
    const rB = getDisplayRating(idB);
    if (rB !== rA) return rB - rA;
    return String(idA).localeCompare(String(idB));
  }

  function getLeaderboardOrderFromDom() {
    if (!els.leaderboardBody) return null;
    const rows = [...els.leaderboardBody.querySelectorAll("tr[data-song-id]")];
    if (!rows.length) return null;
    return rows.map((row) => row.dataset.songId);
  }

  // ---------- Rendering ----------
  const els = {
    matchup: document.getElementById("matchup"),
    cardA: document.querySelector('.song-card[data-side="a"]'),
    cardB: document.querySelector('.song-card[data-side="b"]'),
    voteProgressBanner: document.getElementById("vote-progress-banner"),
    voteProgressCount: document.getElementById("vote-progress-count"),
    voteProgressBar: document.getElementById("vote-progress-bar"),
    voteProgressFill: document.getElementById("vote-progress-fill"),
    statVotes: document.getElementById("stat-votes"),
    statSongs: document.getElementById("stat-songs"),
    leaderboardAccuracyHint: document.getElementById("leaderboard-accuracy-hint"),
    leaderboardHeadRow: document.getElementById("leaderboard-head-row"),
    leaderboardTableWrap: document.getElementById("leaderboard-table-wrap"),
    leaderboardSwitches: document.querySelectorAll("[data-leaderboard]"),
    voteEmpty: document.getElementById("vote-empty"),
    voteActive: document.getElementById("vote-active"),
    btnGoAddSongs: document.getElementById("btn-go-add-songs"),
    leaderboardBody: document.getElementById("leaderboard-body"),
    btnSkip: document.getElementById("btn-skip"),
    btnTie: document.getElementById("btn-tie"),
    favoriteEmpty: document.getElementById("favorite-empty"),
    favoriteActive: document.getElementById("favorite-active"),
    favoriteStatus: document.getElementById("favorite-status"),
    favoriteWinner: document.getElementById("favorite-winner"),
    favoriteWinnerCard: document.getElementById("favorite-winner-card"),
    favoriteMatchup: document.getElementById("favorite-matchup"),
    favoriteCardA: document.querySelector("#favorite-matchup .song-card[data-side='a']"),
    favoriteCardB: document.querySelector("#favorite-matchup .song-card[data-side='b']"),
    btnFavoriteRestart: document.getElementById("btn-favorite-restart"),
    btnFavoriteGoSongs: document.getElementById("btn-favorite-go-songs"),
    btnReset: document.getElementById("btn-reset"),
    btnExport: document.getElementById("btn-export"),
    tabs: document.querySelectorAll(".tab"),
    views: {
      vote: document.getElementById("view-vote"),
      favorite: document.getElementById("view-favorite"),
      leaderboard: document.getElementById("view-leaderboard"),
      songs: document.getElementById("view-songs"),
      about: document.getElementById("view-about"),
    },
    // Songs tab elements
    addSongForm: document.getElementById("add-song-form"),
    addAlbumForm: document.getElementById("add-album-form"),
    formError: document.getElementById("form-error"),
    albumFormError: document.getElementById("album-form-error"),
    formSwitches: document.querySelectorAll(".form-switch"),
    fieldTitle: document.getElementById("field-title"),
    fieldArtist: document.getElementById("field-artist"),
    fieldYear: document.getElementById("field-year"),
    fieldAlbum: document.getElementById("field-album"),
    fieldCover: document.getElementById("field-cover"),
    coverPreviewSong: document.getElementById("cover-preview-song"),
    fieldAudio: document.getElementById("field-audio"),
    audioPreviewSong: document.getElementById("audio-preview-song"),
    audioPreviewName: document.getElementById("audio-preview-name"),
    fieldAlbumTitle: document.getElementById("field-album-title"),
    fieldAlbumArtist: document.getElementById("field-album-artist"),
    fieldAlbumYear: document.getElementById("field-album-year"),
    fieldAlbumTracks: document.getElementById("field-album-tracks"),
    fieldAlbumCover: document.getElementById("field-album-cover"),
    coverPreviewAlbum: document.getElementById("cover-preview-album"),
    albumsSection: document.getElementById("albums-section"),
    albumsList: document.getElementById("albums-list"),
    songsList: document.getElementById("songs-list"),
    songsCount: document.getElementById("songs-count"),
    btnClearAll: document.getElementById("btn-clear-all"),
    langButtons: document.querySelectorAll(".lang-flag"),
  };

  function renderCard(cardEl, songId) {
    const song = songById(songId);
    if (!song) return;
    cardEl.dataset.songId = song.id;
    cardEl.classList.remove("is-picked", "is-loser");

    const img = cardEl.querySelector(".cover");
    img.alt = `${song.title} cover art`;
    img.onerror = () => {
      img.style.visibility = "hidden";
    };
    img.style.visibility = "visible";
    img.src = song.cover || "";

    cardEl.querySelector(".song-title").textContent = song.title;
    const artistLine = song.album
      ? `${song.artist || ""} · ${song.album}`
      : song.artist || "";
    cardEl.querySelector(".song-artist").textContent = artistLine;
    cardEl.querySelector(".song-year").textContent = song.year ? String(song.year) : "";

    const player = cardEl.querySelector(".song-player");
    if (player) {
      player.hidden = !song.hasAudio;
      if (!song.hasAudio) {
        resetPlayerUI(player);
      } else if (activePreviewPlayer === player && activePreviewAudio) {
        syncPlayerUI(player, activePreviewAudio);
      } else {
        resetPlayerUI(player);
      }
    }

    cardEl.setAttribute(
      "aria-label",
      t("vote.pickSong", {
        title: song.title,
        artist: song.artist || t("vote.unknownArtist"),
        albumPart:
          song.albumId && song.album
            ? t("vote.fromAlbum", { album: song.album })
            : "",
      })
    );
  }

  function renderMatchup() {
    stopActivePreview();
    renderVoteState();
    updateMatchupNavControls();
    if (!state.current) return;
    if (!songsAreComparable(state.current.a, state.current.b)) {
      if (isLiveMatchup()) {
        state.current = pickMatchup();
        if (!state.current) return;
      } else {
        return;
      }
    }
    if (isLiveMatchup()) {
      markSongsShown(state.current.a, state.current.b);
    }
    renderCard(els.cardA, state.current.a);
    renderCard(els.cardB, state.current.b);
  }

  function renderVoteState() {
    const canVote = state.songs.length >= 2;
    const titleEl = els.voteEmpty?.querySelector(".vote-empty-title");
    const hintEl = els.voteEmpty?.querySelector(".vote-empty-hint");

    if (els.voteEmpty) {
      els.voteEmpty.hidden = canVote;
    }
    if (els.voteActive) {
      els.voteActive.hidden = !canVote;
    }
    if (els.voteProgressBanner) {
      els.voteProgressBanner.hidden = !canVote;
    }

    if (!canVote && titleEl && hintEl) {
      if (state.songs.length === 0) {
        titleEl.textContent = t("vote.emptyTitle");
        hintEl.textContent = t("vote.emptyHintNone");
      } else {
        titleEl.textContent = t("vote.emptyTitle");
        hintEl.textContent = t("vote.emptyHintOne");
      }
    }

    if (canVote && !state.current) {
      state.current = pickMatchup();
    }
  }

  function renderStats() {
    const info = getVoteAccuracyInfo();
    const targetMet = info.target > 0 && info.voteTargetMet;
    const pct =
      info.target > 0
        ? Math.min(100, Math.round((info.votes / info.target) * 100))
        : 0;

    if (els.statVotes) {
      els.statVotes.textContent = String(info.votes);
    }
    if (els.statSongs) {
      els.statSongs.textContent = String(info.songCount);
    }
    if (els.voteProgressCount) {
      els.voteProgressCount.textContent =
        info.target > 0 ? `${info.votes} / ${info.target}` : "—";
    }
    if (els.voteProgressFill) {
      els.voteProgressFill.style.width = `${pct}%`;
    }
    if (els.voteProgressBar) {
      els.voteProgressBar.setAttribute("aria-valuenow", String(pct));
      els.voteProgressBar.setAttribute(
        "aria-label",
        info.target > 0
          ? t("leaderboard.hintVotesProgress", {
              songs: info.songCount,
              votes: info.votes,
              target: info.target,
              remaining: info.remaining,
            })
          : t("vote.progressAria")
      );
    }
    if (els.voteProgressBanner) {
      els.voteProgressBanner.classList.toggle("is-target-met", targetMet);
    }
    if (els.leaderboardAccuracyHint && !els.views.leaderboard.hidden) {
      renderLeaderboardAccuracyHint();
    }
  }

  function renderLeaderboardAccuracyHint() {
    if (!els.leaderboardAccuracyHint) return;

    if (state.leaderboardMode === "albums") {
      const rows = getAlbumRankings();
      if (rows.length === 0) {
        els.leaderboardAccuracyHint.textContent = t("leaderboard.hintAlbumsEmpty");
        return;
      }
      const trackTotal = rows.reduce((sum, row) => sum + row.trackCount, 0);
      els.leaderboardAccuracyHint.textContent = t("leaderboard.hintAlbumsCount", {
        albums: rows.length,
        tracks: trackTotal,
      });
      return;
    }

    const info = getVoteAccuracyInfo();
    const n = state.songs.length;
    if (n < 2) {
      els.leaderboardAccuracyHint.textContent = t("leaderboard.hintDefault");
      return;
    }
    if (info.voteTargetMet) {
      els.leaderboardAccuracyHint.textContent = t("leaderboard.hintVotesMet", {
        votes: info.votes,
        target: info.target,
      });
      return;
    }
    els.leaderboardAccuracyHint.textContent = t("leaderboard.hintVotesProgress", {
      songs: n,
      votes: info.votes,
      target: info.target,
      remaining: info.remaining,
    });
  }

  function getAlbumRankings() {
    return state.customAlbums
      .map((album) => {
        const tracks = getAlbumTracks(album.id);
        if (tracks.length === 0) return null;

        const stats = tracks.map(
          (song) =>
            state.stats[song.id] || {
              rating: INITIAL_RATING,
              wins: 0,
              losses: 0,
              ties: 0,
            }
        );
        const ratedStats = tracks
          .filter((song) => songHasRank(song.id))
          .map((song) => state.stats[song.id]);
        const rating = tracks.length
          ? tracks.reduce((sum, song) => sum + getDisplayRating(song.id), 0) /
            tracks.length
          : INITIAL_RATING;
        const wins = stats.reduce((sum, st) => sum + st.wins, 0);
        const losses = stats.reduce((sum, st) => sum + st.losses, 0);
        const ties = stats.reduce((sum, st) => sum + st.ties, 0);
        const total = wins + losses + ties;
        const winrate = total ? (wins + ties * 0.5) / total : 0;
        const hasAlbumScore = ratedStats.length > 0 && total > 0;

        return {
          album,
          trackCount: tracks.length,
          rating,
          hasAlbumScore,
          wins,
          losses,
          ties,
          total,
          winrate,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          (b.rating ?? INITIAL_RATING) - (a.rating ?? INITIAL_RATING) ||
          b.trackCount - a.trackCount ||
          a.album.title.localeCompare(b.album.title)
      );
  }

  function renderLeaderboardHead() {
    if (!els.leaderboardHeadRow) return;

    if (state.leaderboardMode === "albums") {
      els.leaderboardHeadRow.innerHTML = `
        <th class="col-rank">#</th>
        <th class="col-song">${escapeHtml(t("leaderboard.colAlbum"))}</th>
        <th class="col-rating">${escapeHtml(t("leaderboard.colAvgRating"))}</th>
        <th class="col-tracks">${escapeHtml(t("leaderboard.colTracks"))}</th>
        <th class="col-record">${escapeHtml(t("leaderboard.colRecord"))}</th>
        <th class="col-winrate">${escapeHtml(t("leaderboard.colWinrate"))}</th>`;
      els.leaderboardTableWrap?.classList.add("is-album-mode");
      return;
    }

    els.leaderboardHeadRow.innerHTML = `
      <th class="col-rank">#</th>
      <th class="col-drag" aria-hidden="true"></th>
      <th class="col-song">${escapeHtml(t("leaderboard.colSong"))}</th>
      <th class="col-rating">${escapeHtml(t("leaderboard.colRating"))}</th>
      <th class="col-record">${escapeHtml(t("leaderboard.colRecord"))}</th>
      <th class="col-winrate">${escapeHtml(t("leaderboard.colWinrate"))}</th>`;
    els.leaderboardTableWrap?.classList.remove("is-album-mode");
  }

  function switchLeaderboardMode(mode) {
    state.leaderboardMode = mode;
    els.leaderboardSwitches.forEach((btn) => {
      const active = btn.dataset.leaderboard === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderLeaderboardHead();
    renderLeaderboard();
    renderLeaderboardAccuracyHint();
  }

  function getLeaderboardOrder() {
    return getSortedSongs().map((song) => song.id);
  }

  function getSortedSongs() {
    mergeSongs();
    ensureStats();
    validateManualLeaderboardOrder();
    const songsById = getSongsById();
    const uniqueSongs = [...songsById.values()];
    const catalogIds = uniqueSongs.map((song) => song.id);

    if (state.manualLeaderboardOrder?.length === catalogIds.length) {
      const order = normalizeSongOrder(state.manualLeaderboardOrder);
      if (order.length === catalogIds.length) {
        const ordered = order
          .map((id) => songsById.get(id))
          .filter(Boolean);
        if (ordered.length === catalogIds.length) {
          return ordered;
        }
      }
      state.manualLeaderboardOrder = null;
    }

    return uniqueSongs
      .slice()
      .sort((a, b) => sortByDisplayRating({ song: a }, { song: b }));
  }

  function buildSongRowData(song) {
    const st = state.stats[song.id] || {
      rating: INITIAL_RATING,
      wins: 0,
      losses: 0,
      ties: 0,
    };
    const total = st.wins + st.losses + st.ties;
    const winrate = total ? (st.wins + st.ties * 0.5) / total : 0;
    return { song, stats: st, total, winrate };
  }

  function validateManualLeaderboardOrder() {
    if (!state.manualLeaderboardOrder?.length) return false;
    const catalogIds = getUniqueSongIds();
    const catalogSet = new Set(catalogIds);
    const order = dedupePreserveOrder(
      state.manualLeaderboardOrder.filter((id) => catalogSet.has(id))
    );
    const sameCatalog =
      order.length === catalogIds.length &&
      order.slice().sort().join("\0") === catalogIds.slice().sort().join("\0");
    if (
      !sameCatalog ||
      order.length !== state.manualLeaderboardOrder.length ||
      new Set(state.manualLeaderboardOrder).size !== order.length
    ) {
      state.manualLeaderboardOrder = null;
      clearStaleManualRanks();
      return true;
    }
    state.manualLeaderboardOrder = order;
    return false;
  }

  function restoreManualLeaderboardRatings() {
    if (state.manualLeaderboardOrder?.length) {
      applyRatingsFromOrder(state.manualLeaderboardOrder);
    }
  }

  function getSongsListOrderFromDom() {
    if (!els.songsList) return null;
    const rows = [...els.songsList.querySelectorAll(".song-row[data-id]")];
    if (!rows.length) return null;
    return rows.map((row) => row.dataset.id);
  }

  function getCatalogSongIds() {
    mergeSongs();
    return getUniqueSongIds();
  }

  function normalizeSongOrder(partial) {
    const canonical = getCatalogSongIds();
    const seen = new Set();
    const order = [];
    for (const id of partial || []) {
      if (seen.has(id)) continue;
      if (!canonical.includes(id)) continue;
      order.push(id);
      seen.add(id);
    }
    for (const id of canonical) {
      if (!seen.has(id)) order.push(id);
    }
    return order;
  }

  function moveSongToRank(order, draggedId, targetRankIndex) {
    const fromIndex = order.indexOf(draggedId);
    if (fromIndex === -1) return null;

    const next = order.slice();
    next.splice(fromIndex, 1);
    const insertAt = Math.max(0, Math.min(targetRankIndex, next.length));
    next.splice(insertAt, 0, draggedId);

    if (next.every((id, i) => id === order[i])) return null;
    return next;
  }

  function applyRatingsFromOrder(orderedIds) {
    if (orderedIds.length === 0) return;
    ensureStats();
    const top = INITIAL_RATING + orderedIds.length;
    orderedIds.forEach((id, i) => {
      state.stats[id].rating = top - i;
      state.stats[id].manualRank = true;
    });
  }

  function reorderSongs(draggedId, targetRankIndex, baseOrder = null) {
    const order = normalizeSongOrder(
      baseOrder ||
        getLeaderboardOrderFromDom() ||
        getSongsListOrderFromDom() ||
        state.manualLeaderboardOrder ||
        getCatalogSongIds()
    );
    const next = moveSongToRank(order, draggedId, targetRankIndex);
    if (!next) return;

    state.manualLeaderboardOrder = next.slice();
    applyRatingsFromOrder(next);
    saveState();
    renderLeaderboard();
    if (!els.views.songs.hidden) renderSongsView();
  }

  let rankDrag = null;
  let rankDragListenersAttached = false;

  function clearRankDragVisuals(container) {
    container
      ?.querySelectorAll(".is-dragging, .is-drag-over")
      .forEach((el) => el.classList.remove("is-dragging", "is-drag-over"));
    container?.classList?.remove("is-drag-append");
  }

  function onRankDragMove(e) {
    if (!rankDrag) return;
    const row = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(rankDrag.rowSelector);
    rankDrag.container.querySelectorAll(".is-drag-over").forEach((el) => {
      if (el !== row) el.classList.remove("is-drag-over");
    });
    if (row && rankDrag.container.contains(row)) {
      const id = rankDrag.getRowId(row);
      if (id && id !== rankDrag.draggedId) {
        row.classList.add("is-drag-over");
      }
    }
  }

  function onRankDragEnd(e) {
    if (!rankDrag) return;
    const { draggedId, container, rowSelector, getRowId } = rankDrag;
    const row = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(rowSelector);
    clearRankDragVisuals(container);
    rankDrag = null;

    if (!row || !container.contains(row)) return;
    const targetId = getRowId(row);
    if (!targetId || targetId === draggedId) return;

    const order = normalizeSongOrder(
      [...container.querySelectorAll(rowSelector)].map(getRowId).filter(Boolean)
    );
    const targetIndex = order.indexOf(targetId);
    if (targetIndex === -1) return;

    reorderSongs(draggedId, targetIndex, order);
  }

  function ensureRankDragListeners() {
    if (rankDragListenersAttached) return;
    rankDragListenersAttached = true;
    document.addEventListener("pointermove", onRankDragMove);
    document.addEventListener("pointerup", onRankDragEnd);
    document.addEventListener("pointercancel", onRankDragEnd);
  }

  function attachRankDragList(container, { rowSelector, getRowId, canStart }) {
    if (!container) return;
    ensureRankDragListeners();

    container.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, a, input, .song-player")) return;
      if (canStart && !canStart()) return;

      const row = e.target.closest(rowSelector);
      if (!row || !container.contains(row)) return;

      const id = getRowId(row);
      if (!id) return;

      rankDrag = { draggedId: id, container, rowSelector, getRowId };
      row.classList.add("is-dragging");
      if (typeof row.setPointerCapture === "function") {
        row.setPointerCapture(e.pointerId);
      }
      e.preventDefault();
    });
  }

  function attachLeaderboardDrag() {
    attachRankDragList(els.leaderboardBody, {
      rowSelector: "tr[data-song-id]",
      getRowId: (row) => row.dataset.songId,
      canStart: () => state.leaderboardMode === "songs",
    });
  }

  function attachSongsListDrag() {
    attachRankDragList(els.songsList, {
      rowSelector: ".song-row[data-id]",
      getRowId: (row) => row.dataset.id,
    });
  }

  function renderAlbumLeaderboard() {
    const rows = getAlbumRankings();

    if (rows.length === 0) {
      els.leaderboardBody.innerHTML = `
        <tr>
          <td colspan="6" class="leaderboard-empty">${escapeHtml(t("leaderboard.emptyAlbums"))}</td>
        </tr>`;
      return;
    }

    els.leaderboardBody.innerHTML = rows
      .map((r, i) => {
        const rank = i + 1;
        const rankClass =
          rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
        const cover = r.album.cover
          ? `<img src="${escapeAttr(r.album.cover)}" alt="" draggable="false" onerror="this.style.visibility='hidden'">`
          : `<img alt="" draggable="false" style="visibility:hidden">`;
        const yearLine = r.album.year ? ` · ${escapeHtml(String(r.album.year))}` : "";
        const winPct = r.hasAlbumScore ? formatWinPct(null, r.winrate, r.total) : "—";
        const avgRating = Math.round(r.rating ?? INITIAL_RATING);
        const albumRecord = r.hasAlbumScore
          ? `${r.wins} – ${r.losses} – ${r.ties}`
          : "—";

        return `
          <tr data-album-id="${escapeAttr(r.album.id)}">
            <td class="col-rank ${rankClass}">${rank}</td>
            <td>
              <div class="song-cell">
                ${cover}
                <div class="song-cell-text">
                  <span class="song-cell-title">${escapeHtml(r.album.title)}</span>
                  <span class="song-cell-artist">${escapeHtml(r.album.artist || "")}${yearLine}</span>
                </div>
              </div>
            </td>
            <td class="col-rating">${avgRating}</td>
            <td class="col-tracks">${r.trackCount}</td>
            <td class="col-record">${albumRecord}</td>
            <td class="col-winrate">${winPct}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderLeaderboard() {
    mergeSongs();
    ensureStats();
    renderLeaderboardHead();

    if (state.leaderboardMode === "albums") {
      renderAlbumLeaderboard();
      return;
    }

    if (state.songs.length === 0) {
      els.leaderboardBody.innerHTML = `
        <tr>
          <td colspan="6" class="leaderboard-empty">${escapeHtml(t("leaderboard.emptySongs"))}</td>
        </tr>`;
      return;
    }

    const rows = getSortedSongs().map((song) => buildSongRowData(song));

    els.leaderboardBody.innerHTML = rows
      .map((r, i) => {
        const rank = i + 1;
        const rankClass =
          rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
        const cover = r.song.cover
          ? `<img src="${escapeAttr(r.song.cover)}" alt="" draggable="false" onerror="this.style.visibility='hidden'">`
          : `<img alt="" draggable="false" style="visibility:hidden">`;
        const winPct = formatWinPct(r.song.id, r.winrate, r.total);
        return `
          <tr data-song-id="${escapeAttr(r.song.id)}">
            <td class="col-rank ${rankClass}">${rank}</td>
            <td class="col-drag">
              <span class="drag-handle" title="${escapeAttr(t("leaderboard.dragReorder"))}" aria-hidden="true">⋮⋮</span>
            </td>
            <td>
              <div class="song-cell">
                ${cover}
                <div class="song-cell-text">
                  <span class="song-cell-title">${escapeHtml(r.song.title)}</span>
                  <span class="song-cell-artist">${escapeHtml(formatArtistAlbum(r.song))}</span>
                </div>
              </div>
            </td>
            <td class="col-rating">${formatSongRating(r.song.id)}</td>
            <td class="col-record">${formatSongRecord(r.song.id)}</td>
            <td class="col-winrate">${winPct}</td>
          </tr>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function formatArtistAlbum(song) {
    if (song.albumId && song.album) {
      return `${song.artist || ""} · ${song.album}`;
    }
    return song.artist || "";
  }

  function renderSongsView() {
    mergeSongs();
    ensureStats();
    const albumCount = state.customAlbums.length;
    els.songsCount.textContent = t("songs.count", {
      songs: state.songs.length,
      albums: albumCount,
    });

    renderAlbumsList();

    if (state.songs.length === 0) {
      els.songsList.innerHTML =
        `<li class="empty-state">${escapeHtml(t("songs.empty"))}</li>`;
      if (els.btnClearAll) els.btnClearAll.disabled = true;
      return;
    }

    if (els.btnClearAll) els.btnClearAll.disabled = false;

    const rows = getSortedSongs().map((song) => buildSongRowData(song));

    els.songsList.innerHTML = rows
      .map(({ song, stats }) => {
        const cover = song.cover
          ? `<img src="${escapeAttr(song.cover)}" alt="" draggable="false" onerror="this.style.visibility='hidden'">`
          : `<img alt="" draggable="false" style="visibility:hidden">`;
        const yearHtml = song.year
          ? ` <span class="song-year-badge">${escapeHtml(String(song.year))}</span>`
          : "";
        const albumBadge = song.albumId
          ? `<span class="badge badge-album" title="${escapeAttr(t("songs.onAlbum"))}">${escapeHtml(song.album || t("songs.albumFallback"))}</span>`
          : "";
        const deleteBtn = `<button type="button" class="btn-icon" data-action="delete-song" data-id="${escapeAttr(song.id)}" aria-label="${escapeAttr(t("songs.deleteSong", { title: song.title }))}" title="${escapeAttr(t("songs.removeFromList"))}">✕</button>`;
        return `
          <li class="song-row is-draggable" data-id="${escapeAttr(song.id)}">
            <span class="drag-handle" title="${escapeAttr(t("leaderboard.dragReorder"))}" aria-hidden="true">⋮⋮</span>
            ${cover}
            <div class="song-row-main">
              <div class="song-row-title">
                <span class="song-row-name">${escapeHtml(song.title)}</span>
                ${albumBadge}
                ${yearHtml}
              </div>
              <div class="song-row-artist">${escapeHtml(formatArtistAlbum(song))}</div>
            </div>
            <div class="song-row-meta">
              <div class="song-row-rating">${formatSongRating(song.id)}</div>
              <div class="song-row-record">${formatSongRecord(song.id)}</div>
            </div>
            ${deleteBtn}
          </li>`;
      })
      .join("");
  }

  function renderAlbumsList() {
    const ranked = getAlbumRankings();

    if (ranked.length === 0) {
      els.albumsSection.hidden = true;
      els.albumsList.innerHTML = "";
      return;
    }

    els.albumsSection.hidden = false;
    els.albumsList.innerHTML = ranked
      .map((row, index) => {
        const { album, trackCount, rating, hasAlbumScore } = row;
        const cover = album.cover
          ? `<img src="${escapeAttr(album.cover)}" alt="" onerror="this.style.visibility='hidden'">`
          : `<img alt="" style="visibility:hidden">`;
        const yearHtml = album.year
          ? `<span class="song-year-badge">${escapeHtml(String(album.year))}</span>`
          : "";
        return `
          <li class="album-row" data-id="${escapeAttr(album.id)}">
            ${cover}
            <div class="album-row-main">
              <div class="album-row-title">
                <span class="album-row-rank">#${index + 1}</span>
                <span class="album-row-name">${escapeHtml(album.title)}</span>
                ${yearHtml}
              </div>
              <div class="album-row-artist">${escapeHtml(album.artist || "")}</div>
              <div class="album-row-meta">${escapeHtml(
                hasAlbumScore
                  ? t("songs.trackMeta", { count: trackCount, rating: Math.round(rating) })
                  : t("songs.trackMeta", { count: trackCount, rating: INITIAL_RATING })
              )}</div>
            </div>
            <button type="button" class="btn-icon" data-action="delete-album" data-id="${escapeAttr(album.id)}" aria-label="${escapeAttr(t("songs.deleteAlbumAria", { title: album.title }))}" title="${escapeAttr(t("songs.deleteAlbum"))}">✕</button>
          </li>`;
      })
      .join("");
  }

  function showFormError(msg, form = "song") {
    const el = form === "album" ? els.albumFormError : els.formError;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function showAlbumFormSuccess(msg) {
    showFormError(msg, "album");
    els.albumFormError.classList.add("form-success");
    setTimeout(() => {
      els.albumFormError.classList.remove("form-success");
      showFormError("", "album");
    }, 4000);
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(t("error.readImage")));
      };
      img.src = url;
    });
  }

  function clearAudioUpload(input, previewWrap, nameEl) {
    if (input) input.value = "";
    if (previewWrap) previewWrap.hidden = true;
    if (nameEl) nameEl.textContent = "";
  }

  function updateAudioPreviewFromInput() {
    const file = els.fieldAudio?.files?.[0];
    if (!file) {
      clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
      return;
    }
    if (els.audioPreviewName) els.audioPreviewName.textContent = file.name;
    if (els.audioPreviewSong) els.audioPreviewSong.hidden = false;
  }

  function validateAudioFile(file) {
    const isAudio =
      file.type.startsWith("audio/") ||
      /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || "");
    if (!isAudio) throw new Error(t("error.audioType"));
    if (file.size > MAX_AUDIO_FILE_BYTES) throw new Error(t("error.audioSize"));
  }

  async function compressImageFile(file) {
    if (!file.type.startsWith("image/")) {
      throw new Error(t("error.imageType"));
    }
    if (file.size > MAX_COVER_FILE_BYTES) {
      throw new Error(t("error.imageSize"));
    }

    const img = await loadImageFromFile(file);
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    const max = MAX_COVER_DIM;

    if (width > max || height > max) {
      if (width >= height) {
        height = Math.round((height * max) / width);
        width = max;
      } else {
        width = Math.round((width * max) / height);
        height = max;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    let quality = 0.85;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > MAX_COVER_DATA_URL_LEN && quality > 0.45) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }

    if (dataUrl.length > MAX_COVER_DATA_URL_LEN) {
      throw new Error(t("error.compressImage"));
    }

    return dataUrl;
  }

  async function readCoverFromInput(input) {
    const file = input.files?.[0];
    if (!file) return null;
    return compressImageFile(file);
  }

  function clearCoverUpload(input, previewWrap) {
    input.value = "";
    previewWrap.hidden = true;
    const img = previewWrap.querySelector("img");
    if (img) img.removeAttribute("src");
  }

  async function previewCoverFromInput(input, previewWrap, onError) {
    const file = input.files?.[0];
    if (!file) {
      clearCoverUpload(input, previewWrap);
      return;
    }
    try {
      const dataUrl = await compressImageFile(file);
      previewWrap.querySelector("img").src = dataUrl;
      previewWrap.hidden = false;
    } catch (err) {
      clearCoverUpload(input, previewWrap);
      onError(err.message || t("error.loadImage"));
    }
  }

  // ---------- Interactions ----------
  function vote(side) {
    if (!state.current || !isLiveMatchup()) return;
    stopActivePreview();
    const { a, b } = state.current;
    if (side === "a") {
      els.cardA.classList.add("is-picked");
      els.cardB.classList.add("is-loser");
      applyElo(a, b, 1);
    } else if (side === "b") {
      els.cardB.classList.add("is-picked");
      els.cardA.classList.add("is-loser");
      applyElo(a, b, 0);
    } else if (side === "tie") {
      applyElo(a, b, 0.5);
    } else {
      // skip: don't update anything
    }

    if (side !== "skip") state.voteCount += 1;
    recordCurrentInHistory();
    saveState();

    if (state.current) {
      recordSeenPair(state.current.a, state.current.b);
    }
    state.lastPair = state.current ? { ...state.current } : null;

    const nextMode =
      side === "skip" ? "skip" : side === "tie" ? "soft" : "normal";

    // Brief pause so the pick animation is visible.
    const delay = side === "skip" ? 0 : 220;
    setTimeout(() => {
      state.current = pickMatchup(nextMode);
      renderMatchup();
      renderStats();
      renderLeaderboard();
      if (!els.views.songs.hidden) renderSongsView();
    }, delay);
  }

  function switchView(name) {
    if (name !== "vote" && name !== "favorite") stopActivePreview();
    for (const [key, el] of Object.entries(els.views)) {
      const isActive = key === name;
      el.classList.toggle("is-active", isActive);
      el.hidden = !isActive;
    }
    els.tabs.forEach((tab) => {
      const isActive = tab.dataset.view === name;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (name === "leaderboard") {
      renderLeaderboard();
      renderLeaderboardAccuracyHint();
    }
    if (name === "songs") renderSongsView();
    if (name === "favorite") renderFavoriteView();
  }

  function resetVotes() {
    if (!confirm(t("confirm.resetVotes"))) return;
    state.stats = {};
    state.voteCount = 0;
    state.lastPair = null;
    clearMatchupHistory();
    state.seenPairKeys = [];
    state.shownSongIds = [];
    state.manualLeaderboardOrder = null;
    ensureStats();
    state.current = pickMatchup();
    saveState();
    renderMatchup();
    renderStats();
    renderLeaderboard();
    if (!els.views.songs.hidden) renderSongsView();
  }

  async function handleAddSong(event) {
    event.preventDefault();
    showFormError("");

    const title = els.fieldTitle.value;
    const artist = els.fieldArtist.value;
    const year = els.fieldYear.value;
    const album = els.fieldAlbum.value;

    try {
      const cover = await readCoverFromInput(els.fieldCover);
      const audioFile = els.fieldAudio?.files?.[0] || null;
      if (audioFile) validateAudioFile(audioFile);
      const song = addSong({ title, artist, year, cover, album });
      if (audioFile) {
        await saveSongAudio(song.id, audioFile);
        song.hasAudio = true;
        saveCustomSongs();
      }
      els.addSongForm.reset();
      clearCoverUpload(els.fieldCover, els.coverPreviewSong);
      clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
      els.fieldTitle.focus();

      // Refresh matchup so new songs enter the vote pool immediately.
      if (state.songs.length >= 2) {
        state.current = pickMatchup();
        saveState();
        renderMatchup();
      }
      renderStats();
      renderSongsView();
      renderLeaderboard();
      renderFavoriteView();

      // Confirmation via a brief visual flash on the newly-added row.
      requestAnimationFrame(() => {
        const row = els.songsList.querySelector(
          `.song-row[data-id="${cssEscape(song.id)}"]`
        );
        if (row) {
          row.classList.add("is-new");
          setTimeout(() => row.classList.remove("is-new"), 1400);
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    } catch (err) {
      showFormError(err.message || t("error.addSong"));
    }
  }

  async function handleAddAlbum(event) {
    event.preventDefault();
    showFormError("", "album");

    const title = els.fieldAlbumTitle.value;
    const artist = els.fieldAlbumArtist.value;
    const year = els.fieldAlbumYear.value;

    try {
      const cover = await readCoverFromInput(els.fieldAlbumCover);
      const { album, songs } = addAlbum({
        title,
        artist,
        year,
        cover,
        trackTitles: els.fieldAlbumTracks.value,
      });
      els.addAlbumForm.reset();
      clearCoverUpload(els.fieldAlbumCover, els.coverPreviewAlbum);
      if (els.fieldAlbumTracks) els.fieldAlbumTracks.value = "";
      els.fieldAlbumTitle.focus();

      if (state.songs.length >= 2) {
        state.current = pickMatchup();
        saveState();
        renderMatchup();
      }
      renderStats();
      renderSongsView();
      renderLeaderboard();
      renderFavoriteView();

      showAlbumFormSuccess(
        t("success.albumCreated", { title: album.title, count: songs.length })
      );

      requestAnimationFrame(() => {
        const row = els.albumsList.querySelector(
          `.album-row[data-id="${cssEscape(album.id)}"]`
        );
        if (row) {
          row.classList.add("is-new");
          setTimeout(() => row.classList.remove("is-new"), 1400);
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    } catch (err) {
      showFormError(err.message || t("error.addAlbum"), "album");
    }
  }

  function switchAddForm(mode) {
    state.addFormMode = mode;
    const isSong = mode === "song";
    els.addSongForm.hidden = !isSong;
    els.addAlbumForm.hidden = isSong;
    els.formSwitches.forEach((btn) => {
      const active = btn.dataset.form === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    showFormError("");
    showFormError("", "album");
    clearCoverUpload(els.fieldCover, els.coverPreviewSong);
    clearCoverUpload(els.fieldAlbumCover, els.coverPreviewAlbum);
    clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
    renderSongsView();
    if (isSong) els.fieldTitle.focus();
    else els.fieldAlbumTitle.focus();
  }

  function handleClearAll() {
    if (!clearAllSongs()) return;
    renderMatchup();
    renderStats();
    renderSongsView();
    renderLeaderboard();
    renderFavoriteView();
    if (state.songs.length === 0) switchView("vote");
  }

  function handleSongsListClick(event) {
    const songBtn = event.target.closest('button[data-action="delete-song"]');
    if (songBtn) {
      event.stopPropagation();
      const id = songBtn.dataset.id;
      const song = state.songs.find((s) => s.id === id);
      if (!song) return;
      if (!confirm(t("confirm.deleteSong", { title: song.title, artist: song.artist }))) return;
      if (removeSong(id)) {
        renderMatchup();
        renderStats();
        renderSongsView();
        renderLeaderboard();
        renderFavoriteView();
      }
      return;
    }

    const albumBtn = event.target.closest('button[data-action="delete-album"]');
    if (albumBtn) {
      event.stopPropagation();
      const id = albumBtn.dataset.id;
      const album = state.customAlbums.find((a) => a.id === id);
      if (!album) return;
      const trackCount = getAlbumTracks(id).length;
      if (
        !confirm(
          t("confirm.deleteAlbum", { title: album.title, count: trackCount })
        )
      ) {
        return;
      }
      if (removeAlbum(id)) {
        renderMatchup();
        renderStats();
        renderSongsView();
        renderLeaderboard();
        renderFavoriteView();
      }
    }
  }

  function cssEscape(str) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(str);
    }
    return String(str).replace(/[^\w-]/g, "\\$&");
  }

  function exportCsv() {
    if (state.leaderboardMode === "albums") {
      const rows = getAlbumRankings();
      const header = [
        "rank",
        "album",
        "artist",
        "year",
        "avg_rating",
        "tracks",
        "wins",
        "losses",
        "ties",
      ];
      const csvRows = [header.join(",")];
      rows.forEach((r, i) => {
        csvRows.push(
          [
            i + 1,
            csvField(r.album.title),
            csvField(r.album.artist || ""),
            r.album.year || "",
            r.hasAlbumScore && r.rating != null ? Math.round(r.rating) : INITIAL_RATING,
            r.trackCount,
            r.hasAlbumScore ? r.wins : "",
            r.hasAlbumScore ? r.losses : "",
            r.hasAlbumScore ? r.ties : "",
          ].join(",")
        );
      });

      const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "album-rankings.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    const rows = getSortedSongs().map((song) => buildSongRowData(song));

    const header = ["rank", "title", "artist", "album", "year", "rating", "wins", "losses", "ties"];
    const csvRows = [header.join(",")];
    rows.forEach((r, i) => {
      csvRows.push(
        [
          i + 1,
          csvField(r.song.title),
          csvField(r.song.artist || ""),
          csvField(r.song.album || ""),
          r.song.year || "",
          songHasRank(r.song.id) ? r.rating : INITIAL_RATING,
          hasVoteHistory(r.song.id) ? r.wins : "",
          hasVoteHistory(r.song.id) ? r.losses : "",
          hasVoteHistory(r.song.id) ? r.ties : "",
        ].join(",")
      );
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "song-rankings.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvField(str) {
    const s = String(str);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  // ---------- Wire up ----------
  function updateLangSwitcher() {
    els.langButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.lang === window.I18n.getLocale());
    });
  }

  function refreshLocaleUI() {
    window.I18n.applyDocument();
    updateLangSwitcher();
    renderVoteState();
    if (state.current) {
      renderCard(els.cardA, state.current.a);
      renderCard(els.cardB, state.current.b);
    }
    renderStats();
    renderLeaderboard();
    if (!els.views.songs.hidden) renderSongsView();
    if (!els.views.favorite.hidden) renderFavoriteView();
  }

  function getSongIdFromPlayer(playerEl) {
    return playerEl?.closest(".song-card")?.dataset.songId || null;
  }

  function handlePlayerScrubPointerDown(e) {
    const scrub = e.target.closest(".song-scrub");
    if (!scrub) return;
    const player = scrub.closest(".song-player");
    if (!player || player.hidden) return;

    e.stopPropagation();
    e.preventDefault();

    const songId = getSongIdFromPlayer(player);
    if (!songId) return;

    scrubState = { scrub, player, songId, pointerId: e.pointerId };
    isScrubbing = true;
    scrub.setPointerCapture(e.pointerId);

    const ratio = getScrubRatio(scrub, e.clientX);
    seekSongPreview(songId, player, ratio);
  }

  function handlePlayerScrubPointerMove(e) {
    if (!isScrubbing || !scrubState || e.pointerId !== scrubState.pointerId) return;
    e.preventDefault();
    const ratio = getScrubRatio(scrubState.scrub, e.clientX);
    if (activePreviewPlayer === scrubState.player && activePreviewAudio) {
      seekPreviewPosition(ratio);
      return;
    }
    seekSongPreview(scrubState.songId, scrubState.player, ratio);
  }

  function handlePlayerScrubPointerUp(e) {
    if (!scrubState || e.pointerId !== scrubState.pointerId) return;
    if (scrubState.scrub.hasPointerCapture(e.pointerId)) {
      scrubState.scrub.releasePointerCapture(e.pointerId);
    }
    isScrubbing = false;
    scrubState = null;
  }

  function handlePlayerScrubKeydown(e) {
    const scrub = e.target.closest(".song-scrub");
    if (!scrub) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

    e.stopPropagation();
    e.preventDefault();

    const player = scrub.closest(".song-player");
    const songId = getSongIdFromPlayer(player);
    if (!player || !songId) return;

    const step = e.key === "ArrowRight" ? 0.05 : -0.05;
    const current = Number(scrub.getAttribute("aria-valuenow") || 0) / 100;
    seekSongPreview(songId, player, current + step);
  }

  function attachEvents() {
    els.cardA.addEventListener("click", (e) => {
      if (e.target.closest(".song-player")) return;
      vote("a");
    });
    els.cardB.addEventListener("click", (e) => {
      if (e.target.closest(".song-player")) return;
      vote("b");
    });
    els.cardA.addEventListener("keydown", (e) => {
      if (e.target.closest(".song-player")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        vote("a");
      }
    });
    els.cardB.addEventListener("keydown", (e) => {
      if (e.target.closest(".song-player")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        vote("b");
      }
    });
    els.matchup.addEventListener("click", (e) => {
      const playBtn = e.target.closest(".song-player-play");
      if (!playBtn) return;
      e.stopPropagation();
      const player = playBtn.closest(".song-player");
      const songId = getSongIdFromPlayer(player);
      if (songId) toggleSongPreview(songId, player);
    });
    els.matchup.addEventListener("pointerdown", handlePlayerScrubPointerDown);
    els.matchup.addEventListener("pointermove", handlePlayerScrubPointerMove);
    els.matchup.addEventListener("pointerup", handlePlayerScrubPointerUp);
    els.matchup.addEventListener("pointercancel", handlePlayerScrubPointerUp);
    els.matchup.addEventListener("keydown", handlePlayerScrubKeydown);
    els.btnSkip.addEventListener("click", () => vote("skip"));
    els.btnTie.addEventListener("click", () => vote("tie"));
    els.btnReset.addEventListener("click", resetVotes);
    els.btnExport.addEventListener("click", exportCsv);
    attachLeaderboardDrag();
    attachSongsListDrag();
    attachFavoriteMatchupEvents();

    els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
    });

    els.addSongForm.addEventListener("submit", handleAddSong);
    els.addAlbumForm.addEventListener("submit", handleAddAlbum);
    els.addSongForm.addEventListener("reset", () => {
      clearCoverUpload(els.fieldCover, els.coverPreviewSong);
      clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
      showFormError("");
    });
    els.addAlbumForm.addEventListener("reset", () => {
      clearCoverUpload(els.fieldAlbumCover, els.coverPreviewAlbum);
      if (els.fieldAlbumTracks) els.fieldAlbumTracks.value = "";
      showFormError("", "album");
    });
    els.fieldCover.addEventListener("change", () => {
      previewCoverFromInput(els.fieldCover, els.coverPreviewSong, (msg) =>
        showFormError(msg)
      );
    });
    if (els.fieldAudio) {
      els.fieldAudio.addEventListener("change", () => {
        try {
          const file = els.fieldAudio.files?.[0];
          if (!file) {
            clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
            return;
          }
          validateAudioFile(file);
          updateAudioPreviewFromInput();
          showFormError("");
        } catch (err) {
          clearAudioUpload(els.fieldAudio, els.audioPreviewSong, els.audioPreviewName);
          showFormError(err.message || t("error.audioType"));
        }
      });
    }
    els.fieldAlbumCover.addEventListener("change", () => {
      previewCoverFromInput(els.fieldAlbumCover, els.coverPreviewAlbum, (msg) =>
        showFormError(msg, "album")
      );
    });
    els.songsList.addEventListener("click", handleSongsListClick);
    els.albumsList.addEventListener("click", handleSongsListClick);
    els.formSwitches.forEach((btn) => {
      btn.addEventListener("click", () => switchAddForm(btn.dataset.form));
    });
    els.leaderboardSwitches.forEach((btn) => {
      btn.addEventListener("click", () => switchLeaderboardMode(btn.dataset.leaderboard));
    });
    els.btnClearAll.addEventListener("click", handleClearAll);
    els.btnGoAddSongs.addEventListener("click", () => switchView("songs"));
    if (els.btnFavoriteGoSongs) {
      els.btnFavoriteGoSongs.addEventListener("click", () => switchView("songs"));
    }
    if (els.btnFavoriteRestart) {
      els.btnFavoriteRestart.addEventListener("click", () =>
        resetFavoriteRun({ confirmRestart: true })
      );
    }

    els.langButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        window.I18n.setLocale(btn.dataset.lang);
      });
    });
    window.I18n.onChange(() => refreshLocaleUI());

    document.addEventListener("keydown", (e) => {
      if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable
      ) {
        return;
      }

      if (isFavoriteViewActive()) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          favoritePick("a");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          favoritePick("b");
        }
        return;
      }

      if (els.views.vote.hidden) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (goPreviousMatchup()) return;
        if (isLiveMatchup()) vote("a");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (goNextMatchup()) return;
        if (isLiveMatchup()) vote("b");
      } else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        vote("skip");
      } else if (e.key === "=" || e.key === "0") {
        e.preventDefault();
        vote("tie");
      }
    });
  }

  function init() {
    window.I18n.init();
    updateLangSwitcher();

    state.customSongs = loadCustomSongs();
    state.customAlbums = loadCustomAlbums();
    reconcileAlbums();
    mergeSongs();
    loadFavoriteState();

    if (state.songs.length < 2) {
      attachEvents();
      renderStats();
      renderSongsView();
      renderLeaderboard();
      renderVoteState();
      if (!els.views.favorite.hidden) renderFavoriteView();
      return;
    }

    const saved = loadState();
    if (saved && saved.stats) {
      state.stats = sanitizeLoadedStats(saved.stats);
      state.voteCount = saved.voteCount || 0;
      if (Array.isArray(saved.seenPairKeys)) {
        state.seenPairKeys = saved.seenPairKeys;
      } else if (Array.isArray(saved.recentPairKeys)) {
        state.seenPairKeys = saved.recentPairKeys;
      }
      if (Array.isArray(saved.shownSongIds)) {
        state.shownSongIds = saved.shownSongIds;
      }
      if (Array.isArray(saved.manualLeaderboardOrder)) {
        state.manualLeaderboardOrder = saved.manualLeaderboardOrder;
      }
    }
    syncCatalogIntegrity();
    attachEvents();
    renderMatchup();
    renderStats();
    renderLeaderboard();
    if (!els.views.favorite.hidden) renderFavoriteView();
  }

  init();
})();
