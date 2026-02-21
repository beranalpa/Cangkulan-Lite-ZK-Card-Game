#!/usr/bin/env bun
import { Keypair, TransactionBuilder, hash, rpc, Address, authorizeEntry, Networks } from '@stellar/stellar-sdk';
import { Client as CangkulanClient } from '../bindings/cangkulan/src/index';
import type { CangkulanGame } from '../bindings/cangkulan/src/index';
import { Buffer } from 'buffer';
import { keccak256 } from 'js-sha3';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { readEnvFile, getEnvValue } from './utils/env';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Load ENV
const REPO_ROOT = join(import.meta.dir, '..');
const envContent = await readEnvFile(join(REPO_ROOT, '.env'));
const RPC_URL = getEnvValue(envContent, 'VITE_SOROBAN_RPC_URL') || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = getEnvValue(envContent, 'VITE_NETWORK_PASSPHRASE') || Networks.TESTNET;
const CONTRACT_ID = getEnvValue(envContent, 'VITE_CANGKULAN_CONTRACT_ID')!;
const WS_URL = getEnvValue(envContent, 'VITE_WS_LOBBY_URL') || 'ws://localhost:8787/ws';

const isLocalNode = RPC_URL.includes('localhost') || RPC_URL.includes('127.0.0.1');
const FRIENDBOT_URL = isLocalNode ? 'http://localhost:8000/friendbot' : 'https://friendbot.stellar.org';

const LIFECYCLE = { SEED_COMMIT: 1, SEED_REVEAL: 2, PLAYING: 3, FINISHED: 4 } as const;
const CANNOT_FOLLOW_SENTINEL = 0xFFFFFFFF;

const c = { dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m', yellow: '\x1b[33m' };
function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

// --- Crypto ---
function keccak(data: Uint8Array): Buffer { return Buffer.from(keccak256(data), 'hex'); }
function generateRandomBytes(len: number) { return new Uint8Array(randomBytes(len)); }
function bufferToFr(buf: Uint8Array): bigint { return bytesToNumberBE(buf) % bls12_381.fields.Fr.ORDER; }
function g1ToBytes96(point: any) { const aff = point.toAffine(); const out = new Uint8Array(96); out.set(numberToBytesBE(aff.x, 48), 0); out.set(numberToBytesBE(aff.y, 48), 48); return out; }
function pedersenH() { return bls12_381.G1.hashToCurve(new TextEncoder().encode('PEDERSEN_H'), { DST: new TextEncoder().encode('SGS_CANGKULAN_V1') }); }

function buildPedersenProof(seedHash: Buffer, blinding: Uint8Array, sessionId: number, playerAddress: string) {
  const s = bufferToFr(seedHash); const r = bufferToFr(blinding);
  const G = bls12_381.G1.Point.BASE; const H = pedersenH();
  const cBytes = g1ToBytes96(G.multiply(s).add(H.multiply(r) as any));
  const kRaw = generateRandomBytes(32); const k = bufferToFr(kRaw);
  const rBytes = g1ToBytes96(H.multiply(k));
  const addressBytes = new TextEncoder().encode(playerAddress);
  const sidBuf = new Uint8Array(4); new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x50, 0x34]);

  const pre = new Uint8Array(96 + 96 + 32 + 4 + addressBytes.length + 4);
  let off = 0; pre.set(cBytes, off); off += 96; pre.set(rBytes, off); off += 96; pre.set(seedHash, off); off += 32; pre.set(sidBuf, off); off += 4; pre.set(addressBytes, off); off += addressBytes.length; pre.set(tag, off);

  const e = bufferToFr(keccak(pre));
  const z_r = (k + e * r) % bls12_381.fields.Fr.ORDER;

  const proof = Buffer.alloc(224);
  Buffer.from(cBytes).copy(proof, 0); Buffer.from(rBytes).copy(proof, 96); Buffer.from(numberToBytesBE(z_r, 32)).copy(proof, 192);
  return proof;
}

