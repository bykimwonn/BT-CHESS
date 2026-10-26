import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameSnapshot } from '@shared/contracts';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../app/AuthProvider';
import { useSocket, useSocketEvent } from '../../app/SocketProvider';

interface ChatMessage { username: string; text: string; at: string }
interface PendingMove { resolve: (snapshot: GameSnapshot) => void; reject: (error: Error) => void; expectedVersion: number; timer: number }

export function useGame(gameId: string) {
  const { user } = useAuth();
  const { connected, emit } = useSocket();
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [replayPly, setReplayPly] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState(false);
  const serverOffset = useRef(0);
  const pending = useRef(new Map<string, PendingMove>());

  const refresh = useCallback(async () => {
    try {
      const next = await api<GameSnapshot>(`/games/${gameId}`);
      serverOffset.current = Date.parse(next.serverTime) - Date.now();
      setSnapshot(next);
      setError(null);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally { setLoading(false); }
  }, [gameId]);

  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);

  useEffect(() => {
    if (!connected) return;
    void emit('game:join', { gameId }).catch((err) => setError(errorMessage(err)));
  }, [connected, gameId, emit]);

  useSocketEvent<GameSnapshot>('game:state', (next) => {
    if (next.id !== gameId) return;
    serverOffset.current = Date.parse(next.serverTime) - Date.now();
    setSnapshot(next);
    for (const [nonce, waiter] of pending.current) {
      if (next.version > waiter.expectedVersion || next.status !== 'active') {
        window.clearTimeout(waiter.timer);
        pending.current.delete(nonce);
        waiter.resolve(next);
      }
    }
  });
  useSocketEvent<ChatMessage & { gameId: string }>('game:chat', (message) => {
    if (message.gameId === gameId) setChat((list) => [...list.slice(-49), message]);
  });
  useSocketEvent<{ gameId: string }>('game:terminal', (event) => {
    if (event.gameId === gameId) void refresh().catch(() => undefined);
  });

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (snapshot?.status !== 'active') return;
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 200);
    return () => window.clearInterval(timer);
  }, [snapshot?.status]);
  const displayClocks = useMemo(() => {
    if (!snapshot) return { white: 0, black: 0 };
    let white = snapshot.whiteClockMs, black = snapshot.blackClockMs;
    if (snapshot.status === 'active' && snapshot.turnStartedAt) {
      const serverNow = Date.now() + serverOffset.current;
      const elapsed = Math.max(0, serverNow - Date.parse(snapshot.turnStartedAt));
      if (snapshot.fen.split(' ')[1] === 'w') white = Math.max(0, white - elapsed);
      else black = Math.max(0, black - elapsed);
    }
    return { white, black };
    // clockTick is intentionally read to recompute on each interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, clockTick]);

  useEffect(() => () => {
    for (const waiter of pending.current.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error('Game view was closed'));
    }
    pending.current.clear();
  }, []);

  const submitMove = useCallback(async (from: string, to: string, promotion?: string) => {
    if (!snapshot) throw new Error('Game state is not loaded');
    const nonce = crypto.randomUUID();
    setPendingMove(true);
    try {
      const promise = new Promise<GameSnapshot>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.current.delete(nonce);
          reject(new Error('The server did not acknowledge the move in time; refresh the game.'));
        }, 10_000);
        pending.current.set(nonce, { resolve, reject, expectedVersion: snapshot.version, timer });
      });
      const payload = { gameId, version: snapshot.version, from, to, promotion, nonce };
      if (connected) {
        await emit('game:move', payload).catch(async (err) => {
          window.clearTimeout(pending.current.get(nonce)?.timer);
          pending.current.delete(nonce);
          await refresh().catch(() => undefined);
          throw new Error(errorMessage(err));
        });
      } else {
        const result = await api<{ snapshot: GameSnapshot }>(`/games/${gameId}/moves`, { method: 'POST', body: payload });
        window.clearTimeout(pending.current.get(nonce)?.timer);
        pending.current.delete(nonce);
        serverOffset.current = Date.parse(result.snapshot.serverTime) - Date.now();
        setSnapshot(result.snapshot);
        return result.snapshot;
      }
      return await promise;
    } finally { setPendingMove(false); }
  }, [snapshot, connected, emit, gameId, refresh]);

  const action = useCallback(async (event: string, restPath: string, payload: Record<string, unknown> = {}) => {
    try {
      if (connected) await emit(event, { gameId, ...payload });
      else await api(`/games/${gameId}/${restPath}`, { method: 'POST', body: payload });
      await refresh();
    } catch (err) { setError(errorMessage(err)); throw err; }
  }, [connected, emit, gameId, refresh]);

  const resign = useCallback(() => action('game:resign', 'resign'), [action]);
  const offerDraw = useCallback(() => action('game:draw-offer', 'draw-offer'), [action]);
  const answerDraw = useCallback((accept: boolean) => action('game:draw-answer', 'draw-answer', { accept }), [action]);
  const claimDraw = useCallback(() => action('game:claim-draw', 'claim-draw'), [action]);

  const sendChat = useCallback(async (text: string) => {
    if (!connected) throw new Error('Chat requires a live connection');
    await emit('game:chat', { gameId, text });
  }, [connected, emit, gameId]);

  const viewerColor = useMemo(() => {
    if (!snapshot || !user) return null;
    if (snapshot.white.userId === user.id) return 'white';
    if (snapshot.black.userId === user.id) return 'black';
    return null;
  }, [snapshot, user]);
  const isSpectator = !!snapshot && !viewerColor;
  const isMyTurn = !!snapshot && snapshot.status === 'active' && !!viewerColor &&
    ((snapshot.fen.split(' ')[1] === 'w' && viewerColor === 'white') ||
      (snapshot.fen.split(' ')[1] === 'b' && viewerColor === 'black'));

  const replayFen = replayPly === null || !snapshot
    ? snapshot?.fen ?? null
    : replayPly === 0 ? snapshot.initialFen : snapshot.moves[replayPly - 1]?.fen ?? snapshot.fen;
  const replayUciMoves = replayPly === null || !snapshot
    ? snapshot?.moves.map((m) => m.uci) ?? []
    : snapshot.moves.slice(0, replayPly).map((m) => m.uci);

  return {
    snapshot, loading, error, refresh, chat, clocks: displayClocks,
    submitMove, pendingMove, resign, offerDraw, answerDraw, claimDraw, sendChat,
    viewerColor, isSpectator, isMyTurn, connected,
    orientation: (viewerColor ?? 'white') as 'white' | 'black',
    replayPly, setReplayPly, replayFen, replayUciMoves,
  };
}
