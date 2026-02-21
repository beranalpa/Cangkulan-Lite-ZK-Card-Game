/**
 * useBotAutoPlay — Drives the bot (Player 2) through every game phase.
 *
 * When the game state shows it's the bot's turn to act (seed commit,
 * seed reveal, card commit, card reveal), this hook automatically
 * calls the contract using the bot's ephemeral keypair signer.
 *
 * All moves are real Soroban transactions — the only difference is
 * the signing key is an ephemeral in-memory keypair instead of a wallet.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Buffer } from 'buffer';
import type { BotPlayer } from './ai/BotPlayer';
import type { GameState, ProofMode } from './types';
import { LIFECYCLE, TRICK, CANNOT_FOLLOW_SENTINEL } from './types';
import { CangkulanService } from './cangkulanService';
import {
  generateSeed,
  computeInnerSeedHash,
  computePedersenCommitHash,
  buildPedersenProof,
  computePlayCommitHash,
  generatePlaySalt,
} from './cryptoHelpers';
import { log } from '@/utils/logger';
import { saveSeedData, loadSeedData } from './seedStorage';
import { savePlayCommit, loadPlayCommit, clearPlayCommit } from './playCommitStorage';

interface BotAutoPlayConfig {
  bot: BotPlayer | null | undefined;
  service: CangkulanService;
  sessionId: number;
  gameState: GameState | null;
  loadGameState: () => Promise<void>;
  addTx: (label: string, hash: string, addr: string, detail?: string) => void;
  proofMode?: ProofMode;
  /** Called whenever the bot knows how many cards it holds */
  onBotHandSize?: (size: number) => void;
}

/**
 * Drives bot actions whenever the game state says it's Player 2's turn.
 *
 * Returns `botBusy` — true while a bot transaction is in-flight.
 */
