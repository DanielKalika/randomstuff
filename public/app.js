const app = document.querySelector('#app');
const announcer = document.querySelector('#announcer');
let controller;
const isStaticPreview = document.documentElement.dataset.staticPreview === 'true';
const currentRoute = () => isStaticPreview
  ? new URL(location.hash.slice(1) || document.documentElement.dataset.initialRoute || '/', 'https://original.invalid')
  : location;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name) => {
  const paths = {
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
    play: '<path d="m9 5 11 7-11 7z"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    sound: '<path d="m11 5-6 5H2v4h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4m10-8h4m-4 8h4"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.film}</svg>`;
};

async function api(path, signal) {
  if (isStaticPreview) {
    const error = new Error('This standalone preview does not connect to the live app server.');
    error.code = 'STATIC_PREVIEW';
    throw error;
  }
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(typeof body.error === 'string' ? body.error : body.error?.message || body.message || 'The source service is unavailable. Please try again.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function navigate(url) {
  history.pushState({}, '', isStaticPreview ? `#${url}` : url);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
  if (isStaticPreview && /^\/(?!\/)/.test(link.getAttribute('href') || '')) {
    event.preventDefault();
    navigate(link.getAttribute('href'));
    return;
  }
  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', render);

function emptyState({ title, description, retry = false, search = false }) {
  return `<div class="empty-state"><span class="empty-icon">${icon(search ? 'search' : 'film')}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${retry ? `<button class="button secondary" id="retry">${icon('refresh')}Try again</button>` : ''}</div>`;
}

function skeletons() {
  return `<div class="movie-grid" aria-label="Loading catalog" aria-busy="true">${Array.from({ length: 12 }, () => '<div class="movie-skeleton"><div class="skeleton-poster"></div><div class="skeleton-title"></div><div class="skeleton-meta"></div></div>').join('')}</div>`;
}

function safePoster(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}

function card(movie) {
  const poster = safePoster(movie.poster);
  const rating = Number(movie.rating);
  return `<a href="/watch/${encodeURIComponent(movie.id)}" class="movie-card" aria-label="Watch ${escapeHtml(movie.title)}">
    <div class="poster">${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="poster-placeholder">${icon('film')}</span>
      ${Number.isFinite(rating) && rating > 0 ? `<span class="rating"><span aria-label="Rating">★</span> ${rating.toFixed(1)}</span>` : ''}
      <span class="card-play">${icon('play')}</span><span class="card-action">Watch with Alloha ${icon('arrow')}</span>
    </div><h3 dir="auto">${escapeHtml(movie.title)}</h3><p>${escapeHtml(movie.year || 'Year unavailable')}<span>·</span>${movie.type === 'series' ? 'Series' : 'Movie'}</p>
  </a>`;
}

function movieLinkForm() {
  return `<section class="open-movie" aria-labelledby="open-movie-title"><div><p class="eyebrow muted">STRAIGHT TO THE PLAYER</p><h2 id="open-movie-title">Have a movie link?</h2><p>Open a Kinopk title here, even while the catalog is unavailable.</p></div><form class="movie-link-form"><label for="movie-link">Kinopk movie URL</label><div class="movie-link-input"><input id="movie-link" name="movie" type="text" inputmode="url" required autocomplete="off" placeholder="https://kinopk.web.app/movie/…" aria-describedby="movie-link-error"><button class="button primary" type="submit">Open player ${icon('play')}</button></div><p class="form-error" id="movie-link-error" role="alert"></p></form><a class="example-movie" href="/watch/258687">Try the movie you shared ${icon('arrow')}</a></section>`;
}

function bindMovieLinkForm() {
  const form = app.querySelector('.movie-link-form');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = form.querySelector('input');
    const value = input.value.trim();
    let id;
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/(?:movie|film|embed)\/([1-9]\d{0,14})\/?$/);
      if (url.protocol === 'https:' && url.hostname === 'kinopk.web.app' && !url.port && !url.username && !url.password && match) id = match[1];
    } catch {}
    if (!id) {
      form.querySelector('.form-error').textContent = 'Paste a movie link from kinopk.web.app, such as https://kinopk.web.app/movie/258687.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    navigate(`/watch/${id}`);
  });
}

