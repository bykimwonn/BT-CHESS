import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthProvider';
import { useToast } from './ToastProvider';

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';
type SocketHandler = (payload: any) => void; // Socket.IO event payloads are dynamic by design.

interface SocketValue {
  socket: Socket | null;
  connected: boolean;
  connectionState: ConnectionState;
  error: string | null;
  emit: <T = unknown>(event: string, payload?: unknown) => Promise<T>;
  on: (event: string, handler: SocketHandler) => () => void;
}

const SocketContext = createContext<SocketValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const toast = useToast();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef(new Map<string, Set<SocketHandler>>());

  useEffect(() => {
    if (!user) {
      setConnectionState('offline');
      return;
    }
    const instance = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    setSocket(instance);
    setConnectionState('connecting');
    const onConnect = () => { setConnectionState('connected'); setError(null); };
    const onDisconnect = () => setConnectionState('reconnecting');
    const onReconnectAttempt = () => setConnectionState('reconnecting');
    const onError = (err: Error) => {
      setError(err.message);
      setConnectionState('offline');
    };
    const onServerError = (payload: { message?: string }) => {
      if (payload?.message) toast.error('Server rejected a request', payload.message);
    };
    instance.on('connect', onConnect);
    instance.on('disconnect', onDisconnect);
    instance.on('reconnect_attempt', onReconnectAttempt);
    instance.on('connect_error', onError);
    instance.on('server:error', onServerError);
    return () => {
      instance.off('connect', onConnect);
      instance.off('disconnect', onDisconnect);
      instance.off('reconnect_attempt', onReconnectAttempt);
      instance.off('connect_error', onError);
      instance.off('server:error', onServerError);
      instance.disconnect();
      setSocket(null);
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebind consumer subscriptions whenever the socket instance changes.
  useEffect(() => {
    if (!socket) return;
    const bindings: Array<[string, (payload: unknown) => void]> = [];
    for (const [event, set] of handlers.current) {
      for (const handler of set) {
        const bound = (payload: unknown) => handler(payload);
        socket.on(event, bound);
        bindings.push([event, bound]);
      }
    }
    return () => { for (const [event, bound] of bindings) socket.off(event, bound); };
  }, [socket]);

  const on = useCallback((event: string, handler: SocketHandler) => {
    let set = handlers.current.get(event);
    if (!set) { set = new Set(); handlers.current.set(event, set); }
    set.add(handler);
    socket?.on(event, handler);
    return () => {
      set?.delete(handler);
      socket?.off(event, handler);
    };
  }, [socket]);

  const emit = useCallback(async <T,>(event: string, payload: unknown = {}): Promise<T> => {
    if (!socket) throw new Error('Not connected to the game server');
    const result = await socket.timeout(10_000).emitWithAck(event, payload) as { ok?: boolean; error?: { message?: string } } & T;
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      throw new Error(result.error?.message ?? 'The server rejected the request');
    }
    return result as T;
  }, [socket]);

  const value = useMemo<SocketValue>(() => ({
    socket, connected: connectionState === 'connected', connectionState, error, emit, on,
  }), [socket, connectionState, error, emit, on]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketValue {
  const context = useContext(SocketContext);
  if (!context) throw new Error('useSocket must be used inside SocketProvider');
  return context;
}

export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void): void {
  const { on } = useSocket();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => on(event, ((payload: T) => ref.current(payload)) as SocketHandler), [event, on]);
}
