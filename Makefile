# Pull.fm - operator entry points.
#
# Everything here is a thin wrapper over a script that also works standalone.
# The Makefile is a discovery surface, not a build system: `pnpm` owns the
# application build and `terraform` owns the infrastructure.

.PHONY: help cost cost-json staging-up staging-down staging-status risks jobs infra-guards

help:
	@echo "make cost           run rate + billing-alert check (Gate \$$)"
	@echo "make cost-json      the same, machine-readable"
	@echo "make staging-up     provision ephemeral staging for a gate run"
	@echo "make staging-down   destroy staging compute (keeps R2 and DNS)"
	@echo "make staging-status what is running right now"
	@echo "make risks          validate the accepted-risk register"
	@echo "make jobs           assert the background-job schedule matches the runbook"
	@echo "make infra-guards   prove the scale guard and the origin config (terraform, docker)"

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
