import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [template, css, js, icon] = await Promise.all([
  'public/index.html', 'public/styles.css', 'public/app.js', 'public/icon.svg',
].map((name) => readFile(new URL(name, root), 'utf8')));

function replaceOnce(html, needle, replacement) {
  if (html.split(needle).length !== 2) throw new Error(`Expected exactly one ${needle} in the HTML template.`);
  return html.replace(needle, () => replacement);
}

let standalone = replaceOnce(template, '<html lang="en">', '<html lang="en" data-static-preview="true">');
standalone = replaceOnce(standalone, '<link rel="stylesheet" href="/styles.css">', `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
standalone = replaceOnce(standalone, '<script type="module" src="/app.js"></script>', `<script type="module">\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`);
standalone = replaceOnce(standalone, '<link rel="icon" href="/icon.svg" type="image/svg+xml">', `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}" type="image/svg+xml">`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/index.html', root), standalone);
await writeFile(new URL('dist/playback.html', root), standalone.replace('data-static-preview="true"', 'data-static-preview="true" data-initial-route="/playback"'));
console.log('Built dist/index.html and dist/playback.html — self-contained pages; playback opens the source’s public embed.');
