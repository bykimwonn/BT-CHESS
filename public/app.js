// chess.js is loaded by a <script type="module"> in index.html, which runs
// before this deferred classic script. If it is missing, say so loudly.
if (typeof Chess === 'undefined') {
  console.error('[BetChess] chess.js failed to load from /vendor/chess.js - run `npm run vendor`');
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('board');
    if (el) el.innerHTML = '<div class="game-overlay">chess.js failed to load.<br>Run <code>npm install &amp;&amp; npm run vendor</code> and reload.</div>';
  });
}

const socket = io();
let userId = localStorage.getItem('chessUserId');
let username = localStorage.getItem('chessUsername') || '';
let user = null;

let chess = new Chess();
let currentGame = null;
let currentMode = 'engine';
let boardOrientation = 'white';
let selectedSquare = null;
let legalMoves = [];
let hintMove = null;
let isSpectator = false;

let difficultyConfig = {};
let jackpotPool = 0;
let leaderboard = [];
let selectedDifficulty = 'medium';
let isSearchingMatch = false;
let currentSearchBet = null;
let lastRatingDelta = null;
let lobbies = [];

// Stockfish analysis (browser worker with server fallback)
let engineClient = null;
let evalThrottleTimer = null;
let currentEval = { score: 0, text: '0.0 — equal position', depth: 0, pv: '' };
let analysisEnabled = true;

// Puzzles
let currentPuzzle = null;
let puzzleChess = new Chess();
let puzzleSelected = null;
let puzzleLegal = [];

if (!username) {
  username = 'Player_' + Math.floor(Math.random() * 9000 + 1000);
  localStorage.setItem('chessUsername', username);
}

// ============ BOARD THEMES ============
const BOARD_THEMES = [
  { id: 'classic', label: 'Classic',  light: '#ebecd0', dark: '#739552', frame: 'rgba(15,23,42,0.7)' },
  { id: 'walnut',  label: 'Walnut',   light: '#ead7c3', dark: '#a0714f', frame: 'rgba(35,22,14,0.75)' },
  { id: 'ocean',   label: 'Ocean',    light: '#dde7f0', dark: '#4e6e8e', frame: 'rgba(12,26,42,0.75)' },
  { id: 'carbon',  label: 'Carbon',   light: '#3d4759', dark: '#222b3a', frame: 'rgba(8,12,20,0.8)' },
  { id: 'royal',   label: 'Royal',    light: '#e7def0', dark: '#7d6ba8', frame: 'rgba(24,18,40,0.75)' },
];
let boardTheme = localStorage.getItem('boardTheme') || 'classic';

function applyBoardTheme() {
  const t = BOARD_THEMES.find((x) => x.id === boardTheme) || BOARD_THEMES[0];
  document.querySelectorAll('.chess-board').forEach((b) => {
    b.dataset.theme = t.id;
    b.style.setProperty('--sq-light', t.light);
    b.style.setProperty('--sq-dark', t.dark);
  });
  document.querySelectorAll('.board-frame').forEach((f) => {
    f.style.setProperty('--board-frame', t.frame);
    f.style.background = t.frame;
  });
}
function cycleBoardTheme() {
  const i = BOARD_THEMES.findIndex((x) => x.id === boardTheme);
  boardTheme = BOARD_THEMES[(i + 1) % BOARD_THEMES].id;
  localStorage.setItem('boardTheme', boardTheme);
  applyBoardTheme();
  toast(`Board: ${BOARD_THEMES.find((x) => x.id === boardTheme).label}`, 'info');
}

// ============ PIECES ============
const pieceSrc = (color, type) => `/pieces/${color}${type.toUpperCase()}.svg`;

// ============ SOCKET LIFECYCLE ============
socket.on('connect', () => socket.emit('register', { userId, username }));

socket.on('registered', ({ userId: uid, user: u, difficultyConfig: cfg, jackpotPool: jp, leaderboard: lb }) => {
  userId = uid;
  user = u;
  if (cfg) difficultyConfig = cfg;
  if (jp != null) jackpotPool = jp;
  if (lb) leaderboard = lb;
  localStorage.setItem('chessUserId', uid);
  const $ = (id) => document.getElementById(id);
  $('userIdDisplay').value = uid;
  $('usernameInput').value = u.username;
  $('headerAvatar').textContent = u.username[0].toUpperCase();
  $('whiteAvatar').textContent = u.username[0].toUpperCase();
  $('whiteName').firstChild.textContent = u.username + ' ';
  updateBalance(u.balance);
  updateTransactions(u.transactions || []);
  updateStats(u.stats || {});
  updateRatingUI();
  renderDifficultyGrids();
  updateBetCalculation();
  updateJackpot();
  renderMiniLeaderboard();
  applyBoardTheme();
  coachGreet(u);
  // Deep-link: invite link (?invite=) or spectator link (?game=)
  handleUrlInvite();
});

socket.on('balanceUpdate', ({ balance }) => { if (user) user.balance = balance; updateBalance(balance); });
socket.on('transactionUpdate', (txs) => updateTransactions(txs));
socket.on('statsUpdate', (stats) => { updateStats(stats); updateRatingUI(); });
socket.on('jackpotUpdate', ({ pool }) => { jackpotPool = pool; updateJackpot(); });
socket.on('leaderboardUpdate', ({ leaderboard: lb }) => { leaderboard = lb || []; renderMiniLeaderboard(); renderFullLeaderboard(); });
socket.on('ratingUpdate', ({ rating, delta, ratedGames }) => {
  if (!user) return;
  user.rating = rating;
  user.stats = user.stats || {};
  user.stats.rating = rating;
  user.stats.ratedGames = ratedGames;
  lastRatingDelta = delta;
  updateRatingUI();
  if (delta !== 0) {
    toast(`Rating ${delta > 0 ? '+' : ''}${delta} → ${rating}${ratedGames < 25 ? '?' : ''}`, delta > 0 ? 'success' : delta < 0 ? 'error' : 'info');
  }
});

socket.on('paymentUpdate', (tx) => {
  if (!tx) return;
  updateTransactions(user && user.transactions ? user.transactions : []);
  if (['completed', 'failed', 'expired', 'rejected', 'cancelled'].includes(tx.status)) {
    toast(`${tx.type === 'deposit' ? 'Deposit' : 'Withdrawal'} ${tx.status} · $${Number(tx.amount).toFixed(2)}`, tx.status === 'completed' ? 'success' : 'error');
    if (tx.status === 'completed') socket.emit('getBalance', { userId });
  }
});
socket.on('paymentProviders', ({ providers }) => { if (providers) paymentProviders = providers.filter((p) => p.id !== 'mock'); });

// ============ MATCHMAKING (quick match) ============
socket.on('searchingMatch', ({ bet, queuePosition, message }) => {
  isSearchingMatch = true;
  currentSearchBet = bet;
  document.getElementById('searchStatus').style.display = 'flex';
  document.getElementById('searchText').textContent = message;
  document.getElementById('findMatchBtn').disabled = true;
  refreshLiveStats(bet, queuePosition);
});
socket.on('matchFound', ({ game, opponent }) => {
  isSearchingMatch = false;
  document.getElementById('searchStatus').style.display = 'none';
  document.getElementById('findMatchBtn').disabled = false;
  toast(`Matched vs ${opponent} — good luck!`, 'success');
  enterGame(game);
  switchRightTab('game');
});
socket.on('noMatchFound', ({ suggestion }) => {
  document.getElementById('searchSub').textContent = suggestion || 'No opponent at this stake yet — try the engine or a friend invite.';
});
socket.on('searchCancelled', () => {
  isSearchingMatch = false;
  currentSearchBet = null;
  document.getElementById('searchStatus').style.display = 'none';
  document.getElementById('findMatchBtn').disabled = false;
});
socket.on('gameStarted', ({ game }) => enterGame(game));
socket.on('moveMadePvp', ({ game, move }) => {
  currentGame = game;
  chess.load(game.fen);
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
  const who = game.moves.length % 2 === 1 ? game.white.username : game.black.username;
  addChatMsg(`${who} played ${move.san}`, 'system');
});
socket.on('gameOverPvp', ({ game }) => {
  currentGame = game;
  chess.load(game.fen);
  renderBoard(); renderGameInfo(); syncTurnBars();
  showGameOverPvp(game);
});

