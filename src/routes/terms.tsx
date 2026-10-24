import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal-content'
import { LEGAL_DOCS } from '@/lib/legal'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
})

/** Crawlable copy of the terms; browsers land in `/#terms` instead. */
function TermsPage() {
  const doc = LEGAL_DOCS.terms

  useEffect(() => {
    window.location.replace(`/${doc.hash}`)
  }, [doc.hash])

  return <LegalPage title={doc.title} doc="terms" />
}
