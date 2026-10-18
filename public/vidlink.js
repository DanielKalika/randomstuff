const providerOrigin = 'https://vidlink.pro';
const form = document.querySelector('#trial-title-form');
const input = document.querySelector('#trial-title');
const kindInput = document.querySelector('#trial-kind');
const seasonInput = document.querySelector('#trial-season');
const episodeInput = document.querySelector('#trial-episode');
const watch = document.querySelector('#trial-watch');
const playerArea = document.querySelector('#trial-player');
const status = document.querySelector('#trial-status');
const progress = document.querySelector('#trial-progress');
let media;
let frame;
let frameController;

function positiveId(value, maxDigits = 15) {
  return typeof value === 'string' && new RegExp(`^[1-9]\\d{0,${maxDigits - 1}}$`).test(value);
}

function episodeNumber(node) {
  return positiveId(node.value, 4) ? node.value : null;
}

function showEpisodeFields() {
  document.querySelector('#trial-episode-fields').hidden = kindInput.value !== 'tv';
}
kindInput.addEventListener('change', showEpisodeFields);

function parseTitle(value) {
  const raw = value.trim();
  if (positiveId(raw)) return { id: raw, type: kindInput.value };
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/(movie|tv)\/([1-9]\d{0,14})(?:-[^/]+)?\/?$/);
    if (url.protocol !== 'https:' || !['www.themoviedb.org', 'themoviedb.org'].includes(url.hostname)
      || url.port || url.username || url.password || !match) return null;
    return { type: match[1], id: match[2] };
  } catch { return null; }
}

function appearance() {
  const accent = document.querySelector('#trial-accent').value;
  const icons = document.querySelector('#trial-icons').value;
  const engine = document.querySelector('#trial-engine').value;
  return {
    primaryColor: /^#[0-9a-f]{6}$/i.test(accent) ? accent.slice(1) : 'c0e994',
    secondaryColor: '2a3229', iconColor: 'f2f2e9',
    icons: ['vid', 'default'].includes(icons) ? icons : 'vid',
    player: ['default', 'jw'].includes(engine) ? engine : 'default',
    title: 'false', poster: 'true', autoplay: 'false', nextbutton: 'false',
  };
}

function playerUrl(title) {
  const path = title.type === 'movie' ? `/movie/${title.id}` : `/tv/${title.id}/${title.season}/${title.episode}`;
  const url = new URL(path, providerOrigin);
  url.search = new URLSearchParams(appearance()).toString();
  return url.href;
}

function formatTime(seconds) {
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(hours ? 2 : 1, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function mountPlayer() {
  if (!media) return;
  frameController?.abort();
  frameController = new AbortController();
  const signal = frameController.signal;
  const requestedMedia = { ...media };
  const url = playerUrl(requestedMedia);
  const nextFrame = document.createElement('iframe');
  nextFrame.title = 'VidLink video player';
  nextFrame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  nextFrame.allowFullscreen = true;
  nextFrame.referrerPolicy = 'strict-origin-when-cross-origin';
  nextFrame.src = url;
  status.textContent = 'Requesting the player page…';
  progress.textContent = '';
  playerArea.setAttribute('aria-busy', 'true');
  nextFrame.addEventListener('load', () => {
    playerArea.setAttribute('aria-busy', 'false');
    status.textContent = 'Player page requested. Press Play; video availability has not been verified.';
  }, { signal });
  window.addEventListener('message', (event) => {
    // Both the origin and the exact iframe must match. Ignore unrelated frames,
    // stale players, bulk progress data and malformed provider messages.
    if (event.origin !== providerOrigin || event.source !== nextFrame.contentWindow) return;
    const payload = event.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 'PLAYER_EVENT') return;
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !['play', 'pause', 'seeked', 'ended', 'timeupdate'].includes(data.event)
      || String(data.mtmdbId) !== requestedMedia.id || data.mediaType !== requestedMedia.type
      || !Number.isFinite(data.currentTime) || data.currentTime < 0
      || !Number.isFinite(data.duration) || data.duration <= 0 || data.currentTime > data.duration + 1) return;
    if (requestedMedia.type === 'tv' && (String(data.season) !== requestedMedia.season || String(data.episode) !== requestedMedia.episode)) return;
    const state = { play: 'Playing', pause: 'Paused', seeked: 'Position changed', ended: 'Ended' }[data.event];
    if (state) status.textContent = `Provider reports: ${state}. Audio and resolution have not been verified.`;
    progress.textContent = `Provider reported: ${formatTime(data.currentTime)} / ${formatTime(data.duration)}`;
  }, { signal });
  frame = nextFrame;
  playerArea.replaceChildren(frame);
  document.querySelector('#trial-provider-link').href = url;
}

