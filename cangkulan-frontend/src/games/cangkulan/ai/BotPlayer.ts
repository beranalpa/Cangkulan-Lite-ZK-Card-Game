/**
 * BotPlayer — AI opponent that auto-signs transactions and plays cards.
 *
 * Generates an ephemeral Stellar keypair, funds it via Friendbot,
 * and auto-responds to all game phases (seed, play, reveal).
 * All moves are still verified on-chain — the bot is a real Soroban player.
 */

import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import type { ContractSigner } from '@/types/signer';
import { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } from '@/utils/constants';
import { log } from '@/utils/logger';

export type BotDifficulty = 'easy' | 'medium' | 'hard';

/** Minimal card shape from contract bindings */
export interface BotCard {
  suit: number;
  rank: number;
}

/**
 * Card selection strategies by difficulty
 */
const strategies: Record<BotDifficulty, (hand: BotCard[], leadSuit: number | null, playedCards?: BotCard[]) => BotCard> = {
  /** Easy: random valid card */
  easy: (hand, leadSuit) => {
    if (leadSuit !== null) {
      const matching = hand.filter(c => c.suit === leadSuit);
      if (matching.length > 0) return matching[Math.floor(Math.random() * matching.length)];
    }
    return hand[Math.floor(Math.random() * hand.length)];
  },

  /** Medium: follow suit with lowest rank; if leading, play suit with most cards */
  medium: (hand, leadSuit) => {
    if (leadSuit !== null) {
      const matching = hand.filter(c => c.suit === leadSuit);
      if (matching.length > 0) {
        // Play lowest rank in suit
        return matching.reduce((low, c) => c.rank < low.rank ? c : low);
      }
      // No matching suit — play highest rank to waste it
      return hand.reduce((high, c) => c.rank > high.rank ? c : high);
    }
    // Leading — play suit with most cards (to control the trick)
    const suitCount: Record<number, number> = {};
    for (const c of hand) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
    const bestSuit = Object.entries(suitCount).reduce((a, b) => +a[1] >= +b[1] ? a : b);
    const suitCards = hand.filter(c => c.suit === +bestSuit[0]);
    // Play highest rank in dominant suit
    return suitCards.reduce((high, c) => c.rank > high.rank ? c : high);
  },

  /** Hard: track played cards, save high cards, try to force opponent to draw */
  hard: (hand, leadSuit, playedCards = []) => {
    // Track which suits are depleted (from played cards)
    const suitPlayed: Record<number, number> = {};
    for (const c of playedCards) suitPlayed[c.suit] = (suitPlayed[c.suit] || 0) + 1;

    if (leadSuit !== null) {
      const matching = hand.filter(c => c.suit === leadSuit);
      if (matching.length > 0) {
        // Play just high enough to win if possible, else lowest
        return matching.reduce((low, c) => c.rank < low.rank ? c : low);
      }
      // Can't follow — play least useful card
      // (card with suit that's been heavily played, lowest rank)
      return [...hand].sort((a, b) => {
        const aUsed = suitPlayed[a.suit] || 0;
        const bUsed = suitPlayed[b.suit] || 0;
        if (bUsed !== aUsed) return bUsed - aUsed; // more played = less useful
        return a.rank - b.rank; // lower rank = less useful
      })[0];
    }
    // Leading — pick suit that opponent may not have (most played out)
    const suitInHand = [...new Set(hand.map(c => c.suit))];
    const sortedSuits = suitInHand.sort((a, b) => (suitPlayed[b] || 0) - (suitPlayed[a] || 0));
    const targetSuit = sortedSuits[0];
    const suitCards = hand.filter(c => c.suit === targetSuit);
    // Play highest in that suit to maximize win chance
    return suitCards.reduce((high, c) => c.rank > high.rank ? c : high);
  },
};

/** Shape persisted to sessionStorage for page-refresh recovery */
export interface BotSessionData {
  secret: string;
  difficulty: BotDifficulty;
  sessionId: number;
}

const BOT_SESSION_KEY = 'cangkulan-bot-session';

/** Save bot session so it survives page refresh and new-tab recovery.
 *  Dual-write to sessionStorage + localStorage (same pattern as seedStorage). */
export function saveBotSession(data: BotSessionData): void {
  const json = JSON.stringify(data);
  try { sessionStorage.setItem(BOT_SESSION_KEY, json); } catch { /* ignore */ }
  try { localStorage.setItem(BOT_SESSION_KEY, json); } catch { /* ignore */ }
}

