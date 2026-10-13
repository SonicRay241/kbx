/**
 * Google OAuth 2.0 + PKCE auth for Drive access, via a server-side token
 * proxy (api/google-token.ts on Vercel, Vite middleware in dev).
 *
 * The client secret lives only on the server; the SPA sends the auth code +
 * PKCE verifier (or refresh token) to /api/google-token and receives tokens.
 *
 * Google Cloud Console setup: OAuth 2.0 Web-application client with
 * `<origin>/oauth-callback` as an Authorized redirect URI, plus
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars on the server.
 * Scope: drive.file only — non-sensitive, limits access to files this app
 * created (the visible "kanban" folder).
 */

const STORAGE_KEY = 'kanban-gdrive-token'

const SCOPES = 'https://www.googleapis.com/auth/drive.file'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_PROXY = '/api/google-token'

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32))
  const verifier = base64UrlEncode(random)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) }
}

function readToken(): StoredToken | null {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredToken
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

function writeToken(token: StoredToken): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(token))
  notifyConnection()
}

// --- Connection-state notifications (UI reactivity) ---
type ConnectionListener = (connected: boolean) => void
let connectionListeners: ConnectionListener[] = []

function notifyConnection(): void {
  const connected = readToken() !== null
  for (const listener of connectionListeners) listener(connected)
}

/** Subscribe to connect/disconnect changes; returns an unsubscribe fn. */
export function subscribeDriveConnection(listener: ConnectionListener): () => void {
  connectionListeners.push(listener)
  return () => {
    connectionListeners = connectionListeners.filter((l) => l !== listener)
  }
}

export function isDriveConnected(): boolean {
  return readToken() !== null
}

interface ProxyResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function tokenProxy(body: Record<string, unknown>): Promise<ProxyResponse> {
  const response = await fetch(TOKEN_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, origin: window.location.origin }),
  })
  const json = (await response.json()) as ProxyResponse
  if (!response.ok) {
    const detail = json.error_description ?? json.error ?? `HTTP ${response.status}`
    throw new Error(`Google authorization failed: ${detail}`)
  }
  return json
}

export async function getValidAccessToken(): Promise<string | null> {
  const token = readToken()
  if (!token) return null
  // Refresh a minute early to avoid racing expiry mid-request.
  if (Date.now() < token.expiresAt - 60_000) return token.accessToken

  const json = await tokenProxy({
    grantType: 'refresh_token',
    refreshToken: token.refreshToken,
  })
  if (!json.access_token) {
    // Refresh token revoked/expired — force reconnect.
    disconnectDrive()
    return null
  }
  const next = {
    ...token,
    accessToken: json.access_token,
    // Google only returns a new refresh token on consent; keep the old one.
    refreshToken: json.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  }
  writeToken(next)
  return next.accessToken
}

/** Opens the Google consent popup and resolves once tokens are stored. */
export async function connectDrive(): Promise<void> {
  // Open the window in the SAME task as the user's click: an await before
  // window.open (e.g. the PKCE hash below) loses Safari's user activation
  // and the popup gets blocked even when allowed. Open about:blank first,
  // then do the async work, then navigate it to the real consent URL.
  const width = 480
  const height = 640
  const left = window.screenX + (window.outerWidth - width) / 2
  const top = window.screenY + (window.outerHeight - height) / 2
  let popup = window.open(
    'about:blank',
    'gdrive-oauth',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  )
  if (!popup) {
    // Some hardened browsers block script popups outright. Fall back to a
    // regular new tab: oauth-callback forwards the result over
    // BroadcastChannel, which reaches tabs just like popups.
    popup = window.open('about:blank', '_blank')
  }
  if (!popup) {
    throw new Error(
      'Could not open the Google sign-in window. Allow popups for this site to connect Google Drive.',
    )
  }

  const { verifier, challenge } = await createPkcePair()
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  sessionStorage.setItem('kanban-pkce-verifier', verifier)
  sessionStorage.setItem('kanban-oauth-state', state)

  // Must byte-match the redirect URI registered in Google Cloud Console.
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_GDRIVE_CLIENT_ID as string,
    redirect_uri: window.location.origin + '/oauth-callback',
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  try {
    popup.location.href = `${AUTH_ENDPOINT}?${params}`
  } catch {
    // The user closed the blank window during PKCE setup.
    void popup.close()
    throw new Error('Google authorization window was closed. Try again.')
  }

  const code = await new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel('kanban-gdrive-oauth')
    const poll = setInterval(() => {
      try {
        if (popup.closed) {
          cleanup()
          reject(new Error('Google authorization window was closed.'))
        }
      } catch {
        // COOP may block window.closed access; the BroadcastChannel message
        // is the reliable completion signal, so ignore polling failures.
      }
    }, 500)
    const cleanup = () => {
      clearInterval(poll)
      channel.close()
    }
    channel.onmessage = (event) => {
      cleanup()
      // State nonce: only accept completions for the request we initiated.
      if (event.data?.state !== sessionStorage.getItem('kanban-oauth-state')) {
        reject(new Error('Authorization response did not match its request.'))
        return
      }
      if (event.data?.type === 'kanban-code') resolve(event.data.code as string)
      else reject(new Error(String(event.data?.error ?? 'Authorization failed')))
    }
  })

  sessionStorage.removeItem('kanban-oauth-state')
  const verifierStored = sessionStorage.getItem('kanban-pkce-verifier')
  sessionStorage.removeItem('kanban-pkce-verifier')
  if (!verifierStored) throw new Error('Authorization state lost. Try again.')

  const json = await tokenProxy({
    grantType: 'authorization_code',
    code,
    codeVerifier: verifierStored,
  })
  if (!json.access_token || !json.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove the app's access at " +
        'myaccount.google.com/permissions and reconnect.',
    )
  }
  writeToken({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  })
}

export function disconnectDrive(): void {
  localStorage.removeItem(STORAGE_KEY)
  notifyConnection()
}