---
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "An entry with no owner and no expiry"
    status: accepted
    severity: low
    threat_ids:
      - T03
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    review_notes: "Owner, accepted_on and expires_on are all absent."
    example: true
---
