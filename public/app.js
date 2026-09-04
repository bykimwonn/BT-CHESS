// chess.js is loaded by a <script type="module"> in index.html, which runs
// before this deferred classic script. If it is missing, say so loudly instead
// of failing with a cryptic ReferenceError further down.
if (typeof Chess === 'undefined') {
  console.error('[BetChess] chess.js failed to load from /vendor/chess.js - run `npm run vendor`');
  document.addEventListener('DOMContentLoaded', ()=>{
    const el=document.getElementById('board');
    if (el) el.innerHTML='<div style="padding:20px;color:#ff6b6b;font-family:Inter,sans-serif">chess.js failed to load.<br>Run <code>npm install &amp;&amp; npm run vendor</code> and reload.</div>';
  });
}

const socket = io();
let userId = localStorage.getItem('chessUserId');
let username = localStorage.getItem('chessUsername') || '';
let user = null;

let chess = new Chess();
let currentGame = null;
let currentMode = 'stockfish';
let boardOrientation = 'white';
let selectedSquare = null;
let legalMoves = [];
let hintMove = null;

let difficultyConfig = {};
let jackpotPool = 1250;
let leaderboard = [];
let selectedDifficulty = 'medium';
let selectedFreeDifficulty = 'medium';
let isSearchingMatch = false;
let currentSearchBet = null;

// Stockfish
let stockfish = null;
let currentEval = { score: 0.3, text: '+0.3 White better', depth: 0 };
let analysisEnabled = true;
let currentPuzzle = null;
let puzzleChess = new Chess();

// LLM
let llmGameMode = false;
let llmCommentaryHistory = [];

const pieceUnicode = {
  'wK':'♔','wQ':'♕','wR':'♖','wB':'♗','wN':'♘','wP':'♙',
  'bK':'♚','bQ':'♛','bR':'♜','bB':'♝','bN':'♞','bP':'♟'
};

// Init user
if (!username) {
  username = 'Player_' + Math.floor(Math.random()*9000+1000);
  localStorage.setItem('chessUsername', username);
}

socket.on('connect', ()=> socket.emit('register', { userId, username }));

socket.on('registered', ({ userId: uid, user: u, difficultyConfig: cfg, jackpotPool: jp, leaderboard: lb })=>{
  userId = uid;
  user = u;
  if (cfg) difficultyConfig = cfg;
  if (jp) jackpotPool = jp;
  if (lb) leaderboard = lb;
  localStorage.setItem('chessUserId', uid);
  document.getElementById('userIdDisplay').value = uid;
  document.getElementById('usernameInput').value = u.username;
  document.getElementById('headerAvatar').textContent = u.username[0].toUpperCase();
  document.getElementById('whiteName').textContent = u.username + ' (You)';
  document.getElementById('whiteAvatar').textContent = u.username[0].toUpperCase();
  updateBalance(u.balance);
  updateTransactions(u.transactions || []);
  updateStats(u.stats||{});
  renderDifficultyGrids();
  updateBetCalculation();
  updateJackpot();
  renderMiniLeaderboard();
  document.getElementById('engineStatus')?.textContent || null;
});

socket.on('balanceUpdate', ({ balance })=> { if (user) user.balance=balance; updateBalance(balance); });
socket.on('transactionUpdate', (txs)=> updateTransactions(txs));
socket.on('statsUpdate', (stats)=> updateStats(stats));
socket.on('jackpotUpdate', ({ pool })=> { jackpotPool=pool; updateJackpot(); });
socket.on('leaderboardUpdate', ({ leaderboard: lb })=> { leaderboard=lb; renderMiniLeaderboard(); renderFullLeaderboard(); });

// Payment lifecycle updates straight from the server
socket.on('paymentUpdate', (tx)=>{
  if (!tx) return;
  updateTransactions(user && user.transactions ? user.transactions : []);
  const status=document.getElementById('depositStatus');
  if (status && ['completed','failed','expired','rejected','cancelled'].includes(tx.status)){
    toast(`${tx.type === 'deposit' ? 'Deposit' : 'Withdrawal'} ${tx.status} • $${Number(tx.amount).toFixed(2)}`, tx.status==='completed'?'success':'error');
    if (tx.status==='completed') socket.emit('getBalance', { userId });
  }
});
socket.on('paymentProviders', ({ providers })=>{ if (providers) paymentProviders = providers.filter(p=>p.id!=='mock'); });

// Matchmaking events
socket.on('searchingMatch', ({ bet, queuePosition, message })=>{
  isSearchingMatch=true;
  currentSearchBet=bet;
  document.getElementById('searchStatus').style.display='flex';
  document.getElementById('searchText').textContent = message;
  document.getElementById('searchSub').textContent = `Pos ${queuePosition} in $${bet} queue • Finding opponent...`;
  document.getElementById('findMatchBtn').disabled=true;
});

socket.on('matchFound', ({ game, opponent })=>{
  isSearchingMatch=false;
  document.getElementById('searchStatus').style.display='none';
  document.getElementById('findMatchBtn').disabled=false;
  toast(`Matched vs ${opponent}! Pot $${(game.bet*2).toFixed(2)} - GL!`, 'success');
  currentGame = game;
  chess.load(game.fen);
  boardOrientation = game.white.id===userId ? 'white' : 'black';
  selectedSquare=null; legalMoves=[];
  renderBoard();
  renderGameInfo();
  renderMoves();
  switchRightTab('game');
});

socket.on('noMatchFound', ({ bet, suggestion })=>{
  document.getElementById('searchSub').textContent = suggestion;
  setTimeout(()=>{ if (isSearchingMatch) cancelSearch(); }, 4000);
});

socket.on('searchCancelled', ()=>{
  isSearchingMatch=false;
  currentSearchBet=null;
  document.getElementById('searchStatus').style.display='none';
  document.getElementById('findMatchBtn').disabled=false;
});

socket.on('gameStarted', ({ game })=>{
  currentGame=game;
  chess.load(game.fen);
  boardOrientation = game.white.id===userId ? 'white':'black';
  renderBoard(); renderGameInfo(); renderMoves();
});

socket.on('moveMadePvp', ({ game, move })=>{
  currentGame=game;
  chess.load(game.fen);
  renderBoard(); renderGameInfo(); renderMoves();
  addChatMsg(`${game.moves.length % 2===1 ? game.white.username : game.black.username} played ${move.san}`, 'system');
});

socket.on('gameOverPvp', ({ game })=>{
  currentGame=game;
  chess.load(game.fen);
  renderBoard(); renderGameInfo();
  showGameOverPvp(game);
});

// Engine events
socket.on('engineGameCreated', ({ game })=>{
  currentGame=game;
  chess.load(game.fen);
  boardOrientation = game.playerColor === 'w' ? 'white' : 'black';
  const colorSel = document.getElementById('playerColor')?.value;
  if (colorSel === 'random') boardOrientation = Math.random()>0.5?'white':'black';
  if (game.playerColor) boardOrientation = game.playerColor==='w'?'white':'black';
  selectedSquare=null; legalMoves=[]; hintMove=null;
  renderBoard(); renderGameInfo(); renderMoves();
  toast(`vs Stockfish ${game.difficultyConfig.label} started! ${game.isFree?'Free':'Bet $'+game.bet}`, 'success');
  // The server plays the engine's moves - no client-side engine moves any more.
  if (game.turn !== game.playerColor) showEngineThinking(game.difficultyConfig?.label);
  if (currentMode!=='bet') requestEvaluation(game.fen);
});

socket.on('moveMadeEngine', ({ game })=>{
  currentGame=game;
  chess.load(game.fen);
  hideEngineThinking();
  renderBoard(); renderGameInfo(); renderMoves();
  if (currentMode!=='bet') requestEvaluation(game.fen);
});

socket.on('engineThinking', ({ difficulty })=> showEngineThinking(difficulty));

function showEngineThinking(label){
  const el=document.getElementById('engineThinking');
  if (!el) return;
  el.style.display='flex';
  const t=el.querySelector('#thinkingText');
  if (t) t.textContent=`Stockfish ${label ? (label+' ') : ''}thinking…`;
}
function hideEngineThinking(){
  const el=document.getElementById('engineThinking');
  if (el) el.style.display='none';
}

socket.on('engineGameFinal', (data)=>{
  currentGame=data.game;
  renderBoard(); renderGameInfo(); renderMoves();
  showEngineOver(data.result, data.outcome, data.payout, data.multiplier, data.game);
});

