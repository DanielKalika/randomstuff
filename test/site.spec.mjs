import { test, expect } from '@playwright/test';
import { playerFixture, expectFittedSurface, expectInsidePlayer, clickSourceControl } from './player-fixture.mjs';

// These are local UI fixtures, not catalog entries or evidence of live playback.
const movie = {
  id: '258687',
  title: '[Fixture] Movie & Original',
  year: 2024,
  type: 'film',
  rating: 8.2,
  poster: 'https://images.invalid/fixture-poster.jpg',
  genres: ['Drama'],
  description: 'A deliberately local fixture for browser validation.',
};
const series = { ...movie, id: '258688', title: '[Fixture] Series', type: 'series', poster: null };
const secondPage = { ...movie, id: '258689', title: '[Fixture] Next page', poster: null };
const playerUrl = 'https://kinopk.web.app/embed/258687';

async function fixtures(page, { catalogFailures = 0, metadataFailures = 0 } = {}) {
  const requests = [];
  const blocked = [];
  const embeds = [];
  let failedCatalog = 0;
  let failedMetadata = 0;
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:3000') {
      // Only the source's public embed path is served; media and other external
      // request are blocked so tests cannot contact providers or start playback.
      if (/^https:\/\/kinopk\.web\.app\/embed\/[1-9]\d{0,14}$/.test(url.href) && request.resourceType() === 'document') {
        embeds.push(url.href);
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: playerFixture('Local Kinopk embed fixture. No video is loaded.'),
        });
      }
      blocked.push(url.href);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(url);
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === '/api/catalog') {
      if (failedCatalog++ < catalogFailures) return json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Fixture catalog unavailable.' } }, 503);
      const type = url.searchParams.get('type') || 'all';
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const items = pageNumber > 1 ? [secondPage] : type === 'series' ? [series] : type === 'films' ? [movie] : [movie, series];
      return json({ items, total: 31, page: pageNumber, pageSize: 30 });
    }
    if (url.pathname === '/api/search') return json({ items: [movie], total: 1, page: 1, pageSize: 30 });
    if (/^\/api\/movie\/\d+$/.test(url.pathname)) {
      if (failedMetadata++ < metadataFailures) return json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Fixture metadata unavailable.' } }, 503);
      return json({ movie });
    }
    return json({ error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'This API request has no browser fixture.' } }, 501);
  });
  return { requests, blocked, embeds };
}

test('catalog renders source fixtures as navigable cards and keeps audio status honest', async ({ page }) => {
  const { blocked } = await fixtures(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find your next watch.' })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(2);
  await expect(page.getByRole('link', { name: `Watch ${movie.title}` })).toHaveAttribute('href', '/watch/258687');
  await expect(page.getByRole('link', { name: `Watch ${series.title}` })).toBeVisible();
  await expect(page.locator('#result-summary')).toContainText('31 titles');
  await expect(page.locator('.preference-note')).toContainText('Automatic selection is awaiting player integration');
  await expect(page.locator('.preference-note')).toContainText('SETUP IN PROGRESS');
  await expect.poll(() => blocked.length).toBeGreaterThan(0);
  await expect(page.locator('.movie-card img')).toHaveCount(0);
});

test('search preserves special characters in one encoded query parameter and browser history', async ({ page }) => {
  const { requests } = await fixtures(page);
  const query = 'Amélie & "כוכב" + 100% #?';
  await page.goto('/');
  await expect(page.locator('.movie-card')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search titles' }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(1);
  const searchRequest = requests.find((url) => url.pathname === '/api/search');
  expect(searchRequest).toBeDefined();
  expect([...searchRequest.searchParams]).toEqual([['q', query]]);
  expect(new URL(page.url()).searchParams.get('q')).toBe(query);
  await expect(page.getByRole('searchbox', { name: 'Search titles' })).toHaveValue(query);
  await expect(page.locator('#result-summary')).toContainText(query);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Find your next watch.' })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(2);
});

test('category tabs, pagination, and back navigation preserve catalog selection', async ({ page }) => {
  const { requests } = await fixtures(page);
  await page.goto('/');
  await expect(page.locator('.movie-card')).toHaveCount(2);
  const seriesTab = page.getByLabel('Catalog type').getByRole('link', { name: 'Series', exact: true });
  await seriesTab.click();
  await expect(seriesTab).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: `Watch ${series.title}` })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('link', { name: `Watch ${secondPage.title}` })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('type')).toBe('series');
  expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  expect(requests.some((url) => url.pathname === '/api/catalog' && url.searchParams.get('type') === 'series' && url.searchParams.get('page') === '2')).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Catalog pages' })).toContainText('Page 2 of 2');
  await page.goBack();
  await expect(page.getByRole('link', { name: `Watch ${series.title}` })).toBeVisible();
  await expect(seriesTab).toHaveAttribute('aria-current', 'page');
});

