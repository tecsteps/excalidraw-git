// "Connect GitHub" without a Kurviq account: GitHub App user tokens, kept in
// an encrypted httpOnly cookie of this browser. The Worker stores nothing —
// the cookie is the only place the refresh token exists (besides GitHub).
//
//   GET  /auth/login?return=…    sign in with GitHub (OAuth of the GitHub App)
//   GET  /auth/install?return=…  install the app on (more) repositories
//   GET  /auth/callback          GitHub's redirect: code -> tokens -> cookie
//   POST /auth/token             a valid access token (8 h) for the page,
//                                refreshed with the refresh token when needed
//                                ({ connected: false } if there is none)
//   POST /auth/logout            forget the connection (and revoke the token)
//
// GitHub user tokens expire after 8 hours, their refresh token after 6
// months — and every refresh gives a new 6-month refresh token, so a browser
// that opens Kurviq at least twice a year stays connected for good.

export type AuthEnv = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  /** base64 of 32 random bytes: encrypts the cookies */
  COOKIE_KEY: string;
};

const SESSION_COOKIE = "kq_github";
const STATE_COOKIE = "kq_oauth_state";
const UA = "Kurviq";

type Session = {
  /** access token and when it expires (ms) */
  a: string;
  ae: number;
  /** refresh token and when it expires (ms) */
  r: string;
  re: number;
  user: { login: string; avatarUrl: string | null };
};

// -----------------------------------------------------------------------------
// encrypted cookies (AES-GCM)
// -----------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (text: string) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

let cachedKey: { raw: string; key: CryptoKey } | null = null;

const cookieKey = async (env: AuthEnv) => {
  if (cachedKey?.raw !== env.COOKIE_KEY) {
    const raw = Uint8Array.from(atob(env.COOKIE_KEY), (char) => char.charCodeAt(0));
    if (raw.length !== 32) {
      throw new Error("COOKIE_KEY must be base64 of 32 bytes");
    }
    cachedKey = { raw: env.COOKIE_KEY, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
  }
  return cachedKey.key;
};

const seal = async (env: AuthEnv, value: unknown, purpose: string) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, await cookieKey(env), data),
  );
  return `${b64url(iv)}.${b64url(sealed)}`;
};

const unseal = async <T>(env: AuthEnv, text: string | undefined, purpose: string): Promise<T | null> => {
  if (!text) {
    return null;
  }
  try {
    const [iv, sealed] = text.split(".").map(fromB64url);
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
      await cookieKey(env),
      sealed,
    );
    return JSON.parse(new TextDecoder().decode(data)) as T;
  } catch {
    return null;
  }
};

const readCookie = (request: Request, name: string) => {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === name) {
      return part.slice(index + 1);
    }
  }
  return undefined;
};

