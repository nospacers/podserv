const STORAGE_KEYS = {
  subscriptions: "podcast-subscriptions-v2",
  progress: "podcast-progress-v2",
  lastFeed: "podcast-last-feed-v2",
  episodesCollapsed: "podcast-episodes-collapsed-v1",
};

const SAMPLE_FEED = "https://feeds.simplecast.com/54nAGcIl";

const els = {
  feedUrl: document.getElementById("feedUrl"),
  loadFeedBtn: document.getElementById("loadFeedBtn"),
  saveSubscriptionBtn: document.getElementById("saveSubscriptionBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  episodeSearch: document.getElementById("episodeSearch"),
  subscriptions: document.getElementById("subscriptions"),
  subscriptionCount: document.getElementById("subscriptionCount"),
  downloadsList: document.getElementById("downloadsList"),
  downloadCount: document.getElementById("downloadCount"),
  statusBox: document.getElementById("statusBox"),
  episodeList: document.getElementById("episodeList"),
  episodeCount: document.getElementById("episodeCount"),
  podcastArt: document.getElementById("podcastArt"),
  heroArtFallback: document.getElementById("heroArtFallback"),
  episodeTitle: document.getElementById("episodeTitle"),
  podcastTitle: document.getElementById("podcastTitle"),
  episodeDescription: document.getElementById("episodeDescription"),
  audioPlayer: document.getElementById("audioPlayer"),
  backBtn: document.getElementById("backBtn"),
  playBtn: document.getElementById("playBtn"),
  forwardBtn: document.getElementById("forwardBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  offlineBtn: document.getElementById("offlineBtn"),
  currentTime: document.getElementById("currentTime"),
  seekBar: document.getElementById("seekBar"),
  duration: document.getElementById("duration"),
  episodeMeta: document.getElementById("episodeMeta"),
  installBtn: document.getElementById("installBtn"),
  toggleEpisodesBtn: document.getElementById("toggleEpisodesBtn"),
  episodesSection: document.getElementById("episodesSection"),
  episodeListWrap: document.getElementById("episodeListWrap"),
  rateButtons: [...document.querySelectorAll(".rate-btn")],
};

const state = {
  podcast: null,
  episodes: [],
  filteredEpisodes: [],
  selectedEpisode: null,
  downloads: [],
  installPrompt: null,
};

function setPlayButtonState(isPlaying) {
  if (!els.playBtn) return;
  const icon = isPlaying ? "pause" : "play_arrow";
  const label = isPlaying ? "Pause" : "Play";
  els.playBtn.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${label}</span>`;
}

function setEpisodesCollapsed(collapsed) {
  if (!els.episodesSection || !els.toggleEpisodesBtn || !els.episodeListWrap) return;
  els.episodesSection.classList.toggle("collapsed", collapsed);
  els.toggleEpisodesBtn.setAttribute("aria-expanded", String(!collapsed));
  els.toggleEpisodesBtn.textContent = collapsed ? "Show episodes" : "Hide episodes";
  els.episodeListWrap.classList.toggle("hidden-block", collapsed);
  localStorage.setItem(STORAGE_KEYS.episodesCollapsed, collapsed ? "1" : "0");
}

function initEpisodesCollapse() {
  const saved = localStorage.getItem(STORAGE_KEYS.episodesCollapsed);
  const defaultCollapsed = window.matchMedia && window.matchMedia("(max-width: 980px)").matches;
  const collapsed = saved === null ? defaultCollapsed : saved === "1";
  setEpisodesCollapsed(collapsed);
  els.toggleEpisodesBtn?.addEventListener("click", () => {
    const next = !els.episodesSection.classList.contains("collapsed");
    setEpisodesCollapsed(next);
  });
}

function getJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function setJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showStatus(message, ok = false) {
  els.statusBox.textContent = message;
  els.statusBox.classList.remove("hidden", "ok");
  if (ok) els.statusBox.classList.add("ok");
}

function clearStatus() {
  els.statusBox.classList.add("hidden");
  els.statusBox.classList.remove("ok");
  els.statusBox.textContent = "";
}

function getSubscriptions() {
  return getJson(STORAGE_KEYS.subscriptions, []);
}

function saveSubscriptions(subscriptions) {
  setJson(STORAGE_KEYS.subscriptions, subscriptions);
  renderSubscriptions();
}

function getProgressMap() {
  return getJson(STORAGE_KEYS.progress, {});
}

function saveProgressForCurrentEpisode() {
  const ep = state.selectedEpisode;
  if (!ep || !els.audioPlayer.src) return;
  const progress = getProgressMap();
  progress[ep.id] = {
    currentTime: els.audioPlayer.currentTime || 0,
    duration: els.audioPlayer.duration || 0,
    title: ep.title,
    podcastTitle: state.podcast?.title || "",
    savedAt: new Date().toISOString(),
  };
  setJson(STORAGE_KEYS.progress, progress);
}

function renderSubscriptions() {
  const subscriptions = getSubscriptions();
  els.subscriptionCount.textContent = subscriptions.length;
  els.subscriptions.innerHTML = "";
  if (!subscriptions.length) {
    els.subscriptions.innerHTML = '<p class="muted">No saved subscriptions yet.</p>';
    return;
  }
  subscriptions.forEach((sub) => {
    const btn = document.createElement("button");
    btn.className = "subscription-chip";
    if (els.feedUrl.value === sub.feedUrl) btn.classList.add("active");
    btn.textContent = sub.title || sub.feedUrl;
    btn.addEventListener("click", async () => {
      els.feedUrl.value = sub.feedUrl;
      await loadFeed(sub.feedUrl);
    });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const filtered = subscriptions.filter((item) => item.feedUrl !== sub.feedUrl);
      saveSubscriptions(filtered);
      showStatus(`Removed subscription: ${sub.title || sub.feedUrl}`, true);
    });
    els.subscriptions.appendChild(btn);
  });
}

function renderDownloads() {
  els.downloadCount.textContent = state.downloads.length;
  els.downloadsList.innerHTML = "";
  if (!state.downloads.length) {
    els.downloadsList.innerHTML = '<p class="muted">No downloads stored on the Pi yet.</p>';
    return;
  }

  state.downloads.forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "download-item";
    wrap.innerHTML = `
      <strong>${escapeHtml(item.episode_title)}</strong>
      <div class="meta">${escapeHtml(item.podcast_title || "Podcast")} • ${Math.round((item.file_size || 0) / (1024 * 1024) * 10) / 10} MB</div>
      <div class="download-actions">
        <button class="tiny play-local-btn">Play local</button>
        <button class="tiny cache-local-btn">Cache on phone</button>
        <button class="tiny danger remove-local-btn">Delete</button>
      </div>
    `;
    wrap.querySelector(".play-local-btn").addEventListener("click", () => {
      playDownloadedItem(item);
    });
    wrap.querySelector(".cache-local-btn").addEventListener("click", async () => {
      await cacheUrlOffline(item.download_url);
    });
    wrap.querySelector(".remove-local-btn").addEventListener("click", async () => {
      await deleteDownload(item.id);
    });
    els.downloadsList.appendChild(wrap);
  });
}

function renderEpisodes() {
  els.episodeCount.textContent = state.filteredEpisodes.length;
  els.episodeList.innerHTML = "";
  if (!state.filteredEpisodes.length) {
    els.episodeList.innerHTML = '<p class="muted">No episodes match your search.</p>';
    return;
  }

  state.filteredEpisodes.forEach((episode) => {
    const item = document.createElement("button");
    item.className = "episode-item";
    if (state.selectedEpisode && state.selectedEpisode.id === episode.id) item.classList.add("active");
    const saved = getProgressMap()[episode.id]?.currentTime || 0;
    item.innerHTML = `
      <strong>${escapeHtml(episode.title)}</strong>
      <div class="desc">${escapeHtml((episode.description || "No description available.").slice(0, 180))}</div>
      <div class="meta">${escapeHtml(episode.pub_date || "")}${saved ? ` • Resume at ${formatTime(saved)}` : ""}${episode.downloaded ? " • Downloaded" : ""}</div>
    `;
    item.addEventListener("click", () => selectEpisode(episode));
    els.episodeList.appendChild(item);
  });
}

function applyEpisodeSearch() {
  const query = els.episodeSearch.value.trim().toLowerCase();
  if (!query) {
    state.filteredEpisodes = [...state.episodes];
  } else {
    state.filteredEpisodes = state.episodes.filter((episode) => {
      return episode.title.toLowerCase().includes(query) || (episode.description || "").toLowerCase().includes(query);
    });
  }
  renderEpisodes();
}

function updateHero() {
  const ep = state.selectedEpisode;
  const podcast = state.podcast;
  els.episodeTitle.textContent = ep?.title || "Choose an episode";
  els.podcastTitle.textContent = podcast?.title || "Load a feed to begin";
  els.episodeDescription.textContent = ep?.description || podcast?.description || "";
  els.episodeMeta.textContent = ep ? [podcast?.title, ep.pub_date, ep.duration, ep.downloaded ? "Downloaded" : "Streaming"].filter(Boolean).join(" • ") : "No episode selected";
  const img = ep?.image || podcast?.image || "";
  if (img) {
    els.podcastArt.src = img;
    els.podcastArt.classList.remove("hidden");
    els.heroArtFallback.classList.add("hidden");
  } else {
    els.podcastArt.removeAttribute("src");
    els.podcastArt.classList.add("hidden");
    els.heroArtFallback.classList.remove("hidden");
  }
}

function applyMediaSession() {
  const ep = state.selectedEpisode;
  if (!("mediaSession" in navigator) || !ep) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ep.title,
    artist: state.podcast?.title || "Podcast",
    album: state.podcast?.title || "Podcast",
    artwork: ep.image ? [{ src: ep.image, sizes: "512x512", type: "image/png" }] : [],
  });
  navigator.mediaSession.setActionHandler("play", () => els.audioPlayer.play());
  navigator.mediaSession.setActionHandler("pause", () => els.audioPlayer.pause());
  navigator.mediaSession.setActionHandler("seekbackward", () => { els.audioPlayer.currentTime = Math.max(0, els.audioPlayer.currentTime - 15); });
  navigator.mediaSession.setActionHandler("seekforward", () => { els.audioPlayer.currentTime = Math.min(els.audioPlayer.duration || Infinity, els.audioPlayer.currentTime + 30); });
}

function selectEpisode(episode) {
  state.selectedEpisode = episode;
  updateHero();
  renderEpisodes();
  applyMediaSession();

  const src = episode.download_url || episode.audio_url || "";
  if (!src) {
    els.audioPlayer.removeAttribute("src");
    els.audioPlayer.load();
    els.playBtn.disabled = true;
    setPlayButtonState(false);
    els.downloadBtn.disabled = true;
    els.offlineBtn.disabled = true;
    showStatus("This episode does not include a playable audio URL in the feed.");
    return;
  }

  clearStatus();
  els.playBtn.disabled = false;
  setPlayButtonState(false);
  els.downloadBtn.disabled = !episode.audio_url;
  els.offlineBtn.disabled = !episode.download_url;
  els.audioPlayer.src = src;
  els.audioPlayer.load();

  const saved = getProgressMap()[episode.id]?.currentTime || 0;
  els.audioPlayer.addEventListener("loadedmetadata", () => {
    els.seekBar.max = Math.max(1, Math.floor(els.audioPlayer.duration || 1));
    els.duration.textContent = formatTime(els.audioPlayer.duration || 0);
    if (saved > 0 && saved < (els.audioPlayer.duration || Infinity)) {
      els.audioPlayer.currentTime = saved;
      els.seekBar.value = String(Math.floor(saved));
      els.currentTime.textContent = formatTime(saved);
    } else {
      els.seekBar.value = "0";
      els.currentTime.textContent = "0:00";
    }
  }, { once: true });
}

function playDownloadedItem(item) {
  const pseudoEpisode = {
    id: item.episode_id || `download-${item.id}`,
    title: item.episode_title,
    description: "Downloaded episode stored on the Raspberry Pi.",
    pub_date: "",
    duration: "",
    image: state.selectedEpisode?.image || state.podcast?.image || "",
    audio_url: item.audio_url,
    download_url: item.download_url,
    downloaded: true,
  };
  selectEpisode(pseudoEpisode);
}

async function fetchDownloads() {
  try {
    const response = await fetch("/api/downloads");
    const data = await response.json();
    state.downloads = data.items || [];
    renderDownloads();
  } catch {
    state.downloads = [];
    renderDownloads();
  }
}

async function loadFeed(url) {
  const targetUrl = (url || els.feedUrl.value || "").trim();
  if (!targetUrl) {
    showStatus("Please enter a feed URL.");
    return;
  }

  els.loadFeedBtn.disabled = true;
  els.refreshBtn.disabled = true;
  showStatus("Loading feed...");

  try {
    const response = await fetch(`/api/feed?url=${encodeURIComponent(targetUrl)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load feed.");
    state.podcast = data;
    state.episodes = data.items || [];
    state.filteredEpisodes = [...state.episodes];
    state.selectedEpisode = state.episodes.find((item) => item.download_url || item.audio_url) || state.episodes[0] || null;
    localStorage.setItem(STORAGE_KEYS.lastFeed, targetUrl);
    els.feedUrl.value = targetUrl;
    clearStatus();
    renderSubscriptions();
    updateHero();
    renderEpisodes();
    if (state.selectedEpisode) selectEpisode(state.selectedEpisode);
    await fetchDownloads();
  } catch (error) {
    showStatus(error.message || "Could not load feed.");
  } finally {
    els.loadFeedBtn.disabled = false;
    els.refreshBtn.disabled = false;
  }
}

function saveCurrentSubscription() {
  if (!state.podcast || !state.podcast.feed_url) {
    showStatus("Load a podcast before saving a subscription.");
    return;
  }
  const subscriptions = getSubscriptions();
  const exists = subscriptions.some((item) => item.feedUrl === state.podcast.feed_url);
  if (exists) {
    showStatus("This subscription is already saved.", true);
    return;
  }
  subscriptions.unshift({
    title: state.podcast.title,
    feedUrl: state.podcast.feed_url,
    image: state.podcast.image || "",
    savedAt: new Date().toISOString(),
  });
  saveSubscriptions(subscriptions.slice(0, 40));
  showStatus(`Saved subscription: ${state.podcast.title}`, true);
}

function togglePlay() {
  if (!els.audioPlayer.src) return;
  if (els.audioPlayer.paused) {
    els.audioPlayer.play().catch(() => showStatus("Playback could not start. Try tapping play again."));
  } else {
    els.audioPlayer.pause();
  }
}

function setPlaybackRate(rate) {
  els.audioPlayer.playbackRate = rate;
  els.rateButtons.forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.rate) === rate));
}

