import { z } from 'zod';
import type { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../../shared/contracts.js';
import { moveSchema } from '../../shared/validation.js';
import type { AppContext } from '../services/context.js';
import { findSession, assertSocketOrigin, type AuthUser } from '../auth/session.js';
import { AppError } from '../services/errors.js';
import type { GameEvents } from './service.js';

interface SocketData { auth: AuthUser }

const gameIdSchema = z.object({ gameId: z.string().uuid() });
const drawAnswerSchema = gameIdSchema.extend({ accept: z.boolean() });
const chatSchema = gameIdSchema.extend({ text: z.string().trim().min(1).max(300) });

function errorPayload(error: unknown): { message: string; code: string; detail?: unknown } {
  if (error instanceof AppError) return { message: error.message, code: error.code, detail: error.detail };
  if (error instanceof z.ZodError) return { message: 'Invalid request', code: 'validation_error', detail: error.issues };
  return { message: error instanceof Error ? error.message : 'Unexpected server error', code: 'server_error' };
}

export class RealtimeService {
  private readonly connections = new Map<string, Set<string>>();
  private readonly chat = new Map<string, Array<{ username: string; text: string; at: string }>>();
  private readonly rate = new Map<string, number[]>();

  constructor(private readonly io: Server, private readonly ctx: AppContext) {}

  isConnected(userId: string): boolean { return (this.connections.get(userId)?.size ?? 0) > 0; }

  attach(): void {
    this.ctx.games.presence = { isConnected: (userId) => this.isConnected(userId) };
    this.io.use(async (socket, next) => {
      try {
        assertSocketOrigin(socket.handshake.headers);
        const user = await findSession(this.ctx.db, socket.handshake.headers);
        if (!user) throw new AppError(401, 'unauthorized', 'Authentication required');
        (socket.data as SocketData).auth = user;
        next();
      } catch (error) { next(error instanceof Error ? error : new Error('Unauthorised')); }
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private rateOk(socketId: string, event: string, max: number, windowMs: number): boolean {
    const key = `${socketId}:${event}`;
    const now = Date.now();
    const calls = (this.rate.get(key) ?? []).filter((t) => now - t < windowMs);
    if (calls.length >= max) { this.rate.set(key, calls); return false; }
    calls.push(now);
    this.rate.set(key, calls);
    return true;
  }

  private onConnection(socket: Socket): void {
    const user = (socket.data as SocketData).auth;
    let set = this.connections.get(user.id);
    if (!set) { set = new Set(); this.connections.set(user.id, set); }
    set.add(socket.id);
    socket.join(`user:${user.id}`);
    this.ctx.log.info({ userId: user.id, socketId: socket.id }, 'socket connected');
    void this.onPresenceChanged(user.id, true);

    const handle = <T>(
      event: string,
      schema: z.ZodType<T>,
      fn: (payload: T, user: AuthUser) => Promise<unknown>,
      maxPerSecond = 8,
    ) => {
      socket.on(event, async (payload: unknown, ack?: (response: unknown) => void) => {
        if (!this.rateOk(socket.id, event, maxPerSecond, 1000)) {
          ack?.({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } });
          return;
        }
        try {
          const parsed = schema.parse(payload ?? {});
          const result = await fn(parsed, user);
          ack?.({ ok: true, ...(result && typeof result === 'object' ? result as object : {}) });
        } catch (error) {
          const detail = errorPayload(error);
          ack?.({ ok: false, error: detail });
          socket.emit(SOCKET_EVENTS.error, detail);
          const snapshot = (detail.detail as { snapshot?: unknown } | undefined)?.snapshot;
          if (snapshot) socket.emit(SOCKET_EVENTS.gameState, snapshot);
        }
      });
    };

    handle('game:join', gameIdSchema, async ({ gameId }) => {
      await this.joinGame(socket, gameId);
      return { joined: gameId };
    });
    handle('game:leave', gameIdSchema, async ({ gameId }) => {
      socket.leave(`game:${gameId}`);
      return { left: gameId };
    });
    handle(SOCKET_EVENTS.gameMove, moveSchema, async (input, auth) => {
      const result = await this.ctx.games.submitMove(auth.id, input);
      await this.publishEvents(result.events);
      return { duplicate: result.duplicate, version: result.snapshot.version };
    }, 20);
    handle(SOCKET_EVENTS.gameResign, gameIdSchema, async ({ gameId }, auth) => {
      await this.publishEvents(await this.ctx.games.resign(auth.id, gameId));
      return { resigned: true };
    });
    handle(SOCKET_EVENTS.gameDrawOffer, gameIdSchema, async ({ gameId }, auth) => {
      await this.publishEvents(await this.ctx.games.offerDraw(auth.id, gameId));
      return { offered: true };
    });
    handle(SOCKET_EVENTS.gameDrawAnswer, drawAnswerSchema, async ({ gameId, accept }, auth) => {
      await this.publishEvents(await this.ctx.games.answerDraw(auth.id, gameId, accept));
      return { answered: true };
    });
    handle(SOCKET_EVENTS.gameClaimDraw, gameIdSchema, async ({ gameId }, auth) => {
      await this.publishEvents(await this.ctx.games.claimDraw(auth.id, gameId));
      return { claimed: true };
    });
    handle('challenge:subscribe', z.object({}), async () => {
      socket.join('lobby');
      return { subscribed: true };
    });
    socket.on(SOCKET_EVENTS.gameChat, async (payload: unknown, ack?: (response: unknown) => void) => {
      if (!this.rateOk(socket.id, 'game:chat', 3, 1000)) {
        ack?.({ ok: false, error: { code: 'rate_limited', message: 'Chat is rate limited' } });
        return;
      }
      try {
        const { gameId, text } = chatSchema.parse(payload);
        const membership = await this.ctx.db.query(
          'SELECT id FROM games WHERE id = $1 AND (white_id = $2 OR black_id = $2)',
          [gameId, user.id],
        );
        if (!membership.rows.length) throw new AppError(403, 'forbidden', 'Only players may chat in a game');
        const messages = this.chat.get(gameId) ?? [];
        const message = { username: user.username, text, at: new Date().toISOString() };
        messages.push(message);
        this.chat.set(gameId, messages.slice(-50));
        this.io.to(`game:${gameId}`).emit(SOCKET_EVENTS.gameChat, { gameId, ...message });
        ack?.({ ok: true });
      } catch (error) {
        const detail = errorPayload(error);
        ack?.({ ok: false, error: detail });
      }
    });

    socket.on('disconnect', () => {
      const active = this.connections.get(user.id);
      active?.delete(socket.id);
      if (active?.size === 0) this.connections.delete(user.id);
      this.rate.delete(`${socket.id}:${SOCKET_EVENTS.gameMove}`);
      this.ctx.log.info({ userId: user.id, socketId: socket.id }, 'socket disconnected');
      void this.onPresenceChanged(user.id, false);
    });
  }

  private async joinGame(socket: Socket, gameId: string): Promise<void> {
    const result = await this.ctx.db.query('SELECT id, status FROM games WHERE id = $1', [gameId]);
    if (!result.rows.length) throw new AppError(404, 'not_found', 'Game not found');
    const user = (socket.data as SocketData).auth;
    socket.join(`game:${gameId}`);
    const snapshot = await this.ctx.games.getSnapshot(gameId, user.id);
    socket.emit(SOCKET_EVENTS.gameState, snapshot);
    const messages = this.chat.get(gameId) ?? [];
    for (const message of messages) socket.emit(SOCKET_EVENTS.gameChat, { gameId, ...message });
    await this.ctx.games.resumeIfBothConnected(gameId);
  }

  private async activeGameIds(userId: string): Promise<string[]> {
    const result = await this.ctx.db.query<{ id: string }>(
      `SELECT id FROM games WHERE status IN ('active','disputed') AND (white_id = $1 OR black_id = $1)`,
      [userId],
    );
    return result.rows.map((r) => String(r.id));
  }

  private async onPresenceChanged(userId: string, connected: boolean): Promise<void> {
    try {
      const gameIds = await this.activeGameIds(userId);
      for (const gameId of gameIds) {
        if (connected) {
          const snapshot = await this.ctx.games.getSnapshot(gameId, userId);
          const both = this.isConnected(snapshot.white.userId) && this.isConnected(snapshot.black.userId);
          if (both) await this.ctx.games.clearDisconnectDeadline(gameId);
          await this.ctx.games.resumeIfBothConnected(gameId);
        } else {
          await this.ctx.games.markDisconnect(gameId, userId);
        }
        await this.publishGameState(gameId);
      }
    } catch (error) {
      this.ctx.log.warn({ userId, err: (error as Error).message }, 'presence update failed');
    }
  }

  async publishGameState(gameId: string): Promise<void> {
    const snapshot = await this.ctx.games.getSnapshot(gameId);
    this.io.to(`game:${gameId}`).emit(SOCKET_EVENTS.gameState, snapshot);
  }

  async publishEvents(events: GameEvents): Promise<void> {
    for (const gameId of new Set(events.stateGameIds)) {
      try { await this.publishGameState(gameId); }
      catch (error) { this.ctx.log.warn({ gameId, err: (error as Error).message }, 'state broadcast failed'); }
    }
    for (const notification of events.notifications) {
      this.io.to(`user:${notification.userId}`).emit(SOCKET_EVENTS.notification, notification);
    }
    if (events.terminal) {
      this.io.to(`game:${events.terminal.gameId}`).emit('game:terminal', events.terminal);
    }
  }

  async emitChallenge(challengeId: string, event: 'created' | 'updated' | 'matched' = 'updated'): Promise<void> {
    try {
      const challenge = await this.ctx.competition.getChallenge(challengeId);
      this.io.to('lobby').emit(event === 'created' ? SOCKET_EVENTS.challengeCreated : SOCKET_EVENTS.challengeUpdated, challenge);
    } catch (error) {
      this.ctx.log.warn({ challengeId, err: (error as Error).message }, 'challenge broadcast failed');
    }
  }

  emitMatchFound(userId: string, gameId: string): void {
    this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.matchFound, { gameId });
  }

  emitNotification(userId: string, payload: { type: string; title: string; body: string; link?: string | null }): void {
    this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.notification, payload);
  }
}
