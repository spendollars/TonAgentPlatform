/**
 * Fragment Service — Per-user MTProto client management
 *
 * Each user gets their own GramJS TelegramClient + StringSession stored in DB.
 * Legacy singleton is kept for gift data functions (uses any available user session).
 */

import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import fs from 'fs';
import path from 'path';
import { StringSession } from 'telegram/sessions';

// ── Telegram App credentials ──────────────────────────────────────
const API_ID   = parseInt(process.env.TG_API_ID   || '2040');
const API_HASH =          process.env.TG_API_HASH  || 'b18441a1ff607e10a989891a5462e627';

// ── Per-user client pool ──────────────────────────────────────────
interface UserClient {
  client: TelegramClient;
  connected: boolean;
  lastUsed: number;
  userId: number;
}

const userClients = new Map<number, UserClient>();

// Evict idle clients every 10 min (idle > 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [uid, uc] of userClients) {
    if (now - uc.lastUsed > 30 * 60 * 1000) {
      try { uc.client.disconnect(); } catch {}
      userClients.delete(uid);
      console.log(`[Fragment] Evicted idle client for user ${uid}`);
    }
  }
}, 10 * 60 * 1000);

// ── DB Session Storage ────────────────────────────────────────────
// Uses user_settings table: key='tg_mtproto_session'

let _settingsRepo: any = null;

export function initFragmentDB(repo: any) {
  _settingsRepo = repo;
}

async function loadUserSession(userId: number): Promise<string> {
  if (!_settingsRepo) return '';
  try {
    const data = await _settingsRepo.get(userId, 'tg_mtproto_session');
    return data?.sessionString || '';
  } catch { return ''; }
}

async function saveUserSession(userId: number, sessionString: string, extra?: Record<string, any>) {
  if (!_settingsRepo) return;
  try {
    await _settingsRepo.set(userId, 'tg_mtproto_session', {
      sessionString,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  } catch (e: any) {
    console.error(`[Fragment] Failed to save session for user ${userId}:`, e.message);
  }
}

async function deleteUserSession(userId: number) {
  if (!_settingsRepo) return;
  try {
    await _settingsRepo.set(userId, 'tg_mtproto_session', {});
  } catch {}
}

// ── Legacy file session (fallback for migration) ──────────────────
const SESSION_FILE = path.join(process.cwd(), 'tg-session.txt');

function loadLegacySession(): string {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return fs.readFileSync(SESSION_FILE, 'utf-8').trim();
    }
  } catch {}
  return '';
}

function saveLegacySession(session: string) {
  try {
    fs.writeFileSync(SESSION_FILE, session, { encoding: 'utf-8', mode: 0o600 });
  } catch {}
}

// ── Per-user client management ────────────────────────────────────

async function getUserClient(userId: number): Promise<TelegramClient> {
  const existing = userClients.get(userId);
  if (existing && existing.connected) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  // Load session from DB
  let savedSession = await loadUserSession(userId);

  // Migration: if no DB session but legacy file exists, migrate it
  if (!savedSession && userId > 0) {
    const legacy = loadLegacySession();
    if (legacy) {
      console.log(`[Fragment] Migrating legacy session to user ${userId}`);
      savedSession = legacy;
      await saveUserSession(userId, legacy, { migratedFromFile: true });
    }
  }

  const session = new StringSession(savedSession);
  console.log(`[Fragment] Creating client for user ${userId}, session: ${savedSession ? 'LOADED' : 'NEW'}`);

  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    requestRetries: 5,
    autoReconnect: true,
    useWSS: false,
  });

  await client.connect();

  const sessionStr = client.session.save() as unknown as string;
  if (sessionStr && sessionStr !== savedSession) {
    await saveUserSession(userId, sessionStr);
  }

  userClients.set(userId, { client, connected: true, lastUsed: Date.now(), userId });
  return client;
}

