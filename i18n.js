/**
 * Song Ranker — English / Simplified Chinese UI strings.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "song-ranker.locale.v1";

  const messages = {
    en: {
      "app.title": "Song Ranker",
      "meta.title": "Song Ranker — Pick Your Favorite",
      "meta.description":
        "Rank songs by comparing two at a time. Your votes power a live leaderboard.",
      "lang.label": "Language",
      "lang.en": "English",
      "lang.zhCN": "简体中文",

      "nav.sections": "Sections",
      "nav.vote": "Vote",
      "nav.favorite": "Your favorite",
      "nav.leaderboard": "Leaderboard",
      "nav.songs": "Songs",
      "nav.about": "About",

      "vote.heading": "Vote",
      "vote.statVotes": "Votes",
      "vote.statSongs": "Songs",
      "vote.progressAria": "Progress toward recommended votes",
      "vote.emptyTitle": "Add songs to continue",
      "vote.emptyHintNone": "Head to the Songs tab to add tracks or a whole album.",
      "vote.emptyHintOne": "Add at least one more song to start voting.",
      "vote.addSongs": "Add songs",
      "vote.pickA": "Pick song A",
      "vote.pickB": "Pick song B",
      "vote.loading": "Loading…",
      "vote.pickSong": "Pick {title} by {artist}{albumPart}",
      "vote.fromAlbum": " from {album}",
      "vote.unknownArtist": "Unknown",
      "vote.skip": "Skip →",
      "vote.tie": "Too close to call",
      "vote.playPreview": "Play preview",
      "vote.pausePreview": "Pause preview",
      "vote.seekTimeline": "Audio timeline",

      "favorite.heading": "Your favorite song",
      "favorite.hint":
        "Pick the winner each round. The other song is removed until one favorite remains. This does not change your rankings or leaderboard.",
      "favorite.emptyTitle": "Add songs to play",
      "favorite.emptyHint": "You need at least two songs on the Songs tab.",
      "favorite.remaining": "{count} songs remaining",
      "favorite.winnerLabel": "Your favorite",
      "favorite.restart": "Start over",
      "favorite.pickA": "Pick this song",
      "favorite.pickB": "Pick this song",
      "confirm.restartFavorite": "Start a new favorite run from your full song list?",

      "leaderboard.heading": "Leaderboard",
      "leaderboard.export": "Export CSV",
      "leaderboard.reset": "Reset votes",
      "leaderboard.type": "Leaderboard type",
      "leaderboard.songs": "Songs",
      "leaderboard.albums": "Albums",
      "leaderboard.hintDefault":
        "Press and drag a song onto another row to move it to that rank. Ratings update; win % stays the same.",
      "leaderboard.hintAlbumsEmpty":
        "Album rankings use only tracks grouped into an album on the Songs tab. Standalone songs are not counted.",
      "leaderboard.hintAlbumsCount":
        "{albums} album(s) ranked from {tracks} grouped track(s) (standalone songs excluded).",
      "leaderboard.hintVotesMet":
        "{votes} vote(s) cast (recommended {target}). Keep voting to refine, or drag one song to any rank to adjust it.",
      "leaderboard.hintVotesProgress":
        "{songs} songs in pool — {votes} / {target} recommended votes ({remaining} to go). Drag one song to any rank anytime.",
      "leaderboard.colSong": "Song",
      "leaderboard.colAlbum": "Album",
      "leaderboard.colRating": "Rating",
      "leaderboard.colAvgRating": "Avg rating",
      "leaderboard.colTracks": "Tracks",
      "leaderboard.colRecord": "W – L – T",
      "leaderboard.colWinrate": "Win %",
      "leaderboard.emptySongs": "Add songs to continue",
      "leaderboard.emptyAlbums":
        "No albums yet — group songs into albums on the Songs tab.",
      "leaderboard.dragReorder": "Drag to move rank",
      "leaderboard.dragSong": "Drag {title} to a new rank",

      "songs.heading": "Songs",
      "songs.count": "{songs} song(s) · {albums} album(s)",
      "songs.formToggle": "Add song or album",
      "songs.addSong": "Add song",
      "songs.addAlbum": "Add album",
      "songs.formTitleSong": "Add a song",
      "songs.formTitleAlbum": "Add an album",
      "songs.labelTitle": "Title",
      "songs.labelArtist": "Artist",
      "songs.labelYear": "Year",
      "songs.labelAlbum": "Album",
      "songs.labelCover": "Cover image",
      "songs.labelAudio": "Audio preview",
      "songs.labelAlbumTitle": "Album title",
      "songs.labelTracks": "Tracks",
      "songs.hintCoverSong":
        "Optional. Upload JPG, PNG, WebP, or GIF from your device.",
      "songs.hintAudio":
        "Optional. Plays on the vote screen when comparing songs.",
      "songs.hintCoverAlbum": "Optional. Shared by every track on this album.",
      "songs.hintTracksEnter": "Enter one track title per line, in album order.",
      "songs.btnAddSong": "Add song",
      "songs.btnAddAlbum": "Add album",
      "songs.btnClear": "Clear",
      "songs.sectionAlbums": "Albums",
      "songs.sectionSongs": "Songs",
      "songs.clearList": "Clear list",
      "songs.empty": "No songs yet. Add a song above or create an album with tracks.",
      "songs.onAlbum": "On album",
      "songs.albumFallback": "album",
      "songs.removeFromList": "Remove from list",
      "songs.deleteSong": "Delete {title}",
      "songs.deleteAlbum": "Delete album",
      "songs.deleteAlbumAria": "Delete album {title}",
      "songs.removeFromAlbum": "Remove {title} from album",
      "songs.trackMeta": "{count} track(s) · avg {rating}",
      "songs.trackMetaUnranked": "{count} track(s)",
      "songs.albumTracksAria": "Album tracks — drag songs here",
      "songs.coverPreview": "Cover preview",
      "songs.removeCover": "Remove cover image",
      "songs.removeAudio": "Remove audio file",

      "about.heading": "How to use Song Ranker",
      "about.intro":
        "Compare two songs at a time to build your personal chart. Everything stays saved in this browser.",
      "about.step1Title": "1. Add your songs",
      "about.step1Text":
        "On <strong>Songs</strong>, add tracks with a title and artist. You need at least two to start voting.",
      "about.step2Title": "2. Vote on matchups",
      "about.step2Text":
        "On <strong>Vote</strong>, click the song you prefer. Use <strong>Skip</strong> or <strong>Too close to call</strong> when needed. Shortcuts: <kbd>←</kbd> <kbd>→</kbd> to pick, <kbd>Space</kbd> to skip.",
      "about.step3Title": "3. Check your leaderboard",
      "about.step3Text":
        "<strong>Leaderboard</strong> shows your ranked songs — or switch to <strong>Albums</strong>. Drag one song to any rank to adjust it.",
      "about.step4Title": "4. Group songs into albums (optional)",
      "about.step4Text":
        "On <strong>Songs</strong>, choose <strong>Add album</strong>, type track titles (one per line), set the album details, and save.",
      "about.step5Title": "5. Export or start over",
      "about.step5Text":
        "<strong>Export CSV</strong> downloads rankings. <strong>Reset votes</strong> clears results. <strong>Clear list</strong> removes all songs.",
      "about.note":
        "Your progress is saved locally — close the tab anytime and pick up later.",

      "confirm.clearAll":
        "Clear all {count} songs and albums from your list? This cannot be undone in this browser.",
      "confirm.resetVotes": "Reset all votes and ratings? This cannot be undone.",
      "confirm.deleteSong": 'Delete "{title}" by {artist}?',
      "confirm.deleteAlbum":
        'Delete album "{title}" and all {count} track(s)?',

      "error.titleRequired": "Title is required.",
      "error.artistRequired": "Artist is required.",
      "error.albumTitleRequired": "Album title is required.",
      "error.enterTracks": "Enter at least one track title.",
      "error.albumAlreadyInList": 'Album "{title}" by {artist} is already in your list.',
      "error.duplicateTrackInAlbum": 'Track "{title}" appears more than once in this album.',
      "error.trackAlreadyInList": '"{title}" by {artist} is already in the list.',
      "error.addSong": "Couldn't add the song.",
      "error.addAlbum": "Couldn't add the album.",
      "error.readImage": "Couldn't read that image.",
      "error.imageType": "Please choose an image file (JPG, PNG, WebP, or GIF).",
      "error.imageSize": "Image must be under 10 MB.",
      "error.compressImage":
        "Image is too large after compression — try a smaller file.",
      "error.loadImage": "Couldn't load that image.",
      "error.audioType":
        "Please choose an audio file (MP3, WAV, OGG, M4A, AAC, FLAC, or WebM).",
      "error.audioSize": "Audio must be under 8 MB.",
      "success.albumCreated": 'Created "{title}" with {count} track(s).',
    },
    "zh-CN": {
      "app.title": "歌曲排名",
      "meta.title": "歌曲排名 — 选出你最喜欢的歌",
      "meta.description": "两两对比歌曲，用投票生成实时排行榜。",
      "lang.label": "语言",
      "lang.en": "English",
      "lang.zhCN": "简体中文",

      "nav.sections": "导航",
      "nav.vote": "投票",
      "nav.favorite": "最爱歌曲",
      "nav.leaderboard": "排行榜",
      "nav.songs": "歌曲",
      "nav.about": "关于",

      "vote.heading": "投票",
      "vote.statVotes": "投票数",
      "vote.statSongs": "歌曲数",
      "vote.progressAria": "推荐投票进度",
      "vote.emptyTitle": "添加歌曲以继续",
      "vote.emptyHintNone": "前往「歌曲」标签页添加单曲或整张专辑。",
      "vote.emptyHintOne": "至少需要再添加一首歌曲才能开始投票。",
      "vote.addSongs": "添加歌曲",
      "vote.pickA": "选择左侧歌曲",
      "vote.pickB": "选择右侧歌曲",
      "vote.loading": "加载中…",
      "vote.pickSong": "选择 {title} — {artist}{albumPart}",
      "vote.fromAlbum": "（专辑 {album}）",
      "vote.unknownArtist": "未知艺术家",
      "vote.skip": "跳过 →",
      "vote.tie": "差不多",
      "vote.playPreview": "播放预览",
      "vote.pausePreview": "暂停预览",
      "vote.seekTimeline": "音频进度",

      "favorite.heading": "最爱歌曲",
      "favorite.hint":
        "每轮选择更喜欢的歌曲，另一首会被淘汰，直到剩下你的最爱。此模式不会影响排行榜或歌曲列表。",
      "favorite.emptyTitle": "添加歌曲后再玩",
      "favorite.emptyHint": "请先在「歌曲」标签页添加至少两首歌曲。",
      "favorite.remaining": "还剩 {count} 首",
      "favorite.winnerLabel": "你的最爱",
      "favorite.restart": "重新开始",
      "favorite.pickA": "选择这首",
      "favorite.pickB": "选择这首",
      "confirm.restartFavorite": "从完整歌曲列表重新开始吗？",

      "leaderboard.heading": "排行榜",
      "leaderboard.export": "导出 CSV",
      "leaderboard.reset": "重置投票",
      "leaderboard.type": "排行榜类型",
      "leaderboard.songs": "歌曲",
      "leaderboard.albums": "专辑",
      "leaderboard.hintDefault": "按住并拖动一首歌到另一行即可移到该排名 — 评分会更新，胜率不变。",
      "leaderboard.hintAlbumsEmpty":
        "专辑排行仅统计在「歌曲」页归入专辑的曲目，未归专辑的单曲不计入。",
      "leaderboard.hintAlbumsCount":
        "共 {albums} 张专辑，来自 {tracks} 首已分组曲目（不含未归专辑的单曲）。",
      "leaderboard.hintVotesMet":
        "已投 {votes} 票（推荐 {target} 票）。可继续投票细化排名，或拖动单首歌曲到任意排名。",
      "leaderboard.hintVotesProgress":
        "曲库 {songs} 首 — 已投 {votes} / {target} 票（还差 {remaining} 票）。可随时拖动单首歌曲到任意排名。",
      "leaderboard.colSong": "歌曲",
      "leaderboard.colAlbum": "专辑",
      "leaderboard.colRating": "评分",
      "leaderboard.colAvgRating": "平均评分",
      "leaderboard.colTracks": "曲目数",
      "leaderboard.colRecord": "胜 – 负 – 平",
      "leaderboard.colWinrate": "胜率",
      "leaderboard.emptySongs": "添加歌曲以继续",
      "leaderboard.emptyAlbums": "暂无专辑 — 请在「歌曲」页将歌曲归入专辑。",
      "leaderboard.dragReorder": "拖动调整排名",
      "leaderboard.dragSong": "拖动 {title} 到新排名",

      "songs.heading": "歌曲",
      "songs.count": "{songs} 首歌曲 · {albums} 张专辑",
      "songs.formToggle": "添加歌曲或专辑",
      "songs.addSong": "添加歌曲",
      "songs.addAlbum": "添加专辑",
      "songs.formTitleSong": "添加歌曲",
      "songs.formTitleAlbum": "添加专辑",
      "songs.labelTitle": "标题",
      "songs.labelArtist": "艺术家",
      "songs.labelYear": "年份",
      "songs.labelAlbum": "专辑",
      "songs.labelCover": "封面图片",
      "songs.labelAudio": "音频预览",
      "songs.labelAlbumTitle": "专辑名称",
      "songs.labelTracks": "曲目",
      "songs.hintCoverSong": "可选。支持 JPG、PNG、WebP 或 GIF。",
      "songs.hintAudio": "可选。在投票对比时可播放试听。",
      "songs.hintCoverAlbum": "可选。本专辑所有曲目共用。",
      "songs.hintTracksEnter": "按专辑顺序输入，每行一首曲目。",
      "songs.btnAddSong": "添加歌曲",
      "songs.btnAddAlbum": "添加专辑",
      "songs.btnClear": "清空",
      "songs.sectionAlbums": "专辑",
      "songs.sectionSongs": "歌曲",
      "songs.clearList": "清空列表",
      "songs.empty": "暂无歌曲。请在上方添加单曲，或通过专辑表单输入曲目。",
      "songs.onAlbum": "已归专辑",
      "songs.albumFallback": "专辑",
      "songs.removeFromList": "从列表移除",
      "songs.deleteSong": "删除 {title}",
      "songs.deleteAlbum": "删除专辑",
      "songs.deleteAlbumAria": "删除专辑 {title}",
      "songs.removeFromAlbum": "从专辑移除 {title}",
      "songs.trackMeta": "{count} 首曲目 · 平均 {rating}",
      "songs.trackMetaUnranked": "{count} 首曲目",
      "songs.albumTracksAria": "专辑曲目 — 拖动歌曲到这里",
      "songs.coverPreview": "封面预览",
      "songs.removeCover": "移除封面",
      "songs.removeAudio": "移除音频",

      "about.heading": "如何使用歌曲排名",
      "about.intro":
        "两两对比歌曲，建立你的个人榜单。所有数据仅保存在本浏览器中。",
      "about.step1Title": "1. 添加歌曲",
      "about.step1Text":
        "在<strong>歌曲</strong>页填写标题和艺术家即可添加。至少需要两首才能开始投票。",
      "about.step2Title": "2. 投票对比",
      "about.step2Text":
        "在<strong>投票</strong>页点击更喜欢的歌曲。可用<strong>跳过</strong>或<strong>差不多</strong>。快捷键：<kbd>←</kbd> <kbd>→</kbd> 选择，<kbd>Space</kbd> 跳过。",
      "about.step3Title": "3. 查看排行榜",
      "about.step3Text":
        "<strong>排行榜</strong>显示歌曲排名，也可切换到<strong>专辑</strong>。拖动单首歌曲到任意排名即可调整。",
      "about.step4Title": "4. 创建专辑（可选）",
      "about.step4Text":
        "在<strong>歌曲</strong>页选择<strong>添加专辑</strong>，每行输入一首曲目，填写专辑信息后保存。",
      "about.step5Title": "5. 导出或重置",
      "about.step5Text":
        "<strong>导出 CSV</strong>下载排名。<strong>重置投票</strong>清除结果。<strong>清空列表</strong>删除所有歌曲。",
      "about.note": "进度保存在本地 — 随时关闭页面，下次打开可继续。",

      "confirm.clearAll":
        "清空列表中的全部 {count} 首歌曲和专辑？此操作无法在本浏览器中撤销。",
      "confirm.resetVotes": "重置所有投票和评分？此操作无法撤销。",
      "confirm.deleteSong": "删除「{title}」（{artist}）？",
      "confirm.deleteAlbum": "删除专辑「{title}」及其全部 {count} 首曲目？",

      "error.titleRequired": "请填写标题。",
      "error.artistRequired": "请填写艺术家。",
      "error.albumTitleRequired": "请填写专辑名称。",
      "error.enterTracks": "请至少输入一首曲目。",
      "error.albumAlreadyInList": "专辑「{title}」（{artist}）已在列表中。",
      "error.duplicateTrackInAlbum": "曲目「{title}」在本专辑中重复出现。",
      "error.trackAlreadyInList": "「{title}」（{artist}）已在列表中。",
      "error.addSong": "无法添加歌曲。",
      "error.addAlbum": "无法添加专辑。",
      "error.readImage": "无法读取该图片。",
      "error.imageType": "请选择图片文件（JPG、PNG、WebP 或 GIF）。",
      "error.imageSize": "图片须小于 10 MB。",
      "error.compressImage": "压缩后图片仍然过大 — 请换一张较小的文件。",
      "error.loadImage": "无法加载该图片。",
      "error.audioType":
        "请选择音频文件（MP3、WAV、OGG、M4A、AAC、FLAC 或 WebM）。",
      "error.audioSize": "音频须小于 8 MB。",
      "success.albumCreated": "已创建「{title}」，共 {count} 首曲目。",
    },
  };

  let locale = "en";
  const listeners = [];

  function t(key, params = {}) {
    let str = messages[locale]?.[key] ?? messages.en[key] ?? key;
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
    return str;
  }

  function applyDocument() {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      el.alt = t(el.dataset.i18nAlt);
    });

    document.title = t("meta.title");
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.content = t("meta.description");
  }

  function setLocale(next) {
    if (!messages[next] || next === locale) return;
    locale = next;
    localStorage.setItem(STORAGE_KEY, locale);
    applyDocument();
    listeners.forEach((fn) => fn(locale));
  }

  function init() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && messages[saved]) locale = saved;
    applyDocument();
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  window.I18n = {
    t,
    setLocale,
    getLocale: () => locale,
    applyDocument,
    init,
    onChange,
  };
})();