// ============ FRIEND INVITES ============
socket.on('lobbyUpdate', ({ lobbies: list }) => {
  lobbies = list || [];
  renderLobby();
});
socket.on('friendGameStarted', ({ game, opponent }) => {
  toast(`Friend game started vs ${opponent}`, 'success');
  closeModal('shareModal');
  enterGame(game);
  switchRightTab('game');
});
socket.on('inviteCancelled', () => renderLobby());

// Draw offers
socket.on('drawOffered', ({ by }) => {
  if (isSpectator) return;
  const accept = window.confirm(`${by} offers a draw. Accept?`);
  socket.emit('respondDraw', { userId, gameId: currentGame?.id, accept });
});
socket.on('drawDeclined', ({ by }) => toast(`${by} declined the draw`, 'info'));

// ============ ENGINE GAMES ============
socket.on('engineGameCreated', ({ game }) => {
  currentGame = game;
  isSpectator = false;
  chess.load(game.fen);
  boardOrientation = game.playerColor === 'w' ? 'white' : 'black';
  selectedSquare = null; legalMoves = []; hintMove = null;
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
  toast(`vs ${game.difficultyConfig?.label || 'engine'} started — ${game.isFree ? 'free practice' : 'stake $' + game.bet}`, 'success');
  if (game.turn !== game.playerColor) showEngineThinking(game.difficultyConfig?.label);
  requestEvaluation(game.fen);
});
socket.on('moveMadeEngine', ({ game, engine: eng }) => {
  currentGame = game;
  chess.load(game.fen);
  hideEngineThinking();
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
  if (eng?.depth) document.getElementById('engineDepth').textContent = `depth ${eng.depth}`;
  requestEvaluation(game.fen);
});
socket.on('engineThinking', ({ difficulty }) => showEngineThinking(difficulty));

function showEngineThinking(label) {
  const el = document.getElementById('engineThinking');
  if (!el) return;
  el.style.display = 'flex';
  const t = el.querySelector('#thinkingText');
  if (t) t.textContent = `${label || 'Engine'} thinking…`;
}
function hideEngineThinking() { const el = document.getElementById('engineThinking'); if (el) el.style.display = 'none'; }

socket.on('engineGameFinal', (data) => {
  currentGame = data.game;
  chess.load(data.game.fen);
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
  showEngineOver(data.result, data.outcome, data.payout, data.multiplier, data.game);
});

// ============ SPECTATING ============
socket.on('spectating', ({ game, spectators }) => {
  isSpectator = true;
  currentGame = game;
  chess.load(game.fen);
  boardOrientation = 'white';
  selectedSquare = null; legalMoves = [];
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
  document.getElementById('blackStatus').textContent = `Spectating · ${spectators} watching`;
  document.getElementById('whiteStatus').textContent = 'Live broadcast';
  toast(`Spectating ${game.id}`, 'info');
});
socket.on('spectatorJoined', ({ count }) => {
  const el = document.getElementById('blackStatus');
  if (el && currentGame) el.textContent = `${count} spectators watching · live`;
});
socket.on('chatMessage', ({ username: u, message }) => addChatMsg(`${u}: ${message}`, 'user'));

// ============ CLOCKS ============
socket.on('clockUpdate', ({ clocks, turn }) => {
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const w = document.getElementById('whiteTimer');
  const b = document.getElementById('blackTimer');
  if (w && clocks.w != null) {
    w.textContent = fmt(clocks.w);
    w.classList.toggle('low', clocks.w <= 30);
    w.classList.toggle('active', turn === 'w');
  }
  if (b && clocks.b != null) {
    b.textContent = fmt(clocks.b);
    b.classList.toggle('low', clocks.b <= 30);
    b.classList.toggle('active', turn === 'b');
  }
});

// ============ UI HELPERS ============
function enterGame(game) {
  currentGame = game;
  isSpectator = false;
  chess.load(game.fen);
  const myColor = game.playerColor || (game.white && game.white.id === userId ? 'w' : 'b');
  boardOrientation = myColor === 'w' ? 'white' : 'black';
  selectedSquare = null; legalMoves = []; hintMove = null;
  renderBoard(); renderGameInfo(); renderMoves(); syncTurnBars();
}

function myColorIn(game) {
  if (!game) return null;
  if (game.playerColor) return game.playerColor;
  if (game.white?.id === userId) return 'w';
  if (game.black?.id === userId) return 'b';
  return null;
}

function syncTurnBars() {
  const wBar = document.getElementById('whiteBar');
  const bBar = document.getElementById('blackBar');
  if (!currentGame) { wBar?.classList.remove('turn'); bBar?.classList.remove('turn'); return; }
  const turn = chess.turn();
  wBar.classList.toggle('turn', turn === 'w' && currentGame.status === 'playing');
  bBar.classList.toggle('turn', turn === 'b' && currentGame.status === 'playing');
  // ratings in bars
  const myR = document.getElementById('myRating');
  const opR = document.getElementById('blackRating');
  if (myR && user?.rating != null) {
    myR.style.display = '';
    myR.textContent = `${Math.round(user.rating)}${(user.stats?.ratedGames ?? 0) < 25 ? '?' : ''}`;
  }
  const opp = currentGame.white?.id === userId ? currentGame.black : currentGame.white;
  if (opR) {
    if (opp?.rating != null && opp.id !== 'stockfish') {
      opR.style.display = '';
      opR.textContent = Math.round(opp.rating);
    } else if (opp?.id === 'stockfish' || /stockfish/i.test(opp?.username || '')) {
      opR.style.display = '';
      opR.textContent = currentGame.difficultyConfig?.elo || 'engine';
    } else {
      opR.style.display = 'none';
    }
  }
}

function updateBalance(b) {
  document.getElementById('balanceDisplay').textContent = `$${Number(b).toFixed(2)}`;
  const ab = document.getElementById('availableBalance');
  if (ab) ab.textContent = `$${Number(b).toFixed(2)}`;
}
function updateTransactions(txs) {
  if (!txs) return;
  let earned = 0;
  txs.forEach((t) => { if (t.type === 'win' || t.type === 'jackpot') earned += t.amount; });
  const mini = txs.slice(0, 6).map(txHTML).join('') || '<div class="empty-state">No transactions yet</div>';
  document.getElementById('txListMini').innerHTML = mini;
  document.getElementById('totalWon').textContent = `$${earned.toFixed(2)}`;
}
function updateStats(stats) {
  if (!stats) return;
  document.getElementById('puzzlesSolved').textContent = stats.puzzlesSolved || 0;
  const pp = document.getElementById('puzzlesSolvedPage');
  if (pp) pp.textContent = stats.puzzlesSolved || 0;
  const rec = document.getElementById('statRecord');
  if (rec) rec.textContent = `${stats.wins || 0}–${stats.losses || 0}–${stats.draws || 0}`;
  const pr = document.getElementById('puzzleRatingStat');
  if (pr) pr.textContent = stats.puzzleRating || 1200;
}
function updateRatingUI() {
  const r = Math.round(user?.rating ?? 1200);
  const prov = (user?.stats?.ratedGames ?? 0) < 25;
  const txt = `${r}${prov ? '?' : ''}`;
  const el = document.getElementById('statRating');
  if (el) el.textContent = txt;
  const pr = document.getElementById('profileRating');
  if (pr) pr.value = `${txt} · ${user?.stats?.ratedGames || 0} rated games`;
  syncTurnBars();
}
function txHTML(tx) {
  const pos = tx.amount > 0;
  const icons = { deposit: '💳', withdraw: '🏦', win: '🏆', bet: '⚔️', fee: '💼', refund: '↩️', loss: '💸', jackpot: '🎰', puzzle: '🧩' }[tx.type] || '💰';
  return `<div class="tx-item"><div style="min-width:0"><div class="tx-type">${icons} ${tx.type} <span class="tx-status ${tx.status}">${tx.status}</span></div><div class="tx-detail">${tx.details || ''} · ${new Date(tx.timestamp).toLocaleTimeString()}</div></div><div class="tx-amount ${pos ? 'positive' : 'negative'}">${pos ? '+' : ''}$${Math.abs(tx.amount).toFixed(2)}</div></div>`;
}
function updateJackpot() {
  document.getElementById('jackpotPill').textContent = `🎰 Jackpot $${Number(jackpotPool).toFixed(0)}`;
  const jf = document.getElementById('jackpotFull');
  if (jf) jf.textContent = `$${Number(jackpotPool).toFixed(2)}`;
}