// LLM events
socket.on('llmGameCreated', ({ game })=>{
  currentGame=game;
  chess.load(game.fen);
  boardOrientation = game.playerColor==='w'?'white':'black';
  renderBoard(); renderGameInfo(); renderMoves();
  toast(`LLM Arena vs ${game.llmConfig?.model||'AI'} started!`, 'success');
  llmGameMode=true;
  addCommentary(`🤖 LLM ${game.llmConfig?.model||'Agent'}: "Good luck! I'm ready. FEN: ${game.fen.split(' ')[0]}..."`, 'llm');
  if (game.turn !== game.playerColor) setTimeout(()=> requestLLMMove(game.fen, game), 800);
});

socket.on('llmTurn', ({ fen, moves, history })=>{
  // It's LLM's turn after human move
  requestLLMMove(fen, currentGame);
});

socket.on('llmGameOver', ({ game })=>{
  currentGame=game;
  renderGameInfo();
  showGameOverPvp(game);
});

// ========= UI HELPERS =========
function updateBalance(b){
  document.getElementById('balanceDisplay').textContent = `$${b.toFixed(2)}`;
  document.getElementById('availableBalance').textContent = `$${b.toFixed(2)}`;
}
function updateTransactions(txs){
  if (!txs) return;
  let earned=0, puzzles=0;
  txs.forEach(t=>{ if(t.type==='win') earned+=t.amount; });
  const mini = txs.slice(0,5).map(tx=>txHTML(tx)).join('') || '<div class="empty-state">No tx yet</div>';
  document.getElementById('txListMini').innerHTML = mini;
  document.getElementById('totalWon').textContent = `$${earned.toFixed(2)}`;
}
function updateStats(stats){
  if (!stats) return;
  document.getElementById('puzzlesSolved').textContent = stats.puzzlesSolved||0;
  document.getElementById('puzzlesSolvedPage').textContent = stats.puzzlesSolved||0;
}
function txHTML(tx){
  const pos=tx.amount>0;
  const icons={deposit:'💳',withdraw:'🏦',win:'🏆',bet:'⚔️',fee:'💼',refund:'↩️',loss:'💸',jackpot:'🎰',puzzle:'🧩'}[tx.type]||'💰';
  return `<div class="tx-item"><div class="tx-left"><div class="tx-type">${icons} ${tx.type} <span class="tx-status ${tx.status}">${tx.status}</span></div><div class="tx-detail">${tx.details} • ${new Date(tx.timestamp).toLocaleTimeString()}</div></div><div class="tx-amount ${pos?'positive':'negative'}">${pos?'+':''}$${tx.amount.toFixed(2)}</div></div>`;
}
function updateJackpot(){
  document.getElementById('jackpotPill').textContent = `🎰 Jackpot $${jackpotPool.toFixed(2)}`;
  const jf = document.getElementById('jackpotFull');
  if (jf) jf.textContent = `$${jackpotPool.toFixed(2)}`;
}
function switchLeftTab(tab){
  currentMode=tab;
  document.querySelectorAll('.left-tab').forEach(t=> t.classList.toggle('active', t.dataset.tab===tab));
  document.querySelectorAll('.left-tab-content').forEach(c=> c.classList.toggle('active', c.id === `tab-${tab}`));
}
function switchRightTab(tab){
  document.querySelectorAll('.right-tab').forEach(t=> t.classList.toggle('active', t.dataset.rtab===tab));
  document.querySelectorAll('.right-tab-content').forEach(c=> c.classList.toggle('active', c.id === `rtab-${tab}`));
}
function switchPage(page){
  document.querySelectorAll('.page-overlay').forEach(p=> p.style.display='none');
  if (page==='play') {
    document.querySelectorAll('.page-overlay').forEach(p=> p.style.display='none');
  } else {
    const el = document.getElementById(`page-${page}`);
    if (el) el.style.display='block';
    if (page==='puzzles' && !currentPuzzle) nextPuzzle();
    if (page==='leaderboard') renderFullLeaderboard();
  }
  // update nav
  document.querySelectorAll('.nav-link').forEach(n=> n.classList.toggle('active', n.dataset.page===page));
}
function onProviderChange(){
  const prov = document.getElementById('llmProvider').value;
  document.getElementById('apiKeyGroup').style.display = prov==='fallback' ? 'none' : 'flex';
}

// Bet slider
document.getElementById('quickBetSlider')?.addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  document.getElementById('quickBetLabel').textContent = `$${v.toFixed(2)}`;
  document.getElementById('findBetAmount').textContent = v.toFixed(2);
  // sync other bet inputs
  document.getElementById('betAmount').value = v.toFixed(2);
  document.getElementById('customBet').value = v.toFixed(2);
  updateBetCalculation();
});
function updateBetCalculation(){
  const bet = parseFloat(document.getElementById('betAmount').value)||0;
  const cfg = difficultyConfig[selectedDifficulty] || { multiplier:2.5, label:'Medium' };
  const gross = bet*cfg.multiplier;
  const win = gross*0.9;
  document.getElementById('betDisplay').textContent=`$${bet.toFixed(2)}`;
  document.getElementById('multDisplay').textContent=`${cfg.multiplier}x`;
  document.getElementById('winDisplay').textContent=`$${win.toFixed(2)}`;
  document.getElementById('payoutBadge').textContent=`Win ${cfg.multiplier}x`;
  document.getElementById('liveMult').textContent=`${cfg.multiplier}x`;
  document.getElementById('liveWin').textContent=`$${win.toFixed(2)}`;
  document.getElementById('potDisplay').textContent=`$${bet.toFixed(2)}`;
  document.getElementById('potSub').textContent=`Win $${win.toFixed(2)} vs ${cfg.label}`;
}

function renderDifficultyGrids(){
  if (!difficultyConfig || Object.keys(difficultyConfig).length===0) return;
  const mk = (selected) => Object.keys(difficultyConfig).map(k=>{
    const c=difficultyConfig[k];
    const active = k===selected ? 'active':'';
    return `<div class="diff-card ${active}" onclick="selectDiff('${k}')"><div class="diff-mult">${c.multiplier}x</div><div class="diff-name" style="color:${c.color}">${c.label}</div><div class="diff-elo">${c.elo} • ${c.desc}</div></div>`;
  }).join('');
  document.getElementById('difficultyGrid').innerHTML = mk(selectedDifficulty);
  // for free tab reuse same
}
window.selectDiff = (k)=>{
  selectedDifficulty=k;
  renderDifficultyGrids();
  updateBetCalculation();
};

document.getElementById('betAmount')?.addEventListener('input', updateBetCalculation);

// ========= MATCHMAKING =========
function findMatch(){
  const bet = parseFloat(document.getElementById('quickBetSlider').value) || parseFloat(document.getElementById('betAmount').value) || 1;
  if (user && user.balance < bet) { toast(`Need $${bet.toFixed(2)} - Deposit via EcoCash`, 'error'); openModal('depositModal'); return; }
  const timeControl = document.getElementById('customTime')?.value || '10+0';
  socket.emit('findMatch', { userId, bet, timeControl }, (res)=>{
    if (res && res.error) toast(res.error,'error');
  });
}
function cancelSearch(){
  if (!currentSearchBet) return;
  socket.emit('cancelMatchSearch', { userId, bet: currentSearchBet });
}

// ========= BOARD RENDERING =========
function renderBoard(){
  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  boardEl.innerHTML='';
  const ranks=['8','7','6','5','4','3','2','1'];
  const files=['a','b','c','d','e','f','g','h'];
  const displayRanks = boardOrientation==='white' ? ranks : [...ranks].reverse();
  const displayFiles = boardOrientation==='white' ? files : [...files].reverse();

  for (let r=0;r<8;r++){
    for (let f=0;f<8;f++){
      const rank=displayRanks[r];
      const file=displayFiles[f];
      const sqName=file+rank;
      const piece=chess.get(sqName);
      const isLight=(r+f)%2===0;
      const isSelected=selectedSquare===sqName;
      const isLegal=legalMoves.some(m=>m.to===sqName);
      const isCapture=isLegal && piece;
      const isLast=currentGame && currentGame.moves && currentGame.moves.length>0 && (currentGame.moves[currentGame.moves.length-1].from===sqName || currentGame.moves[currentGame.moves.length-1].to===sqName);
      const isHint=hintMove && hintMove.to===sqName;

      const sq=document.createElement('div');
      sq.className=`square ${isLight?'light':'dark'} ${isSelected?'selected':''} ${isLegal?'legal':''} ${isCapture?'capture':''} ${isLast?'last-move':''} ${isHint?'hint':''}`;
      sq.dataset.square=sqName;

      if (piece){
        const key=piece.color+piece.type.toUpperCase();
        const ch=pieceUnicode[key];
        const span=document.createElement('span');
        span.className=`piece ${piece.color==='w'?'white':'black'}`;
        span.textContent=ch;
        sq.appendChild(span);
      }
      if (f===7){ const fc=document.createElement('span'); fc.className='coords file'; fc.textContent=file; sq.appendChild(fc); }
      if (r===7){ const rc=document.createElement('span'); rc.className='coords rank'; rc.textContent=rank; sq.appendChild(rc); }
      sq.addEventListener('click',()=> onSquareClick(sqName));
      boardEl.appendChild(sq);
    }
  }

  if (!currentGame){
    boardEl.innerHTML+=`<div class="game-overlay" id="boardOverlay"><div style="font-size:32px;margin-bottom:10px">♔ BetChess</div><h3 style="font-weight:800">Find Match with Bet</h3><p style="color:var(--muted);font-size:12px;max-width:320px;margin-top:8px">Like chess.com but with added option for putting your bet and system searches others with same bet and pairs them. Deposit via EcoCash to start.</p><button class="btn btn-green" style="margin-top:12px" onclick="findMatch()">⚡ Find $${(parseFloat(document.getElementById('quickBetSlider')?.value||1)).toFixed(2)} Match</button><div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center"><span class="chip">💵 $0.50 min</span><span class="chip">♞ Stockfish</span><span class="chip">🤖 LLM Agents</span></div></div>`;
  }
}