test('watch uses the public source embed with fullscreen permissions and an honest audio state', async ({ page }) => {
  const { requests, embeds } = await fixtures(page);
  await page.goto('/');
  await page.getByRole('link', { name: `Watch ${movie.title}` }).click();
  await expect(page).toHaveURL(/\/watch\/258687$/);
  await expect(page.getByRole('heading', { name: movie.title, exact: true })).toBeVisible();
  const frame = page.getByTitle('Kinopk video player');
  await expect(frame).toHaveAttribute('src', playerUrl);
  await expect(frame).toHaveAttribute('allowfullscreen', '');
  await expect(frame).toHaveAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(page.frameLocator('iframe[title="Kinopk video player"]').getByText('Local Kinopk embed fixture. No video is loaded.')).toBeVisible();
  await expect(page.locator('.watch-audio')).toContainText('NOT APPLIED');
  await expect(page.locator('.watch-audio')).toContainText('Automatic audio selection is not connected yet');
  await expect(page.locator('#announcer')).toContainText('Availability and playback have not been verified');
  await expect(page.locator('#announcer')).toContainText('Automatic soundtrack selection is not applied');
  await expect(page.locator('.player-instructions')).toContainText('Original / Оригинальный');
  await expect(page.locator('.source-watch')).toHaveAttribute('href', 'https://kinopk.web.app/movie/258687');
  await page.getByRole('button', { name: 'Reload player' }).click();
  await expect.poll(() => embeds.length).toBe(2);
  expect(embeds).toEqual([playerUrl, playerUrl]);
  await expect(page.locator('#player-status')).toContainText('Player requested');
  expect(requests.some((url) => url.pathname.startsWith('/api/player/'))).toBe(false);
  // Reloading a cross-origin iframe can create its own browser history entry.
  // Use the explicit catalog control here; main-route history is checked above.
  await page.getByRole('link', { name: 'Back to the catalog' }).click();
  await expect(page.locator('.movie-card')).toHaveCount(2);
});

test('catalog failure offers a working retry instead of showing fictional titles', async ({ page }) => {
  const { requests } = await fixtures(page, { catalogFailures: 1 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The catalog is out of reach.' })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.movie-card')).toHaveCount(2);
  expect(requests.filter((url) => url.pathname === '/api/catalog')).toHaveLength(2);
});

