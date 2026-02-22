import { useMemo, useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  QR Code Generator — pure TypeScript SVG output, no external deps
//  Uses a minimal QR encoding for alphanumeric/byte mode, version auto-select.
//  Simplified implementation covering typical URL lengths (up to ~300 chars).
// ═══════════════════════════════════════════════════════════════════════════════

// --- Reed-Solomon / QR internals (minimal implementation) ---

// For simplicity, we use a well-known approach: generate the QR matrix
// using a lightweight algorithm. Since full QR encoding is ~1000 LOC,
// we use a compact generator pattern.

// This is a self-contained QR encoder covering versions 1-10 (up to ~271 bytes at L EC level).

const EC_POLY: Record<number, number[]> = {};

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function rsGenPoly(n: number): number[] {
  if (EC_POLY[n]) return EC_POLY[n];
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  EC_POLY[n] = poly;
  return poly;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenPoly(ecLen);
  const msg = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// QR version info (version, total data codewords at EC level L, EC codewords per block, num blocks)
const VERSION_INFO: [number, number, number, number][] = [
  [1, 19, 7, 1], [2, 34, 10, 1], [3, 55, 15, 1], [4, 80, 20, 1],
  [5, 108, 26, 1], [6, 136, 18, 2], [7, 156, 20, 2], [8, 194, 24, 2],
  [9, 232, 30, 2], [10, 274, 18, 4],
];

function selectVersion(dataLen: number): number {
  for (const [ver, cap] of VERSION_INFO) {
    // Byte mode: 4 bits mode + 8/16 bits length + data, subtract overhead
    const overhead = ver >= 10 ? 4 : 3; // bytes for mode+length
    if (cap - overhead >= dataLen) return ver;
  }
  return 10; // max we support
}

function getVersionInfo(ver: number) {
  return VERSION_INFO[ver - 1];
}

function encodeData(text: string): { version: number; codewords: number[] } {
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes.length);
  const [, totalData, ecPerBlock, numBlocks] = getVersionInfo(version);
  const dataPerBlock = Math.floor(totalData / numBlocks) - ecPerBlock;

  // Encode in byte mode (mode 0100)
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // byte mode
  const lenBits = version >= 10 ? 16 : 8;
  pushBits(bytes.length, lenBits);
  for (const b of bytes) pushBits(b, 8);

  // Terminator
  const totalBits = totalData * 8;
  const termLen = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Convert to bytes
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    dataBytes.push(b);
  }

  // Pad bytes
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (dataBytes.length < totalData - ecPerBlock * numBlocks) {
    dataBytes.push(padBytes[padIdx % 2]);
    padIdx++;
  }

  // Split into blocks and add EC
  const allData: number[][] = [];
  const allEc: number[][] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const blockData = dataBytes.slice(offset, offset + dataPerBlock);
    offset += dataPerBlock;
    const ec = rsEncode(blockData, ecPerBlock);
    allData.push(blockData);
    allEc.push(ec);
  }

  // Interleave
  const result: number[] = [];
  const maxDataLen = Math.max(...allData.map(d => d.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of allData) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of allEc) {
      if (i < block.length) result.push(block[i]);
    }
  }

  return { version, codewords: result };
}

function createMatrix(version: number): { size: number; matrix: (0 | 1 | null)[][] } {
  const size = version * 4 + 17;
  const matrix: (0 | 1 | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  // Finder patterns
  const drawFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          const isEdge = r === 0 || r === 6 || c === 0 || c === 6;
          const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          matrix[rr][cc] = (isEdge || isCenter) ? 1 : 0;
        } else {
          matrix[rr][cc] = 0;
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0 ? 1 : 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Dark module
  matrix[size - 8][8] = 1;

  // Alignment patterns (version >= 2)
  if (version >= 2) {
    const positions = getAlignmentPositions(version);
    for (const r of positions) {
      for (const c of positions) {
        if (matrix[r][c] !== null) continue; // skip if overlaps finder
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            matrix[r + dr][c + dc] = (isEdge || isCenter) ? 1 : 0;
          }
        }
      }
    }
  }

  return { size, matrix };
}

function getAlignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const positions: number[] = [6];
  const last = version * 4 + 10;
  if (version >= 7) {
    const step = Math.ceil((last - 6) / 3) & ~1 || 2;
    for (let p = last; p > 6; p -= step) positions.unshift(p);
  } else {
    positions.push(last);
  }
  return positions;
}