function switchLeftTab(tab) {
  currentMode = tab;
  document.querySelectorAll('.left-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.left-tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${tab}`));
}
function switchRightTab(tab) {
  document.querySelectorAll('.right-tab').forEach((t) => t.classList.toggle('active', t.dataset.rtab === tab));
  document.querySelectorAll('.right-tab-content').forEach((c) => c.classList.toggle('active', c.id === `rtab-${tab}`));
}
function switchPage(page) {
  document.querySelectorAll('.page-overlay').forEach((p) => (p.style.display = 'none'));
  if (page !== 'play') {
    const el = document.getElementById(`page-${page}`);
    if (el) el.style.display = 'block';
    if (page === 'puzzles' && !currentPuzzle) nextPuzzle();
    if (page === 'leaderboard') renderFullLeaderboard();
  }
  document.querySelectorAll('.nav-link').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
}

// ============ BET SLIDER / DIFFICULTY ============
document.getElementById('quickBetSlider')?.addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('quickBetLabel').textContent = v === 0 ? 'Free' : `$${v.toFixed(2)}`;
  document.getElementById('findBetAmount').textContent = v.toFixed(2);
  document.getElementById('betAmount').value = v.toFixed(2);
  document.getElementById('customBet').value = v.toFixed(2);
  updateBetCalculation();
});
function updateBetCalculation() {
  const bet = parseFloat(document.getElementById('betAmount').value) || 0;
  const cfg = difficultyConfig[selectedDifficulty] || { multiplier: 2.5, label: 'Medium' };
  const gross = bet * cfg.multiplier;
  const win = gross * 0.9;
  document.getElementById('betDisplay').textContent = `$${bet.toFixed(2)}`;
  document.getElementById('multDisplay').textContent = `${cfg.multiplier}×`;
  document.getElementById('winDisplay').textContent = `$${win.toFixed(2)}`;
  document.getElementById('payoutBadge').textContent = `Win ${cfg.multiplier}×`;
  document.getElementById('liveMult').textContent = bet > 0 ? `${cfg.multiplier}×` : 'free';
  document.getElementById('liveWin').textContent = `$${win.toFixed(2)}`;
  document.getElementById('potDisplay').textContent = bet > 0 ? `$${bet.toFixed(2)}` : 'FREE';
  document.getElementById('potSub').textContent = bet > 0 ? `Win $${win.toFixed(2)} vs ${cfg.label}` : 'Practice — no stake';
}
function renderDifficultyGrids() {
  if (!difficultyConfig || Object.keys(difficultyConfig).length === 0) return;
  document.getElementById('difficultyGrid').innerHTML = Object.keys(difficultyConfig).map((k) => {
    const c = difficultyConfig[k];
    const active = k === selectedDifficulty ? 'active' : '';
    return `<div class="diff-card ${active}" onclick="selectDiff('${k}')"><div class="diff-mult">${c.multiplier}×</div><div class="diff-name" style="color:${c.color}">${c.label}</div><div class="diff-elo">${c.elo} · ${c.desc}</div></div>`;
  }).join('');
}
window.selectDiff = (k) => { selectedDifficulty = k; renderDifficultyGrids(); updateBetCalculation(); };
document.getElementById('betAmount')?.addEventListener('input', updateBetCalculation);

function findMatch() {
  const bet = parseFloat(document.getElementById('quickBetSlider').value) || 0;
  if (bet > 0 && user && user.balance < bet) { toast(`You need $${bet.toFixed(2)} — deposit to play`, 'error'); openModal('depositModal'); return; }
  const timeControl = '10+0';
  socket.emit('findMatch', { userId, bet, timeControl }, (res) => { if (res && res.error) toast(res.error, 'error'); });
}
function cancelSearch() {
  if (!currentSearchBet && currentSearchBet !== 0) return;
  socket.emit('cancelMatchSearch', { userId, bet: currentSearchBet });
}

async function refreshLiveStats(bet, pos) {
  try {
    const s = await fetch('/api/stats/live').then((r) => r.json());
    document.getElementById('searchSub').textContent =
      `${s.totalUsers || 0} players · ${s.waitingQueues || 0} waiting · position ${pos || 1} in $${Number(bet).toFixed(2)} queue`;
  } catch (e) { /* offline */ }
}

// ============ BOARD RENDERING ============
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function buildBoard(boardEl, c, opts = {}) {
  boardEl.innerHTML = '';
  const displayRanks = boardOrientation === 'white' ? RANKS : [...RANKS].reverse();
  const displayFiles = boardOrientation === 'white' ? FILES : [...FILES].reverse();
  const lastMove = opts.lastMove || (currentGame && currentGame.moves && currentGame.moves.length
    ? currentGame.moves[currentGame.moves.length - 1] : null);
  const checkSquare = opts.checkSquare || null;
  const selSquare = opts.selected !== undefined ? opts.selected : selectedSquare;
  const selMoves = opts.legalMoves !== undefined ? opts.legalMoves : legalMoves;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rank = displayRanks[r];
      const file = displayFiles[f];
      const sqName = file + rank;
      const piece = c.get(sqName);
      const isLight = (r + f) % 2 === 0;
      const isSelected = selSquare === sqName;
      const isLegal = selMoves.some((m) => m.to === sqName);
      const isCapture = isLegal && piece;
      const isLast = lastMove && (lastMove.from === sqName || lastMove.to === sqName);
      const isHint = hintMove && (hintMove.from === sqName || hintMove.to === sqName);
      const isCheck = checkSquare === sqName;

      const sq = document.createElement('div');
      sq.className = `square ${isLight ? 'light' : 'dark'} ${isSelected ? 'selected' : ''} ${isLegal ? 'legal' : ''} ${isCapture ? 'capture' : ''} ${isLast ? 'last-move' : ''} ${isHint ? 'hint' : ''} ${isCheck ? 'check' : ''}`;
      sq.dataset.square = sqName;

      if (piece) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = pieceSrc(piece.color, piece.type);
        img.alt = piece.color + piece.type;
        img.draggable = !opts.readOnly;
        img.addEventListener('dragstart', (e) => {
          if (opts.onPick) opts.onPick(sqName);
          e.dataTransfer.setData('text/plain', sqName);
          e.dataTransfer.effectAllowed = 'move';
        });
        sq.appendChild(img);
      }
      sq.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      sq.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData('text/plain');
        if (from && opts.onDrop) opts.onDrop(from, sqName);
      });
      sq.addEventListener('click', () => opts.onClick && opts.onClick(sqName));

      if (f === 7) { const fc = document.createElement('span'); fc.className = 'coords file'; fc.textContent = file; sq.appendChild(fc); }
      if (r === 7) { const rc = document.createElement('span'); rc.className = 'coords rank'; rc.textContent = rank; sq.appendChild(rc); }
      boardEl.appendChild(sq);
    }
  }
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  const inCheck = chess.inCheck();
  const turn = chess.turn();
  let kingSq = null;
  if (inCheck) {
    const board = chess.board();
    outer: for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === 'k' && p.color === turn) {
        kingSq = FILES[f] + RANKS[r];
        break outer;
      }
    }
  }
  buildBoard(boardEl, chess, {
    readOnly: isSpectator || !currentGame || currentGame.status !== 'playing',
    checkSquare: kingSq,
    onClick: (sq) => onSquareClick(sq),
    onPick: (sq) => onSquareClick(sq),
    onDrop: (from, to) => attemptMove(from, to),
  });

  if (!currentGame) {
    const overlay = document.createElement('div');
    overlay.className = 'game-overlay';
    overlay.id = 'boardOverlay';
    overlay.innerHTML = `
      <div style="font-size:40px;margin-bottom:8px">♞</div>
      <h3 style="font-weight:800;font-size:18px;letter-spacing:-.3px">Your move</h3>
      <p style="color:var(--muted);font-size:12.5px;max-width:330px;margin-top:8px;line-height:1.6">
        Take on the rated Stockfish ladder, send a friend an invite link, or jump into a staked quick match.
      </p>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-cyan" onclick="coachAction('engine')">⚔️ Play engine</button>
        <button class="btn btn-outline" onclick="coachAction('friend')">🔗 Invite friend</button>
      </div>`;
    boardEl.appendChild(overlay);
  }
}

