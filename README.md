# ♔ BetChess ZW — Chess.com Style Betting Platform • Stockfish + LLM Arena • EcoCash

Zimbabwe's first real-money chess platform: Bet vs Stockfish or vs random players matched by same bet amount (like chess.com random + bet filter). Winner auto-paid via EcoCash wallet.

**Live Features:**
- 💰 Bet Matchmaking: Set $0.50+ → System pairs you with same-bet player instantly (chess.com structure + ZW twist)
- 🤖 Stockfish 16 Open Source: Easy (800) → Grandmaster (2850) • 1.6x to 15x payout + progressive jackpot
- 🧩 Puzzles Tactics Trainer: Win $0.10 per solve
- 🤖 LLM Arena: Configure OpenAI/Groq/Anthropic/Gemini API key, LLM plays with commentary {"commentary","move"} JSON
- 🎰 Jackpot: 2% of losses → pool, 15% chance win 10% when beating Master/GM
- 📱 EcoCash Wallet: Deposit/withdraw via EcoCash or Bank, OTP phone login (wallet tied to phone, recoverable)
- ⏱️ Real Clocks: Ticking 10+0, 5+0 etc, flag loss
- 👁️ Spectator Mode: Share link ?game=XXXX like lichess
- 🛡️ Anti-Cheat: Server-side Stockfish verification, not client-trust
- 💾 JSON DB: Persists to data/*.json every 3 sec, survives restart
- 🛠️ Admin Dashboard: /admin (password admin123ZW)

## Quick Start

```bash
unzip chess-bet-app.zip
cd chess-bet-app
npm install
node server.js
# Open http://localhost:3000
# Admin http://localhost:3000/admin
```

## Project Structure (Step 1 as requested)

```
/public
  index.html — dashboard, board centered, config panel for LLM API keys, commentary display
  style.css — chess.com dark theme
  app.js — game loop, state handlers, LLM integration, Stockfish client
  admin.html — admin dashboard
  stockfish.js — Stockfish 16 engine (10.0.2)
server.js — Express + Socket.io, game logic, EcoCash stub, clocks, OTP, DB
data/ — JSON persistence (gitignored, created at runtime)
package.json
```

## UI Layout (Step 2)

- Top Nav: Play | Puzzles | LLM Arena | Leaderboard | Learn
- Left Sidebar: Quick Match bet slider + Find Match, Computer/Friend/LLM tabs, difficulty grid, wallet
- Center: Board + vertical eval bar + player bars + controls (Flip/Hint/Undo/Analysis)
- Right Sidebar: Game/Analysis/Chat tabs, moves (chess.com style), pot, commentary box for LLM

## Game Loop (Step 3)

- Initialize board -> chess.js new Chess()
- Hook board click -> onSquareClick -> validate via chess.moves({square, verbose})
- After valid human move -> async delay -> hand to AI pipeline (engineMove / requestEngineMove / requestLLMMove)

## LLM API Integration (Step 4)

- Capture FEN: chess.fen()
- System Prompt: 
```
You are Grandmaster chess AI.
FEN: {fen}
You are {color}. Legal: {legalMoves} History: {history}
Output ONLY JSON {"commentary":"strategic reasoning","move":"uci"}
```
- HTTP to aggregator: 
  POST /api/llm/move {fen, legalMoves, provider, model, apiKey, playerColor, history}
  Proxies to OpenAI /api/chat/completions, Groq, Anthropic, Gemini
  Fallback if no key: Stockfish-simulated commentary + random legal move

## Parse & Execute (Step 5)

- Extract commentary -> #commentaryBox live
- Extract move UCI -> chess.js validation -> update board -> check checkmate/draw

## EcoCash Real Integration (Step 6)

Set env:
```
ECOCASH_MERCHANT_CODE=your_code
ECOCASH_API_KEY=your_key
BASE_URL=https://yourdomain.com
ADMIN_PASSWORD=strong_password
```

Routes:
- POST /api/ecocash/deposit {phone, amount, userId} -> initiate C2B
- POST /api/ecocash/callback {reference, status, transactionId} -> called by EcoCash, verifies, adds balance
- POST /api/ecocash/withdraw -> B2C
- GET /api/ecocash/status

In MOCK mode (no env), deposits auto-complete after 2.2s, withdrawals after 3s, for demo.

## OTP Login (Feature 4)

- POST requestOTP {phone} -> generates 6-digit, stores 5 min, logs to console (in prod send SMS via Econet)
- POST verifyOTP {phone, code} -> links phone to userId, wallet recoverable

## Spectator (Feature 5)

- Share link: ?game=PVP-XXXX
- Event spectateGame -> joins room, sees moves live, chat only
- Used for high stakes FOMO like chess.com broadcast

## Admin (Feature 7)

- /admin -> login admin123ZW -> stats, jackpot controls, pending withdrawals approve (triggers B2C), users, games, queues, transactions

## Deployment

- Node 18+, npm install
-_pm2: pm2 start server.js --name betchess
- Nginx reverse proxy to :3000 with SSL
- Set env vars for EcoCash LIVE

## Legal ZW

Add 18+ disclaimer, responsible gaming, skill-based gaming clauses for ZIMRA.

Enjoy! ♟️💰🇿🇼
