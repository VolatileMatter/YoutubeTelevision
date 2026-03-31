/**
 * RetroTube TV — home.js
 *
 * Channel model:
 *   - Each channel has its own optional filler[] array. If a channel has filler,
 *     one random video from one random filler playlist plays between EVERY primary video.
 *   - If a channel has no filler, globalFiller is used as fallback (if set).
 *   - fillerChance in config (0–1) controls how often filler plays.
 *
 * Playback mode:
 *   - IN ORDER: Cycles through playlists in sequence (playlist[0], playlist[1], ..., wrap).
 *               Within each playlist, increments episode index via cookie.
 *   - SHUFFLE:  Picks a random playlist from the active channel, random index within it.
 *               Cookies are not consumed in shuffle mode.
 *
 * Filler:
 *   - A filler video plays between every primary video (subject to fillerChance).
 *   - Filler is always random regardless of playback mode.
 *
 * Effects:
 *   - CRT settings (intensity + individual toggles) saved to cookies.
 *   - Mild ambient flicker added to the CRT overlay at all times.
 *   - "Edit TV Effects" palette is collapsible, closed by default.
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
 */

// ─── Debug logger ─────────────────────────────────────────────────────────────
const LOG = {
  tag: '[RTV]',
  info  (...a) { console.log  (this.tag, ...a); },
  warn  (...a) { console.warn (this.tag, ...a); },
  error (...a) { console.error(this.tag, ...a); },
  group (label, fn) {
    console.groupCollapsed(this.tag + ' ' + label);
    fn();
    console.groupEnd();
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const App = {
  config:          null,
  channels:        [],
  globalFiller:    null,
  activeChannelId: 'all',
  shuffleMode:     true,   // shuffle ON by default
  player:          null,
  playerReady:     false,
  current: {
    channelId:   null,
    playlistId:  null,
    isFiller:    false,
  },
  pending:         null,   // episode queued while filler plays
  watchLog:        {},     // { [playlistId]: { title, episode } }
  disabled:        new Set(),
  // In-order rotation state: tracks which playlist index we're on per channel
  playlistCursor:  {},     // { [channelId]: number }
};

// ─── Cookies ─────────────────────────────────────────────────────────────────
const Cookies = {
  PREFIX: 'rtv_',
  DAYS:   365,
  _key(id) { return this.PREFIX + id; },
  get(id) {
    const name = this._key(id) + '=';
    for (const p of decodeURIComponent(document.cookie).split(';')) {
      const t = p.trim();
      if (t.startsWith(name)) return parseInt(t.slice(name.length), 10) || 0;
    }
    return 0;
  },
  set(id, value) {
    const d = new Date();
    d.setTime(d.getTime() + this.DAYS * 86400000);
    document.cookie = `${this._key(id)}=${value};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },
  setStr(id, value) {
    const d = new Date();
    d.setTime(d.getTime() + this.DAYS * 86400000);
    document.cookie = `${this._key(id)}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  },
  getStr(id) {
    const name = this._key(id) + '=';
    for (const p of decodeURIComponent(document.cookie).split(';')) {
      const t = p.trim();
      if (t.startsWith(name)) return decodeURIComponent(t.slice(name.length));
    }
    return null;
  },
  consume(playlistId) {
    const i = this.get(playlistId);
    this.set(playlistId, i + 1);
    LOG.info(`Cookie consume [${playlistId}]: was ${i}, now ${i + 1}`);
    return i;
  },
};

// ─── Effects cookie helpers ───────────────────────────────────────────────────
const EffectsCookies = {
  COOKIE_ID: 'effects_state',
  defaults() {
    return {
      crtEnabled:   true,
      intensity:    0.4,
      scanlines:    true,
      glow:         true,
      vignette:     true,
      noise:        true,
      fringe:       true,
      blur:         true,
      flicker:      true,
    };
  },
  save(state) {
    Cookies.setStr(this.COOKIE_ID, JSON.stringify(state));
    LOG.info('Effects saved to cookie:', state);
  },
  load() {
    const raw = Cookies.getStr(this.COOKIE_ID);
    if (!raw) {
      LOG.info('No effects cookie found, using defaults');
      return this.defaults();
    }
    try {
      const parsed = { ...this.defaults(), ...JSON.parse(raw) };
      LOG.info('Effects loaded from cookie:', parsed);
      return parsed;
    } catch {
      LOG.warn('Failed to parse effects cookie, using defaults');
      return this.defaults();
    }
  },
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomIndex()   { return Math.floor(Math.random() * 500); }

function shouldPlayFiller(channel) {
  const fillerList = getFillerForChannel(channel);
  if (!fillerList.length) return false;
  if (fillerList.every(p => p.youtubePlaylistId.startsWith('PLACEHOLDER'))) return false;
  const roll = Math.random();
  const chance = App.config.fillerChance ?? 0.4;
  const result = roll < chance;
  LOG.info(`Filler check: roll=${roll.toFixed(2)} chance=${chance} → ${result ? 'YES' : 'NO'}`);
  return result;
}

function getFillerForChannel(channel) {
  if (channel?.filler?.length) return channel.filler;
  return App.globalFiller?.playlists ?? [];
}

// ─── Channel / playlist helpers ───────────────────────────────────────────────
function getChannelById(id) {
  const ch = App.channels.find(c => c.id === id) ?? null;
  if (!ch && id !== 'all') LOG.warn(`getChannelById: no channel found for id="${id}"`);
  return ch;
}

function getActivePlaylists() {
  let all;
  if (App.activeChannelId === 'all') {
    all = App.channels.flatMap(ch =>
      ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }))
    );
  } else {
    const ch = getChannelById(App.activeChannelId);
    if (!ch) {
      LOG.error(`getActivePlaylists: channel "${App.activeChannelId}" not found!`);
      return [];
    }
    all = ch.playlists.map(pl => ({ channelId: ch.id, playlist: pl }));
  }
  const enabled = all.filter(({ playlist }) => !App.disabled.has(playlist.id));
  LOG.info(`getActivePlaylists [channel="${App.activeChannelId}"]:`,
    enabled.map(e => `${e.channelId}/${e.playlist.id}`));
  return enabled;
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

// ─── In-order playlist cursor ─────────────────────────────────────────────────
function getNextPlaylistInOrder(channelId) {
  const options = getActivePlaylists();
  if (!options.length) return null;

  // Filter to just the current channel if not 'all'
  const pool = channelId === 'all' ? options :
    options.filter(o => o.channelId === channelId);

  if (!pool.length) {
    LOG.warn(`getNextPlaylistInOrder: empty pool for channelId="${channelId}"`);
    return null;
  }

  const cursor = App.playlistCursor[channelId] ?? 0;
  const idx    = cursor % pool.length;
  App.playlistCursor[channelId] = cursor + 1;

  const chosen = pool[idx];
  LOG.info(`In-order cursor [${channelId}]: slot ${idx}/${pool.length} → playlist "${chosen.playlist.id}"`);
  return chosen;
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  LOG.info('YouTube IFrame API ready, creating player…');
  App.player = new YT.Player('yt-player', {
    playerVars: { autoplay: 1, controls: 1, modestbranding: 1, rel: 0, iv_load_policy: 3 },
    events: {
      onReady:       () => { App.playerReady = true; LOG.info('Player ready'); playNext(); },
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
    },
  });
};

function onPlayerStateChange(event) {
  const stateNames = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
  LOG.info(`Player state: ${stateNames[event.data] ?? event.data}`);
  if (event.data === YT.PlayerState.ENDED)   handleVideoEnded();
  if (event.data === YT.PlayerState.PLAYING) captureNowPlayingTitle();
}

function onPlayerError(event) {
  LOG.error(`YouTube player error code: ${event.data}`);
  App.current.isFiller ? loadPendingEpisode() : playNext();
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function playNext() {
  LOG.group('playNext()', () => {
    LOG.info(`Mode: ${App.shuffleMode ? 'SHUFFLE' : 'IN ORDER'} | Channel: ${App.activeChannelId}`);
  });

  const options = getActivePlaylists();
  if (!options.length) { showStatic('NO SIGNAL'); return; }

  let chosen;
  if (App.shuffleMode) {
    chosen = pickRandom(options);
    LOG.info(`Shuffle picked: channel="${chosen.channelId}" playlist="${chosen.playlist.id}"`);
  } else {
    chosen = getNextPlaylistInOrder(App.activeChannelId);
    if (!chosen) { showStatic('NO SIGNAL'); return; }
  }

  const { channelId, playlist } = chosen;

  // Validate the channel matches what we expect
  if (App.activeChannelId !== 'all' && channelId !== App.activeChannelId) {
    LOG.error(`MISMATCH! activeChannelId="${App.activeChannelId}" but chosen channelId="${channelId}"`);
  }

  const index = App.shuffleMode
    ? randomIndex()
    : Cookies.consume(playlist.id);

  LOG.info(`Loading: channel="${channelId}" playlist="${playlist.id}" ytId="${playlist.youtubePlaylistId}" index=${index}`);

  const episode = { channelId, playlistId: playlist.id, index };
  updateNowPlaying(channelId, playlist.label, index);
  setAccentColor(channelId);

  const channel = getChannelById(channelId);
  if (shouldPlayFiller(channel)) {
    LOG.info('Queuing filler before episode');
    App.pending = episode;
    playFiller(channel);
  } else {
    loadEpisode(episode);
  }
}

function loadEpisode({ channelId, playlistId, index }) {
  LOG.info(`loadEpisode: channel="${channelId}" playlist="${playlistId}" index=${index}`);
  App.current = { channelId, playlistId, isFiller: false };
  hideStatic();
  const pl = findPlaylistAnywhere(playlistId);
  if (!pl) {
    LOG.error(`loadEpisode: playlist "${playlistId}" not found anywhere!`);
    playNext();
    return;
  }
  LOG.info(`loadPlaylist: ytId="${pl.youtubePlaylistId}" index=${index}`);
  App.player.loadPlaylist({ list: pl.youtubePlaylistId, listType: 'playlist', index, startSeconds: 0 });
}

function playFiller(channel) {
  const fillerList = getFillerForChannel(channel).filter(
    p => !p.youtubePlaylistId.startsWith('PLACEHOLDER')
  );
  if (!fillerList.length) {
    LOG.warn('No valid filler found, skipping to episode');
    loadPendingEpisode();
    return;
  }
  const pl    = pickRandom(fillerList);
  const index = randomIndex();
  LOG.info(`playFiller: "${pl.id}" ytId="${pl.youtubePlaylistId}" index=${index}`);
  App.current = { channelId: 'filler', playlistId: pl.id, isFiller: true };
  updateNowPlaying(null, pl.label, index);
  App.player.loadPlaylist({ list: pl.youtubePlaylistId, listType: 'playlist', index, startSeconds: 0 });
}

function handleVideoEnded() {
  LOG.info(`handleVideoEnded: isFiller=${App.current.isFiller}`);
  App.current.isFiller ? loadPendingEpisode() : playNext();
}

function loadPendingEpisode() {
  const ep = App.pending; App.pending = null;
  LOG.info('loadPendingEpisode:', ep ? `channel="${ep.channelId}" playlist="${ep.playlistId}"` : 'none, calling playNext');
  ep ? loadEpisode(ep) : playNext();
}

// ─── Channel switching ────────────────────────────────────────────────────────
function switchChannel(channelId) {
  LOG.info(`switchChannel: "${channelId}" (was "${App.activeChannelId}")`);
  if (channelId === App.activeChannelId) {
    LOG.info('switchChannel: same channel, ignoring');
    return;
  }
  App.activeChannelId = channelId;
  LOG.info(`switchChannel: App.activeChannelId is now "${App.activeChannelId}"`);

  document.querySelectorAll('.ch-btn').forEach(b => {
    const match = b.dataset.id === channelId;
    b.classList.toggle('active', match);
    LOG.info(`  btn[data-id="${b.dataset.id}"] active=${match}`);
  });

  setAccentColor(channelId === 'all' ? null : channelId);
  triggerCRTFlicker();
  renderPlaylistToggles();
  renderWatchLog();
  if (App.playerReady) playNext();
}

// ─── Shuffle / order mode ─────────────────────────────────────────────────────
function setShuffleMode(on) {
  LOG.info(`setShuffleMode: ${on}`);
  App.shuffleMode = on;
  document.body.classList.toggle('shuffle-on', on);

  const slider = document.getElementById('order-shuffle-slider');
  if (slider) slider.value = on ? 1 : 0;

  const label = document.getElementById('order-shuffle-label');
  if (label) label.textContent = on ? 'SHUFFLE' : 'IN ORDER';
}

// ─── Playlist toggles ─────────────────────────────────────────────────────────
function renderPlaylistToggles() {
  const list = document.getElementById('playlist-toggle-list');
  list.innerHTML = '';

  let entries;
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
  LOG.info(`onPlaylistToggle: playlist="${playlistId}" enabled=${enabled}`);
  if (!enabled) {
    const enabledCount = allEntries.filter(({ playlist }) => !App.disabled.has(playlist.id)).length;
    if (enabledCount <= 1) {
      LOG.warn('Cannot disable last enabled playlist');
      const cb = document.querySelector(`[data-playlist-id="${playlistId}"]`);
      if (cb) cb.checked = true;
      return;
    }
    App.disabled.add(playlistId);
  } else {
    App.disabled.delete(playlistId);
  }
  sessionStorage.setItem('rtv_disabled', JSON.stringify([...App.disabled]));
}

function loadDisabledState() {
  try {
    const saved = sessionStorage.getItem('rtv_disabled');
    if (saved) App.disabled = new Set(JSON.parse(saved));
    LOG.info('Loaded disabled playlists:', [...App.disabled]);
  } catch { LOG.warn('Failed to load disabled state'); }
}

// ─── Watch Log ────────────────────────────────────────────────────────────────
function captureNowPlayingTitle() {
  if (App.current.isFiller) return;
  const { playlistId } = App.current;
  if (!playlistId) return;
  const data  = App.player.getVideoData?.();
  const title = data?.title ?? null;
  const ep    = Cookies.get(playlistId);
  LOG.info(`Now playing: playlist="${playlistId}" ep=${ep} title="${title}"`);
  App.watchLog[playlistId] = { title, episode: ep };
  renderWatchLog();
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
  const color = ch?.accentColor ?? '#c8f0c0';
  document.documentElement.style.setProperty('--accent', color);
  LOG.info(`Accent color set to ${color} for channel="${channelId}"`);
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

// ─── CRT Effects ─────────────────────────────────────────────────────────────
let _effectsState = null;

function getEffectsState() {
  return _effectsState;
}

function applyEffectsState(state) {
  _effectsState = state;

  const overlay = document.getElementById('crt-overlay');
  if (overlay) overlay.style.opacity = state.crtEnabled ? '1' : '0';

  setCRTIntensity(state.intensity);

  const el = (sel) => document.querySelector(sel);

  const scanlines = el('.crt-scanlines');
  if (scanlines) scanlines.style.display = state.scanlines ? '' : 'none';

  const glow = el('.crt-glow');
  if (glow) glow.style.display = state.glow ? '' : 'none';

  const vig = el('.crt-vignette');
  if (vig) vig.style.display = state.vignette ? '' : 'none';

  const noise = el('.crt-noise');
  if (noise) noise.style.display = state.noise ? '' : 'none';

  const fringe = el('.crt-fringe');
  if (fringe) fringe.style.display = state.fringe ? '' : 'none';

  const blur = el('.crt-blur');
  if (blur) blur.style.display = state.blur ? '' : 'none';

  // Ambient flicker
  const ambientFlicker = el('.crt-ambient-flicker');
  if (ambientFlicker) {
    ambientFlicker.style.display = state.flicker ? '' : 'none';
  }

  // Sync UI controls
  syncEffectsUI(state);
  EffectsCookies.save(state);
}

function syncEffectsUI(state) {
  const setToggle = (id, on) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('on', on);
  };
  const setCheck = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.checked = on;
  };

  setToggle('crt-toggle', state.crtEnabled);
  const slider = document.getElementById('crt-intensity-slider');
  if (slider) slider.value = state.intensity * 100;
  setCheck('fx-scanlines', state.scanlines);
  setCheck('fx-glow',      state.glow);
  setCheck('fx-vignette',  state.vignette);
  setCheck('fx-noise',     state.noise);
  setCheck('fx-fringe',    state.fringe);
  setCheck('fx-blur',      state.blur);
  setCheck('fx-flicker',   state.flicker);
}

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
  LOG.info('Channel list built:', App.channels.map(c => c.id));
}

