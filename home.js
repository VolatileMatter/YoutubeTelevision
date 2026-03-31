/**
 * RetroTube TV — home.js
 *
 * Channel model:
 *   Each channel has one or more playlists. When a channel is active, the app
 *   picks a random playlist from that channel's pool and plays the next
 *   sequential episode (tracked via per-playlist cookie). "All Channels"
 *   picks randomly from every playlist across every channel.
 *
 * Shuffle mode:
 *   When enabled, cookie tracking is suspended. Instead of consuming the saved
 *   index, a random index (0–499, safely beyond most playlist lengths) is
 *   chosen each time. Progress cookies are left untouched so normal viewing
 *   resumes from where it left off when shuffle is turned off.
 *
 * To add a channel or playlist: edit channels.json only.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const App = {
  config:          null,
  channels:        [],
  filler:          null,
  activeChannelId: 'all',
  shuffleMode:     false,
  player:          null,
  playerReady:     false,
  current: {
    channelId:  null,
    playlistId: null,
    isFiller:   false,
  },
  pending: null, // { channelId, playlistId, index } queued after filler
};

// ─── Cookie helpers ───────────────────────────────────────────────────────────
const Cookies = {
  PREFIX: 'rtv_',
  DAYS:   365,

  _key(id) { return this.PREFIX + id; },

  get(playlistId) {
    const name = this._key(playlistId) + '=';
    for (const part of decodeURIComponent(document.cookie).split(';')) {
      const p = part.trim();
      if (p.startsWith(name)) return parseInt(p.slice(name.length), 10) || 0;
    }
    return 0;
  },

  set(playlistId, index) {
    const d = new Date();
    d.setTime(d.getTime() + this.DAYS * 86400000);
    document.cookie =
      `${this._key(playlistId)}=${index};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },

  // Read current index, then advance it. Returns the index to play NOW.
  consume(playlistId) {
    const index = this.get(playlistId);
    this.set(playlistId, index + 1);
    return index;
  },
};

// ─── Utility ─────────────────────────────────────────────────────────────────
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomIndex() {
  // Random position 0–499. YouTube will clamp to playlist length automatically.
  return Math.floor(Math.random() * 500);
}

function shouldPlayFiller() {
  const fillerPlaylists = App.filler?.playlists ?? [];
  if (fillerPlaylists.length === 0) return false;
  // Don't show filler if the filler playlist ID isn't set yet
  if (fillerPlaylists.every(p => p.youtubePlaylistId.startsWith('YOUR_'))) return false;
  return Math.random() < (App.config.fillerChance ?? 0.4);
}

// ─── Channel / playlist helpers ───────────────────────────────────────────────
function getChannelById(id) {
  return App.channels.find(c => c.id === id) ?? null;
}

/**
 * Returns array of { channelId, playlist } for the active channel selection.
 * 'all' → every playlist from every channel.
 */
function getActivePlaylists() {
  if (App.activeChannelId === 'all') {
    return App.channels.flatMap(ch =>
      ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }))
    );
  }
  const ch = getChannelById(App.activeChannelId);
  if (!ch) return [];
  return ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }));
}

function findPlaylist(playlistId) {
  for (const ch of App.channels) {
    const found = ch.playlists.find(p => p.id === playlistId);
    if (found) return found;
  }
  if (App.filler) {
    const found = App.filler.playlists.find(p => p.id === playlistId);
    if (found) return found;
  }
  return null;
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  App.player = new YT.Player('yt-player', {
    playerVars: {
      autoplay:       1,
      controls:       1,
      modestbranding: 1,
      rel:            0,
      iv_load_policy: 3,
    },
    events: {
      onReady:       onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
    },
  });
};

function onPlayerReady() {
  App.playerReady = true;
  playNext();
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    handleVideoEnded();
  }
}

function onPlayerError(event) {
  console.warn('YouTube player error:', event.data);
  // Error codes 100, 101, 150 = video unavailable/not embeddable → skip it
  if (App.current.isFiller) {
    loadPendingEpisode();
  } else {
    playNext();
  }
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function playNext() {
  const options = getActivePlaylists();
  if (options.length === 0) {
    showStatic('NO SIGNAL');
    return;
  }

  const { channelId, playlist } = pickRandom(options);

  // In shuffle mode, pick a random index without touching the cookie.
  // In normal mode, consume the cookie (read + increment).
  const index = App.shuffleMode
    ? randomIndex()
    : Cookies.consume(playlist.id);

  const episode = { channelId, playlistId: playlist.id, index };

  updateNowPlaying(channelId, playlist.label, index);
  setAccentColor(channelId);

  if (shouldPlayFiller()) {
    App.pending = episode;
    playFiller();
  } else {
    loadEpisode(episode);
  }
}

function loadEpisode({ channelId, playlistId, index }) {
  App.current = { channelId, playlistId, isFiller: false };
  hideStatic();

  const playlist = findPlaylist(playlistId);
  if (!playlist) { playNext(); return; }

  App.player.loadPlaylist({
    list:         playlist.youtubePlaylistId,
    listType:     'playlist',
    index:        index,
    startSeconds: 0,
  });
}

function playFiller() {
  const fillerPlaylists = App.filler?.playlists ?? [];
  if (fillerPlaylists.length === 0) { loadPendingEpisode(); return; }

  const pl = pickRandom(fillerPlaylists);
  // Filler always uses a random index — we don't track filler progress
  const index = randomIndex();

  App.current = { channelId: 'filler', playlistId: pl.id, isFiller: true };
  updateNowPlaying(null, 'Filler', index);

  App.player.loadPlaylist({
    list:         pl.youtubePlaylistId,
    listType:     'playlist',
    index:        index,
    startSeconds: 0,
  });
}

function handleVideoEnded() {
  if (App.current.isFiller) {
    loadPendingEpisode();
  } else {
    playNext();
  }
}

function loadPendingEpisode() {
  const ep = App.pending;
  App.pending = null;
  if (ep) loadEpisode(ep);
  else playNext();
}

// ─── Channel switching ────────────────────────────────────────────────────────
function switchChannel(channelId) {
  if (channelId === App.activeChannelId) return;
  App.activeChannelId = channelId;

  document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === channelId);
  });

  setAccentColor(channelId === 'all' ? null : channelId);
  triggerCRTFlicker();
  if (App.playerReady) playNext();
}

