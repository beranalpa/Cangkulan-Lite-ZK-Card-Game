import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, CreateMode, GamePhase } from './types';
import { DEFAULT_POINTS, POINTS_DECIMALS, LIFECYCLE } from './types';
import { CangkulanService } from './cangkulanService';
import { useWallet } from '@/hooks/useWallet';
import { requestCache, createCacheKey } from '@/utils/requestCache';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';
import { devWalletService, DevWalletService } from '@/services/devWalletService';
import { GameHistoryPanel } from './GameHistoryPanel';
import { QRInviteModal } from './QRCode';

interface CreatePhaseProps {
  sessionId: number;
  userAddress: string;
  availablePoints: bigint;
  service: CangkulanService;
  isBusy: boolean;
  loading: boolean;
  setLoading: (v: boolean) => void;
  quickstartLoading: boolean;
  setQuickstartLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
  setSuccess: (s: string | null) => void;
  setSessionId: (id: number) => void;
  setGameState: (gs: GameState | null) => void;
  setGamePhase: (gp: GamePhase) => void;
  setPlayer1Address: (addr: string) => void;
  addTx: (label: string, hash: string, addr: string, detail?: string) => void;
  onStandingsRefresh: () => void;
  createRandomSessionId: () => number;
  runAction: (action: () => Promise<void>) => Promise<void>;
  parsePoints: (value: string) => bigint | null;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStartTutorial?: () => void;
  autoQuickstart?: boolean;
}

function phaseFromLifecycle(state: number): GamePhase {
  switch (state) {
    case LIFECYCLE.SEED_COMMIT: return 'seed-commit';
    case LIFECYCLE.SEED_REVEAL: return 'seed-reveal';
    case LIFECYCLE.PLAYING: return 'playing';
    case LIFECYCLE.FINISHED: return 'complete';
    default: return 'seed-commit';
  }
}

