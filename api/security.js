import { promisify } from 'node:util';
import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const scrypt = promisify(scryptCallback);
const ADJECTIVES = ['Brave', 'Clever', 'Cosmic', 'Crimson', 'Flying', 'Golden', 'Iron', 'Jade', 'Lucky', 'Mighty', 'Quiet', 'Rapid', 'Silver', 'Stormy', 'Swift'];
const NOUNS = ['Bento', 'Dragon', 'Fox', 'Ninja', 'Otter', 'Panda', 'Penguin', 'Ramen', 'Salmon', 'Shark', 'Sushi', 'Tiger', 'Turtle', 'Wasabi', 'Whale'];

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateCredentials(username, password) {
  const cleanUsername = String(username || '').trim();
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(cleanUsername)) {
    return { error: 'Username must be 3–24 letters, numbers, underscores or hyphens.' };
  }
  const length = [...String(password || '')].length;
  if (length < 10 || length > 128) return { error: 'Password must be 10–128 characters.' };
  return { username: cleanUsername, usernameKey: normalizeUsername(cleanUsername), password: String(password) };
}

function scryptOptions(overrides = {}) {
  const N = Number(overrides.N || process.env.SGL_SCRYPT_N || 32768);
  const r = Number(overrides.r || process.env.SGL_SCRYPT_R || 8);
  const p = Number(overrides.p || process.env.SGL_SCRYPT_P || 3);
  const maxmem = Math.max(64 * 1024 * 1024, 256 * N * r);
  return { N, r, p, maxmem };
}

export async function hashPassword(password, overrides) {
  const salt = randomBytes(16);
  const options = scryptOptions(overrides);
  const derived = await scrypt(String(password), salt, 32, options);
  return `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded).split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(String(password), Buffer.from(saltText, 'base64url'), expected.length, scryptOptions({ N:Number(n), r:Number(r), p:Number(p) }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function verifyToken(token, expectedHash) {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function makeRecoveryCode() {
  return randomBytes(16).toString('hex').match(/.{4}/g).join('-');
}

export function makeDisplayName() {
  // Public names are deliberately unrelated to the private login. The five
  // digit suffix also keeps collisions rare enough that a UNIQUE index plus
  // a short retry loop can guarantee that every leaderboard name is distinct.
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${NOUNS[randomInt(NOUNS.length)]} ${String(randomInt(0, 100_000)).padStart(5, '0')}`;
}