const computeC = (id: number, salt: Uint8Array) => { const pb = Buffer.alloc(36); pb.writeUInt32BE(id, 0); Buffer.from(salt).copy(pb, 4); return keccak(pb); };

// --- Clients ---
function makeClient(kp: Keypair) {
  return new CangkulanClient({
    contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL, publicKey: kp.publicKey(),
    signTransaction: async (txXdr, opts) => { const tx = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase ?? NETWORK_PASSPHRASE); tx.sign(kp); return { signedTxXdr: tx.toXDR(), signerAddress: kp.publicKey() }; },
    signAuthEntry: async (preXdr) => { const sig = kp.sign(hash(Buffer.from(preXdr, 'base64'))); return { signedAuthEntry: Buffer.from(sig).toString('base64'), signerAddress: kp.publicKey() }; }
  });
}
function makeReadClient() { return new CangkulanClient({ contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL }); }
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fundWallet(pub: string) { try { await fetch(`${FRIENDBOT_URL}?addr=${pub}`); } catch { } }
async function getGame(sid: number): Promise<CangkulanGame | null> { try { const res = await makeReadClient().get_game({ session_id: sid }).then(tx => tx.simulate()); return res.result.isOk() ? res.result.unwrap() : null; } catch { return null; } }
async function getGameView(sid: number, viewer: string): Promise<CangkulanGame | null> { try { const res = await makeReadClient().get_game_view({ session_id: sid, viewer }).then(tx => tx.simulate()); return res.result.isOk() ? res.result.unwrap() : null; } catch { return null; } }

async function signAndSend(tx: any) {
  for (let i = 0; i < 3; i++) {
    try { const sim = await tx.simulate(); try { return await sim.signAndSend(); } catch (e: any) { if (e.message?.includes('NoSignatureNeeded')) return await sim.signAndSend({ force: true }); throw e; } }
    catch (e) { if (i < 2) await sleep(3000); else throw e; }
  }
}

