import { useEffect, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/oauth-callback')({
  component: OAuthCallback,
})

/**
 * OAuth redirect landing for the Google Drive popup. Forwards the code/error
 * to the opener via BroadcastChannel, then closes itself.
 */
function OAuthCallback() {
  const forwarded = useRef(false)

  useEffect(() => {
    if (forwarded.current) return
    forwarded.current = true

    const params = new URLSearchParams(window.location.search)
    const error = params.get('error')
    const code = params.get('code')
    const state = params.get('state')
    const channel = new BroadcastChannel('kanban-gdrive-oauth')
    if (error) {
      channel.postMessage({ type: 'kanban-error', error, state })
    } else if (code) {
      channel.postMessage({ type: 'kanban-code', code, state })
    }
    channel.close()
    window.close()
  }, [])

  return (
    <div className="p-6 text-sm text-muted-foreground">
      Authorization complete. You can close this window if it does not close
      automatically.
    </div>
  )
}