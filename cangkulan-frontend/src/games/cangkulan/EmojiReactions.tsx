import { useState, useEffect, useRef, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  Emoji Reactions — cross-tab signaling via BroadcastChannel + localStorage
//
//  BroadcastChannel gives instant delivery between tabs on the same origin.
//  localStorage serves as a fallback and persistence layer for tabs that
//  opened after a reaction was sent.
// ═══════════════════════════════════════════════════════════════════════════════

const EMOJIS = ['👍', '🔥', '😱', '😂', '👏', '💀', '🎉', '😤'] as const;
const EMOJI_LABELS: Record<string, string> = {
  '👍': 'Thumbs up',
  '🔥': 'Fire',
  '😱': 'Shocked',
  '😂': 'Laughing',
  '👏': 'Clapping',
  '💀': 'Skull',
  '🎉': 'Party',
  '😤': 'Frustrated',
};
export type ReactionEmoji = typeof EMOJIS[number];

interface Reaction {
  emoji: ReactionEmoji;
  sender: string;   // player address (truncated)
  timestamp: number;
  id: string;
}

interface ReactionMessage {
  type: 'emoji-reaction';
  sessionId: number;
  reaction: Reaction;
}

// ─── Storage helpers ───────────────────────────────────────────────────────

function getStorageKey(sessionId: number): string {
  return `cangkulan-reactions-${sessionId}`;
}

function readReactions(sessionId: number): Reaction[] {
  try {
    const raw = localStorage.getItem(getStorageKey(sessionId));
    if (!raw) return [];
    const reactions: Reaction[] = JSON.parse(raw);
    const cutoff = Date.now() - 30_000;
    return reactions.filter(r => r.timestamp > cutoff);
  } catch { return []; }
}

function persistReaction(sessionId: number, reaction: Reaction) {
  const reactions = readReactions(sessionId);
  if (reactions.some(r => r.id === reaction.id)) return; // dedupe
  reactions.push(reaction);
  const trimmed = reactions.slice(-20);
  try {
    localStorage.setItem(getStorageKey(sessionId), JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

// ─── BroadcastChannel singleton per session ────────────────────────────────

const channels = new Map<number, BroadcastChannel>();

function getChannel(sessionId: number): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channels.has(sessionId)) {
    try {
      channels.set(sessionId, new BroadcastChannel(`cangkulan-emoji-${sessionId}`));
    } catch { return null; }
  }
  return channels.get(sessionId) ?? null;
}

function broadcastReaction(sessionId: number, reaction: Reaction) {
  const ch = getChannel(sessionId);
  if (ch) {
    const msg: ReactionMessage = { type: 'emoji-reaction', sessionId, reaction };
    ch.postMessage(msg);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Floating Reaction Bubble
// ═══════════════════════════════════════════════════════════════════════════════

function FloatingReaction({ reaction, onDone }: { reaction: Reaction; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 3000);
    return () => clearTimeout(timer);
  }, [onDone]);

  const x = 10 + Math.random() * 80;

  return (
    <div
      className="absolute pointer-events-none z-30"
      aria-hidden="true"
      style={{
        left: `${x}%`,
        bottom: 0,
        animation: 'emojiFloatUp 3s ease-out forwards',
      }}
    >
      <div className="text-3xl sm:text-4xl drop-shadow-lg">{reaction.emoji}</div>
      <div className="text-[0.6rem] font-bold text-gray-500 text-center mt-0.5">{reaction.sender}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Emoji Picker Bar
// ═══════════════════════════════════════════════════════════════════════════════

interface EmojiReactionsProps {
  sessionId: number;
  userAddress: string;
}

export function EmojiReactions({ sessionId, userAddress }: EmojiReactionsProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [visibleReactions, setVisibleReactions] = useState<Reaction[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const seenIdsRef = useRef(new Set<string>());

  // ─── Listen for cross-tab reactions via BroadcastChannel ──────────────
  useEffect(() => {
    const ch = getChannel(sessionId);
    if (!ch) return;

    const handler = (event: MessageEvent<ReactionMessage>) => {
      const msg = event.data;
      if (msg?.type !== 'emoji-reaction' || msg.sessionId !== sessionId) return;
      const r = msg.reaction;
      if (seenIdsRef.current.has(r.id)) return;
      seenIdsRef.current.add(r.id);
      persistReaction(sessionId, r);
      setVisibleReactions(prev => [...prev, r].slice(-10));
    };

    ch.addEventListener('message', handler);
    return () => ch.removeEventListener('message', handler);
  }, [sessionId]);

  // ─── Fallback: poll localStorage for reactions from tabs without BC ───
  useEffect(() => {
    const poll = () => {
      const reactions = readReactions(sessionId);
      const newOnes = reactions.filter(r => !seenIdsRef.current.has(r.id));
      if (newOnes.length > 0) {
        newOnes.forEach(r => seenIdsRef.current.add(r.id));
        setVisibleReactions(prev => [...prev, ...newOnes].slice(-10));
      }
    };
    poll();
    const iv = setInterval(poll, 1500);
    return () => clearInterval(iv);
  }, [sessionId]);

  const sendReaction = useCallback((emoji: ReactionEmoji) => {
    if (cooldown) return;
    const reaction: Reaction = {
      emoji,
      sender: userAddress.slice(0, 6),
      timestamp: Date.now(),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    seenIdsRef.current.add(reaction.id);

    // Persist locally + broadcast to other tabs
    persistReaction(sessionId, reaction);
    broadcastReaction(sessionId, reaction);

    setVisibleReactions(prev => [...prev, reaction].slice(-10));
    setShowPicker(false);
    setCooldown(true);
    setTimeout(() => setCooldown(false), 2000);
  }, [sessionId, userAddress, cooldown]);

  const removeReaction = useCallback((id: string) => {
    setVisibleReactions(prev => prev.filter(r => r.id !== id));
  }, []);

  return (
    <>
      {/* Floating reactions overlay */}
      <div className="relative h-0 overflow-visible">
        <div className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none">
          {visibleReactions.map(r => (
            <FloatingReaction key={r.id} reaction={r} onDone={() => removeReaction(r.id)} />
          ))}
        </div>
      </div>

      {/* Reaction bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowPicker(!showPicker)}
          aria-label={showPicker ? 'Close emoji picker' : 'Open emoji picker'}
          aria-expanded={showPicker}
          className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
            showPicker
              ? 'bg-emerald-100 text-emerald-700 border-2 border-emerald-300'
              : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
          }`}
          style={{ minWidth: 'auto', minHeight: 'auto', padding: '0.375rem 0.75rem' }}
          disabled={cooldown}
          title={cooldown ? 'Wait a moment...' : 'Send a reaction'}
        >
          {cooldown ? '⏳' : '😊'}
        </button>

        {showPicker && (
          <div
            className="flex gap-1 slide-in-up"
            role="group"
            aria-label="Emoji reactions"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowPicker(false);
              }
            }}
          >
            {EMOJIS.map(emoji => (
              <button
                key={emoji}
                onClick={() => sendReaction(emoji)}
                aria-label={`Send ${EMOJI_LABELS[emoji] || emoji} reaction`}
                className="text-xl hover:scale-125 transition-transform p-1 rounded-lg hover:bg-gray-100"
                style={{ background: 'none', border: 'none', minWidth: 'auto', minHeight: 'auto', padding: '0.25rem' }}
                title={`Send ${EMOJI_LABELS[emoji] || emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CSS for floating animation */}
      <style>{`
        @keyframes emojiFloatUp {
          0%   { transform: translateY(0) scale(1); opacity: 1; }
          70%  { opacity: 1; }
          100% { transform: translateY(-120px) scale(1.3); opacity: 0; }
        }
      `}</style>
    </>
  );
}