// --- Battle Logic ---
async function playSingleBattle(p1: Keypair, p2: Keypair, sid: number) {
  const short1 = p1.publicKey().slice(0, 6); const short2 = p2.publicKey().slice(0, 6);
  log(`${c.cyan}${c.bold}⚔️ BATTLE START: ${short1} vs ${short2} (Session ${sid})${c.reset}`);

  // 1. Start Game
  const c2 = makeClient(p2);
  const txStart = await c2.start_game({ session_id: sid, player1: p1.publicKey(), player2: p2.publicKey(), player1_points: 100n, player2_points: 100n }, { timeoutInSeconds: 120 });
  const authEntries = txStart.simulationData!.result!.auth;
  const server = new rpc.Server(RPC_URL);
  const validUntil = (await server.getLatestLedger()).sequence + 100;
  for (let i = 0; i < authEntries.length; i++) {
    if (authEntries[i].credentials().switch().name === 'sorobanCredentialsAddress' && Address.fromScAddress(authEntries[i].credentials().address().address()).toString() === p1.publicKey()) {
      authEntries[i] = await authorizeEntry(authEntries[i], async pre => p1.sign(hash(pre.toXDR())), validUntil, NETWORK_PASSPHRASE);
    }
  }
  (txStart as any).built.operations[0].auth = authEntries;
  const txObj = TransactionBuilder.fromXDR(txStart.toXDR(), NETWORK_PASSPHRASE); txObj.sign(p2);
  const sr = await server.sendTransaction(txObj);
  let gr = await server.getTransaction(sr.hash); while (gr.status === 'NOT_FOUND') { await sleep(2000); gr = await server.getTransaction(sr.hash); }
  log(`${c.green}✅ Game initialized on-chain${c.reset}`);

  // 2. Commit & Reveal Seeds
  const s1 = generateRandomBytes(32), s2 = generateRandomBytes(32), b1 = generateRandomBytes(32), b2 = generateRandomBytes(32);
  const c1 = makeClient(p1);
  const p1Hash = computeCParams(s1, b1); const p2Hash = computeCParams(s2, b2);
  await signAndSend(await c1.commit_seed({ session_id: sid, player: p1.publicKey(), commit_hash: p1Hash }, { timeoutInSeconds: 120 }));
  await signAndSend(await c2.commit_seed({ session_id: sid, player: p2.publicKey(), commit_hash: p2Hash }, { timeoutInSeconds: 120 }));

  await signAndSend(await c1.reveal_seed({ session_id: sid, player: p1.publicKey(), seed_hash: keccak(s1), proof: buildPedersenProof(keccak(s1), b1, sid, p1.publicKey()) }, { timeoutInSeconds: 120 }));
  await signAndSend(await c2.reveal_seed({ session_id: sid, player: p2.publicKey(), seed_hash: keccak(s2), proof: buildPedersenProof(keccak(s2), b2, sid, p2.publicKey()) }, { timeoutInSeconds: 120 }));
  log(`${c.green}✅ ZK Seeds (Pedersen) committed & revealed. Cards Dealt.${c.reset}`);

  // 3. Play Tricks
  let trickCount = 0;
  while (true) {
    let g = await getGame(sid);
    if (!g || g.lifecycle_state === LIFECYCLE.FINISHED) break;
    if (g.trick_suit == null && g.flipped_card == null) { await sleep(2000); continue; }

    trickCount++;
    const v1 = await getGameView(sid, p1.publicKey()); const v2 = await getGameView(sid, p2.publicKey());
    const ch1 = chooseCard(v1?.hand1 as number[] || [], g.trick_suit ?? 0); const ch2 = chooseCard(v2?.hand2 as number[] || [], g.trick_suit ?? 0);

    const salt1 = generateRandomBytes(32), salt2 = generateRandomBytes(32);
    try { await signAndSend(await c1.commit_play({ session_id: sid, player: p1.publicKey(), commit_hash: computeC(ch1.cardId, salt1), expected_nonce: g.action_nonce }, { timeoutInSeconds: 120 })); } catch (e: any) { if (!e.message.includes('FINISHED')) throw e; }

    g = await getGame(sid); if (!g || g.lifecycle_state === LIFECYCLE.FINISHED) break;
    try { await signAndSend(await c2.commit_play({ session_id: sid, player: p2.publicKey(), commit_hash: computeC(ch2.cardId, salt2), expected_nonce: g.action_nonce }, { timeoutInSeconds: 120 })); } catch (e: any) { if (!e.message.includes('FINISHED')) throw e; }

    try { await signAndSend(await c1.reveal_play({ session_id: sid, player: p1.publicKey(), card_id: ch1.cardId, salt: Buffer.from(salt1) }, { timeoutInSeconds: 120 })); } catch { }
    try { await signAndSend(await c2.reveal_play({ session_id: sid, player: p2.publicKey(), card_id: ch2.cardId, salt: Buffer.from(salt2) }, { timeoutInSeconds: 120 })); } catch { }
    log(`Trick ${trickCount}: P1→${ch1.cardId === CANNOT_FOLLOW_SENTINEL ? 'Cangkul!' : ch1.cardId} | P2→${ch2.cardId === CANNOT_FOLLOW_SENTINEL ? 'Cangkul!' : ch2.cardId}`);
  }

  const fg = await getGame(sid);
  const winner = fg?.outcome === 1 ? short1 : fg?.outcome === 2 ? short2 : 'Draw';
  log(`${c.cyan}${c.bold}🏆 Battle Over! Winner: ${winner} (${trickCount} tricks)${c.reset}`);
}

function computeCParams(s: Uint8Array, b: Uint8Array) {
  return Buffer.from(keccak256(g1ToBytes96(bls12_381.G1.Point.BASE.multiply(bufferToFr(keccak(s))).add(pedersenH().multiply(bufferToFr(b)) as any))), 'hex');
}
function chooseCard(hand: number[], s: number) {
  const m = hand.filter(c => Math.floor(c / 9) === s);
  if (m.length === 0) return { cardId: CANNOT_FOLLOW_SENTINEL, canFollow: false };
  return { cardId: m.sort((a, b) => (b % 9) - (a % 9))[0], canFollow: true };
}