function onSquareClick(square) {
  if (isSpectator) return;
  if (!currentGame || currentGame.status !== 'playing') return;
  const piece = chess.get(square);
  const myColor = myColorIn(currentGame);
  if (!myColor) return;
  const isMyTurn = chess.turn() === myColor;
  if (selectedSquare) {
    const mv = legalMoves.find((m) => m.to === square);
    if (mv) { attemptMove(selectedSquare, square, mv.promotion); selectedSquare = null; legalMoves = []; renderBoard(); return; }
  }
  if (piece && piece.color === myColor && isMyTurn) {
    selectedSquare = square;
    legalMoves = chess.moves({ square, verbose: true });
  } else {
    selectedSquare = null;
    legalMoves = [];
    if (!isMyTurn) toast('Opponent to move', 'info');
  }
  renderBoard();
}

function attemptMove(from, to, prom) {
  if (isSpectator || !currentGame || currentGame.status !== 'playing') return;
  const myColor = myColorIn(currentGame);
  if (!myColor || chess.turn() !== myColor) return;
  const verbose = chess.moves({ verbose: true }).find((m) => m.from === from && m.to === to);
  if (!verbose) { toast('Illegal move', 'error'); return; }
  const promotion = prom || verbose.promotion || 'q';
  if (currentGame.type === 'pvp_bet' || currentGame.type === 'pvp_friend') {
    socket.emit('makeMovePvp', { userId, gameId: currentGame.id, from, to, promotion }, (res) => {
      if (res && res.error) toast(res.error, 'error');
    });
  } else if (currentGame.type === 'engine') {
    // optimistic local render; server is authoritative and echoes the move
    const test = new Chess(currentGame.fen);
    if (!test.move({ from, to, promotion })) return toast('Invalid move', 'error');
    chess.move({ from, to, promotion });
    renderBoard(); renderMovesLocal();
    selectedSquare = null; legalMoves = [];
    socket.emit('engineMove', { userId, gameId: currentGame.id, from, to, promotion }, (res) => {
      if (res && res.error) { toast(res.error, 'error'); chess.load(currentGame.fen); renderBoard(); }
    });
  }
}

