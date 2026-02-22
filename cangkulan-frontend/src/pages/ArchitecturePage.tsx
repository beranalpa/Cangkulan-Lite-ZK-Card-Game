import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

/* ═══════════════════════════════════════════════════════════════════════════════
   Architecture Page — Interactive Mermaid diagrams for system documentation
   ═══════════════════════════════════════════════════════════════════════════════

   Displays architecture diagrams covering:
     1. System Overview (contract interactions)
     2. Game Lifecycle State Machine
     3. Trick Commit-Reveal Protocol
     4. Frontend Component & Data Flow
     5. ZK Seed Commitment Flow
     6. Timeout & Dispute Resolution
     7. Multi-Contract Architecture
   Plus: ZK Mode Comparison Table
   ═══════════════════════════════════════════════════════════════════════════════ */

interface ArchitecturePageProps {
  navigate: (route: AppRoute) => void;
}

interface DiagramSection {
  id: string;
  title: string;
  description: string;
  mermaid: string;
}

const diagrams: DiagramSection[] = [
  // ─── 1. System Overview ──────────────────────────────────────────────────
  {
    id: 'system-overview',
    title: '🏗️ System Overview',
    description: 'High-level architecture showing how the frontend, Soroban contracts, and Stellar network interact.',
    mermaid: `graph TB
    subgraph Frontend["🖥️ React Frontend"]
        GameMode["Game Mode Selector<br/>(Multiplayer/AI/Dev)"]
        UI["UI Components<br/>(Phases)"]
        Actions["useCangkulanActions<br/>Hook"]
        BotAI["BotPlayer<br/>(AI Opponent)"]
        BotHook["useBotAutoPlay<br/>Hook"]
        Service["CangkulanService"]
        TxHelper["Transaction Helper<br/>(retry + backoff)"]
        Polling["Smart Polling<br/>(adaptive)"]
        Wallet["Wallet Kit<br/>(Freighter/Dev)"]
        NoirProver["Noir Prover<br/>(bb.js + noir_js)"]
    end

    subgraph Lobby["🌐 WebSocket Lobby"]
        WSServer["Bun WS Relay"]
        Rooms["Room System<br/>(Public/Private)"]
        Matchmaking["Matchmaking Queue"]
    end

    subgraph Stellar["⭐ Stellar Network"]
        RPC["Soroban RPC"]
        subgraph Contracts["Smart Contracts (5)"]
            Cangkulan["🎴 Cangkulan<br/>Game Contract"]
            GameHub["🎮 Game Hub<br/>(Lifecycle)"]
            ZKVerifier["🔐 ZK Verifier<br/>(4 modes)"]
            UltraHonk["🌑 UltraHonk<br/>(Noir verifier)"]
            Leaderboard["🏆 Leaderboard<br/>(ELO rating)"]
        end
    end

    subgraph Storage["💾 Browser Storage"]
        Seeds["Seed Data<br/>(localStorage)"]
        Commits["Play Commits<br/>(localStorage)"]
        History["Game History"]
    end

    GameMode --> UI
    GameMode --> BotAI
    GameMode -->|Room Events| WSServer
    BotAI --> BotHook
    BotHook --> Service
    UI --> Actions
    Actions --> Service
    Service --> TxHelper
    TxHelper --> RPC
    Polling --> Service
    Actions --> Seeds
    Actions --> Commits
    Actions --> NoirProver
    Wallet --> TxHelper
    BotAI -->|Ephemeral Keypair| TxHelper
    WSServer --> Rooms
    WSServer --> Matchmaking
    RPC --> Cangkulan
    Cangkulan -->|start_game / end_game| GameHub
    Cangkulan -->|verify seed / card play| ZKVerifier
    ZKVerifier -->|Noir proofs| UltraHonk
    GameHub -->|record_match| Leaderboard
    UI --> History`,
  },

  // ─── 2. Game Mode Flow ───────────────────────────────────────────────────
  {
    id: 'game-modes',
    title: '🎮 Game Mode Flow',
    description: 'Three game modes accessible from the Play Game button: Multiplayer (rooms), vs AI (bot), and Dev Testing.',
    mermaid: `graph TB
    Home["🏠 Homepage"] -->|Play Game| ModeSelect["🎮 Mode Selector"]

    ModeSelect --> Multi["🌐 Multiplayer"]
    ModeSelect --> AI["🤖 vs AI"]
    ModeSelect --> Dev["🔧 Dev Testing"]

    subgraph MultiFlow["Multiplayer Flow"]
        Multi --> Create["Create Room<br/>(Public/Private)"]
        Multi --> Join["Join Room<br/>(Browse/Invite Code)"]
        Multi --> Quick["⚡ Quick Match<br/>(FIFO Queue)"]
        Create --> Waiting["Waiting Room<br/>(Invite Link + QR + Chat)"]
        Join --> GameStart["Auto-Start Game"]
        Waiting -->|Guest Joins| GameStart
        Quick -->|Match Found| GameStart
    end

    subgraph AIFlow["AI Flow"]
        AI --> Difficulty["Select Difficulty<br/>(Easy/Medium/Hard)"]
        Difficulty --> BotCreate["Fund Bot via Friendbot"]
        BotCreate --> BotGame["Game vs Bot<br/>(On-Chain)"]
    end

    subgraph DevFlow["Dev Flow"]
        Dev --> WalletSwitch["Quick Wallet Switch"]
        Dev --> ZKTest["ZK Mode Selector"]
        Dev --> Inspector["Contract Inspector"]
        ZKTest --> QuickStart["Quickstart Game"]
    end

    GameStart --> CangkulanGame["🎴 CangkulanGame<br/>(Seed → Play → Complete)"]
    BotGame --> CangkulanGame`,
  },

  // ─── 3. Game Lifecycle State Machine ─────────────────────────────────────
  {
    id: 'lifecycle',
    title: '🔄 Game Lifecycle State Machine',
    description: 'The four phases a game passes through, from seed commitment to completion.',
    mermaid: `stateDiagram-v2
    [*] --> CreateGame: Player creates session
    CreateGame --> SeedCommit: start_game()

    state SeedCommit {
        [*] --> WaitBothCommit
        WaitBothCommit --> P1Committed: P1 commit_seed()
        WaitBothCommit --> P2Committed: P2 commit_seed()
        P1Committed --> BothCommitted: P2 commit_seed()
        P2Committed --> BothCommitted: P1 commit_seed()
    }

    SeedCommit --> SeedReveal: Both committed

    state SeedReveal {
        [*] --> WaitBothReveal
        WaitBothReveal --> P1Revealed: P1 reveal_seed() + ZK proof
        WaitBothReveal --> P2Revealed: P2 reveal_seed() + ZK proof
        P1Revealed --> BothRevealed: P2 reveal_seed()
        P2Revealed --> BothRevealed: P1 reveal_seed()
    }

    SeedReveal --> Playing: Seeds combined → deck shuffled

    state Playing {
        [*] --> NewTrick: Flip card from draw pile
        NewTrick --> CommitPhase
        CommitPhase --> RevealPhase: Both committed
        RevealPhase --> TrickResolved: Both revealed
        TrickResolved --> NewTrick: Cards remain
        TrickResolved --> GameEnd: Hand empty or pile exhausted
    }

    Playing --> Finished: Winner determined

    state Finished {
        P1Wins: P1 Wins (outcome=1)
        P2Wins: P2 Wins (outcome=2)
        Draw: Draw (outcome=3)
    }

    note right of SeedCommit: ZK Pedersen commitment\\nBlinding factor hides seed
    note right of Playing: Commit-reveal prevents\\nfront-running card plays`,
  },

  // ─── 3. Trick Commit-Reveal Protocol ─────────────────────────────────────
  {
    id: 'commit-reveal',
    title: '🃏 Trick Commit-Reveal Protocol',
    description: 'Each trick uses a two-phase commit-reveal to prevent opponents from seeing card choices.',
    mermaid: `sequenceDiagram
    participant P1 as Player 1
    participant SC as Cangkulan Contract
    participant P2 as Player 2

    Note over SC: Draw pile card flipped<br/>→ determines trick suit

    rect rgb(255, 245, 235)
        Note over P1, P2: COMMIT PHASE (trick_state=10)
        P1->>P1: Choose card, generate salt
        P1->>P1: hash = keccak256(card_id ∥ salt)
        P1->>SC: commit_play(hash, nonce)
        Note over SC: trick_state → 12 (wait P2)

        P2->>P2: Choose card, generate salt
        P2->>P2: hash = keccak256(card_id ∥ salt)
        P2->>SC: commit_play(hash, nonce)
        Note over SC: trick_state → 20 (reveal both)
    end

    rect rgb(235, 245, 255)
        Note over P1, P2: REVEAL PHASE (trick_state=20)
        P1->>SC: reveal_play(card_id, salt)
        SC->>SC: Verify keccak256(card_id ∥ salt) == stored hash
        Note over SC: trick_state → 22 (wait P2)

        P2->>SC: reveal_play(card_id, salt)
        SC->>SC: Verify hash match
        SC->>SC: Validate suits, resolve winner
    end

    rect rgb(235, 255, 235)
        Note over SC: TRICK RESOLVED
        SC->>SC: Transfer cards, update scores
        SC-->>P1: EvTrickResolved event
        SC-->>P2: EvTrickResolved event
    end`,
  },

  // ─── 4. Frontend Component Tree ──────────────────────────────────────────
  {
    id: 'frontend-components',
    title: '🧩 Frontend Component & Data Flow',
    description: 'React component hierarchy showing how data flows through the application.',
    mermaid: `graph TB
    App["App.tsx<br/>(Router)"]

    subgraph Pages["Pages"]
        Home["HomePage"]
        Game["CangkulanGame<br/>(Orchestrator)"]
        Lobby["GameLobby"]
        Stats["StatsPage"]
        Spectate["SpectatorView"]
        Tutorial["TutorialPage"]
        History["HistoryPage"]
        Arch["ArchitecturePage"]
    end

    subgraph GamePhases["Game Phases"]
        Create["CreatePhase"]
        Seed["SeedPhase"]
        Play["PlayingPhase"]
        Complete["CompletePhase"]
    end

    subgraph Shared["Shared Components"]
        Layout["Layout + NavBar"]
        Toast["Toast System"]
        TxLog["Transaction Log"]
        Cards["PlayingCard<br/>(React.memo)"]
        DealAnim["CardDealAnimation"]
        Timeout["TimeoutControls"]
        Emoji["EmojiReactions"]
    end

    subgraph Hooks["Custom Hooks"]
        WalletHook["useWallet"]
        ActionsHook["useCangkulanActions"]
        PollingHook["useSmartPolling"]
        NotifHook["useTurnNotification"]
    end

    subgraph State["State Management"]
        Zustand["Zustand Store<br/>(wallet slice)"]
        LocalStorage["localStorage<br/>(seeds, commits, history)"]
    end

    App --> Layout
    App --> Pages
    Game --> GamePhases
    Game --> ActionsHook
    Game --> PollingHook
    Game --> NotifHook
    ActionsHook --> Service["CangkulanService"]
    Play --> Cards
    Play --> Timeout
    Play --> Emoji
    Game --> DealAnim
    Game --> TxLog
    WalletHook --> Zustand
    ActionsHook --> LocalStorage`,
  },

  // ─── 5. ZK Seed Commitment Flow ─────────────────────────────────────────
  {
    id: 'zk-flow',
    title: '🔐 ZK Seed Commitment Flow',
    description: 'How Pedersen commitments and zero-knowledge proofs ensure provably fair shuffling.',
    mermaid: `sequenceDiagram
    participant Player as Player (Browser)
    participant LS as localStorage
    participant CC as Cangkulan Contract
    participant ZK as ZK Verifier Contract

    Note over Player: COMMIT PHASE

    Player->>Player: seed = random(32 bytes)
    Player->>Player: blinding = random(32 bytes)
    Player->>Player: seedHash = keccak256(seed)
    Player->>Player: commitHash = Pedersen(seedHash, blinding)
    Player->>LS: Save {seed, blinding}

    Player->>CC: commit_seed(commitHash)
    CC->>CC: Store commitHash

    Note over Player: REVEAL PHASE (after both commit)

    Player->>LS: Load {seed, blinding}
    Player->>Player: seedHash = keccak256(seed)
    Player->>Player: proof = buildPedersenProof(seedHash, blinding, sessionId, address)

    Player->>CC: reveal_seed(seedHash, proof)
    CC->>ZK: verify(publicInputs, proof)
    ZK-->>CC: true ✓
    CC->>CC: Store seedHash, mark revealed

    Note over CC: BOTH SEEDS REVEALED
    CC->>CC: combinedSeed = keccak256(seedHash1 ⊕ seedHash2)
    CC->>CC: Fisher-Yates shuffle with PRNG(combinedSeed)
    CC->>CC: Deal 5 cards each, 26 to draw pile`,
  },

  // ─── 6. Timeout & Dispute Resolution ─────────────────────────────────────
  {
    id: 'timeout-flow',
    title: '⏰ Timeout & Dispute Resolution',
    description: 'How the timeout mechanism prevents abandoned games from being stuck forever.',
    mermaid: `sequenceDiagram
    participant Active as Active Player
    participant SC as Contract
    participant Idle as Idle Player

    Note over Active, Idle: Normal game in progress...
    Note over Idle: Player goes offline / unresponsive

    Active->>SC: tick_timeout()
    SC->>SC: Record deadline_nonce = action_nonce + 1
    SC-->>Active: deadline_nonce set

    Note over Active: Wait for opponent action...
    Note over Idle: Still no action

    alt Opponent acts in time
        Idle->>SC: (any game action)
        SC->>SC: action_nonce increments
        Note over SC: Deadline naturally passes
    else Opponent doesn't act
        Active->>SC: resolve_timeout()
        SC->>SC: Verify action_nonce >= deadline_nonce
        SC->>SC: Forfeit idle player
        SC-->>Active: Game ended (Active wins)
    end`,
  },

  // ─── 7. Multi-Contract Architecture ──────────────────────────────────────
  {
    id: 'multi-contract',
    title: '📦 Multi-Contract Architecture',
    description: 'How the contracts interact on-chain. Auto-detection routes proofs by byte size. Supports Pedersen, Ring Sigma, Noir, and more ZK backends.',
    mermaid: `graph LR
    subgraph GameLayer["Game Layer"]
        CG["🎴 Cangkulan<br/>Game Logic<br/>~2,100 LOC"]
    end

    subgraph HubLayer["Lifecycle Layer"]
        GH["🎮 Game Hub<br/>start_game / end_game"]
    end

    subgraph ZKLayer["ZK Verification Layer"]
        ZKV["🔐 ZK Verifier<br/>4 modes · ~2,500 LOC"]
        UH["🌑 UltraHonk<br/>Noir SNARK verifier"]
    end

    subgraph RatingLayer["Rating Layer"]
        LB["🏆 Leaderboard<br/>ELO K=32/16"]
    end

    CG -->|"start_game()"| GH
    CG -->|"end_game()"| GH
    CG -->|"verify_*(proof)"| ZKV
    ZKV -->|"Noir proofs >4KB"| UH
    GH -->|"record_match()"| LB

    classDef game fill:#d1fae5,stroke:#059669,stroke-width:2px
    classDef hub fill:#dbeafe,stroke:#2563eb,stroke-width:2px
    classDef zk fill:#ede9fe,stroke:#7c3aed,stroke-width:2px
    classDef rating fill:#fef3c7,stroke:#d97706,stroke-width:2px

    class CG game
    class GH hub
    class ZKV,UH zk
    class LB rating`,
  },
];

