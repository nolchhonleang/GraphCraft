import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus, GraphPayload, WebSocketEnvelope } from "../types";

const DEFAULT_URL = "ws://127.0.0.1:8000";
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

export interface UseWebSocketOptions {
  url?: string;
  autoConnect?: boolean;
  onGraph?: (graph: GraphPayload) => void;
  onMessage?: (envelope: WebSocketEnvelope) => void;
  onStatus?: (status: ConnectionStatus) => void;
}

export interface UseWebSocketResult {
  status: ConnectionStatus;
  lastError: string | null;
  graph: GraphPayload | null;
  connect: () => void;
  disconnect: () => void;
  send: (payload: Record<string, unknown>) => boolean;
  requestScan: (path?: string) => boolean;
  requestGraph: () => boolean;
}

/**
 * Native WebSocket lifecycle hook with exponential backoff retry.
 *
 * Connects exclusively to the local GraphCraft engine. No external
 * endpoints are contacted.
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketResult {
  const {
    url = DEFAULT_URL,
    autoConnect = true,
    onGraph,
    onMessage,
    onStatus,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [lastError, setLastError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(INITIAL_RETRY_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => undefined);

  const onGraphRef = useRef(onGraph);
  const onMessageRef = useRef(onMessage);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onGraphRef.current = onGraph;
    onMessageRef.current = onMessage;
    onStatusRef.current = onStatus;
  }, [onGraph, onMessage, onStatus]);

  const updateStatus = useCallback((next: ConnectionStatus) => {
    if (!mountedRef.current) {
      return;
    }
    setStatus(next);
    onStatusRef.current?.(next);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const applyGraph = useCallback((envelope: WebSocketEnvelope) => {
    const payload: GraphPayload = {
      nodes: envelope.nodes ?? [],
      edges: envelope.edges ?? [],
      root_path: envelope.root_path ?? "",
      stats: envelope.stats ?? { node_count: 0, edge_count: 0 },
    };
    if (!mountedRef.current) {
      return;
    }
    setGraph(payload);
    onGraphRef.current?.(payload);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current || !mountedRef.current) {
      return;
    }
    clearRetryTimer();
    const delay = retryRef.current;
    timerRef.current = setTimeout(() => {
      connectRef.current();
    }, delay);
    retryRef.current = Math.min(MAX_RETRY_MS, Math.round(delay * 1.6));
  }, [clearRetryTimer]);

  const connect = useCallback(() => {
    clearRetryTimer();
    intentionalCloseRef.current = false;

    if (socketRef.current) {
      try {
        socketRef.current.onopen = null;
        socketRef.current.onmessage = null;
        socketRef.current.onerror = null;
        socketRef.current.onclose = null;
        socketRef.current.close();
      } catch {
        // ignore close races
      }
      socketRef.current = null;
    }

    updateStatus("connecting");
    setLastError(null);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      updateStatus("error");
      scheduleReconnect();
      return;
    }

    socketRef.current = socket;

    socket.onopen = () => {
      retryRef.current = INITIAL_RETRY_MS;
      updateStatus("open");
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as WebSocketEnvelope;
        onMessageRef.current?.(envelope);

        if (envelope.type === "graph" || envelope.type === "error") {
          if (envelope.nodes || envelope.edges) {
            applyGraph(envelope);
          }
          if (envelope.type === "error" && envelope.message) {
            setLastError(envelope.message);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(`Malformed server message: ${message}`);
      }
    };

    socket.onerror = () => {
      setLastError("WebSocket connection error (is the backend running on localhost:8000?)");
      updateStatus("error");
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (intentionalCloseRef.current) {
        updateStatus("closed");
        return;
      }
      updateStatus("closed");
      scheduleReconnect();
    };
  }, [url, updateStatus, clearRetryTimer, scheduleReconnect, applyGraph]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearRetryTimer();
    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch {
        // ignore
      }
      socketRef.current = null;
    }
    updateStatus("closed");
  }, [clearRetryTimer, updateStatus]);

  const send = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      return false;
    }
  }, []);

  const requestScan = useCallback(
    (path?: string): boolean => {
      const body: Record<string, unknown> = { type: "scan" };
      if (path) {
        body.path = path;
      }
      return send(body);
    },
    [send],
  );

  const requestGraph = useCallback((): boolean => send({ type: "get_graph" }), [send]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoConnect) {
      connect();
    }
    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      clearRetryTimer();
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          // ignore
        }
        socketRef.current = null;
      }
    };
    // Only re-run when url / autoConnect change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, autoConnect]);

  return {
    status,
    lastError,
    graph,
    connect,
    disconnect,
    send,
    requestScan,
    requestGraph,
  };
}

export default useWebSocket;
