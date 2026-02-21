import { useState, useEffect } from 'react';
import { WalletSwitcher } from './WalletSwitcher';
import { NavigationBar } from './NavigationBar';
import { CANGKULAN_CONTRACT, ZK_VERIFIER_CONTRACT, STELLAR_EXPERT_BASE } from '@/utils/constants';
import { isSoundMuted, toggleSoundMuted } from '@/games/cangkulan/soundHelpers';
import type { AppRoute } from '@/hooks/useHashRouter';
import './Layout.css';
import './NavigationBar.css';

const STELLAR_EXPERT = STELLAR_EXPERT_BASE;
const THEME_KEY = 'cangkulan-theme';

function getStoredTheme(): 'light' | 'dark' {
  try {
    return (localStorage.getItem(THEME_KEY) as 'dark') === 'dark' ? 'dark' : 'light';
  } catch { return 'light'; }
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

interface LayoutProps {
  children: React.ReactNode;
  currentPage?: AppRoute['page'];
  navigate?: (route: AppRoute) => void;
  isConnected?: boolean;
  activeSessionId?: number;
}

export function Layout({ children, currentPage, navigate, isConnected, activeSessionId }: LayoutProps) {
  const [muted, setMuted] = useState(() => isSoundMuted());
  const [theme, setTheme] = useState<'light' | 'dark'>(getStoredTheme);

  // Apply theme on mount and when changed
  useEffect(() => { applyTheme(theme); }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'light' ? 'dark' : 'light');

  return (
    <div className="studio">
      <div className="studio-background" aria-hidden="true">
        <div className="studio-orb orb-1" />
        <div className="studio-orb orb-2" />
        <div className="studio-orb orb-3" />
        <div className="studio-grid" />
      </div>

      {/* Unified Top Bar: Logo | Nav (centered) | Actions */}
      <header className="studio-topbar">
        <div className="topbar-inner">
          {/* Left: Brand logo */}
          <div className="topbar-brand">
            <img src="/cangkulan-logo.png" alt="Cangkulan Lite" className="topbar-logo" />
            <span className="topbar-brand-name">Cangkulan</span>
          </div>

          {/* Center: Navigation */}
          {navigate && currentPage && (
            <NavigationBar
              currentPage={currentPage}
              navigate={navigate}
              isConnected={isConnected ?? false}
              activeSessionId={activeSessionId}
            />
          )}

          {/* Right: toggles + wallet */}
          <div className="topbar-actions">
            <span className="topbar-network-badge">Testnet</span>
            <button
              onClick={toggleTheme}
              className="topbar-btn"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button
              onClick={() => { toggleSoundMuted(); setMuted(isSoundMuted()); }}
              className={`topbar-btn ${muted ? 'topbar-btn-muted' : 'topbar-btn-sound'}`}
              title={muted ? 'Unmute sounds' : 'Mute sounds'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <WalletSwitcher />
          </div>
        </div>
      </header>

      <main className="studio-main">{children}</main>

      <footer className="studio-footer">
        <div className="footer-inner">
          <span className="footer-text">Built with the Stellar Game Studio</span>
          <div className="footer-links">
            <a href={`${STELLAR_EXPERT}/${CANGKULAN_CONTRACT}`} target="_blank" rel="noopener noreferrer">
              Contract ↗
            </a>
            <span className="footer-dot">·</span>
            <a href={`${STELLAR_EXPERT}/${ZK_VERIFIER_CONTRACT}`} target="_blank" rel="noopener noreferrer">
              ZK Verifier ↗
            </a>
            <span className="footer-dot">·</span>
            <a href="https://github.com/beranalpa/Cangkulan-Lite-ZK-Card-Game" target="_blank" rel="noopener noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