/** Disconnect and remove a user's client */
async function disconnectUserClient(userId: number) {
  const uc = userClients.get(userId);
  if (uc) {
    try {
      const sessionStr = uc.client.session.save() as unknown as string;
      if (sessionStr) await saveUserSession(userId, sessionStr);
      uc.client.disconnect();
    } catch {}
    userClients.delete(userId);
  }
}

// ── Auth State Machine ─────────────────────────────────────────────
interface AuthState {
  step: 'phone' | 'code' | 'password' | 'done';
  phone?: string;
  phoneCodeHash?: string;
  createdAt: number;
}

const AUTH_STATE_TTL = 30 * 60 * 1000;
const authStates = new Map<number, AuthState>();

setInterval(() => {
  const now = Date.now();
  for (const [uid, state] of authStates) {
    if (now - state.createdAt > AUTH_STATE_TTL) authStates.delete(uid);
  }
}, 15 * 60 * 1000);

export function getAuthState(userId: number): AuthState | null {
  const s = authStates.get(userId);
  if (s && Date.now() - s.createdAt > AUTH_STATE_TTL) { authStates.delete(userId); return null; }
  return s || null;
}
export function clearAuthState(userId: number) {
  authStates.delete(userId);
}

// ── QR Code Login (per-user) ──────────────────────────────────────

const _qrCancelFns = new Map<number, () => void>();

export function cancelQRLogin(userId?: number): void {
  if (userId !== undefined) {
    const fn = _qrCancelFns.get(userId);
    if (fn) { fn(); _qrCancelFns.delete(userId); }
  } else {
    // Cancel all (legacy compat)
    for (const [uid, fn] of _qrCancelFns) { fn(); }
    _qrCancelFns.clear();
  }
}

export type Complete2FAFn = (password: string) => Promise<{ ok: boolean; error?: string }>;

