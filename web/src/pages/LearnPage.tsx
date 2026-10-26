import { useMemo, useState } from 'react';
import type { Arrow } from 'react-chessboard';
import { Chess } from 'chess.js';
import { ChessBoard } from '../features/chess/ChessBoard';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface Lesson {
  id: string; title: string; level: string; minutes: number;
  fen: string; arrows: Arrow[]; objective: string; ideas: string[];
  quiz: { question: string; options: string[]; answer: number; explanation: string };
}

const LESSONS: Lesson[] = [
  {
    id: 'opening', title: 'Opening principles', level: 'Beginner', minutes: 6,
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    arrows: [{ startSquare: 'g1', endSquare: 'f3', color: '#d8b46a' }, { startSquare: 'f1', endSquare: 'c4', color: '#7fd1c1' }],
    objective: 'Control the centre, develop minor pieces and castle early.',
    ideas: ['A central pawn opens lines for bishops and the queen.', 'Knights usually develop before bishops because their best squares are clearer.', 'Every pawn move creates a weakness; do not make unnecessary pawn moves.'],
    quiz: { question: 'Which move best follows opening principles from this position?', options: ['Bf1–c4, developing toward the centre', 'h2–h4, attacking nothing', 'a2–a4, moving a rook pawn'], answer: 0, explanation: 'Bc4 develops a piece, controls d5 and prepares castling.' },
  },
  {
    id: 'tactics', title: 'Forks and double attacks', level: 'Beginner', minutes: 5,
    fen: '4k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
    arrows: [{ startSquare: 'd5', endSquare: 'e7', color: '#d8b46a' }, { startSquare: 'd5', endSquare: 'c7', color: '#d8b46a' }],
    objective: 'Recognise when one move attacks two targets at once.',
    ideas: ['A knight is especially strong at forking because it jumps over pieces.', 'Look for checks, captures and threats after every candidate move.', 'Calculate the opponent’s forced replies before playing a tactic.'],
    quiz: { question: 'What should you look for first in a tactical position?', options: ['Checks, captures and threats', 'Only pawn moves', 'The number of pieces on the board'], answer: 0, explanation: 'Forcing moves narrow the opponent’s choices and reveal tactics.' },
  },
  {
    id: 'mate', title: 'Back-rank mate', level: 'Beginner', minutes: 4,
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    arrows: [{ startSquare: 'a1', endSquare: 'a8', color: '#ff8b8b' }],
    objective: 'Understand why a king can be trapped behind its own pawns.',
    ideas: ['The rook checks along the eighth rank.', 'The king cannot escape to f8 or h8 because its own pawns block the flight squares.', 'Creating luft with h3, g3 or f3 can prevent this pattern.'],
    quiz: { question: 'What prevents the black king from escaping the back-rank check?', options: ['Its own f7, g7 and h7 pawns', 'The white king', 'The clock'], answer: 0, explanation: 'The pawns occupy the escape squares, so the check is mate.' },
  },
  {
    id: 'endgame', title: 'King and pawn endings', level: 'Intermediate', minutes: 7,
    fen: '8/8/8/4k3/8/4P3/4K3/8 w - - 0 1',
    arrows: [{ startSquare: 'e2', endSquare: 'd3', color: '#d8b46a' }, { startSquare: 'e3', endSquare: 'e4', color: '#7fd1c1' }],
    objective: 'Use the king actively and understand opposition.',
    ideas: ['In endgames the king becomes a fighting piece.', 'Opposition means the kings stand on the same file with one square between them; the side not to move often benefits.', 'Not every pawn ending is winning: precise king placement matters.'],
    quiz: { question: 'Which piece becomes especially active in endgames?', options: ['The king', 'The queen', 'Both rooks'], answer: 0, explanation: 'With fewer attacking pieces, the king can safely support pawns and attack the opponent’s.' },
  },
  {
    id: 'structure', title: 'Pawn structure', level: 'Intermediate', minutes: 6,
    fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 2',
    arrows: [{ startSquare: 'c5', endSquare: 'd4', color: '#7fd1c1' }, { startSquare: 'e4', endSquare: 'd5', color: '#d8b46a' }],
    objective: 'Connect pawn moves to long-term squares and plans.',
    ideas: ['Pawns cannot move backwards, so every pawn move is permanent.', 'Pawn chains create strong and weak squares.', 'A pawn break can open a file for rooks or change the centre completely.'],
    quiz: { question: 'Why are pawn moves strategically important?', options: ['Pawns cannot move backwards', 'Pawns are worth more than queens', 'Pawns can teleport'], answer: 0, explanation: 'Their permanence makes pawn structure a long-term commitment.' },
  },
  {
    id: 'defence', title: 'Defending weak squares', level: 'Beginner', minutes: 5,
    fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    arrows: [{ startSquare: 'h4', endSquare: 'e1', color: '#ff8b8b' }],
    objective: 'Notice direct threats before making a developing move.',
    ideas: ['This position is already checkmate: White ignored the threat to f2/e1.', 'Before each move, ask what the opponent threatens.', 'A single defensive move can be more valuable than development.'],
    quiz: { question: 'What should you ask before every move?', options: ['What does my opponent threaten?', 'How fast can I move?', 'How many pawns do I have?'], answer: 0, explanation: 'Threat awareness prevents immediate tactical losses.' },
  },
];

