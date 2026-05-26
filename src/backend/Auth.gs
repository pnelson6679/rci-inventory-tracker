/**
 * Auth.gs — Google sign-in (OpenID, email scope only) + stateless session tokens.
 *
 * WHY THIS EXISTS
 *   The web app is deployed "Execute as: me" so that photo uploads land in the
 *   owner's Drive and only the owner needs BigQuery access. The price of that
 *   choice is that Session.getActiveUser().getEmail() comes back EMPTY for any
 *   visitor on a different domain (i.e. every consumer @gmail.com that isn't the
 *   owner). So we cannot read the visitor's identity from the Session.
 *
 *   Instead we run our own lightweight "Sign in with Google" flow that requests
 *   only the non-sensitive `openid email` scopes. The visitor proves who they are,
 *   we check that email against CONFIG.ALLOWLIST, and we hand back a short-lived,
 *   HMAC-signed session token. The browser stores that token and replays it on
 *   every google.script.run call; each server endpoint calls requireAuth_(token)
 *   before doing any work.
 *
 * SETUP (one time) — three Script Properties must be set (see README "Sign-in setup"):
 *   OAUTH_CLIENT_ID      — Web OAuth client ID used only for sign-in
 *   OAUTH_CLIENT_SECRET  — that client's secret
 *   SESSION_SECRET       — any long random string (run generateSessionSecret() to make one)
 */

/** How long a session token stays valid, in seconds (12 hours). */
var SESSION_TTL_SECONDS = 12 * 60 * 60;

/** How long a sign-in `state` value stays valid, in seconds (10 minutes). */
var STATE_TTL_SECONDS = 10 * 60;

/* -------------------------------------------------------------------------- */
/* Config accessors                                                           */
/* -------------------------------------------------------------------------- */

function authProps_() {
  return PropertiesService.getScriptProperties();
}

function oauthClientId_() {
  return authProps_().getProperty('OAUTH_CLIENT_ID') || '';
}

function oauthClientSecret_() {
  return authProps_().getProperty('OAUTH_CLIENT_SECRET') || '';
}

function sessionSecret_() {
  var s = authProps_().getProperty('SESSION_SECRET');
  if (!s) {
    throw new Error('SESSION_SECRET is not set. Run generateSessionSecret() once, then set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET in Project Settings → Script Properties.');
  }
  return s;
}

/** The deployed web app /exec URL — used as the OAuth redirect_uri. */
function webAppUrl_() {
  return ScriptApp.getService().getUrl();
}

/**
 * Run this ONCE from the Apps Script editor (Run ▸ generateSessionSecret).
 * It writes a fresh random SESSION_SECRET to Script Properties and logs it.
 * Safe to re-run, but doing so invalidates everyone's existing sessions.
 */
function generateSessionSecret() {
  var secret = Utilities.getUuid() + Utilities.getUuid();
  authProps_().setProperty('SESSION_SECRET', secret);
  Logger.log('SESSION_SECRET set. (You do not need to copy this anywhere.)');
  return 'OK';
}

/* -------------------------------------------------------------------------- */
/* Sign-in URL                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds the Google sign-in URL the visitor is sent to. Requests only
 * `openid email` (non-sensitive — no app verification required, no test-user cap).
 */
function buildAuthUrl_() {
  var params = {
    client_id: oauthClientId_(),
    redirect_uri: webAppUrl_(),
    response_type: 'code',
    scope: 'openid email',
    state: makeState_(),
    prompt: 'select_account',
    access_type: 'online'
  };
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + qs;
}

/* -------------------------------------------------------------------------- */
/* OAuth callback handling (called from doGet when ?code= is present)         */
/* -------------------------------------------------------------------------- */

/**
 * Exchanges the auth code for tokens, extracts the verified email, and checks
 * the allowlist. Returns a small status object that doGet acts on:
 *
 *   { status: 'ok',     token, email }  → mint a session; render the app
 *   { status: 'denied', email }         → show the "not on the list" page
 *   { status: 'error' }                 → fall back to the normal shell
 *
 * NOTE: we deliberately do NOT return an HTML page that tries to redirect the
 * browser. The Apps Script sandbox iframe blocks a script from navigating the
 * top window without a user click, which left users stuck on a blank page.
 * Instead doGet renders the app directly and injects the token inline.
 */
function handleOAuthSignin_(p) {
  // CSRF: the state we issued must verify and not be expired.
  if (!p.state || !verifyState_(p.state)) {
    Logger.log('Sign-in: missing/expired state.');
    return { status: 'error' };
  }

  var tokenResp;
  try {
    tokenResp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        code: p.code,
        client_id: oauthClientId_(),
        client_secret: oauthClientSecret_(),
        redirect_uri: webAppUrl_(),
        grant_type: 'authorization_code'
      }
    });
  } catch (err) {
    Logger.log('Sign-in: token endpoint unreachable: ' + err);
    return { status: 'error' };
  }

  if (tokenResp.getResponseCode() !== 200) {
    // Most common while debugging: client ID/secret mismatch or redirect_uri not
    // registered. Also fires harmlessly when an already-used code is replayed
    // (e.g. the user refreshed the ?code= URL).
    Logger.log('Sign-in: token exchange HTTP ' + tokenResp.getResponseCode() + ' — ' + tokenResp.getContentText());
    return { status: 'error' };
  }

  var idToken = (JSON.parse(tokenResp.getContentText()) || {}).id_token;
  var claims = idToken ? decodeJwtPayload_(idToken) : null;
  var email = claims && claims.email ? String(claims.email).toLowerCase() : '';
  var verified = claims && (claims.email_verified === true || claims.email_verified === 'true');

  if (!email || !verified) {
    Logger.log('Sign-in: no verified email in id_token.');
    return { status: 'error' };
  }

  if (!isAllowed_(email)) {
    return { status: 'denied', email: email };
  }

  return { status: 'ok', token: makeSessionToken_(email), email: email };
}

