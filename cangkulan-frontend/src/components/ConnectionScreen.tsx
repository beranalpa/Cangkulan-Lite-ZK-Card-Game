import { useState } from 'react';
import { useWallet } from '../hooks/useWallet';
import './ConnectionScreen.css';

/**
 * ConnectionModal — wallet chooser overlay.
 * Can be opened from anywhere (Play Game, Game Lobby, etc.)
 * when a wallet connection is required.
 */
interface ConnectionModalProps {
  /** Called when user successfully connects or dismisses the modal */
  onClose: () => void;
}

export function ConnectionModal({ onClose }: ConnectionModalProps) {
  const {
    connectWallet,
    connectDev,
    isConnecting,
    error,
    isDevModeAvailable,
    isConnected,
  } = useWallet();

  const [connectError, setConnectError] = useState<string | null>(null);
  const devAvailable = isDevModeAvailable();

  const handleConnectWallet = async () => {
    try {
      setConnectError(null);
      await connectWallet();
      // Auto-close on success
      onClose();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Failed to connect wallet'
      );
    }
  };

  const handleDev = async (player: 1 | 2) => {
    try {
      setConnectError(null);
      await connectDev(player);
      onClose();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Failed to connect dev wallet'
      );
    }
  };

  // Auto-close if already connected (e.g. wallet connected externally)
  if (isConnected) {
    onClose();
    return null;
  }

  const displayError = connectError || error;

  return (
    <div className="connection-overlay" onClick={onClose}>
      <div className="connection-card" onClick={e => e.stopPropagation()}>
        {/* Close button — top-right ✕ */}
        <button className="connection-close" onClick={onClose} title="Close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>

        {/* Hero branding */}
        <div className="connection-hero">
          <img
            src="/cangkulan-logo.png"
            alt="Cangkulan Lite"
            className="connection-logo"
          />
        </div>

        {/* Header */}
        <div className="connection-header">
          <h2 className="connection-title">Connect Wallet</h2>
          <p className="connection-subtitle">
            Choose how you want to play
          </p>
        </div>

        {/* Error */}
        {displayError && (
          <div className="connection-error">
            <span>⚠️</span> {displayError}
          </div>
        )}

        {/* Connect Wallet — opens Stellar Wallets Kit modal */}
        <button
          className="connection-option connection-option-primary"
          onClick={handleConnectWallet}
          disabled={isConnecting}
        >
          <div className="connection-option-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="connection-option-text">
            <span className="connection-option-label">Connect Wallet</span>
            <span className="connection-option-desc">
              Freighter, HOT Wallet, Hana, Klever
            </span>
          </div>
          <span className="connection-option-badge">Public</span>
        </button>

        {/* Divider */}
        <div className="connection-divider">
          <span>or</span>
        </div>

        {/* Dev Mode Option */}
        {devAvailable ? (
          <div className="connection-dev-section">
            <p className="connection-dev-label">🛠 Dev Mode (Testing)</p>
            <div className="connection-dev-buttons">
              <button
                className="connection-option connection-option-dev"
                onClick={() => handleDev(1)}
                disabled={isConnecting}
              >
                <span className="connection-option-label">Player 1</span>
                <span className="connection-option-desc">Dev wallet</span>
              </button>
              <button
                className="connection-option connection-option-dev"
                onClick={() => handleDev(2)}
                disabled={isConnecting}
              >
                <span className="connection-option-label">Player 2</span>
                <span className="connection-option-desc">Dev wallet</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="connection-dev-unavailable">
            <p>
              <span style={{ opacity: 0.5 }}>🛠</span> Dev mode unavailable —{' '}
              <code>bun run setup</code> to enable
            </p>
          </div>
        )}

        {/* Loading overlay */}
        {isConnecting && (
          <div className="connection-loading">
            <div className="connection-spinner" />
            <span>Connecting…</span>
          </div>
        )}

        {/* Wallet install hint */}
        <div className="connection-hint">
          <p>
            New to Stellar?{' '}
            <a
              href="https://freighter.app"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get Freighter ↗
            </a>
            {' · '}
            <a
              href="https://hot-labs.org"
              target="_blank"
              rel="noopener noreferrer"
            >
              HOT Wallet ↗
            </a>
            {' · '}
            <a
              href="https://hanawallet.io"
              target="_blank"
              rel="noopener noreferrer"
            >
              Hana ↗
            </a>
            {' · '}
            <a
              href="https://klever.io"
              target="_blank"
              rel="noopener noreferrer"
            >
              Klever ↗
            </a>
          </p>
        </div>

        {/* Bottom close button — always reachable on mobile */}
        <button className="connection-close-bottom" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Legacy name alias — use ConnectionModal directly */
export const ConnectionScreen = ConnectionModal;