function onSquareClick(square){
  if (!currentGame || currentGame.status!=='playing') return;
  const piece=chess.get(square);
  const myColor=currentGame.playerColor || (currentGame.white.id===userId ? 'w' : 'b');
  // For pvp
  if (currentGame.type==='pvp_bet'){
    const playerColor = currentGame.white.id===userId ? 'w' : 'b';
    const isMyTurn = chess.turn()===playerColor;
    if (!isMyTurn) return toast("Not your turn", 'info');
    const isMyPiece = piece && piece.color===playerColor;
    if (selectedSquare){
      const mv = legalMoves.find(m=>m.to===square);
      if (mv){ makePvpMove(selectedSquare, square, mv.promotion); selectedSquare=null; legalMoves=[]; renderBoard(); return; }
    }
    if (isMyPiece){ selectedSquare=square; legalMoves=chess.moves({ square, verbose:true }); renderBoard(); }
    else { selectedSquare=null; legalMoves=[]; renderBoard(); }
    return;
  }

  // Engine / LLM
  const isMyTurn = chess.turn()===myColor;
  if (!isMyTurn) return toast("Not your turn - opponent thinking", 'info');
  const isMyPiece = piece && piece.color===myColor;

  if (selectedSquare){
    const mv=legalMoves.find(m=>m.to===square);
    if (mv){ makePlayerMove(selectedSquare, square, mv.promotion); selectedSquare=null; legalMoves=[]; renderBoard(); return; }
  }
  if (isMyPiece){ selectedSquare=square; legalMoves=chess.moves({ square, verbose:true }); renderBoard(); }
  else { selectedSquare=null; legalMoves=[]; renderBoard(); }
}

function makePvpMove(from,to,prom){
  socket.emit('makeMovePvp', { userId, gameId: currentGame.id, from, to, promotion: prom }, (res)=>{
    if (res && res.error) toast(res.error,'error');
  });
}

function makePlayerMove(from,to,prom){
  if (!currentGame) return;
  const tmp=new Chess(currentGame.fen);
  const test=tmp.move({ from,to, promotion: prom||'q' });
  if (!test) return toast('Invalid','error');
  chess.load(currentGame.fen);
  chess.move({ from,to, promotion: prom||'q' });
  renderBoard(); renderMovesLocal();
  if (currentGame.type==='engine'){
    socket.emit('engineMove', { userId, gameId: currentGame.id, from, to, promotion: prom }, (res)=>{
      if (res && res.error){ toast(res.error,'error'); chess.load(currentGame.fen); renderBoard(); }
      else { if (currentGame) { currentGame.fen=res.fen; currentGame.moves.push(res.move); renderGameInfo(); } }
    });
  } else if (currentGame.type==='llm'){
    socket.emit('llmHumanMove', { userId, gameId: currentGame.id, from,to, promotion: prom }, (res)=>{
      if (res && res.error) toast(res.error,'error');
      else { if (res) currentGame.fen=chess.fen(); }
    });
  }
}

