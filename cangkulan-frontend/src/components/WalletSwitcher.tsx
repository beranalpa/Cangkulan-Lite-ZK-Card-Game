import { useState, useRef, useEffect } from 'react';
import { useWallet } from '../hooks/useWallet';
import { ConnectionModal } from './ConnectionScreen';
import { log } from '@/utils/logger';
import './WalletSwitcher.css';

export function WalletSwitcher() {
  const {
    publicKey,
    isConnected,
    isConnecting,
    walletType,
    walletIcon,
    balanceXlm,
    error,
    connectDev,
    switchPlayer,
    disconnect,
    fundTestnet,
    getCurrentDevPlayer,
    getConnectedWalletName,
    isDevModeAvailable,
  } = useWallet();

  const [open, setOpen] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [funding, setFunding] = useState(false);
  const [fundResult, setFundResult] = useState<'success' | 'fail' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const currentPlayer = getCurrentDevPlayer();

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset fund result after 3s
  useEffect(() => {
    if (!fundResult) return;
    const t = setTimeout(() => setFundResult(null), 3000);
    return () => clearTimeout(t);
  }, [fundResult]);

  const handleSwitch = async () => {
    if (walletType !== 'dev') return;
    const nextPlayer = currentPlayer === 1 ? 2 : 1;
    try {
      await switchPlayer(nextPlayer);
      setOpen(false);
    } catch (err) {
      log.error('Failed to switch player:', err);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      setOpen(false);
    } catch (err) {
      log.error('Failed to disconnect:', err);
    }
  };

  const handleCopy = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = publicKey;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleFund = async () => {
    setFunding(true);
    setFundResult(null);
    const ok = await fundTestnet();
    setFundResult(ok ? 'success' : 'fail');
    setFunding(false);
  };

  // Not connected — show "Connect" button
  if (!isConnected) {
    return (
      <>
        <button
          className="wallet-connect-btn"
          onClick={() => setShowConnectModal(true)}
          disabled={isConnecting}
        >
          {isConnecting ? '…' : 'Connect'}
        </button>
        {showConnectModal && (
          <ConnectionModal onClose={() => setShowConnectModal(false)} />
        )}
      </>
    );
  }

  const shortAddr = publicKey ? `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}` : '';
  const walletLabel = getConnectedWalletName();
  const explorerUrl = publicKey
    ? `https://stellar.expert/explorer/testnet/account/${publicKey}`
    : null;

  return (
    <div className="wallet-chip-wrapper" ref={dropdownRef}>
      {/* Compact chip: icon + short address + balance */}
      <button className="wallet-chip" onClick={() => setOpen(o => !o)}>
        {walletIcon ? (
          <img src={walletIcon} alt="" className="wallet-chip-icon" />
        ) : (
          <span className="wallet-dot" />
        )}
        <span className="wallet-short-addr">{shortAddr}</span>
        {balanceXlm && (
          <span className="wallet-balance-chip">{balanceXlm} XLM</span>
        )}
        <span className="wallet-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="wallet-dropdown">
          {error && (
            <div className="wallet-dropdown-error">{error}</div>
          )}

          <div className="wallet-dropdown-header">
            <div className="wallet-dropdown-label-row">
              {walletIcon && (
                <img src={walletIcon} alt="" className="wallet-dropdown-icon" />
              )}
              <span className="wallet-dropdown-label">{walletLabel}</span>
            </div>
            <div className="wallet-dropdown-addr-row">
              <div className="wallet-dropdown-addr">{publicKey}</div>
              <button
                className="wallet-copy-btn"
                onClick={handleCopy}
                title="Copy address"
              >
                {copied ? '✓' : '⎘'}
              </button>
            </div>
          </div>

          {/* Balance row */}
          {balanceXlm !== null && (
            <div className="wallet-dropdown-balance">
              <span className="wallet-dropdown-balance-label">Balance</span>
              <span className="wallet-dropdown-balance-value">{balanceXlm} XLM</span>
            </div>
          )}

          {/* Quick actions */}
          <div className="wallet-dropdown-links">
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="wallet-dropdown-link">
                View on Explorer ↗
              </a>
            )}
            <button
              className="wallet-dropdown-link wallet-fund-btn"
              onClick={handleFund}
              disabled={funding}
            >
              {funding ? 'Funding…' : fundResult === 'success' ? '✓ Funded!' : fundResult === 'fail' ? '✗ Failed' : '💧 Fund Testnet XLM'}
            </button>
          </div>

          <div className="wallet-dropdown-actions">
            {walletType === 'dev' && (
              <button onClick={handleSwitch} className="wallet-dropdown-btn wallet-dropdown-switch">
                Switch to P{currentPlayer === 1 ? 2 : 1}
              </button>
            )}
            <button onClick={handleDisconnect} className="wallet-dropdown-btn wallet-dropdown-disconnect">
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