async function downloadCurrentEpisode() {
  const ep = state.selectedEpisode;
  if (!ep || !ep.audio_url) {
    showStatus("Select a streamable episode first.");
    return;
  }
  els.downloadBtn.disabled = true;
  showStatus("Downloading episode to the Raspberry Pi...");
  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode_id: ep.id,
        episode_title: ep.title,
        podcast_title: state.podcast?.title || "Podcast",
        audio_url: ep.audio_url,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Download failed.");
    ep.downloaded = true;
    ep.download_url = data.item.download_url;
    selectEpisode(ep);
    await fetchDownloads();
    showStatus("Episode downloaded to the Raspberry Pi.", true);
  } catch (error) {
    showStatus(error.message || "Download failed.");
  } finally {
    els.downloadBtn.disabled = false;
  }
}

async function deleteDownload(id) {
  try {
    const response = await fetch(`/api/download/${id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Delete failed.");
    await fetchDownloads();
    if (state.selectedEpisode?.download_url && !state.downloads.some((item) => item.id === id)) {
      state.selectedEpisode.download_url = "";
      state.selectedEpisode.downloaded = false;
      selectEpisode(state.selectedEpisode);
    }
    showStatus("Deleted download from the Raspberry Pi.", true);
  } catch (error) {
    showStatus(error.message || "Delete failed.");
  }
}

async function cacheUrlOffline(url) {
  if (!url) {
    showStatus("Download the episode to the Pi first.");
    return;
  }
  if (!("serviceWorker" in navigator)) {
    showStatus("Offline caching is not available in this browser.");
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) {
    showStatus("Service worker is not ready yet. Reload once and try again.");
    return;
  }
  showStatus("Caching downloaded episode on this phone...");
  registration.active.postMessage({ type: "CACHE_URLS", urls: [url] });
}

function bindEvents() {
  els.loadFeedBtn.addEventListener("click", () => loadFeed());
  els.refreshBtn.addEventListener("click", () => loadFeed());
  els.saveSubscriptionBtn.addEventListener("click", saveCurrentSubscription);
  els.episodeSearch.addEventListener("input", applyEpisodeSearch);
  els.playBtn.addEventListener("click", togglePlay);
  els.backBtn.addEventListener("click", () => { els.audioPlayer.currentTime = Math.max(0, els.audioPlayer.currentTime - 15); });
  els.forwardBtn.addEventListener("click", () => { els.audioPlayer.currentTime = Math.min(els.audioPlayer.duration || Infinity, els.audioPlayer.currentTime + 30); });
  els.downloadBtn.addEventListener("click", downloadCurrentEpisode);
  els.offlineBtn.addEventListener("click", async () => {
    await cacheUrlOffline(state.selectedEpisode?.download_url || "");
  });

  els.seekBar.addEventListener("input", () => {
    els.audioPlayer.currentTime = Number(els.seekBar.value || 0);
    els.currentTime.textContent = formatTime(els.audioPlayer.currentTime || 0);
  });

  els.audioPlayer.addEventListener("timeupdate", () => {
    els.seekBar.value = String(Math.floor(els.audioPlayer.currentTime || 0));
    els.currentTime.textContent = formatTime(els.audioPlayer.currentTime || 0);
    saveProgressForCurrentEpisode();
    if (navigator.mediaSession?.setPositionState && Number.isFinite(els.audioPlayer.duration)) {
      navigator.mediaSession.setPositionState({
        duration: els.audioPlayer.duration,
        playbackRate: els.audioPlayer.playbackRate,
        position: els.audioPlayer.currentTime,
      });
    }
  });

  els.audioPlayer.addEventListener("play", () => {
    setPlayButtonState(true);
  });

  els.audioPlayer.addEventListener("pause", () => {
    setPlayButtonState(false);
  });

  els.audioPlayer.addEventListener("ended", () => {
    setPlayButtonState(false);
  });

  els.rateButtons.forEach((btn) => {
    btn.addEventListener("click", () => setPlaybackRate(Number(btn.dataset.rate)));
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installBtn.classList.remove("hidden");
  });

  els.installBtn.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    els.installBtn.classList.add("hidden");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/static/service-worker.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "CACHE_DONE") {
        showStatus(`Cached ${data.count || 0} item(s) on this phone for offline playback.`, true);
      } else if (data.type === "CACHE_ERROR") {
        showStatus(data.message || "Offline cache failed.");
      }
    });
  }
}

function init() {
  bindEvents();
  renderSubscriptions();
  fetchDownloads();
  const lastFeed = localStorage.getItem(STORAGE_KEYS.lastFeed) || SAMPLE_FEED;
  els.feedUrl.value = lastFeed;
  loadFeed(lastFeed);
}

init();
