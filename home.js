/**
 * RetroTube TV — home.js
 *
 * Channel model:
 *   - Each channel has its own optional filler[] array. If a channel has filler,
 *     one random video from one random filler playlist plays between episodes.
 *   - If a channel has no filler, globalFiller is used as fallback (if set).
 *   - fillerChance in config (0–1) controls how often filler plays.
 *
 * Playlist toggles:
 *   - The right panel shows checkboxes for each playlist in the active channel.
 *   - Disabled playlists are skipped when picking the next episode.
 *   - Disabled state is stored in sessionStorage (resets on tab close).
 *   - At least one playlist must remain enabled.
 *
 * Collapsible panels:
 *   - Sidebar and right panel can each be collapsed via floating buttons.
 *   - State stored in sessionStorage.
 *
 * Shuffle mode:
 *   - Bypasses cookie tracking; picks random indices. Cookies untouched.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const App = {
  config:          null,
  channels:        [],
  globalFiller:    null,
  activeChannelId: 'all',
  shuffleMode:     false,
  player:          null,
  playerReady:     false,
  current: {
    channelId:  null,
    playlistId: null,
    isFiller:   false,
  },
  pending:    null,   // episode queued while filler plays
  watchLog:   {},     // { [playlistId]: { title, episode } }
  disabled:   new Set(), // disabled playlist IDs this session
};

// ─── Cookies ─────────────────────────────────────────────────────────────────
const Cookies = {
  PREFIX: 'rtv_',
  DAYS:   365,
  _key(id) { return this.PREFIX + id; },
  get(playlistId) {
    const name = this._key(playlistId) + '=';
    for (const p of decodeURIComponent(document.cookie).split(';')) {
      const t = p.trim();
      if (t.startsWith(name)) return parseInt(t.slice(name.length), 10) || 0;
    }
    return 0;
  },
  set(playlistId, index) {
    const d = new Date();
    d.setTime(d.getTime() + this.DAYS * 86400000);
    document.cookie = `${this._key(playlistId)}=${index};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },
  consume(playlistId) {
    const i = this.get(playlistId);
    this.set(playlistId, i + 1);
    return i;
  },
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomIndex()   { return Math.floor(Math.random() * 500); }

function shouldPlayFiller(channel) {
  const fillerList = getFillerForChannel(channel);
  if (!fillerList.length) return false;
  // Skip if all filler playlist IDs are still placeholders
  if (fillerList.every(p => p.youtubePlaylistId.startsWith('PLACEHOLDER'))) return false;
  return Math.random() < (App.config.fillerChance ?? 0.4);
}

function getFillerForChannel(channel) {
  if (channel?.filler?.length) return channel.filler;
  return App.globalFiller?.playlists ?? [];
}

// ─── Channel / playlist helpers ───────────────────────────────────────────────
function getChannelById(id) { return App.channels.find(c => c.id === id) ?? null; }

function getActivePlaylists() {
  // Returns enabled playlists only
  const all = App.activeChannelId === 'all'
    ? App.channels.flatMap(ch => ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl })))
    : (getChannelById(App.activeChannelId)?.playlists ?? [])
        .map(pl => ({ channelId: App.activeChannelId, playlist: pl }));
  return all.filter(({ playlist }) => !App.disabled.has(playlist.id));
}

function findPlaylistAnywhere(playlistId) {
  for (const ch of App.channels) {
    const f = ch.playlists.find(p => p.id === playlistId);
    if (f) return f;
    const ff = ch.filler?.find(p => p.id === playlistId);
    if (ff) return ff;
  }
  return App.globalFiller?.playlists.find(p => p.id === playlistId) ?? null;
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  App.player = new YT.Player('yt-player', {
    playerVars: { autoplay: 1, controls: 1, modestbranding: 1, rel: 0, iv_load_policy: 3 },
    events: {
      onReady:       () => { App.playerReady = true; playNext(); },
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
    },
  });
};

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED)   handleVideoEnded();
  if (event.data === YT.PlayerState.PLAYING) captureNowPlayingTitle();
}

function onPlayerError(event) {
  console.warn('YT error:', event.data);
  App.current.isFiller ? loadPendingEpisode() : playNext();
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function playNext() {
  const options = getActivePlaylists();
  if (!options.length) { showStatic('NO SIGNAL'); return; }

  const { channelId, playlist } = pickRandom(options);
  const index = App.shuffleMode ? randomIndex() : Cookies.consume(playlist.id);
  const episode = { channelId, playlistId: playlist.id, index };

  updateNowPlaying(channelId, playlist.label, index);
  setAccentColor(channelId);

  const channel = getChannelById(channelId);
  if (shouldPlayFiller(channel)) {
    App.pending = episode;
    playFiller(channel);
  } else {
    loadEpisode(episode);
  }
}

function loadEpisode({ channelId, playlistId, index }) {
  App.current = { channelId, playlistId, isFiller: false };
  hideStatic();
  const pl = findPlaylistAnywhere(playlistId);
  if (!pl) { playNext(); return; }
  App.player.loadPlaylist({ list: pl.youtubePlaylistId, listType: 'playlist', index, startSeconds: 0 });
}

function playFiller(channel) {
  const fillerList = getFillerForChannel(channel).filter(
    p => !p.youtubePlaylistId.startsWith('PLACEHOLDER')
  );
  if (!fillerList.length) { loadPendingEpisode(); return; }

  const pl    = pickRandom(fillerList);
  const index = randomIndex();
  App.current = { channelId: 'filler', playlistId: pl.id, isFiller: true };
  updateNowPlaying(null, pl.label, index);
  App.player.loadPlaylist({ list: pl.youtubePlaylistId, listType: 'playlist', index, startSeconds: 0 });
}

function handleVideoEnded() {
  App.current.isFiller ? loadPendingEpisode() : playNext();
}

function loadPendingEpisode() {
  const ep = App.pending; App.pending = null;
  ep ? loadEpisode(ep) : playNext();
}

// ─── Channel switching ────────────────────────────────────────────────────────
function switchChannel(channelId) {
  if (channelId === App.activeChannelId) return;
  App.activeChannelId = channelId;
  document.querySelectorAll('.ch-btn').forEach(b => b.classList.toggle('active', b.dataset.id === channelId));
  setAccentColor(channelId === 'all' ? null : channelId);
  triggerCRTFlicker();
  renderPlaylistToggles();
  renderWatchLog();
  if (App.playerReady) playNext();
}

// ─── Shuffle ──────────────────────────────────────────────────────────────────
function setShuffleMode(on) {
  App.shuffleMode = on;
  document.body.classList.toggle('shuffle-on', on);
  document.getElementById('shuffle-toggle').classList.toggle('on', on);
}

// ─── Playlist toggles ─────────────────────────────────────────────────────────
function renderPlaylistToggles() {
  const list = document.getElementById('playlist-toggle-list');
  list.innerHTML = '';

  // Determine which playlists to show
  let entries; // [{ channelId, playlist }]
  if (App.activeChannelId === 'all') {
    entries = App.channels.flatMap(ch =>
      ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }))
    );
  } else {
    const ch = getChannelById(App.activeChannelId);
    entries = (ch?.playlists ?? []).map(pl => ({ channelId: ch.id, playlist: pl }));
  }

  if (!entries.length) {
    list.innerHTML = '<div class="wl-empty">No playlists</div>';
    return;
  }

  // In "all" mode, group by channel
  const showChannelLabel = App.activeChannelId === 'all';
  let lastChannelId = null;

  for (const { channelId, playlist } of entries) {
    if (showChannelLabel && channelId !== lastChannelId) {
      const ch = getChannelById(channelId);
      const head = document.createElement('div');
      head.className = 'wl-channel-head';
      head.textContent = `${ch.icon} ${ch.label}`;
      list.appendChild(head);
      lastChannelId = channelId;
    }

    const enabled = !App.disabled.has(playlist.id);
    const ep      = Cookies.get(playlist.id);

    const row = document.createElement('div');
    row.className = 'pl-toggle-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pl-toggle-checkbox';
    checkbox.checked = enabled;
    checkbox.dataset.playlistId = playlist.id;
    checkbox.addEventListener('change', () => onPlaylistToggle(playlist.id, checkbox.checked, entries));

    const label = document.createElement('label');
    label.className = 'pl-toggle-label';
    label.textContent = playlist.label;
    label.addEventListener('click', () => { checkbox.click(); });

    const epEl = document.createElement('div');
    epEl.className = 'pl-toggle-ep';
    epEl.textContent = ep > 0 ? `${ep}` : '—';
    epEl.id = `pl-ep-${playlist.id}`;

    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(epEl);
    list.appendChild(row);
  }
}

function onPlaylistToggle(playlistId, enabled, allEntries) {
  if (!enabled) {
    // Don't allow disabling the last enabled playlist
    const enabledCount = allEntries.filter(({ playlist }) => !App.disabled.has(playlist.id)).length;
    if (enabledCount <= 1) {
      // Re-check the box
      const cb = document.querySelector(`[data-playlist-id="${playlistId}"]`);
      if (cb) cb.checked = true;
      return;
    }
    App.disabled.add(playlistId);
  } else {
    App.disabled.delete(playlistId);
  }
  // Persist to sessionStorage
  sessionStorage.setItem('rtv_disabled', JSON.stringify([...App.disabled]));
}

function loadDisabledState() {
  try {
    const saved = sessionStorage.getItem('rtv_disabled');
    if (saved) App.disabled = new Set(JSON.parse(saved));
  } catch {}
}

// ─── Watch Log ────────────────────────────────────────────────────────────────
function captureNowPlayingTitle() {
  if (App.current.isFiller) return;
  const { playlistId } = App.current;
  if (!playlistId) return;
  const data  = App.player.getVideoData?.();
  const title = data?.title ?? null;
  const ep    = Cookies.get(playlistId);
  App.watchLog[playlistId] = { title, episode: ep };
  renderWatchLog();
  // Also update the episode count in the playlist toggle list
  const epEl = document.getElementById(`pl-ep-${playlistId}`);
  if (epEl) epEl.textContent = ep > 0 ? `${ep}` : '—';
}

function renderWatchLog() {
  const container = document.getElementById('watch-log-list');
  if (!container) return;

  let sections;
  if (App.activeChannelId === 'all') {
    sections = App.channels.map(ch => ({ channel: ch, playlists: ch.playlists }));
  } else {
    const ch = getChannelById(App.activeChannelId);
    sections = ch ? [{ channel: ch, playlists: ch.playlists }] : [];
  }

  container.innerHTML = '';
  if (!sections.length) { container.innerHTML = '<div class="wl-empty">No data</div>'; return; }

  for (const { channel, playlists } of sections) {
    if (App.activeChannelId === 'all') {
      const head = document.createElement('div');
      head.className = 'wl-channel-head';
      head.textContent = `${channel.icon} ${channel.label}`;
      container.appendChild(head);
    }
    for (const pl of playlists) {
      const log   = App.watchLog[pl.id];
      const ep    = log ? log.episode : Cookies.get(pl.id);
      const title = log?.title ?? null;
      const isPlaying = pl.id === App.current.playlistId && !App.current.isFiller;

      const row = document.createElement('div');
      row.className = 'wl-row' + (isPlaying ? ' wl-row--active' : '');
      row.innerHTML = `
        <div class="wl-playlist-name">
          ${isPlaying ? '<span class="wl-playing-dot"></span>' : ''}
          ${pl.label}
        </div>
        <div class="wl-ep-num">EP&nbsp;${ep > 0 ? ep : '—'}</div>
        ${title
          ? `<div class="wl-title">${title}</div>`
          : `<div class="wl-title wl-unseen">${ep === 0 ? 'Not started' : '—'}</div>`}
      `;
      container.appendChild(row);
    }
  }
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
  void f.offsetWidth;
  f.classList.add('active');
  f.addEventListener('animationend', () => f.classList.remove('active'), { once: true });
}

// ─── CRT ─────────────────────────────────────────────────────────────────────
function setCRTIntensity(value) {
  const v = Math.max(0, Math.min(1, value));
  document.documentElement.style.setProperty('--crt-intensity', v);

  const lineOpacity = 0.12 + v * 0.68;
  const lineSize    = v < 0.5 ? 4 : 4 + Math.round((v - 0.5) * 8);
  const darkBand    = Math.min(lineSize - 1, lineSize * 0.6);
  const sl = document.querySelector('.crt-scanlines');
  if (sl) {
    sl.style.background = v === 0 ? 'none' :
      `repeating-linear-gradient(to bottom,transparent 0px,transparent ${lineSize - darkBand}px,rgba(0,0,0,${lineOpacity}) ${lineSize - darkBand}px,rgba(0,0,0,${lineOpacity}) ${lineSize}px)`;
    sl.style.opacity = v === 0 ? '0' : '1';
  }

  const glow = document.querySelector('.crt-glow');
  if (glow) { glow.style.filter = `blur(${v * 7}px)`; glow.style.opacity = v * 0.55; }

  const blurEl = document.querySelector('.crt-blur');
  if (blurEl) {
    const b = v * 1.4 > 0 ? `blur(${v * 1.4}px)` : 'none';
    blurEl.style.backdropFilter = b;
    blurEl.style.webkitBackdropFilter = b;
  }

  const vig = document.querySelector('.crt-vignette');
  if (vig) vig.style.opacity = v;

  const noise = document.querySelector('.crt-noise');
  if (noise) noise.style.opacity = v * 0.18;

  const fringe = document.querySelector('.crt-fringe');
  if (fringe) fringe.style.opacity = v < 0.4 ? 0 : ((v - 0.4) / 0.6) * 0.9;
}

function toggleCRT(on) {
  document.getElementById('crt-overlay').style.opacity = on ? '1' : '0';
  document.getElementById('crt-toggle').classList.toggle('on', on);
}

// ─── Clock ───────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('panel-clock').textContent =
      `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }
  tick();
  setInterval(tick, 10000);
}

// ─── Sidebar build ────────────────────────────────────────────────────────────
function buildChannelList() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';

  const groups = [], seen = new Set();
  for (const ch of App.channels) {
    const g = ch.group || 'Channels';
    if (!seen.has(g)) { groups.push(g); seen.add(g); }
  }

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
    `<span class="ch-icon">${icon}</span><span>${label}</span>` +
    `<span class="shuffle-badge">RND</span>`;
  btn.addEventListener('click', () => switchChannel(id));
  return btn;
}

// ─── Panel collapse ───────────────────────────────────────────────────────────
function wireCollapseButtons() {
  const app = document.getElementById('app');

  // Restore from sessionStorage
  if (sessionStorage.getItem('rtv_sidebar_collapsed') === '1') app.classList.add('sidebar-collapsed');
  if (sessionStorage.getItem('rtv_panel_collapsed')   === '1') app.classList.add('panel-collapsed');

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    app.classList.toggle('sidebar-collapsed');
    sessionStorage.setItem('rtv_sidebar_collapsed', app.classList.contains('sidebar-collapsed') ? '1' : '0');
  });

  document.getElementById('panel-toggle').addEventListener('click', () => {
    app.classList.toggle('panel-collapsed');
    sessionStorage.setItem('rtv_panel_collapsed', app.classList.contains('panel-collapsed') ? '1' : '0');
  });
}

// ─── Wire controls ────────────────────────────────────────────────────────────
function wireControls() {
  const crtSlider = document.getElementById('crt-intensity-slider');
  const init = App.config.crtIntensity ?? 0.4;
  crtSlider.value = init * 100;
  setCRTIntensity(init);

  crtSlider.addEventListener('input', () => {
    const v = crtSlider.value / 100;
    setCRTIntensity(v);
    document.getElementById('crt-toggle').classList.toggle('on', v > 0);
  });

  let crtOn = App.config.crtEnabled !== false;
  const crtToggle = document.getElementById('crt-toggle');
  if (crtOn) crtToggle.classList.add('on');
  crtToggle.addEventListener('click', () => { crtOn = !crtOn; toggleCRT(crtOn); });

  document.getElementById('shuffle-toggle').addEventListener('click', () => setShuffleMode(!App.shuffleMode));
  document.getElementById('btn-skip').addEventListener('click', () => {
    triggerCRTFlicker();
    if (App.playerReady) playNext();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  showStatic('LOADING…');
  loadDisabledState();

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

  App.config       = data.config       || {};
  App.channels     = data.channels     || [];
  App.globalFiller = data.globalFiller || null;

  document.title = App.config.siteName || 'RetroTube TV';
  document.getElementById('site-title').textContent = App.config.siteName || 'RetroTube TV';

  buildChannelList();
  wireControls();
  wireCollapseButtons();
  startClock();
  renderPlaylistToggles();
  renderWatchLog();

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

document.addEventListener('DOMContentLoaded', init);
