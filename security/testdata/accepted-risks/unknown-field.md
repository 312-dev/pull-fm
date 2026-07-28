---
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "An entry with a typo in a field name"
    status: accepted
    severity: low
    threat_ids:
      - T03
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    owner: "ope@312.dev"
    accepted_on: 2026-07-01
    expiry_date: 2026-12-01
    expires_on: 2026-12-01
    review_notes: "expiry_date is not part of the closed schema."
    example: true
---
