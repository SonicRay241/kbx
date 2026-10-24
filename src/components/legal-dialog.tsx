import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type LegalDoc = 'privacy' | 'terms'

const HASHES: Record<string, LegalDoc> = {
  '#privacy-policy': 'privacy',
  '#terms': 'terms',
}

const LAST_UPDATED = 'October 24, 2026'
const ISSUES_URL = 'https://github.com/SonicRay241/kbx/issues'

/**
 * Legal notices live behind URL fragments (`#privacy-policy`, `#terms`) so any
 * link — in the sync popover, a README, or an OAuth consent screen — can open
 * them without a route. The dialog owns the hash: closing it drops the fragment.
 */
export function LegalHashDialog() {
  const [doc, setDoc] = useState<LegalDoc | null>(null)

  useEffect(() => {
    const sync = () => setDoc(HASHES[window.location.hash] ?? null)
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const close = () => {
    setDoc(null)
    if (HASHES[window.location.hash]) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  return (
    <Dialog open={doc !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-base">
            {doc === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
          </DialogTitle>
          <DialogDescription>Last updated: {LAST_UPDATED}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4 text-sm text-muted-foreground">
          {doc === 'terms' ? <Terms /> : <Privacy />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-primary text-xs tracking-widest uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="underline underline-offset-2 hover:text-foreground" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function Privacy() {
  return (
    <>
      <p>
        kbx is an offline-first kanban board. Your boards live in your browser and, if you
        choose to enable sync, in your own Google Drive or your own WebDAV server. We collect
        nothing.
      </p>

      <Section title="Data we do not collect">
        <ul className="list-inside list-disc space-y-1">
          <li>
            Board data (boards, cards, descriptions, tags, lineage links, archives) is stored
            locally in your browser and never sent to us.
          </li>
          <li>No accounts. No analytics. No advertising. No tracking pixels.</li>
          <li>
            We do not read, scan, or index the contents of your Google Drive. Sync operates
            only on files inside the <span className="text-foreground">kanban</span> folder
            that this app created, using the{' '}
            <span className="text-foreground">drive.file</span> scope — the narrowest Google
            Drive scope available.
          </li>
        </ul>
      </Section>

      <Section title="Google Drive access">
        <p>
          If you connect Google Drive, this app gains access limited to files it created
          (scope{' '}
          <span className="text-foreground">https://www.googleapis.com/auth/drive.file</span>
          ). File contents are exchanged directly between your browser and Google&apos;s
          servers. They are not routed through, stored on, or accessible to our infrastructure.
        </p>
        <p>
          You can revoke this access at any time at{' '}
          <Ext href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</Ext>.
        </p>
      </Section>

      <Section title="WebDAV sync">
        <p>
          If you connect a WebDAV server, files are exchanged directly between your browser and
          that server. The address and credentials you enter are kept in this browser&apos;s
          local storage and are never sent anywhere else.
        </p>
      </Section>

      <Section title="Server-side token exchange">
        <p>
          To keep the OAuth client secret off your device, token exchanges with Google are
          relayed through a small serverless function. It sees your authorization code and
          access/refresh tokens only to perform the exchange, does not log them, and stores
          nothing.
        </p>
      </Section>

      <Section title="Traffic and hosting">
        <p>
          This site is served via Vercel. Like virtually all websites, standard server
          infrastructure processes request metadata (IP address, user agent, requested URL,
          timestamps) for security and abuse prevention. This is standard network traffic
          handled by the host&apos;s own privacy policy — not data we collect or control.
        </p>
      </Section>

      <Section title="Local storage">
        <p>
          Boards, preferences, and any sync credentials — your Google OAuth token or your WebDAV
          username and password — are stored in your browser&apos;s local storage and IndexedDB.
          Clearing your browser data for this site removes all of it.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy? <Ext href={ISSUES_URL}>Open an issue on GitHub</Ext>.
        </p>
      </Section>
    </>
  )
}

function Terms() {
  return (
    <>
      <p>
        By using kbx you agree to these terms. If you do not agree, do not use the app.
      </p>

      <Section title="The service">
        <p>
          kbx is a free, offline-first kanban board that runs in your browser. Board data is
          stored locally on your device and, optionally, in your own Google Drive or WebDAV
          server via bring-your-own-storage sync. There is no kbx server holding your data.
        </p>
      </Section>

      <Section title="Your data is your responsibility">
        <ul className="list-inside list-disc space-y-1">
          <li>
            Your boards live in your browser&apos;s storage. Clearing browser data, private
            browsing modes, or aggressive browser settings can erase them.
          </li>
          <li>
            Sync keeps a copy in your own storage (Google Drive or your WebDAV server), not on
            our side. Keep that storage healthy if you rely on it.
          </li>
          <li>We cannot recover lost boards. There is no server copy to restore from.</li>
        </ul>
      </Section>

      <Section title="Acceptable use">
        <p>
          Don&apos;t misuse the service: no attempts to breach, overload, or abuse the hosting,
          the OAuth token relay, Google&apos;s APIs, or any WebDAV server you connect.
        </p>
      </Section>

      <Section title="Google Drive and WebDAV">
        <p>
          If you enable Google Drive sync, you also agree to Google&apos;s Terms of Service.
          Sync access is limited to files this app created (drive.file scope). You can revoke
          access at any time at{' '}
          <Ext href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</Ext>.
        </p>
        <p>
          If you connect a WebDAV server, you are responsible for that server, its credentials,
          and whatever else it stores.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          The app is provided &quot;as is&quot;, without warranty of any kind.
        </p>
      </Section>

      <Section title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for any data loss, damages,
          or losses arising from your use of the app. If this term doesn&apos;t hold where you
          live, the app isn&apos;t intended for use there.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          Terms may change; material updates will be reflected in this dialog with a new
          &quot;last updated&quot; date.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms? <Ext href={ISSUES_URL}>Open an issue on GitHub</Ext>.
        </p>
      </Section>
    </>
  )
}
