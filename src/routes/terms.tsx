import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal-content'
import { LEGAL_DOCS } from '@/lib/legal'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
})

/** Same as the privacy page: the text lives here, not behind a redirect. */
function TermsPage() {
  const doc = LEGAL_DOCS.terms
  return <LegalPage title={doc.title} doc="terms" />
}
