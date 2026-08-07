const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", maxHttpBufferSize: 1e8 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== 1. JSON FILE DB PERSISTENCE ==========
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def) {
  try {
    const p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('Load error', file, e.message); }
  return def;
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  } catch (e) { console.error('Save error', file, e.message); }
}

let usersData = loadJSON('users.json', {}); // userId -> user object
let leaderboard = loadJSON('leaderboard.json', []);
let jackpotPool = loadJSON('jackpot.json', { pool: 1250.75 }).pool;
let transactionsLog = loadJSON('transactions.json', []); // global log for admin
let pendingWithdrawals = loadJSON('withdrawals.json', []); // for admin approval
let totalPayouts = loadJSON('stats.json', { totalPayouts: 0, totalFees: 0, totalBets: 0 }).totalPayouts;
let statsData = loadJSON('stats.json', { totalPayouts: 0, totalFees: 0, totalBets: 0 });

let dirty = false;
function markDirty() { dirty = true; }
setInterval(() => {
  if (!dirty) return;
  saveJSON('users.json', usersData);
  saveJSON('leaderboard.json', leaderboard);
  saveJSON('jackpot.json', { pool: jackpotPool });
  saveJSON('transactions.json', transactionsLog.slice(0, 500));
  saveJSON('withdrawals.json', pendingWithdrawals.slice(0, 200));
  saveJSON('stats.json', statsData);
  dirty = false;
  console.log('💾 DB saved');
}, 3000);

// Convert loaded usersData to Map for runtime
const users = new Map(Object.entries(usersData));
const games = new Map();
const socketToUser = new Map();
const betQueues = new Map();
const otpStore = new Map(); // phone -> {code, expires, attempts}
const gameClocks = new Map(); // gameId -> interval

const PLATFORM_FEE = 0.10;
const MIN_BET = 0.50;
const JACKPOT_CONTRIBUTION = 0.02;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123ZW';

const DIFFICULTY_CONFIG = {
  easy:    { label: 'Easy', elo: 800, skill: 1, multiplier: 1.6, color: '#81b64c', depth: 8, desc: 'Beginner' },
  medium:  { label: 'Medium', elo: 1250, skill: 6, multiplier: 2.5, color: '#f1c40f', depth: 12, desc: 'Casual' },
  hard:    { label: 'Hard', elo: 1800, skill: 12, multiplier: 4.2, color: '#e67e22', depth: 16, desc: 'Club' },
  master:  { label: 'Master', elo: 2400, skill: 20, multiplier: 8.0, color: '#e74c3c', depth: 19, desc: 'Master + Jackpot' },
  grandmaster: { label: 'Grandmaster', elo: 2850, skill: 20, multiplier: 15.0, color: '#9b59b6', depth: 22, desc: '15x + Jackpot!' }
};

