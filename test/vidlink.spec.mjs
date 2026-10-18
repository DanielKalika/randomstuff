import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const trial = new URL('../dist/vidlink.html', import.meta.url);
const origin = 'https://vidlink.pro';
const entry = 'https://preview.invalid/vidlink.html';
const frameTitle = 'VidLink video player';

// All provider requests are local fixtures. These tests verify integration and
// layout, and cannot establish real playback, source quality or audio language.
async function standalone(page, hash = '') {
  const html = await readFile(trial, 'utf8');
  const requests = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().route(/^https?:\/\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === entry && request.resourceType() === 'document') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    requests.push(url.href);
    if (url.origin === origin && /^\/(?:movie\/[1-9]\d{0,14}|tv\/[1-9]\d{0,14}\/[1-9]\d{0,3}\/[1-9]\d{0,3})$/.test(url.pathname)
      && request.resourceType() === 'document') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;background:#101820;color:white}body{display:grid;place-items:center}</style></head><body>Local VidLink UI fixture; no media loaded.</body></html>',
      });
    }
    return route.abort('blockedbyclient');
  });
  await page.goto(entry + hash);
  return { requests, errors };
}

async function demo(page) {
  await page.getByRole('button', { name: 'Watch Interstellar', exact: true }).click();
  await expect(page.getByTitle(frameTitle)).toBeVisible();
  await expect(page.frameLocator('iframe').getByText('Local VidLink UI fixture; no media loaded.')).toBeVisible();
}

function eventData(overrides = {}) {
  return {
    type: 'PLAYER_EVENT',
    // The provider's documented field is mtmdbId (including the first m).
    data: { event: 'timeupdate', currentTime: 12, duration: 120, mtmdbId: 157336, mediaType: 'movie', ...overrides },
  };
}

async function providerMessage(page, payload) {
  // Observe delivery after the production listener has handled the message.
  // An unchanged UI assertion must not pass merely because delivery is queued.
  await page.evaluate(() => {
    window.__fixtureMessageDelivered = new Promise((resolve) => {
      window.addEventListener('message', () => resolve(), { once: true });
    });
  });
  await page.frameLocator(`iframe[title="${frameTitle}"]`).locator('body').evaluate((_, message) => {
    parent.postMessage(message, '*');
  }, payload);
  await page.evaluate(async () => {
    await window.__fixtureMessageDelivered;
    delete window.__fixtureMessageDelivered;
  });
}

test('VidLink standalone waits for a title, then opens only its themed TMDB embed', async ({ page }) => {
  const { requests, errors } = await standalone(page);
  await expect(page.getByLabel('TMDB link or ID', { exact: true })).toBeVisible();
  await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  await demo(page);
  expect(new URL(page.url()).hash).toBe('#movie/157336');
  const frame = page.getByTitle(frameTitle);
  const url = new URL(await frame.getAttribute('src'));
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe('/movie/157336');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    primaryColor: 'c0e994', secondaryColor: '2a3229', iconColor: 'f2f2e9',
    icons: 'vid', player: 'default', title: 'false', poster: 'true',
    autoplay: 'false', nextbutton: 'false',
  });
  await expect(frame).toHaveAttribute('allowfullscreen', '');
  await expect(frame).toHaveAttribute('allow', /fullscreen/);
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  const fallback = page.locator('#trial-provider-link');
  await expect(fallback).toHaveAttribute('href', url.href);
  await expect(fallback).toHaveAttribute('target', '_blank');
  await expect(fallback).toHaveAttribute('rel', /noopener/);
  await expect(fallback).toHaveAttribute('rel', /noreferrer/);
  await expect(page.locator('#trial-original-link')).toHaveAttribute('href', './playback.html#/watch/258687');
  await expect(page.locator('#trial-status')).not.toContainText(/playing|4k confirmed/i);
  expect(requests).toEqual([url.href]);
  expect(requests.some((request) => new URL(request).pathname.startsWith('/api/'))).toBe(false);
  expect(errors).toEqual([]);
});

test('VidLink rejects foreign and Kinopk URLs instead of mixing movie ID namespaces', async ({ page }) => {
  const { requests } = await standalone(page);
  const input = page.getByLabel('TMDB link or ID', { exact: true });
  for (const value of [
    'https://kinopk.web.app/movie/258687',
    'https://www.themoviedb.org.attacker.invalid/movie/157336',
    'https://attacker.invalid/https://www.themoviedb.org/movie/157336',
    'https://user:password@www.themoviedb.org/movie/157336',
    'http://www.themoviedb.org/movie/157336',
    'https://www.themoviedb.org:8443/movie/157336',
    'javascript:alert(1)',
    'https://www.themoviedb.org/person/157336',
    'https://www.themoviedb.org/movie/157336/trailing',
    'https://www.themoviedb.org/movie/0',
    'https://www.themoviedb.org/movie/1234567890123456',
    '0', '-1', '157336.5',
  ]) {
    await input.fill(value);
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    await expect(page.locator('iframe')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
  await input.fill('https://www.themoviedb.org/movie/157336-interstellar?primaryColor=ff0000');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const url = new URL(await page.getByTitle(frameTitle).getAttribute('src'));
  expect(url.pathname).toBe('/movie/157336');
  expect(url.searchParams.get('primaryColor')).toBe('c0e994');
});

test('VidLink TV URLs and direct hashes preserve episode identity without backend requests', async ({ page }) => {
  const { requests } = await standalone(page, '#tv/1399/2/3');
  await expect(page.getByTitle(frameTitle)).toHaveAttribute('src', /^https:\/\/vidlink\.pro\/tv\/1399\/2\/3\?/);
  await expect(page.locator('#trial-kind')).toHaveValue('tv');
  await expect(page.locator('#trial-season')).toHaveValue('2');
  await expect(page.locator('#trial-episode')).toHaveValue('3');
  await expect(page.frameLocator('iframe').getByText('Local VidLink UI fixture; no media loaded.')).toBeVisible();
  const seriesEvent = { mtmdbId: 1399, mediaType: 'tv', season: 2, episode: 3 };
  await providerMessage(page, eventData({ ...seriesEvent, episode: 4 }));
  await expect(page.locator('#trial-progress')).toHaveText('');
  await providerMessage(page, eventData(seriesEvent));
  await expect(page.locator('#trial-progress')).toContainText(/provider reported/i);
  await page.getByLabel('TMDB link or ID', { exact: true }).fill('https://themoviedb.org/movie/157336-interstellar');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.locator('#trial-kind')).toHaveValue('movie');
  await expect(page.getByTitle(frameTitle)).toHaveAttribute('src', /^https:\/\/vidlink\.pro\/movie\/157336\?/);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => new URL(request).origin === origin)).toBe(true);
  await expect(page.locator('#trial-original-link')).toHaveAttribute('href', './playback.html#/watch/258687');
  // An invalid deep link must not leave a different title's old player running.
  await page.evaluate(() => { location.hash = '#movie/157336/1/1'; });
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('#trial-title-error')).toContainText('incomplete');
  expect(requests).toHaveLength(2);
});

