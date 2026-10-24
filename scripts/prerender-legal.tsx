/**
 * Emits static HTML for the legal pages so the text is in the response even
 * for a client that never runs JS (OAuth brand review does exactly this).
 * The markup comes from the same React component the app uses, so there is
 * one source of truth; only the shell is synthetic.
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { LegalPage } from '@/components/legal-content'
import { LEGAL_DOCS } from '@/lib/legal'

const cssFile = readdirSync('dist/assets').find(
  (file) => file.startsWith('index-') && file.endsWith('.css'),
)
if (!cssFile) throw new Error('prerender-legal: no built stylesheet in dist/assets')

for (const doc of ['privacy', 'terms'] as const) {
  const meta = LEGAL_DOCS[doc]
  const body = renderToStaticMarkup(<LegalPage title={meta.title} doc={doc} />)
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${meta.title} — kbx</title>
    <meta name="description" content="${meta.title} for kbx, a local-first kanban board that stores boards in your browser and syncs only to storage you own." />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/${cssFile}" />
  </head>
  <body class="bg-background text-foreground min-h-dvh">
    ${body}
  </body>
</html>
`
  writeFileSync(`dist${meta.path}.html`, html)
  console.log(`prerendered dist${meta.path}.html`)
}
