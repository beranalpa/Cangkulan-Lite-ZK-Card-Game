import { useNetworkStatus, type NetworkState } from '@/hooks/useNetworkStatus';

// ═══════════════════════════════════════════════════════════════════════════════
//  Network Status Banner
//  Shows a sticky banner when the Soroban RPC is degraded or unreachable.
// ═══════════════════════════════════════════════════════════════════════════════

const MESSAGES: Record<Exclude<NetworkState, 'online'>, { icon: string; text: string; detail: string }> = {
  degraded: {
    icon: '⚡',
    text: 'RPC connection unstable',
    detail: 'Transactions may be slow. Retrying automatically…',
  },
  offline: {
    icon: '🔌',
    text: 'Network offline',
    detail: 'Cannot reach Soroban RPC. Check your connection.',
  },
};

export function NetworkStatusBanner() {
  const { state, retry, failures } = useNetworkStatus();

  if (state === 'online') return null;

  const msg = MESSAGES[state];

  return (
    <div
      role="alert"
      className={`
        fixed top-0 left-0 right-0 z-[70] flex items-center justify-center gap-3 px-4 py-2.5
        text-sm font-semibold backdrop-blur-md transition-all duration-300
        ${state === 'offline'
          ? 'bg-red-600/90 text-white'
          : 'bg-amber-500/90 text-amber-950'}
      `}
    >
      <span className="text-lg">{msg.icon}</span>
      <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2">
        <span>{msg.text}</span>
        <span className="text-xs opacity-80 font-normal">{msg.detail}</span>
      </div>
      <button
        onClick={retry}
        className={`
          ml-2 px-3 py-1 rounded-lg text-xs font-bold border transition-colors shrink-0
          ${state === 'offline'
            ? 'bg-white/20 border-white/30 text-white hover:bg-white/30'
            : 'bg-amber-900/20 border-amber-900/30 text-amber-950 hover:bg-amber-900/30'}
        `}
      >
        Retry ({failures})
      </button>
    </div>
  );
}