test('VidLink progress requires the correct frame, origin, title and finite event data', async ({ page }) => {
  await standalone(page);
  await demo(page);
  const progress = page.locator('#trial-progress');
  const initial = await progress.textContent();
  const payload = eventData();
  await page.evaluate((message) => {
    const source = document.querySelector('iframe').contentWindow;
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://attacker.invalid', source, data: message }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://vidlink.pro', source: window, data: message }));
  }, payload);
  for (const invalid of [
    { type: 'MEDIA_DATA', data: payload.data },
    eventData({ event: 'unknown-event' }),
    eventData({ currentTime: -1 }),
    eventData({ currentTime: 122 }),
    eventData({ currentTime: Number.NaN }),
    eventData({ duration: Number.POSITIVE_INFINITY }),
    eventData({ duration: 0 }),
    eventData({ mtmdbId: 258687 }),
    eventData({ mediaType: 'tv' }),
    { type: 'PLAYER_EVENT', data: null },
    'not an object',
  ]) await providerMessage(page, invalid);
  await expect(progress).toHaveText(initial);
  await providerMessage(page, payload);
  await expect(progress).toContainText(/provider reported/i);
  await expect(progress).not.toHaveText(initial);
  await providerMessage(page, eventData({ event: 'play', currentTime: 13 }));
  await expect(page.locator('#trial-status')).toContainText(/playing/i);
  await expect(page.locator('#trial-status')).not.toContainText(/4k|original selected/i);
});

test('VidLink reload clears progress and rejects messages from the removed frame', async ({ page }) => {
  await standalone(page);
  await demo(page);
  const progress = page.locator('#trial-progress');
  const initial = await progress.textContent();
  await providerMessage(page, eventData());
  await expect(progress).not.toHaveText(initial);
  await page.evaluate(() => { window.__oldTrialFrame = document.querySelector('iframe').contentWindow; });
  await page.locator('#trial-reload').click();
  await expect(page.frameLocator('iframe').getByText('Local VidLink UI fixture; no media loaded.')).toBeVisible();
  await expect(progress).toHaveText(initial);
  await page.evaluate((data) => {
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://vidlink.pro', source: window.__oldTrialFrame, data }));
    delete window.__oldTrialFrame;
  }, eventData({ currentTime: 70 }));
  await expect(progress).toHaveText(initial);
  await providerMessage(page, eventData({ currentTime: 15 }));
  await expect(progress).not.toHaveText(initial);
});

test('VidLink appearance settings use documented parameters and reload the current title', async ({ page }) => {
  const { requests } = await standalone(page);
  await demo(page);
  const progress = page.locator('#trial-progress');
  const initial = await progress.textContent();
  await providerMessage(page, eventData());
  await expect(progress).not.toHaveText(initial);
  await page.locator('#trial-appearance summary').click();
  await page.locator('#trial-accent').fill('#47a3ff');
  await page.locator('#trial-icons').selectOption('default');
  await page.locator('#trial-engine').selectOption('jw');
  await page.getByRole('button', { name: 'Apply and reload player', exact: true }).click();
  await expect(progress).toHaveText(initial);
  await expect.poll(() => requests.length).toBe(2);
  const url = new URL(await page.getByTitle(frameTitle).getAttribute('src'));
  expect(url.pathname).toBe('/movie/157336');
  expect(url.searchParams.get('primaryColor')).toBe('47a3ff');
  expect(url.searchParams.get('icons')).toBe('default');
  expect(url.searchParams.get('player')).toBe('jw');
  expect(url.searchParams.get('autoplay')).toBe('false');
  await expect(page.locator('#trial-provider-link')).toHaveAttribute('href', url.href);
});

test('VidLink iframe fills its player bounds on desktop and mobile with no page overflow', async ({ page }) => {
  await standalone(page, '#movie/157336');
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTitle(frameTitle)).toBeVisible();
    await expect.poll(async () => page.getByTitle(frameTitle).evaluate((frame) => {
      const inner = frame.getBoundingClientRect();
      const outer = frame.parentElement.getBoundingClientRect();
      return Math.max(Math.abs(inner.x - outer.x), Math.abs(inner.y - outer.y), Math.abs(inner.right - outer.right), Math.abs(inner.bottom - outer.bottom));
    })).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