/** Load a previously-persisted bot session.
 *  Prefers sessionStorage (current tab), falls back to localStorage (cross-tab). */
export function loadBotSession(): BotSessionData | null {
  try {
    const raw = sessionStorage.getItem(BOT_SESSION_KEY) ?? localStorage.getItem(BOT_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BotSessionData;
  } catch { return null; }
}

/** Clear persisted bot session (game ended / user navigated away) */
export function clearBotSession(): void {
  try { sessionStorage.removeItem(BOT_SESSION_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(BOT_SESSION_KEY); } catch { /* ignore */ }
}

export class BotPlayer {
  readonly difficulty: BotDifficulty;
  readonly keypair: Keypair;
  readonly address: string;
  private funded = false;
  private playedCards: BotCard[] = [];

  constructor(difficulty: BotDifficulty, keypair?: Keypair) {
    this.difficulty = difficulty;
    this.keypair = keypair ?? Keypair.random();
    this.address = this.keypair.publicKey();
    log.debug(`[Bot] Created ${difficulty} bot: ${this.address.slice(0, 8)}...`);
  }

  /** Reconstruct a BotPlayer from a stored secret key */
  static fromSecret(secret: string, difficulty: BotDifficulty): BotPlayer {
    const kp = Keypair.fromSecret(secret);
    const bot = new BotPlayer(difficulty, kp);
    bot.funded = true; // Already funded in a previous session
    return bot;
  }

  /** Serialize for sessionStorage persistence */
  serialize(sessionId: number): BotSessionData {
    return {
      secret: this.keypair.secret(),
      difficulty: this.difficulty,
      sessionId,
    };
  }

  /** Fund bot wallet via Friendbot (testnet or local) */
  async fund(): Promise<void> {
    if (this.funded) return;
    try {
      const { getActiveFriendbotUrl } = await import('@/utils/constants');
      const resp = await fetch(`${getActiveFriendbotUrl()}?addr=${this.address}`);
      if (!resp.ok) throw new Error(`Friendbot error: ${resp.status}`);
      this.funded = true;
      log.debug(`[Bot] Funded via Friendbot`);
    } catch (err) {
      log.error('[Bot] Friendbot funding failed:', err);
      throw new Error('Failed to fund bot wallet. Check testnet connectivity.');
    }
  }

  /** Get ContractSigner for signing transactions */
  getContractSigner(): ContractSigner {
    const keypair = this.keypair;
    const publicKey = this.address;

    return {
      signTransaction: async (txXdr: string, opts?: any) => {
        try {
          const transaction = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase || NETWORK_PASSPHRASE);
          transaction.sign(keypair);
          return { signedTxXdr: transaction.toXDR(), signerAddress: publicKey };
        } catch (error) {
          return {
            signedTxXdr: txXdr,
            signerAddress: publicKey,
            error: { message: String(error), code: -1 },
          };
        }
      },
      signAuthEntry: async (preimageXdr: string, _opts?: any) => {
        try {
          const preimageBytes = Buffer.from(preimageXdr, 'base64');
          const payload = hash(preimageBytes);
          const signatureBytes = keypair.sign(payload);
          return { signedAuthEntry: Buffer.from(signatureBytes).toString('base64'), signerAddress: publicKey };
        } catch (error) {
          return {
            signedAuthEntry: preimageXdr,
            signerAddress: publicKey,
            error: { message: String(error), code: -1 },
          };
        }
      },
    };
  }

  /** Select a card using the AI strategy */
  selectCard(hand: BotCard[], leadSuit: number | null): BotCard {
    if (hand.length === 0) throw new Error('Bot has no cards');
    const strategy = strategies[this.difficulty];
    const card = strategy(hand, leadSuit, this.playedCards);
    this.playedCards.push(card);
    return card;
  }

  /** Track a card that was played (by either player) */
  trackPlayedCard(card: BotCard): void {
    this.playedCards.push(card);
  }

  /** Reset played card tracking (new game) */
  resetTracking(): void {
    this.playedCards = [];
  }

  /** Get bot display name based on difficulty */
  get displayName(): string {
    switch (this.difficulty) {
      case 'easy': return '🤖 Easy Bot';
      case 'medium': return '🧠 Medium Bot';
      case 'hard': return '💀 Hard Bot';
    }
  }
}