// ─── ZK Mode Comparison Data ───────────────────────────────────────────────

interface ZkModeInfo {
  mode: number;
  name: string;
  curve: string;
  proofSize: string;
  useCase: string;
  testnet: boolean;
}

const ZK_MODES: ZkModeInfo[] = [
  { mode: 1, name: 'Card Verify', curve: 'keccak256', proofSize: '32 B', useCase: 'Basic card hash verification', testnet: true },
  { mode: 2, name: 'NIZK Seed', curve: 'keccak256', proofSize: '64 B', useCase: 'Cangkulan seed Schnorr NIZK (AI default)', testnet: true },
  { mode: 3, name: 'Legacy Hash', curve: 'keccak256', proofSize: '32 B', useCase: 'Legacy seed hash verify', testnet: true },
  { mode: 4, name: 'Pedersen+Sigma', curve: 'BLS12-381', proofSize: '224 B', useCase: 'EC seed commitment (multiplayer default)', testnet: true },
  { mode: 5, name: 'Groth16 BLS12-381', curve: 'BLS12-381', proofSize: '384 B', useCase: 'Groth16 SNARK (future)', testnet: false },
  { mode: 6, name: 'Groth16 BN254', curve: 'BN254', proofSize: '256 B', useCase: 'Groth16 SNARK (future)', testnet: false },
  { mode: 7, name: 'Ring Sigma Card Play', curve: 'BLS12-381', proofSize: 'variable', useCase: 'ZK card play compliance (card in set)', testnet: true },
  { mode: 8, name: 'Cangkul Hand Proof', curve: 'BLS12-381', proofSize: '228 B', useCase: 'ZK suit exclusion (must draw)', testnet: true },
  { mode: 9, name: 'Noir UltraHonk', curve: 'BN254', proofSize: '~14 KB', useCase: 'Full SNARK seed proof (Local Node only)', testnet: false },
];

