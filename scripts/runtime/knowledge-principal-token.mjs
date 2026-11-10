/** Prints a new random API token and the SHA-256 digest that goes into KNOWLEDGE_API_PRINCIPALS_FILE.
 * Give the token to that principal's client only; the principals file keeps just the digest. */
import {createHash,randomBytes} from 'node:crypto';
const token=randomBytes(32).toString('base64url');
process.stdout.write(`${JSON.stringify({token,tokenSha256:createHash('sha256').update(token,'utf8').digest('hex')},null,2)}\n`);