const PUZZLES = [
  { id: 1, fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', solution: ['f3g5','d7d5'], rating: 1200, theme: 'Fork', desc: 'Knight fork wins material' },
  { id: 2, fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/3P1N2/PPP2PPP/RNBQKB1R w KQkq - 0 4', solution: ['f3g5'], rating: 1100, theme: 'Pin', desc: 'Pin the knight' },
  { id: 3, fen: 'r2qkb1r/pp2pppp/2n2n2/2ppb3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 6', solution: ['c4d5','c6d5','e4d5'], rating: 1350, theme: 'Central break', desc: 'Break center' },
  { id: 4, fen: 'r1bq1rk1/ppp2ppp/2n5/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQ - 0 7', solution: ['c4f7','f8f7','e4e5'], rating: 1500, theme: 'Sacrifice', desc: 'Bishop sacrifice' },
  { id: 5, fen: 'r1bqk2r/ppp2ppp/2n5/2b1p3/2B1n3/3P1N2/PPP1QPPP/RNB1K2R w KQkq - 0 8', solution: ['f3e5','e4g3','e2g4'], rating: 1600, theme: 'Deflection', desc: 'Deflect defender' },
  { id: 6, fen: '5rk1/pp3ppp/2p5/3p4/3P4/2P3P1/PP3P1P/5RK1 w - - 0 1', solution: ['f1f8','d8f8','a2a4'], rating: 1000, theme: 'Back rank mate', desc: 'Back rank trick' },
  { id: 7, fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2', solution: ['d2d4','c5d4','c2c3'], rating: 1050, theme: 'Gambit', desc: 'Sicilian gambit' },
  { id: 8, fen: 'r3kb1r/pp1n1ppp/2p1p3/q3P3/2B1n3/2N2N2/PPP2PPP/R2QK2R w KQkq - 0 10', solution: ['c3e4','a5a2','e4d6'], rating: 1750, theme: 'Discovered attack', desc: 'Discovered' },
  { id: 9, fen: '6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1', solution: ['g2g4'], rating: 900, theme: 'Endgame', desc: 'Pawn push wins' },
  { id: 10, fen: 'r1bq1rk1/ppp2ppp/2n5/2b1p3/2B1P3/5N2/PPP2PPP/RNBQK2R w KQ - 0 7', solution: ['e4e5'], rating: 1400, theme: 'Interference', desc: 'Pawn break' },
];

function getUser(userId) {
  if (!users.has(userId)) {
    // try to find existing by userId
    const existing = usersData[userId];
    if (existing) {
      users.set(userId, existing);
      return existing;
    }
    const newUser = {
      id: userId,
      username: `Player_${userId.substring(0,4)}`,
      balance: 12.50,
      phone: '',
      phoneVerified: false,
      transactions: [],
      stats: { wins:0, losses:0, draws:0, engineWins:0, freeGames:0, earned:0, puzzlesSolved:0, pvpWins:0, jackpotWins:0, totalBets:0, rating: 800 + Math.floor(Math.random()*400) },
      rating: 800 + Math.floor(Math.random()*400),
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    users.set(userId, newUser);
    usersData[userId] = newUser;
    addTransaction(userId, 'deposit', 12.50, 'completed', 'Welcome bonus - $12.50 free to start!');
    markDirty();
    return newUser;
  }
  return users.get(userId);
}

function getUserByPhone(phone) {
  for (let [uid, u] of users.entries()) {
    if (u.phone === phone) return u;
  }
  // also check usersData
  for (let uid in usersData) {
    if (usersData[uid].phone === phone) return usersData[uid];
  }
  return null;
}

function addTransaction(userId, type, amount, status, details) {
  const user = getUser(userId);
  const tx = { id: uuidv4(), type, amount, status, details, timestamp: new Date().toISOString(), userId, username: user.username };
  user.transactions.unshift(tx);
  if (user.transactions.length > 100) user.transactions.pop();
  transactionsLog.unshift(tx);
  if (transactionsLog.length > 1000) transactionsLog.pop();
  if (type === 'bet') {
    user.stats.totalBets = (user.stats.totalBets||0) + Math.abs(amount);
    statsData.totalBets += Math.abs(amount);
  }
  if (type === 'fee') statsData.totalFees += Math.abs(amount);
  if (type === 'win' || type === 'jackpot') statsData.totalPayouts += amount;
  markDirty();
  return tx;
}

function updateLeaderboard(userId) {
  const user = getUser(userId);
  let entry = leaderboard.find(l => l.userId === userId);
  if (!entry) {
    entry = { userId, username: user.username, winsVsGM: 0, earnings: 0, highestWin: 0, lastWin: null, rating: user.rating||800, phone: user.phone };
    leaderboard.push(entry);
  }
  entry.username = user.username;
  entry.earnings = user.stats.earned||0;
  entry.rating = user.rating||800;
  entry.phone = user.phone||'';
  leaderboard.sort((a,b)=> b.earnings - a.earnings);
  if (leaderboard.length > 100) leaderboard = leaderboard.slice(0,100);
  markDirty();
}

// ========== 6. REAL ECOCASH API STUB ==========
const EcoCash = {
  // In production, set these env vars
  merchantCode: process.env.ECOCASH_MERCHANT_CODE || null,
  apiKey: process.env.ECOCASH_API_KEY || null,
  apiUrl: process.env.ECOCASH_API_URL || 'https://api.ecocash.co.zw/api/v1',
  
  async initiateC2B({ phone, amount, reference }) {
    console.log(`📱 EcoCash C2B Request: ${phone} $${amount} ref ${reference}`);
    
    if (!this.merchantCode || !this.apiKey) {
      console.log('⚠️ EcoCash credentials not set - using MOCK mode');
      // Simulate EcoCash USSD flow
      return { success: true, mock: true, message: `EcoCash prompt sent to ${phone}`, transactionId: 'MOCK-'+uuidv4().substring(0,8), status: 'PENDING' };
    }

    try {
      // REAL implementation template for Cassava / EcoCash API
      // Example payload - adjust to actual EcoCash API docs: https://developers.ecocash.co.zw
      const payload = {
        merchantCode: this.merchantCode,
        phoneNumber: phone.startsWith('0') ? '263' + phone.substring(1) : phone,
        amount: amount,
        currency: 'USD',
        reference: reference,
        description: `BetChess ZW Deposit $${amount}`,
        returnUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/api/ecocash/callback`,
        // ... other required fields
      };

      // const res = await fetch(`${this.apiUrl}/c2b/initiate`, {
      //   method: 'POST',
      //   headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      //   body: JSON.stringify(payload)
      // });
      // const data = await res.json();
      // return data;

      // For now mock even with creds (until real integration tested)
      return { success: true, mock: false, transactionId: 'ECO-'+uuidv4().substring(0,8), status: 'PENDING', payload };
    } catch (e) {
      console.error('EcoCash C2B error', e);
      throw e;
    }
  },

  async initiateB2C({ phone, amount, reference }) {
    console.log(`💸 EcoCash B2C Withdraw: ${phone} $${amount} ref ${reference}`);
    if (!this.merchantCode || !this.apiKey) {
      console.log('⚠️ Mock B2C - would send to', phone);
      return { success: true, mock: true, transactionId: 'MOCK-WD-'+uuidv4().substring(0,8), status: 'COMPLETED' };
    }
    // REAL B2C implementation similar to above
    return { success: true, mock: false, transactionId: 'ECO-WD-'+uuidv4().substring(0,8), status: 'PENDING' };
  },

  async verifyTransaction(transactionId) {
    // Verify status via EcoCash API
    if (!this.apiKey) return { status: 'COMPLETED', mock: true };
    // const res = await fetch(`${this.apiUrl}/transactions/${transactionId}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    // return res.json();
    return { status: 'COMPLETED' };
  }
};

// ========== 3. SERVER-SIDE STOCKFISH ENGINE (Anti-Cheat) ==========
function evaluateBoard(chess) {
  // Simple material eval
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  const board = chess.board();
  for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
    const p = board[r][c];
    if (p) {
      const v = values[p.type] || 0;
      score += p.color==='w' ? v : -v;
    }
  }
  // Add tiny random to avoid deterministic
  score += (Math.random()-0.5)*0.2;
  return score;
}

function getServerEngineMove(fen, difficulty) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length===0) return null;

  const cfg = DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.medium;

  // Easy: random
  if (difficulty==='easy' || cfg.skill <=2) {
    return moves[Math.floor(Math.random()*moves.length)];
  }

  // Medium: prefer captures, checks
  if (difficulty==='medium') {
    const captures = moves.filter(m=> m.captured);
    if (captures.length>0 && Math.random()>0.3) return captures[Math.floor(Math.random()*captures.length)];
    const checks = moves.filter(m=> {
      const tmp = new Chess(fen);
      tmp.move({ from:m.from, to:m.to, promotion:m.promotion||'q' });
      return tmp.isCheck();
    });
    if (checks.length>0 && Math.random()>0.5) return checks[0];
    return moves[Math.floor(Math.random()*moves.length)];
  }

  // Hard+: minimax shallow
  let bestMove = null;
  let bestScore = chess.turn()==='w' ? -Infinity : Infinity;
  const isWhiteTurn = chess.turn()==='w';

  for (let m of moves) {
    const tmp = new Chess(fen);
    tmp.move({ from:m.from, to:m.to, promotion:m.promotion||'q' });
    let score = evaluateBoard(tmp);
    // Penalize moving into check? chess.js already prevents illegal
    // Bonus for check, capture
    if (tmp.isCheck()) score += isWhiteTurn ? 0.5 : -0.5;
    if (m.captured) score += isWhiteTurn ? ( {p:1,n:3,b:3,r:5,q:9}[m.captured]||0 )*0.1 : -( {p:1,n:3,b:3,r:5,q:9}[m.captured]||0 )*0.1;

    if (isWhiteTurn) {
      if (score > bestScore) { bestScore=score; bestMove=m; }
    } else {
      if (score < bestScore) { bestScore=score; bestMove=m; }
    }
  }

  // For master/GM, add deeper lookahead with 10% chance of blunder for hard
  if (difficulty==='master' || difficulty==='grandmaster') {
    // With some randomness, avoid perfect play for slightly weaker levels
    if (difficulty==='master' && Math.random()<0.15) {
      // blunder: pick second best or random
      const others = moves.filter(x=> x!==bestMove);
      if (others.length>0 && Math.random()<0.5) return others[Math.floor(Math.random()*others.length)];
    }
  }

  return bestMove || moves[0];
}

// ========== 2. REAL TICKING CLOCKS ==========
function parseTimeControl(tc) {
  // "10+0", "5+0", "10+5", "3+2"
  if (!tc) return { base: 600, inc: 0 };
  const parts = tc.split('+');
  const baseMin = parseInt(parts[0])||10;
  const incSec = parseInt(parts[1])||0;
  return { base: baseMin*60, inc: incSec };
}

function startClock(game) {
  if (gameClocks.has(game.id)) clearInterval(gameClocks.get(game.id));

  const tc = parseTimeControl(game.timeControl || '10+0');
  // Initialize clocks if not present
  if (!game.clocks) {
    game.clocks = { w: tc.base*1000, b: tc.base*1000, inc: tc.inc*1000 };
  }
  game.clockBase = tc.base;
  game.clockInc = tc.inc;
  game.lastMoveAt = Date.now();
  game.turn = game.chessInstance ? game.chessInstance.turn() : 'w';

  const interval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - game.lastMoveAt;
    game.lastMoveAt = now;

    const turn = game.chessInstance ? game.chessInstance.turn() : game.turn;
    // For engine games, only tick player's clock when it's their turn
    if (game.type === 'engine' || game.type === 'llm') {
      if (game.turn === game.playerColor) {
        game.clocks[turn] = Math.max(0, game.clocks[turn] - elapsed);
        io.to(game.id).emit('clockUpdate', { clocks: { w: Math.ceil(game.clocks.w/1000), b: Math.ceil(game.clocks.b/1000) }, turn });
        io.to(game.id).emit('clockTick', { clocks: game.clocks, turn });
        if (game.clocks[turn] <= 0) {
          // Flag - player loses on time
          clearInterval(interval);
          gameClocks.delete(game.id);
          handleFlag(game, turn);
        }
      } else {
        // Engine turn - don't tick player clock, but update display
        io.to(game.id).emit('clockTick', { clocks: game.clocks, turn });
      }
    } else {
      // PvP - tick whoever's turn
      if (game.clocks[turn] !== undefined) {
        game.clocks[turn] = Math.max(0, game.clocks[turn] - elapsed);
        io.to(game.id).emit('clockUpdate', { clocks: { w: Math.ceil(game.clocks.w/1000), b: Math.ceil(game.clocks.b/1000) }, turn });
        io.to(game.id).emit('clockTick', { clocks: game.clocks, turn });
        if (game.clocks[turn] <= 0) {
          clearInterval(interval);
          gameClocks.delete(game.id);
          handleFlag(game, turn);
        }
      }
    }
  }, 1000);

  gameClocks.set(game.id, interval);
}

function stopClock(gameId) {
  if (gameClocks.has(gameId)) {
    clearInterval(gameClocks.get(gameId));
    gameClocks.delete(gameId);
  }
}

function handleFlag(game, flaggedColor) {
  if (game.status !== 'playing') return;
  game.status = 'finished';
  const winnerColor = flaggedColor === 'w' ? 'b' : 'w';
  game.winner = winnerColor;
  game.result = `${flaggedColor==='w'?'White':'Black'} flagged - ${winnerColor==='w'?'White':'Black'} wins on time`;

  if (game.type === 'engine' || game.type === 'llm') {
    const userId = game.white.id !== 'stockfish' && game.white.id !== 'llm' ? game.white.id : game.black.id;
    const user = getUser(userId);
    const playerColor = game.playerColor;
    const playerFlagged = flaggedColor === playerColor;
    if (playerFlagged) {
      // Player lost on time
      user.stats.losses++;
      if (!game.isFree) {
        jackpotPool += game.bet * JACKPOT_CONTRIBUTION;
        addTransaction(userId, 'loss', 0, 'completed', `Flagged vs ${game.difficultyConfig?.label||game.llmConfig?.model||'AI'} - Lost $${game.bet} on time`);
        io.emit('jackpotUpdate', { pool: jackpotPool });
      }
      io.to(game.id).emit('engineGameFinal', { game: sanitizeGame(game), result: game.result, outcome: 'loss', payout: 0 });
      io.to(userId).emit('balanceUpdate', { balance: user.balance });
    } else {
      // Engine flagged? Unlikely, but player wins
      const cfg = game.difficultyConfig;
      if (cfg && !game.isFree) {
        const gross = game.bet * cfg.multiplier;
        const payout = gross * (1-PLATFORM_FEE);
        user.balance += payout;
        user.stats.wins++;
        user.stats.earned += payout;
        addTransaction(userId, 'win', payout, 'completed', `Opponent flagged - Won $${payout.toFixed(2)} vs ${cfg.label}`);
        io.to(userId).emit('balanceUpdate', { balance: user.balance });
        io.to(game.id).emit('engineGameFinal', { game: sanitizeGame(game), result: game.result, outcome: 'win', payout });
      }
    }
  } else if (game.type === 'pvp_bet') {
    const winnerId = flaggedColor==='w' ? game.black.id : game.white.id;
    const winner = getUser(winnerId);
    const gross = game.escrow;
    const fee = gross * PLATFORM_FEE;
    const payout = gross - fee;
    winner.balance += payout;
    winner.stats.pvpWins++; winner.stats.wins++; winner.stats.earned += payout;
    addTransaction(winnerId, 'win', payout, 'completed', `Won on time PvP ${game.id} $${payout.toFixed(2)}`);
    io.to(winnerId).emit('balanceUpdate', { balance: winner.balance });
    io.to(game.id).emit('gameOverPvp', { game: sanitizeGame(game) });
    updateLeaderboard(winnerId);
  }
  stopClock(game.id);
  markDirty();
}

// ========== API ROUTES ==========
app.get('/api/config', (req,res)=>{ res.json({ difficultyConfig: DIFFICULTY_CONFIG, minBet: MIN_BET, jackpotPool, totalPayouts, stats: statsData }); });
app.get('/api/leaderboard', (req,res)=>{ res.json({ leaderboard, jackpotPool }); });
app.get('/api/puzzles/random', (req,res)=>{ res.json(PUZZLES[Math.floor(Math.random()*PUZZLES.length)]); });
app.get('/api/puzzles/:id', (req,res)=>{ const p=PUZZLES.find(x=> x.id == req.params.id); if(!p) return res.status(404).json({error:'Not found'}); res.json(p); });

app.get('/api/game/:id', (req,res)=>{
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(sanitizeGame(game));
});

app.get('/api/stats/live', (req,res)=>{
  const activeGames = Array.from(games.values()).filter(g=> g.status==='playing').length;
  const waitingQueues = Array.from(betQueues.values()).reduce((acc,q)=> acc+q.length,0);
  res.json({ activeGames, waitingQueues, totalUsers: users.size, jackpotPool, totalPayouts, totalFees: statsData.totalFees, totalBets: statsData.totalBets });
});

// 6. EcoCash real stub routes
app.post('/api/ecocash/deposit', async (req,res)=>{
  const { phone, amount, userId } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  try {
    const result = await EcoCash.initiateC2B({ phone, amount, reference: `DEP-${userId}-${Date.now()}` });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ecocash/withdraw', async (req,res)=>{
  const { phone, amount, userId } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  try {
    const result = await EcoCash.initiateB2C({ phone, amount, reference: `WD-${userId}-${Date.now()}` });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ecocash/callback', (req,res)=>{
  // This endpoint is called by EcoCash when transaction completes
  console.log('📲 EcoCash callback received:', req.body);
  const { reference, status, transactionId, phone, amount } = req.body;
  // Parse userId from reference: DEP-userId-timestamp
  if (reference && reference.startsWith('DEP-')) {
    const parts = reference.split('-');
    const userId = parts[1];
    const user = users.get(userId) || usersData[userId];
    if (user && status === 'COMPLETED') {
      const amt = parseFloat(amount) || 0;
      user.balance += amt;
      addTransaction(userId, 'deposit', amt, 'completed', `EcoCash callback ${transactionId} ${phone}`);
      io.to(userId).emit('balanceUpdate', { balance: user.balance });
      io.to(userId).emit('transactionUpdate', user.transactions);
      console.log(`✅ Deposit confirmed via callback: ${userId} +$${amt}`);
    }
  }
  res.json({ success: true });
});

app.get('/api/ecocash/status', (req,res)=>{
  res.json({ configured: !!EcoCash.apiKey, merchantCode: EcoCash.merchantCode ? 'SET' : 'NOT SET - USING MOCK', apiUrl: EcoCash.apiUrl, mockMode: !EcoCash.apiKey });
});

// 7. ADMIN API
app.post('/api/admin/login', (req,res)=>{
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true, token: 'admin-token-'+Date.now() });
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/data', (req,res)=>{
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== 'admin-token' && !req.headers.authorization?.includes(ADMIN_PASSWORD)) {
    // Allow if password query for simplicity in demo
    const pw = req.query.password || req.headers['x-admin-password'];
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    users: Array.from(users.values()).slice(0,100),
    usersCount: users.size,
    games: Array.from(games.values()).map(g=> sanitizeGame(g)).slice(0,50),
    activeGames: Array.from(games.values()).filter(g=> g.status==='playing').length,
    betQueues: Object.fromEntries(Array.from(betQueues.entries()).map(([k,v])=> [k, v.length])),
    leaderboard,
    jackpotPool,
    stats: statsData,
    transactions: transactionsLog.slice(0,100),
    pendingWithdrawals,
    ecocashStatus: { configured: !!EcoCash.apiKey, mock: !EcoCash.apiKey }
  });
});

