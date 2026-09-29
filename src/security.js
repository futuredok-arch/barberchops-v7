'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024, keylen: 64 };

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifySecret(secret, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(secret, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}
// used when the account does not exist, so response time doesn't reveal which accounts exist
let DUMMY = null;
async function burnTime(secret) { if (!DUMMY) DUMMY = await hashSecret('dummy-secret'); await verifySecret(String(secret || ''), DUMMY); }

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

module.exports = { hashSecret, verifySecret, burnTime, randomToken, sha256, randomId };
