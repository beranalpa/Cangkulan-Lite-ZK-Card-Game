import { useIntl } from 'react-intl';
import type { AppRoute } from '@/hooks/useHashRouter';

// ═══════════════════════════════════════════════════════════════════════════════
//  NavigationBar — icon-only navigation in the unified top bar.
//  Shows tooltip on hover with the page name. Compact and space-efficient.
// ═══════════════════════════════════════════════════════════════════════════════

interface NavItem {
  page: AppRoute['page'];
  labelId: string;
  icon: string;
  hideWhen?: 'disconnected';
}

const NAV_ITEMS: NavItem[] = [
  { page: 'home',     labelId: 'nav.home',     icon: '🏠' },
  { page: 'lobby',    labelId: 'nav.lobby',    icon: '🌐' },
  { page: 'leaderboard', labelId: 'nav.ranks', icon: '🏆' },
  { page: 'rules',    labelId: 'nav.rules',    icon: '📖' },
  { page: 'settings', labelId: 'nav.settings', icon: '⚙️' },
];

interface NavigationBarProps {
  currentPage: AppRoute['page'];
  navigate: (route: AppRoute) => void;
  isConnected: boolean;
  /** If there's an active game, show a "Game" tab */
  activeSessionId?: number;
}

export function NavigationBar({ currentPage, navigate, isConnected, activeSessionId }: NavigationBarProps) {
  const intl = useIntl();
  const items = NAV_ITEMS.filter(item => {
    if (item.hideWhen === 'disconnected' && !isConnected) return false;
    return true;
  });

  const isGameActive = currentPage === 'game' || currentPage === 'spectate';

  return (
    <nav className="navigation-bar">
      <div className="nav-inner">
        {items.map(item => {
          const isActive = currentPage === item.page;
          const label = intl.formatMessage({ id: item.labelId });
          return (
            <button
              key={item.page}
              onClick={() => {
                const route: AppRoute = item.page === 'game' && activeSessionId
                  ? { page: 'game', sessionId: activeSessionId }
                  : { page: item.page } as AppRoute;
                navigate(route);
              }}
              className={`nav-item ${isActive ? 'nav-item-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              aria-label={label}
              title={label}
            >
              <span className="nav-icon">{item.icon}</span>
            </button>
          );
        })}

        {/* Dynamic "Game" tab when playing */}
        {activeSessionId && (
          <button
            onClick={() => navigate({ page: 'game', sessionId: activeSessionId })}
            className={`nav-item ${isGameActive ? 'nav-item-active' : ''} nav-item-game`}
            aria-current={isGameActive ? 'page' : undefined}
            title={intl.formatMessage({ id: 'nav.game' })}
          >
            <span className="nav-icon">🎮</span>
            {!isGameActive && <span className="nav-badge" />}
          </button>
        )}
      </div>
    </nav>
  );
}