function renderPlaybackEntry() {
  document.title = 'Open a movie — Original';
  app.innerHTML = `<section class="playback-entry"><a class="back-link" href="/">${icon('back')} Back to the catalog</a><h1 class="playback-title">Let’s watch something.</h1>${movieLinkForm()}<div class="watch-audio">${icon('sound')}<div><strong>Use the real player’s controls</strong><p>Choose Alloha if needed, select Original in its soundtrack menu, then press Play. Automatic soundtrack selection is still pending.</p></div></div></section>`;
  bindMovieLinkForm();
}

async function renderCatalog(signal) {
  const query = new URLSearchParams(currentRoute().search);
  const type = ['films', 'series'].includes(query.get('type')) ? query.get('type') : 'all';
  const search = (query.get('q') || '').trim();
  const page = Math.max(1, Number.parseInt(query.get('page'), 10) || 1);
  document.title = search ? `${search} — Original` : 'Original — Your personal cinema';
  app.innerHTML = `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy"><p class="eyebrow"><span></span> YOUR PERSONAL CINEMA</p><h1 id="hero-title">Good stories.<br>In their <em>own voice.</em></h1><p class="hero-description">A little less searching. A little more watching.<br>Your Kinopk catalog, with the Alloha player.</p><a class="button primary" href="#catalog">Explore the catalog ${icon('arrow')}</a></div>
    <div class="hero-art" aria-hidden="true"><div class="vinyl"><div class="vinyl-label"><svg viewBox="0 0 48 48"><path d="m18 12 20 12-20 12z" fill="currentColor"/></svg></div></div><div class="audio-card"><span class="audio-dot"></span><div><span class="audio-label">PREFERRED SOUNDTRACK</span><strong>Original</strong></div><div class="waveform">${[9, 18, 12, 25, 34, 20, 29, 14, 23, 11].map((height) => `<i style="--bar-height:${height}px"></i>`).join('')}</div></div><span class="art-caption">EVERY STORY HAS A VOICE.</span></div>
  </section>
  ${movieLinkForm()}
  <section class="catalog-section" id="catalog" aria-labelledby="catalog-title"><div class="section-heading"><div><p class="eyebrow muted">THE WATCH LIST</p><h2 id="catalog-title">${search ? 'Search results' : 'Find your next watch.'}</h2></div><span class="catalog-source"><span class="status-dot"></span>From Kinopk</span></div>
    <div class="catalog-toolbar"><div class="filter-tabs" aria-label="Catalog type">${[['all', 'All titles'], ['films', 'Movies'], ['series', 'Series']].map(([value, label]) => `<a href="/?${new URLSearchParams({ ...(value === 'all' ? {} : { type: value }) })}#catalog" class="filter-tab ${type === value && !search ? 'active' : ''}" ${type === value && !search ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</div>
      <form class="search-form" role="search">${icon('search')}<label class="visually-hidden" for="search">Search titles</label><input id="search" name="q" type="search" placeholder="Search movies, series…" maxlength="200" value="${escapeHtml(search)}"><button type="submit" aria-label="Search">${icon('arrow')}</button></form></div>
    <p class="result-summary" id="result-summary" role="status">${search ? `Searching for “${escapeHtml(search)}”…` : 'Connecting to the catalog…'}</p><div id="catalog-results">${skeletons()}</div><nav class="pagination" id="pagination" aria-label="Catalog pages"></nav>
  </section><aside class="preference-note">${icon('sound')}<p><strong>Your preference: Original audio.</strong> Automatic selection is awaiting player integration. Subtitles stay under your control.</p><span class="outline-tag">SETUP IN PROGRESS</span></aside>`;
  app.querySelector('.hero .button').addEventListener('click', (event) => { event.preventDefault(); document.querySelector('#catalog').scrollIntoView({ behavior: 'smooth' }); });
  bindMovieLinkForm();
  app.querySelector('.search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = app.querySelector('#search').value.trim();
    navigate(value ? `/?${new URLSearchParams({ q: value })}` : '/');
  });
  try {
    const result = await api(search ? `/api/search?${new URLSearchParams({ q: search })}` : `/api/catalog?${new URLSearchParams({ type, page })}`, signal);
    if (signal.aborted) return;
    const results = app.querySelector('#catalog-results');
    if (!Array.isArray(result.items)) throw new Error('The catalog returned an unexpected response.');
    const total = Number(result.total) || result.items.length;
    app.querySelector('#result-summary').textContent = search ? `${result.items.length} ${result.items.length === 1 ? 'result' : 'results'} for “${search}”` : `${total.toLocaleString()} titles in the catalog · Page ${page}`;
    results.innerHTML = result.items.length ? `<div class="movie-grid">${result.items.map(card).join('')}</div>` : emptyState({ title: search ? 'No matches this time.' : 'No titles available.', description: search ? 'Try another title, including its original or Russian name.' : 'Check back when the source catalog has new titles.', search: Boolean(search) });
    results.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
    if (!search) {
      const pageSize = Number(result.pageSize) || 30;
      const last = Math.max(1, Math.ceil(total / pageSize));
      const pageLink = (number, label) => `<a class="button secondary" href="/?${new URLSearchParams({ type, page: number })}">${label}</a>`;
      app.querySelector('#pagination').innerHTML = `${page > 1 ? pageLink(page - 1, '← Previous') : ''}${last > 1 ? `<span>Page ${page} of ${last.toLocaleString()}</span>` : ''}${page < last ? pageLink(page + 1, 'Next page →') : ''}`;
    }
    announcer.textContent = `${result.items.length} titles loaded.`;
  } catch (error) {
    if (signal.aborted) return;
    const preview = error.code === 'STATIC_PREVIEW';
    app.querySelector('#result-summary').textContent = preview ? 'Standalone design preview · Live catalog not connected' : 'The live catalog could not be loaded.';
    app.querySelector('#catalog-results').innerHTML = emptyState(preview
      ? { title: 'A first look at your cinema.', description: 'Open a movie link above to use the live player. The full catalog needs the running app and a working catalog connection.' }
      : { title: 'The catalog is out of reach.', description: 'Kinopk’s catalog service is not responding. Your connection to this site is working; try the source again in a little while.', retry: true });
    app.querySelector('#retry')?.addEventListener('click', render);
    announcer.textContent = preview ? 'Standalone preview loaded. The live catalog is not connected.' : 'Catalog unavailable. Try again later.';
  }
  if (currentRoute().hash === '#catalog') document.querySelector('#catalog')?.scrollIntoView();
}

function fitSourcePlayer(area, signal) {
  // Kinopk's public embed has a 900px player and 129px of source-page header.
  // Keep that legitimate page intact and frame its video area. The options
  // view reveals the same page without reloading or changing the provider.
  const update = () => {
    if (signal.aborted) return;
    const width = area.clientWidth;
    if (!width) return;
    const sourceWidth = Math.min(width, 900);
    const scale = width / sourceWidth;
    const sourceHeader = 129;
    const sourceHeight = sourceHeader + sourceWidth * 9 / 16;
    area.style.setProperty('--source-width', `${sourceWidth}px`);
    area.style.setProperty('--source-height', `${sourceHeight}px`);
    area.style.setProperty('--source-scale', scale);
    area.style.setProperty('--source-header', `${sourceHeader * scale}px`);
    area.style.setProperty('--video-height', `${width * 9 / 16}px`);
    area.style.setProperty('--page-height', `${sourceHeight * scale}px`);
  };
  const observer = new ResizeObserver(update);
  observer.observe(area);
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  update();
}

async function renderWatch(id, signal) {
  document.title = 'Watch — Original';
  app.innerHTML = `<section class="watch-section"><a class="back-link" href="/">${icon('back')} Back to the catalog</a><div class="watch-heading"><div><p class="eyebrow muted">NOW SHOWING</p><h1 id="watch-title">${isStaticPreview ? `Kinopk title #${id}` : 'Loading your title…'}</h1><p id="watch-meta" class="watch-meta"></p></div><span class="player-tag">KINOPK PLAYER</span></div><div class="player-area" id="player-area" aria-busy="true"></div><div class="player-instructions"><p>Select <strong>Original / Оригинальный</strong> in the soundtrack menu, then press Play. Use <strong>Player options</strong> to choose Alloha or another provider.</p><div class="player-actions"><button class="button secondary" id="player-options" type="button" aria-expanded="false" aria-controls="player-area">Player options</button><button class="button secondary" id="reload-player" type="button">${icon('refresh')}Reload player</button></div></div><p class="player-status" id="player-status" role="status">Requesting the embedded player…</p><div class="watch-audio">${icon('sound')}<div><strong>Original is your preferred soundtrack</strong><p>Automatic audio selection is not connected yet. Use the soundtrack menu inside the player.</p></div><span class="outline-tag">NOT APPLIED</span></div><div class="watch-description" id="watch-description"></div><a class="source-watch" href="https://kinopk.web.app/movie/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">View this title on Kinopk ${icon('external')}</a><p class="player-help">A chat preview or browser policy can block this player. Open the hosted site in a normal browser tab, or use the Kinopk link above. Some privacy settings also restrict embedded sites’ storage. If the video is misaligned, use Player options to show the full embedded page.</p></section>`;
  const playerArea = app.querySelector('#player-area');
  fitSourcePlayer(playerArea, signal);
  const frame = document.createElement('iframe');
  frame.src = `https://kinopk.web.app/embed/${id}`;
  frame.title = 'Kinopk video player';
  frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.addEventListener('load', () => {
    if (signal.aborted) return;
    app.querySelector('#player-area').setAttribute('aria-busy', 'false');
    app.querySelector('#player-status').textContent = 'Player requested. A blocked message means playback is unavailable in this viewer.';
    announcer.textContent = 'Player requested. Availability and playback have not been verified. Automatic soundtrack selection is not applied.';
  });
  playerArea.replaceChildren(frame);
  const optionsButton = app.querySelector('#player-options');
  const showOptions = (expanded) => {
    playerArea.classList.toggle('is-options', expanded);
    optionsButton.setAttribute('aria-expanded', String(expanded));
    optionsButton.textContent = expanded ? 'Back to video' : 'Player options';
  };
  optionsButton.addEventListener('click', () => {
    showOptions(!playerArea.classList.contains('is-options'));
  });
  // Reveal the source toolbar before Tab crosses into the iframe. Checking
  // focus afterward races cross-process frame navigation in some browsers.
  const beforePlayer = app.querySelector('.watch-section .back-link');
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    if ((!event.shiftKey && event.target === beforePlayer)
      || (event.shiftKey && event.target === optionsButton)) showOptions(true);
  }, { signal });
  app.querySelector('#reload-player').addEventListener('click', () => {
    app.querySelector('#player-area').setAttribute('aria-busy', 'true');
    app.querySelector('#player-status').textContent = 'Reloading the embedded player page…';
    frame.src = `https://kinopk.web.app/embed/${id}`;
  });
  const movieTask = (async () => {
    try {
      const { movie } = await api(`/api/movie/${id}`, signal);
      if (signal.aborted) return;
      if (!movie) throw new Error('Missing movie');
      document.title = `${movie.title} — Original`;
      app.querySelector('#watch-title').textContent = movie.title;
      const meta = [movie.year, movie.type === 'series' ? 'Series' : 'Movie', ...(movie.genres || []).slice(0, 3)].filter(Boolean);
      app.querySelector('#watch-meta').textContent = meta.join('  ·  ');
      if (movie.description) {
        app.querySelector('#watch-description').innerHTML = '<h2>About the story</h2><p dir="auto"></p>';
        app.querySelector('#watch-description p').textContent = movie.description;
      }
    } catch {
      if (!signal.aborted) {
        app.querySelector('#watch-title').textContent = `Title #${id}`;
        app.querySelector('#watch-meta').textContent = 'Title details are currently unavailable.';
      }
    }
  })();
  await movieTask;
}

function render() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const route = currentRoute();
  const type = new URLSearchParams(route.search).get('type') || 'all';
  document.querySelectorAll('[data-category]').forEach((link) => {
    const active = route.pathname === '/' && link.dataset.category === type;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const watch = route.pathname.match(/^\/watch\/([1-9]\d{0,14})\/?$/);
  if (watch) return renderWatch(watch[1], signal);
  if (route.pathname === '/playback') return renderPlaybackEntry();
  if (route.pathname === '/') return renderCatalog(signal);
  document.title = 'Page not found — Original';
  app.innerHTML = `${emptyState({ title: 'This scene is missing.', description: 'The page you are looking for does not exist.' })}<p class="center"><a class="button primary" href="/">Back to the catalog ${icon('arrow')}</a></p>`;
}

render();