export async function authStartQR(
  userId: number,
  onQRReady: (qrUrl: string, expiresIn: number) => Promise<void>,
  on2FARequired?: (complete: Complete2FAFn) => void,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; error?: string }> {
  cancelQRLogin(userId);

  const ensureClient = async (): Promise<TelegramClient> => {
    try {
      return await getUserClient(userId);
    } catch (e: any) {
      const m: string = e.message || '';
      if (m.includes('SESSION_PASSWORD_NEEDED') || m.includes('AUTH_KEY_UNREGISTERED') || m.includes('USER_DEACTIVATED')) {
        console.log(`[Fragment] QR: stale session for user ${userId}, wiping...`);
        await saveUserSession(userId, '');
        await disconnectUserClient(userId);
      }
      return getUserClient(userId);
    }
  };

  let client: TelegramClient;
  try {
    client = await ensureClient();
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }

  return new Promise<{ ok: boolean; error?: string }>(async (resolve) => {
    let done = false;
    let refreshTimer: NodeJS.Timeout | null = null;
    let currentToken: Buffer | null = null;
    let updateHandler: ((upd: any) => Promise<void>) | null = null;
    let rawFilter: any = null;

    const finish = (result: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      _qrCancelFns.delete(userId);
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (updateHandler && rawFilter) {
        try { client.removeEventHandler(updateHandler, rawFilter); } catch {}
      }
      resolve(result);
    };

    _qrCancelFns.set(userId, () => finish({ ok: false, error: 'cancelled' }));

    const timeoutHandle = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

    updateHandler = async (upd: any) => {
      if (done || !currentToken) return;
      const isLoginToken = upd.className === 'UpdateLoginToken' || upd.CONSTRUCTOR_ID === 0x564FE691;
      if (!isLoginToken) return;

      console.log(`[Fragment] UpdateLoginToken for user ${userId}`);
      try {
        const res = await (client as any).invoke(
          new Api.auth.ImportLoginToken({ token: currentToken })
        ) as any;

        if (res.className === 'auth.LoginTokenSuccess') {
          const sessionStr = client.session.save() as unknown as string;
          await saveUserSession(userId, sessionStr, { authMethod: 'qr', authTime: new Date().toISOString() });
          const uc = userClients.get(userId);
          if (uc) uc.connected = true;
          clearTimeout(timeoutHandle);
          console.log(`[Fragment] QR login authorized for user ${userId}!`);
          finish({ ok: true });
        } else if (res.className === 'auth.LoginTokenMigrateTo') {
          if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
          generateQR();
        }
      } catch (e: any) {
        const errMsg: string = e.message || String(e);
        if (errMsg.includes('SESSION_PASSWORD_NEEDED')) {
          if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
          console.log(`[Fragment] 2FA required for user ${userId}`);

          if (on2FARequired) {
            on2FARequired(async (password: string) => {
              try {
                const { computeCheck } = require('telegram/Password');
                const accountPwd = await (client as any).invoke(new Api.account.GetPassword());
                const pwdCheck = await computeCheck(accountPwd, password);
                await (client as any).invoke(new Api.auth.CheckPassword({ password: pwdCheck }));
                const sessionStr = client.session.save() as unknown as string;
                await saveUserSession(userId, sessionStr, { authMethod: 'qr+2fa', authTime: new Date().toISOString() });
                const uc = userClients.get(userId);
                if (uc) uc.connected = true;
                clearTimeout(timeoutHandle);
                finish({ ok: true });
                return { ok: true };
              } catch (e2: any) {
                const e2msg: string = e2.message || String(e2);
                if (e2msg.includes('PASSWORD_HASH_INVALID') || e2msg.includes('Bad password')) {
                  return { ok: false, error: 'Неверный пароль 2FA. Попробуй ещё раз.' };
                }
                finish({ ok: false, error: e2msg });
                return { ok: false, error: e2msg };
              }
            });
          } else {
            finish({ ok: false, error: 'SESSION_PASSWORD_NEEDED' });
          }
        } else {
          console.log(`[Fragment] ImportLoginToken error for user ${userId}:`, errMsg);
        }
      }
    };

    try {
      const { Raw: RawEvt } = require('telegram/events');
      rawFilter = new RawEvt({});
      client.addEventHandler(updateHandler!, rawFilter);
    } catch (e: any) {
      finish({ ok: false, error: 'Events module unavailable: ' + (e.message || e) });
      return;
    }

    const generateQR = async () => {
      if (done) return;
      try {
        let res: any;
        try {
          res = await (client as any).invoke(new Api.auth.ExportLoginToken({
            apiId: API_ID, apiHash: API_HASH, exceptIds: [],
          }));
        } catch (e: any) {
          const m: string = e.message || '';
          if (m.includes('SESSION_PASSWORD_NEEDED')) {
            await saveUserSession(userId, '');
            await disconnectUserClient(userId);
            client = await getUserClient(userId);
            res = await (client as any).invoke(new Api.auth.ExportLoginToken({
              apiId: API_ID, apiHash: API_HASH, exceptIds: [],
            }));
          } else throw e;
        }

        currentToken = Buffer.from(res.token as Uint8Array);
        const expiresTs: number = typeof res.expires === 'number' ? res.expires : Number(res.expires);
        const nowSec = Math.floor(Date.now() / 1000);
        const expiresIn = Math.max(10, expiresTs - nowSec);

        const tokenB64 = currentToken.toString('base64url');
        const qrUrl = `tg://login?token=${tokenB64}`;

        await onQRReady(qrUrl, expiresIn).catch(() => {});

        if (!done) {
          refreshTimer = setTimeout(generateQR, Math.max(5000, (expiresIn - 5) * 1000));
        }
      } catch (e: any) {
        finish({ ok: false, error: e.message || String(e) });
      }
    };

    await generateQR();
  });
}

/** @deprecated */
export async function pollQRLogin(): Promise<{ status: 'error'; error: string }> {
  return { status: 'error', error: 'Deprecated: use authStartQR(userId, callback) instead' };
}

/**
 * Step 1: Start phone auth — send OTP
 */
