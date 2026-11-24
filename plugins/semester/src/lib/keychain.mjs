// macOS Keychain access through /usr/bin/security. Secrets are never printed or logged.
import { execFileSync } from 'node:child_process';

/** Returns the secret, or null if the item is missing (or `security` is unavailable). */
export function readSecret(service, account) {
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 15000,
    });
    return out.replace(/\r?\n$/, '') || null;
  } catch {
    return null;
  }
}
