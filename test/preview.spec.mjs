import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { playerFixture, expectFittedSurface, expectInsidePlayer, clickSourceControl } from './player-fixture.mjs';

const preview = new URL('../dist/index.html', import.meta.url);
const playback = new URL('../dist/playback.html', import.meta.url);

for (const mode of ['standalone document', 'HTML visualization']) {
  test(`standalone preview renders and navigates as a ${mode} without a server`, async ({ page }) => {
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const html = await readFile(preview, 'utf8');
    await page.context().route(/^https?:\/\//, (route) => {
      if (route.request().url() === 'https://preview.invalid/index.html' && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      requests.push(route.request().url());
      return route.abort();
    });

    // This environment's managed Chromium blocks file:// navigation. Serve just
    // the one document instead; no companion assets or API server are present.
    if (mode === 'standalone document') await page.goto('https://preview.invalid/index.html');
    else await page.setContent(html);

    await expect(page.getByRole('heading', { name: 'Good stories. In their own voice.' })).toBeVisible();
    await expect(page.locator('#result-summary')).toContainText('Standalone design preview');
    await expect(page.getByRole('heading', { name: 'A first look at your cinema.' })).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 20, 17)');
    await expect(page.locator('.hero h1')).toHaveCSS('font-family', /Georgia/);
    await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Movies' }).click();
    await expect(page.getByLabel('Catalog type').getByRole('link', { name: 'Movies' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Series' }).click();
    await expect(page.getByLabel('Catalog type').getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'page');

    const query = 'Original & מקור + 100%';
    await page.getByRole('searchbox', { name: 'Search titles' }).fill(query);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveValue(query);
    const route = new URL(new URL(page.url()).hash.slice(1), 'https://original.invalid');
    expect(route.searchParams.get('q')).toBe(query);

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Discover' }).click();
    await expect(page.getByRole('heading', { name: 'Find your next watch.' })).toBeVisible();
    await page.getByRole('link', { name: 'Explore the catalog' }).click();
    await expect(page.getByRole('heading', { name: 'Find your next watch.' })).toBeInViewport();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}

for (const mode of ['standalone document', 'HTML visualization']) {
  test(`standalone playback opens only the public source iframe as a ${mode}`, async ({ page }) => {
    const errors = [];
    const requests = [];
    const embeds = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const html = await readFile(playback, 'utf8');
    await page.context().route(/^https?:\/\//, (route) => {
      const request = route.request();
      const url = request.url();
      if (url === 'https://preview.invalid/playback.html' && request.resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      requests.push(url);
      if (/^https:\/\/kinopk\.web\.app\/embed\/[1-9]\d{0,14}$/.test(url) && request.resourceType() === 'document') {
        embeds.push(url);
        return route.fulfill({ contentType: 'text/html', body: playerFixture('Local public embed fixture; no stream loaded.') });
      }
      return route.abort('blockedbyclient');
    });
    if (mode === 'standalone document') await page.goto('https://preview.invalid/playback.html');
    else await page.setContent(html);

    await expect(page.locator('html')).toHaveAttribute('data-initial-route', '/playback');
    await expect(page.getByRole('heading', { name: 'Have a movie link?' })).toBeVisible();
    await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(0);
    expect(requests).toEqual([]);
    await page.getByRole('link', { name: 'Try the movie you shared' }).click();
    await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', 'https://kinopk.web.app/embed/258687');
    await expect(page.frameLocator('iframe').getByText('Local public embed fixture; no stream loaded.')).toBeVisible();
    await expect(page.locator('.watch-audio')).toContainText('NOT APPLIED');
    await expect(page.locator('#announcer')).toContainText('Availability and playback have not been verified');
    expect(embeds).toEqual(['https://kinopk.web.app/embed/258687']);
    await expectFittedSurface(page);
    const options = page.getByRole('button', { name: 'Player options', exact: true });
    await options.click();
    const provider = page.frameLocator('iframe').getByRole('combobox', { name: '[Fixture] Provider' });
    await expectInsidePlayer(page, provider);
    await clickSourceControl(page, provider);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(provider).toHaveValue('other');
    await page.getByRole('button', { name: 'Back to video', exact: true }).click();
    await expectFittedSurface(page);
    expect(embeds).toEqual(['https://kinopk.web.app/embed/258687']);

    await page.getByRole('link', { name: 'Back to the catalog' }).click();
    await expect(page.getByRole('heading', { name: 'A first look at your cinema.' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Kinopk movie URL' }).fill('https://kinopk.web.app/film/12345');
    await page.getByRole('button', { name: 'Open player' }).click();
    await expect(page.getByTitle('Kinopk video player')).toHaveAttribute('src', 'https://kinopk.web.app/embed/12345');
    await expect(page.locator('#player-status')).toContainText('Player requested');
    expect(embeds).toEqual(['https://kinopk.web.app/embed/258687', 'https://kinopk.web.app/embed/12345']);
    expect(requests).toEqual(embeds);
    expect(requests.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
    expect(errors).toEqual([]);
  });
}
