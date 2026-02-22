import { useState, useRef, useCallback, useEffect } from 'react';
import { Buffer } from 'buffer';
import { CangkulanService } from './cangkulanService';
import type { GameState, TrickRecord, ProofMode, GameMode } from './types';
import { LIFECYCLE, TRICK, OUTCOME, CANNOT_FOLLOW_SENTINEL } from './types';
import { cardLabel } from './cardHelpers';
import { log } from '@/utils/logger';
import {
  generateSeed,
  computeInnerSeedHash,
  computePedersenCommitHash,
  buildPedersenProof,
  computeNizkCommitment,
  buildNizkProof,
  computePlayCommitHash,
  computeCardPlayZkCommitHash,
  buildCardPlayRingProof,
  computeCangkulZkCommitHash,
  buildCangkulZkProof,
  computeCangkulRevealSalt,
  generatePlaySalt,
  computeBlake2sSeedHash,
  computeNoirCommitHash,
} from './cryptoHelpers';
import { saveSeedData, loadSeedData, clearSeedData } from './seedStorage';
import { savePlayCommit, loadPlayCommit, clearPlayCommit } from './playCommitStorage';
import { useNetworkStore } from '@/store/networkStore';
import { playSound } from './soundHelpers';
// noirProver is loaded lazily via dynamic import() to avoid pulling the
// 3.6 MB @aztec/bb.js bundle into the initial download.  It is only
// needed when the user selects the "Noir" ZK proof mode.

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface CangkulanActionsConfig {
  service: CangkulanService;
  sessionId: number;
  userAddress: string;
  isPlayer1: boolean;
  isPlayer2: boolean;
  gameState: GameState | null;
  getContractSigner: () => Pick<import('@stellar/stellar-sdk').contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>;
  addTx: (label: string, hash: string, address: string, detail?: string) => void;
  loadGameStateAndNudge: () => Promise<void>;
  onStandingsRefresh: () => void;
  /** Game mode — controls default ZK proof mode selection */
  gameMode?: GameMode;
}

export interface CangkulanActions {
  // State
  loading: boolean;
  isBusy: boolean;
  error: string | null;
  success: string | null;
  shuffleData: number[] | null;
  shuffleLoading: boolean;
  proofMode: ProofMode;
  noirProofProgress: string | null;
  autoCommitStatus: string | null;
  /** Ref to the last action that was attempted (for retry on failure) */
  lastActionRef: React.RefObject<(() => Promise<void>) | null>;

  // State setters (for external use, e.g. quickstart loading)
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  setSuccess: (v: string | null) => void;
  setProofMode: (mode: ProofMode) => void;

