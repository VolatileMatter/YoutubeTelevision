/**
 * RetroTube TV — home.js
 *
 * How it works:
 *  - Fetches channels.json on load
 *  - Builds the channel list in the sidebar
 *  - On "All Channels" (default), picks a random playlist from any channel each time
 *  - On a specific channel, picks a random playlist only from that channel
 *  - Within a chosen playlist, plays episodes sequentially using a per-playlist
 *    index stored in a browser cookie — so progress survives page reloads
 *  - After each episode, maybe inserts one filler video (configurable chance)
 *  - CRT overlay intensity is controlled by a real CSS variable slider
 *
 * To add channels or playlists: edit channels.json only.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const App = {
  config:          null,   // from channels.json
  channels:        [],     // from channels.json
  filler:          null,   // from channels.json
  activeChannelId: 'all',  // 'all' or a channel id string
  player:          null,   // YT.Player instance
  playerReady:     false,
  // What's currently loaded:
  current: {
    channelId:  null,
    playlistId: null,
    isFiller:   false,
  },
  // After filler finishes, load this episode:
  pending: null,  // { channelId, playlistId, index }
};

// ─── Cookie helpers ───────────────────────────────────────────────────────────
const Cookies = {
  PREFIX:   'rtv_',
  DAYS:     365,

  _key(playlistId) { return this.PREFIX + playlistId; },

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
    document.cookie = `${this._key(playlistId)}=${index};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },

  // Returns the current index to play, then increments it in the cookie.
  consume(playlistId) {
    const index = this.get(playlistId);
    this.set(playlistId, index + 1);
    return index;
  },

  reset(playlistId) { this.set(playlistId, 0); },
};

// ─── Utility ─────────────────────────────────────────────────────────────────
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shouldPlayFiller() {
  return Math.random() < (App.config.fillerChance ?? 0.4);
}

/**
 * Collect all playlists visible under the current active channel.
 * 'all' → every playlist from every channel.
 */
function getActivePlaylists() {
  if (App.activeChannelId === 'all') {
    return App.channels.flatMap(ch =>
      ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }))
    );
  }
  const ch = App.channels.find(c => c.id === App.activeChannelId);
  if (!ch) return [];
  return ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }));
}

function getChannelById(id) {
  return App.channels.find(c => c.id === id) || null;
}

function getFillerPlaylists() {
  return App.filler?.playlists ?? [];
}

// ─── YouTube IFrame API bootstrap ────────────────────────────────────────────
// The API calls this globally once it's ready.
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
  // YT.PlayerState.ENDED === 0
  if (event.data === YT.PlayerState.ENDED) {
    handleVideoEnded();
  }
}

function onPlayerError(event) {
  // Error codes: 2 = bad param, 5 = HTML5 error, 100 = not found/private,
  // 101/150 = embedding not allowed.
  console.warn('YouTube player error:', event.data);

  if (App.current.isFiller) {
    // Filler errored — just move to the pending episode directly
    loadPendingEpisode();
  } else {
    // Episode errored (likely video removed/private) — skip it and try next
    playNext();
  }
}

// ─── Playback logic ───────────────────────────────────────────────────────────
/**
 * Pick a random playlist from active channels, get the next sequential
 * episode index from its cookie, and play it.
 * If fillerChance triggers, play a filler video first and queue the episode.
 */
function playNext() {
  const options = getActivePlaylists();
  if (options.length === 0) {
    showStatic('NO SIGNAL');
    return;
  }

  const { channelId, playlist } = pickRandom(options);
  const index = Cookies.consume(playlist.id);
  const episode = { channelId, playlistId: playlist.id, index };

  updateNowPlaying(channelId, playlist.label, index);
  setAccentColor(channelId);

  const fillerPlaylists = getFillerPlaylists();
  if (fillerPlaylists.length > 0 && shouldPlayFiller()) {
    // Stash the real episode, play filler first
    App.pending = episode;
    playFiller(episode);
  } else {
    loadEpisode(episode);
  }
}

/**
 * Load a specific episode: play playlist starting at the given index.
 * YouTube's LIST + INDEX param plays playlist from that position.
 */
function loadEpisode({ channelId, playlistId, index }) {
  App.current = { channelId, playlistId, isFiller: false };
  hideStatic();

  const playlist = findPlaylist(playlistId);
  if (!playlist) { playNext(); return; }

  App.player.loadPlaylist({
    list:       playlist.youtubePlaylistId,
    listType:   'playlist',
    index:      index,
    startSeconds: 0,
  });
}