export async function authSendPhone(userId: number, phone: string): Promise<{ type: 'code_sent' | 'already_authorized'; info?: string }> {
  if (await isAuthorizedForUser(userId)) {
    return { type: 'already_authorized', info: 'Уже авторизован' };
  }

  const client = await getUserClient(userId);

  try {
    const { phoneCodeHash } = await client.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      phone
    );

    const sessionAfterCode = client.session.save() as unknown as string;
    if (sessionAfterCode) await saveUserSession(userId, sessionAfterCode);

    authStates.set(userId, {
      step: 'code',
      phone,
      phoneCodeHash,
      createdAt: Date.now(),
    });

    return { type: 'code_sent', info: `Код отправлен на ${phone}` };
  } catch (e: any) {
    throw new Error('Ошибка отправки кода: ' + (e.message || String(e)));
  }
}

/**
 * Step 2: Submit OTP code
 */
export async function authSubmitCode(userId: number, code: string): Promise<{ type: 'authorized' | 'need_password'; info?: string }> {
  const state = authStates.get(userId);
  if (!state || !state.phone || !state.phoneCodeHash) {
    throw new Error('Сначала введите номер телефона');
  }

  const client = await getUserClient(userId);

  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: state.phone,
      phoneCodeHash: state.phoneCodeHash,
      phoneCode: code.replace(/\s/g, ''),
    }));

    const sessionStr = client.session.save() as unknown as string;
    await saveUserSession(userId, sessionStr, { phone: state.phone, authMethod: 'phone', authTime: new Date().toISOString() });
    authStates.set(userId, { step: 'done', phone: state.phone, createdAt: Date.now() });

    console.log(`[Fragment] Authorized user ${userId} via phone`);
    return { type: 'authorized', info: 'Авторизован успешно!' };
  } catch (e: any) {
    const msg: string = e.message || String(e);
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      authStates.set(userId, { ...state, step: 'password', createdAt: Date.now() });
      return { type: 'need_password', info: 'Требуется пароль 2FA' };
    }
    if (msg.includes('PHONE_CODE_EXPIRED')) {
      authStates.delete(userId);
      throw new Error('EXPIRED');
    }
    if (msg.includes('PHONE_CODE_INVALID')) {
      throw new Error('INVALID');
    }
    throw new Error(msg);
  }
}

/**
 * Step 3: Submit 2FA password
 */
export async function authSubmitPassword(userId: number, password: string): Promise<void> {
  const client = await getUserClient(userId);

  try {
    const pwdInfo = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password');
    const inputCheck = await computeCheck(pwdInfo as any, password);
    await client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));

    const sessionStr = client.session.save() as unknown as string;
    await saveUserSession(userId, sessionStr, { authMethod: 'phone+2fa', authTime: new Date().toISOString() });
    authStates.set(userId, { step: 'done', createdAt: Date.now() });

    console.log(`[Fragment] 2FA accepted for user ${userId}`);
  } catch (e: any) {
    throw new Error('Неверный пароль: ' + (e.message || String(e)));
  }
}

// ── Per-user authorization checks ─────────────────────────────────

/**
 * Get the MTProto client for a specific user.
 * Throws if user is not authenticated.
 */
export async function getFragmentClientForUser(userId: number): Promise<TelegramClient> {
  return getUserClient(userId);
}

/**
 * Check if a specific user has an active MTProto session.
 */
