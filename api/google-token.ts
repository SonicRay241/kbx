/**
 * Vercel serverless function: POST /api/google-token
 *
 * Confidential token exchange for Google OAuth. Holds the client secret
 * server-side; the SPA never sees it. Handles both grant types:
 *  - authorization_code (initial connect, with PKCE verifier)
 *  - refresh_token (silent renewal)
 *
 * Env vars (Vercel project settings / .env.local for `vercel dev`):
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *
 * The redirect_uri must byte-match the SPA's registered
 * `<origin>/oauth-callback` in Google Cloud Console; this function keeps it
 * server-side so it can't drift.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

interface TokenRequest {
  grantType: 'authorization_code' | 'refresh_token'
  code?: string
  codeVerifier?: string
  refreshToken?: string
  /** Origin of the calling SPA, e.g. https://charasheet.example */
  origin: string
}

export async function handleTokenRequest(body: TokenRequest): Promise<{
  status: number
  json: Record<string, unknown>
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return {
      status: 500,
      json: {
        error: 'server_config',
        error_description:
          'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in the environment.',
      },
    }
  }

  const redirectUri = `${body.origin}/oauth-callback`
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  })

  if (body.grantType === 'authorization_code') {
    params.set('grant_type', 'authorization_code')
    params.set('code', body.code ?? '')
    params.set('code_verifier', body.codeVerifier ?? '')
  } else {
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', body.refreshToken ?? '')
    // redirect_uri is not required for refresh grants but Google tolerates it.

    // Trim to what the SPA needs; keeps payloads small.
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const json = (await response.json()) as Record<string, unknown>
  return { status: response.status, json }
}

export default async function handler(
  req: { method?: string; body?: TokenRequest },
  res: {
    status: (code: number) => {
      json: (payload: Record<string, unknown>) => void
    }
  },
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }
  const body = req.body ?? ({} as TokenRequest)
  const origin = body.origin ?? ''
  // Only allow exchanges for origins this deployment serves.
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (allowed.length > 0 && !allowed.includes(origin)) {
    res.status(403).json({ error: 'origin_not_allowed' })
    return
  }
  if (body.grantType !== 'authorization_code' && body.grantType !== 'refresh_token') {
    res.status(400).json({ error: 'invalid_grant_type' })
    return
  }
  try {
    const result = await handleTokenRequest(body)
    res.status(result.status).json(result.json)
  } catch (error) {
    res.status(502).json({
      error: 'token_exchange_failed',
      error_description: error instanceof Error ? error.message : String(error),
    })
  }
}