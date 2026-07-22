/**
 * Generate a PBKDF2 password hash and write a ready-to-run SQL file for
 * provisioning a staff account.
 *
 * There is no self-serve signup route by design, so staff are created by
 * hashing a password here and inserting the row directly into D1.
 *
 * Uses Web Crypto (globalThis.crypto), the same API the Worker uses — so the
 * output is byte-for-byte compatible with src/services/password.ts.
 *
 * WHY A FILE INSTEAD OF A PASTEABLE --command:
 * The hash format is `pbkdf2$sha256$<iters>$<salt>$<key>`. Those '$' signs are
 * variable sigils in PowerShell AND in bash double quotes, so a pasted inline
 * command silently mangles the hash (PowerShell turns $sha256 into "") and the
 * account is created with a corrupt hash that can never authenticate.
 * Writing a .sql file and using --file avoids shell quoting entirely.
 *
 * ⚠️ DO NOT PASS THE PASSWORD AS AN ARGUMENT if it contains '$' or a backtick.
 * The shell substitutes those BEFORE node runs, so the hash ends up matching a
 * different string than the one typed — login then fails with an unhelpful 401.
 * Prefer the PowerShell wrapper, which prompts securely and pipes via stdin:
 *
 *   Create:  powershell -File scripts/new-staff.ps1
 *   Reset:   powershell -File scripts/new-staff.ps1 -Reset -Email a@b.my
 *
 * Direct use (password read from stdin, never from argv):
 *
 *   'MyPassword123' | node scripts/hash-password.mjs \
 *        --email aina@ifixexpress.com.my --branch 1 --role admin
 *
 *   'NewPassword123' | node scripts/hash-password.mjs --update --email a@b.my
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


// MUST match MAX_WORKERS_ITERATIONS in src/services/password.ts.
// The Workers production runtime rejects PBKDF2 above 100,000 iterations
// ("iteration counts above 100000 are not supported"), while wrangler dev
// --local accepts anything — so a higher value here produces hashes that
// verify locally and fail every login in production.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const ROLES = ['admin', 'technician', 'staff'];

const args = process.argv.slice(2);
const inlinePassword = args[0] && !args[0].startsWith('--') ? args[0] : null;

/**
 * Read the password from stdin.
 *
 * Deliberately a plain stream read rather than an interactive readline
 * prompt: readline masking behaves differently across TTY and piped input,
 * and an interactive prompt that silently fails to resolve is worse than no
 * prompt at all. Secure prompting is delegated to the PowerShell wrapper
 * (scripts/new-staff.ps1), which uses Read-Host -AsSecureString.
 */
function readPasswordFromStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(
        new Error(
          'No password supplied on stdin.\n\n' +
            'Use the PowerShell wrapper, which prompts securely:\n' +
            '  powershell -File scripts/new-staff.ps1\n\n' +
            'Or pipe it in:\n' +
            "  'MyPassword123' | node scripts/hash-password.mjs --email a@b.my --branch 1 --role admin",
        ),
      );
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      // PowerShell prepends a UTF-8 BOM (U+FEFF) when piping to a native
      // command. Left in place it becomes part of the password, so the hash
      // silently stops matching what the user actually typed.
      // Trailing newline is added by the pipe itself, not by the user.
      resolve(data.replace(/^﻿/, '').replace(/\r?\n$/, ''));
    });
    process.stdin.on('error', reject);
  });
}

/** Read `--flag value` from argv. */
const opt = (flag, fallback) => {
  const i = args.indexOf(`--${flag}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const isUpdate = args.includes('--update');
const name = opt('name', 'Full Name');
const email = opt('email', 'person@ifixexpress.com.my').trim().toLowerCase();
const branchId = opt('branch', '1');
const role = opt('role', 'staff');

if (isUpdate && !args.includes('--email')) {
  console.error('--update requires --email <the account to reset>');
  process.exit(1);
}

if (!isUpdate && !ROLES.includes(role)) {
  console.error(`Invalid role "${role}". Must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}
if (!isUpdate && !Number.isInteger(Number(branchId))) {
  console.error(`Invalid branch "${branchId}". Must be an integer branches.id.`);
  process.exit(1);
}

// ── Password ────────────────────────────────────────────────────────────────
let password = inlinePassword;

if (password) {
  // Warn loudly: by the time node sees it the shell has already substituted.
  if (/[$`]/.test(password)) {
    console.warn(
      `\n⚠️  The password argument contains '$' or a backtick. Your shell may have\n` +
        `   already rewritten it, in which case this hash will NOT match what you\n` +
        `   type at login. Re-run without the argument to be prompted instead.\n`,
    );
  }
} else {
  try {
    password = await readPasswordFromStdin();
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}

if (!password || password.length < 10) {
  console.error(
    '\nPassword must be at least 10 characters (matches the API minimum).',
  );
  process.exit(1);
}

// ── Hash ────────────────────────────────────────────────────────────────────
const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

const keyMaterial = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(password),
  'PBKDF2',
  false,
  ['deriveBits'],
);

const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  keyMaterial,
  KEY_BITS,
);

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const hash = `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;

// ── Write SQL ───────────────────────────────────────────────────────────────
// SQLite escapes a single quote by doubling it.
const sq = (v) => `'${String(v).replace(/'/g, "''")}'`;

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'generated');
mkdirSync(outDir, { recursive: true });
const fileName = isUpdate ? 'reset_password.sql' : 'create_staff.sql';
const outFile = join(outDir, fileName);

const sql = isUpdate
  ? `-- Generated by scripts/hash-password.mjs — contains a password hash.
-- Gitignored. Delete after running.
--
-- Resets the password for an existing account. Also reactivates it, since a
-- deactivated account cannot log in no matter how correct the password is.

UPDATE staff
   SET password_hash = ${sq(hash)},
       is_active = 1
 WHERE lower(email) = ${sq(email)};
`
  : `-- Generated by scripts/hash-password.mjs — contains a password hash.
-- Gitignored. Delete after running.
--
-- The branch_id below must exist in branches(id), or the insert fails.
--   npx wrangler d1 execute repairtrack-db --remote --command="SELECT id, name FROM branches;"

INSERT INTO staff (name, email, password_hash, branch_id, role, is_active)
VALUES (${sq(name)}, ${sq(email)}, ${sq(hash)}, ${branchId}, ${sq(role)}, 1);
`;

writeFileSync(outFile, sql, 'utf8');

console.log(
  isUpdate
    ? `
✅ Wrote src/db/generated/${fileName}

   Resetting password for: ${email}

Run it against production:

  npx wrangler d1 execute repairtrack-db --remote --file=./src/db/generated/${fileName}

Confirm it matched exactly one row ("rows_written": 1), then test and delete:

  powershell -File scripts/smoke-login.ps1
  Remove-Item src/db/generated/${fileName}
`
    : `
✅ Wrote src/db/generated/${fileName}

   Name   : ${name}
   Email  : ${email}
   Branch : ${branchId}
   Role   : ${role}

Run it against production:

  npx wrangler d1 execute repairtrack-db --remote --file=./src/db/generated/${fileName}

Then verify, and delete the file (it contains a password hash):

  npx wrangler d1 execute repairtrack-db --remote --command="SELECT id, name, email, role, branch_id FROM staff;"
  Remove-Item src/db/generated/${fileName}
`,
);
