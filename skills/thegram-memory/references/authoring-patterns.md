# Memory authoring patterns

These patterns describe useful structure, not a sample record count or permission to import someone else's data.

- Engineering: explain purpose, current components, meaningful changes and unresolved work. Count commits only with a named command and scope; commits are events, not planned tasks.
- Operations: keep current risks, incident boundaries, decisions and verifying evidence distinct. A changed threshold should link to the choice it replaces and the event that implemented it.
- Research: preserve source attribution, disagreement and dates. Link evidence to the claim it supports or contradicts; a chronological sequence alone does not prove causation.
- Shared plans: explain accepted choices, replaced choices and remaining steps. A decision is not implemented merely because it is accepted; require an actual implementing event.
- Metrics: define the measured quantity, denominator, unit, observation window and source. Reuse one metric ID for repeated observations and disclose incomparable units or windows.

Use standalone record placements, inline mentions, explicit links and filtered collections only according to the current `gram_profile`. A collection is a document projection, not a dashboard widget. The current rich collection views are list and table. Document, dashboard and graph rendering is a host capability, not a promise of the storage transport or plugin.

Revision recording time reflects when information was actually recorded; sourced event time and effective time are separate. Do not fabricate recording history, backdate an import or rebuild a document to imitate a sample.

Do not imitate record counts, revision counts, repeated inspection events or link density as quality targets. Explain what changed and why, retain uncertainty, and put evidence near the supported claims so readers can understand purpose, state, reasons and remaining work.