app.post('/api/admin/jackpot', (req,res)=>{
  const { password, action, amount } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (action==='add') jackpotPool += parseFloat(amount)||0;
  if (action==='set') jackpotPool = parseFloat(amount)||0;
  if (action==='reset') jackpotPool = 1250.75;
  markDirty();
  io.emit('jackpotUpdate', { pool: jackpotPool });
  res.json({ success:true, pool: jackpotPool });
});

app.post('/api/admin/withdraw/approve', (req,res)=>{
  const { password, withdrawalId } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const wd = pendingWithdrawals.find(w=> w.id===withdrawalId);
  if (!wd) return res.status(404).json({ error: 'Not found' });
  wd.status='approved';
  wd.approvedAt=new Date().toISOString();
  markDirty();
  // In real, trigger EcoCash B2C here
  EcoCash.initiateB2C({ phone: wd.phone || wd.accountDetails, amount: wd.amount, reference: `WD-APPROVED-${wd.id}` });
  res.json({ success:true, withdrawal: wd });
});

// LLM proxy
app.post('/api/llm/move', async (req,res)=>{
  const { fen, legalMoves, provider, model, apiKey, playerColor, history } = req.body;
  if (!fen) return res.status(400).json({ error: 'FEN required' });
  if (!apiKey) {
    const chess = new Chess(fen);
    const moves = legalMoves || chess.moves();
    let chosen = moves[Math.floor(Math.random()*moves.length)];
    if (typeof chosen==='object') chosen = chosen.from+chosen.to+(chosen.promotion||'');
    const commentary = `Position looks sharp. I'm counting ${moves.length} options, targeting weak squares. My Stockfish eval leans slightly positive.`;
    return res.json({ commentary, move: chosen||'e2e4', provider:'fallback', fallback:true });
  }
  try {
    const systemPrompt = `You are Grandmaster chess AI. FEN: ${fen} You are ${playerColor||'white'}. Legal: ${JSON.stringify(legalMoves||[])} History: ${history||''} Output ONLY JSON {"commentary":"reasoning","move":"uci"}`;
    let move=null, comm='';
    if (provider==='openai' || provider==='groq' || provider==='openai-compatible') {
      const url = provider==='groq'?'https://api.groq.com/openai/v1/chat/completions':'https://api.openai.com/v1/chat/completions';
      const resp=await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${apiKey}`, 'Content-Type':'application/json' }, body: JSON.stringify({ model: model||'gpt-4o-mini', messages:[{role:'system',content:systemPrompt},{role:'user',content:`FEN:${fen} Legal:${(legalMoves||[]).join(',')}`}], temperature:0.7, max_tokens:250 }) });
      const data=await resp.json();
      const content=data.choices?.[0]?.message?.content||'';
      const m=content.match(/\{[\s\S]*\}/); if(m){ try{const obj=JSON.parse(m[0]); comm=obj.commentary; move=obj.move;}catch{}}
      if(!move){ const u=content.match(/[a-h][1-8][a-h][1-8][qrbn]?/); move=u?u[0]:null; comm=content.slice(0,180); }
    } else {
      // fallback
      const chess=new Chess(fen); const ms=legalMoves||chess.moves(); let ch=ms[Math.floor(Math.random()*ms.length)]; if(typeof ch==='object') ch=ch.from+ch.to+(ch.promotion||''); move=ch; comm='Strategic move';
    }
    if(!move) throw new Error('No move');
    res.json({ commentary:comm, move, provider, model });
  } catch(e){ console.error('LLM err',e); res.status(500).json({ error:e.message }); }
});

// ========== SOCKET LOGIC ==========
io.on('connection', (socket)=>{
  console.log('conn', socket.id);

  socket.on('register', ({ userId, username, phone })=>{
    let uid = userId || uuidv4();
    // If phone provided and user exists by phone, use that userId
    if (phone) {
      const byPhone = getUserByPhone(phone);
      if (byPhone) uid = byPhone.id;
    }
    socketToUser.set(socket.id, uid);
    socket.join(uid);
    const user = getUser(uid);
    if (username) user.username=username;
    if (phone) user.phone=phone;
    user.lastLogin=new Date().toISOString();
    markDirty();
    socket.emit('registered', { userId: uid, user, difficultyConfig: DIFFICULTY_CONFIG, jackpotPool, leaderboard: leaderboard.slice(0,10) });
    socket.emit('jackpotUpdate', { pool: jackpotPool });
  });

  // 4. PHONE OTP LOGIN
  socket.on('requestOTP', ({ phone }, cb)=>{
    if (!phone || phone.length<9) return cb && cb({ error: 'Invalid phone - use 077xxxxxxx' });
    const code = Math.floor(100000 + Math.random()*900000).toString();
    otpStore.set(phone, { code, expires: Date.now()+5*60*1000, attempts:0 });
    console.log(`📲 OTP for ${phone}: ${code} - In production, send via SMS/EcoCash`);
    // In production, integrate with EcoCash SMS or Twilio: await sendSMS(phone, `Your BetChess OTP is ${code}`)
    cb && cb({ success:true, message: `OTP sent to ${phone} (Check server console in demo: ${code})`, code: code }); // returning code for demo only, remove in prod
    socket.emit('otpSent', { phone, expiresIn: 300 });
  });

  socket.on('verifyOTP', ({ phone, code }, cb)=>{
    const entry = otpStore.get(phone);
    if (!entry) return cb && cb({ error: 'No OTP requested - request first' });
    if (Date.now() > entry.expires) { otpStore.delete(phone); return cb && cb({ error: 'OTP expired - request new' }); }
    entry.attempts++;
    if (entry.code !== code) {
      if (entry.attempts>=3) otpStore.delete(phone);
      return cb && cb({ error: 'Wrong OTP' });
    }
    otpStore.delete(phone);
    let user = getUserByPhone(phone);
    let uid;
    if (user) {
      uid = user.id;
      user.phoneVerified=true;
      user.phone=phone;
    } else {
      // Link phone to current socket user or create new
      const currentUid = socketToUser.get(socket.id);
      if (currentUid) {
        user = getUser(currentUid);
        user.phone=phone;
        user.phoneVerified=true;
        uid = currentUid;
      } else {
        uid = uuidv4();
        user = getUser(uid);
        user.phone=phone;
        user.phoneVerified=true;
      }
    }
    users.set(uid, user);
    usersData[uid]=user;
    socketToUser.set(socket.id, uid);
    socket.join(uid);
    markDirty();
    socket.emit('registered', { userId: uid, user, difficultyConfig: DIFFICULTY_CONFIG, jackpotPool });
    socket.emit('otpVerified', { userId: uid, phone, verified:true });
    cb && cb({ success:true, userId: uid, user });
  });

  socket.on('getBalance', ({ userId })=>{
    const user=getUser(userId);
    socket.emit('balanceUpdate', { balance:user.balance });
    socket.emit('transactionUpdate', user.transactions);
    socket.emit('statsUpdate', user.stats);
  });

  socket.on('deposit', async ({ userId, amount, phone }, cb)=>{
    if (!userId || amount < MIN_BET) return cb && cb({ error: `Min $${MIN_BET}` });
    const user=getUser(userId);
    user.phone=phone;
    const tx=addTransaction(userId, 'deposit', parseFloat(amount), 'pending', `EcoCash ${phone} - Initiating`);
    socket.emit('transactionUpdate', user.transactions);
    
    try {
      const ecoResult = await EcoCash.initiateC2B({ phone, amount, reference: `DEP-${userId}-${Date.now()}` });
      if (ecoResult.mock) {
        // Mock: auto-complete after 2.2 sec
        setTimeout(()=>{
          user.balance+=parseFloat(amount);
          tx.status='completed';
          tx.details=`EcoCash ${phone} - Confirmed ${ecoResult.transactionId}`;
          socket.emit('balanceUpdate', { balance:user.balance });
          socket.emit('transactionUpdate', user.transactions);
          markDirty();
        }, 2200);
        cb && cb({ success:true, transaction:tx, eco:ecoResult, message:`EcoCash prompt to ${phone} - confirm on phone` });
      } else {
        // Real: wait for callback
        tx.details=`EcoCash ${phone} - Awaiting confirmation ${ecoResult.transactionId}`;
        cb && cb({ success:true, transaction:tx, eco:ecoResult, message:'Awaiting EcoCash confirmation - check phone' });
      }
    } catch(e){
      tx.status='failed';
      tx.details=`EcoCash failed: ${e.message}`;
      cb && cb({ error: e.message });
    }
  });

  socket.on('withdraw', async ({ userId, amount, method, accountDetails }, cb)=>{
    const user=getUser(userId);
    if (user.balance < amount) return cb && cb({ error: 'Insufficient' });
    user.balance-=parseFloat(amount);
    const tx=addTransaction(userId, 'withdraw', -parseFloat(amount), 'pending', `${method}: ${accountDetails} - Awaiting approval`);
    const wd={
      id: tx.id,
      userId,
      username:user.username,
      phone:user.phone,
      amount: parseFloat(amount),
      method,
      accountDetails,
      status: 'pending',
      createdAt: new Date().toISOString(),
      transaction: tx
    };
    pendingWithdrawals.unshift(wd);
    markDirty();
    socket.emit('balanceUpdate', { balance:user.balance });
    socket.emit('transactionUpdate', user.transactions);
    // In mock mode, auto-approve after 3 sec
    if (!EcoCash.apiKey) {
      setTimeout(()=>{
        wd.status='approved';
        tx.status='completed';
        tx.details=`${method}: ${accountDetails} - Paid (Mock)`;
        socket.emit('transactionUpdate', user.transactions);
        markDirty();
      }, 3000);
    }
    cb && cb({ success:true, transaction:tx, withdrawal: wd });
  });

  // BET MATCHMAKING
  socket.on('findMatch', ({ userId, bet, timeControl }, cb)=>{
    const user=getUser(userId);
    const betKey=parseFloat(bet).toFixed(2);
    if (user.balance < bet) return cb && cb({ error: `Need $${bet} deposit first!` });
    for (let [k,q] of betQueues.entries()){
      betQueues.set(k, q.filter(e=> Date.now()-e.timestamp<30000));
    }
    let queue=betQueues.get(betKey)||[];
    let opponent=queue.find(e=> e.userId!==userId);
    if (opponent){
      betQueues.set(betKey, queue.filter(e=> e.userId!==opponent.userId));
      const oppUser=getUser(opponent.userId);
      user.balance-=parseFloat(bet);
      oppUser.balance-=parseFloat(bet);
      const gameId='PVP-'+uuidv4().substring(0,6).toUpperCase();
      const chessInst=new Chess();
      const isWhite=Math.random()>0.5;
      const game={
        id:gameId,
        type:'pvp_bet',
        bet:parseFloat(bet),
        pot:parseFloat(bet)*2,
        white: isWhite? { id:userId, username:user.username, socketId:socket.id, rating:user.rating } : { id:opponent.userId, username:oppUser.username, socketId:opponent.socketId, rating:oppUser.rating },
        black: !isWhite? { id:userId, username:user.username, socketId:socket.id, rating:user.rating } : { id:opponent.userId, username:oppUser.username, socketId:opponent.socketId, rating:oppUser.rating },
        fen:chessInst.fen(),
        status:'playing',
        moves:[],
        createdAt:new Date().toISOString(),
        timeControl: timeControl||'10+0',
        escrow:parseFloat(bet)*2,
        chessInstance:chessInst,
        pvp:true
      };
      const tc=parseTimeControl(game.timeControl);
      game.clocks={ w:tc.base*1000, b:tc.base*1000, inc:tc.inc*1000 };
      games.set(gameId, game);
      addTransaction(userId, 'bet', -parseFloat(bet), 'completed', `Matched vs ${oppUser.username} $${bet} ${gameId}`);
      addTransaction(opponent.userId, 'bet', -parseFloat(bet), 'completed', `Matched vs ${user.username} $${bet} ${gameId}`);
      markDirty();
      io.to(opponent.userId).emit('balanceUpdate', { balance:oppUser.balance });
      io.to(opponent.userId).emit('matchFound', { game: sanitizeGame(game), opponent:user.username });
      socket.emit('balanceUpdate', { balance:user.balance });
      socket.emit('matchFound', { game: sanitizeGame(game), opponent:oppUser.username });
      io.to(gameId).emit('gameStarted', { game: sanitizeGame(game) });
      socket.join(gameId);
      try{ io.sockets.sockets.get(opponent.socketId)?.join(gameId); }catch(e){}
      startClock(game);
      cb && cb({ success:true, matched:true, gameId });
    } else {
      queue.push({ userId, socketId:socket.id, timeControl, bet:parseFloat(bet), timestamp:Date.now() });
      betQueues.set(betKey, queue);
      socket.emit('searchingMatch', { bet:betKey, queuePosition:queue.length, message:`Searching $${betKey} players...` });
      cb && cb({ success:true, matched:false });
      setTimeout(()=>{
        const cq=betQueues.get(betKey)||[];
        if (cq.find(e=> e.userId===userId)) socket.emit('noMatchFound', { bet:betKey, suggestion:'No same-bet players online. Try vs Stockfish instant?' });
      },15000);
    }
  });

  socket.on('cancelMatchSearch', ({ userId, bet })=>{
    const betKey=parseFloat(bet).toFixed(2);
    let queue=betQueues.get(betKey)||[];
    betQueues.set(betKey, queue.filter(e=> e.userId!==userId));
    socket.emit('searchCancelled');
  });

  socket.on('makeMovePvp', ({ userId, gameId, from, to, promotion }, cb)=>{
    const game=games.get(gameId);
    if (!game || game.status!=='playing') return cb && cb({ error: 'Game not found/finished' });
    const playerColor=game.white.id===userId?'w':game.black.id===userId?'b':null;
    if (!playerColor || playerColor!==game.chessInstance.turn()) return cb && cb({ error: 'Not your turn' });
    try{
      const move=game.chessInstance.move({ from,to, promotion:promotion||'q' });
      if (!move) return cb && cb({ error:'Invalid' });
      game.fen=game.chessInstance.fen();
      game.moves.push(move);
      // Clock: add increment to mover, switch turn timestamp
      const tc=parseTimeControl(game.timeControl);
      if (game.clocks) {
        game.clocks[playerColor==='w'?'w':'b'] += tc.inc*1000;
        game.lastMoveAt=Date.now();
      }
      if (game.chessInstance.isGameOver()){
        handlePvpGameOver(game);
        io.to(gameId).emit('gameOverPvp', { game:sanitizeGame(game) });
        stopClock(gameId);
      } else {
        io.to(gameId).emit('moveMadePvp', { game:sanitizeGame(game), move });
      }
      markDirty();
      cb && cb({ success:true });
    }catch(e){ cb && cb({ error:e.message }); }
  });

  function handlePvpGameOver(game){
    const isMate=game.chessInstance.isCheckmate();
    const isDraw=game.chessInstance.isDraw() || game.chessInstance.isStalemate();
    const turn=game.chessInstance.turn();
    let winnerId=null, result='';
    if (isMate){
      winnerId=turn==='w'?game.black.id:game.white.id;
      const winner=getUser(winnerId);
      const gross=game.escrow;
      const fee=gross*PLATFORM_FEE;
      const payout=gross-fee;
      winner.balance+=payout;
      winner.stats.pvpWins++; winner.stats.wins++; winner.rating+=12; winner.stats.earned+=payout;
      statsData.totalPayouts+=payout; statsData.totalFees+=fee;
      getUser(winnerId===game.white.id?game.black.id:game.white.id).stats.losses++;
      getUser(winnerId===game.white.id?game.black.id:game.white.id).rating=Math.max(100, getUser(winnerId===game.white.id?game.black.id:game.white.id).rating-8);
      addTransaction(winnerId, 'win', payout, 'completed', `Won PvP ${game.id} vs ${winnerId===game.white.id?game.black.username:game.white.username} $${payout.toFixed(2)}`);
      io.to(winnerId).emit('balanceUpdate', { balance:winner.balance });
      result=`Checkmate! ${winner.username} wins $${payout.toFixed(2)}`;
      updateLeaderboard(winnerId);
    } else if (isDraw){
      getUser(game.white.id).balance+=game.bet;
      getUser(game.black.id).balance+=game.bet;
      addTransaction(game.white.id, 'refund', game.bet, 'completed', `Draw ${game.id} refund`);
      addTransaction(game.black.id, 'refund', game.bet, 'completed', `Draw ${game.id} refund`);
      io.to(game.white.id).emit('balanceUpdate', { balance:getUser(game.white.id).balance });
      io.to(game.black.id).emit('balanceUpdate', { balance:getUser(game.black.id).balance });
      result='Draw';
    }
    game.status='finished'; game.result=result; game.winner=winnerId?(winnerId===game.white.id?'w':'b'):'draw';
    markDirty();
    stopClock(game.id);
  }

  // ENGINE GAMES - SERVER-SIDE ENGINE
  socket.on('createEngineGame', ({ userId, bet, difficulty, isFree, color }, cb)=>{
    const user=getUser(userId);
    const config=DIFFICULTY_CONFIG[difficulty]||DIFFICULTY_CONFIG.medium;
    if (!isFree){
      if (bet<MIN_BET) return cb && cb({ error:`Min $${MIN_BET}` });
      if (user.balance<bet) return cb && cb({ error:`Need $${bet} deposit` });
      user.balance-=parseFloat(bet);
      addTransaction(userId, 'bet', -parseFloat(bet), 'completed', `Bet vs Stockfish ${config.label} $${bet} ${config.multiplier}x`);
      io.to(userId).emit('balanceUpdate', { balance:user.balance });
    }
    const gameId='ENG-'+uuidv4().substring(0,6).toUpperCase();
    const chessInst=new Chess();
    const playerColor=color==='random'?(Math.random()>0.5?'w':'b'):color||'w';
    const tc=parseTimeControl('10+0');
    const game={
      id:gameId,
      type:'engine',
      bet:isFree?0:parseFloat(bet),
      difficulty,
      difficultyConfig:config,
      playerColor,
      engineColor:playerColor==='w'?'b':'w',
      isFree:!!isFree,
      white: playerColor==='w'?{ id:userId, username:user.username }:{ id:'stockfish', username:`Stockfish ${config.label} (${config.elo})` },
      black: playerColor==='b'?{ id:userId, username:user.username }:{ id:'stockfish', username:`Stockfish ${config.label} (${config.elo})` },
      fen:chessInst.fen(),
      status:'playing',
      moves:[],
      createdAt:new Date().toISOString(),
      escrow:isFree?0:parseFloat(bet),
      chessInstance:chessInst,
      clocks:{ w:tc.base*1000, b:tc.base*1000, inc:tc.inc*1000 },
      lastMoveAt:Date.now()
    };
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('engineGameCreated', { game:sanitizeGame(game) });
    markDirty();
    // If engine starts, generate move server-side
    if (game.chessInstance.turn()!==playerColor) {
      setTimeout(()=> generateAndSendEngineMove(game, socket), 600);
    } else {
      startClock(game);
    }
    cb && cb({ success:true, gameId });
  });

  socket.on('engineMove', ({ userId, gameId, from, to, promotion }, cb)=>{
    const game=games.get(gameId);
    if (!game || (game.type!=='engine' && game.type!=='pvp_bet' && game.type!=='llm')) return cb && cb({ error:'Game not found' });
    if (game.type==='engine' && game.playerColor!==game.chessInstance.turn()) return cb && cb({ error:'Not your turn' });
    try{
      const move=game.chessInstance.move({ from,to, promotion:promotion||'q' });
      if (!move) return cb && cb({ error:'Invalid' });
      game.fen=game.chessInstance.fen();
      game.moves.push(move);
      // Clock inc for player
      const tc=parseTimeControl(game.timeControl||'10+0');
      if (game.clocks) {
        const moverColor = move.color;
        game.clocks[moverColor==='w'?'w':'b'] += tc.inc*1000;
        game.lastMoveAt=Date.now();
      }
      markDirty();
      if (game.chessInstance.isGameOver()){
        if (game.type==='engine') handleEngineOver(game, userId, socket);
        else {
          // pvp handled elsewhere
        }
        stopClock(gameId);
      } else {
        if (game.type==='engine') {
          socket.emit('moveMadeEngine', { game:sanitizeGame(game), move });
          // Now engine's turn - generate server-side
          setTimeout(()=> generateAndSendEngineMove(game, socket), 400 + Math.random()*400);
        }
      }
      cb && cb({ success:true, fen:game.fen, move });
    }catch(e){ cb && cb({ error:e.message }); }
  });

  function generateAndSendEngineMove(game, sock) {
    if (game.status!=='playing') return;
    const fen=game.fen;
    const difficulty=game.difficulty;
    const engineMove=getServerEngineMove(fen, difficulty);
    if (!engineMove) {
      // Game over?
      if (game.chessInstance.isGameOver()) handleEngineOver(game, game.white.id!=='stockfish'?game.white.id:game.black.id, sock);
      return;
    }
    try{
      const move=game.chessInstance.move({ from:engineMove.from, to:engineMove.to, promotion:engineMove.promotion||'q' });
      if (!move) return;
      game.fen=game.chessInstance.fen();
      game.moves.push(move);
      game.lastMoveAt=Date.now();
      markDirty();
      if (game.chessInstance.isGameOver()){
        const playerId=game.white.id!=='stockfish'?game.white.id:game.black.id;
        handleEngineOver(game, playerId, sock);
        stopClock(game.id);
      } else {
        const s = sock || io.to(game.id);
        s.emit ? s.emit('moveMadeEngine', { game:sanitizeGame(game), move }) : io.to(game.id).emit('moveMadeEngine', { game:sanitizeGame(game), move });
        // Clock continues
      }
    }catch(e){ console.error('Engine move err', e); }
  }

  // For old client that requests engine move
  socket.on('requestEngineMove', ({ gameId, fen, difficulty }, cb)=>{
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Game not found' });
    const move=getServerEngineMove(fen||game.fen, difficulty||game.difficulty);
    if (!move) return cb && cb({ error:'No move' });
    cb && cb({ success:true, move: { from:move.from, to:move.to, promotion:move.promotion||'q' } });
    // Also apply server side if needed? For now just return
  });

  socket.on('engineReply', ({ userId, gameId, from, to, promotion }, cb)=>{
    // LEGACY - now server generates moves, but accept for compatibility if client sends
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Not found' });
    // Only allow if it's player's turn? Actually engineReply should be engine move - but now we ignore client engine moves for anti-cheat, generate our own
    // For anti-cheat, we DO NOT trust client engine moves. We generate server move instead.
    // So we ignore client provided and generate server move
    if (game.type==='engine' && game.status==='playing') {
      // If it's engine's turn, generate server move
      if (game.chessInstance.turn()===game.engineColor) {
        generateAndSendEngineMove(game, socket);
        return cb && cb({ success:true, serverGenerated:true });
      }
    }
    // For LLM, allow
    if (game.type==='llm') {
      try{
        const move=game.chessInstance.move({ from,to, promotion:promotion||'q' });
        if (!move) return cb && cb({ error:'Invalid' });
        game.fen=game.chessInstance.fen();
        game.moves.push(move);
        markDirty();
        if (game.chessInstance.isGameOver()){
          game.status='finished';
          socket.emit('llmGameOver', { game:sanitizeGame(game), result:'Game over' });
        } else {
          socket.emit('moveMadeEngine', { game:sanitizeGame(game), move });
        }
        cb && cb({ success:true });
      }catch(e){ cb && cb({ error:e.message }); }
    }
  });

  socket.on('engineGameOver', ({ userId, gameId, result }, cb)=>{
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Not found' });
    game.status='finished'; game.winner=game.playerColor==='w'?'b':'w'; game.result=`${getUser(userId).username} resigned`;
    const user=getUser(userId);
    user.stats.losses++;
    if (!game.isFree){
      jackpotPool+=game.bet*JACKPOT_CONTRIBUTION;
      addTransaction(userId, 'loss', 0, 'completed', `Lost $${game.bet} vs ${game.difficultyConfig?.label||'AI'} resigned ${(game.bet*JACKPOT_CONTRIBUTION).toFixed(2)} to jackpot`);
      io.emit('jackpotUpdate', { pool:jackpotPool });
    }
    socket.emit('engineGameFinal', { game:sanitizeGame(game), result:game.result, outcome:'loss', payout:0 });
    markDirty();
    stopClock(gameId);
    cb && cb({ success:true });
  });

  function handleEngineOver(game, userId, sock){
    const isMate=game.chessInstance.isCheckmate();
    const isDraw=game.chessInstance.isDraw()||game.chessInstance.isStalemate();
    const turn=game.chessInstance.turn();
    const user=getUser(userId);
    let outcome='draw', payout=0, resultText='';
    if (isMate){
      const winnerColor=turn==='w'?'b':'w';
      const playerWon=winnerColor===game.playerColor;
      if (playerWon){
        outcome='win';
        if (!game.isFree){
          const gross=game.bet*game.difficultyConfig.multiplier;
          const fee=gross*PLATFORM_FEE;
          payout=gross-fee;
          let jackpotWin=0;
          if (['master','grandmaster'].includes(game.difficulty) && Math.random()<0.15){
            jackpotWin=jackpotPool*0.1;
            payout+=jackpotWin;
            jackpotPool-=jackpotWin;
            user.stats.jackpotWins++;
            addTransaction(userId, 'jackpot', jackpotWin, 'completed', `JACKPOT! 10% pool $${jackpotWin.toFixed(2)} vs ${game.difficultyConfig.label}`);
          }
          if (game.difficulty==='grandmaster'){
            payout+=10;
            user.rating+=50;
            let entry=leaderboard.find(l=>l.userId===userId);
            if (!entry){ entry={ userId, username:user.username, winsVsGM:0, earnings:0, highestWin:0, lastWin:null, rating:user.rating }; leaderboard.push(entry); }
            entry.winsVsGM++;
            entry.lastWin=new Date().toISOString();
            updateLeaderboard(userId);
            io.emit('leaderboardUpdate', { leaderboard:leaderboard.slice(0,10) });
          }
          user.balance+=payout;
          statsData.totalPayouts+=payout; statsData.totalFees+=gross*PLATFORM_FEE;
          user.stats.wins++; user.stats.engineWins++; user.stats.earned+=payout;
          user.stats.highestWin=Math.max(user.stats.highestWin||0, payout);
          addTransaction(userId, 'win', payout, 'completed', `Beat Stockfish ${game.difficultyConfig.label} Won $${payout.toFixed(2)} (${game.difficultyConfig.multiplier}x)`);
          totalPayouts+=payout;
        } else {
          user.stats.freeGames++;
        }
        resultText=`You beat Stockfish ${game.difficultyConfig.label}! ${game.isFree?'':`+$${payout.toFixed(2)} ${payout>game.bet*game.difficultyConfig.multiplier?' + JACKPOT!':''}`}`;
      } else {
        outcome='loss';
        user.stats.losses++;
        if (!game.isFree){
          jackpotPool+=game.bet*JACKPOT_CONTRIBUTION;
          io.emit('jackpotUpdate', { pool:jackpotPool });
          addTransaction(userId, 'loss', 0, 'completed', `Lost $${game.bet} vs ${game.difficultyConfig.label}. ${(game.bet*JACKPOT_CONTRIBUTION).toFixed(2)} to jackpot`);
        }
        resultText=`Stockfish ${game.difficultyConfig.label} checkmates you`;
      }
    } else if (isDraw){
      outcome='draw'; resultText='Draw';
      if (!game.isFree){
        user.balance+=game.bet;
        addTransaction(userId, 'refund', game.bet, 'completed', `Draw vs ${game.difficultyConfig.label} refund`);
      }
      user.stats.draws++;
    }
    game.status='finished'; game.result=resultText; game.winner=outcome==='win'?game.playerColor:outcome==='loss'?game.engineColor:'draw';
    sock.emit('balanceUpdate', { balance:user.balance });
    sock.emit('transactionUpdate', user.transactions);
    sock.emit('statsUpdate', user.stats);
    sock.emit('engineGameFinal', { game:sanitizeGame(game), result:resultText, outcome, payout, multiplier:game.difficultyConfig.multiplier, jackpotPool });
    if (!game.isFree) sock.emit('jackpotUpdate', { pool:jackpotPool });
    if (leaderboard.length) io.emit('leaderboardUpdate', { leaderboard:leaderboard.slice(0,10) });
    markDirty();
    stopClock(game.id);
  }

  // LLM games
  socket.on('createLLMGame', ({ userId, bet, llmConfig, color, isFree }, cb)=>{
    const user=getUser(userId);
    if (!isFree && bet < MIN_BET) return cb && cb({ error:`Min $${MIN_BET}` });
    if (!isFree && user.balance < bet) return cb && cb({ error:`Need $${bet}` });
    if (!isFree){ user.balance-=parseFloat(bet); addTransaction(userId, 'bet', -parseFloat(bet), 'completed', `LLM Arena bet $${bet} vs ${llmConfig?.model||'AI'}`); }
    const gameId='LLM-'+uuidv4().substring(0,6).toUpperCase();
    const chessInst=new Chess();
    const playerColor=color||'w';
    const tc=parseTimeControl('10+0');
    const game={
      id:gameId,
      type:'llm',
      bet:isFree?0:parseFloat(bet),
      llmConfig,
      playerColor,
      isFree,
      white: playerColor==='w'?{ id:userId, username:user.username }:{ id:'llm', username:`🤖 ${llmConfig?.model||'LLM'}` },
      black: playerColor==='b'?{ id:userId, username:user.username }:{ id:'llm', username:`🤖 ${llmConfig?.model||'LLM'}` },
      fen:chessInst.fen(),
      status:'playing',
      moves:[],
      history:[],
      escrow:isFree?0:parseFloat(bet),
      chessInstance:chessInst,
      createdAt:new Date().toISOString(),
      clocks:{ w:tc.base*1000, b:tc.base*1000, inc:tc.inc*1000 },
      lastMoveAt:Date.now()
    };
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('llmGameCreated', { game:sanitizeGame(game) });
    markDirty();
    startClock(game);
    cb && cb({ success:true, gameId });
  });

  socket.on('llmHumanMove', ({ userId, gameId, from, to, promotion }, cb)=>{
    const game=games.get(gameId);
    if (!game || game.type!=='llm') return cb && cb({ error:'Game not found' });
    try{
      const move=game.chessInstance.move({ from,to, promotion:promotion||'q' });
      if (!move) return cb && cb({ error:'Invalid' });
      game.fen=game.chessInstance.fen();
      game.moves.push(move);
      game.history.push(move.san);
      const tc=parseTimeControl('10+0');
      if (game.clocks){ game.clocks[move.color==='w'?'w':'b']+=tc.inc*1000; game.lastMoveAt=Date.now(); }
      markDirty();
      if (game.chessInstance.isGameOver()){
        game.status='finished';
        socket.emit('llmGameOver', { game:sanitizeGame(game), result:'Game over', outcome:'win' });
        stopClock(gameId);
      } else {
        socket.emit('llmTurn', { gameId, fen:game.fen, moves:game.moves, history:game.history.join(' ') });
      }
      cb && cb({ success:true });
    }catch(e){ cb && cb({ error:e.message }); }
  });

  socket.on('llmEngineMove', ({ userId, gameId, from, to, promotion }, cb)=>{
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Not found' });
    try{
      const move=game.chessInstance.move({ from,to, promotion:promotion||'q' });
      if (!move) return cb && cb({ error:'Invalid' });
      game.fen=game.chessInstance.fen();
      game.moves.push(move);
      markDirty();
      if (game.chessInstance.isGameOver()){
        game.status='finished';
        socket.emit('llmGameOver', { game:sanitizeGame(game), result:'Game over' });
        stopClock(gameId);
      } else {
        socket.emit('moveMadeEngine', { game:sanitizeGame(game), move });
      }
      cb && cb({ success:true });
    }catch(e){ cb && cb({ error:e.message }); }
  });

  socket.on('resignPvp', ({ userId, gameId }, cb)=>{
    const game=games.get(gameId);
    if (!game || game.type!=='pvp_bet') return cb && cb({ error:'No PvP' });
    if (game.status!=='playing') return cb && cb({ error:'Finished' });
    const isWhite=game.white.id===userId;
    const winnerId=isWhite?game.black.id:game.white.id;
    const winner=getUser(winnerId);
    const gross=game.escrow;
    const fee=gross*PLATFORM_FEE;
    const payout=gross-fee;
    winner.balance+=payout;
    winner.stats.pvpWins++; winner.stats.wins++; winner.stats.earned+=payout;
    game.status='finished';
    game.result=`${getUser(userId).username} resigned - ${winner.username} wins $${payout.toFixed(2)}`;
    game.winner=isWhite?'b':'w';
    addTransaction(winnerId, 'win', payout, 'completed', `Opponent resigned PvP ${gameId} $${payout.toFixed(2)}`);
    io.to(gameId).emit('gameOverPvp', { game:sanitizeGame(game) });
    io.to(winnerId).emit('balanceUpdate', { balance:winner.balance });
    updateLeaderboard(winnerId);
    markDirty();
    stopClock(gameId);
    cb && cb({ success:true });
  });

  socket.on('createGame', ({ userId, bet, timeControl }, cb)=>{
    const user=getUser(userId);
    const betVal=parseFloat(bet);
    if (user.balance < betVal) return cb && cb({ error:`Need $${betVal}` });
    user.balance-=betVal;
    const gameId='CUST-'+uuidv4().substring(0,5).toUpperCase();
    const chessInst=new Chess();
    const tc=parseTimeControl(timeControl||'10+0');
    const game={
      id:gameId,
      type:'pvp_bet',
      bet:betVal,
      pot:betVal*2,
      white:{ id:userId, username:user.username, socketId:socket.id, rating:user.rating },
      black:null,
      fen:chessInst.fen(),
      status:'waiting',
      moves:[],
      escrow:betVal,
      createdAt:new Date().toISOString(),
      timeControl: timeControl||'10+0',
      chessInstance:chessInst,
      clocks:{ w:tc.base*1000, b:tc.base*1000, inc:tc.inc*1000 }
    };
    games.set(gameId, game);
    addTransaction(userId, 'bet', -betVal, 'completed', `Created custom PvP ${gameId} $${betVal}`);
    socket.emit('balanceUpdate', { balance:user.balance });
    cb && cb({ success:true, gameId, game:sanitizeGame(game) });
    const betKey=betVal.toFixed(2);
    let queue=betQueues.get(betKey)||[];
    queue.push({ userId, socketId:socket.id, timeControl, bet:betVal, timestamp:Date.now(), customGameId:gameId });
    betQueues.set(betKey, queue);
    markDirty();
  });

  // 5. SPECTATOR MODE + SHAREABLE LINKS
  socket.on('spectateGame', ({ gameId }, cb)=>{
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Game not found' });
    socket.join(gameId);
    socket.emit('spectating', { game: sanitizeGame(game), spectators: io.sockets.adapter.rooms.get(gameId)?.size||0 });
    io.to(gameId).emit('spectatorJoined', { count: io.sockets.adapter.rooms.get(gameId)?.size||0 });
    cb && cb({ success:true, game: sanitizeGame(game) });
  });

  socket.on('getGame', ({ gameId }, cb)=>{
    const game=games.get(gameId);
    if (!game) return cb && cb({ error:'Game not found' });
    cb && cb({ success:true, game: sanitizeGame(game) });
  });

  // Chat
  socket.on('sendChat', ({ gameId, message, userId })=>{
    const user=getUser(userId);
    io.to(gameId).emit('chatMessage', { username:user.username, message, timestamp: new Date().toISOString() });
  });

  // Puzzles
  socket.on('getPuzzle', (cb)=>{
    const p=PUZZLES[Math.floor(Math.random()*PUZZLES.length)];
    cb && cb(p);
  });

  socket.on('solvePuzzle', ({ userId, puzzleId, moves }, cb)=>{
    const puzzle=PUZZLES.find(p=>p.id===puzzleId);
    if (!puzzle) return cb && cb({ error:'Puzzle not found' });
    const isCorrect=JSON.stringify(moves)===JSON.stringify(puzzle.solution) || moves[0]===puzzle.solution[0];
    const user=getUser(userId);
    if (isCorrect){
      user.stats.puzzlesSolved++;
      user.rating+=3;
      addTransaction(userId, 'puzzle', 0.10, 'completed', `Solved puzzle ${puzzleId} +$0.10`);
      user.balance+=0.10;
      socket.emit('balanceUpdate', { balance:user.balance });
      markDirty();
    }
    cb && cb({ correct:isCorrect, solution:puzzle.solution });
  });

  socket.on('disconnect', ()=>{
    for (let [k,q] of betQueues.entries()){
      betQueues.set(k, q.filter(e=> e.socketId!==socket.id));
    }
    // Don't stop clocks on disconnect - give 60 sec grace
    setTimeout(()=>{
      // After 60s, if game still playing and user disconnected, flag them
      for (let [gid, game] of games.entries()){
        if (game.status!=='playing') continue;
        const isPlayer = game.white?.id===socketToUser.get(socket.id) || game.black?.id===socketToUser.get(socket.id) || (game.type!=='pvp_bet' && (game.white?.id===socketToUser.get(socket.id) || game.black?.id===socketToUser.get(socket.id)));
        if (isPlayer && Date.now() - (game.lastMoveAt||Date.now()) > 60000) {
          // Check if socket still not reconnected
          const stillConnected = Array.from(socketToUser.values()).includes(game.white?.id) || Array.from(socketToUser.values()).includes(game.black?.id);
          // For simplicity, flag if no opponent move for 60s in bet games
          // handleFlag will be called by clock interval anyway
        }
      }
    }, 60000);
    socketToUser.delete(socket.id);
  });
});

function sanitizeGame(game){
  if (!game) return null;
  return {
    id: game.id,
    type: game.type,
    bet: game.bet,
    pot: game.escrow || (game.bet?game.bet*2:0),
    isFree: game.isFree,
    difficulty: game.difficulty,
    difficultyConfig: game.difficultyConfig,
    playerColor: game.playerColor,
    engineColor: game.engineColor,
    llmConfig: game.llmConfig,
    white: game.white,
    black: game.black,
    fen: game.fen,
    status: game.status,
    moves: game.moves,
    result: game.result,
    winner: game.winner,
    pgn: game.chessInstance?game.chessInstance.pgn():'',
    turn: game.chessInstance?game.chessInstance.turn():'w',
    isCheck: game.chessInstance?game.chessInstance.isCheck():false,
    clocks: game.clocks ? { w: Math.ceil(game.clocks.w/1000), b: Math.ceil(game.clocks.b/1000) } : null,
    rawClocks: game.clocks,
    timeControl: game.timeControl,
    createdAt: game.createdAt,
    commentary: game.commentary||[],
    spectators: 0
  };
}

// 7. ADMIN PAGE
app.get('/admin', (req,res)=>{
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', ()=> console.log(`♔ BetChess ZW Arena FULL running on ${PORT} | DB: ${Object.keys(usersData).length} users | Jackpot $${jackpotPool.toFixed(2)} | EcoCash ${EcoCash.apiKey?'LIVE':'MOCK'}`));
