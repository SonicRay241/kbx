import type { Plugin, ViteDevServer } from 'vite'

/**
 * Dev-only middleware so `npm run dev` serves /api/google-token locally with
 * the exact same handler code the Vercel function runs (api/google-token.ts).
 * Secrets come from .env.local via Vite's loadEnv.
 */
export function googleTokenDevPlugin(): Plugin {
  return {
    name: 'google-token-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/google-token', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'method_not_allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid_json' }))
          return
        }

        const { handleTokenRequest } = await import('../api/google-token.js')
        const { loadEnv } = await import('vite')
        const env = loadEnv('development', process.cwd(), '')
        // The shared handler reads process.env; populate from .env.local.
        Object.assign(process.env, {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
        })

        const result = await handleTokenRequest({
          grantType: body.grantType as 'authorization_code' | 'refresh_token',
          code: body.code as string | undefined,
          codeVerifier: body.codeVerifier as string | undefined,
          refreshToken: body.refreshToken as string | undefined,
          origin: body.origin as string,
        })
        res.statusCode = result.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result.json))
      })
    },
  }
}