function renderGameInfo() {
  const info = document.getElementById('gameInfo');
  if (!currentGame) {
    info.innerHTML = `<div class="empty-state"><div class="empty-icon">♟️</div><b style="color:var(--text)">Ready when you are.</b><br>Play the rated engine ladder, invite a friend, or quick-match.</div>`;
    document.getElementById('blackName').firstChild.textContent = 'Opponent ';
    document.getElementById('blackStatus').textContent = 'Pick a mode to start';
    document.getElementById('potDisplay').textContent = '$0.00';
    document.getElementById('potSub').textContent = 'No active game';
    document.getElementById('liveWin').textContent = '$0.00';
    document.getElementById('liveMult').textContent = '—';
    return;
  }
  const myColor = myColorIn(currentGame);
  const isMyTurn = myColor ? chess.turn() === myColor : false;
  const opp = currentGame.white?.id === userId ? currentGame.black : currentGame.white;
  const blackNameEl = document.getElementById('blackName');
  if (opp) blackNameEl.firstChild.textContent = `${opp.username} `;
  const cfg = currentGame.difficultyConfig;
  document.getElementById('blackStatus').textContent =
    `${isMyTurn ? 'Waiting for you' : 'Thinking…'} · ${currentGame.type === 'pvp_bet' || currentGame.type === 'pvp_friend' ? (currentGame.bet ? `Stake $${currentGame.bet}` : 'Casual') : cfg ? `${cfg.label} · ${cfg.multiplier}×` : 'Engine'}`;
  document.getElementById('whiteName').firstChild.textContent = `${user ? user.username : 'You'} `;
  document.getElementById('whiteStatus').textContent =
    `${isSpectator ? 'Spectating' : isMyTurn ? 'Your move' : 'Opponent move'} · ${currentGame.type === 'engine' ? (currentGame.isFree ? 'Practice' : 'Rated stake') : 'Rated game'}`;

  const potText = (currentGame.type === 'pvp_bet' || currentGame.type === 'pvp_friend')
    ? `Pot $${((currentGame.bet || 0) * 2).toFixed(2)}`
    : currentGame.isFree ? 'FREE' : `$${currentGame.bet} stake · win $${(currentGame.bet * (cfg?.multiplier || 2.5) * 0.9).toFixed(2)}`;
  info.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--muted)">${currentGame.id}</b>
      <span class="chip" style="color:${cfg?.color || 'var(--cyan)'}">${currentGame.type === 'engine' ? `${cfg?.label || 'Engine'} ${cfg?.multiplier || ''}×` : currentGame.bet ? `Stake $${currentGame.bet}` : 'Casual'}</span>
    </div>
    <div style="background:rgba(2,6,23,0.45);border:1px solid var(--hairline);border-radius:12px;padding:12px;font-size:12px">
      <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Pot</span><b style="color:var(--green)">${potText}</b></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--muted)">Turn</span><b>${chess.turn() === 'w' ? 'White' : 'Black'}${isMyTurn ? ' (you)' : ''}</b></div>
      ${currentGame.result ? `<div style="margin-top:8px;color:var(--amber);font-weight:700">${currentGame.result}</div>` : ''}
    </div>
    ${currentGame.status === 'playing' && !isSpectator ? `<button class="btn btn-small btn-outline" style="width:100%;margin-top:10px" onclick="shareCurrentGame()">🔗 Share / invite spectators</button>` : ''}`;

  const isPvp = currentGame.type === 'pvp_bet' || currentGame.type === 'pvp_friend';
  document.getElementById('potDisplay').textContent = isPvp ? `$${((currentGame.bet || 0) * 2).toFixed(2)}` : currentGame.isFree ? 'FREE' : `$${Number(currentGame.bet || 0).toFixed(2)}`;
  document.getElementById('potSub').textContent = isPvp ? `Winner takes $${((currentGame.bet || 0) * 2 * 0.9).toFixed(2)}` : currentGame.isFree ? 'Practice' : `To win $${(currentGame.bet * (cfg?.multiplier || 2.5) * 0.9).toFixed(2)}`;
  document.getElementById('liveMult').textContent = isPvp ? '90% pot' : cfg ? `${cfg.multiplier}×` : '—';
  document.getElementById('liveWin').textContent = currentGame.isFree ? '$0.00' : isPvp ? `$${((currentGame.bet || 0) * 2 * 0.9).toFixed(2)}` : `$${(currentGame.bet * (cfg?.multiplier || 2.5) * 0.9).toFixed(2)}`;
}

function renderMoves() { renderMovesLocal(); }
function renderMovesLocal() {
  const moves = chess.history({ verbose: true });
  let html = '';
  for (let i = 0; i < moves.length; i += 2) {
    html += `<div class="move-row"><span class="move-num">${Math.floor(i / 2) + 1}</span><span class="move">${moves[i].san}</span><span class="move">${moves[i + 1] ? moves[i + 1].san : ''}</span></div>`;
  }
  const panel = document.getElementById('movesPanel');
  if (panel) { panel.innerHTML = html; panel.scrollTop = panel.scrollHeight; }
}

// ============ ANALYSIS ENGINE ============
function initEngineClient() {
  if (typeof EngineClient === 'undefined') { setEngineStatus('No engine', ''); return; }
  engineClient = new EngineClient({ socket });
  engineClient.onStatus((status) => {
    const labels = {
      idle: 'Engine idle',
      loading: 'Engine starting…',
      ready: 'Stockfish 18 ✓',
      server: 'Server engine ✓',
      unavailable: 'No engine',
    };
    setEngineStatus(labels[status] || 'Engine', '', status);
  });
  engineClient.init();
  loadPaymentProviders();
}
function setEngineStatus(text, title, status) {
  if (status) document.body.dataset.engineStatus = status;
  const el = document.getElementById('engineStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'status-badge ' + (/✓/.test(text) ? 'status-playing' : '');
}
function updateEvalUI() {
  const s = currentEval.score;
  let pct = 50 + s * 8; pct = Math.max(5, Math.min(95, pct));
  const vf = document.getElementById('verticalFill'); if (vf) vf.style.height = (100 - pct) + '%';
  const ef = document.getElementById('evalFill'); if (ef) ef.style.width = pct + '%';
  const ed = document.getElementById('evalDisplay'); if (ed) ed.textContent = currentEval.text;
  const en = document.getElementById('evalNumber'); if (en) en.textContent = s > 0 ? `+${s.toFixed(1)}` : s.toFixed(1);
}
function requestEvaluation(fen) {
  if (!analysisEnabled || !engineClient || !fen) return;
  clearTimeout(evalThrottleTimer);
  evalThrottleTimer = setTimeout(async () => {
    const res = await engineClient.analyse({ fen, movetimeMs: 350, multiPv: 1 });
    if (!res) return;
    const pov = fen.split(' ')[1] === 'b' ? -1 : 1;
    if (res.mate != null) {
      currentEval = { score: res.mate > 0 ? 10 : -10, text: `Mate in ${Math.abs(res.mate)}`, depth: res.depth, pv: (res.pv || []).join(' ') };
    } else if (res.cp != null) {
      const whitePov = (res.cp / 100) * pov;
      currentEval = {
        score: whitePov,
        text: `${whitePov > 0 ? '+' : ''}${whitePov.toFixed(1)} · ${Math.abs(whitePov) < 0.3 ? 'equal position' : whitePov > 0 ? 'White better' : 'Black better'}`,
        depth: res.depth,
        pv: (res.pv || []).join(' '),
      };
    }
    updateEvalUI();
    const al = document.getElementById('analysisLines');
    if (al) al.innerHTML = `<div><b>Depth ${currentEval.depth}</b> · ${currentEval.text} <span style="color:var(--faint)">(${res.source})</span></div><div style="margin-top:6px;color:var(--text-2)">${(res.pv || []).slice(0, 10).join(' ') || res.bestMove || '…'}</div>`;
  }, 250);
}

// ============ GAME ACTIONS ============
function startEngineGame(isFree) {
  const bet = parseFloat(document.getElementById('betAmount').value) || 0;
  const difficulty = selectedDifficulty;
  const colorSel = document.getElementById('playerColor').value;
  const color = colorSel === 'random' ? (Math.random() > 0.5 ? 'w' : 'b') : colorSel;
  if (!isFree && bet > 0 && user && user.balance < bet) { toast(`You need $${bet.toFixed(2)} — deposit to play`, 'error'); openModal('depositModal'); return; }
  socket.emit('createEngineGame', { userId, bet: isFree ? 0 : bet, difficulty, isFree: !!isFree, color }, (res) => {
    if (res && res.error) toast(res.error, 'error');
  });
  coachSay(isFree ? 'Free practice started — no stake, no pressure. Your rating still moves.' : `Staked game vs ${difficultyConfig[difficulty]?.label || 'engine'} — good luck!`);
}

function resignGame() {
  if (!currentGame || currentGame.status !== 'playing' || isSpectator) return toast('No active game', 'error');
  if (!window.confirm('Resign this game?')) return;
  const type = currentGame.type;
  if (type === 'pvp_bet' || type === 'pvp_friend') {
    socket.emit('resignPvp', { userId, gameId: currentGame.id }, (res) => { if (res && res.error) toast(res.error, 'error'); });
  } else {
    socket.emit('engineGameOver', { userId, gameId: currentGame.id, result: 'resign' }, (res) => { if (res && res.error) toast(res.error, 'error'); });
  }
}
function offerDraw() {
  if (!currentGame || currentGame.status !== 'playing' || isSpectator) return toast('No active game', 'error');
  if (currentGame.type === 'engine') return toast('The engine never accepts draws — checkmate is the only way', 'info');
  socket.emit('offerDraw', { userId, gameId: currentGame.id }, (res) => {
    if (res && res.error) return toast(res.error, 'error');
    toast('Draw offer sent to your opponent', 'success');
  });
}
function flipBoard() { boardOrientation = boardOrientation === 'white' ? 'black' : 'white'; renderBoard(); if (currentPuzzle) renderPuzzleBoard(); }

async function getHint() {
  if (!currentGame || currentGame.status !== 'playing') return toast('Start a game first', 'error');
  if (!engineClient) return toast('Engine is starting…', 'info');
  const uci = await engineClient.bestMove(chess.fen(), { movetimeMs: 700 });
  if (!uci) return toast('Engine unavailable — try again', 'error');
  hintMove = { from: uci.substring(0, 2), to: uci.substring(2, 4) };
  renderBoard();
  const probe = new Chess(chess.fen());
  const mv = probe.move({ from: hintMove.from, to: hintMove.to, promotion: uci.length > 4 ? uci[4] : 'q' });
  toast(`Hint: ${mv ? mv.san : uci}`, 'success');
}
async function showSolution() {
  if (!engineClient) return toast('Engine starting…', 'info');
  const best = await engineClient.bestMove(chess.fen(), { movetimeMs: 700 });
  toast(best ? `Best move: ${best.toUpperCase()}` : `Best line: ${currentEval.pv || 'calculating…'}`, 'info');
}
function toggleEngine() {
  analysisEnabled = !analysisEnabled;
  toast(analysisEnabled ? 'Analysis engine on' : 'Analysis engine off', 'info');
  if (analysisEnabled && currentGame) requestEvaluation(currentGame.fen);
}
function openAnalysis() { switchRightTab('analysis'); }
function resetBoard() { chess.reset(); currentGame = null; hintMove = null; selectedSquare = null; legalMoves = []; isSpectator = false; renderBoard(); renderGameInfo(); document.getElementById('movesPanel').innerHTML = ''; }

// ============ FRIEND INVITES ============
function createFriendInvite() {
  const bet = parseFloat(document.getElementById('customBet').value) || 0;
  const timeControl = document.getElementById('customTime').value;
  const color = document.getElementById('friendColor').value;
  if (bet > 0 && user && user.balance < bet) { toast(`You need $${bet.toFixed(2)} for this stake`, 'error'); openModal('depositModal'); return; }
  socket.emit('createFriendInvite', { userId, bet, timeControl, color }, (res) => {
    if (res && res.error) return toast(res.error, 'error');
    const url = `${window.location.origin}${window.location.pathname}?invite=${res.gameId}`;
    document.getElementById('shareLink').value = url;
    document.getElementById('shareModalSub').textContent = bet > 0 ? `Staked game · $${bet.toFixed(2)} per player · ${timeControl}` : `Casual game · ${timeControl}`;
    document.getElementById('shareHint').textContent = 'Your friend opens the link, signs in, and joins as your opponent. Stakes are held in escrow when they join; the winner takes 90% of the pot.';
    openModal('shareModal');
    navigator.clipboard?.writeText(url).catch(() => {});
    toast('Invite created — link copied to clipboard', 'success');
    coachSay('Invite link ready. Send it to your friend — they will drop straight into the game when they open it.');
  });
}

function renderLobby() {
  const el = document.getElementById('lobbyList');
  if (!el) return;
  const open = lobbies.filter((g) => g.status === 'waiting');
  if (!open.length) { el.innerHTML = '<div class="empty-state" style="padding:14px">No open challenges. Create one and share the link.</div>'; return; }
  el.innerHTML = open.map((g) => {
    const mine = g.hostId === userId;
    return `<div class="lobby-item">
      <div><b>${mine ? 'Your challenge' : g.host}</b><div style="font-size:10px;color:var(--muted);margin-top:2px">${g.bet > 0 ? '$' + g.bet.toFixed(2) + ' stake' : 'Casual'} · ${g.timeControl} · ${g.rated ? 'rated' : 'unrated'}</div></div>
      ${mine
        ? `<button class="btn btn-small btn-outline" onclick="copyInvite('${g.id}')">Copy link</button>`
        : `<button class="btn btn-small btn-cyan" onclick="joinFriendGame('${g.id}')">Join</button>`}
    </div>`;
  }).join('');
}
window.joinFriendGame = (gameId) => {
  socket.emit('joinFriendGame', { gameId, userId }, (res) => {
    if (res && res.error) { toast(res.error, 'error'); if (/started|finished|not found/i.test(res.error)) spectateGame(gameId); }
  });
};
window.copyInvite = (gameId) => {
  const url = `${window.location.origin}${window.location.pathname}?invite=${gameId}`;
  document.getElementById('shareLink').value = url;
  openModal('shareModal');
  navigator.clipboard?.writeText(url).then(() => toast('Invite link copied', 'success')).catch(() => {});
};

function handleUrlInvite() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  const spectate = params.get('game');
  if (invite) {
    coachSay('Invite link detected — joining your friend’s game…');
    socket.emit('joinFriendGame', { gameId: invite, userId }, (res) => {
      if (res && res.error) {
        // Game may already be running -> fall back to spectating
        if (/started|finished|not found/i.test(res.error)) spectateGame(invite);
        else toast(res.error, 'error');
      }
    });
  } else if (spectate) {
    spectateGame(spectate);
  }
}

function spectateGame(gameId) {
  socket.emit('spectateGame', { gameId }, (res) => {
    if (res && res.error) toast('Game not found: ' + gameId, 'error');
  });
}

function shareCurrentGame() {
  if (!currentGame) return toast('No active game to share', 'error');
  const url = `${window.location.origin}${window.location.pathname}?game=${currentGame.id}`;
  document.getElementById('shareLink').value = url;
  document.getElementById('shareModalSub').textContent = 'Spectator link — anyone can watch live';
  document.getElementById('shareHint').textContent = 'Spectators see the board, clocks and chat live, but cannot move. Great for streaming high-stakes games.';
  openModal('shareModal');
}
function copyShareLink() {
  const input = document.getElementById('shareLink');
  input.select();
  navigator.clipboard?.writeText(input.value).then(() => toast('Link copied', 'success')).catch(() => {});
}

// ============ CONCIERGE CHAT ============
function coachBubble(html, cls) {
  const box = document.getElementById('coachChat');
  if (!box) return;
  const div = document.createElement('div');
  div.className = `chat-bubble ${cls}`;
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function coachSay(text) {
  const box = document.getElementById('coachChat');
  if (!box) return;
  const typing = document.createElement('div');
  typing.className = 'typing-indicator';
  typing.innerHTML = '<span></span><span></span><span></span>';
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;
  setTimeout(() => {
    typing.remove();
    coachBubble(text, 'coach');
  }, 550 + Math.random() * 400);
}
function userSay(text) { coachBubble(text, 'user'); }
function coachGreet(u) {
  const box = document.getElementById('coachChat');
  if (!box || box.dataset.greeted) return;
  box.dataset.greeted = '1';
  coachBubble(`Hey <b>${u.username}</b> — welcome back. You're <b>${Math.round(u.rating || 1200)}${(u.stats?.ratedGames || 0) < 25 ? '?' : ''}</b> Elo. Want to climb the ladder, test a friend, or warm up with a free game?`, 'coach');
}
window.coachAction = (action) => {
  const labels = {
    engine: 'I want to play the engine',
    friend: 'Invite a friend',
    match: 'Quick match me',
    free: 'Free practice',
    rating: "What's my rating?",
    deposit: 'Add funds',
  };
  userSay(labels[action] || action);
  switch (action) {
    case 'engine':
      switchLeftTab('engine');
      coachSay('Pick a strength tier — Easy (800) up to Grandmaster (2850) — set your stake, and hit <b>Play for stake</b>. Wins pay the multiplier shown; practice games are free.');
      break;
    case 'friend':
      switchLeftTab('friend');
      coachSay('Set a stake (or zero for casual), pick a time control, then press <b>Create invite link</b>. Send the link to your friend — they join the game the moment they open it.');
      break;
    case 'match':
      switchLeftTab('match');
      coachSay('Set your stake and hit <b>Find a match</b>. You will be paired with someone staking the same amount. Winner takes 90% of the pot.');
      break;
    case 'free':
      coachSay('Starting a free practice game against the engine — your rating still moves, but no money is at stake.');
      startEngineGame(true);
      break;
    case 'rating':
      if (user) coachSay(`You are <b>${Math.round(user.rating)}${(user.stats?.ratedGames || 0) < 25 ? '?' : ''}</b> Elo with a record of <b>${user.stats?.wins || 0}–${user.stats?.losses || 0}–${user.stats?.draws || 0}</b>. ${(user.stats?.ratedGames || 0) < 25 ? 'Your rating is provisional — it will settle after 25 rated games.' : 'Beat stronger opponents to gain more rating.'}`);
      break;
    case 'deposit':
      openModal('depositModal');
      coachSay('Deposits use EcoCash, InnBucks, OneMoney, bank transfer or a cash agent. In sandbox mode everything settles automatically for testing.');
      break;
  }
};
document.querySelectorAll('#coachPills .pill').forEach((p) => p.addEventListener('click', () => coachAction(p.dataset.action)));