// ─── Tint helpers (same pattern as other redesigned pages) ─────────────────
const tintCard = (accent: string): React.CSSProperties => ({
  background: `color-mix(in srgb, ${accent} 8%, var(--color-surface))`,
  border: `1px solid color-mix(in srgb, ${accent} 20%, var(--color-border))`,
  borderRadius: 12,
});

export function ArchitecturePage({ navigate }: ArchitecturePageProps) {
  return (
    <div className="space-y-5">
      {/* Hero */}
      <PageHero
        icon="📐"
        title="Architecture"
        subtitle="System diagrams for the Cangkulan on-chain card game"
        gradient="from-indigo-500 via-blue-500 to-cyan-500"
        navigate={navigate}
        backTo={{ page: 'home' }}
      />

      {/* Table of Contents */}
      <nav className="rounded-2xl p-5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--color-ink)' }}>Contents</h2>
        <ul className="grid sm:grid-cols-2 gap-2">
          {diagrams.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => document.getElementById(d.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="flex items-center gap-2 text-sm py-1 px-2 rounded-lg transition-colors w-full text-left cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                style={{ color: 'var(--color-accent)' }}
              >
                <span className="text-base leading-none" role="img">{d.title.match(/^\S+/)?.[0]}</span>
                <span>{d.title.replace(/^\S+\s*/, '')}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              onClick={() => document.getElementById('zk-modes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="flex items-center gap-2 text-sm py-1 px-2 rounded-lg transition-colors w-full text-left cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
              style={{ color: 'var(--color-accent)' }}
            >
              <span className="text-base leading-none" role="img">🔐</span>
              <span>ZK Verification Modes (8 modes)</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* Diagram Sections */}
      <div className="space-y-5">
        {diagrams.map((d) => (
          <section
            key={d.id}
            id={d.id}
            className="rounded-2xl p-5 sm:p-6"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          >
            <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-ink)' }}>{d.title}</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--color-ink-muted)' }}>{d.description}</p>

            {/* Mermaid diagram rendered as code block */}
            <div className="rounded-xl p-4 overflow-x-auto" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
              <pre className="text-xs sm:text-sm font-mono whitespace-pre leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
                {d.mermaid.trim()}
              </pre>
            </div>

            {/* Open in Mermaid Live */}
            <div className="mt-3 flex justify-end">
              <a
                href={`https://mermaid.live/edit#pako:${(() => { try { const json = JSON.stringify({ code: d.mermaid.trim() }); const bytes = new TextEncoder().encode(json); let out = ''; for (const b of bytes) out += String.fromCharCode(b); return btoa(out); } catch { return ''; } })()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-105 active:scale-95 no-underline"
                style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-ink-muted)' }}
              >
                🧜‍♂️ Open in Mermaid Live
              </a>
            </div>
          </section>
        ))}
      </div>

      {/* Footer note */}
      <div className="rounded-2xl p-4 text-sm" style={tintCard('#d97706')}>
        <span style={{ color: 'var(--color-ink)' }}>
          <strong>Tip:</strong> Click &ldquo;Open in Mermaid Live&rdquo; on any diagram to see the rendered visualization instantly.
        </span>
      </div>

      {/* ─── ZK Mode Comparison Table ─────────────────────────────────────── */}
      <section
        id="zk-modes"
        className="rounded-2xl p-5 sm:p-6"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-ink)' }}>🔐 ZK Verification Modes (8 modes)</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--color-ink-muted)' }}>
          The ZK Verifier contract supports multiple verification modes, auto-detected by proof byte length.
          Modes 1&ndash;4, 7&ndash;8 work on Stellar Testnet today. Noir UltraHonk is fully verified on Local Node, as its split-TX architecture (verify_noir_seed + reveal_seed) uses ~215M CPU, exceeding the public Testnet ~100M limit.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm border-collapse">
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th className="px-3 py-2 text-left font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>#</th>
                <th className="px-3 py-2 text-left font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>Mode</th>
                <th className="px-3 py-2 text-left font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>Curve / Hash</th>
                <th className="px-3 py-2 text-left font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>Proof Size</th>
                <th className="px-3 py-2 text-left font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>Use Case</th>
                <th className="px-3 py-2 text-center font-bold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>Testnet</th>
              </tr>
            </thead>
            <tbody>
              {ZK_MODES.map((m, i) => (
                <tr key={m.mode} style={{ background: i % 2 === 0 ? 'var(--color-surface)' : 'var(--color-bg)' }}>
                  <td className="px-3 py-2 font-mono font-bold" style={{ border: '1px solid var(--color-border)', color: '#6366f1' }}>{m.mode}</td>
                  <td className="px-3 py-2 font-semibold" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>{m.name}</td>
                  <td className="px-3 py-2" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink-muted)' }}>{m.curve}</td>
                  <td className="px-3 py-2 font-mono" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}>{m.proofSize}</td>
                  <td className="px-3 py-2" style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink-muted)' }}>{m.useCase}</td>
                  <td className="px-3 py-2 text-center" style={{ border: '1px solid var(--color-border)' }}>{m.testnet ? '✅' : '⚠️'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-[11px]" style={{ color: 'var(--color-ink-muted)' }}>
          ⚠️ = Exceeds Soroban Testnet public CPU budget. Requires Local Node (unlimited CPU) for full on-chain computation.
        </div>

        {/* Auto-detection */}
        <div className="mt-4 p-4 rounded-xl" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
          <h3 className="text-sm font-bold mb-2" style={{ color: 'var(--color-ink)' }}>Auto-Detection by Proof Size</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {[
              { size: '32 B', label: 'Card / Legacy', color: '#6366f1' },
              { size: '64 B', label: 'NIZK Hash', color: '#0891b2' },
              { size: '224 B', label: 'Pedersen+Sigma', color: '#2563eb' },
              { size: '228 B', label: 'Cangkul Hand', color: '#7c3aed' },
              { size: 'variable', label: 'Ring Sigma', color: '#ea580c' },
              { size: '384 B', label: 'Groth16 BLS ⚠️', color: '#059669' },
              { size: '256 B', label: 'Groth16 BN254 ⚠️', color: '#d97706' },
              { size: '>4 KB', label: 'Noir UltraHonk ⚠️', color: '#7c3aed' },
            ].map((item) => (
              <div key={item.label} className="p-2 rounded-lg text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
                <div className="font-mono font-bold" style={{ color: item.color }}>{item.size}</div>
                <div className="mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Noir Circuit Info */}
        <div className="mt-4 p-4 rounded-xl" style={tintCard('#7c3aed')}>
          <h3 className="text-sm font-bold mb-2" style={{ color: 'var(--color-ink)' }}>🌑 Noir Circuit: Dual-Constraint Seed Verification</h3>
          <div className="text-xs space-y-1.5" style={{ color: 'var(--color-ink-muted)' }}>
            <p><strong>File:</strong> <code style={{ background: 'var(--color-bg)', padding: '0 4px', borderRadius: 4 }}>circuits/seed_verify/src/main.nr</code></p>
            <p>The Noir circuit proves <strong>two properties</strong> simultaneously in zero knowledge:</p>
            <ol className="list-decimal list-inside ml-2 space-y-0.5">
              <li><code style={{ background: 'var(--color-bg)', padding: '0 4px', borderRadius: 4 }}>blake2s(seed) == seed_hash</code> &mdash; preimage knowledge</li>
              <li><code style={{ background: 'var(--color-bg)', padding: '0 4px', borderRadius: 4 }}>seed[0..4] != [0,0,0,0]</code> &mdash; in-circuit entropy check</li>
            </ol>
            <p className="mt-1.5">
              A valid proof guarantees the seed has non-trivial randomness without revealing the seed itself.
              Compiled with <strong>nargo 1.0.0-beta.9</strong>, proved with <strong>@aztec/bb.js 0.87.0</strong> (UltraKeccakHonk).
              6 circuit tests pass (3 positive + 3 negative).
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default ArchitecturePage;
