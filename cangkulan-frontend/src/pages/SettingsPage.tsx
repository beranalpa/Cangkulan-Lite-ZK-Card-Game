import { useState, useEffect } from 'react';
import { isSoundMuted, toggleSoundMuted } from '@/games/cangkulan/soundHelpers';
import { clearGameHistory, loadGameHistory } from '@/games/cangkulan/gameHistory';
import { clearActiveSession } from '@/hooks/useHashRouter';
import {
  getActiveCangkulanContract, getActiveZkVerifierContract,
  getActiveGameHubContract, getActiveLeaderboardContract,
  getActiveUltrahonkVerifierContract,
  getStellarExpertLink, isLocalNetwork, type StellarNetwork
} from '@/utils/constants';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionModal } from '@/components/ConnectionScreen';
import { useLocale, SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n';
import { PageHero } from '@/components/PageHero';
import type { AppRoute } from '@/hooks/useHashRouter';

// ═══════════════════════════════════════════════════════════════════════════════
//  Settings Page — sound, theme, data management, wallet info
//  Accessible via #/settings, persistent across refreshes
// ═══════════════════════════════════════════════════════════════════════════════

const THEME_KEY = 'cangkulan-theme';

function getTheme(): 'light' | 'dark' {
  try { return (localStorage.getItem(THEME_KEY) as 'dark') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

function setTheme(t: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch { }
}

interface SettingsPageProps {
  navigate: (route: AppRoute) => void;
}

export function SettingsPage({ navigate }: SettingsPageProps) {
  const { publicKey, walletType, isConnected, disconnect } = useWallet();
  const { locale, setLocale } = useLocale();
  const [muted, setMuted] = useState(() => isSoundMuted());
  const [theme, setThemeState] = useState<'light' | 'dark'>(getTheme);
  const [historyCount, setHistoryCount] = useState(() => loadGameHistory().length);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);

  const handleToggleSound = () => {
    toggleSoundMuted();
    setMuted(isSoundMuted());
  };

  const handleToggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const handleClearData = () => {
    clearGameHistory();
    clearActiveSession();
    // Clear seed/play commit/reactions data from both storages
    const gameKeyPrefixes = ['cangkulan-seed', 'cangkulan-play-commit', 'cangkulan-reactions'];
    const shouldClear = (key: string) => gameKeyPrefixes.some(p => key.startsWith(p));

    for (const storage of [localStorage, sessionStorage]) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && shouldClear(key)) keysToRemove.push(key);
      }
      keysToRemove.forEach(k => storage.removeItem(k));
    }
    setHistoryCount(0);
    setShowClearConfirm(false);
  };

  const handleDisconnect = () => {
    disconnect();
    setShowDisconnectConfirm(false);
    navigate({ page: 'home' });
  };

  const handleFactoryReset = () => {
    // Clear ALL cangkulan-related keys from both storages
    for (const storage of [localStorage, sessionStorage]) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith('cangkulan')) keysToRemove.push(key);
      }
      keysToRemove.forEach(k => storage.removeItem(k));
    }
    setShowResetConfirm(false);
    // Hard reload to ensure all in-memory state is cleared
    window.location.hash = '';
    window.location.reload();
  };

  const shortAddr = (addr: string) => addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)} ` : addr;

  return (
    <div className="space-y-6">
      {/* Hero Header */}
      <PageHero
        icon="⚙️"
        title="Settings"
        subtitle="Preferences and app management"
        gradient="from-slate-600 via-gray-700 to-zinc-800"
        navigate={navigate}
        backTo={{ page: 'home' }}
      />

      {/* Sound & Theme */}
      <div className="p-4 rounded-xl space-y-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--color-ink-muted)' }}>Preferences</h3>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>🔊 Sound Effects</div>
            <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>Card sounds, trick wins, game end</div>
          </div>
          <button onClick={handleToggleSound}
            className={`w-14 h-7 rounded-full transition-colors relative ${muted ? 'bg-gray-300 dark:bg-gray-600' : 'bg-emerald-500'}`}>
            <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-md transition-transform ${muted ? 'left-0.5' : 'left-7'}`} />
          </button>
        </div>

        <div style={{ borderTop: '1px solid var(--color-border)' }} />

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>{theme === 'dark' ? '🌙' : '☀️'} Theme</div>
            <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>Currently: {theme === 'dark' ? 'Dark' : 'Light'} mode</div>
          </div>
          <button onClick={handleToggleTheme}
            className={`w-14 h-7 rounded-full transition-colors relative ${theme === 'dark' ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-md transition-transform ${theme === 'dark' ? 'left-7' : 'left-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Language */}
      <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--color-ink-muted)' }}>🌐 Language / Bahasa</h3>
        <div className="flex gap-2">
          {SUPPORTED_LOCALES.map(l => (
            <button
              key={l.code}
              onClick={() => setLocale(l.code)}
              className={`flex items - center gap - 1.5 px - 4 py - 2 rounded - lg text - sm font - medium transition - all ${locale === l.code
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'hover:opacity-80'
                } `}
              style={locale !== l.code ? { background: 'var(--color-bg)', color: 'var(--color-ink)', border: '1px solid var(--color-border)' } : undefined}
            >
              <span>{l.flag}</span>
              <span>{l.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Wallet Info */}
      {isConnected && publicKey ? (
        <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--color-ink-muted)' }}>Wallet</h3>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
                {walletType === 'dev' ? '🛠️ Dev Wallet' : '💼 Connected Wallet'}
              </div>
              <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>{shortAddr(publicKey)}</div>
            </div>
            {!showDisconnectConfirm ? (
              <button onClick={() => setShowDisconnectConfirm(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors">
                Disconnect
              </button>
            ) : (
              <div className="flex gap-2">
                <button onClick={handleDisconnect}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500 hover:bg-red-600">
                  Confirm
                </button>
                <button onClick={() => setShowDisconnectConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: 'var(--color-bg)', color: 'var(--color-ink-muted)' }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-gradient-to-r from-amber-500/10 to-orange-500/10" style={{ border: '1px solid var(--color-border)' }}>
          <h3 className="text-sm font-semibold uppercase mb-2" style={{ color: 'var(--color-ink-muted)' }}>Wallet</h3>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>🔗 Not Connected</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>Connect to play games, view history, and use lobby features</div>
            </div>
            <button
              onClick={() => setShowWalletModal(true)}
              className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-amber-500 hover:bg-amber-600 transition-colors"
            >
              Connect
            </button>
          </div>
          {showWalletModal && <ConnectionModal onClose={() => setShowWalletModal(false)} />}
        </div>
      )}

      {/* Data Management */}
      <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--color-ink-muted)' }}>Data</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>🗂️ Local Data</div>
            <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              {historyCount} game{historyCount !== 1 ? 's' : ''} in history · Seeds & commits cached locally
            </div>
          </div>
          {!showClearConfirm ? (
            <button onClick={() => setShowClearConfirm(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors">
              🗑️ Clear
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleClearData}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500 hover:bg-red-600">
                Confirm
              </button>
              <button onClick={() => setShowClearConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: 'var(--color-bg)', color: 'var(--color-ink-muted)' }}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Factory Reset */}
      <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderColor: 'rgb(239 68 68 / 0.3)' }}>
        <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 uppercase">🔄 Factory Reset</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>Reset Everything</div>
            <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              Clear all data: wallet, game history, seeds, commits, preferences. App will reload fresh.
            </div>
          </div>
          {!showResetConfirm ? (
            <button onClick={() => setShowResetConfirm(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors whitespace-nowrap">
              ⚠️ Reset App
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleFactoryReset}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500 hover:bg-red-600 animate-pulse">
                Yes, Reset All
              </button>
              <button onClick={() => setShowResetConfirm(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: 'var(--color-bg)', color: 'var(--color-ink-muted)' }}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Contract Links */}
      <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--color-ink-muted)' }}>Contracts</h3>
        <div className="space-y-2">
          {[
            { icon: '🃏', label: 'Cangkulan Contract', id: getActiveCangkulanContract() },
            { icon: '🔒', label: 'ZK Verifier', id: getActiveZkVerifierContract() },
            { icon: '🌑', label: 'UltraHonk Verifier', id: getActiveUltrahonkVerifierContract() },
            { icon: '🏛️', label: 'Game Hub', id: getActiveGameHubContract() },
            { icon: '📊', label: 'Leaderboard', id: getActiveLeaderboardContract() },
          ].map(c => {
            const expertLink = getStellarExpertLink('contract', c.id);
            if (!expertLink) {
              return (
                <div key={c.label} className="flex items-center justify-between p-2.5 rounded-lg"
                  style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>{c.icon} {c.label}</div>
                    <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>{shortAddr(c.id)}</div>
                  </div>
                  <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Local</span>
                </div>
              );
            }
            return (
              <a key={c.label} href={expertLink} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between p-2.5 rounded-lg hover:shadow-md transition-all group"
                style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>{c.icon} {c.label}</div>
                  <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>{shortAddr(c.id)}</div>
                </div>
                <span style={{ color: 'var(--color-ink-muted)' }}>↗</span>
              </a>
            );
          })}
        </div>
      </div>

      {/* About */}
      <div className="p-4 rounded-xl text-center bg-gradient-to-br from-emerald-500/5 to-teal-500/5" style={{ border: '1px solid var(--color-border)' }}>
        <div className="text-2xl mb-2">🃏</div>
        <div className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>Cangkulan Lite</div>
        <div className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>Built with the Stellar Game Studio</div>
        <a href="https://github.com/beranalpa/Cangkulan-Lite-ZK-Card-Game" target="_blank" rel="noopener noreferrer"
          className="inline-block mt-2 text-xs font-bold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400">
          View on GitHub ↗
        </a>
      </div>
    </div>
  );
}
