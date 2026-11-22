import { describe, expect, it } from 'vitest';
import { deterministicUuid } from '../src/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deterministicUuid', () => {
  it('gives the same id for the same seed, every time', () => {
    expect(deterministicUuid('streak:abc')).toBe(deterministicUuid('streak:abc'));
  });

  it('gives different ids for different seeds', () => {
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
    expect(deterministicUuid('streak:abc')).not.toBe(deterministicUuid('badge:abc'));
  });

  it('is a well-formed version 5 style UUID with the RFC variant', () => {
    for (const seed of ['', 'x', 'a much longer seed with spaces and ünïcode', '0'.repeat(500)]) {
      expect(deterministicUuid(seed)).toMatch(UUID);
    }
  });
});