function placeData(matrix: (0 | 1 | null)[][], codewords: number[], size: number) {
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= size) continue;
        if (matrix[row][c] !== null) continue;
        matrix[row][c] = (bitIdx < bits.length ? bits[bitIdx] : 0) as 0 | 1;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix: (0 | 1 | null)[][], size: number, reserved: boolean[][]) {
  // Use mask 0: (row + col) % 2 === 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if ((r + c) % 2 === 0) {
        matrix[r][c] = (matrix[r][c] === 1 ? 0 : 1) as 0 | 1;
      }
    }
  }
}

function placeFormatInfo(matrix: (0 | 1 | null)[][], size: number) {
  // EC level L (01), mask 0 (000) → format bits = 01000
  // After BCH encoding, the 15-bit format string for L/mask0 is:
  const FORMAT_BITS = 0b111011111000100; // pre-computed for EC=L, mask=0
  const bits: number[] = [];
  for (let i = 14; i >= 0; i--) bits.push((FORMAT_BITS >> i) & 1);

  // Horizontal
  for (let i = 0; i < 8; i++) {
    const c = i < 6 ? i : i + 1;
    matrix[8][c] = bits[i] as 0 | 1;
  }
  for (let i = 8; i < 15; i++) {
    matrix[8][size - 15 + i] = bits[i] as 0 | 1;
  }

  // Vertical
  for (let i = 0; i < 7; i++) {
    matrix[size - 1 - i][8] = bits[i] as 0 | 1;
  }
  for (let i = 7; i < 15; i++) {
    const r = i < 9 ? 15 - i : 14 - i;
    matrix[r][8] = bits[i] as 0 | 1;
  }
}

function generateQRMatrix(text: string): { matrix: (0 | 1)[]; size: number } {
  const { version, codewords } = encodeData(text);
  const { size, matrix } = createMatrix(version);

  // Mark reserved areas
  const reserved = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => matrix[r][c] !== null)
  );

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (i < size) { reserved[8][i] = true; reserved[i][8] = true; }
    if (size - 1 - i >= 0) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  }

  placeData(matrix, codewords, size);
  applyMask(matrix, size, reserved);
  placeFormatInfo(matrix, size);

  // Flatten
  const flat: (0 | 1)[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      flat.push((matrix[r][c] ?? 0) as 0 | 1);
    }
  }

  return { matrix: flat, size };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  React Component
// ═══════════════════════════════════════════════════════════════════════════════

interface QRCodeProps {
  text: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
}

export function QRCode({ text, size: displaySize = 200, fgColor = '#000000', bgColor = '#ffffff' }: QRCodeProps) {
  const qr = useMemo(() => generateQRMatrix(text), [text]);
  const cellSize = displaySize / (qr.size + 2); // +2 for quiet zone

  return (
    <svg
      width={displaySize}
      height={displaySize}
      viewBox={`0 0 ${displaySize} ${displaySize}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`QR code for: ${text.slice(0, 50)}...`}
    >
      <rect width={displaySize} height={displaySize} fill={bgColor} />
      {qr.matrix.map((val, i) => {
        if (!val) return null;
        const row = Math.floor(i / qr.size);
        const col = i % qr.size;
        return (
          <rect
            key={i}
            x={(col + 1) * cellSize}
            y={(row + 1) * cellSize}
            width={cellSize}
            height={cellSize}
            fill={fgColor}
          />
        );
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  QR Invite Modal
// ═══════════════════════════════════════════════════════════════════════════════

interface QRInviteModalProps {
  url: string;
  onClose: () => void;
}

export function QRInviteModal({ url, onClose }: QRInviteModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4 slide-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-black text-gray-900">📱 QR Code Invite</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            style={{ background: 'none', border: 'none', padding: '4px 8px', minWidth: 'auto', minHeight: 'auto' }}
          >
            ✕
          </button>
        </div>

        <div className="flex justify-center mb-4">
          <div className="p-3 bg-white rounded-xl border-2 border-gray-100 shadow-inner">
            <QRCode text={url} size={220} />
          </div>
        </div>

        <p className="text-xs text-gray-500 text-center mb-4">
          Scan this QR code to join the game as Player 2
        </p>

        <div className="space-y-2">
          <div className="p-2 bg-gray-50 rounded-lg border border-gray-200">
            <code className="text-xs text-gray-600 break-all block max-h-16 overflow-auto">{url}</code>
          </div>
          <button
            onClick={handleCopy}
            className="w-full py-2.5 rounded-lg font-bold text-sm bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-600 hover:to-teal-600 transition-all shadow-md"
          >
            {copied ? '✓ Copied!' : '📋 Copy URL'}
          </button>
        </div>
      </div>
    </div>
  );
}