function playFiller(pendingEpisode) {
  App.pending = pendingEpisode;
  App.current = { channelId: 'filler', playlistId: null, isFiller: true };

  const fillerPlaylists = getFillerPlaylists();
  const pl = pickRandom(fillerPlaylists);
  const index = Cookies.consume(pl.id);

  App.current.playlistId = pl.id;
  updateNowPlaying(null, 'Filler', index);

  App.player.loadPlaylist({
    list:     pl.youtubePlaylistId,
    listType: 'playlist',
    index:    index,
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
  if (App.pending) {
    const ep = App.pending;
    App.pending = null;
    loadEpisode(ep);
  } else {
    playNext();
  }
}

function findPlaylist(playlistId) {
  for (const ch of App.channels) {
    const found = ch.playlists.find(p => p.id === playlistId);
    if (found) return found;
  }
  // Check filler playlists too
  if (App.filler) {
    const found = App.filler.playlists.find(p => p.id === playlistId);
    if (found) return found;
  }
  return null;
}

// ─── Channel switching ────────────────────────────────────────────────────────
function switchChannel(channelId) {
  if (channelId === App.activeChannelId) return;
  App.activeChannelId = channelId;

  // Update sidebar active state
  document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === channelId);
  });

  triggerCRTFlicker();

  if (App.playerReady) {
    playNext();
  }
}

// ─── UI: Now Playing ─────────────────────────────────────────────────────────
function updateNowPlaying(channelId, playlistLabel, index) {
  const ch = channelId ? getChannelById(channelId) : null;
  document.getElementById('np-channel').textContent =
    ch ? `${ch.icon}  ${ch.label}` : '📺  RetroTube TV';
  document.getElementById('np-detail').textContent =
    `${playlistLabel}  —  EP. ${index + 1}`;
}

function setAccentColor(channelId) {
  const ch = getChannelById(channelId);
  const color = ch?.accentColor ?? '#c8f0c0';
  document.documentElement.style.setProperty('--accent', color);
}

// ─── UI: Static screen ───────────────────────────────────────────────────────
function showStatic(msg = 'NO SIGNAL') {
  const el = document.getElementById('static-screen');
  el.classList.remove('hidden');
  document.getElementById('static-message').textContent = msg;
}

function hideStatic() {
  document.getElementById('static-screen').classList.add('hidden');
}

// ─── CRT ─────────────────────────────────────────────────────────────────────
function triggerCRTFlicker() {
  const f = document.querySelector('.crt-flicker');
  if (!f) return;
  f.classList.remove('active');
  // Force reflow so the animation restarts
  void f.offsetWidth;
  f.classList.add('active');
  f.addEventListener('animationend', () => f.classList.remove('active'), { once: true });
}

function setCRTIntensity(value) {
  // value: 0–1
  document.documentElement.style.setProperty('--crt-intensity', value);
}

function toggleCRT(on) {
  const overlay = document.getElementById('crt-overlay');
  overlay.style.opacity = on ? '1' : '0';
  const btn = document.getElementById('crt-toggle');
  btn.classList.toggle('on', on);
}

// ─── Clock ───────────────────────────────────────────────────────────────────
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

// ─── Build sidebar channels ───────────────────────────────────────────────────
function buildChannelList() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  // "All Channels" button
  const allBtn = document.createElement('button');
  allBtn.className = 'ch-btn active';
  allBtn.dataset.id = 'all';
  allBtn.innerHTML = `<span class="ch-icon">📺</span><span>All Channels</span>`;
  allBtn.addEventListener('click', () => switchChannel('all'));
  list.appendChild(allBtn);

  // One button per channel
  for (const ch of App.channels) {
    const btn = document.createElement('button');
    btn.className = 'ch-btn';
    btn.dataset.id = ch.id;
    btn.innerHTML = `<span class="ch-icon">${ch.icon}</span><span>${ch.label}</span>`;
    btn.addEventListener('click', () => switchChannel(ch.id));
    list.appendChild(btn);
  }
}

// ─── Panel controls wiring ────────────────────────────────────────────────────
function wireControls() {
  // CRT intensity slider
  const crtSlider = document.getElementById('crt-intensity-slider');
  crtSlider.value = (App.config.crtIntensity ?? 0.4) * 100;
  setCRTIntensity(App.config.crtIntensity ?? 0.4);

  crtSlider.addEventListener('input', () => {
    const v = crtSlider.value / 100;
    setCRTIntensity(v);
    // Keep the toggle in sync — if you drag to 0, mark it off
    const btn = document.getElementById('crt-toggle');
    if (v === 0) btn.classList.remove('on');
    else btn.classList.add('on');
  });

  // CRT on/off toggle
  const crtToggle = document.getElementById('crt-toggle');
  let crtOn = App.config.crtEnabled !== false;
  if (crtOn) crtToggle.classList.add('on');
  crtToggle.addEventListener('click', () => {
    crtOn = !crtOn;
    toggleCRT(crtOn);
  });

  // Skip button
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
    data = await res.json();
  } catch (e) {
    showStatic('ERROR: could not load channels.json');
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

  // Inject the YouTube IFrame API script — onYouTubeIframeAPIReady fires when done
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

document.addEventListener('DOMContentLoaded', init);