test('unavailable title metadata does not block the source player or request a player API', async ({ page }) => {
  const { requests } = await fixtures(page, { metadataFailures: 1 });
  await page.goto('/watch/258687');
  await expect(page.getByRole('heading', { name: 'Title #258687', exact: true })).toBeVisible();
  await expect(page.locator('#watch-meta')).toContainText('Title details are currently unavailable');
  await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', playerUrl);
  await expect(page.frameLocator('iframe').getByText('Local Kinopk embed fixture. No video is loaded.')).toBeVisible();
  await expect(page.locator('#player-area')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.watch-audio')).toContainText('NOT APPLIED');
  await expect(page.getByRole('link', { name: 'View this title on Kinopk' })).toBeVisible();
  expect(requests.filter((url) => url.pathname === '/api/movie/258687')).toHaveLength(1);
  expect(requests.some((url) => url.pathname.startsWith('/api/player/'))).toBe(false);
});

test('the direct movie link remains usable while the catalog is unavailable', async ({ page }) => {
  await fixtures(page, { catalogFailures: 1, metadataFailures: 1 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The catalog is out of reach.' })).toBeVisible();
  await page.getByRole('link', { name: 'Try the movie you shared' }).click();
  await expect(page).toHaveURL(/\/watch\/258687$/);
  await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', playerUrl);
});

test('movie link validation rejects foreign hosts, credentials, insecure schemes and invalid IDs', async ({ page }) => {
  const { embeds } = await fixtures(page);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Kinopk movie URL' });
  const invalidLinks = [
    'https://example.com/movie/258687',
    'https://kinopk.web.app.attacker.invalid/movie/258687',
    'https://attacker.invalid/https://kinopk.web.app/movie/258687',
    'https://user:password@kinopk.web.app/movie/258687',
    'http://kinopk.web.app/movie/258687',
    'https://kinopk.web.app:8443/movie/258687',
    'javascript:alert(1)',
    'https://kinopk.web.app/movie/0',
    'https://kinopk.web.app/movie/1234567890123456',
    'https://kinopk.web.app/movie/258687/trailing',
  ];
  for (const link of invalidLinks) {
    await input.fill(link);
    await page.getByRole('button', { name: 'Open player' }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    await expect(page.getByRole('alert')).toContainText('Paste a movie link from kinopk.web.app');
    await expect(page.locator('iframe')).toHaveCount(0);
  }
  expect(embeds).toEqual([]);
});

for (const path of ['movie', 'film', 'embed']) {
  test(`a valid Kinopk ${path} link opens only its public source embed`, async ({ page }) => {
    const { embeds } = await fixtures(page);
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Kinopk movie URL' }).fill(`https://kinopk.web.app/${path}/258687/?ignored=query`);
    await page.getByRole('button', { name: 'Open player' }).click();
    await expect(page).toHaveURL(/\/watch\/258687$/);
    await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', playerUrl);
    await expect.poll(() => embeds.length).toBe(1);
    expect(embeds).toEqual([playerUrl]);
  });
}

test('mobile catalog and watch layouts fit the viewport and support keyboard search', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixtures(page);
  await page.goto('/');
  await expect(page.locator('.movie-card')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const search = page.getByRole('searchbox', { name: 'Search titles' });
  // Reach the form through normal tab navigation, rather than clicking it.
  for (let index = 0; index < 15 && !(await search.evaluate((node) => node === document.activeElement)); index++) await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await page.keyboard.type('Fixture');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(1);
  const card = page.getByRole('link', { name: `Watch ${movie.title}` });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('Kinopk video player')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`fitted source layout preserves controls and provider access at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { embeds, requests } = await fixtures(page, { metadataFailures: 1 });
    await page.goto('/watch/258687');
    await expect(page.frameLocator('iframe').getByText('Local Kinopk embed fixture. No video is loaded.')).toBeVisible();
    const frame = await page.getByTitle('Kinopk video player').elementHandle();
    const source = page.frameLocator('iframe[title="Kinopk video player"]');
    const options = page.locator('#player-options');
    await expect(options).toHaveAccessibleName('Player options');
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expectFittedSurface(page);
    for (const name of ['[Fixture] Soundtrack', '[Fixture] Fullscreen control']) {
      await expectInsidePlayer(page, source.getByRole('button', { name, exact: true }));
      await clickSourceControl(page, source.getByRole('button', { name, exact: true }));
    }
    await expect(source.locator('.fixture-video')).toHaveAttribute('data-audio', 'original');
    await expect(source.locator('.fixture-video')).toHaveAttribute('data-fullscreen', 'requested');

    await options.focus();
    await page.keyboard.press('Enter');
    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await expect(options).toHaveAccessibleName('Back to video');
    const provider = source.getByRole('combobox', { name: '[Fixture] Provider' });
    await expectInsidePlayer(page, provider);
    await clickSourceControl(page, provider);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(provider).toHaveValue('other');
    await options.focus();
    await page.keyboard.press('Space');
    await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expectFittedSurface(page);

    // Exercise the same mounted iframe across the desktop/mobile breakpoint.
    await page.setViewportSize(viewport.width > 650 ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    await expectFittedSurface(page);
    expect(await frame.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', playerUrl);
    expect(embeds).toEqual([playerUrl]);
    expect(requests.some((url) => url.pathname.startsWith('/api/player/'))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('keyboard entry reveals the source toolbar before its provider control receives focus', async ({ page }) => {
  const { embeds } = await fixtures(page);
  await page.goto('/watch/258687');
  const provider = page.frameLocator('iframe').getByRole('combobox', { name: '[Fixture] Provider' });
  await expectFittedSurface(page);
  await page.getByRole('link', { name: 'Back to the catalog' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#player-options')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#player-options')).toHaveAccessibleName('Back to video');
  await expect(provider).toBeFocused();
  await expectInsidePlayer(page, provider);
  await page.keyboard.press('End');
  await expect(provider).toHaveValue('other');
  const options = page.locator('#player-options');
  await options.focus();
  await page.keyboard.press('Space');
  await expect(options).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Shift+Tab');
  await expect(options).toHaveAttribute('aria-expanded', 'true');
  const lastControl = page.frameLocator('iframe').getByRole('button', { name: '[Fixture] Fullscreen control', exact: true });
  await expect(lastControl).toBeFocused();
  await expectInsidePlayer(page, lastControl);
  expect(embeds).toEqual([playerUrl]);
});
