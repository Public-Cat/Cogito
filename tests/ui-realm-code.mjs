// tests/ui-realm-code.mjs — Visual test: the session-code input must be hidden
// for LAN players (who join without a code) but the name field stays usable.
//
// Loads the real join page through the Caddy LAN vhost (https://cogito.home.arpa,
// realm = lan) in a headless browser and asserts the code box is not shown. This
// is the visual counterpart to tests/join.mjs (which only checks the socket layer
// and can't see the DOM). Requires the local Caddy harness up (deploy/local) and
// cogito.home.arpa resolving to the Caddy host. Needs chromium:
//   npx playwright install chromium
import { chromium } from 'playwright';

const LAN_URL = process.env.COGITO_URL || 'https://cogito.home.arpa';

async function main() {
  console.log('=== UI Test: session-code box hidden for LAN realm (' + LAN_URL + ') ===\n');
  const t = (m) => console.log('  [' + (Date.now() % 100000) + '] ' + m);

  // ignoreHTTPSErrors: Caddy serves a self-signed `tls internal` cert.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    t('Loading join page through Caddy (LAN realm)...');
    await page.goto(LAN_URL, { waitUntil: 'domcontentloaded' });

    // Join panel must render and be usable (name field present & visible).
    await page.waitForSelector('#nameInput', { state: 'visible', timeout: 10000 });
    t('Join panel rendered, name input visible.');

    // The code input exists in the DOM but must be hidden for LAN players. Give
    // the client:hello realm event time to hide it; fail clearly if it stays.
    try {
      await page.waitForSelector('#codeInput', { state: 'hidden', timeout: 5000 });
    } catch {
      const visible = await page.isVisible('#codeInput');
      throw new Error('FAIL: session-code input is ' + (visible ? 'VISIBLE' : 'present')
        + ' for a LAN player — it should be hidden (realm=lan bypasses the code).');
    }
    t('Session-code input is hidden. Good.');

    // Sanity: the player can still join (name input usable, join button present).
    if (!(await page.isVisible('#joinBtn'))) throw new Error('FAIL: join button not visible');
    if (!(await page.isEnabled('#nameInput'))) throw new Error('FAIL: name input not usable');
    t('Name input + join button usable without a code.');

    console.log('\n=== UI REALM-CODE TEST PASSED ===');
    await browser.close();
    process.exit(0);
  } catch (err) {
    await browser.close();
    console.error('\n=== UI REALM-CODE TEST FAILED ===', err.message);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('\n=== UI REALM-CODE TEST FAILED ===', err.message);
  process.exit(1);
});