/** The "your account isn't on the access list" page (static, no redirect needed). */
function accessDeniedPage_(email) {
  return authMessagePage_(
    'Access denied',
    'The account <b>' + escapeForHtml_(email) + '</b> is not on the access list. Ask the fleet admin to add you.',
    true
  );
}

/** Small standalone HTML page for sign-in errors / notices. */
function authMessagePage_(title, bodyHtml, showRetry) {
  var retry = showRetry
    ? '<p style="margin-top:18px"><a href="' + escapeForHtml_(webAppUrl_()) + '" target="_top">Back to sign in</a></p>'
    : '';
  var html = '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 20px;text-align:center;color:#222">' +
    '<h2>' + escapeForHtml_(title) + '</h2><p>' + bodyHtml + '</p>' + retry +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* -------------------------------------------------------------------------- */
/* Session tokens (stateless, HMAC-signed)                                    */
/* Format:  base64url(JSON{email,exp}) + "." + base64url(HMAC_SHA256(payload)) */
/* -------------------------------------------------------------------------- */

function makeSessionToken_(email) {
  var payload = { email: String(email).toLowerCase(), exp: nowSec_() + SESSION_TTL_SECONDS };
  var body = b64uEncode_(JSON.stringify(payload));
  return body + '.' + sign_(body);
}

/**
 * Verifies a session token's signature and expiry.
 * @return {string} the lowercased email if valid, else '' .
 */
function verifySessionToken_(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return '';
  var parts = token.split('.');
  if (parts.length !== 2) return '';
  var body = parts[0], sig = parts[1];
  if (!constantTimeEquals_(sig, sign_(body))) return '';
  var payload;
  try { payload = JSON.parse(b64uDecode_(body)); } catch (e) { return ''; }
  if (!payload || !payload.email || !payload.exp) return '';
  if (nowSec_() > Number(payload.exp)) return '';
  return String(payload.email).toLowerCase();
}

/**
 * Gate used by EVERY client-callable endpoint. Validates the session token and
 * re-checks the allowlist (so removing someone from CONFIG.ALLOWLIST locks them
 * out immediately, even with an unexpired token). Throws on failure — the thrown
 * message surfaces in the frontend's .catch().
 * @return {string} the authenticated, allowlisted email.
 */
function requireAuth_(token) {
  var email = verifySessionToken_(token);
  if (!email) throw new Error('AUTH_REQUIRED');
  if (!isAllowed_(email)) throw new Error('AUTH_FORBIDDEN');
  return email;
}

/**
 * Client-callable: lets the freshly-booted page validate a stored token without
 * doing real work. Returns the email if the token is good, or null if not (so the
 * client shows the sign-in screen instead of an error).
 */
function whoami(token) {
  var email = verifySessionToken_(token);
  if (!email || !isAllowed_(email)) return null;
  return { email: email };
}

/* -------------------------------------------------------------------------- */
/* CSRF state (signed, expiring)                                              */
/* -------------------------------------------------------------------------- */

function makeState_() {
  var body = b64uEncode_(JSON.stringify({ n: Utilities.getUuid(), exp: nowSec_() + STATE_TTL_SECONDS }));
  return body + '.' + sign_(body);
}

function verifyState_(state) {
  if (!state || state.indexOf('.') < 0) return false;
  var parts = state.split('.');
  if (parts.length !== 2) return false;
  if (!constantTimeEquals_(parts[1], sign_(parts[0]))) return false;
  var payload;
  try { payload = JSON.parse(b64uDecode_(parts[0])); } catch (e) { return false; }
  return payload && payload.exp && nowSec_() <= Number(payload.exp);
}

/* -------------------------------------------------------------------------- */
/* Low-level crypto / encoding helpers                                        */
/* -------------------------------------------------------------------------- */

function nowSec_() { return Math.floor(Date.now() / 1000); }

/** HMAC-SHA256(body, SESSION_SECRET) as web-safe base64 (no padding). */
function sign_(body) {
  var raw = Utilities.computeHmacSha256Signature(body, sessionSecret_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}

/** Constant-time string comparison to avoid signature timing leaks. */
function constantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function b64uEncode_(str) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(str).getBytes()).replace(/=+$/, '');
}

function b64uDecode_(b64u) {
  var pad = b64u.length % 4;
  var padded = b64u + (pad ? Array(5 - pad).join('=') : '');
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
}

/** Decode (without re-verifying) the payload of a JWT received directly from Google over TLS. */
function decodeJwtPayload_(jwt) {
  var parts = String(jwt).split('.');
  if (parts.length < 2) return null;
  try { return JSON.parse(b64uDecode_(parts[1])); } catch (e) { return null; }
}

/** Minimal HTML escaper for the few server-rendered strings in this file. */
function escapeForHtml_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