export async function isAuthorizedForUser(userId: number): Promise<boolean> {
  const uc = userClients.get(userId);
  if (uc && uc.connected) {
    try {
      const me = await Promise.race([
        uc.client.getMe(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);
      return !!me;
    } catch {
      uc.connected = false;
      return false;
    }
  }

  // Try loading from DB
  const saved = await loadUserSession(userId);
  if (!saved) return false;

  try {
    const client = await getUserClient(userId);
    const me = await Promise.race([
      client.getMe(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5000)
      ),
    ]);
    return !!me;
  } catch {
    return false;
  }
}

/**
 * Get info about the authenticated Telegram account for a user.
 */
export async function getTgAccountInfo(userId: number): Promise<{
  authorized: boolean;
  phone?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  userId?: number;
} | null> {
  try {
    if (!(await isAuthorizedForUser(userId))) return { authorized: false };
    const client = await getUserClient(userId);
    const me = await client.getMe() as any;
    return {
      authorized: true,
      phone: me.phone,
      username: me.username,
      firstName: me.firstName,
      lastName: me.lastName,
      userId: me.id?.toJSNumber?.() ?? Number(me.id),
    };
  } catch {
    return { authorized: false };
  }
}

/**
 * Logout user's Telegram session.
 */
export async function logoutUser(userId: number): Promise<void> {
  const uc = userClients.get(userId);
  if (uc) {
    try { await uc.client.invoke(new Api.auth.LogOut()); } catch {}
    try { uc.client.disconnect(); } catch {}
    userClients.delete(userId);
  }
  await deleteUserSession(userId);
  console.log(`[Fragment] User ${userId} logged out`);
}

// ── Legacy compat: singleton getFragmentClient / isAuthorized ─────
// Used by gift functions that don't have a userId context.
// Picks the first available authorized client.

let _legacyUserId: number | null = null;

/** Set default user for legacy calls (call once at startup or after first auth) */
export function setLegacyUserId(userId: number) {
  _legacyUserId = userId;
}

export async function getFragmentClient(): Promise<TelegramClient> {
  // Try legacy userId first
  if (_legacyUserId) {
    try { return await getUserClient(_legacyUserId); } catch {}
  }
  // Try any connected client
  for (const [uid, uc] of userClients) {
    if (uc.connected) {
      uc.lastUsed = Date.now();
      return uc.client;
    }
  }
  // Fallback to legacy file session
  const legacy = loadLegacySession();
  if (legacy) {
    const session = new StringSession(legacy);
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5, requestRetries: 5, autoReconnect: true, useWSS: false,
    });
    await client.connect();
    return client;
  }
  throw new Error('No authenticated MTProto session available');
}

export async function isAuthorized(): Promise<boolean> {
  if (_legacyUserId) return isAuthorizedForUser(_legacyUserId);
  for (const [uid] of userClients) {
    if (await isAuthorizedForUser(uid)) return true;
  }
  return false;
}

// ── Fragment Gift Data (unchanged, uses legacy getFragmentClient) ──

export interface GiftResaleData {
  giftSlug: string;
  giftId: string;
  floorPriceTon: number;
  floorPriceStars: number;
  listedCount: number;
  avgPriceStars: number;
  topListings: Array<{ priceStars: number; priceTon: number; seller?: string }>;
  updatedAt: string;
}

const giftCache = new Map<string, { data: GiftResaleData; expires: number }>();

async function starsToTon(stars: number): Promise<number> {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    const d: any = await r.json();
    const tonUsd = d?.['the-open-network']?.usd || 4;
    const starUsd = 0.013;
    return (stars * starUsd) / tonUsd;
  } catch {
    return stars * 0.00325;
  }
}

