// Copies the Fylgja stylesheets the site uses from node_modules into
// assets/vendor/fylgja/, so the site serves them itself (versions pinned by
// package-lock.json, no third-party CDN at runtime).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets', 'vendor', 'fylgja');
const require = createRequire(import.meta.url);

// Order matters only in the <link> tags (see _layouts/default.html).
const files = {
  'tokens.css': '@fylgja/tokens/css/index.min.css',
  'base.css': '@fylgja/base/index.min.css',
  'theme.css': '@fylgja/base/theme.css',
  'utilities.css': '@fylgja/utilities/index.min.css',
  'card.css': '@fylgja/card/index.min.css',
  'badge.css': '@fylgja/badge/index.min.css',
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, spec] of Object.entries(files)) {
  const [scope, pkg, ...rest] = spec.split('/');
  const pkgDir = dirname(require.resolve(`${scope}/${pkg}/package.json`));
  copyFileSync(join(pkgDir, ...rest), join(out, name));
}
console.log(`Copied ${Object.keys(files).length} Fylgja stylesheets to ${out}`);