function openTitle(title, { updateHash = true, scroll = false } = {}) {
  if (!['movie', 'tv'].includes(title.type) || !positiveId(title.id)) return;
  if (title.type === 'tv' && (!positiveId(title.season, 4) || !positiveId(title.episode, 4))) return;
  media = title;
  const sharedMovie = title.type === 'movie' && title.id === '157336';
  const providerDemo = title.type === 'movie' && title.id === '786892';
  const name = sharedMovie ? 'Interstellar' : providerDemo ? 'Furiosa: A Mad Max Saga' : title.type === 'movie' ? `TMDB movie #${title.id}` : `TMDB series #${title.id}`;
  document.querySelector('#trial-watch-title').textContent = name;
  document.querySelector('#trial-watch-meta').textContent = sharedMovie ? '2014 · Movie · The title you shared' : providerDemo ? '2024 · Movie · The provider’s documented example' : title.type === 'tv' ? `Season ${title.season} · Episode ${title.episode}` : 'Movie';
  document.title = `${name} — VidLink · Original`;
  kindInput.value = title.type;
  input.value = `https://www.themoviedb.org/${title.type}/${title.id}`;
  if (title.type === 'tv') {
    seasonInput.value = title.season;
    episodeInput.value = title.episode;
  }
  showEpisodeFields();
  input.removeAttribute('aria-invalid');
  document.querySelector('#trial-title-error').textContent = '';
  document.querySelector('#trial-original-link').href = sharedMovie ? './playback.html#/watch/258687' : './playback.html';
  watch.hidden = false;
  mountPlayer();
  if (updateHash) {
    const hash = `#${title.type}/${title.id}${title.type === 'tv' ? `/${title.season}/${title.episode}` : ''}`;
    try { history.replaceState(null, '', hash); } catch { /* An HTML viewer can restrict history. */ }
  }
  if (scroll) watch.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = parseTitle(input.value);
  if (title?.type === 'tv') {
    kindInput.value = 'tv';
    showEpisodeFields();
    title.season = episodeNumber(seasonInput);
    title.episode = episodeNumber(episodeInput);
  }
  if (!title || (title.type === 'tv' && (!title.season || !title.episode))) {
    document.querySelector('#trial-title-error').textContent = 'Enter a TMDB movie or series link, or a positive TMDB ID. Series also need a season and episode from 1 to 9999.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  openTitle(title, { scroll: true });
});
document.querySelector('#trial-example').addEventListener('click', () => openTitle({ type: 'movie', id: '157336' }, { scroll: true }));
document.querySelector('#trial-provider-example').addEventListener('click', () => openTitle({ type: 'movie', id: '786892' }, { scroll: true }));
document.querySelector('#trial-reload').addEventListener('click', mountPlayer);
document.querySelector('#trial-appearance-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mountPlayer();
});

function readHash() {
  const clearPlayer = () => {
    frameController?.abort();
    frameController = null;
    frame = null;
    media = null;
    playerArea.replaceChildren();
    watch.hidden = true;
    status.textContent = '';
    progress.textContent = '';
    document.title = 'A different player — Original';
  };
  if (!location.hash) { clearPlayer(); return; }
  const match = location.hash.match(/^#(movie|tv)\/([1-9]\d{0,14})(?:\/([1-9]\d{0,3})\/([1-9]\d{0,3}))?$/);
  if (!match || (match[1] === 'tv') !== Boolean(match[3])) {
    clearPlayer();
    document.querySelector('#trial-title-error').textContent = 'This title link is incomplete. Open a movie or series with the form above.';
    return;
  }
  openTitle({ type: match[1], id: match[2], ...(match[3] ? { season: match[3], episode: match[4] } : {}) }, { updateHash: false });
}
window.addEventListener('hashchange', readHash);
readHash();
