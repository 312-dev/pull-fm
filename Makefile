# Pull.fm - operator entry points.
#
# Everything here is a thin wrapper over a script that also works standalone.
# The Makefile is a discovery surface, not a build system: `pnpm` owns the
# application build and `terraform` owns the infrastructure.

.PHONY: help cost cost-json staging-up staging-down staging-status risks jobs infra-guards alerts alerts-armed

help:
	@echo "make cost           run rate + billing-alert check (Gate \$$)"
	@echo "make cost-json      the same, machine-readable"
	@echo "make staging-up     provision ephemeral staging for a gate run"
	@echo "make staging-down   destroy staging compute (keeps R2 and DNS)"
	@echo "make staging-status what is running right now"
	@echo "make risks          validate the accepted-risk register"
	@echo "make jobs           assert the background-job schedule matches the runbook"
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

risks:
	@node security/scripts/check-accepted-risks.mjs

# The four background jobs are what make the published retention windows true.
# This asserts they are scheduled, enabled, bounded, and that a job which could
# not run is treated differently from one that ran. See docs/RUNBOOK-JOBS.md.
jobs:
	@node infra/scripts/check-job-schedule.mjs

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