// ============ PUZZLES ============
function nextPuzzle() {
  socket.emit('getPuzzle', null, (p) => {
    if (!p) return;
    currentPuzzle = p;
    puzzleChess.load(p.fen);
    chess.load(p.fen);
    currentGame = null;
    renderBoard();
    document.getElementById('puzzleTheme').textContent = `Theme: ${p.theme}`;
    document.getElementById('puzzleRating').textContent = p.rating;
    document.getElementById('puzzleDesc').textContent = p.desc;
    puzzleSelected = null; puzzleLegal = [];
    renderPuzzleBoard();
  });
}
function renderPuzzleBoard() {
  const pb = document.getElementById('puzzleBoard');
  if (!pb || !currentPuzzle) return;
  buildBoard(pb, puzzleChess, {
    readOnly: false,
    selected: puzzleSelected,
    legalMoves: puzzleLegal,
    onClick: (sq) => onPuzzleClick(sq),
    onPick: (sq) => onPuzzleClick(sq),
    onDrop: (from, to) => { puzzleSelected = from; onPuzzleClick(to); },
  });
  applyBoardTheme();
}
function onPuzzleClick(square) {
  if (!currentPuzzle) return;
  const piece = puzzleChess.get(square);
  if (puzzleSelected) {
    const move = puzzleLegal.find((m) => m.to === square);
    if (move) {
      const uci = puzzleSelected + square;
      puzzleChess.move({ from: puzzleSelected, to: square, promotion: 'q' });
      renderPuzzleBoard();
      if (currentPuzzle.solution[0] === uci) {
        toast('Correct! Rating adjusted.', 'success');
        socket.emit('solvePuzzle', { userId, puzzleId: currentPuzzle.id, moves: [uci], puzzleRating: user?.stats?.puzzleRating || 1200 }, () => setTimeout(nextPuzzle, 900));
      } else {
        toast(`Not quite — the solution begins ${currentPuzzle.solution[0].toUpperCase()}`, 'error');
        setTimeout(() => { puzzleChess.load(currentPuzzle.fen); renderPuzzleBoard(); }, 900);
      }
      puzzleSelected = null; puzzleLegal = [];
      return;
    }
  }
  if (piece && piece.color === 'w') {
    puzzleSelected = square;
    puzzleLegal = puzzleChess.moves({ square, verbose: true });
    renderPuzzleBoard();
  } else { puzzleSelected = null; puzzleLegal = []; renderPuzzleBoard(); }
}
async function getPuzzleHint() {
  if (!currentPuzzle) return;
  let uci = currentPuzzle.solution[0];
  if (engineClient) {
    const best = await engineClient.bestMove(puzzleChess.fen(), { movetimeMs: 600 });
    if (best) uci = best;
  }
  toast(`Hint: ${uci.toUpperCase()}`, 'info');
  hintMove = { from: uci.substring(0, 2), to: uci.substring(2, 4) };
  renderPuzzleBoard();
}