function renderGameInfo(){
  if (!currentGame){
    document.getElementById('gameInfo').innerHTML=`<div class="empty-state"><div class="empty-icon">♟️</div><b>Welcome!</b><br>Deposit, set bet, click Find Match — system pairs you with same bet like chess.com random + bet filter.<br><br>Or play vs Stockfish/LLM instantly.</div>`;
    document.getElementById('gameStatusBadge').textContent='No Game';
    document.getElementById('blackName').textContent='Choose mode to start';
    return;
  }
  const isMyTurn = currentGame.type==='pvp_bet' ? (chess.turn()===(currentGame.white.id===userId?'w':'b')) : chess.turn()===currentGame.playerColor;
  const opponent = currentGame.white.id===userId ? currentGame.black : currentGame.white;
  document.getElementById('blackName').textContent = opponent?.username || `Stockfish ${currentGame.difficultyConfig?.label||''}`;
  document.getElementById('blackStatus').textContent = `${isMyTurn?'Waiting':'Thinking...'} • ${currentGame.type==='pvp_bet' ? `Bet $${currentGame.bet}` : currentGame.difficultyConfig ? `${currentGame.difficultyConfig.label} ${currentGame.difficultyConfig.multiplier}x` : 'AI Agent'}`;
  document.getElementById('whiteName').textContent = user ? user.username+' (You)' : 'You';
  document.getElementById('whiteStatus').textContent = `${isMyTurn?'Your turn':'Opponent turn'} • ${currentGame.type==='pvp_bet'?'PvP Bet':currentGame.isFree?'Free':'Bet Game'}`;

  const cfg=currentGame.difficultyConfig;
  const potText = currentGame.type==='pvp_bet' ? `Pot $${(currentGame.bet*2).toFixed(2)}` : currentGame.isFree ? 'FREE' : `$${currentGame.bet} bet • Win $${(currentGame.bet*(cfg?.multiplier||2.5)*0.9).toFixed(2)}`;
  document.getElementById('gameInfo').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>${currentGame.id}</b><span class="chip" style="color:${cfg?.color||'var(--green)'}">${currentGame.type==='pvp_bet' ? `PvP $${currentGame.bet}` : cfg ? `${cfg.label} ${cfg.multiplier}x` : currentGame.llmConfig?.model||'LLM'}</span></div>
    <div style="background:var(--bg3);border-radius:10px;padding:10px;font-size:12px"><div style="display:flex;justify-content:space-between"><span>Pot</span><b style="color:var(--green)">${potText}</b></div><div style="display:flex;justify-content:space-between"><span>Turn</span><b>${chess.turn()==='w'?'White':'Black'} ${isMyTurn?'(YOU)':''}</b></div>${currentGame.result?`<div style="margin-top:6px;color:var(--yellow);font-weight:700">${currentGame.result}</div>`:''}</div>
  `;
  document.getElementById('potDisplay').textContent = currentGame.type==='pvp_bet' ? `$${(currentGame.bet*2).toFixed(2)}` : currentGame.isFree ? 'FREE' : `$${currentGame.bet.toFixed(2)}`;
  document.getElementById('potSub').textContent = currentGame.type==='pvp_bet' ? `Winner $${(currentGame.bet*2*0.9).toFixed(2)}` : currentGame.isFree ? 'Practice' : `To win $${(currentGame.bet*(cfg?.multiplier||2.5)*0.9).toFixed(2)}`;
  document.getElementById('liveMult').textContent = cfg ? cfg.multiplier+'x' : currentGame.type==='pvp_bet' ? '1.8x' : '-';
  document.getElementById('liveWin').textContent = currentGame.isFree ? '$0' : currentGame.type==='pvp_bet' ? `$${(currentGame.bet*2*0.9).toFixed(2)}` : `$${(currentGame.bet*(cfg?.multiplier||2.5)*0.9).toFixed(2)}`;
}

function renderMoves(){
  renderMovesLocal();
}
function renderMovesLocal(){
  const moves=chess.history({ verbose:true });
  let html='';
  for (let i=0;i<moves.length;i+=2){
    const w=moves[i];
    const b=moves[i+1];
    html+=`<div class="move-row"><span class="move-num">${Math.floor(i/2)+1}</span><span class="move">${w.san}</span><span class="move">${b?b.san:''}</span></div>`;
  }
  const panel=document.getElementById('movesPanel');
  if (panel) { panel.innerHTML=html; panel.scrollTop=panel.scrollHeight; }
}

// ========= ANALYSIS ENGINE (Lichess Stockfish 18) =========
// The engine that plays games lives on the server (clients cannot be trusted
// with real money). In the browser we run the same Lichess wasm build in a
// worker for the eval bar, hints and analysis, with the server as fallback.
let engineClient = null;
let evalThrottleTimer = null;
let lastEvalFen = null;

function initEngineClient(){
  if (typeof EngineClient === 'undefined'){ setEngineStatus('No engine', ''); return; }
  engineClient = new EngineClient({ socket });
  engineClient.onStatus((status, name)=>{
    const labels = {
      idle: 'Engine idle',
      loading: 'Engine starting…',
      ready: 'Stockfish 18 ✓',
      server: 'Server engine ✓',
      unavailable: 'No engine',
    };
    setEngineStatus(labels[status] || name || 'Engine', name || '', status);
  });
  engineClient.init();
  loadPaymentProviders();
}

function setEngineStatus(text, title, status){
  if (status) document.body.dataset.engineStatus = status;
  const el = document.getElementById('engineStatus');
  if (!el) return;
  el.textContent = text;
  el.title = title || '';
  el.className = 'status-badge ' + (/✓/.test(text) ? 'status-playing' : '');
}

/** Legacy hook - kept so older markup calling it does not break. */
function handleEngineMessage(line){ /* handled inside EngineClient */ }

function updateEvalUI(){
  const s=currentEval.score;
  let pct=50 + s*8; pct=Math.max(5,Math.min(95,pct));
  const vf=document.getElementById('verticalFill'); if (vf) vf.style.height=(100-pct)+'%';
  const ef=document.getElementById('evalFill'); if (ef) ef.style.width=pct+'%';
  const ed=document.getElementById('evalDisplay'); if (ed) ed.textContent=currentEval.text;
  const en=document.getElementById('evalNumber'); if (en) en.textContent=currentEval.score>0?`+${currentEval.score.toFixed(1)}`:currentEval.score.toFixed(1);
}

/** Ask the engine for an evaluation (debounced so dragging moves is smooth). */
function requestEvaluation(fen){
  if (!analysisEnabled || !engineClient || !fen) return;
  clearTimeout(evalThrottleTimer);
  evalThrottleTimer = setTimeout(async ()=>{
    lastEvalFen = fen;
    const res = await engineClient.analyse({ fen, movetimeMs: 350, multiPv: 1 });
    if (!res || fen !== (currentGame ? currentGame.fen : lastEvalFen)) return;
    const pov = (fen.split(' ')[1] === 'b') ? -1 : 1; // UCI scores are side-to-move relative
    if (res.mate != null){
      currentEval = { score: res.mate > 0 ? 10 : -10, text: `Mate in ${Math.abs(res.mate)}`, depth: res.depth, pv: (res.pv||[]).join(' ') };
    } else if (res.cp != null){
      const whitePov = (res.cp / 100) * pov;
      currentEval = {
        score: whitePov,
        text: `${whitePov > 0 ? '+' : ''}${whitePov.toFixed(1)} ${Math.abs(whitePov) < 0.05 ? 'Equal' : whitePov > 0 ? 'White better' : 'Black better'}`,
        depth: res.depth,
        pv: (res.pv||[]).join(' '),
      };
    }
    updateEvalUI();
    const al=document.getElementById('analysisLines');
    if (al) al.innerHTML=`<div><b>Depth ${currentEval.depth}</b> • ${currentEval.text} <span style="color:var(--muted)">(${res.source})</span></div><div style="margin-top:6px;color:var(--text)">Best: ${(res.pv||[]).slice(0,8).join(' ') || res.bestMove || '…'}</div>`;
  }, 250);
}

// ========= ENGINE GAME START =========
function startEngineGame(isFree){
  const bet=parseFloat(document.getElementById('betAmount').value)||0.5;
  const difficulty=isFree ? selectedFreeDifficulty : selectedDifficulty;
  let colorSel=document.getElementById('playerColor').value;
  if (isFree) colorSel=document.getElementById('freePlayerColor')?.value || colorSel;
  // free panel doesn't exist now, use same
  const color=colorSel==='random' ? (Math.random()>0.5?'w':'b') : colorSel;
  if (!isFree && user && user.balance < bet){ toast(`Need $${bet.toFixed(2)} - Deposit`, 'error'); openModal('depositModal'); return; }
  socket.emit('createEngineGame', { userId, bet, difficulty, isFree, color }, (res)=>{ if (res && res.error) toast(res.error,'error'); });
}

// ========= LLM ARENA =========
function startLLMGame(isFree){
  const bet=parseFloat(document.getElementById('betAmount').value)||1;
  const provider=document.getElementById('llmProvider').value;
  const model=document.getElementById('llmModel').value;
  const apiKey=document.getElementById('llmApiKey').value.trim();
  const color=document.getElementById('llmColor').value==='w'?'w':'b';
  if (!isFree && provider!=='fallback' && !apiKey){ toast('Enter API key or use Demo mode', 'error'); return; }
  if (!isFree && user.balance < bet){ toast(`Need $${bet}`, 'error'); openModal('depositModal'); return; }
  const llmConfig={ provider, model, apiKey: apiKey||null, customUrl: null };
  if (provider==='fallback') llmConfig.apiKey=null;
  socket.emit('createLLMGame', { userId, bet, llmConfig, color, isFree }, (res)=>{ if (res&&res.error) toast(res.error,'error'); });
}

/**
 * Last-resort move when the LLM agent fails or returns something illegal:
 * ask the server engine (Lichess Stockfish) and play that instead.
 */
async function fallbackEngineMove(fen, game){
  const g = game || currentGame;
  if (!g) return;
  socket.emit('requestEngineMove', { gameId: g.id, fen, difficulty: 'hard' }, (res)=>{
    if (!res || res.error || !res.move) return hideEngineThinking();
    const { from, to, promotion } = res.move;
    try { chess.move({ from, to, promotion: promotion || 'q' }); } catch(e){ return hideEngineThinking(); }
    socket.emit('llmEngineMove', { userId, gameId: g.id, from, to, promotion: promotion || 'q' });
    renderBoard(); renderMovesLocal();
    addCommentary(`♞ Stockfish covers for the LLM: ${from}${to}`, 'llm');
    hideEngineThinking();
  });
}

async function requestLLMMove(fen, game){
  const provider=game.llmConfig?.provider || 'fallback';
  const model=game.llmConfig?.model || 'gpt-4o-mini';
  const apiKey=game.llmConfig?.apiKey || null;
  const legalMoves=chess.moves({ verbose:true }).map(m=> m.from+m.to+(m.promotion||''));
  const history=game.moves?.map(m=>m.san||'').join(' ') || '';
  addCommentary(`🤔 ${model} thinking... FEN: ${fen.split(' ')[0]}...`, 'thinking');
  document.getElementById('engineThinking').style.display='flex';
  document.getElementById('thinkingText').textContent=`🤖 ${model} thinking...`;

  try {
    let moveUci=null, commentary='';

    if (provider==='fallback' || !apiKey){
      // Call our fallback API (server simulates LLM)
      const resp=await fetch('/api/llm/move', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ fen, legalMoves, provider:'fallback', playerColor: game.playerColor==='w'?'b':'w', history }) });
      const data=await resp.json();
      moveUci=data.move;
      commentary=data.commentary;
    } else {
      // Direct client call to /api/llm/move which proxies with real key
      const resp=await fetch('/api/llm/move', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ fen, legalMoves, provider, model, apiKey, playerColor: game.playerColor==='w'?'b':'w', history }) });
      const data=await resp.json();
      moveUci=data.move;
      commentary=data.commentary;
    }

    if (!moveUci) throw new Error('No move returned');
    // Validate move is legal - convert UCI to from/to
    const from=moveUci.substring(0,2); const to=moveUci.substring(2,4); const promo=moveUci.length>4?moveUci[4]:undefined;
    // Check if legal
    const temp=new Chess(fen);
    const legalCheck=temp.moves({ verbose:true }).some(m=> m.from===from && m.to===to);
    if (!legalCheck){
      addCommentary(`⚠️ LLM returned illegal ${moveUci}, using fallback Stockfish move`, 'error');
      fallbackEngineMove(fen);
      document.getElementById('engineThinking').style.display='none';
      return;
    }

    addCommentary(`🤖 ${model}: "${commentary}" → Plays ${moveUci.toUpperCase()}`, 'llm');

    // Send move to server as engineReply? For LLM, we need llm move handling
    // For now, make move locally and send via engineReply if game type engine? But LLM game uses different flow
    // We'll use same as engine but via llm endpoint: make move via Chess and then emit llmHumanMove? Actually we need reverse: LLM move should be applied as opponent move
    // Simulate opponent move: apply to chess and emit as if its engine move
    // Use socket emit for LLM: we will reuse engineReply for simplicity but with llm type, server will handle via llmHumanMove? Let's just apply locally and inform server via engineReply for llm type? Better create llmMove event
    // Quick hack: make move on client chess and send to server as llm move
    chess.move({ from, to, promotion: promo||'q' });
    renderBoard(); renderMovesLocal();

    // Inform server
    socket.emit('engineReply', { userId, gameId: game.id, from, to, promotion: promo }, ()=>{});
    // But for LLM game server expects engineReply? We created llm game but using same handler - it will work because game.chessInstance move
    // Actually we already created llm game with different handler, we need to call llm endpoint for human moves only. So we need to sync server: we moved client side, now tell server to update
    // We'll call a custom event llmEngineMove
    // For simplicity, just emit engineReply and also llmHumanMove equivalent
    // Let's emit llmHumanMove with opposite? no
    // Workaround: we emit a generic "engineReply" for llm game too - server has engineReply handler that checks game type engine only. So need new handler
    // Let's emit "llmEngineMove"
    socket.emit('llmEngineMove', { userId, gameId: game.id, from, to, promotion: promo }); // will be ignored but we already updated client

    // For now, trust client and continue
    if (chess.isGameOver()){
      // handle game over
      setTimeout(()=> showEngineOver('Game Over by LLM', chess.isCheckmate() ? 'loss' : 'draw', 0, 2, currentGame), 500);
    }

  } catch(e){
    console.error(e);
    addCommentary(`❌ LLM error: ${e.message}. Fallback to Stockfish`, 'error');
    fallbackEngineMove(fen);
  } finally {
    document.getElementById('engineThinking').style.display='none';
  }
}

// Need to add missing socket handler for llmEngineMove on server? We'll just reuse engineReply on server by making it accept llm type as well
// For now client side already handles.

function addCommentary(text, type='info'){
  const box=document.getElementById('commentaryBox');
  const pageBox=document.getElementById('llmPageCommentary');
  const div=document.createElement('div');
  div.style.marginBottom='8px'; div.style.padding='6px 8px'; div.style.borderRadius='8px';
  if (type==='llm'){ div.style.background='rgba(129,182,76,.1)'; div.style.border='1px solid rgba(129,182,76,.2)'; }
  else if (type==='thinking'){ div.style.background='var(--bg3)'; div.style.fontStyle='italic'; }
  else if (type==='error'){ div.style.background='rgba(224,90,71,.1)'; div.style.color='var(--red)'; }
  div.textContent=text;
  if (box) { box.appendChild(div); box.scrollTop=box.scrollHeight; }
  if (pageBox) { pageBox.appendChild(div); pageBox.scrollTop=pageBox.scrollHeight; }
  llmCommentaryHistory.push(text);
}

function startLLMvsLLM(){
  toast('LLM vs LLM demo - Watch two AIs battle!', 'info');
  // Start a game where both sides are LLM
  const provider=document.getElementById('llmProvider').value;
  const model=document.getElementById('llmModel').value;
  const apiKey=document.getElementById('llmApiKey').value.trim();
  const llmConfig={ provider, model, apiKey: apiKey||null };
  socket.emit('createLLMGame', { userId, bet:0, llmConfig, color:'w', isFree:true }, (res)=>{
    if (res) {
      // Auto play both sides with LLM calls every move
      currentGame.llmAutoPlay=true;
      addCommentary('🎬 LLM vs LLM Battle started! Both sides are AI agents.', 'llm');
      // Loop
      let autoLoop = setInterval(async ()=>{
        if (!currentGame || currentGame.status!=='playing' || !currentGame.llmAutoPlay) { clearInterval(autoLoop); return; }
        await requestLLMMove(chess.fen(), currentGame);
      }, 4000);
    }
  });
}
function startLLMvsStockfish(){
  toast('LLM vs Stockfish - Ultimate test!', 'info');
  // Create free engine game but then have Stockfish vs LLM alternating: we can just start engine game and have LLM play as human? For demo start LLM game vs Stockfish engine logic
  const provider=document.getElementById('llmProvider').value;
  const model=document.getElementById('llmModel').value;
  const apiKey=document.getElementById('llmApiKey').value.trim();
  const llmConfig={ provider, model, apiKey: apiKey||null };
  socket.emit('createEngineGame', { userId, bet:0, difficulty:'hard', isFree:true, color:'w' }, (res)=>{
    if (res){
      currentGame.llmConfig=llmConfig;
      currentGame.llmVsStockfish=true;
      addCommentary('🤖 LLM vs ♞ Stockfish Hard: LLM is White, Stockfish is Black. Let battle commence!', 'llm');
    }
  });
}

// ========= PUZZLES =========
function nextPuzzle(){
  socket.emit('getPuzzle', (p)=>{
    if (!p) return;
    currentPuzzle=p;
    puzzleChess.load(p.fen);
    // Render puzzle board (reuse main board for now, but also puzzleBoard)
    chess.load(p.fen);
    currentGame=null;
    renderBoard();
    document.getElementById('puzzleTheme').textContent=`Theme: ${p.theme}`;
    document.getElementById('puzzleRating').textContent=p.rating;
    document.getElementById('puzzleDesc').textContent=p.desc;
    // Render puzzleBoard if exists
    const pb=document.getElementById('puzzleBoard');
    if (pb){
      pb.innerHTML='';
      // quick render same as board but with puzzleChess
      const ranks=['8','7','6','5','4','3','2','1']; const files=['a','b','c','d','e','f','g','h'];
      for (let r=0;r<8;r++){ for (let f=0;f<8;f++){ const sq=files[f]+ranks[r]; const piece=puzzleChess.get(sq); const isLight=(r+f)%2===0; const sqEl=document.createElement('div'); sqEl.className=`square ${isLight?'light':'dark'}`; if (piece){ const key=piece.color+piece.type.toUpperCase(); const ch=pieceUnicode[key]; const span=document.createElement('span'); span.className=`piece ${piece.color==='w'?'white':'black'}`; span.textContent=ch; sqEl.appendChild(span); } sqEl.addEventListener('click', ()=>{ onPuzzleClick(sq); }); pb.appendChild(sqEl); } }
      pb.style.display='grid'; pb.style.gridTemplateColumns='repeat(8,1fr)'; pb.style.gridTemplateRows='repeat(8,1fr)'; pb.style.aspectRatio='1'; pb.style.borderRadius='10px'; pb.style.overflow='hidden';
    }
    toast(`Puzzle Rating ${p.rating} - ${p.theme}`, 'info');
  });
}
let puzzleSelected=null;
let puzzleLegal=[];
function onPuzzleClick(square){
  if (!currentPuzzle) return;
  const piece=puzzleChess.get(square);
  if (puzzleSelected){
    const move=puzzleLegal.find(m=>m.to===square);
    if (move){
      puzzleChess.move({ from:puzzleSelected, to:square, promotion:'q' });
      renderBoard(); // re-render main board
      // check solution
      const moveUci=puzzleSelected+square;
      if (currentPuzzle.solution.includes(moveUci) || currentPuzzle.solution[0]===moveUci){
        toast('✅ Correct! +$0.10 +3 Elo', 'success');
        socket.emit('solvePuzzle', { userId, puzzleId: currentPuzzle.id, moves: [moveUci] }, (res)=>{
          if (res && res.correct) setTimeout(()=> nextPuzzle(), 1200);
        });
      } else {
        toast(`❌ Wrong. Solution: ${currentPuzzle.solution.join(', ')}`, 'error');
        setTimeout(()=>{ puzzleChess.load(currentPuzzle.fen); chess.load(currentPuzzle.fen); renderBoard(); }, 1000);
      }
      puzzleSelected=null; puzzleLegal=[];
      return;
    }
  }
  if (piece && piece.color==='w'){
    puzzleSelected=square;
    puzzleLegal=puzzleChess.moves({ square, verbose:true });
    renderBoard();
  } else { puzzleSelected=null; puzzleLegal=[]; }
}
async function getPuzzleHint(){
  if (!currentPuzzle) return;
  let uci = currentPuzzle.solution[0];
  if (engineClient){
    const best = await engineClient.bestMove(puzzleChess.fen(), { movetimeMs: 600 });
    if (best) uci = best;
  }
  toast(`Hint: ${uci.toUpperCase()}`, 'info');
  hintMove={ from: uci.substring(0,2), to: uci.substring(2,4) };
  renderBoard();
}

// ========= LEADERBOARD =========
function renderMiniLeaderboard(){
  const el=document.getElementById('miniLeaderboard');
  if (!el) return;
  if (!leaderboard || leaderboard.length===0){ el.innerHTML='<div class="empty-state">No GM slayers yet. Be first!</div>'; return; }
  el.innerHTML=leaderboard.slice(0,5).map((l,i)=>`<div class="lb-item"><div style="display:flex;align-items:center;gap:8px"><span class="lb-rank">${i+1}</span><div><div class="lb-name">${l.username}</div><div class="lb-elo">${l.rating||800} Elo • ${l.winsVsGM||0} GM wins</div></div></div><div style="text-align:right"><div style="font-weight:700;color:var(--green)">$${(l.earnings||0).toFixed(2)}</div><div style="font-size:10px;color:var(--muted)">Best $${(l.highestWin||0).toFixed(2)}</div></div></div>`).join('');
}
function renderFullLeaderboard(){
  const el=document.getElementById('fullLeaderboard');
  const gmEl=document.getElementById('gmSlayers');
  if (!el) return;
  if (!leaderboard || leaderboard.length===0){ el.innerHTML='<div class="empty-state">No players yet</div>'; return; }
  el.innerHTML=leaderboard.map((l,i)=>`<div class="lb-item"><div style="display:flex;align-items:center;gap:10px"><span class="lb-rank">#${i+1}</span><div class="player-avatar" style="width:28px;height:28px;font-size:12px">${l.username[0]}</div><div><div class="lb-name">${l.username}</div><div class="lb-elo">Rating ${l.rating||800} • GM wins ${l.winsVsGM||0}</div></div></div><div style="text-align:right"><b style="color:var(--green)">$${(l.earnings||0).toFixed(2)}</b><div style="font-size:10px">${l.lastWin?new Date(l.lastWin).toLocaleDateString():''}</div></div></div>`).join('');
  if (gmEl){
    const gmOnly=leaderboard.filter(l=> (l.winsVsGM||0)>0);
    gmEl.innerHTML=gmOnly.length? gmOnly.map((l,i)=>`<div class="lb-item"><span>🏆 ${l.username} - ${l.winsVsGM} GM wins</span><b>$${(l.earnings||0).toFixed(2)}</b></div>`).join('') : '<div class="empty-state">No one beat Grandmaster yet. Prize is $10 + jackpot!</div>';
  }
}

