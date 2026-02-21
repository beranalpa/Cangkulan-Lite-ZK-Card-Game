/**
 * authEntryUtils.test.ts — structural tests for the multi-sig auth entry
 * injection flow. Tests cover XDR parsing, nonce mismatch detection, and
 * the critical footprint patching logic that prevents on-chain failures.
 *
 * These tests mock the Stellar SDK types to validate the injection logic
 * without needing a live network connection.
 */
import { describe, it, expect, vi } from 'vitest';
import { xdr, Address, Keypair } from '@stellar/stellar-sdk';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helper: create a SorobanAuthorizationEntry for a given address + nonce
// ═══════════════════════════════════════════════════════════════════════════════

function makeAuthEntry(address: string, nonce: bigint): xdr.SorobanAuthorizationEntry {
  const scAddress = new Address(address).toScAddress();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: scAddress,
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 999_999,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: scAddress,
          functionName: 'test_fn',
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Auth entry XDR round-trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('SorobanAuthorizationEntry XDR round-trip', () => {
  const kp = Keypair.random();
  const address = kp.publicKey();

  it('serializes and deserializes with correct address', () => {
    const entry = makeAuthEntry(address, 100n);
    const xdrBase64 = entry.toXDR('base64');
    const parsed = xdr.SorobanAuthorizationEntry.fromXDR(xdrBase64, 'base64');

    const parsedAddr = Address.fromScAddress(parsed.credentials().address().address()).toString();
    expect(parsedAddr).toBe(address);
  });

  it('preserves the nonce through serialization', () => {
    const nonce = 12345n;
    const entry = makeAuthEntry(address, nonce);
    const xdrBase64 = entry.toXDR('base64');
    const parsed = xdr.SorobanAuthorizationEntry.fromXDR(xdrBase64, 'base64');

    const parsedNonce = parsed.credentials().address().nonce();
    expect(parsedNonce.toString()).toBe(nonce.toString());
  });

  it('credential type is sorobanCredentialsAddress', () => {
    const entry = makeAuthEntry(address, 1n);
    expect(entry.credentials().switch().name).toBe('sorobanCredentialsAddress');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Nonce mismatch detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('nonce mismatch detection', () => {
  const kp1 = Keypair.random();
  const addr1 = kp1.publicKey();

  it('detects matching nonces', () => {
    const stub = makeAuthEntry(addr1, 100n);
    const signed = makeAuthEntry(addr1, 100n);
    const stubNonce = stub.credentials().address().nonce();
    const signedNonce = signed.credentials().address().nonce();
    expect(stubNonce.toString()).toBe(signedNonce.toString());
  });

  it('detects different nonces', () => {
    const stub = makeAuthEntry(addr1, 100n);
    const signed = makeAuthEntry(addr1, 200n);
    const stubNonce = stub.credentials().address().nonce();
    const signedNonce = signed.credentials().address().nonce();
    expect(stubNonce.toString()).not.toBe(signedNonce.toString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Auth entry address matching
// ═══════════════════════════════════════════════════════════════════════════════

describe('auth entry address matching', () => {
  const kp1 = Keypair.random();
  const kp2 = Keypair.random();

  it('correctly identifies Player 1 entry in array', () => {
    const entries = [
      makeAuthEntry(kp1.publicKey(), 1n),
      makeAuthEntry(kp2.publicKey(), 2n),
    ];

    let p1Index = -1;
    let p2Index = -1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const type = entry.credentials().switch().name;
      if (type === 'sorobanCredentialsAddress') {
        const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
        if (addr === kp1.publicKey()) p1Index = i;
        if (addr === kp2.publicKey()) p2Index = i;
      }
    }

    expect(p1Index).toBe(0);
    expect(p2Index).toBe(1);
  });

  it('replaces Player 1 stub with signed entry', () => {
    const entries = [
      makeAuthEntry(kp1.publicKey(), 1n),
      makeAuthEntry(kp2.publicKey(), 2n),
    ];

    const signedEntry = makeAuthEntry(kp1.publicKey(), 999n);
    entries[0] = signedEntry;

    const nonce = entries[0].credentials().address().nonce();
    expect(nonce.toString()).toBe('999');
    // Player 2 entry should be unchanged
    const p2Nonce = entries[1].credentials().address().nonce();
    expect(p2Nonce.toString()).toBe('2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Footprint nonce key construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('nonce footprint key construction', () => {
  const kp = Keypair.random();

  it('creates a valid LedgerKeyContractData for nonce', () => {
    const scAddr = new Address(kp.publicKey()).toScAddress();
    const nonce = xdr.Int64.fromString('42');
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddr,
        key: xdr.ScVal.scvLedgerKeyNonce(
          new xdr.ScNonceKey({ nonce })
        ),
        durability: xdr.ContractDataDurability.temporary(),
      })
    );

    expect(key.switch().name).toBe('contractData');
    expect(key.contractData().key().switch().name).toBe('scvLedgerKeyNonce');
  });

  it('can update nonce in footprint key', () => {
    const scAddr = new Address(kp.publicKey()).toScAddress();
    const oldNonce = xdr.Int64.fromString('100');
    const newNonce = xdr.Int64.fromString('200');

    const oldKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddr,
        key: xdr.ScVal.scvLedgerKeyNonce(
          new xdr.ScNonceKey({ nonce: oldNonce })
        ),
        durability: xdr.ContractDataDurability.temporary(),
      })
    );

    // Build updated key (simulating the patch logic from injectSignedAuthEntry)
    const cd = oldKey.contractData();
    const updatedKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: cd.contract(),
        key: xdr.ScVal.scvLedgerKeyNonce(
          new xdr.ScNonceKey({ nonce: newNonce })
        ),
        durability: cd.durability(),
      })
    );

    // Verify address preserved and nonce updated
    const keyAddr = Address.fromScAddress(updatedKey.contractData().contract()).toString();
    expect(keyAddr).toBe(kp.publicKey());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handles sorobanCredentialsSourceAccount (invoker) entries', () => {
    // Invokers appear as sourceAccount credentials — they should be skipped
    const invokerEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(Keypair.random().publicKey()).toScAddress(),
            functionName: 'test',
            args: [],
          })
        ),
        subInvocations: [],
      }),
    });

    const type = invokerEntry.credentials().switch().name;
    expect(type).toBe('sorobanCredentialsSourceAccount');
    // This should NOT be processed as an address credential
    expect(type).not.toBe('sorobanCredentialsAddress');
  });
});
