// Card encoding: card_id = suit * 9 + (value - 2)
export const CARDS_PER_SUIT = 9;

export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const;
export const SUIT_NAMES = ['Spades', 'Hearts', 'Diamonds', 'Clubs'] as const;

export function cardSuit(cardId: number): number {
  return Math.floor(cardId / CARDS_PER_SUIT);
}

export function cardValue(cardId: number): number {
  return (cardId % CARDS_PER_SUIT) + 2;
}

export function cardLabel(cardId: number): string {
  return `${cardValue(cardId)}${SUIT_SYMBOLS[cardSuit(cardId)]}`;
}

export function cardAccessibleName(cardId: number): string {
  return `${cardValue(cardId)} of ${SUIT_NAMES[cardSuit(cardId)]}`;
}

/** Check if player has any card matching a given suit */
export function hasMatchingSuitCards(hand: number[], suit: number): boolean {
  return hand.some(c => cardSuit(c) === suit);
}