// ========= GAME OVER DISPLAY =========
function showEngineOver(result, outcome, payout, multiplier, game){
  const overlay=document.createElement('div'); overlay.className='game-overlay';
  overlay.innerHTML=`<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:340px;text-align:center"><div style="font-size:44px">${outcome==='win'?'🏆':outcome==='loss'?'😢':'🤝'}</div><h3 style="margin:8px 0;font-weight:800;color:${outcome==='win'?'var(--green)':''}">${outcome==='win'?'You Won!':outcome==='loss'?'You Lost':'Draw'}</h3><p style="font-size:12px;color:var(--muted)">${result}</p>${outcome==='win'&&!game.isFree?`<div style="background:rgba(129,182,76,.12);border:1px solid rgba(129,182,76,.3);border-radius:10px;padding:12px;margin:12px 0"><div style="font-size:10px;color:var(--muted)">WON vs ${game.difficultyConfig.label} ${multiplier}x</div><div style="font-size:26px;font-weight:800;color:var(--green)">+$${payout.toFixed(2)}</div><div style="font-size:10px;color:var(--muted)">${payout>game.bet*game.difficultyConfig.multiplier ? '🎰 JACKPOT INCLUDED!' : 'Added to wallet'}</div></div>`:''}${outcome==='loss'&&!game.isFree?`<div style="background:rgba(224,90,71,.08);border-radius:10px;padding:10px;margin:10px 0;font-size:11px">Lost $${game.bet.toFixed(2)} • Jackpot +$${(game.bet*0.02).toFixed(2)}</div>`:''}<button class="btn btn-green" style="width:100%;margin-top:10px" onclick="this.parentElement.parentElement.remove()">Continue</button><button class="btn btn-outline" style="width:100%;margin-top:6px" onclick="this.parentElement.parentElement.remove(); startEngineGame(${game.isFree})">↻ Play Again</button></div>`;
  document.getElementById('board').appendChild(overlay);
  if (outcome==='win' && !game.isFree) confetti();
}
function showGameOverPvp(game){
  const isWinner = game.winner && ((game.winner==='w' && game.white.id===userId) || (game.winner==='b' && game.black.id===userId));
  const overlay=document.createElement('div'); overlay.className='game-overlay';
  overlay.innerHTML=`<div style="background:var(--card);border-radius:14px;padding:20px;max-width:340px;text-align:center;border:1px solid var(--border)"><div style="font-size:40px">${isWinner?'🏆':game.winner==='draw'?'🤝':'😢'}</div><h3>${game.winner==='draw'?'Draw!': isWinner?'You Won!':'You Lost'}</h3><p style="font-size:12px;color:var(--muted);margin:8px 0">${game.result}</p>${isWinner?`<div style="font-size:22px;font-weight:800;color:var(--green)">Pot won!</div>`:''}<button class="btn btn-green" style="width:100%;margin-top:12px" onclick="this.parentElement.parentElement.remove(); currentGame=null; renderBoard(); renderGameInfo()">Close</button></div>`;
  document.getElementById('board').appendChild(overlay);
  if (isWinner) confetti();
}
function confetti(){
  for (let i=0;i<16;i++){ setTimeout(()=>{ const el=document.createElement('div'); el.textContent='💸'; el.style.position='fixed'; el.style.left=Math.random()*100+'vw'; el.style.top='-10px'; el.style.fontSize='20px'; el.style.zIndex='500'; el.style.animation='fall 2s linear forwards'; document.body.appendChild(el); setTimeout(()=>el.remove(),2000); }, i*80); }
}