const cookie = (request: Request, name: string, value: string, maxAgeSeconds: number) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`;
};

// -----------------------------------------------------------------------------
// GitHub
// -----------------------------------------------------------------------------

type TokenAnswer = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

const exchange = async (env: AuthEnv, params: Record<string, string>): Promise<TokenAnswer> => {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  return res.ok ? res.json() : { error: `http_${res.status}` };
};

const sessionFrom = (answer: TokenAnswer, user: Session["user"]): Session | null => {
  if (!answer.access_token) {
    return null;
  }
  const now = Date.now();
  return {
    a: answer.access_token,
    ae: now + (answer.expires_in ?? 8 * 3600) * 1000,
    // tokens without expiry (app setting off): no refresh token
    r: answer.refresh_token ?? "",
    re: now + (answer.refresh_token_expires_in ?? 180 * 24 * 3600) * 1000,
    user,
  };
};

const fetchUser = async (accessToken: string) => {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": UA },
  });
  if (!res.ok) {
    return null;
  }
  const user: any = await res.json();
  return { login: String(user.login), avatarUrl: user.avatar_url ? String(user.avatar_url) : null };
};

const sessionCookie = async (request: Request, env: AuthEnv, session: Session) =>
  cookie(request, SESSION_COOKIE, await seal(env, session, SESSION_COOKIE), (session.re - Date.now()) / 1000);

// -----------------------------------------------------------------------------
// routes
// -----------------------------------------------------------------------------

/** only paths on this site (no open redirects) */
const safeReturn = (value: string | null) =>
  value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";

const withParam = (path: string, key: string, value: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach((value) => headers.append("Set-Cookie", value));
  return new Response(null, { status: 302, headers });
};

const json = (status: number, body: unknown, cookies: string[] = []) => {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  cookies.forEach((value) => headers.append("Set-Cookie", value));
  return new Response(JSON.stringify(body), { status, headers });
};

/** POSTs only from Kurviq's own pages */
const sameOrigin = (request: Request) => request.headers.get("Origin") === new URL(request.url).origin;

const startFlow = async (request: Request, env: AuthEnv, target: (state: string, origin: string) => string) => {
  const url = new URL(request.url);
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const sealed = await seal(env, { state, back: safeReturn(url.searchParams.get("return")) }, STATE_COOKIE);
  return redirect(target(state, url.origin), [cookie(request, STATE_COOKIE, sealed, 900)]);
};

export const handleAuth = async (request: Request, env: AuthEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) {
    return null;
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.COOKIE_KEY) {
    return json(503, { error: "GitHub is not configured on this Kurviq server" });
  }

  if (url.pathname === "/auth/login" && request.method === "GET") {
    return startFlow(request, env, (state, origin) => {
      const target = new URL("https://github.com/login/oauth/authorize");
      target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      target.searchParams.set("redirect_uri", `${origin}/auth/callback`);
      target.searchParams.set("state", state);
      return target.toString();
    });
  }

  if (url.pathname === "/auth/install" && request.method === "GET") {
    return startFlow(
      request,
      env,
      (state) => `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new?state=${encodeURIComponent(state)}`,
    );
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const flow = await unseal<{ state: string; back: string }>(env, readCookie(request, STATE_COOKIE), STATE_COOKIE);
    const clearState = cookie(request, STATE_COOKIE, "", 0);
    const back = flow?.back ?? "/";
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      return redirect(withParam(back, "github", "cancelled"), [clearState]);
    }
    if (!flow || flow.state !== url.searchParams.get("state")) {
      // e.g. an installation started on github.com (no state of ours): sign in
      // properly, GitHub answers at once since the app is authorized already
      return redirect(`/auth/login?return=${encodeURIComponent(back)}`, [clearState]);
    }
    const answer = await exchange(env, { code, redirect_uri: `${url.origin}/auth/callback` });
    const user = answer.access_token ? await fetchUser(answer.access_token) : null;
    const session = user && sessionFrom(answer, user);
    if (!session) {
      return redirect(withParam(back, "github", "failed"), [clearState]);
    }
    // after an installation: which one, so the app can go straight to its repositories
    const installation = url.searchParams.get("installation_id");
    const done = withParam(back, "github", "connected");
    return redirect(/^\d+$/.test(installation ?? "") ? withParam(done, "installation", installation!) : done, [
      clearState,
      await sessionCookie(request, env, session),
    ]);
  }

  if (url.pathname === "/auth/token" && request.method === "POST") {
    if (!sameOrigin(request)) {
      return json(403, { error: "Forbidden" });
    }
    const session = await unseal<Session>(env, readCookie(request, SESSION_COOKIE), SESSION_COOKIE);
    if (!session) {
      return json(200, { connected: false });
    }
    if (session.ae - Date.now() > 10 * 60_000) {
      return json(200, { token: session.a, expiresAt: new Date(session.ae).toISOString(), user: session.user });
    }
    if (!session.r || session.re <= Date.now()) {
      return json(200, { connected: false, expired: true }, [cookie(request, SESSION_COOKIE, "", 0)]);
    }
    const answer = await exchange(env, { grant_type: "refresh_token", refresh_token: session.r });
    const next = sessionFrom(answer, session.user);
    if (!next) {
      if (answer.error === "bad_refresh_token" && !request.headers.get("X-Kurviq-Retry")) {
        // most likely another tab refreshed it a moment ago: its answer set
        // the new cookie, the page asks once more with it
        return json(409, { error: "Token was refreshed meanwhile, ask again" });
      }
      if (answer.error && answer.error.startsWith("http_")) {
        return json(503, { error: "GitHub not reachable" });
      }
      return json(200, { connected: false, expired: true }, [cookie(request, SESSION_COOKIE, "", 0)]);
    }
    return json(200, { token: next.a, expiresAt: new Date(next.ae).toISOString(), user: next.user }, [
      await sessionCookie(request, env, next),
    ]);
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request)) {
      return json(403, { error: "Forbidden" });
    }
    const session = await unseal<Session>(env, readCookie(request, SESSION_COOKIE), SESSION_COOKIE);
    if (session) {
      // revoke the token at GitHub too (best effort)
      await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
          Accept: "application/vnd.github+json",
          "User-Agent": UA,
        },
        body: JSON.stringify({ access_token: session.a }),
      }).catch(() => {});
    }
    return json(200, { ok: true }, [cookie(request, SESSION_COOKIE, "", 0)]);
  }

  return json(404, { error: "Not found" });
};
