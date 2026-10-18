import { expect } from '@playwright/test';

// Structural source-page fixture, based on its observed toolbar, 900px player
// limit and 16:9 surface. It has no media, provider script or external assets.
export function playerFixture(message) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Source player layout fixture</title><style>
    *{box-sizing:border-box}html,body{margin:0;background:#302c33;color:white;font:14px sans-serif}
    .fixture-toolbar{height:129px;max-width:900px;margin:auto;position:relative}
    .fixture-toolbar label{position:absolute;left:10px;top:52px;font-size:12px}
    .fixture-toolbar select{position:absolute;left:10px;top:74px;width:180px;height:39px}
    .fixture-video{position:relative;width:100%;max-width:900px;aspect-ratio:16/9;margin:auto;background:#101820;overflow:hidden}
    .fixture-video p{position:absolute;inset:40% 20px auto;text-align:center;margin:0}
    .fixture-video button{position:absolute;max-width:calc(100% - 20px);height:32px;border:0;border-radius:3px;padding:6px 10px}
    .fixture-audio{top:10px;left:10px}.fixture-fullscreen{bottom:10px;right:10px}
  </style></head><body><div class="fixture-toolbar"><label for="fixture-provider">[Fixture] Provider</label><select id="fixture-provider"><option value="alloha">Alloha (fixture)</option><option value="other">Other (fixture)</option></select></div><div class="fixture-video"><p>${message}</p><button class="fixture-audio" type="button" aria-label="[Fixture] Soundtrack">Fixture soundtrack</button><button class="fixture-fullscreen" type="button" aria-label="[Fixture] Fullscreen control">Fixture fullscreen</button></div><script>
    document.querySelector('.fixture-audio').addEventListener('click',()=>document.querySelector('.fixture-video').dataset.audio='original');
    document.querySelector('.fixture-fullscreen').addEventListener('click',()=>document.querySelector('.fixture-video').dataset.fullscreen='requested');
  </script></body></html>`;
}

async function renderedSourceBox(page, locator) {
  const [frame, local] = await Promise.all([
    page.getByTitle('Kinopk video player').evaluate((node) => {
      const box = node.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { x: box.x, y: box.y, scaleX: matrix.a, scaleY: matrix.d };
    }),
    locator.evaluate((node) => node.getBoundingClientRect().toJSON()),
  ]);
  // Chromium/Playwright reports child locator.boundingBox() without the parent
  // iframe's CSS scale. Project the actual child DOM rectangle through the
  // browser's computed transform; no production crop constants are used here.
  return {
    x: frame.x + local.x * frame.scaleX,
    y: frame.y + local.y * frame.scaleY,
    width: local.width * frame.scaleX,
    height: local.height * frame.scaleY,
  };
}

export async function expectFittedSurface(page) {
  const surface = page.frameLocator('iframe[title="Kinopk video player"]').locator('.fixture-video');
  await expect.poll(async () => {
    const [outer, inner] = await Promise.all([page.locator('#player-area').boundingBox(), renderedSourceBox(page, surface)]);
    if (!outer || !inner) return Infinity;
    return Math.max(
      Math.abs(outer.x - inner.x), Math.abs(outer.y - inner.y),
      Math.abs(outer.x + outer.width - inner.x - inner.width),
      Math.abs(outer.y + outer.height - inner.y - inner.height),
    );
  }, { message: 'The fixture video surface should fill the designed player bounds on every edge.' }).toBeLessThanOrEqual(2);
}

export async function expectInsidePlayer(page, locator) {
  const [outer, control] = await Promise.all([page.locator('#player-area').boundingBox(), renderedSourceBox(page, locator)]);
  expect(outer).not.toBeNull();
  expect(control).not.toBeNull();
  expect(control.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(control.y).toBeGreaterThanOrEqual(outer.y - 1);
  expect(control.x + control.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(control.y + control.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

export async function clickSourceControl(page, locator) {
  await page.locator('#player-area').scrollIntoViewIfNeeded();
  await expectInsidePlayer(page, locator);
  const box = await renderedSourceBox(page, locator);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
