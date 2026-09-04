/* Smoke-test / benchmark the engine stack end to end. */
const { EngineService } = require('../lib/engine');

const POSITIONS = [
  { name: 'mate in 1 (Ra8#)', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', expect: 'a1a8', difficulty: 'grandmaster' },
  { name: 'mate in 2 (Qd8+)', fen: 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PP3PPP/R3R1K1 w - - 1 1', expect: 'd5d8', difficulty: 'grandmaster' },
  { name: 'back rank (Rd8+)', fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', expect: 'd1d8', difficulty: 'grandmaster' },
  { name: 'opening', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', difficulty: 'medium' },
  { name: 'tactics middlegame', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', difficulty: 'hard' },
];

(async () => {
  const svc = new EngineService({ cloudEnabled: process.env.LICHESS_CLOUD_EVAL !== 'false', log: (m) => console.log(m) });
  const t0 = Date.now();
  await svc.init();
  console.log(`init in ${Date.now() - t0}ms\n`);
  console.log('status:', JSON.stringify(svc.status(), null, 1).slice(0, 600), '\n');

  for (const p of POSITIONS) {
    const res = await svc.getMove({ fen: p.fen, difficulty: p.difficulty });
    const ok = p.expect ? (res.uci === p.expect ? 'OK  ' : `FAIL(expected ${p.expect})`) : '    ';
    console.log(
      `${ok} ${p.name.padEnd(24)} ${p.difficulty.padEnd(12)} -> ${res.uci}  src=${res.source} depth=${res.depth} ${res.elapsedMs}ms eval=${JSON.stringify(res.eval)}`
    );
  }

  console.log('\n--- difficulty ladder (opening position, 5 moves each) ---');
  for (const d of ['easy', 'medium', 'hard', 'master', 'grandmaster']) {
    const t = Date.now();
    const moves = [];
    for (let i = 0; i < 3; i++) {
      const r = await svc.getMove({ fen: POSITIONS[3].fen, difficulty: d });
      moves.push(`${r.uci}(${r.source === 'lichess-cloud' ? 'cloud' : r.source === 'stockfish-18-lichess' ? 'sf18' : r.source})`);
    }
    console.log(`${d.padEnd(12)} ${(Date.now() - t)}ms total  ${moves.join(' ')}`);
  }

  console.log('\n--- anti-cheat sample ---');
  const ac = await svc.analyseMove({ fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', moveUci: 'a1a8' });
  console.log('good move :', JSON.stringify(ac));
  const ac2 = await svc.analyseMove({ fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', moveUci: 'a1a3' });
  console.log('weak move :', JSON.stringify(ac2));

  console.log('\nfinal stats:', JSON.stringify(svc.status().stats));
  svc.shutdown();
  process.exit(0);
})();
