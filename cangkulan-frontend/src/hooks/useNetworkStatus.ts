import { useState, useEffect, useCallback, useRef } from 'react';
import { config } from '@/config';

// ═══════════════════════════════════════════════════════════════════════════════
//  Network Status Hook
//  Periodic RPC health check with exponential back-off on failure.
// ═══════════════════════════════════════════════════════════════════════════════

export type NetworkState = 'online' | 'degraded' | 'offline';

export interface NetworkStatus {
  state: NetworkState;
  /** Last successful RPC ping timestamp, or null if never succeeded */
  lastPing: number | null;
  /** Manual retry — immediately pings RPC again */
  retry: () => void;
  /** Number of consecutive failures */
  failures: number;
}

const HEALTHY_INTERVAL = 30_000;   // check every 30s when healthy
const DEGRADED_INTERVAL = 10_000;  // check every 10s when degraded
const OFFLINE_INTERVAL = 5_000;    // check every 5s when offline

/**
 * Pings the Soroban RPC `getHealth` endpoint.
 * Returns true if the RPC is reachable and healthy.
 */
async function pingRpc(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.result?.status === 'healthy';
  } catch {
    return false;
  }
}

export function useNetworkStatus(): NetworkStatus {
  const [state, setState] = useState<NetworkState>('online');
  const [lastPing, setLastPing] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  const check = useCallback(async () => {
    const ok = await pingRpc();
    if (!mountedRef.current) return;
    if (ok) {
      setState('online');
      setLastPing(Date.now());
      setFailures(0);
    } else {
      setFailures(prev => {
        const next = prev + 1;
        // 1 failure = degraded, 3+ = offline
        setState(next >= 3 ? 'offline' : 'degraded');
        return next;
      });
    }
  }, []);

  // Schedule recurring checks with adaptive interval
  useEffect(() => {
    mountedRef.current = true;
    const schedule = () => {
      const interval =
        state === 'offline' ? OFFLINE_INTERVAL :
        state === 'degraded' ? DEGRADED_INTERVAL :
        HEALTHY_INTERVAL;
      intervalRef.current = setTimeout(async () => {
        await check();
        if (mountedRef.current) schedule();
      }, interval);
    };
    // Initial check
    check().then(() => { if (mountedRef.current) schedule(); });
    return () => {
      mountedRef.current = false;
      clearTimeout(intervalRef.current);
    };
  }, [state, check]);

  // Also listen to browser online/offline events
  useEffect(() => {
    const goOffline = () => { setState('offline'); setFailures(3); };
    const goOnline = () => { check(); };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [check]);

  const retry = useCallback(() => { check(); }, [check]);

  return { state, lastPing, retry, failures };
}