// ============ LEADERBOARD ============
function renderMiniLeaderboard() {
  const el = document.getElementById('miniLeaderboard');
  if (!el) return;
  if (!leaderboard || !leaderboard.length) { el.innerHTML = '<div class="empty-state">No rated games yet — be the first on the board.</div>'; return; }
  el.innerHTML = leaderboard.slice(0, 5).map((l, i) => `
    <div class="lb-item">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <span class="lb-rank">${i + 1}</span>
        <div style="min-width:0"><div class="lb-name">${l.username}${l.provisional ? ' <span style="color:var(--faint)">?</span>' : ''}</div><div class="lb-elo">${l.wins || 0}–${l.losses || 0}–${l.draws || 0}</div></div>
      </div>
      <div style="text-align:right"><div style="font-weight:800;color:var(--cyan)">${Math.round(l.rating || 1200)}</div><div style="font-size:10px;color:var(--muted)">$${(l.earnings || 0).toFixed(0)} won</div></div>
    </div>`).join('');
}
function renderFullLeaderboard() {
  const el = document.getElementById('fullLeaderboard');
  const gmEl = document.getElementById('gmSlayers');
  if (!el) return;
  if (!leaderboard || !leaderboard.length) { el.innerHTML = '<div class="empty-state">No players yet.</div>'; return; }
  el.innerHTML = leaderboard.map((l, i) => `
    <div class="lb-item">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="lb-rank">#${i + 1}</span>
        <div class="player-avatar" style="width:30px;height:30px;font-size:12px">${(l.username || '?')[0]}</div>
        <div><div class="lb-name">${l.username}${l.provisional ? ' <span style="color:var(--faint)">?</span>' : ''}</div><div class="lb-elo">${l.wins || 0}W · ${l.losses || 0}L · ${l.draws || 0}D${l.winsVsGM ? ` · 🏆 ${l.winsVsGM} GM` : ''}</div></div>
      </div>
      <div style="text-align:right"><b style="color:var(--cyan);font-size:14px">${Math.round(l.rating || 1200)}</b><div style="font-size:10px;color:var(--muted)">$${(l.earnings || 0).toFixed(2)} earned</div></div>
    </div>`).join('');
  if (gmEl) {
    const gmOnly = leaderboard.filter((l) => (l.winsVsGM || 0) > 0);
    gmEl.innerHTML = gmOnly.length
      ? gmOnly.map((l) => `<div class="lb-item"><span>🏆 ${l.username}</span><b style="color:var(--violet)">${l.winsVsGM} × Grandmaster beaten</b></div>`).join('')
      : '<div class="empty-state">Nobody has beaten the Grandmaster yet. $10 bonus + jackpot share awaits.</div>';
  }
}