function makeChannelBtn(id, icon, label, active) {
  const btn = document.createElement('button');
  btn.className = 'ch-btn' + (active ? ' active' : '');
  btn.dataset.id = id;
  btn.innerHTML =
    `<span class="ch-icon">${icon}</span><span>${label}</span>`;
  btn.addEventListener('click', () => {
    LOG.info(`Channel button clicked: data-id="${id}"`);
    switchChannel(id);
  });
  return btn;
}

// ─── Panel collapse ───────────────────────────────────────────────────────────
function wireCollapseButtons() {
  const app = document.getElementById('app');

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
  const state = EffectsCookies.load();

  // CRT master toggle
  const crtToggle = document.getElementById('crt-toggle');
  crtToggle.addEventListener('click', () => {
    const s = getEffectsState();
    s.crtEnabled = !s.crtEnabled;
    applyEffectsState(s);
    LOG.info(`CRT master toggle → ${s.crtEnabled}`);
  });

  // Intensity slider
  const crtSlider = document.getElementById('crt-intensity-slider');
  crtSlider.addEventListener('input', () => {
    const s = getEffectsState();
    s.intensity = crtSlider.value / 100;
    applyEffectsState(s);
  });

  // Order/Shuffle slider
  const modeSlider = document.getElementById('order-shuffle-slider');
  modeSlider.addEventListener('input', () => {
    const on = parseInt(modeSlider.value, 10) === 1;
    setShuffleMode(on);
  });

  // Skip button
  document.getElementById('btn-skip').addEventListener('click', () => {
    LOG.info('Skip button clicked');
    triggerCRTFlicker();
    if (App.playerReady) playNext();
  });

  // Effects palette toggle
  const fxHeader = document.getElementById('fx-palette-header');
  const fxBody   = document.getElementById('fx-palette-body');
  fxHeader.addEventListener('click', () => {
    const open = fxBody.classList.toggle('open');
    fxHeader.classList.toggle('open', open);
    sessionStorage.setItem('rtv_fx_open', open ? '1' : '0');
  });
  // Restore palette open state
  if (sessionStorage.getItem('rtv_fx_open') === '1') {
    fxBody.classList.add('open');
    fxHeader.classList.add('open');
  }

  // Individual effect checkboxes
  const effectMap = {
    'fx-scanlines': 'scanlines',
    'fx-glow':      'glow',
    'fx-vignette':  'vignette',
    'fx-noise':     'noise',
    'fx-fringe':    'fringe',
    'fx-blur':      'blur',
    'fx-flicker':   'flicker',
  };
  for (const [elId, key] of Object.entries(effectMap)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('change', () => {
      const s = getEffectsState();
      s[key] = el.checked;
      LOG.info(`Effect "${key}" → ${el.checked}`);
      applyEffectsState(s);
    });
  }

  // Apply loaded state to DOM
  applyEffectsState(state);
  // Start in shuffle mode
  setShuffleMode(true);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  LOG.info('init() start');
  showStatic('LOADING…');
  loadDisabledState();

  let data;
  try {
    const res = await fetch('channels.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    showStatic('ERROR: channels.json');
    LOG.error('Failed to load channels.json:', e);
    return;
  }

  App.config       = data.config       || {};
  App.channels     = data.channels     || [];
  App.globalFiller = data.globalFiller || null;

  LOG.group('Loaded data', () => {
    LOG.info('Config:', App.config);
    LOG.info('Channels:', App.channels.map(c => ({ id: c.id, label: c.label, playlists: c.playlists.map(p => p.id) })));
    LOG.info('GlobalFiller:', App.globalFiller);
  });

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
  LOG.info('YouTube API script injected');
}

document.addEventListener('DOMContentLoaded', init);
