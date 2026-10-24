export type LegalDoc = 'privacy' | 'terms'

export const LEGAL_DOCS: Record<LegalDoc, { title: string; hash: string; path: string }> = {
  privacy: { title: 'Privacy Policy', hash: '#privacy-policy', path: '/privacy-policy' },
  terms: { title: 'Terms of Service', hash: '#terms', path: '/terms' },
}

/** URL fragment → document. The modal is driven entirely by these. */
export const LEGAL_HASHES: Record<string, LegalDoc> = {
  '#privacy-policy': 'privacy',
  '#terms': 'terms',
}

export const LEGAL_LAST_UPDATED = 'October 24, 2026'