export async function getGiftFloorPrice(giftSlug: string, giftId?: string): Promise<GiftResaleData | null> {
  const cacheKey = giftSlug;
  const cached = giftCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  if (!(await isAuthorized())) return null;

  const client = await getFragmentClient();

  try {
    let resolvedGiftId = giftId;

    if (!resolvedGiftId) {
      const catalogResult = await client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
      const catalog = (catalogResult as any).gifts || [];
      const SLUG_TO_EMOJI: Record<string, string> = {
        'jelly-bunny': '\u{1F430}', 'homemade-cake': '\u{1F382}', 'plush-pepe': '\u{1F438}',
        'lol-pop': '\u{1F36D}', 'cookie-heart': '\u{2764}\u{FE0F}', 'berrybox': '\u{1F381}',
        'bdaycandle': '\u{1F56F}\u{FE0F}', 'candy-cane': '\u{1F36C}',
        'love-potion': '\u{1F9EA}', 'witch-hat': '\u{1F383}', 'crystal-ball': '\u{1F52E}',
        'star-notepad': '\u{1F4D3}', 'astro': '\u{1F52D}', 'signet-ring': '\u{1F48D}',
        'evil-eye': '\u{1F9FF}', 'loot-bag': '\u{1F4B0}', 'eternal-rose': '\u{1F339}',
        'jack-o-lantern': '\u{1F383}', 'haunted-candy': '\u{1F36C}', 'skeleton': '\u{1F480}',
      };
      const targetEmoji = SLUG_TO_EMOJI[giftSlug];
      if (targetEmoji) {
        const found = catalog.find((g: any) => g.sticker?.emoji === targetEmoji);
        if (found) resolvedGiftId = String(found.id);
      }
      if (!resolvedGiftId) {
        const slugWords = giftSlug.replace(/-/g, ' ').toLowerCase();
        const found = catalog.find((g: any) => {
          const gName = (g.title || g.name || g.sticker?.emoticon || '').toLowerCase();
          return gName.includes(slugWords) || slugWords.includes(gName);
        });
        if (found) resolvedGiftId = String(found.id);
      }
      if (!resolvedGiftId) return null;
    }

    if (!resolvedGiftId) return null;

    const resaleResult = await client.invoke(new (Api.payments as any).GetResaleStarGifts({
      giftId: BigInt(resolvedGiftId),
      sortByPrice: true, offset: '', limit: 20,
    }));

    const listings = (resaleResult as any).gifts || [];
    if (listings.length === 0) return null;

    const prices: number[] = listings.map((l: any) => l.price || 0).filter((p: number) => p > 0).sort((a: number, b: number) => a - b);
    const floorStars = prices[0] || 0;
    const avgStars = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
    const floorTon = await starsToTon(floorStars);

    const topListings = await Promise.all(prices.slice(0, 5).map(async (p: number) => ({
      priceStars: p, priceTon: await starsToTon(p),
    })));

    const data: GiftResaleData = {
      giftSlug, giftId: resolvedGiftId,
      floorPriceTon: floorTon, floorPriceStars: floorStars,
      listedCount: listings.length, avgPriceStars: Math.round(avgStars),
      topListings, updatedAt: new Date().toISOString(),
    };

    giftCache.set(cacheKey, { data, expires: Date.now() + 30 * 60 * 1000 });
    return data;
  } catch (e: any) {
    console.error('[Fragment] getGiftFloorPrice error:', e.message);
    return null;
  }
}

export async function getAllGiftFloors(): Promise<Array<{
  name: string; emoji: string; floorStars: number; floorTon: number; listed: number;
}>> {
  if (!(await isAuthorized())) return [];

  const client = await getFragmentClient();

  try {
    const catalogResult = await client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
    const catalog = (catalogResult as any).gifts || [];
    const results: Array<{ name: string; emoji: string; floorStars: number; floorTon: number; listed: number }> = [];

    for (const gift of catalog.slice(0, 10)) {
      try {
        const resale = await client.invoke(new (Api.payments as any).GetResaleStarGifts({
          giftId: gift.id, sortByPrice: true, offset: '', limit: 5,
        }));
        const listings = (resale as any).gifts || [];
        if (listings.length === 0) continue;
        const prices = listings.map((l: any) => l.price || 0).filter((p: number) => p > 0).sort((a: number, b: number) => a - b);
        if (prices.length === 0) continue;
        const floorStars = prices[0];
        const floorTon = await starsToTon(floorStars);
        results.push({
          name: gift.sticker?.emoji || `Gift #${gift.id}`,
          emoji: gift.sticker?.emoji || '\u{1F381}',
          floorStars, floorTon, listed: listings.length,
        });
      } catch {}
    }
    return results;
  } catch (e: any) {
    console.error('[Fragment] getAllGiftFloors error:', e.message);
    return [];
  }
}
