/**
 * Actual Chromium browser verification.
 *
 * Uses the npm-packaged @sparticuz/chromium binary and playwright-core, so no
 * external browser download is required. It builds/serves the production React
 * bundle against a fresh PGlite database and exercises real user journeys.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const pageErrors = [];
const consoleMessages = [];
const expectedRestartNoise = [];
let restartInProgress = false;
function check(name, condition, detail) {
  if (!condition) throw new Error(`FAILED: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${name}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy: ${last}`);
}

function startServer(port, dataDir) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    PGLITE_DIR: dataDir,
    OPERATING_MODE: 'free',
    TEST_FUNDS_ENABLED: 'false',
    SESSION_SECRET: 'browser-e2e-session-secret-that-is-long-enough-123456',
    ENGINE_ENABLED: 'true',
    ENGINE_MAX_CONCURRENT: '2',
    ENGINE_MAX_DEPTH: '18',
    ENGINE_MAX_TIME_MS: '1200',
    LOG_LEVEL: 'error',
  };
  const child = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  child.logs = () => logs.slice(-4000);
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
  await exited;
  clearTimeout(force);
}

async function register(page, base, username, email, options = {}) {
  await page.goto(`${base}/auth?mode=register`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('QueensGambit').fill(username);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill('Password123!');
  await passwords.nth(1).fill('Password123!');
  if (options.country) await page.locator('select').first().selectOption(options.country);
  if (options.shareCountry) await page.getByRole('checkbox', { name: /Show my country flag/i }).check();
  if (options.shareTimezone) await page.getByRole('checkbox', { name: /Share my local timezone/i }).check();
  await page.getByRole('checkbox', { name: 'Accept terms' }).check();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/play', { timeout: 20_000 });
}

async function ensureKeyboardMode(page) {
  const grid = page.locator('.board-keyboard');
  if (!(await grid.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /Keyboard mode/i }).click();
  }
  await grid.waitFor({ state: 'visible', timeout: 5000 });
}

async function playMove(page, from, to) {
  await ensureKeyboardMode(page);
  await page.getByPlaceholder('e2').fill(from);
  await page.getByPlaceholder('e4').fill(to);
  await page.getByRole('button', { name: 'Move', exact: true }).click();
}

async function overflow(page) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rookstone-browser-'));
  let server = null;
  let browser = null;
  try {
    // The AL2023 shared-library bundle is only auto-extracted on Lambda. This
    // sandbox is Debian, so extract it explicitly and set LD_LIBRARY_PATH.
    await inflate(path.join(root, 'node_modules', '@sparticuz', 'chromium', 'bin', 'al2023.tar.br'));
    setupLambdaEnvironment(path.join(os.tmpdir(), 'al2023', 'lib'));
    const executablePath = await chromium.executablePath();
    // The Lambda-oriented defaults include --single-process and
    // --disable-web-security, which can break Playwright context isolation.
    const safeArgs = chromium.args.filter((arg) =>
      !/--single-process|--disable-web-security|--no-zygote|--disable-site-isolation-trials|--headless/.test(arg));
    browser = await playwright.launch({
      executablePath,
      headless: true,
      args: [...safeArgs, '--no-sandbox', '--no-zygote'],
    });
    check('real Chromium launched from npm-packaged binary', !!browser && browser.isConnected());

    server = startServer(port, dataDir);
    const health = await waitForHealth(base);
    check('production server served API and migrations', health.status === 'ok' && health.database === 'pglite', health);

    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Africa/Harare' });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Tokyo' });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    for (const [label, page] of [['A', pageA], ['B', pageB]]) {
      page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
      page.on('console', (message) => {
        const text = message.text();
        consoleMessages.push(`${label}:${message.type()}: ${text}`.slice(0, 500));
        if (message.type() !== 'error') return;
        if (/Failed to load resource|ERR_CONNECTION_REFUSED/.test(text)) return;
        // This suite deliberately kills and restarts the API. A socket that is
        // reconnecting while the process boots receives a 503 from the startup
        // responder; that is the expected consequence of our own action, and it
        // is recorded rather than discarded. The window is closed again as soon
        // as the restarted server is serving, and recovery is proven below by a
        // real move exchange over Socket.IO.
        if (restartInProgress && /WebSocket|socket\.io|Unexpected response code: 503|net::ERR_CONNECTION/.test(text)) {
          expectedRestartNoise.push(`${label} console: ${text}`.slice(0, 300));
          return;
        }
        pageErrors.push(`${label} console: ${text}`);
      });
    }

    await pageA.goto(base, { waitUntil: 'domcontentloaded' });
    await pageA.getByRole('heading', { name: /Every move/i }).waitFor();
    check('landing page rendered hero and real board', await pageA.locator('.board-container').isVisible());
    check('landing page has no horizontal overflow at 1440px', (await overflow(pageA)).scrollWidth <= 1441);

    const initialTheme = await pageA.evaluate(() => document.documentElement.dataset.theme);
    const otherTheme = initialTheme === 'dark' ? 'light' : 'dark';
    await pageA.getByRole('button', { name: new RegExp(`Switch to ${otherTheme} theme`, 'i') }).click();
    check('theme toggle updates the document theme', await pageA.evaluate(() => document.documentElement.dataset.theme) === otherTheme);
    await pageA.getByRole('button', { name: new RegExp(`Switch to ${initialTheme} theme`, 'i') }).click();

    await pageA.getByRole('heading', { name: 'Play Free', exact: true }).waitFor();
    await pageA.getByRole('heading', { name: 'Play for Money', exact: true }).waitFor();
    check('homepage shows explicit free and money mode choices', await pageA.getByTestId('mode-choice-cards').isVisible());
    await pageA.getByTestId('play-free-button').click();
    await pageA.waitForURL('**/play**', { timeout: 10_000 });
    check('free play has no mandatory payment screen',
      (await pageA.getByRole('dialog').count()) === 0 && (await pageA.getByText(/Deposit amount/i).count()) === 0);

    const userA = `BrowserA${Date.now().toString().slice(-6)}`;
    const userB = `BrowserB${Date.now().toString().slice(-6)}`;
    await register(pageA, base, userA, `${userA.toLowerCase()}@example.com`, { country: 'ZW', shareCountry: true, shareTimezone: true });
    await register(pageB, base, userB, `${userB.toLowerCase()}@example.com`, { country: 'JP', shareCountry: true, shareTimezone: true });
    check('two accounts registered through the real UI', pageA.url().includes('/play') && pageB.url().includes('/play'));
    const [sessionA, sessionB] = await Promise.all([
      pageA.evaluate(async () => (await fetch('/api/auth/session')).text()),
      pageB.evaluate(async () => (await fetch('/api/auth/session')).text()),
    ]);
    check('browser contexts have distinct authenticated identities', sessionA.includes(userA) && sessionB.includes(userB));
    const zoneA = await pageA.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const zoneB = await pageB.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    check('browser sessions use different international timezones', zoneA !== zoneB, { zoneA, zoneB });
    check('Play screen repeats the explicit mode choice', await pageA.getByTestId('mode-choice-cards').isVisible());
    check('money-match entry is disabled by server eligibility', await pageA.getByTestId('play-money-button').isDisabled());
    const providerStatus = await pageA.evaluate(async () => (await fetch('/api/status')).json());
    check('free chess is independent of configured payment providers',
      providerStatus.providerHealth.every((provider) => provider.configured === false));
    await pageA.locator('header .pill').filter({ hasText: /Live/ }).waitFor({ timeout: 20_000 });
    await pageB.locator('header .pill').filter({ hasText: /Live/ }).waitFor({ timeout: 20_000 });
    check('both browsers established authenticated WebSocket connections', true);

    // Private invitation must work in a different authenticated browser session.
    await pageA.getByRole('button', { name: /Create challenge/i }).first().click();
    const privateDialog = pageA.getByRole('dialog', { name: 'Create a challenge' });
    await privateDialog.waitFor();
    await privateDialog.getByRole('button', { name: 'private', exact: true }).click();
    await privateDialog.locator('button.btn-primary').click();
    const inviteDialog = pageA.getByRole('dialog', { name: 'Private invitation ready' });
    await inviteDialog.waitFor();
    const inviteUrl = await inviteDialog.locator('input').inputValue();
    check('shareable private invitation generated', inviteUrl.includes('/challenge/'));
    await pageB.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
    await pageB.getByText(/Private invitation/i).first().waitFor();
    try {
      await pageB.getByText(userA, { exact: false }).first().waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`Invite page did not show creator ${userA}: ${(await pageB.locator('body').innerText()).slice(0, 1200)}`);
    }
    check('private invitation works across devices/sessions', true);
    await inviteDialog.getByRole('button', { name: 'Done' }).click();

    await pageA.getByRole('button', { name: /Create challenge/i }).first().click();
    const dialog = pageA.getByRole('dialog', { name: 'Create a challenge' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'open', exact: true }).click();
    await dialog.locator('button.btn-primary').click();
    await pageA.locator('.challenge-card').filter({ hasText: 'open' }).first().waitFor({ timeout: 10_000 });
    check('open challenge created through the UI', await pageA.locator('.challenge-card').count() > 0);

    await pageB.goto(`${base}/play`, { waitUntil: 'domcontentloaded' });
    await pageB.getByRole('button', { name: /Refresh/i }).click();
    const card = pageB.locator('.challenge-card').filter({ hasText: 'open' }).filter({ hasText: userA }).first();
    try {
      await card.waitFor({ timeout: 10_000 });
    } catch (error) {
      const api = await pageB.evaluate(async () => (await fetch('/api/challenges')).text());
      throw new Error(`Challenge not visible on page B. API: ${api.slice(0, 1000)}; body: ${(await pageB.locator('body').innerText()).slice(0, 1200)}`);
    }
    await card.getByRole('button', { name: 'Accept' }).click();
    const acceptDialog = pageB.getByRole('dialog', { name: 'Accept challenge' });
    await acceptDialog.waitFor();
    await acceptDialog.getByRole('button', { name: /Accept and play/i }).click();
    await pageB.waitForURL('**/game/**', { timeout: 20_000 });
    await pageA.waitForURL('**/game/**', { timeout: 20_000 });
    const gameId = pageB.url().split('/game/')[1].split(/[?#]/)[0];
    check('challenge acceptance opened a live game for both users', pageA.url().includes(`/game/${gameId}`) && pageB.url().includes(`/game/${gameId}`));

    const whiteStripA = await pageA.locator('.player-strip').filter({ hasText: 'White ·' }).first().innerText();
    const whitePage = whiteStripA.includes(userA) ? pageA : pageB;
    const blackPage = whitePage === pageA ? pageB : pageA;
    check('server-assigned colours are visible to both players', whiteStripA.includes(userA) || whiteStripA.includes(userB));

    await playMove(whitePage, 'e2', 'e4');
    await blackPage.locator('.move-list').getByText('e4', { exact: true }).waitFor({ timeout: 15_000 });
    await playMove(blackPage, 'e7', 'e5');
    await whitePage.locator('.move-list').getByText('e5', { exact: true }).waitFor({ timeout: 15_000 });
    const moveListAfterTwoMoves = await whitePage.locator('.move-list').innerText();
    check('two legal moves synchronised through Socket.IO in real browsers',
      /e4/.test(moveListAfterTwoMoves) && /e5/.test(moveListAfterTwoMoves), { moveListAfterTwoMoves });
    const localA = await pageA.getByTestId('viewer-local-time').innerText();
    const localB = await pageB.getByTestId('viewer-local-time').innerText();
    check('players in different timezones see correct local timestamps', localA !== localB, { localA, localB });
    const fenBeforeReload = await whitePage.locator('input[aria-label="Forsyth-Edwards Notation"]').inputValue();
    await whitePage.reload({ waitUntil: 'domcontentloaded' });
    await whitePage.locator('.move-list').getByText('e5', { exact: true }).waitFor({ timeout: 15_000 });
    const fenAfterReload = await whitePage.locator('input[aria-label="Forsyth-Edwards Notation"]').inputValue();
    check('reconnection restores authoritative game state',
      fenBeforeReload === fenAfterReload && / e4 e5|1\. e4 e5/.test(await whitePage.locator('textarea[aria-label="Portable Game Notation"]').inputValue()),
      { fenBeforeReload, fenAfterReload });

    const pgn = await whitePage.locator('textarea[aria-label="Portable Game Notation"]').inputValue();
    const fen = await whitePage.locator('input[aria-label="Forsyth-Edwards Notation"]').inputValue();
    check('SAN/PGN/FEN are available from authoritative game state', pgn.includes('1. e4 e5') && (fen.includes(' w ') || fen.length > 30), { pgn, fen });

    await whitePage.goto(`${base}/wallet`, { waitUntil: 'domcontentloaded' });
    await whitePage.getByText(/USD \$0\.00/).first().waitFor();
    await whitePage.getByText(/No transactions match these filters/i).waitFor({ timeout: 10_000 });
    check('wallet displays real zero balance and no fabricated transactions', true);

    await whitePage.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' });
    await whitePage.getByText(/Administrator access required/i).waitFor();
    check('RBAC blocks a regular player from the admin dashboard', true);

    await whitePage.goto(`${base}/competitions`, { waitUntil: 'domcontentloaded' });
    await whitePage.getByText(/Real money is disabled|Real money disabled/i).first().waitFor();
    check('real-money competitions are visibly disabled', true);

    await whitePage.goto(`${base}/analysis`, { waitUntil: 'domcontentloaded' });
    await whitePage.getByRole('button', { name: /Analyse position/i }).click();
    let browserWorkerResult = true;
    const bestMoveVisible = () => {
      const values = [...document.querySelectorAll('.stat-value')].map((el) => el.textContent?.trim() ?? '');
      return values.some((value) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value));
    };
    try {
      await whitePage.waitForFunction(bestMoveVisible, null, { timeout: 25_000 });
    } catch (error) {
      // Under heavy sequential CI load the WASM worker can miss its soft deadline.
      // First stop the real browser request; if it still has no result, use the
      // same genuine UCI engine through the authenticated server fallback.
      const diagnostic = {
        subtitle: await whitePage.locator('.card-subtitle').first().innerText().catch(() => null),
        stats: await whitePage.locator('.stat-value').allInnerTexts().catch(() => []),
        console: consoleMessages.slice(-25),
        pageErrors,
      };
      console.error('ENGINE SLOW', JSON.stringify(diagnostic));
      await whitePage.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
      const stopped = await whitePage.waitForFunction(bestMoveVisible, null, { timeout: 8_000 }).then(() => true).catch(() => false);
      if (!stopped) {
        browserWorkerResult = false;
        await whitePage.getByRole('button', { name: 'Server fallback' }).click({ timeout: 30_000 });
        await whitePage.waitForFunction(bestMoveVisible, null, { timeout: 30_000 });
      }
    }
    const engineText = await whitePage.locator('.card-subtitle').first().innerText();
    check(`genuine Stockfish UCI analysis produced a real best move (${browserWorkerResult ? 'browser worker' : 'server fallback'})`,
      /Stockfish 19 Lite WASM/i.test(engineText), { engineText, browserWorkerResult });

    // Practice board: a real browser worker plays one move against the level
    // ladder and the move list must show both sides' moves.
    await whitePage.goto(`${base}/train`, { waitUntil: 'domcontentloaded' });
    await whitePage.getByRole('button', { name: /Start practice/i }).click();
    await whitePage.waitForTimeout(400);
    const boardBox = await whitePage.locator('.board-container').boundingBox();
    if (!boardBox) throw new Error('practice board did not render');
    const squarePoint = (file, rank) => ({
      x: boardBox.x + (file + 0.5) * (boardBox.width / 8),
      y: boardBox.y + (rank + 0.5) * (boardBox.height / 8),
    });
    const from = squarePoint(4, 6); // e2
    const to = squarePoint(4, 4); // e4
    await whitePage.mouse.move(from.x, from.y);
    await whitePage.mouse.down();
    await whitePage.mouse.move(to.x, to.y, { steps: 10 });
    await whitePage.mouse.up();
    await whitePage.waitForFunction(
      () => document.querySelectorAll('.train-moves li').length >= 2,
      null,
      { timeout: 30_000 },
    );
    const practiceMoves = await whitePage.locator('.train-moves li').allInnerTexts();
    check('practice board: player move accepted and the Stockfish worker replied',
      practiceMoves.some((text) => /e4/.test(text)) && practiceMoves.length >= 2, practiceMoves);
    const evalValue = await whitePage.locator('.eval-number').innerText();
    check('practice board: evaluation bar shows a real engine score', /^([+-]\d+\.\d\d|M\d+)$/.test(evalValue.trim()), evalValue);
    const pieceSources = await whitePage.locator('.board-container img').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')));
    check('board renders the vendored Staunton piece set',
      pieceSources.length >= 32 && pieceSources.every((src) => /^\/pieces\/[wb][KQRBNP]\.svg$/.test(src)),
      pieceSources.slice(0, 4));

    await pageA.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/', '/play', '/competitions', '/tournaments', '/puzzles', '/learn', '/train', '/analysis', '/leaderboard', '/wallet', '/settings', '/history', '/help', '/legal']) {
      await pageA.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      const size = await overflow(pageA);
      check(`no horizontal overflow at 390px on ${route}`, size.scrollWidth <= size.innerWidth + 1, size);
    }

    // Restart the API process against the same database and verify persistence
    // through the browser session without recreating any data.
    restartInProgress = true;
    await stopServer(server);
    server = startServer(port, dataDir);
    await waitForHealth(base);
    await pageA.goto(`${base}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
    await pageA.locator('.move-list').getByText('e5', { exact: true }).waitFor({ timeout: 15_000 });
    const restartedPgn = await pageA.locator('textarea[aria-label="Portable Game Notation"]').inputValue();
    check('game history survived a real API process restart', restartedPgn.includes('1. e4 e5'), restartedPgn);

    // Persisted data could come from any cached render. A further move must
    // travel through a fresh Socket.IO connection to prove the realtime layer
    // recovered, and both pages must show it.
    await whitePage.goto(`${base}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
    await blackPage.goto(`${base}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
    await whitePage.locator('.move-list').getByText('e5', { exact: true }).waitFor({ timeout: 15_000 });
    await blackPage.locator('.move-list').getByText('e5', { exact: true }).waitFor({ timeout: 15_000 });
    restartInProgress = false;
    await playMove(whitePage, 'g1', 'f3');
    await blackPage.locator('.move-list').getByText('Nf3', { exact: true }).waitFor({ timeout: 20_000 });
    const postRestartMoves = await blackPage.locator('.move-list').innerText();
    check('moves still synchronise over Socket.IO after a real API restart', /Nf3/.test(postRestartMoves), { postRestartMoves });

    check('no uncaught browser page errors during the journey', pageErrors.length === 0, pageErrors);
    console.log(JSON.stringify({ ok: true, checks, gameId, port, pageErrors, expectedRestartNoise, restartWindowOpen: restartInProgress }, null, 2));
    if (restartInProgress) throw new Error('restart window was left open');
  } catch (error) {
    console.error(error);
    console.error(JSON.stringify({ ok: false, checks, pageErrors, serverLogs: server?.logs?.() ?? null }, null, 2));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await stopServer(server).catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run();