// ─── Shuffle mode ─────────────────────────────────────────────────────────────
function setShuffleMode(on) {
  App.shuffleMode = on;
  document.body.classList.toggle('shuffle-on', on);

  const btn = document.getElementById('shuffle-toggle');
  btn.classList.toggle('on', on);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function updateNowPlaying(channelId, playlistLabel, index) {
  const ch = channelId ? getChannelById(channelId) : null;
  document.getElementById('np-channel').textContent =
    ch ? `${ch.icon}  ${ch.label}` : '📺  RetroTube TV';
  document.getElementById('np-detail').textContent =
    `${playlistLabel}  —  ${App.shuffleMode ? 'SHUFFLE' : `EP. ${index + 1}`}`;
}

function setAccentColor(channelId) {
  const ch = channelId ? getChannelById(channelId) : null;
  document.documentElement.style.setProperty('--accent', ch?.accentColor ?? '#c8f0c0');
}

function showStatic(msg = 'NO SIGNAL') {
  document.getElementById('static-screen').classList.remove('hidden');
  document.getElementById('static-message').textContent = msg;
}

function hideStatic() {
  document.getElementById('static-screen').classList.add('hidden');
}

function triggerCRTFlicker() {
  const f = document.querySelector('.crt-flicker');
  if (!f) return;
  f.classList.remove('active');
  void f.offsetWidth; // force reflow
  f.classList.add('active');
  f.addEventListener('animationend', () => f.classList.remove('active'), { once: true });
}

function setCRTIntensity(value) {
  document.documentElement.style.setProperty('--crt-intensity', value);
}

function toggleCRT(on) {
  document.getElementById('crt-overlay').style.opacity = on ? '1' : '0';
  document.getElementById('crt-toggle').classList.toggle('on', on);
}

function startClock() {
  function tick() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('clock').textContent = `${h}:${m}`;
  }
  tick();
  setInterval(tick, 10000);
}

// ─── Build sidebar ────────────────────────────────────────────────────────────
function buildChannelList() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  // Collect unique groups in the order they appear
  const groups = [];
  const seen = new Set();
  for (const ch of App.channels) {
    const g = ch.group || 'Channels';
    if (!seen.has(g)) { groups.push(g); seen.add(g); }
  }

  // "All Channels" at the top, outside any group
  list.appendChild(makeChannelBtn('all', '📺', 'All Channels', true));

  for (const group of groups) {
    const label = document.createElement('div');
    label.className = 'ch-group-label';
    label.textContent = group;
    list.appendChild(label);

    for (const ch of App.channels.filter(c => (c.group || 'Channels') === group)) {
      list.appendChild(makeChannelBtn(ch.id, ch.icon, ch.label, false));
    }
  }
}

function makeChannelBtn(id, icon, label, active) {
  const btn = document.createElement('button');
  btn.className = 'ch-btn' + (active ? ' active' : '');
  btn.dataset.id = id;
  btn.innerHTML =
    `<span class="ch-icon">${icon}</span>` +
    `<span>${label}</span>` +
    `<span class="shuffle-badge">RND</span>`;
  btn.addEventListener('click', () => switchChannel(id));
  return btn;
}

// ─── Wire panel controls ──────────────────────────────────────────────────────
function wireControls() {
  // CRT intensity
  const crtSlider = document.getElementById('crt-intensity-slider');
  const initialIntensity = App.config.crtIntensity ?? 0.4;
  crtSlider.value = initialIntensity * 100;
  setCRTIntensity(initialIntensity);

  crtSlider.addEventListener('input', () => {
    const v = crtSlider.value / 100;
    setCRTIntensity(v);
    if (v === 0) document.getElementById('crt-toggle').classList.remove('on');
    else         document.getElementById('crt-toggle').classList.add('on');
  });

  // CRT toggle
  let crtOn = App.config.crtEnabled !== false;
  const crtToggle = document.getElementById('crt-toggle');
  if (crtOn) crtToggle.classList.add('on');
  crtToggle.addEventListener('click', () => {
    crtOn = !crtOn;
    toggleCRT(crtOn);
  });

  // Shuffle toggle
  const shuffleToggle = document.getElementById('shuffle-toggle');
  shuffleToggle.addEventListener('click', () => {
    setShuffleMode(!App.shuffleMode);
  });

  // Skip
  document.getElementById('btn-skip').addEventListener('click', () => {
    triggerCRTFlicker();
    if (App.playerReady) playNext();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  showStatic('LOADING…');

  let data;
  try {
    const res = await fetch('channels.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    showStatic('ERROR: channels.json');
    console.error(e);
    return;
  }

  App.config   = data.config   || {};
  App.channels = data.channels || [];
  App.filler   = data.filler   || null;

  document.title = App.config.siteName || 'RetroTube TV';
  document.getElementById('site-title').textContent = App.config.siteName || 'RetroTube TV';

  buildChannelList();
  wireControls();
  startClock();

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

document.addEventListener('DOMContentLoaded', init);
