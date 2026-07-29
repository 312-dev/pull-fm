---
# Fixture: a SECOND top-level `register:` key. Before 2026-07-29 this replaced
# the parsed list with an empty one, so every entry vanished and the run exited
# 0. Duplicate keys at indent 4 were already rejected; indent 0 was not.
# whose expiry is already in the past, proving retired entries are exempt.
schema_version: 1
register:
  - id: PULLFM-RISK-001
    title: "A representative accepted risk"
    status: accepted
    severity: medium
    threat_ids:
      - T11
    description: "A description long enough to satisfy the eighty character minimum, describing a plausible exposure and how it would be reached."
    justification: "A justification long enough to satisfy the eighty character minimum, explaining the opportunity cost of fixing this immediately."
    compensating_controls: "Something concrete that reduces the blast radius today."
    owner: "ope@312.dev"
    accepted_on: 2026-07-01
    expires_on: 2026-12-01
    review_notes: "Check whether the compensating control still holds."
    example: true

  - id: PULLFM-RISK-002
    title: "A retired risk kept for the audit trail"
    status: retired
    severity: high
    threat_ids:
      - T27
      - ADV-4
    description: "A description long enough to satisfy the eighty character minimum, describing an exposure that has since been remediated in full."
    justification: "A justification long enough to satisfy the eighty character minimum, recording why it was once accepted rather than fixed."
    compensating_controls: "No longer relevant; the underlying issue was fixed."
    owner: "@GraysonCAdams"
    accepted_on: 2026-01-01
    expires_on: 2026-03-01
    review_notes: "Closed once the underlying issue was fixed; retained as history."
    example: true
register:
---

Fixture body. Ignored by the validator.
