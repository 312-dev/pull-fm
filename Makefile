# Pull.fm - operator entry points.
#
# Everything here is a thin wrapper over a script that also works standalone.
# The Makefile is a discovery surface, not a build system: `pnpm` owns the
# application build and `terraform` owns the infrastructure.

.PHONY: help cost cost-json staging-up staging-down staging-status risks

help:
	@echo "make cost           run rate + billing-alert check (Gate \$$)"
	@echo "make cost-json      the same, machine-readable"
	@echo "make staging-up     provision ephemeral staging for a gate run"
	@echo "make staging-down   destroy staging compute (keeps R2 and DNS)"
	@echo "make staging-status what is running right now"
	@echo "make risks          validate the accepted-risk register"

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
