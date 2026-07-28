---
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "First use of this identifier"
    status: accepted
    severity: low
    threat_ids:
      - T03
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    owner: "ope@312.dev"
    accepted_on: 2026-07-01
    expires_on: 2026-12-01
    review_notes: "Identifiers must never be reused, even after retirement."
    example: true

  - id: PULLFM-RISK-001
    title: "Second use of the same identifier"
    status: accepted
    severity: low
    threat_ids:
      - T03
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    owner: "ope@312.dev"
    accepted_on: 2026-07-01
    expires_on: 2026-12-01
    review_notes: "This collides with the entry above."
    example: true
---
