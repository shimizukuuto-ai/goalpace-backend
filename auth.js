const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// 自前セッショントークンの署名用シークレット。本番では必ず長いランダム文字列を
// .env の SESSION_JWT_SECRET に設定すること（無いと毎回自動生成＝再起動でログアウトされる）。
const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

// あなたのアプリの Bundle ID（Xcodeの Signing & Capabilities で確認できる）。
// Appleが発行するidentityTokenの "aud"（audience）と一致している必要がある。
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID;

const appleJwks = jwksClient({ jwksUri: 'https://appleid.apple.com/auth/keys' });

function getAppleSigningKey(header, callback) {
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// iOSアプリからもらった identityToken (Appleが署名したJWT) を検証し、
// 検証OKなら Appleユーザーの一意なID(sub)を返す。
function verifyAppleIdentityToken(identityToken) {
  return new Promise((resolve, reject) => {
    if (!APPLE_BUNDLE_ID) {
      return reject(new Error('APPLE_BUNDLE_ID is not set in .env'));
    }
    jwt.verify(
      identityToken,
      getAppleSigningKey,
      {
        algorithms: ['RS256'],
        audience: APPLE_BUNDLE_ID,
        issuer: 'https://appleid.apple.com',
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded.sub); // これがApple側のユーザー一意ID
      }
    );
  });
}

// 自前のセッショントークンを発行（以降のAPIリクエストはこれをAuthorizationヘッダで送る）
function issueSessionToken(userId) {
  return jwt.sign({ userId }, SESSION_JWT_SECRET, { expiresIn: '180d' });
}

function verifySessionToken(token) {
  return jwt.verify(token, SESSION_JWT_SECRET); // throws if invalid/expired
}

// Express middleware: Authorization: Bearer <token> を検証し、req.userId にセットする。
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'AUTH_REQUIRED: ログインが必要です。' });
  }
  try {
    const decoded = verifySessionToken(token);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'AUTH_INVALID: セッションが無効です。再ログインしてください。' });
  }
}

module.exports = {
  verifyAppleIdentityToken,
  issueSessionToken,
  verifySessionToken,
  requireAuth,
};
