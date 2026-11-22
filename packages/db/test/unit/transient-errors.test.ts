import { describe, expect, it } from 'vitest';
import { isTransientDatabaseError } from '../../src/index.js';

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isTransientDatabaseError', () => {
  it.each([
    ['connection refused', withCode('ECONNREFUSED')],
    ['connection reset', withCode('ECONNRESET')],
    ['timeout', withCode('ETIMEDOUT')],
    ['DNS failure', withCode('ENOTFOUND')],
    ['SQLSTATE connection exception (08006)', withCode('08006')],
    ['too many connections (53300)', withCode('53300')],
    ['server shutting down (57P01)', withCode('57P01')],
    ['statement timeout (57014)', withCode('57014')],
    ['deadlock (40P01)', withCode('40P01')],
    ['serialisation failure (40001)', withCode('40001')],
    ['pool exhausted', new Error('timeout exceeded when trying to connect')],
    ['dropped connection', new Error('Connection terminated unexpectedly')],
  ])('treats %s as transient', (_name, error) => {
    expect(isTransientDatabaseError(error)).toBe(true);
  });

  it.each([
    ['unique violation (23505)', withCode('23505')],
    ['foreign key violation (23503)', withCode('23503')],
    ['undefined table (42P01)', withCode('42P01')],
    ['syntax error (42601)', withCode('42601')],
    ['an ordinary bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a string', 'ECONNREFUSED'],
    ['null', null],
    ['undefined', undefined],
  ])('does not treat %s as transient, so real bugs stay visible as 500s', (_name, error) => {
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});
