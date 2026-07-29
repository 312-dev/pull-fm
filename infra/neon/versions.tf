terraform {
  required_version = "~> 1.15"

  required_providers {
    # THERE IS NO OFFICIAL NEON PROVIDER, and that is a fact about the vendor
    # rather than a gap in this repository. Neon's own documentation states:
    #
    #   "Neon sponsors the following community-developed Terraform provider for
    #    managing Neon Postgres platform resources ... This provider is not
    #    maintained or officially supported by Neon. Use at your own discretion."
    #   https://neon.com/docs/reference/terraform
    #
    # Checked 2026-07-29: registry.terraform.io returns 404 for both
    # `neondatabase/neon` and `neondatabase-labs/neon`, so kislerdm/neon is not
    # merely the recommended option, it is the only one that exists.
    #
    # The residual risk is a single-maintainer dependency on the control plane
    # for the database. It is bounded rather than eliminated:
    #
    #   - Nothing in the data path depends on the provider. If it were abandoned
    #     tomorrow, the running Neon project keeps serving; only Terraform
    #     management of it stops.
    #   - Every resource here is importable by a stable Neon identifier (project
    #     id, project/branch, project/branch/name), so the escape hatch is
    #     `terraform state rm` plus the Neon console or the REST API, not a
    #     rebuild.
    #   - The lock file pins the exact version and the checksums, so an upstream
    #     compromise cannot arrive silently on a re-init.
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.14"
    }
  }

  # --- Remote state ---------------------------------------------------------
  #
  # Identical pattern to envs/staging: NOTHING IS HARDCODED HERE. The bucket,
  # the account-specific endpoint and the credentials are supplied with
  # -backend-config at init time, because the last two are secret and this
  # repository is public.
  #
  #   cp backend.hcl.example backend.hcl        # gitignored, fill it in
  #   source infra/lib/credentials.sh && pullfm_load_credentials neon
  #   terraform init -backend-config=backend.hcl
  #
  # R2 has no DynamoDB equivalent, so locking uses Terraform 1.10+ native S3
  # lockfiles (use_lockfile, set in backend.hcl) rather than dynamodb_table.
  #
  # THIS STATE IS MORE SENSITIVE THAN THE HETZNER ROOTS. Neon returns role
  # passwords through the API, so `neon_role.password` and every
  # `connection_uri` attribute land in state in plaintext. That is a property of
  # the provider and cannot be configured away. The state bucket is therefore
  # the trust boundary for the production database credential, which is why it
  # is a separate R2 token from the environment credentials and why object
  # versioning is on. See README.md, "What is in the state file".
  backend "s3" {
    key = "neon/terraform.tfstate"
  }
}