export function useBotAutoPlay({
  bot,
  service,
  sessionId,
  gameState,
  loadGameState,
  addTx,
  proofMode = 'pedersen',
  onBotHandSize,
}: BotAutoPlayConfig): { botBusy: boolean } {
  // Track whether a bot action is in-flight
  const busyRef = useRef(false);
  // Stored seed data for the bot (persisted to sessionStorage for page-refresh recovery)
  const botSeedRef = useRef<{ seed: Uint8Array; blinding: Uint8Array; seedHash: Buffer; commitHash: Buffer } | null>(null);
  // Stored play commit for the bot
  const botPlayRef = useRef<{ cardId: number; salt: Uint8Array } | null>(null);

  // Bot address prefix for storage keys (distinguishes from human player)
  const botAddr = bot?.address ? `bot-${bot.address}` : '';

  // Recover bot seed data from sessionStorage on mount / bot change
  useEffect(() => {
    if (!bot || !sessionId || botSeedRef.current) return;
    const saved = loadSeedData(sessionId, botAddr);
    if (saved) {
      try {
        botSeedRef.current = {
          seed: Buffer.from(saved.seed, 'hex'),
          blinding: Buffer.from(saved.blinding, 'hex'),
          seedHash: computeInnerSeedHash(Buffer.from(saved.seed, 'hex')),
          commitHash: computePedersenCommitHash(
            computeInnerSeedHash(Buffer.from(saved.seed, 'hex')),
            Buffer.from(saved.blinding, 'hex'),
          ),
        };
        log.debug('[Bot] Recovered seed data from storage');
      } catch (err) {
        log.error('[Bot] Failed to reconstruct seed data from storage:', err);
        botSeedRef.current = null;
      }
    } else {
      log.debug('[Bot] No stored seed data found for recovery');
    }
  }, [bot, sessionId, botAddr]);

  // Recover bot play commit from sessionStorage on mount
  useEffect(() => {
    if (!bot || !sessionId || botPlayRef.current) return;
    const saved = loadPlayCommit(sessionId, botAddr);
    if (saved) {
      botPlayRef.current = {
        cardId: saved.cardId,
        salt: Buffer.from(saved.salt, 'hex'),
      };
      log.debug('[Bot] Recovered play commit from storage');
    } else {
      log.debug('[Bot] No stored play commit found for recovery');
    }
  }, [bot, sessionId, botAddr]);

  const disabled = !bot;

  // ─── Helper: run a bot action with lock ────────────────────────────────
  const runBotAction = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busyRef.current || !bot) return;
    busyRef.current = true;
    try {
      log.debug(`[Bot] ${label}...`);
      await action();
      log.debug(`[Bot] ${label} ✓`);
      // Poll until state changes or max attempts reached.
      // Early-exit as soon as the on-chain state actually updates.
      let prevNonce: number | undefined;
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 800 + i * 300));
        await loadGameState();
        try {
          const game = await service.getGame(sessionId);
          if (game && prevNonce !== undefined && game.action_nonce !== prevNonce) break;
          if (game) prevNonce = game.action_nonce;
        } catch { /* ignore — loadGameState already ran */ }
      }
    } catch (err) {
      log.error(`[Bot] ${label} failed:`, err);
    } finally {
      busyRef.current = false;
    }
  }, [bot, loadGameState, service, sessionId]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase: Seed Commit — bot commits its seed
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (disabled || !gameState) return;
    if (gameState.lifecycle_state !== LIFECYCLE.SEED_COMMIT) return;
    if (gameState.seed_commit2 != null) return; // already committed

    const timer = setTimeout(() => {
      runBotAction('Commit Seed', async () => {
        const seed = generateSeed();
        const blinding = generateSeed();
        const seedHash = computeInnerSeedHash(seed);
        const commitHash = computePedersenCommitHash(seedHash, blinding);

        const signer = bot!.getContractSigner();
        const result = await service.commitSeed(sessionId, bot!.address, commitHash, signer);
        if (result.txHash) addTx('🤖 Bot Commit Seed', result.txHash, bot!.address);

        // Save for reveal phase (ref + sessionStorage for page-refresh recovery)
        botSeedRef.current = { seed, blinding, seedHash, commitHash };
        saveSeedData(sessionId, botAddr, seed, blinding, 'pedersen');
      });
    }, 1500); // Wait 1.5s for natural pacing

    return () => clearTimeout(timer);
  }, [disabled, gameState?.lifecycle_state, gameState?.seed_commit2, runBotAction, service, sessionId, addTx, bot]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase: Seed Reveal — bot reveals its seed with Pedersen proof
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (disabled || !gameState) return;
    if (gameState.lifecycle_state !== LIFECYCLE.SEED_REVEAL) return;
    if (gameState.seed_revealed2) return; // already revealed
    if (!botSeedRef.current) {
      // Seed data was lost (storage cleared, encryption failure, new tab).
      // Log prominently so the timeout fallback can resolve the game.
      log.error('[Bot] DEADLOCK: Seed reveal required but seed data is lost. ' +
        'Cannot reveal without original seed. Timeout must resolve this game.');
      return;
    }

    const timer = setTimeout(() => {
      runBotAction('Reveal Seed', async () => {
        const { seed, blinding, seedHash } = botSeedRef.current!;
        const proof = buildPedersenProof(seedHash, blinding, sessionId, bot!.address);

        const signer = bot!.getContractSigner();
        const result = await service.revealSeed(sessionId, bot!.address, seedHash, proof, signer);
        if (result.txHash) addTx('🤖 Bot Reveal Seed', result.txHash, bot!.address);
      });
    }, 1500);

    return () => clearTimeout(timer);
  }, [disabled, gameState?.lifecycle_state, gameState?.seed_revealed2, runBotAction, service, sessionId, addTx, bot]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase: Playing — Polled Action Loop
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    const iv = setInterval(() => {
      if (disabled || !gameState || !bot || busyRef.current) return;
      if (gameState.lifecycle_state !== LIFECYCLE.PLAYING) return;

      const ts = gameState.trick_state;
      // Bot only acts when it is EXPLICITLY the bot's (P2's) turn.
      // We deliberately skip COMMIT_WAIT_BOTH / REVEAL_WAIT_BOTH so the human
      // player always commits/reveals first. This avoids a race-condition where
      // both parties submit simultaneously and one of the ZK proofs fails
      // because the on-chain nonce or trick state already changed.
      const needsBotCommit = ts === TRICK.COMMIT_WAIT_P2;
      const needsBotReveal = ts === TRICK.REVEAL_WAIT_P2;

      // Ensure stable references
      const botAddr = bot.address ? `bot-${bot.address}` : '';

      if (needsBotCommit && !botPlayRef.current) {
        runBotAction('Commit Play', async () => {
          // The `gameState` prop from the UI is fetched with viewer = P1.
          // The smart contract redacts P2's hand (hand2) to protect privacy!
          // So the bot MUST fetch the game state from its OWN perspective:
          const botState = await service.getGameView(sessionId, bot.address);
          if (!botState) return;

          const hand = botState.hand2 ?? [];
          // Report bot's hand size to the parent UI for display
          onBotHandSize?.(hand.length);
          if (hand.length === 0) return;

          const trickSuit = botState.trick_suit;
          const matchingSuit = trickSuit != null
            ? hand.filter(c => Math.floor(c / 9) === trickSuit)
            : [];

          let cardId: number;
          if (trickSuit != null && matchingSuit.length === 0) {
            // Can't follow suit — cangkul
            cardId = CANNOT_FOLLOW_SENTINEL;
          } else {
            // Use bot strategy to select card
            const leadSuit = trickSuit ?? null;
            const botCards = hand.map(c => ({ suit: Math.floor(c / 9), rank: (c % 9) + 2 }));
            const selected = bot.selectCard(botCards, leadSuit);
            // Convert back to card ID
            cardId = selected.suit * 9 + (selected.rank - 2);
          }

          const isCangkul = cardId === CANNOT_FOLLOW_SENTINEL;
          const salt = generatePlaySalt();

          // The bot is a trusted AI opponent running inside the same browser.
          // ZK ring-sigma proofs (Mode 7/8) protect privacy between two SEPARATE
          // human players. For a vs-Bot game that protection is irrelevant, and
          // the extra crypto round-trip has historically caused Fiat-Shamir
          // challenge mismatches when chain state lags behind the local view.
          // Always use the plain commit/reveal path for the bot.
          const signer = bot.getContractSigner();
          let result;

          const commitHash = computePlayCommitHash(cardId, salt);
          result = await service.commitPlay(sessionId, bot.address, commitHash, gameState.action_nonce, signer);

          if (result.txHash) {
            botPlayRef.current = { cardId, salt };
            savePlayCommit(sessionId, botAddr, cardId, salt, false);
            const label = isCangkul ? 'Cangkul! 🔄' : `Card #${cardId}`;
            addTx(`🤖 Bot Commit Play`, result.txHash, bot.address, label);
          }
        });
      } else if (needsBotReveal && botPlayRef.current) {
        runBotAction('Reveal Play', async () => {
          const { cardId, salt } = botPlayRef.current!;
          if (cardId === undefined) return;

          const signer = bot.getContractSigner();
          const result = await service.revealPlay(sessionId, bot.address, cardId, Buffer.from(salt), signer);
          if (result.txHash) {
            const label = cardId === CANNOT_FOLLOW_SENTINEL ? 'Cangkul! 🔄' : `Card #${cardId}`;
            addTx('🤖 Bot Reveal Play', result.txHash, bot.address, label);
          }

          botPlayRef.current = null;
          clearPlayCommit(sessionId, botAddr);
          bot.trackPlayedCard({ suit: Math.floor(cardId / 9), rank: (cardId % 9) + 2 });
        });
      }
    }, 2000); // Polling every 2 seconds ensures it retries resiliently
    return () => clearInterval(iv);
  }, [disabled, gameState, bot, addTx, runBotAction, service, sessionId]);

  return { botBusy: busyRef.current };
}
