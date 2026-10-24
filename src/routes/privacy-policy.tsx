import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal-content'
import { LEGAL_DOCS } from '@/lib/legal'

export const Route = createFileRoute('/privacy-policy')({
  component: PrivacyPolicyPage,
})

/**
 * Crawlable copy of the policy. Browsers are handed straight to the in-app
 * modal (`/#privacy-policy`) so there is one place to edit the text.
 */
function PrivacyPolicyPage() {
  const doc = LEGAL_DOCS.privacy

  useEffect(() => {
    window.location.replace(`/${doc.hash}`)
  }, [doc.hash])

  return <LegalPage title={doc.title} doc="privacy" />
}
