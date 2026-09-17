import { randomBytes } from 'node:crypto';
console.log('Use separate generated values for each client and webhook destination.');
console.log(randomBytes(48).toString('base64url'));
