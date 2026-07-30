# Pull.fm - operator entry points.
#
# Everything here is a thin wrapper over a script that also works standalone.
# The Makefile is a discovery surface, not a build system: `pnpm` owns the
# application build and `terraform` owns the infrastructure.

.PHONY: help cost cost-json staging-up staging-down staging-status risks jobs identifiers legal consent-evidence infra-guards alerts alerts-armed

help:
	@echo "make cost           run rate + billing-alert check (Gate \$$)"
	@echo "make cost-json      the same, machine-readable"
	@echo "make staging-up     provision ephemeral staging for a gate run"
	@echo "make staging-down   destroy staging compute (keeps R2 and DNS)"
	@echo "make staging-status what is running right now"
	@echo "make risks          validate the accepted-risk register (needs the private checkout)"
	@echo "make jobs           assert the background-job schedule matches the runbook"
	@echo "make identifiers    fail if a live infrastructure identifier is in a tracked file"
	@echo "make legal          fail if legal/ still has an unresolved placeholder"
	@echo "make consent-evidence  produce an auditable consent evidence bundle"
	@echo "make infra-guards   prove the scale guard and the origin config (terraform, docker)"
	@echo "make alerts         PROVE the alert channel delivers, end to end (Gate 5)"
	@echo "make alerts-armed   is this machine able to notify anyone at all?"

# Exits non-zero when a required billing alert is missing or disabled.
cost:
	@./infra/cost.sh

cost-json:
	@./infra/cost.sh --json

staging-up:
	@./infra/staging-env.sh up

staging-down:
	@./infra/staging-env.sh down

staging-status:
	@./infra/staging-env.sh status

# The register itself is NOT in this repository: it moved to a private one on
# 2026-07-29 (security/README.md). No --allow-missing here on purpose. An
# operator running `make risks` is asking a question about the register, and the
# useful answer to "I cannot find it" is the error that says where it looked,
# not a green tick. Point PULLFM_RISK_REGISTER at your checkout, or put one at
# security/private/accepted-risks.md, which is gitignored.
risks:
	@node security/scripts/check-accepted-risks.mjs

# The four background jobs are what make the published retention windows true.
# This asserts they are scheduled, enabled, bounded, and that a job which could
# not run is treated differently from one that ran. See docs/RUNBOOK-JOBS.md.
jobs:
	@node infra/scripts/check-job-schedule.mjs

# This repository is public, and it has already published an origin IP, a
# tailnet address, a database endpoint hostname and a cloud account id in
# tracked files. This fails on a new one. It self-tests every detector against
# its own samples first, so it cannot go green by matching nothing.
identifiers:
	@node tools/check-public-identifiers.mjs

# legal/terms-of-service.md section 16 currently reads "governed by the laws of
# [CONFIRM: state]". Published as written, the dispute framework selects no law
# and no forum and is therefore void, and that is one line in a 20KB document
# nobody re-reads before shipping. This makes it a command that fails rather
# than something to remember. It checks for holes, not for correctness: a
# lawyer still has to read the documents.
legal:
	@node legal/check-publication-blockers.mjs

# The only way to get consent evidence out of the database, and the shape it has to
# be in for somebody who does not trust us to check it. Everything else here is a
# check that passes or fails; this one produces an artefact, so it takes arguments.
#
# It answers the five questions a dispute or an audit actually asks: one subject's
# whole history, the exact text they agreed to at the version they agreed to, who
# has not accepted the current epoch, what changed between two versions and who
# re-consented after it, and what can be re-verified about whether the records were
# altered. The bundle carries `SHA256SUMS` in coreutils format and the append-only
# triggers read out of the LIVE database, so the recipient checks it with
# `sha256sum -c` and their own eyes rather than with a tool of ours.
#
# READ-ONLY, asserted by Postgres: the whole bundle is produced inside one
# REPEATABLE READ, READ ONLY transaction, so producing the evidence cannot alter it.
#
# Exit 1 means a bundle WAS written and something is wrong in it - an append-only
# protection missing from the live database, or a stored text that does not hash to
# its recorded digest. The bundle is kept, because a finding is evidence too.
#
# IP addresses, user agents and session ids are redacted to presence flags by
# default. `--unredact` needs `--reason`, and the reason is written into the bundle.
# See docs/compliance/consent-evidence.md, which is copied into every bundle.
#
#   make consent-evidence OUT=./evidence-run
#   make consent-evidence OUT=./ev ARGS='--subject someone@example.test'
OUT ?= ./consent-evidence
consent-evidence:
	@PGURL_ITEM="$${PGURL_ITEM:-pull-fm/staging/DATABASE_URL}" \
		node packages/db/scripts/consent-evidence.mjs --out "$(OUT)" $(ARGS)

# Two proofs that need tooling rather than a checkout: that raising the node
# count without externalizing Redis fails a terraform plan, and that the origin
# template renders to a config nginx accepts on both ingress paths.
infra-guards:
	@./infra/scripts/check-scale-guard.sh
	@./infra/scripts/check-origin-config.sh

# Gate 5 evidence, generated rather than asserted. Both scripts publish through
# the real sender into a real ntfy and read the message back; neither one checks
# that a file exists or a variable is set, because that class of check is what
# produced two of the three control failures recorded in docs/SCORECARD.md.
#
# Needs docker. Skips (exit 77) rather than failing where it is unavailable, so
# a checkout without docker does not report a broken alert path.
alerts:
	@./infra/observability/alert-selftest.sh
	@./infra/observability/watchdog-selftest.sh

# The one question that matters at 3am, asked of the FILE rather than of
# 1Password: "can this machine tell anyone anything right now?"
alerts-armed:
	@./infra/observability/install-alert-env.sh --check