  // Actions
  handleCommitSeed: () => Promise<void>;
  handleRevealSeed: () => Promise<void>;
  handleCommitPlay: (cardId: number) => Promise<void>;
  handleRevealPlay: () => Promise<void>;
  handleTickTimeout: () => Promise<void>;
  handleResolveTimeout: () => Promise<void>;
  handleForfeit: () => Promise<void>;
  handleVerifyShuffle: () => Promise<void>;
  runAction: (action: () => Promise<void>) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useCangkulanActions(config: CangkulanActionsConfig): CangkulanActions {
  const {
    service,
    sessionId,
    userAddress,
    isPlayer1,
    isPlayer2,
    gameState,
    getContractSigner,
    addTx,
    loadGameStateAndNudge,
    onStandingsRefresh,
    gameMode = 'multiplayer',
  } = config;

  // Default proof mode depends on game mode:
  // - AI: NIZK (fast, 64 bytes, minimal on-chain cost)
  // - Multiplayer: Pedersen (BLS12-381 EC commitment, production default)
  // - Dev: Pedersen (can be changed via full toggle — NIZK, Pedersen, Noir)
  const defaultProofMode: ProofMode = gameMode === 'ai' ? 'nizk' : 'pedersen';

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [shuffleData, setShuffleData] = useState<number[] | null>(null);
  const [shuffleLoading, setShuffleLoading] = useState(false);
  const [proofMode, setProofMode] = useState<ProofMode>(defaultProofMode);
  const [noirProofProgress, setNoirProofProgress] = useState<string | null>(null);
  const [autoCommitStatus, setAutoCommitStatus] = useState<string | null>(null);

  const actionLock = useRef(false);
  const lastActionRef = useRef<(() => Promise<void>) | null>(null);

  const isBusy = loading;

  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (actionLock.current || loading) return;
    actionLock.current = true;
    lastActionRef.current = action;
    try { await action(); } finally { actionLock.current = false; }
  }, [loading]);

  // ─── Commit Seed ──────────────────────────────────────────────────────────

  const handleCommitSeed = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const seed = generateSeed();
        const blinding = generateSeed();

        let commitHash: Buffer;
        if (proofMode === 'noir') {
          // Noir mode: commit_hash = keccak256(blake2s(seed))
          const blake2sHash = computeBlake2sSeedHash(seed);
          commitHash = computeNoirCommitHash(blake2sHash);
          if (!saveSeedData(sessionId, userAddress, seed, blinding, 'noir')) {
            throw new Error('Failed to save seed data to browser storage. Cannot commit — you would be unable to reveal later. Check if storage is full or disabled.');
          }
        } else if (proofMode === 'nizk') {
          // NIZK mode: commit_hash = keccak256(seed_hash || blinding || player_address)
          const seedHash = computeInnerSeedHash(seed);
          commitHash = computeNizkCommitment(seedHash, blinding, userAddress);
          if (!saveSeedData(sessionId, userAddress, seed, blinding, 'nizk')) {
            throw new Error('Failed to save seed data to browser storage. Cannot commit — you would be unable to reveal later. Check if storage is full or disabled.');
          }
        } else {
          // Pedersen mode (default): commit_hash = keccak256(C)
          const seedHash = computeInnerSeedHash(seed);
          commitHash = computePedersenCommitHash(seedHash, blinding);
          if (!saveSeedData(sessionId, userAddress, seed, blinding, 'pedersen')) {
            throw new Error('Failed to save seed data to browser storage. Cannot commit — you would be unable to reveal later. Check if storage is full or disabled.');
          }
        }

        const signer = getContractSigner();
        const commitResult = await service.commitSeed(sessionId, userAddress, commitHash, signer);
        if (commitResult.txHash) addTx('Commit Seed', commitResult.txHash, userAddress);
        playSound('commit');
        const modeLabel = proofMode === 'noir' ? 'Noir blake2s' : proofMode === 'nizk' ? 'Hash-NIZK' : 'Pedersen blinding';
        setSuccess(`Seed committed with ${modeLabel}! Your data is saved locally for proof generation.`);
        await loadGameStateAndNudge();
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge, proofMode]);

  // ─── Reveal Seed ──────────────────────────────────────────────────────────

  const handleRevealSeed = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const seedData = loadSeedData(sessionId, userAddress);
        if (!seedData) throw new Error('No saved seed data found. Did you commit from this browser?');
        const seed = Buffer.from(seedData.seed, 'hex');
        const blinding = Buffer.from(seedData.blinding, 'hex');
        const savedMode: ProofMode = (seedData as any).proofMode ?? 'pedersen';

        let seedHash: Buffer;
        let proof: Buffer;

        if (savedMode === 'noir') {
          // ── Noir / UltraKeccakHonk split-TX path ──
          // TX 1: verify_noir_seed (UltraHonk verification ~215M CPU)
          // TX 2: reveal_seed with empty proof (game logic ~50M CPU)
          setNoirProofProgress('Computing blake2s seed hash…');
          seedHash = computeBlake2sSeedHash(seed);

          setNoirProofProgress('Generating Noir witness + UltraKeccakHonk proof in browser… (may take 10-30 s)');
          const { generateNoirProof, proofToContractBytes } = await import('./noirProver');
          const noirResult = await generateNoirProof(seed, seedHash);

          setNoirProofProgress(`Proof generated in ${(noirResult.proofTimeMs / 1000).toFixed(1)}s – verifying on-chain (TX 1/2)…`);
          proof = Buffer.from(proofToContractBytes(noirResult));

          // TX 1: verify_noir_seed — CPU-heavy UltraHonk verification
          const signer = getContractSigner();
          const verifyResult = await service.verifyNoirSeed(sessionId, userAddress, seedHash, proof, signer);
          if (verifyResult.txHash) addTx('Verify Noir Proof (TX 1/2)', verifyResult.txHash, userAddress);

          setNoirProofProgress('Noir proof verified! Revealing seed (TX 2/2)…');

          // TX 2: reveal_seed with empty proof — consumes the pre-verified flag
          const emptyProof = Buffer.alloc(0);
          const revealResult = await service.revealSeed(sessionId, userAddress, seedHash, emptyProof, signer);
          if (revealResult.txHash) addTx('Reveal Seed (Noir ZK, TX 2/2)', revealResult.txHash, userAddress);

          playSound('commit');
          setSuccess('Noir UltraKeccakHonk ZK proof verified! Seed revealed without exposing the raw value.');
          clearSeedData(sessionId, userAddress);
          setNoirProofProgress(null);
          await loadGameStateAndNudge();
          return; // skip the common reveal path below
        } else if (savedMode === 'nizk') {
          // ── NIZK / Hash-based Schnorr path ──
          seedHash = computeInnerSeedHash(seed);
          const commitment = computeNizkCommitment(seedHash, blinding, userAddress);
          proof = buildNizkProof(seedHash, blinding, commitment, sessionId, userAddress);
        } else {
          // ── Pedersen path (default) ──
          seedHash = computeInnerSeedHash(seed);
          proof = buildPedersenProof(seedHash, blinding, sessionId, userAddress);
        }

        const signer = getContractSigner();
        const revealResult = await service.revealSeed(sessionId, userAddress, seedHash, proof, signer);
        if (revealResult.txHash) {
          const label = savedMode === 'nizk' ? 'Reveal Seed (NIZK)' : 'Reveal Seed (Pedersen ZK)';
          addTx(label, revealResult.txHash, userAddress);
        }
        playSound('commit');
        const modeText = savedMode === 'nizk'
          ? 'Hash-NIZK Schnorr proof verified!'
          : 'Pedersen ZK proof verified!';
        setSuccess(`${modeText} Seed revealed without exposing the raw value.`);
        clearSeedData(sessionId, userAddress);
        setNoirProofProgress(null);
        await loadGameStateAndNudge();
      } catch (err) {
        setError(CangkulanService.formatError(err));
        setNoirProofProgress(null);
      } finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge]);

  // ─── Commit Play ──────────────────────────────────────────────────────────

  const handleCommitPlay = useCallback(async (cardId: number) => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const isCangkul = cardId === CANNOT_FOLLOW_SENTINEL;

        // ─── Fetch FRESH game state before building ZK proof ──────────────
        // The React `gameState` closure can be stale: after the previous trick
        // resolves, new cards may be drawn from the pile on-chain before the
        // next poll cycle updates the UI. If we build a ZK ring-sigma proof
        // using stale hand data, the validSet won't match what the contract
        // computes on verification → ZkPlayProofInvalid (Error #32).
        const freshState = await service.getGameView(sessionId, userAddress);
        if (!freshState) {
          setError('Could not fetch game state. Please retry.');
          setLoading(false);
          return;
        }

        // Use fresh state for hand and trick suit
        const trickSuit = freshState.trick_suit;
        const myHand: number[] =
          freshState.player1 === userAddress
            ? (freshState.hand1 ?? [])
            : (freshState.hand2 ?? []);
        const validSet = trickSuit != null
          ? myHand.filter(c => Math.floor(c / 9) === trickSuit)
          : [];

        // Safety check: if frontend says "can't follow" but we DO have matching cards,
        // refresh state and abort to prevent HasMatchingSuit (error 15)
        if (isCangkul && validSet.length > 0) {
          log.warn('[CommitPlay] Stale state: tried cannot-follow but have matching suit cards. Refreshing...');
          await loadGameStateAndNudge();
          setLoading(false);
          return;
        }

        // On local network, bypass lightweight ZK ring sigma proofs for card play
        // to prevent Error #32 (state sync issues). Noir seed proofs are still fully tested.
        const isLocalNetwork = useNetworkStore.getState().activeNetwork === 'local';

        // Mode 7: ZK ring sigma for follow-suit card plays
        const useZkPlay = !isCangkul && validSet.length > 0 && !isLocalNetwork;
        // Mode 8: ZK aggregate Pedersen for cangkul (cannot follow)
        const useZkCangkul = isCangkul && myHand.length > 0 && trickSuit != null && !isLocalNetwork;
        const signer = getContractSigner();
        // Always use the freshly-fetched nonce to avoid InvalidNonce errors
        const expectedNonce = freshState.action_nonce;
        let result;

        if (useZkPlay) {
          // ZK Pedersen commit + ring sigma proof (Mode 7)
          const salt = generatePlaySalt();
          const commitHash = computeCardPlayZkCommitHash(cardId, salt);
          const zkProof = buildCardPlayRingProof(cardId, salt, validSet, sessionId, userAddress);
          if (!savePlayCommit(sessionId, userAddress, cardId, salt, true)) {
            throw new Error('Failed to save play commit to browser storage. Cannot commit — you would be unable to reveal later.');
          }
          result = await service.commitPlayZk(sessionId, userAddress, commitHash, expectedNonce, zkProof, signer);
        } else if (useZkCangkul) {
          // ZK aggregate Pedersen + Schnorr proof (Mode 8)
          const perCardBlindings = myHand.map(() => generatePlaySalt());
          const commitHash = computeCangkulZkCommitHash(myHand, perCardBlindings);
          const zkProof = buildCangkulZkProof(myHand, perCardBlindings, trickSuit!, sessionId, userAddress);
          // Store r_agg as the "salt" for aggregate opening during reveal
          const rAggBytes = computeCangkulRevealSalt(myHand, perCardBlindings);
          if (!savePlayCommit(sessionId, userAddress, cardId, rAggBytes, true)) {
            throw new Error('Failed to save play commit to browser storage. Cannot commit — you would be unable to reveal later.');
          }
          result = await service.commitCangkulZk(sessionId, userAddress, commitHash, expectedNonce, zkProof, signer);
        } else {
          // Legacy keccak256 commit
          const salt = generatePlaySalt();
          const commitHash = computePlayCommitHash(cardId, salt);
          if (!savePlayCommit(sessionId, userAddress, cardId, salt, false)) {
            throw new Error('Failed to save play commit to browser storage. Cannot commit — you would be unable to reveal later.');
          }
          result = await service.commitPlay(sessionId, userAddress, commitHash, expectedNonce, signer);
        }

        if (result.txHash) {
          const label = isCangkul ? 'Cangkul! 🔄' : cardLabel(cardId);
          const mode = (useZkPlay || useZkCangkul) ? '🔐 ZK ' : '';
          addTx(`${mode}Commit Play`, result.txHash, userAddress, label);
        }
        playSound('commit');
        const zkMode = useZkPlay || useZkCangkul;
        setSuccess(zkMode
          ? (useZkCangkul
            ? '🔐 ZK cangkul committed! Hand proof verified on-chain.'
            : '🔐 ZK play committed! Ring sigma proof verified.')
          : 'Play committed! Waiting for opponent...');
        await loadGameStateAndNudge();
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge]);

  // ─── Reveal Play ──────────────────────────────────────────────────────────

  const handleRevealPlay = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const commitData = loadPlayCommit(sessionId, userAddress);
        if (!commitData) throw new Error('No saved play commit. Did you commit from this browser?');
        const salt = Buffer.from(commitData.salt, 'hex');
        const signer = getContractSigner();
        const result = await service.revealPlay(sessionId, userAddress, commitData.cardId, salt, signer);
        if (result.txHash) {
          const label = commitData.cardId === CANNOT_FOLLOW_SENTINEL ? 'Cangkul! 🔄' : cardLabel(commitData.cardId);
          const mode = commitData.zkMode ? '🔐 ZK ' : '';
          addTx(`${mode}Reveal Play`, result.txHash, userAddress, label);
        }
        clearPlayCommit(sessionId, userAddress);
        playSound('card-play');
        setSuccess('Play revealed!');
        await loadGameStateAndNudge();
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge]);

  // ─── Auto-reveal ──────────────────────────────────────────────────────────
  // Must depend on isBusy so the effect re-fires when loading transitions
  // from true → false after a commit action completes.  Without it the
  // reveal is skipped (isBusy=true) and never retried because trick_state
  // doesn't change again.

  useEffect(() => {
    if (!gameState || gameState.lifecycle_state !== LIFECYCLE.PLAYING) return;
    const ts = gameState.trick_state;
    const needsReveal =
      ts === TRICK.REVEAL_WAIT_BOTH ||
      (ts === TRICK.REVEAL_WAIT_P1 && isPlayer1) ||
      (ts === TRICK.REVEAL_WAIT_P2 && isPlayer2);
    if (needsReveal && !isBusy && !actionLock.current) {
      const commitData = loadPlayCommit(sessionId, userAddress);
      if (commitData) {
        // Triggering auto-reveal
        handleRevealPlay();
      }
    }
  }, [gameState?.trick_state, isBusy, isPlayer1, isPlayer2, sessionId, userAddress, handleRevealPlay]);

  // ─── Tick / Resolve Timeout ───────────────────────────────────────────────

  const handleTickTimeout = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const signer = getContractSigner();
        const tickResult = await service.tickTimeout(sessionId, userAddress, signer);
        if (tickResult.txHash) addTx('Tick Timeout', tickResult.txHash, userAddress);
        setSuccess(`Timeout ticked. Nonce: ${tickResult.result}`);
        await loadGameStateAndNudge();
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge]);

  const handleResolveTimeout = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const signer = getContractSigner();
        const resolveResult = await service.resolveTimeout(sessionId, userAddress, signer);
        if (resolveResult.txHash) addTx('Resolve Timeout', resolveResult.txHash, userAddress);
        setSuccess('Timeout resolved! Game finalized.');
        await loadGameStateAndNudge(); onStandingsRefresh();
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge, onStandingsRefresh]);

  // ─── Forfeit ──────────────────────────────────────────────────────────────

  const handleForfeit = useCallback(async () => {
    await runAction(async () => {
      try {
        setLoading(true); setError(null); setSuccess(null);
        const signer = getContractSigner();
        const forfeitResult = await service.forfeit(sessionId, userAddress, signer);
        if (forfeitResult.txHash) addTx('🏳️ Forfeit', forfeitResult.txHash, userAddress);
        playSound('game-win');
        setSuccess('You forfeited the game. Opponent wins.');
        await loadGameStateAndNudge(); onStandingsRefresh();
      } catch (err) { setError(CangkulanService.formatError(err)); }
      finally { setLoading(false); }
    });
  }, [runAction, sessionId, userAddress, getContractSigner, service, addTx, loadGameStateAndNudge, onStandingsRefresh]);

  // ─── Verify Shuffle ───────────────────────────────────────────────────────

  const handleVerifyShuffle = useCallback(async () => {
    try {
      setShuffleLoading(true);
      const deck = await service.verifyShuffle(sessionId);
      if (deck) { setShuffleData(deck); playSound('deal'); }
      else { setError('Could not verify shuffle — game may not be in the right state.'); }
    } catch (err) { setError(CangkulanService.formatError(err)); }
    finally { setShuffleLoading(false); }
  }, [service, sessionId]);

  return {
    loading,
    isBusy,
    error,
    success,
    shuffleData,
    shuffleLoading,
    setLoading,
    setError,
    setSuccess,
    handleCommitSeed,
    handleRevealSeed,
    handleCommitPlay,
    handleRevealPlay,
    handleTickTimeout,
    handleResolveTimeout,
    handleForfeit,
    handleVerifyShuffle,
    runAction,
    proofMode,
    setProofMode,
    noirProofProgress,
    autoCommitStatus,
    lastActionRef,
  };
}