async function main() {
  log(`${c.yellow}${c.bold}Initializing 25 Wallets...${c.reset}`);
  const wallets = Array.from({ length: 25 }).map(() => Keypair.random());

  const botNames = ["AlphaBot", "BetaBot", "GammaBot", "DeltaBot", "EchoBot", "ZetaBot", "ThetaBot", "IotaBot", "KappaBot", "LambdaBot", "MuBot", "NuBot", "XiBot", "OmicronBot", "PiBot", "RhoBot", "SigmaBot", "TauBot", "UpsilonBot", "PhiBot", "ChiBot", "PsiBot", "OmegaBot", "AstroBot", "NovaBot"];

  log(`${c.yellow}${c.bold}Funding wallets (in batches)...${c.reset}`);
  for (let i = 0; i < wallets.length; i += 5) {
    await Promise.all(wallets.slice(i, i + 5).map(w => fundWallet(w.publicKey())));
    await sleep(2000); // Prevent Friendbot rate limits
  }
  log(`${c.yellow}${c.bold}25 Wallets Funded. Starting Infinite Battle Loop (Integrated with Lobby)...${c.reset}`);

  // Internal connection cache
  const wsConns: Map<string, WebSocket> = new Map();

  // Authenticate and connect
  for (let i = 0; i < wallets.length; i++) {
    const kp = wallets[i];
    const pub = kp.publicKey();

    // Auth Challenge for Lobby
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => { log(`[WS] ${botNames[i]} connected, waiting for challenge...`); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.type === 'auth-challenge') {
          ws.send(JSON.stringify({
            type: 'join',
            payload: { address: pub, challenge: msg.payload.challenge, name: botNames[i] }
          }));
        } else if (msg.type === 'joined') {
          log(`[WS] ${botNames[i]} authenticated with lobby`);
        } else {
          log(`[WS] ${botNames[i]} received: ${JSON.stringify(msg)}`);
        }
      } catch (err) {
        log(`${c.red}[WS] error parsing message: ${err}${c.reset}`);
      }
    };
    ws.onerror = (e: any) => log(`${c.red}[WS] error: ${e.message || 'connection failed'}${c.reset}`);
    wsConns.set(pub, ws);
  }

  // Wait for connections briefly
  await sleep(3000);

  let battleCount = 0;
  while (true) {
    battleCount++;
    const [p1, p2] = [...wallets].sort(() => Math.random() - 0.5);
    const sid = 600000 + Math.floor(Math.random() * 300000);

    // Simulate matchmaking
    const ws1 = wsConns.get(p1.publicKey());
    const ws2 = wsConns.get(p2.publicKey());
    if (ws1 && ws1.readyState === WebSocket.OPEN) ws1.send(JSON.stringify({ type: 'queue-join' }));
    await sleep(200);
    if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'queue-join' }));

    // The server will match them if they are the only two in queue.
    // However, our script plays them together deterministically.
    log(`${c.dim}[WS] ${p1.publicKey().slice(0, 6)} & ${p2.publicKey().slice(0, 6)} entered matchmaking queue${c.reset}`);
    await sleep(2000);

    try {
      if (ws1 && ws1.readyState === WebSocket.OPEN) ws1.send(JSON.stringify({ type: 'game-started', payload: { sessionId: sid } }));
      if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'game-started', payload: { sessionId: sid } }));

      await playSingleBattle(p1, p2, sid);

      if (ws1 && ws1.readyState === WebSocket.OPEN) ws1.send(JSON.stringify({ type: 'game-ended' }));
      if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'game-ended' }));
    } catch (e: any) {
      log(`${c.red}Battle interrupted: ${e.message}${c.reset}`);
      if (ws1 && ws1.readyState === WebSocket.OPEN) ws1.send(JSON.stringify({ type: 'game-ended' }));
      if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'game-ended' }));
    }
    log(`${c.yellow}⏳ Battle #${battleCount} done. Waiting 1 minute...${c.reset}`);
    await sleep(60_000);
  }
}

main();