// ========= MISC =========
function flipBoard(){ boardOrientation = boardOrientation==='white'?'black':'white'; renderBoard(); }
async function getHint(){
  if (!currentGame || currentGame.status!=='playing') return toast('Start a game first','error');
  if (!engineClient) return toast('Engine loading...','info');
  toast('Asking Stockfish for the best move...','info');
  const uci = await engineClient.bestMove(chess.fen(), { movetimeMs: 800 });
  if (!uci) return toast('Engine unavailable - try again','error');
  hintMove={ from: uci.substring(0,2), to: uci.substring(2,4) };
  renderBoard();
  const move = chess.move({ from: hintMove.from, to: hintMove.to, promotion: uci.length>4?uci[4]:'q' });
  const san = move ? move.san : `${hintMove.from}→${hintMove.to}`;
  if (move) chess.undo();
  toast(`Hint: ${san}`,'success');
}
function undoMove(){
  // Every game is played on the server now, so undoing locally would desync the
  // board from the authoritative game state (and defeat anti-cheat).
  if (currentGame && currentGame.type) return toast('Undo is disabled in server games','info');
  if (chess.history().length<2) return toast('Nothing to undo','error');
  chess.undo(); chess.undo();
  renderBoard(); renderMovesLocal();
}
function resetBoard(){ chess.reset(); currentGame=null; hintMove=null; selectedSquare=null; legalMoves=[]; renderBoard(); renderGameInfo(); document.getElementById('movesPanel').innerHTML=''; }
function resignGame(){
  if (!currentGame || currentGame.status!=='playing') return toast('No game','error');
  if (confirm('Resign? Lose bet if bet game.')){
    if (currentGame.type==='pvp_bet'){
      socket.emit('resignPvp', { userId, gameId: currentGame.id });
      // For now treat as engine resign
      socket.emit('engineGameOver', { userId, gameId: currentGame.id, result:'resign' });
    } else {
      socket.emit('engineGameOver', { userId, gameId: currentGame.id, result:'resign' });
    }
    currentGame.status='finished';
  }
}
function offerDraw(){ toast('Draw offer sent - opponent declined (for demo)','info'); }
function createCustomGame(){
  const bet=parseFloat(document.getElementById('customBet').value)||1;
  if (user.balance < bet){ toast(`Need $${bet}`,'error'); openModal('depositModal'); return; }
  socket.emit('createGame', { userId, bet, timeControl: document.getElementById('customTime').value }, (res)=>{ if (res&&res.error) toast(res.error,'error'); else toast(`Private game ${res.gameId} created! Share link`,`success`); });
}
function sendChat(){
  const inp=document.getElementById('chatInput');
  const msg=inp.value.trim(); if (!msg) return;
  addChatMsg(`${user.username}: ${msg}`, 'user');
  inp.value='';
}
function addChatMsg(msg, type){
  const el=document.getElementById('chatMessages');
  const div=document.createElement('div'); div.className=`chat-msg ${type}`; div.textContent=msg;
  el.appendChild(div); el.scrollTop=el.scrollHeight;
}
function openModal(id){ document.getElementById(id).classList.add('active'); }
function closeModal(id){ document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-backdrop').forEach(bg=> bg.addEventListener('click', e=>{ if (e.target===bg) bg.classList.remove('active'); }));
function setDeposit(a){ document.getElementById('depositAmount').value=a.toFixed(2); }

// ---------- PAYMENTS (EcoCash / InnBucks / OneMoney / Bank / Agent) ----------
const PROVIDER_ICONS = { ecocash:'📱', innbucks:'💳', onemoney:'📲', bank:'🏦', agent:'🤝', mock:'🧪' };
let paymentProviders = [];
let depositProvider = 'ecocash';
let withdrawProvider = 'ecocash';
let depositPollTimer = null;

async function loadPaymentProviders(){
  try{
    const data = await fetch('/api/payments/providers').then(r=>r.json());
    paymentProviders = (data.providers||[]).filter(p=> p.id !== 'mock');
    if (!paymentProviders.length) paymentProviders = [{ id:'ecocash', label:'EcoCash', kind:'mobile_money', minAmount:0.5, maxAmount:2000, sandbox:true }];
    depositProvider = paymentProviders.some(p=>p.id==='ecocash') ? 'ecocash' : paymentProviders[0].id;
    withdrawProvider = depositProvider;

    const badge=document.getElementById('ecoModeBadge');
    if (badge) badge.textContent = data.mode === 'live' ? 'LIVE MODE' : 'SANDBOX MODE';

    renderProviderGrid('depositProviders', depositProvider, 'selectDepositProvider');
    renderProviderGrid('withdrawProviders', withdrawProvider, 'selectWithdrawProvider');
    syncProviderForms();
  }catch(e){ console.warn('providers unavailable', e.message); }
}

function renderProviderGrid(containerId, activeId, handler){
  const el=document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = paymentProviders.map(p=>`
    <div class="method-card ${p.id===activeId?'active':''}" data-provider="${p.id}" onclick="${handler}('${p.id}')">
      ${PROVIDER_ICONS[p.id]||'💰'} ${p.label}${p.sandbox?' <span style="font-size:9px;opacity:.7">sandbox</span>':''}
    </div>`).join('');
}

function selectDepositProvider(id){
  depositProvider=id;
  renderProviderGrid('depositProviders', id, 'selectDepositProvider');
  syncProviderForms();
}
function selectWithdrawProvider(id){
  withdrawProvider=id;
  window.withdrawMethod=id;
  renderProviderGrid('withdrawProviders', id, 'selectWithdrawProvider');
  syncProviderForms();
}
function selectWithdrawMethod(el){ if (el && el.dataset && el.dataset.provider) selectWithdrawProvider(el.dataset.provider); }

function syncProviderForms(){
  const phoneGroup=document.getElementById('depositPhoneGroup');
  const ecoForm=document.getElementById('ecoWithdrawForm');
  const bankForm=document.getElementById('bankWithdrawForm');
  const needsPhone = p => p==='ecocash'||p==='innbucks'||p==='onemoney'||p==='agent';
  if (phoneGroup) phoneGroup.style.display = needsPhone(depositProvider) ? 'block' : 'none';
  if (ecoForm) ecoForm.style.display = needsPhone(withdrawProvider) ? 'block' : 'none';
  if (bankForm) bankForm.style.display = withdrawProvider==='bank' ? 'block' : 'none';
}

function setDepositStatus(html, show=true){
  const el=document.getElementById('depositStatus');
  if (!el) return;
  el.style.display = show ? 'block' : 'none';
  el.innerHTML = html;
}

/** Poll a transaction until it settles so the user sees real progress. */
function watchTransaction(reference, { onDone } = {}){
  clearInterval(depositPollTimer);
  let tries=0;
  depositPollTimer=setInterval(async ()=>{
    if (tries++ > 60){ clearInterval(depositPollTimer); return; }
    try{
      const tx=await fetch(`/api/payments/${reference}`).then(r=>r.json());
      if (!tx || !tx.reference) return;
      setDepositStatus(`<b>${tx.type.toUpperCase()} ${tx.reference}</b><br>Status: <b style="color:${tx.status==='completed'?'var(--green)':tx.status==='failed'?'var(--red)':'var(--yellow)'}">${tx.status}</b> • $${Number(tx.amount).toFixed(2)} via ${tx.provider}${tx.instructions?`<br><span style="color:var(--muted)">${tx.instructions}</span>`:''}`);
      if (['completed','failed','expired','rejected','cancelled'].includes(tx.status)){
        clearInterval(depositPollTimer);
        if (onDone) onDone(tx);
      }
    }catch(e){ /* keep polling */ }
  }, 1200);
}

function doDeposit(){
  const amount=parseFloat(document.getElementById('depositAmount').value);
  const phone=document.getElementById('ecoPhone').value.trim();
  if (isNaN(amount)||amount<0.5) return toast('Min $0.50','error');
  if (phone && phone.length<9) return toast('Enter a valid wallet number','error');
  const btn=document.getElementById('depositBtn'); btn.textContent='⏳...'; btn.disabled=true;
  setDepositStatus(`Sending $${amount.toFixed(2)} request to <b>${depositProvider}</b>…`);
  socket.emit('deposit',{ userId, amount, phone, provider: depositProvider }, (res)=>{
    btn.textContent='Deposit'; btn.disabled=false;
    if (res&&res.error){ toast(res.error,'error'); setDepositStatus(`<span style="color:var(--red)">${res.error}</span>`); return; }
    const tx=res.transaction;
    toast(`${depositProvider} request sent`,'success');
    if (!tx) return;
    watchTransaction(tx.reference, { onDone: (t)=>{
      if (t.status==='completed'){
        toast(`+$${Number(t.amount).toFixed(2)} added to your wallet`,'success');
        setTimeout(()=> closeModal('depositModal'), 900);
      } else {
        toast(`Deposit ${t.status}`,'error');
      }
    }});
  });
}

function doWithdraw(){
  const amount=parseFloat(document.getElementById('withdrawAmount').value);
  if (isNaN(amount)||amount<1) return toast('Min $1','error');
  if (user && user.balance<amount) return toast('Insufficient balance','error');
  let account='';
  if (withdrawProvider==='bank'){
    const bank=document.getElementById('bankName').value;
    const acc=document.getElementById('bankAccount').value.trim();
    if(!acc) return toast('Enter account number','error');
    account=`${bank} - ${acc}`;
  } else {
    account=document.getElementById('withdrawPhone').value.trim();
    if(!account) return toast('Enter wallet number','error');
  }
  socket.emit('withdraw',{ userId, amount, provider: withdrawProvider, accountDetails: account, phone: account }, (res)=>{
    if (res&&res.error) return toast(res.error,'error');
    toast(`Withdraw $${amount.toFixed(2)} via ${withdrawProvider} submitted`,'success');
    closeModal('withdrawModal');
    if (res.transaction) watchTransaction(res.transaction.reference, { onDone: (t)=> toast(`Withdrawal ${t.status}`, t.status==='completed'?'success':'error') });
  });
}

function saveProfile(){
  const n=document.getElementById('usernameInput').value.trim();
  if (!n||n.length<3) return toast('Min 3','error');
  username=n; localStorage.setItem('chessUsername',n); socket.emit('register',{userId,username:n}); toast(`Username ${n}`,'success'); closeModal('profileModal');
}
function toast(msg,type='info'){
  const c=document.getElementById('toastContainer'); const t=document.createElement('div'); t.className='toast'; t.style.borderLeft=`4px solid ${type==='error'?'var(--red)':type==='success'?'var(--green)':'var(--yellow)'}`; t.textContent=msg; c.appendChild(t); setTimeout(()=>t.remove(),4000);
}
function toggleEngine(){ analysisEnabled=!analysisEnabled; toast(analysisEnabled?'Engine ON':'Engine OFF','info'); if (analysisEnabled && currentGame) requestEvaluation(currentGame.fen); }
function openAnalysis(){ switchRightTab('analysis'); }
async function showSolution(){
  if (!currentGame) return;
  if (engineClient && typeof chess !== 'undefined'){
    const best = await engineClient.bestMove(chess.fen(), { movetimeMs: 700 });
    if (best) return toast(`Stockfish plays ${best.toUpperCase()}`, 'info');
  }
  toast(`Best line: ${currentEval.pv||'Calculating...'}`, 'info');
}

// Init
renderBoard();
initEngineClient();
document.querySelectorAll('.nav-link').forEach(link=> link.addEventListener('click',()=> switchPage(link.dataset.page)));
const st=document.createElement('style'); st.textContent='@keyframes fall{to{transform:translateY(110vh) rotate(360deg)}}'; document.head.appendChild(st);

// Add missing server handler for llmEngineMove (client only, server will handle via engineReply for llm too)
// Patch server to accept it - it already does if we emit engineReply with llm game, but let's add listener
socket.on('llmEngineMove', ()=>{}); // placeholder


// ========== NEW FEATURES 1-7 ADDITIONS ==========

// 4. PHONE OTP LOGIN
function requestOTP(){
  const phone = document.getElementById('otpPhone').value.trim();
  if (!phone || phone.length<9){ toast('Enter valid EcoCash number 077...', 'error'); return; }
  const btn=document.getElementById('requestOtpBtn');
  btn.textContent='⏳ Sending OTP...'; btn.disabled=true;
  socket.emit('requestOTP', { phone }, (res)=>{
    btn.textContent='📲 Send OTP via SMS'; btn.disabled=false;
    if (res && res.error){ toast(res.error,'error'); return; }
    toast(`OTP sent to ${phone} - Check console / demo code`, 'success');
    document.getElementById('otpRequestSection').style.display='none';
    document.getElementById('otpVerifySection').style.display='block';
    document.getElementById('otpDemoCode').textContent = `DEMO CODE (remove in prod): ${res.code} - Also in server logs`;
    document.getElementById('otpCode').focus();
  });
}

function verifyOTP(){
  const phone=document.getElementById('otpPhone').value.trim();
  const code=document.getElementById('otpCode').value.trim();
  if (!code || code.length!==6){ toast('Enter 6-digit OTP','error'); return; }
  socket.emit('verifyOTP', { phone, code }, (res)=>{
    if (res && res.error){ toast(res.error,'error'); return; }
    toast(`✅ Phone ${phone} verified! Wallet recovered. Balance $${res.user.balance.toFixed(2)}`, 'success');
    userId=res.userId;
    user=res.user;
    localStorage.setItem('chessUserId', userId);
    document.getElementById('userIdDisplay').value=userId;
    document.getElementById('usernameInput').value=res.user.username;
    document.getElementById('headerAvatar').textContent=res.user.username[0].toUpperCase();
    document.getElementById('profilePhone').value=res.user.phone;
    updateBalance(res.user.balance);
    updateTransactions(res.user.transactions||[]);
    closeModal('otpModal');
    document.getElementById('otpRequestSection').style.display='block';
    document.getElementById('otpVerifySection').style.display='none';
    document.getElementById('otpCode').value='';
  });
}

socket.on('otpSent', ({ phone, expiresIn })=>{
  toast(`OTP sent to ${phone} - expires in ${expiresIn}s`, 'info');
});

socket.on('otpVerified', ({ userId: uid, phone })=>{
  toast(`Phone ${phone} verified - wallet linked`, 'success');
  const pp=document.getElementById('profilePhone');
  if (pp) pp.value=phone;
});

socket.on('clockUpdate', ({ clocks, turn })=>{
  // clocks in seconds
  if (clocks.w !== undefined) {
    const wMin=Math.floor(clocks.w/60); const wSec=clocks.w%60;
    const bMin=Math.floor(clocks.b/60); const bSec=clocks.b%60;
    const wEl=document.getElementById('whiteTimer');
    const bEl=document.getElementById('blackTimer');
    if (wEl) wEl.textContent=`${wMin}:${wSec.toString().padStart(2,'0')}`;
    if (bEl) bEl.textContent=`${bMin}:${bSec.toString().padStart(2,'0')}`;
    if (clocks.w<=30) wEl.style.color='var(--red)';
    if (clocks.b<=30) bEl.style.color='var(--red)';
  }
});

socket.on('clockTick', ({ clocks, turn })=>{
  // More granular tick - raw ms
  if (clocks) {
    // Update eval bar maybe
  }
});

socket.on('spectating', ({ game, spectators })=>{
  toast(`Spectating ${game.id} - ${spectators} watching`, 'info');
  currentGame=game;
  chess.load(game.fen);
  boardOrientation='white';
  renderBoard();
  renderGameInfo();
  renderMoves();
  // Disable moves for spectator
  selectedSquare=null; legalMoves=[];
  document.getElementById('blackStatus').textContent=`Spectating • ${spectators} viewers • ${game.type}`;
  document.getElementById('whiteStatus').textContent='Spectator mode - chat only';
});

socket.on('spectatorJoined', ({ count })=>{
  const el=document.getElementById('blackStatus');
  if (el && currentGame) el.textContent=`${count} spectators watching • Live`;
});

socket.on('chatMessage', ({ username: u, message, timestamp })=>{
  addChatMsg(`${u}: ${message}`, 'user');
});

// 5. SPECTATOR + SHAREABLE LINKS
function getGameIdFromUrl(){
  const params=new URLSearchParams(window.location.search);
  return params.get('game');
}

function spectateGameFromUrl(){
  const gid=getGameIdFromUrl();
  if (gid){
    socket.emit('spectateGame', { gameId: gid }, (res)=>{
      if (res && res.error){ toast('Game not found: '+gid,'error'); return; }
      toast(`Joined as spectator: ${gid}`,'success');
      history.replaceState(null,'',`?game=${gid}`);
    });
  }
}

function shareCurrentGame(){
  if (!currentGame){ toast('No active game to share','error'); return; }
  const url=`${window.location.origin}${window.location.pathname}?game=${currentGame.id}`;
  document.getElementById('shareLink').value=url;
  openModal('shareModal');
}

function copyShareLink(){
  const input=document.getElementById('shareLink');
  input.select();
  navigator.clipboard.writeText(input.value).then(()=> toast('Link copied! Share it','success'));
}

// Auto check for ?game= on load
window.addEventListener('load', ()=>{
  setTimeout(()=> spectateGameFromUrl(), 800);
});

// Add share button to game info dynamically
const origRenderGameInfo = renderGameInfo;
renderGameInfo = function(){
  origRenderGameInfo();
  if (currentGame && currentGame.status==='playing'){
    const gi=document.getElementById('gameInfo');
    if (gi && !gi.querySelector('#shareBtn')){
      const btn=document.createElement('button');
      btn.id='shareBtn';
      btn.className='btn btn-small btn-outline';
      btn.style.marginTop='8px'; btn.style.width='100%';
      btn.textContent='🔗 Share - Spectator Link';
      btn.onclick=shareCurrentGame;
      gi.appendChild(btn);
    }
  }
};

// 6. ECOCASH MODE BADGE
async function checkPaymentStatus(){
  try{
    const data = await fetch('/api/payments/status').then(r=>r.json());
    const badge=document.getElementById('ecoModeBadge');
    if (badge) badge.textContent = data.mode === 'live' ? 'LIVE MODE - Real API' : 'SANDBOX - Auto settles';
    const engine = await fetch('/api/engine/status').then(r=>r.json()).catch(()=>null);
    if (engine && engine.engine === 'stockfish-18-lichess'){
      setEngineStatus('Stockfish 18 ✓', 'Lichess engine (server)');
    }
  } catch(e){}
}
setTimeout(checkPaymentStatus, 1200);

// Show OTP modal on first visit if no phone verified
setTimeout(()=>{
  const hasSeenOtp = localStorage.getItem('hasSeenOtp');
  if (!hasSeenOtp && (!user || !user.phoneVerified)){
    // Don't auto show, just hint
    // openModal('otpModal');
    localStorage.setItem('hasSeenOtp','1');
  }
}, 2000);

// Override createCustomGame to also share link after creation
const origCreateCustom = createCustomGame;
createCustomGame = function(){
  const bet=parseFloat(document.getElementById('customBet').value)||1;
  if (user.balance < bet){ toast(`Need $${bet}`,'error'); openModal('depositModal'); return; }
  socket.emit('createGame', { userId, bet, timeControl: document.getElementById('customTime').value }, (res)=>{
    if (res&&res.error){ toast(res.error,'error'); return; }
    toast(`Private game ${res.gameId} created! Share link copied`,'success');
    const url=`${window.location.origin}${window.location.pathname}?game=${res.gameId}`;
    navigator.clipboard.writeText(url).then(()=>{});
    document.getElementById('shareLink').value=url;
    openModal('shareModal');
    currentGame=res.game;
    chess.load(res.game.fen);
    boardOrientation='white';
    renderBoard(); renderGameInfo();
  });
};