export function LearnPage() {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<number | null>(null);
  const [completed, setCompleted] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('rookstone.lessons.v1') ?? '[]') as string[]; } catch { return []; }
  });
  const lesson = LESSONS[index];
  const validFen = useMemo(() => { try { new Chess(lesson.fen); return true; } catch { return false; } }, [lesson.fen]);

  const choose = (value: number) => {
    setAnswer(value);
    if (value === lesson.quiz.answer && !completed.includes(lesson.id)) {
      const next = [...completed, lesson.id];
      setCompleted(next);
      localStorage.setItem('rookstone.lessons.v1', JSON.stringify(next));
    }
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Learn" title="Chess fundamentals" description="Short original lessons with real board positions, clear objectives and knowledge checks. Progress is stored only in your browser."
        actions={<span className="pill pill-teal">{completed.length} of {LESSONS.length} completed</span>} />
      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-header"><div><span className="eyebrow">{lesson.level} · {lesson.minutes} min</span><h2 className="card-title" style={{ fontSize: '1.6rem' }}>{lesson.title}</h2><p className="card-subtitle">{lesson.objective}</p></div>
              {completed.includes(lesson.id) && <span className="pill pill-success"><Icon name="check" size={14} /> Completed</span>}</div>
            {validFen && <ChessBoard fen={lesson.fen} arrows={lesson.arrows} disabled allowArrows={false} className="lesson-board" />}
            <div className="stack" style={{ marginTop: '1rem' }}>
              {lesson.ideas.map((idea) => <div className="alert" key={idea}><Icon name="check" size={15} /> {idea}</div>)}
            </div>
          </section>
          <section className="card">
            <h2 className="card-title">Knowledge check</h2>
            <p><strong>{lesson.quiz.question}</strong></p>
            <div className="stack" style={{ gap: '.5rem' }}>
              {lesson.quiz.options.map((option, value) => (
                <button className="btn" key={option} style={{ justifyContent: 'flex-start', textAlign: 'left' }} aria-pressed={answer === value} onClick={() => choose(value)}>
                  {String.fromCharCode(65 + value)}. {option}
                </button>
              ))}
            </div>
            {answer !== null && <div className={`alert ${answer === lesson.quiz.answer ? 'alert-success' : 'alert-warning'}`} style={{ marginTop: '.75rem' }}>
              <strong>{answer === lesson.quiz.answer ? 'Correct.' : 'Try again.'}</strong> {lesson.quiz.explanation}
            </div>}
          </section>
        </div>
        <aside className="sidebar">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Lessons</h2><span className="pill">{LESSONS.length}</span></div>
            <div className="stack" style={{ gap: '.4rem' }}>
              {LESSONS.map((item, value) => (
                <button className={`btn btn-sm ${value === index ? 'btn-primary' : ''}`} key={item.id} onClick={() => { setIndex(value); setAnswer(null); }}>
                  {completed.includes(item.id) ? <Icon name="check" size={14} /> : <Icon name="book" size={14} />} {item.title}
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            <h2 className="card-title">Study method</h2>
            <ol className="small soft" style={{ paddingLeft: '1.2rem' }}>
              <li>Read the objective.</li><li>Reproduce the idea on the board.</li><li>Answer the knowledge check.</li><li>Apply the pattern in Puzzles and in a Practice game, then review in Analysis.</li>
            </ol>
            <p className="tiny muted" style={{ marginBottom: 0 }}>No external content, advertisements or fake activity feeds are embedded.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
