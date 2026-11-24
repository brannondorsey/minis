// Renders card.html to site/social.jpg (1200x630). Usage: node scripts/social/render.js [dark]
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto('file://' + path.join(__dirname, 'card.html') + (process.argv[2] === 'dark' ? '#dark' : ''));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForLoadState('networkidle');
  await p.locator('.card').screenshot({ type: 'jpeg', quality: 90, path: path.join(__dirname, process.argv[2] === 'dark' ? '../../site/social-dark.jpg' : '../../site/social.jpg') });
  await b.close();
})();