// ============ GAME OVER OVERLAYS ============
function showEngineOver(result, outcome, payout, multiplier, game) {
  hideEngineThinking();
  const overlay = document.createElement('div');
  overlay.className = 'game-overlay';
  const isWin = outcome === 'win';
  const isDraw = outcome === 'draw';
  overlay.innerHTML = `
    <div style="background:var(--glass-strong);backdrop-filter:blur(20px);border:1px solid var(--hairline-strong);border-radius:20px;padding:26px;max-width:360px;text-align:center;box-shadow:0 40px 90px -30px rgba(0,0,0,.9)">
      <div style="font-size:46px">${isWin ? '🏆' : isDraw ? '🤝' : '♟️'}</div>
      <h3 style="margin:10px 0;font-weight:900;font-size:20px;color:${isWin ? 'var(--green)' : 'var(--text)'}">${isWin ? 'Victory' : isDraw ? 'Draw' : 'Defeat'}</h3>
      <p style="font-size:12.5px;color:var(--muted);line-height:1.6">${result}</p>
      ${lastRatingDelta != null ? `<div style="margin-top:12px;font-size:13px;font-weight:800;color:${lastRatingDelta > 0 ? 'var(--green)' : lastRatingDelta < 0 ? 'var(--red)' : 'var(--muted)'}">Rating ${lastRatingDelta > 0 ? '+' : ''}${lastRatingDelta}</div>` : ''}
      ${isWin && !game.isFree ? `<div style="background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);border-radius:14px;padding:14px;margin:14px 0"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px">Won vs ${game.difficultyConfig?.label || 'engine'} · ${multiplier}×</div><div style="font-size:28px;font-weight:900;color:var(--green)">+$${Number(payout).toFixed(2)}</div></div>` : ''}
      <button class="btn btn-cyan" style="width:100%;margin-top:12px;padding:12px" onclick="this.closest('.game-overlay').remove()">Continue</button>
      <button class="btn btn-outline" style="width:100%;margin-top:8px" onclick="this.closest('.game-overlay').remove();startEngineGame(${game.isFree})">↻ Play again</button>
    </div>`;
  document.getElementById('board').appendChild(overlay);
  if (isWin) sparkles();
}
function showGameOverPvp(game) {
  const myColor = myColorIn(game);
  const isWinner = game.winner && game.winner === myColor;
  const isDraw = game.winner === 'draw';
  const overlay = document.createElement('div');
  overlay.className = 'game-overlay';
  overlay.innerHTML = `
    <div style="background:var(--glass-strong);backdrop-filter:blur(20px);border:1px solid var(--hairline-strong);border-radius:20px;padding:26px;max-width:360px;text-align:center">
      <div style="font-size:46px">${isWinner ? '🏆' : isDraw ? '🤝' : '♟️'}</div>
      <h3 style="margin:10px 0;font-weight:900;font-size:20px;color:${isWinner ? 'var(--green)' : 'var(--text)'}">${isWinner ? 'You won!' : isDraw ? 'Draw' : 'You lost'}</h3>
      <p style="font-size:12.5px;color:var(--muted);line-height:1.6;margin:6px 0">${game.result || ''}</p>
      ${lastRatingDelta != null ? `<div style="margin-top:10px;font-size:13px;font-weight:800;color:${lastRatingDelta > 0 ? 'var(--green)' : lastRatingDelta < 0 ? 'var(--red)' : 'var(--muted)'}">Rating ${lastRatingDelta > 0 ? '+' : ''}${lastRatingDelta}</div>` : ''}
      <button class="btn btn-cyan" style="width:100%;margin-top:14px;padding:12px" onclick="this.closest('.game-overlay').remove();resetBoard()">Close</button>
    </div>`;
  document.getElementById('board').appendChild(overlay);
  if (isWinner) sparkles();
}
function sparkles() {
  const glyphs = ['✦', '✧', '★'];
  for (let i = 0; i < 14; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'sparkle';
      el.textContent = glyphs[i % glyphs.length];
      el.style.left = Math.random() * 100 + 'vw';
      el.style.color = ['#22d3ee', '#34d399', '#fbbf24'][i % 3];
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2400);
    }, i * 70);
  }
}

// ============ CHAT ============
function sendChat() {
  const inp = document.getElementById('chatInput');
  const msg = inp.value.trim();
  if (!msg) return;
  addChatMsg(`${user?.username || 'You'}: ${msg}`, 'user');
  socket.emit('sendChat', { gameId: currentGame?.id, message: msg, userId });
  inp.value = '';
}
function addChatMsg(msg, type) {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ============ MODALS / PROFILE ============
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-backdrop').forEach((bg) => bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('active'); }));
function setDeposit(a) { document.getElementById('depositAmount').value = a.toFixed(2); }
function saveProfile() {
  const n = document.getElementById('usernameInput').value.trim();
  if (!n || n.length < 3) return toast('Username must be at least 3 characters', 'error');
  username = n;
  localStorage.setItem('chessUsername', n);
  socket.emit('register', { userId, username: n });
  toast(`Username saved: ${n}`, 'success');
  closeModal('profileModal');
}
function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.borderLeftColor = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--cyan)';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ============ PAYMENTS ============
const PROVIDER_ICONS = { ecocash: '📱', innbucks: '💳', onemoney: '📲', bank: '🏦', agent: '🤝', mock: '🧪' };
let paymentProviders = [];
let depositProvider = 'ecocash';
let withdrawProvider = 'ecocash';
let depositPollTimer = null;

async function loadPaymentProviders() {
  try {
    const data = await fetch('/api/payments/providers').then((r) => r.json());
    paymentProviders = (data.providers || []).filter((p) => p.id !== 'mock');
    if (!paymentProviders.length) paymentProviders = [{ id: 'ecocash', label: 'EcoCash', kind: 'mobile_money', minAmount: 0.5, maxAmount: 2000, sandbox: true }];
    depositProvider = paymentProviders.some((p) => p.id === 'ecocash') ? 'ecocash' : paymentProviders[0].id;
    withdrawProvider = depositProvider;
    const badge = document.getElementById('ecoModeBadge');
    if (badge) badge.textContent = data.mode === 'live' ? 'LIVE' : 'SANDBOX';
    renderProviderGrid('depositProviders', depositProvider, 'selectDepositProvider');
    renderProviderGrid('withdrawProviders', withdrawProvider, 'selectWithdrawProvider');
    syncProviderForms();
  } catch (e) { console.warn('providers unavailable', e.message); }
}
function renderProviderGrid(containerId, activeId, handler) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = paymentProviders.map((p) =>
    `<div class="method-card ${p.id === activeId ? 'active' : ''}" onclick="${handler}('${p.id}')">${PROVIDER_ICONS[p.id] || '💰'} ${p.label}${p.sandbox ? ' <span style="font-size:9px;opacity:.7">sandbox</span>' : ''}</div>`).join('');
}
function selectDepositProvider(id) { depositProvider = id; renderProviderGrid('depositProviders', id, 'selectDepositProvider'); syncProviderForms(); }
function selectWithdrawProvider(id) { withdrawProvider = id; renderProviderGrid('withdrawProviders', id, 'selectWithdrawProvider'); syncProviderForms(); }
function syncProviderForms() {
  const phoneGroup = document.getElementById('depositPhoneGroup');
  const ecoForm = document.getElementById('ecoWithdrawForm');
  const bankForm = document.getElementById('bankWithdrawForm');
  const needsPhone = (p) => p === 'ecocash' || p === 'innbucks' || p === 'onemoney' || p === 'agent';
  if (phoneGroup) phoneGroup.style.display = needsPhone(depositProvider) ? 'block' : 'none';
  if (ecoForm) ecoForm.style.display = needsPhone(withdrawProvider) ? 'block' : 'none';
  if (bankForm) bankForm.style.display = withdrawProvider === 'bank' ? 'block' : 'none';
}
function setDepositStatus(html, show = true) {
  const el = document.getElementById('depositStatus');
  if (!el) return;
  el.style.display = show ? 'block' : 'none';
  el.innerHTML = html;
}
function watchTransaction(reference, { onDone } = {}) {
  clearInterval(depositPollTimer);
  let tries = 0;
  depositPollTimer = setInterval(async () => {
    if (tries++ > 60) { clearInterval(depositPollTimer); return; }
    try {
      const tx = await fetch(`/api/payments/${reference}`).then((r) => r.json());
      if (!tx || !tx.reference) return;
      setDepositStatus(`<b>${tx.type.toUpperCase()} ${tx.reference}</b><br>Status: <b style="color:${tx.status === 'completed' ? 'var(--green)' : tx.status === 'failed' ? 'var(--red)' : 'var(--amber)'}">${tx.status}</b> · $${Number(tx.amount).toFixed(2)} via ${tx.provider}`);
      if (['completed', 'failed', 'expired', 'rejected', 'cancelled'].includes(tx.status)) {
        clearInterval(depositPollTimer);
        if (onDone) onDone(tx);
      }
    } catch (e) { /* keep polling */ }
  }, 1200);
}
function doDeposit() {
  const amount = parseFloat(document.getElementById('depositAmount').value);
  const phone = document.getElementById('ecoPhone').value.trim();
  if (isNaN(amount) || amount < 0.5) return toast('Minimum deposit is $0.50', 'error');
  if (phone && phone.replace(/\D/g, '').length < 9) return toast('Enter a valid wallet number', 'error');
  const btn = document.getElementById('depositBtn');
  btn.textContent = '⏳ …'; btn.disabled = true;
  setDepositStatus(`Sending $${amount.toFixed(2)} request to <b>${depositProvider}</b>…`);
  socket.emit('deposit', { userId, amount, phone, provider: depositProvider }, (res) => {
    btn.textContent = 'Deposit'; btn.disabled = false;
    if (res && res.error) { toast(res.error, 'error'); setDepositStatus(`<span style="color:var(--red)">${res.error}</span>`); return; }
    const tx = res.transaction;
    toast(`${depositProvider} request sent`, 'success');
    if (!tx) return;
    watchTransaction(tx.reference, {
      onDone: (t) => {
        if (t.status === 'completed') { toast(`+$${Number(t.amount).toFixed(2)} added to your wallet`, 'success'); setTimeout(() => closeModal('depositModal'), 900); }
        else toast(`Deposit ${t.status}`, 'error');
      },
    });
  });
}
function doWithdraw() {
  const amount = parseFloat(document.getElementById('withdrawAmount').value);
  if (isNaN(amount) || amount < 1) return toast('Minimum withdrawal is $1', 'error');
  if (user && user.balance < amount) return toast('Insufficient balance', 'error');
  let account = '';
  if (withdrawProvider === 'bank') {
    const bank = document.getElementById('bankName').value;
    const acc = document.getElementById('bankAccount').value.trim();
    if (!acc) return toast('Enter an account number', 'error');
    account = `${bank} - ${acc}`;
  } else {
    account = document.getElementById('withdrawPhone').value.trim();
    if (!account || account.replace(/\D/g, '').length < 9) return toast('Enter a valid wallet number', 'error');
  }
  socket.emit('withdraw', { userId, amount, provider: withdrawProvider, accountDetails: account, phone: account }, (res) => {
    if (res && res.error) return toast(res.error, 'error');
    toast(`Withdrawal of $${amount.toFixed(2)} via ${withdrawProvider} submitted`, 'success');
    closeModal('withdrawModal');
    if (res.transaction) watchTransaction(res.transaction.reference, { onDone: (t) => toast(`Withdrawal ${t.status}`, t.status === 'completed' ? 'success' : 'error') });
  });
}

// ============ PHONE OTP ============
function requestOTP() {
  const phone = document.getElementById('otpPhone').value.trim();
  if (!phone || phone.replace(/\D/g, '').length < 9) return toast('Enter a valid mobile number (07…)', 'error');
  const btn = document.getElementById('requestOtpBtn');
  btn.textContent = '⏳ Sending…'; btn.disabled = true;
  socket.emit('requestOTP', { phone }, (res) => {
    btn.textContent = '📲 Send verification code'; btn.disabled = false;
    if (res && res.error) return toast(res.error, 'error');
    toast(`Verification code sent to ${phone}`, 'success');
    document.getElementById('otpRequestSection').style.display = 'none';
    document.getElementById('otpVerifySection').style.display = 'block';
    if (res.code) document.getElementById('otpDemoCode').textContent = `Sandbox code: ${res.code}`;
    document.getElementById('otpCode').focus();
  });
}
function verifyOTP() {
  const phone = document.getElementById('otpPhone').value.trim();
  const code = document.getElementById('otpCode').value.trim();
  if (!code || code.length !== 6) return toast('Enter the 6-digit code', 'error');
  socket.emit('verifyOTP', { phone, code }, (res) => {
    if (res && res.error) return toast(res.error, 'error');
    toast(`Phone ${phone} verified — wallet linked`, 'success');
    userId = res.userId;
    user = res.user;
    localStorage.setItem('chessUserId', userId);
    document.getElementById('userIdDisplay').value = userId;
    document.getElementById('usernameInput').value = res.user.username;
    document.getElementById('headerAvatar').textContent = res.user.username[0].toUpperCase();
    document.getElementById('profilePhone').value = res.user.phone;
    updateBalance(res.user.balance);
    updateTransactions(res.user.transactions || []);
    updateStats(res.user.stats || {});
    updateRatingUI();
    closeModal('otpModal');
    document.getElementById('otpRequestSection').style.display = 'block';
    document.getElementById('otpVerifySection').style.display = 'none';
    document.getElementById('otpCode').value = '';
  });
}
socket.on('otpVerified', ({ phone }) => {
  const pp = document.getElementById('profilePhone');
  if (pp) pp.value = phone;
});

// ============ INIT ============
renderBoard();
applyBoardTheme();
initEngineClient();
document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => switchPage(link.dataset.page)));
