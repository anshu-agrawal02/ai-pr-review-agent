const crypto = require('crypto');
const { verifySignature } = require('../signature');

const SECRET = 'test-secret';
const BODY = Buffer.from(JSON.stringify({ action: 'opened', number: 2 }));

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  test('accepts a correctly signed payload', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  test('rejects a payload that was modified after signing', () => {
    const tampered = Buffer.from(JSON.stringify({ action: 'opened', number: 3 }));
    expect(verifySignature(tampered, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  test('rejects a signature made with the wrong secret', () => {
    expect(verifySignature(BODY, sign(BODY, 'other-secret'), SECRET)).toBe(false);
  });

  test('rejects a missing signature header', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
  });

  test('rejects a signature of the wrong length without crashing', () => {
    expect(verifySignature(BODY, 'sha256=abc', SECRET)).toBe(false);
  });

  test('rejects everything if the server has no secret configured', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), undefined)).toBe(false);
  });
});