export function CreatePhase({
  sessionId,
  userAddress,
  availablePoints,
  service,
  isBusy,
  loading,
  setLoading,
  quickstartLoading,
  setQuickstartLoading,
  setError,
  setSuccess,
  setSessionId,
  setGameState,
  setGamePhase,
  setPlayer1Address,
  addTx,
  onStandingsRefresh,
  createRandomSessionId,
  runAction,
  parsePoints,
  initialXDR,
  initialSessionId,
  onStartTutorial,
  autoQuickstart,
}: CreatePhaseProps) {
  const { getContractSigner, walletType } = useWallet();

  const [createMode, setCreateMode] = useState<CreateMode>('create');
  const [player1Address, setLocalPlayer1Address] = useState(userAddress);
  const [player1Points, setPlayer1Points] = useState(DEFAULT_POINTS);
  const [exportedAuthEntryXDR, setExportedAuthEntryXDR] = useState<string | null>(null);
  const [importAuthEntryXDR, setImportAuthEntryXDR] = useState('');
  const [importSessionId, setImportSessionId] = useState('');
  const [importPlayer1, setImportPlayer1] = useState('');
  const [importPlayer1Points, setImportPlayer1Points] = useState('');
  const [importPlayer2Points, setImportPlayer2Points] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');
  const [authEntryCopied, setAuthEntryCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [xdrParsing, setXdrParsing] = useState(false);
  const [xdrParseError, setXdrParseError] = useState<string | null>(null);
  const [xdrParseSuccess, setXdrParseSuccess] = useState(false);

  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const quickstartAvailable = walletType === 'dev'
    && DevWalletService.isDevModeAvailable()
    && DevWalletService.isPlayerAvailable(1)
    && DevWalletService.isPlayerAvailable(2);

  useEffect(() => {
    setLocalPlayer1Address(userAddress);
  }, [userAddress]);

  useEffect(() => {
    if (createMode === 'import' && !importPlayer2Points.trim()) setImportPlayer2Points(DEFAULT_POINTS);
  }, [createMode, importPlayer2Points]);

  // Cleanup auth poll on unmount or when mode changes away from 'create'
  useEffect(() => {
    if (createMode !== 'create' && authPollRef.current) {
      clearInterval(authPollRef.current);
      authPollRef.current = null;
    }
    return () => {
      if (authPollRef.current) { clearInterval(authPollRef.current); authPollRef.current = null; }
    };
  }, [createMode]);

  // Deep Link Handling
  useEffect(() => {
    if (initialXDR) {
      try {
        const parsed = service.parseAuthEntry(initialXDR);
        const sid = parsed.sessionId;
        service.getGame(sid)
          .then((game) => {
            if (game) {
              setGameState(game);
              setGamePhase(phaseFromLifecycle(game.lifecycle_state));
              setSessionId(sid);
            } else {
              setCreateMode('import');
              setImportAuthEntryXDR(initialXDR);
              setImportSessionId(sid.toString());
              setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('0.1');
            }
          })
          .catch(() => {
            setCreateMode('import');
            setImportAuthEntryXDR(initialXDR);
            setImportPlayer2Points('0.1');
          });
      } catch {
        setCreateMode('import');
        setImportAuthEntryXDR(initialXDR);
        setImportPlayer2Points('0.1');
      }
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const authEntry = urlParams.get('auth');
    const urlSessionId = urlParams.get('session-id');
    if (authEntry || urlSessionId) window.history.replaceState({}, '', window.location.pathname + window.location.hash);

    if (authEntry) {
      try {
        const parsed = service.parseAuthEntry(authEntry);
        const sid = parsed.sessionId;
        service.getGame(sid)
          .then((game) => {
            if (game) {
              setGameState(game); setGamePhase(phaseFromLifecycle(game.lifecycle_state)); setSessionId(sid);
            } else {
              setCreateMode('import'); setImportAuthEntryXDR(authEntry);
              setImportSessionId(sid.toString()); setImportPlayer1(parsed.player1);
              setImportPlayer1Points((Number(parsed.player1Points) / 10_000_000).toString());
              setImportPlayer2Points('0.1');
            }
          }).catch(() => { setCreateMode('import'); setImportAuthEntryXDR(authEntry); setImportPlayer2Points('0.1'); });
      } catch { setCreateMode('import'); setImportAuthEntryXDR(authEntry); setImportPlayer2Points('0.1'); }
    } else if (urlSessionId) {
      setCreateMode('load'); setLoadSessionId(urlSessionId);
    } else if (initialSessionId !== null && initialSessionId !== undefined) {
      setCreateMode('load'); setLoadSessionId(initialSessionId.toString());
    }
  }, [initialXDR, initialSessionId]);

  // Auto-parse Auth Entry XDR
  useEffect(() => {
    if (createMode !== 'import' || !importAuthEntryXDR.trim()) {
      if (!importAuthEntryXDR.trim()) {
        setXdrParsing(false); setXdrParseError(null); setXdrParseSuccess(false);
        setImportSessionId(''); setImportPlayer1(''); setImportPlayer1Points('');
      }
      return;
    }
    const parseXDR = async () => {
      setXdrParsing(true); setXdrParseError(null); setXdrParseSuccess(false);
      try {
        const gameParams = service.parseAuthEntry(importAuthEntryXDR.trim());
        if (gameParams.player1 === userAddress) throw new Error('You cannot play against yourself.');
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());
        setXdrParseSuccess(true);
      } catch (err) {
        setXdrParseError(err instanceof Error ? err.message : 'Invalid auth entry XDR');
        setImportSessionId(''); setImportPlayer1(''); setImportPlayer1Points('');
      } finally { setXdrParsing(false); }
    };
    const timeoutId = setTimeout(parseXDR, 500);
    return () => clearTimeout(timeoutId);
  }, [importAuthEntryXDR, createMode, userAddress]);

  // Handlers
  const handlePrepareTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const p1Points = parsePoints(player1Points);
        if (!p1Points || p1Points <= 0n) throw new Error('Enter a valid points amount');
        const signer = getContractSigner();
        const placeholderP2 = await getFundedSimulationSourceAddress([player1Address, userAddress]);
        const authEntryXDR = await service.prepareStartGame(sessionId, player1Address, placeholderP2, p1Points, p1Points, signer);
        setExportedAuthEntryXDR(authEntryXDR);
        setSuccess('Auth entry signed! Copy or share URL below and send to Player 2.');
        if (authPollRef.current) clearInterval(authPollRef.current);
        const pollInterval = setInterval(async () => {
          try {
            const game = await service.getGame(sessionId);
            if (game) {
              clearInterval(pollInterval);
              authPollRef.current = null;
              setGameState(game); setExportedAuthEntryXDR(null);
              setSuccess('Game created! Player 2 has signed and submitted.');
              setGamePhase(phaseFromLifecycle(game.lifecycle_state));
              onStandingsRefresh();
              setTimeout(() => setSuccess(null), 2000);
            }
          } catch { /* keep polling */ }
        }, 3000);
        authPollRef.current = pollInterval;
        setTimeout(() => {
          clearInterval(pollInterval);
          authPollRef.current = null;
          // Inform user that polling timed out
          setError('Timed out waiting for Player 2 to sign. You can share the URL again or create a new game.');
        }, 300000);
      } catch (err) {
        setError(CangkulanService.formatError(err));
      } finally { setLoading(false); }
    });
  };

  const handleQuickStart = async () => {
    await runAction(async () => {
      try {
        setQuickstartLoading(true); setError(null); setSuccess(null);
        if (walletType !== 'dev') throw new Error('Quickstart only works with dev wallets.');
        if (!DevWalletService.isDevModeAvailable() || !DevWalletService.isPlayerAvailable(1) || !DevWalletService.isPlayerAvailable(2))
          throw new Error('Quickstart requires both dev wallets. Run "bun run setup".');
        const p1Points = parsePoints(player1Points);
        if (!p1Points || p1Points <= 0n) throw new Error('Enter a valid points amount');

        const originalPlayer = devWalletService.getCurrentPlayer();
        let p1Addr = '', p2Addr = '';
        let p1Signer: ReturnType<typeof devWalletService.getSigner> | null = null;
        let p2Signer: ReturnType<typeof devWalletService.getSigner> | null = null;
        try {
          await devWalletService.initPlayer(1); p1Addr = devWalletService.getPublicKey(); p1Signer = devWalletService.getSigner();
          await devWalletService.initPlayer(2); p2Addr = devWalletService.getPublicKey(); p2Signer = devWalletService.getSigner();
        } finally { if (originalPlayer) await devWalletService.initPlayer(originalPlayer); }
        if (!p1Signer || !p2Signer) throw new Error('Failed to initialize dev wallet signers.');
        if (p1Addr === p2Addr) throw new Error('Quickstart requires two different dev wallets.');

        const qsSessionId = createRandomSessionId();
        setSessionId(qsSessionId); setPlayer1Address(p1Addr); setCreateMode('create'); setExportedAuthEntryXDR(null);
        const startResult = await service.startGameDirect(qsSessionId, p1Addr, p2Addr, p1Points, p1Points, p1Signer, p2Signer);
        if (startResult.txHash) addTx('Start Game', startResult.txHash, p1Addr, `Session #${qsSessionId}`);

        try { const game = await service.getGame(qsSessionId); setGameState(game); } catch { /* ignore */ }
        setGamePhase('seed-commit'); onStandingsRefresh();
        setSuccess('Quickstart complete! Game is ready — commit your seed.');
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        setError(CangkulanService.formatError(err));
      } finally { setQuickstartLoading(false); }
    });
  };

  const autoQuickstarted = useRef(false);
  useEffect(() => {
    if (autoQuickstart && quickstartAvailable && !autoQuickstarted.current) {
      autoQuickstarted.current = true;
      handleQuickStart();
    }
  }, [autoQuickstart, quickstartAvailable, handleQuickStart]);

  const handleImportTransaction = async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        if (!importAuthEntryXDR.trim()) throw new Error('Enter auth entry XDR from Player 1');
        if (!importPlayer2Points.trim()) throw new Error('Enter your points amount (Player 2)');
        const p2Points = parsePoints(importPlayer2Points);
        if (!p2Points || p2Points <= 0n) throw new Error('Invalid Player 2 points');
        const gameParams = service.parseAuthEntry(importAuthEntryXDR.trim());
        setImportSessionId(gameParams.sessionId.toString());
        setImportPlayer1(gameParams.player1);
        setImportPlayer1Points((Number(gameParams.player1Points) / 10_000_000).toString());
        if (gameParams.player1 === userAddress) throw new Error('You cannot play against yourself');
        const signer = getContractSigner();
        const fullySignedTxXDR = await service.importAndSignAuthEntry(importAuthEntryXDR.trim(), userAddress, p2Points, signer);
        const startResult = await service.finalizeStartGame(fullySignedTxXDR, userAddress, signer);
        if (startResult.txHash) addTx('Start Game', startResult.txHash, userAddress, `Session #${gameParams.sessionId}`);
        setSessionId(gameParams.sessionId); setSuccess('Game created successfully!');
        setGamePhase('seed-commit');
        setImportAuthEntryXDR(''); setImportSessionId(''); setImportPlayer1('');
        setImportPlayer1Points(''); setImportPlayer2Points(DEFAULT_POINTS);
        onStandingsRefresh();
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        setError(CangkulanService.formatError(err));
      } finally { setLoading(false); }
    });
  };

  const handleLoadExistingGame = async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const parsedSessionId = parseInt(loadSessionId.trim());
        if (isNaN(parsedSessionId) || parsedSessionId <= 0) throw new Error('Enter a valid session ID');
        const game = await requestCache.dedupe(
          createCacheKey('game-state', parsedSessionId),
          () => service.getGame(parsedSessionId), 5000,
        );
        if (!game) throw new Error('Game not found');
        if (game.player1 !== userAddress && game.player2 !== userAddress) throw new Error('You are not a player in this game');
        setSessionId(parsedSessionId); setGameState(game); setLoadSessionId('');
        const phase = phaseFromLifecycle(game.lifecycle_state);
        setGamePhase(phase);
        setSuccess(phase === 'complete' ? 'Game loaded (already completed).' : 'Game loaded!');
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        setError(CangkulanService.formatError(err));
      } finally { setLoading(false); }
    });
  };

  const copyAuthEntryToClipboard = async () => {
    if (exportedAuthEntryXDR) {
      try {
        await navigator.clipboard.writeText(exportedAuthEntryXDR);
        setAuthEntryCopied(true); setTimeout(() => setAuthEntryCopied(false), 2000);
      } catch { setError('Failed to copy to clipboard'); }
    }
  };

  const copyShareGameUrlWithAuthEntry = async () => {
    if (exportedAuthEntryXDR) {
      try {
        const params = new URLSearchParams({ game: 'cangkulan', auth: exportedAuthEntryXDR });
        await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?${params.toString()}`);
        setShareUrlCopied(true); setTimeout(() => setShareUrlCopied(false), 2000);
      } catch { setError('Failed to copy to clipboard'); }
    }
  };

  const copyShareGameUrlWithSessionId = async () => {
    if (loadSessionId) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?game=cangkulan&session-id=${loadSessionId}#/game/${loadSessionId}`);
        setShareUrlCopied(true); setTimeout(() => setShareUrlCopied(false), 2000);
      } catch { setError('Failed to copy to clipboard'); }
    }
  };

  return (
    <div className="space-y-6">
      {/* Mode Toggle */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 p-2 bg-gray-100 rounded-xl">
        <button onClick={() => { setCreateMode('create'); setExportedAuthEntryXDR(null); setImportAuthEntryXDR(''); setLoadSessionId(''); }}
          className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${createMode === 'create' ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          Create & Export
        </button>
        <button onClick={() => { setCreateMode('import'); setExportedAuthEntryXDR(null); setLoadSessionId(''); }}
          className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${createMode === 'import' ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          Import Auth Entry
        </button>
        <button onClick={() => { setCreateMode('load'); setExportedAuthEntryXDR(null); setImportAuthEntryXDR(''); }}
          className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${createMode === 'load' ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          Load Existing Game
        </button>
      </div>

      {/* Quickstart — only visible in dev mode */}
      {walletType === 'dev' && (
        <div className="p-4 bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-200 rounded-xl">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-yellow-900">⚡ Quickstart (Dev)</p>
              <p className="text-xs font-semibold text-yellow-800">Creates and signs for both dev wallets in one click.</p>
            </div>
            <button onClick={handleQuickStart} disabled={isBusy || !quickstartAvailable}
              className="px-4 py-3 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-md">
              {quickstartLoading ? 'Quickstarting...' : '⚡ Quickstart Game'}
            </button>
          </div>
        </div>
      )}

      {/* CREATE MODE */}
      {createMode === 'create' && (
        <div className="space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Your Address</label>
              <input type="text" value={player1Address}
                onChange={walletType === 'dev' ? (e) => { setLocalPlayer1Address(e.target.value.trim()); setPlayer1Address(e.target.value.trim()); } : undefined}
                readOnly={walletType !== 'dev'}
                placeholder="G..." className={`w-full px-4 py-3 rounded-xl border-2 focus:outline-none text-sm font-medium text-gray-700 ${walletType !== 'dev' ? 'bg-gray-50 border-gray-200 cursor-not-allowed' : 'bg-white border-gray-200 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100'}`} />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Bet Amount (Points)</label>
              <input type="text" value={player1Points} onChange={(e) => setPlayer1Points(e.target.value)} placeholder="0.1"
                className="w-full px-4 py-3 rounded-xl bg-white border-2 border-gray-200 focus:outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 text-sm font-medium" />
              <p className="text-xs font-semibold text-gray-600 mt-1">Available: {(Number(availablePoints) / 10000000).toFixed(2)} Points</p>
            </div>
            <div className="p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
              <p className="text-xs font-semibold text-blue-800">ℹ️ Player 2 will specify their own address and points when they import your auth entry.</p>
            </div>
          </div>
          <div className="pt-4 border-t-2 border-gray-100 space-y-4">
            <p className="text-xs font-semibold text-gray-600">Session ID: {sessionId}</p>
            {!exportedAuthEntryXDR ? (
              <button onClick={handlePrepareTransaction} disabled={isBusy}
                className="w-full py-4 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg">
                {loading ? 'Preparing...' : 'Prepare & Export Auth Entry'}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                  <p className="text-xs font-bold uppercase tracking-wide text-green-700 mb-2">Auth Entry XDR (Player 1 Signed)</p>
                  <div className="bg-white p-3 rounded-lg border border-green-200 mb-3 max-h-24 overflow-auto">
                    <code className="text-xs font-mono text-gray-700 break-all">{exportedAuthEntryXDR}</code>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <button onClick={copyAuthEntryToClipboard}
                      className="py-3 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold text-sm transition-all shadow-md">
                      {authEntryCopied ? '✓ Copied!' : '📋 Copy Auth Entry'}
                    </button>
                    <button onClick={copyShareGameUrlWithAuthEntry}
                      className="py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-bold text-sm transition-all shadow-md">
                      {shareUrlCopied ? '✓ Copied!' : '🔗 Share URL'}
                    </button>
                    <button onClick={() => setShowQRModal(true)}
                      className="py-3 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold text-sm transition-all shadow-md">
                      📱 QR Invite
                    </button>
                  </div>
                  {showQRModal && exportedAuthEntryXDR && (
                    <QRInviteModal
                      url={`${window.location.origin}${window.location.pathname}?game=cangkulan&auth=${encodeURIComponent(exportedAuthEntryXDR)}`}
                      onClose={() => setShowQRModal(false)}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* IMPORT MODE */}
      {createMode === 'import' && (
        <div className="space-y-4">
          <div className="p-4 bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
            <p className="text-sm font-semibold text-blue-800 mb-2">📥 Import Auth Entry from Player 1</p>
            <p className="text-xs text-gray-700 mb-4">Paste the auth entry XDR. Session ID and Player 1 info will be auto-extracted.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1 flex items-center gap-2">
                  Auth Entry XDR
                  {xdrParsing && <span className="text-blue-500 text-xs animate-pulse">Parsing...</span>}
                  {xdrParseSuccess && <span className="text-green-600 text-xs">✓ Parsed</span>}
                  {xdrParseError && <span className="text-red-600 text-xs">✗ Failed</span>}
                </label>
                <textarea value={importAuthEntryXDR} onChange={(e) => setImportAuthEntryXDR(e.target.value)}
                  placeholder="Paste auth entry XDR here..." rows={3}
                  className={`w-full px-4 py-3 rounded-xl bg-white border-2 focus:outline-none focus:ring-4 text-xs font-mono resize-none transition-colors ${xdrParseError ? 'border-red-300 focus:border-red-400 focus:ring-red-100' : xdrParseSuccess ? 'border-green-300 focus:border-green-400 focus:ring-green-100' : 'border-blue-200 focus:border-blue-400 focus:ring-blue-100'}`} />
                {xdrParseError && <p className="text-xs text-red-600 font-semibold mt-1">{xdrParseError}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">Session ID</label>
                  <input type="text" value={importSessionId} readOnly placeholder="Auto-filled"
                    className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">P1 Points</label>
                  <input type="text" value={importPlayer1Points} readOnly placeholder="Auto-filled"
                    className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs text-gray-600 cursor-not-allowed" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Player 1 Address</label>
                <input type="text" value={importPlayer1} readOnly placeholder="Auto-filled"
                  className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">Player 2 (You)</label>
                  <input type="text" value={userAddress} readOnly
                    className="w-full px-4 py-2 rounded-xl bg-gray-50 border-2 border-gray-200 text-xs font-mono text-gray-600 cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">Your Points *</label>
                  <input type="text" value={importPlayer2Points} onChange={(e) => setImportPlayer2Points(e.target.value)} placeholder="0.1"
                    className="w-full px-4 py-2 rounded-xl bg-white border-2 border-blue-200 focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 text-xs" />
                </div>
              </div>
            </div>
          </div>
          <button onClick={handleImportTransaction} disabled={isBusy || !importAuthEntryXDR.trim() || !importPlayer2Points.trim()}
            className="w-full py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500 hover:from-blue-600 hover:via-cyan-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl">
            {loading ? 'Importing & Signing...' : 'Import & Sign Auth Entry'}
          </button>
        </div>
      )}

      {/* LOAD MODE */}
      {createMode === 'load' && (
        <div className="space-y-4">
          <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
            <p className="text-sm font-semibold text-green-800 mb-2">🎮 Load Existing Game</p>
            <p className="text-xs text-gray-700 mb-4">Enter a session ID to load and continue an existing game.</p>
            <input type="text" value={loadSessionId} onChange={(e) => setLoadSessionId(e.target.value)}
              placeholder="Enter session ID" className="w-full px-4 py-3 rounded-xl bg-white border-2 border-green-200 focus:outline-none focus:border-green-400 focus:ring-4 focus:ring-green-100 text-sm font-mono" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button onClick={handleLoadExistingGame} disabled={isBusy || !loadSessionId.trim()}
              className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl">
              {loading ? 'Loading...' : '🎮 Load Game'}
            </button>
            <button onClick={copyShareGameUrlWithSessionId} disabled={!loadSessionId.trim()}
              className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl">
              {shareUrlCopied ? '✓ Copied!' : '🔗 Share Game'}
            </button>
          </div>
        </div>
      )}

      {/* Game History */}
      <GameHistoryPanel onLoadGame={(sid) => {
        setCreateMode('load');
        setLoadSessionId(sid.toString());
      }} />

      {/* Tutorial CTA */}
      {onStartTutorial && (
        <div className="p-4 bg-gradient-to-r from-yellow-50 to-amber-50 border-2 border-amber-200 rounded-xl">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-amber-800">🎓 New to Cangkulan?</p>
              <p className="text-xs text-gray-600">Play vs a Bot to learn the rules before betting real points!</p>
            </div>
            <button onClick={onStartTutorial}
              className="px-4 py-2.5 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 transition-all shadow-md">
              🎓 Play Tutorial
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
