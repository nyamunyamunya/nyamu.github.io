/**
 * Song Ranker — pairwise voting with Elo ratings.
 * All state is kept in localStorage so the site works as a static page.
 */
(() => {
  "use strict";

  const t = (key, params) => window.I18n.t(key, params);

  const STORAGE_KEY = "song-ranker.v1";
  const CUSTOM_SONGS_KEY = "song-ranker.custom-songs.v1";
  const CUSTOM_ALBUMS_KEY = "song-ranker.custom-albums.v1";
  const INITIAL_RATING = 1000;
  const K_FACTOR = 32;
  // Dichotomy (binary-search) ranking: ~n × log₂(n) votes vs ~6n random pairs.
  function computeVoteTargets(songCount) {
    const n = songCount;
    if (n < 2) {
      return { coverage: 0, accurate: 0, perSong: 0 };
    }
    // Bootstrap (1) + binary insert for each remaining song into growing ranked list.
    let accurate = 1;
    for (let rankedSize = 2; rankedSize < n; rankedSize++) {
      accurate += Math.ceil(Math.log2(rankedSize + 1));
    }
    const perSong = Math.round((accurate / n) * 10) / 10;
    const coverage = Math.max(Math.ceil(n / 2), 1);
    return { coverage, accurate, perSong };
  }

  function getAccurateVoteTarget() {
    return computeVoteTargets(state.songs.length).accurate;
  }

  function getVoteAccuracyInfo() {
    const n = state.songs.length;
    const { coverage, accurate, perSong } = computeVoteTargets(n);
    const target = accurate;
    const votes = state.voteCount;
    const unvoted = state.songs.filter((s) => voteTotalForSong(s) === 0).length;
    const allVoted = unvoted === 0;
    const voteTargetMet = votes >= target;
    const dichotomyDone = isDichotomyComplete();
    const ready = dichotomyDone && allVoted;

    return {
      songCount: n,
      coverage,
      target,
      votes,
      remaining: Math.max(0, target - votes),
      progress: target > 0 ? Math.min(1, votes / target) : 1,
      unvoted,
      allVoted,
      voteTargetMet,
      dichotomyDone,
      ready,
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
    addFormMode: "song", // "song" | "album"
    leaderboardMode: "songs", // "songs" | "albums"
    dichotomy: {
      rankedIds: [],
      pendingIds: [],
      insert: null,
      bootstrap: null,
    },
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
          dichotomy: state.dichotomy,
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
      return parsed.filter(isValidSongShape);
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
      typeof obj.title === "string" &&
      typeof obj.artist === "string"
    );
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
    state.songs = [...state.customSongs];
  }

  function ensureStats() {
    for (const song of state.songs) {
      if (!state.stats[song.id]) {
        state.stats[song.id] = {
          rating: INITIAL_RATING,
          wins: 0,
          losses: 0,
          ties: 0,
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

  function generateCustomId(title, artist, albumId) {
    const prefix = albumId
      ? `${albumId}-${slugify(title)}`
      : `${CUSTOM_ID_PREFIX}${slugify(title)}-${slugify(artist)}`;
    const base = prefix.replace(/--+/g, "-");
    const existing = new Set(state.songs.map((s) => s.id));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
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

  function findDuplicate(title, artist) {
    const t = title.trim().toLowerCase();
    const a = artist.trim().toLowerCase();
    return state.songs.find(
      (s) =>
        (s.title || "").trim().toLowerCase() === t &&
        (s.artist || "").trim().toLowerCase() === a
    );
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
      id: generateCustomId(cleanTitle, cleanArtist, albumId),
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
    reconcileDichotomy();
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

    const seen = new Set();
    for (const trackTitle of titles) {
      const key = `${trackTitle.toLowerCase()}::${cleanArtist.toLowerCase()}`;
      if (seen.has(key)) {
        throw new Error(t("error.duplicateTrackInAlbum", { title: trackTitle }));
      }
      seen.add(key);
      const dup = findDuplicate(trackTitle, cleanArtist);
      if (dup) {
        throw new Error(
          t("error.trackAlreadyInList", { title: trackTitle, artist: cleanArtist })
        );
      }
    }

    const albumId = generateAlbumId(cleanTitle, cleanArtist);
    const album = {
      id: albumId,
      title: cleanTitle,
      artist: cleanArtist,
      trackCount: titles.length,
    };
    if (year && Number.isFinite(Number(year))) {
      album.year = Number(year);
    }
    if (cover) {
      album.cover = cover;
    }

    const songs = titles.map((trackTitle, index) => {
      const song = {
        id: generateCustomId(trackTitle, cleanArtist, albumId),
        title: trackTitle,
        artist: cleanArtist,
        albumId,
        album: cleanTitle,
        trackNumber: index + 1,
      };
      if (year && Number.isFinite(Number(year))) {
        song.year = Number(year);
      }
      if (cover) {
        song.cover = cover;
      }
      state.customSongs.push(song);
      return song;
    });

    state.customAlbums.push(album);
    saveCustomSongs();
    saveCustomAlbums();
    mergeSongs();
    ensureStats();
    reconcileDichotomy();

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
    reconcileDichotomy();

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
    state.current = state.songs.length >= 2 ? pickMatchup() : null;
    resetDichotomy();
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
    reconcileDichotomy();

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
   */
  function applyElo(idA, idB, scoreA) {
    const a = state.stats[idA];
    const b = state.stats[idB];
    const eA = expectedScore(a.rating, b.rating);
    const eB = 1 - eA;
    const scoreB = 1 - scoreA;
    a.rating = Math.round(a.rating + K_FACTOR * (scoreA - eA));
    b.rating = Math.round(b.rating + K_FACTOR * (scoreB - eB));

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
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function resetDichotomy() {
    const ids = state.songs.map((s) => s.id);
    shuffleArray(ids);
    state.dichotomy = {
      rankedIds: [],
      pendingIds: ids,
      insert: null,
      bootstrap: null,
    };
  }

  function isDichotomyComplete() {
    const d = state.dichotomy;
    return (
      state.songs.length >= 2 &&
      d.pendingIds.length === 0 &&
      !d.insert &&
      !d.bootstrap &&
      d.rankedIds.length === state.songs.length
    );
  }

  function reconcileDichotomy() {
    if (state.songs.length < 2) {
      resetDichotomy();
      return;
    }
    const valid = new Set(state.songs.map((s) => s.id));
    const d = state.dichotomy;
    if (!d || !Array.isArray(d.rankedIds) || !Array.isArray(d.pendingIds)) {
      resetDichotomy();
      return;
    }

    d.rankedIds = d.rankedIds.filter((id) => valid.has(id));
    d.pendingIds = d.pendingIds.filter((id) => valid.has(id));

    if (d.insert && !valid.has(d.insert.songId)) d.insert = null;
    if (d.bootstrap) {
      if (!valid.has(d.bootstrap.a) || !valid.has(d.bootstrap.b)) {
        d.bootstrap = null;
      }
    }

    const accounted = new Set([
      ...d.rankedIds,
      ...d.pendingIds,
      ...(d.insert ? [d.insert.songId] : []),
      ...(d.bootstrap ? [d.bootstrap.a, d.bootstrap.b] : []),
    ]);
    for (const song of state.songs) {
      if (!accounted.has(song.id)) d.pendingIds.push(song.id);
    }

    const expected =
      d.rankedIds.length +
      d.pendingIds.length +
      (d.insert ? 1 : 0) +
      (d.bootstrap ? 2 : 0);
    if (expected !== state.songs.length) resetDichotomy();
  }

  function syncRatingsFromDichotomy() {
    const d = state.dichotomy;
    const n = state.songs.length;
    const top = INITIAL_RATING + Math.max(n, 1) * 10;
    d.rankedIds.forEach((id, i) => {
      if (state.stats[id]) state.stats[id].rating = top - i;
    });
    if (d.insert && state.stats[d.insert.songId]) {
      const mid = Math.floor((d.insert.lo + d.insert.hi) / 2);
      state.stats[d.insert.songId].rating = top - mid;
    }
    d.pendingIds.forEach((id, i) => {
      if (state.stats[id]) state.stats[id].rating = INITIAL_RATING - i - 1;
    });
  }

  function pickDichotomyPair() {
    const d = state.dichotomy;

    if (d.bootstrap) {
      return { a: d.bootstrap.a, b: d.bootstrap.b };
    }

    if (d.insert && d.rankedIds.length > 0) {
      const mid = Math.floor((d.insert.lo + d.insert.hi) / 2);
      const pivotId = d.rankedIds[mid];
      if (pivotId && pivotId !== d.insert.songId) {
        return { a: d.insert.songId, b: pivotId };
      }
    }

    if (d.rankedIds.length === 0 && d.pendingIds.length >= 2) {
      d.bootstrap = { a: d.pendingIds[0], b: d.pendingIds[1] };
      return { a: d.bootstrap.a, b: d.bootstrap.b };
    }

    if (d.rankedIds.length > 0 && d.pendingIds.length > 0 && !d.insert) {
      d.insert = {
        songId: d.pendingIds.shift(),
        lo: 0,
        hi: d.rankedIds.length,
      };
      return pickDichotomyPair();
    }

    return null;
  }

  function advanceDichotomy(winnerId, loserId) {
    const d = state.dichotomy;

    if (d.bootstrap) {
      const { a, b } = d.bootstrap;
      d.rankedIds = winnerId === a ? [a, b] : [b, a];
      d.pendingIds = d.pendingIds.filter((id) => id !== a && id !== b);
      d.bootstrap = null;
      syncRatingsFromDichotomy();
      return;
    }

    if (d.insert) {
      const mid = Math.floor((d.insert.lo + d.insert.hi) / 2);
      const pivotId = d.rankedIds[mid];
      if (winnerId === d.insert.songId) {
        d.insert.hi = mid;
      } else if (winnerId === pivotId) {
        d.insert.lo = mid + 1;
      }
      if (d.insert.lo >= d.insert.hi) {
        d.rankedIds.splice(d.insert.lo, 0, d.insert.songId);
        d.insert = null;
      }
      syncRatingsFromDichotomy();
    }
  }

  function voteTotalForSong(song) {
    const st = state.stats[song.id];
    return st.wins + st.losses + st.ties;
  }

  function pickByLeastVotes(songs) {
    const totals = songs.map((s) => voteTotalForSong(s));
    const maxVotes = Math.max(...totals, 0);
    // Squared weights keep under-voted songs in rotation after the first pass.
    const weights = totals.map((v) => Math.pow(maxVotes - v + 1, 2));
    return weightedPick(songs, weights);
  }

  // ---------- Matchup selection (dichotomy-first) ----------
  function pickMatchup() {
    if (state.songs.length < 2) return null;

    if (!isDichotomyComplete()) {
      const pair = pickDichotomyPair();
      if (pair) {
        let a = songById(pair.a);
        let b = songById(pair.b);
        if (a && b) {
          if (Math.random() < 0.5) [a, b] = [b, a];
          return { a: a.id, b: b.id };
        }
      }
    }

    let a = pickByLeastVotes(state.songs);
    let b = pickByLeastVotes(state.songs.filter((s) => s.id !== a.id));

    // Avoid repeating the same pair back-to-back when possible.
    if (
      state.lastPair &&
      state.songs.length > 2 &&
      pairKey(a.id, b.id) === pairKey(state.lastPair.a, state.lastPair.b)
    ) {
      const alt = state.songs.find(
        (s) => s.id !== a.id && s.id !== b.id
      );
      if (alt) b = alt;
    }

    // 50/50 which side each song appears on.
    if (Math.random() < 0.5) [a, b] = [b, a];
    return { a: a.id, b: b.id };
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

  function pairKey(a, b) {
    return [a, b].sort().join("::");
  }

  function songById(id) {
    return state.songs.find((s) => s.id === id);
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
    btnReset: document.getElementById("btn-reset"),
    btnExport: document.getElementById("btn-export"),
    tabs: document.querySelectorAll(".tab"),
    views: {
      vote: document.getElementById("view-vote"),
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
    if (!state.current) return;
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
        const rating =
          stats.reduce((sum, st) => sum + st.rating, 0) / stats.length;
        const wins = stats.reduce((sum, st) => sum + st.wins, 0);
        const losses = stats.reduce((sum, st) => sum + st.losses, 0);
        const ties = stats.reduce((sum, st) => sum + st.ties, 0);
        const total = wins + losses + ties;
        const winrate = total ? (wins + ties * 0.5) / total : 0;

        return {
          album,
          trackCount: tracks.length,
          rating,
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
          b.rating - a.rating ||
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
    return state.songs
      .map((song) => ({
        id: song.id,
        rating: state.stats[song.id].rating,
      }))
      .sort((a, b) => b.rating - a.rating)
      .map((row) => row.id);
  }

  function applyRatingsFromOrder(orderedIds) {
    if (orderedIds.length === 0) return;
    const top =
      Math.max(...orderedIds.map((id) => state.stats[id].rating), INITIAL_RATING) +
      orderedIds.length;
    orderedIds.forEach((id, i) => {
      state.stats[id].rating = top - i;
    });
  }

  function reorderLeaderboard(draggedId, targetIndex) {
    const order = getLeaderboardOrder();
    const oldIndex = order.indexOf(draggedId);
    if (oldIndex === -1) return;

    order.splice(oldIndex, 1);
    let insertAt = Math.max(0, Math.min(targetIndex, order.length));
    if (oldIndex < targetIndex) insertAt -= 1;
    insertAt = Math.max(0, Math.min(insertAt, order.length));
    order.splice(insertAt, 0, draggedId);

    applyRatingsFromOrder(order);
    saveState();
    renderLeaderboard();
    if (!els.views.songs.hidden) renderSongsView();
  }

  let dragSongId = null;

  function clearLeaderboardDragState() {
    dragSongId = null;
    els.leaderboardBody
      .querySelectorAll(".is-dragging, .is-drag-over")
      .forEach((el) => el.classList.remove("is-dragging", "is-drag-over"));
  }

  function attachLeaderboardDrag() {
    els.leaderboardBody.addEventListener("dragstart", (e) => {
      if (state.leaderboardMode !== "songs") {
        e.preventDefault();
        return;
      }
      const row = e.target.closest("tr[data-song-id]");
      if (!row) {
        e.preventDefault();
        return;
      }
      dragSongId = row.dataset.songId;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragSongId);
      row.classList.add("is-dragging");
    });

    els.leaderboardBody.addEventListener("dragover", (e) => {
      e.preventDefault();
      const row = e.target.closest("tr[data-song-id]");
      if (!row || row.dataset.songId === dragSongId) return;
      e.dataTransfer.dropEffect = "move";
      els.leaderboardBody
        .querySelectorAll(".is-drag-over")
        .forEach((el) => el.classList.remove("is-drag-over"));
      row.classList.add("is-drag-over");
    });

    els.leaderboardBody.addEventListener("dragleave", (e) => {
      const row = e.target.closest("tr[data-song-id]");
      if (row) row.classList.remove("is-drag-over");
    });

    els.leaderboardBody.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragSongId) return;

      const row = e.target.closest("tr[data-song-id]");
      const rows = [
        ...els.leaderboardBody.querySelectorAll("tr[data-song-id]"),
      ];

      let targetIndex = rows.length;
      if (row) {
        targetIndex = rows.findIndex((r) => r.dataset.songId === row.dataset.songId);
        if (row.dataset.songId === dragSongId) {
          clearLeaderboardDragState();
          return;
        }
      }

      reorderLeaderboard(dragSongId, targetIndex);
      clearLeaderboardDragState();
    });

    els.leaderboardBody.addEventListener("dragend", clearLeaderboardDragState);
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
        const winPct = r.total ? `${Math.round(r.winrate * 100)}%` : "—";
        const avgRating = Math.round(r.rating);

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
            <td class="col-record">${r.wins} – ${r.losses} – ${r.ties}</td>
            <td class="col-winrate">${winPct}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderLeaderboard() {
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

    const rows = state.songs
      .map((song) => {
        const st = state.stats[song.id];
        const total = st.wins + st.losses + st.ties;
        const winrate = total ? (st.wins + st.ties * 0.5) / total : 0;
        return { song, ...st, total, winrate };
      })
      .sort((a, b) => b.rating - a.rating);

    els.leaderboardBody.innerHTML = rows
      .map((r, i) => {
        const rank = i + 1;
        const rankClass =
          rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
        const cover = r.song.cover
          ? `<img src="${escapeAttr(r.song.cover)}" alt="" draggable="false" onerror="this.style.visibility='hidden'">`
          : `<img alt="" draggable="false" style="visibility:hidden">`;
        const winPct = r.total ? `${Math.round(r.winrate * 100)}%` : "—";
        return `
          <tr data-song-id="${escapeAttr(r.song.id)}" draggable="true">
            <td class="col-rank ${rankClass}">${rank}</td>
            <td class="col-drag">
              <span class="drag-handle" title="${escapeAttr(t("leaderboard.dragReorder"))}" aria-label="${escapeAttr(t("leaderboard.dragSong", { title: r.song.title }))}">⋮⋮</span>
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
            <td class="col-rating">${r.rating}</td>
            <td class="col-record">${r.wins} – ${r.losses} – ${r.ties}</td>
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
    const list = state.songs;
    const albumCount = state.customAlbums.length;
    els.songsCount.textContent = t("songs.count", {
      songs: state.songs.length,
      albums: albumCount,
    });

    renderAlbumsList();

    if (list.length === 0) {
      els.songsList.innerHTML =
        `<li class="empty-state">${escapeHtml(t("songs.empty"))}</li>`;
      if (els.btnClearAll) els.btnClearAll.disabled = true;
      return;
    }

    if (els.btnClearAll) els.btnClearAll.disabled = false;

    const rows = list
      .map((song) => ({
        song,
        stats: state.stats[song.id] || {
          rating: INITIAL_RATING,
          wins: 0,
          losses: 0,
          ties: 0,
        },
      }))
      .sort((a, b) => b.stats.rating - a.stats.rating);

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
          <li class="song-row" data-id="${escapeAttr(song.id)}">
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
              <div class="song-row-rating">${stats.rating}</div>
              <div class="song-row-record">${stats.wins} – ${stats.losses} – ${stats.ties}</div>
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
        const { album, trackCount, rating } = row;
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
              <div class="album-row-meta">${escapeHtml(t("songs.trackMeta", { count: trackCount, rating: Math.round(rating) }))}</div>
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
    if (!state.current) return;
    stopActivePreview();
    const { a, b } = state.current;
    if (side === "a") {
      els.cardA.classList.add("is-picked");
      els.cardB.classList.add("is-loser");
      applyElo(a, b, 1);
      if (!isDichotomyComplete()) advanceDichotomy(a, b);
    } else if (side === "b") {
      els.cardB.classList.add("is-picked");
      els.cardA.classList.add("is-loser");
      applyElo(a, b, 0);
      if (!isDichotomyComplete()) advanceDichotomy(b, a);
    } else if (side === "tie") {
      applyElo(a, b, 0.5);
    } else {
      // skip: don't update anything
    }

    if (side !== "skip") state.voteCount += 1;
    saveState();

    state.lastPair = { ...state.current };

    // Brief pause so the pick animation is visible.
    const delay = side === "skip" ? 0 : 220;
    setTimeout(() => {
      state.current = pickMatchup();
      renderMatchup();
      renderStats();
      renderLeaderboard();
      if (!els.views.songs.hidden) renderSongsView();
    }, delay);
  }

  function switchView(name) {
    if (name !== "vote") stopActivePreview();
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
  }

  function resetVotes() {
    if (!confirm(t("confirm.resetVotes"))) return;
    state.stats = {};
    state.voteCount = 0;
    state.lastPair = null;
    ensureStats();
    resetDichotomy();
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

      // If this is the first pair we can build, or we didn't have one yet, pick.
      if (!state.current && state.songs.length >= 2) {
        state.current = pickMatchup();
        renderMatchup();
      }
      renderStats();
      renderSongsView();
      renderLeaderboard();

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

      if (!state.current && state.songs.length >= 2) {
        state.current = pickMatchup();
        renderMatchup();
      }
      renderStats();
      renderSongsView();
      renderLeaderboard();

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
            Math.round(r.rating),
            r.trackCount,
            r.wins,
            r.losses,
            r.ties,
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

    const rows = state.songs
      .map((song) => {
        const st = state.stats[song.id];
        return { song, ...st };
      })
      .sort((a, b) => b.rating - a.rating);

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
          r.rating,
          r.wins,
          r.losses,
          r.ties,
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

    els.langButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        window.I18n.setLocale(btn.dataset.lang);
      });
    });
    window.I18n.onChange(() => refreshLocaleUI());

    document.addEventListener("keydown", (e) => {
      if (
        els.views.vote.hidden ||
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        vote("a");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        vote("b");
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

    if (state.songs.length < 2) {
      attachEvents();
      renderStats();
      renderSongsView();
      renderLeaderboard();
      renderVoteState();
      return;
    }

    const saved = loadState();
    if (saved && saved.stats) {
      state.stats = saved.stats;
      state.voteCount = saved.voteCount || 0;
      if (saved.dichotomy) {
        state.dichotomy = saved.dichotomy;
      }
    }
    ensureStats();
    reconcileDichotomy();
    if (state.dichotomy.rankedIds.length > 0) {
      syncRatingsFromDichotomy();
    }

    state.current = pickMatchup();
    attachEvents();
    renderMatchup();
    renderStats();
    renderLeaderboard();
  }

  init();
})();
