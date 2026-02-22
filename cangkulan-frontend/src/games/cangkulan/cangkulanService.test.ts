/**
 * cangkulanService.test.ts — unit tests for error formatting and translation
 */
import { describe, it, expect } from 'vitest';
import { CangkulanService } from './cangkulanService';

// ═══════════════════════════════════════════════════════════════════════════════
//  translateContractError
// ═══════════════════════════════════════════════════════════════════════════════

describe('CangkulanService.translateContractError', () => {
  it.each([
    [1, 'Game not found'],
    [2, 'Session already exists'],
    [3, 'Not a player'],
    [4, 'Self-play not allowed'],
    [5, 'Game already ended'],
    [6, 'Wrong phase'],
    [7, 'Seed already committed'],
    [8, 'Seed already revealed'],
    [9, 'Commit hash mismatch'],
    [10, 'Invalid ZK proof'],
    [11, 'Missing commit'],
    [12, 'Not your turn'],
    [13, 'Card not in hand'],
    [14, 'Wrong suit'],
    [15, 'Has matching suit'],
    [16, 'Draw pile empty'],
    [17, 'No trick in progress'],
    [18, 'Admin not set'],
    [19, 'Game Hub not set'],
    [20, 'Verifier not set'],
    [21, 'Timeout not reached'],
    [22, 'Timeout not configured'],
    [23, 'Timeout not applicable'],
    [24, 'Weak seed entropy'],
    [25, 'Invalid nonce'],
    [26, 'Play commit already submitted'],
    [27, 'Play commit missing'],
    [28, 'Play reveal mismatch'],
    [29, 'Invalid card ID'],
  ])('error code %i maps to a message containing "%s"', (code, expectedSubstring) => {
    const msg = CangkulanService.translateContractError(code);
    expect(msg.toLowerCase()).toContain(expectedSubstring.toLowerCase());
  });

  it('returns "Unknown contract error #999" for unmapped codes', () => {
    expect(CangkulanService.translateContractError(999)).toBe('Unknown contract error #999');
  });

  it('returns unknown for code 0', () => {
    expect(CangkulanService.translateContractError(0)).toContain('Unknown');
  });

  it('returns unknown for negative code', () => {
    expect(CangkulanService.translateContractError(-1)).toContain('Unknown');
  });

  it('all 29 error codes produce non-empty strings', () => {
    for (let i = 1; i <= 29; i++) {
      const msg = CangkulanService.translateContractError(i);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toContain('Unknown');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  extractErrorCode
// ═══════════════════════════════════════════════════════════════════════════════

describe('CangkulanService.extractErrorCode', () => {
  it('extracts from "Error(Contract, #2)"', () => {
    expect(CangkulanService.extractErrorCode('Error(Contract, #2)')).toBe(2);
  });

  it('extracts from "Error(Contract, #14)"', () => {
    expect(CangkulanService.extractErrorCode('Error(Contract, #14)')).toBe(14);
  });

  it('extracts from "Contract, #7" (simulation format)', () => {
    expect(CangkulanService.extractErrorCode('Contract, #7')).toBe(7);
  });

  it('extracts from complex message with Error(Contract, #29)', () => {
    const msg = 'Transaction failed: HostError: Event: Error(Contract, #29), at line 500';
    expect(CangkulanService.extractErrorCode(msg)).toBe(29);
  });

  it('returns null for no error code', () => {
    expect(CangkulanService.extractErrorCode('Something went wrong')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(CangkulanService.extractErrorCode('')).toBeNull();
  });

  it('returns null for generic "#" without Contract prefix', () => {
    expect(CangkulanService.extractErrorCode('Error #5')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  formatError
// ═══════════════════════════════════════════════════════════════════════════════

describe('CangkulanService.formatError', () => {
  it('translates Error(Contract, #6) to user-friendly message', () => {
    const err = new Error('HostError: Error(Contract, #6)');
    const msg = CangkulanService.formatError(err);
    expect(msg.toLowerCase()).toContain('wrong phase');
  });

  it('translates simulation failure with #13', () => {
    const err = new Error('simulation failed: HostError #13');
    const msg = CangkulanService.formatError(err);
    expect(msg.toLowerCase()).toContain('card not in hand');
  });

  it('passes through non-contract errors unchanged', () => {
    const err = new Error('Network timeout');
    expect(CangkulanService.formatError(err)).toBe('Network timeout');
  });

  it('handles string error', () => {
    expect(CangkulanService.formatError('raw string error')).toBe('raw string error');
  });

  it('handles non-Error objects', () => {
    expect(CangkulanService.formatError({ code: 42 })).toBe('{"code":42}');
  });

  it('handles null/undefined gracefully', () => {
    expect(CangkulanService.formatError(null)).toBe('null');
    expect(CangkulanService.formatError(undefined)).toBe('undefined');
  });

  it('translates Error(Contract, #1) as game not found', () => {
    const msg = CangkulanService.formatError(new Error('Error(Contract, #1)'));
    expect(msg.toLowerCase()).toContain('game not found');
  });

  it('handles #39+ in simulation failed as passthrough', () => {
    const msg = CangkulanService.formatError(new Error('simulation failed: #99'));
    // code 99 is out of range (1-38), should pass through
    expect(msg).toContain('simulation failed');
  });

  it('handles code within range in simulation failed', () => {
    const msg = CangkulanService.formatError(new Error('simulation failed: something #25'));
    expect(msg.toLowerCase()).toContain('invalid nonce');
  });
});
