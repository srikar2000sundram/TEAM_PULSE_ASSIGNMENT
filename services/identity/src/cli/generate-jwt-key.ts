import { generateKeyPairSync } from 'node:crypto';

/**
 * `node dist/cli/generate-jwt-key.js`: prints a fresh RSA signing key pair.
 *
 * Put the PRIVATE key in Secrets Manager as JWT_PRIVATE_KEY_PEM. The public key is not needed for
 * normal operation (the service derives and publishes it), but keep it if this key will later be
 * retired, so it can be listed in JWT_PREVIOUS_PUBLIC_KEYS_PEM during rotation.
 * Output goes to standard output only; nothing is written to disk or logs.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });

process.stdout.write(
  [
    '# JWT_PRIVATE_KEY_PEM (secret, store in Secrets Manager)',
    privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    '# Public key (for JWT_PREVIOUS_PUBLIC_KEYS_PEM when this key is retired)',
    publicKey.export({ type: 'spki', format: 'pem' }) as string,
  ].join('\n'),
);
