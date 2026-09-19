import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from '@microsoft/signalr';
import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, readSession } from '../api/client';

export interface ExecutionEvent {
  type: string;
  runId: string;
  executionId?: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Live execution updates.
 *
 * The connection is a convenience layered over polling, never a replacement for it: if the
 * socket cannot be established — a proxy that blocks websockets, a restarted API — the
 * screens that use this still refresh from their queries. A live view that silently stops
 * updating is worse than one that visibly polls.
 */
export function useExecutionStream(options: {
  runId?: string;
  executionId?: string;
  onEvent?: (event: ExecutionEvent) => void;
  enabled?: boolean;
}) {
  const { runId, executionId, onEvent, enabled = true } = options;
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled || (!runId && !executionId)) return;

    const token = readSession()?.accessToken;
    if (!token) return;

    let cancelled = false;
    // SignalR cannot set an Authorization header on the websocket handshake, so the token
    // travels as a query parameter on this path only.
    const connection: HubConnection = new HubConnectionBuilder()
      .withUrl(`${apiBaseUrl()}/hubs/executions?access_token=${encodeURIComponent(token)}`)
      .withAutomaticReconnect([0, 2000, 5000, 10_000, 30_000])
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on('executionEvent', (event: ExecutionEvent) => {
      if (cancelled) return;
      // Bounded: a long run can emit thousands of events, and only the recent ones matter
      // to a live view.
      setEvents(previous => [...previous.slice(-400), event]);
      handlerRef.current?.(event);
    });

    connection.onreconnected(() => {
      setConnected(true);
      void subscribe();
    });
    connection.onreconnecting(() => setConnected(false));
    connection.onclose(() => setConnected(false));

    const subscribe = async () => {
      if (connection.state !== HubConnectionState.Connected) return;
      if (runId) await connection.invoke('SubscribeToRun', runId).catch(() => undefined);
      if (executionId) await connection.invoke('SubscribeToExecution', executionId).catch(() => undefined);
    };

    connection.start()
      .then(async () => {
        if (cancelled) return;
        setConnected(true);
        await subscribe();
      })
      .catch(() => setConnected(false));

    return () => {
      cancelled = true;
      void connection.stop();
    };
  }, [runId, executionId, enabled]);

  return { events, connected };
}
