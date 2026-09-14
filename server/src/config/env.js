import dotenv from 'dotenv';

dotenv.config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const list = (value) => (value || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// The session and token-encryption secrets have development fallbacks so the app starts on a
// laptop without setup. Anywhere real they are a hole: with the fallback JWT secret, anyone can
// mint an admin session. Render does not guarantee NODE_ENV=production, so "real" is also
// recognised by RENDER / RENDER_EXTERNAL_URL, which Render always sets.
const DEV_SECRETS = {
  JWT_SECRET: 'dev-only-change-me',
  TOKEN_ENCRYPTION_KEY: 'dev-only-32-char-change-me-please!!',
};
const isDeployed = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
function secret(name) {
  const value = required(name, DEV_SECRETS[name]);
  if (isDeployed && value === DEV_SECRETS[name]) {
    throw new Error(`${name} is not set. Refusing to start a deployed server with the public development fallback.`);
  }
  return value;
}

// The OAuth redirect URIs default to localhost for development. The Sep 2026 move to
// salasar-dashboard.onrender.com shipped with a server/.env copied into Render, localhost URIs
// and all: the server started, CORS passed, and every sign-in sent Google's reply to
// localhost:5001 on the user's own machine. On Render the server knows its public URL, so a
// URI there that is unset or still points at localhost is always a mistake — derive it
// instead, and say so in the log. (Google still has to list the result as an authorised
// redirect URI on the OAuth client.)
const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
function redirectUri(name, path) {
  const configured = process.env[name];
  const pointsAtLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(configured || '');
  if (renderUrl && (!configured || pointsAtLocalhost)) {
    const derived = `${renderUrl}${path}`;
    console.warn(`[env] ${name} is ${configured ? `"${configured}"` : 'unset'} on Render — using ${derived}`);
    return derived;
  }
  return required(name, `http://localhost:5001${path}`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5001),

  mongoUri: required('MONGODB_URI'),

  googleClientId: required('GOOGLE_CLIENT_ID'),
  googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  googleLoginRedirectUri: redirectUri('GOOGLE_LOGIN_REDIRECT_URI', '/api/auth/google/callback'),
  googleDriveRedirectUri: redirectUri('GOOGLE_DRIVE_REDIRECT_URI', '/api/auth/google/connect-drive/callback'),
  gmailSendRedirectUri: redirectUri('GMAIL_SEND_REDIRECT_URI', '/api/auth/google/connect-gmail/callback'),

  jwtSecret: secret('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  tokenEncryptionKey: secret('TOKEN_ENCRYPTION_KEY'),

  adminEmails: list(process.env.ADMIN_EMAILS),

  // Who may sign in at all. Before this, any Google account on the internet could sign in and
  // read every figure (SECURITY_REPORT SEC-01). Allowed: any verified address at one of these
  // domains, any address listed in ALLOWED_LOGIN_EMAILS, and every admin and the email sender.
  // ALLOWED_LOGIN_DOMAINS=* restores the old open behaviour, deliberately and visibly.
  allowedLoginDomains: list(process.env.ALLOWED_LOGIN_DOMAINS ?? 'salasartechno.com'),
  allowedLoginEmails: list(process.env.ALLOWED_LOGIN_EMAILS),

  // Compared character for character with the browser's Origin header (CORS, CSRF check,
  // socket.io), which never carries a trailing slash — "https://x.vercel.app/" would fail
  // every request.
  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, ''),

  hsdSpreadsheetId: required('HSD_SPREADSHEET_ID', '1-O9T8zA4yAFYzq9LW2fgn5hIdy7MsAPq'),
  // Drive folder holding the monthly Dispatch Synopsis workbooks — one .xlsx per month,
  // separate from the single live HSD workbook above. Every file in it is read on each sync,
  // so a new month appears on the dashboard as soon as it is dropped in the folder.
  synopsisFolderId: process.env.SYNOPSIS_FOLDER_ID || '1RBlqtBL3l2qnyKxRzF0FZ_p7ruYKQRni',
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || 10),

  geminiApiKey: process.env.GEMINI_API_KEY || null,

  emailUser: process.env.EMAIL_USER || null,

  // Render sets this automatically for web services — no manual config needed. Used to
  // self-ping and avoid the free-tier's spin-down-after-idle cold start (see jobs/keepAlive.js).
  publicUrl: process.env.RENDER_EXTERNAL_URL || null,
};

// One rule, used at sign-in and again on every request, so narrowing the list also ends
// sessions that were issued before the change.
export function isAllowedLogin(email) {
  const normalized = (email || '').toLowerCase();
  if (!normalized) return false;
  if (env.adminEmails.includes(normalized) || normalized === env.emailUser?.toLowerCase()) return true;
  if (env.allowedLoginEmails.includes(normalized)) return true;
  if (env.allowedLoginDomains.includes('*')) return true;
  return env.allowedLoginDomains.includes(normalized.split('@')[1]);
}

export function roleFor(email) {
  return env.adminEmails.includes((email || '').toLowerCase()) ? 'admin' : 'manager';
}
