import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal-content'
import { LEGAL_DOCS } from '@/lib/legal'

export const Route = createFileRoute('/privacy-policy')({
  component: PrivacyPolicyPage,
})

/**
 * The page a reviewer or crawler reads. It must render the policy in place —
 * redirecting to `/#privacy-policy` (the in-app modal) leaves the URL empty
 * for anyone who checks it, which is what OAuth brand verification rejects.
 */
function PrivacyPolicyPage() {
  const doc = LEGAL_DOCS.privacy
  return <LegalPage title={doc.title} doc="privacy" />
}
