---
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "A critical risk accepted for a year"
    status: accepted
    severity: critical
    threat_ids:
      - T20
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    owner: "ope@312.dev"
    accepted_on: 2026-07-01
    expires_on: 2027-07-01
    review_notes: "A critical acceptance may run for at most thirty days."
    example: true
---
