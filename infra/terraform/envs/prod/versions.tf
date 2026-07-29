terraform {
  required_version = "~> 1.15"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.68"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }

  # --- Remote state ---------------------------------------------------------
  #
  # NOTHING IS HARDCODED HERE ON PURPOSE. The bucket name, the account-specific
  # endpoint and the credentials are all environment-specific and the last two
  # are secret, so they are supplied with -backend-config at init time.
  #
  # Cloudflare R2 is S3-compatible, so the stock "s3" backend works against it.
  #
  # Bootstrap order (chicken and egg: the state bucket cannot be created by the
  # config that stores its state in it):
  #
  #   1. Create the state bucket ONCE, by hand, in the Cloudflare dashboard or
  #      with wrangler:
  #        wrangler r2 bucket create pull-fm-tfstate
  #      NOT with --jurisdiction eu, and NOT expecting to enable versioning.
  #      Both were written here once and both were wrong:
  #        * The live bucket is not EU-pinned, and a jurisdiction endpoint only
  #          sees buckets created in that jurisdiction, so the .eu. form fails
  #          init outright rather than falling back (PULLFM-RISK-010).
  #        * R2 DOES NOT IMPLEMENT OBJECT VERSIONING. PutBucketVersioning and
  #          GetBucketVersioning are unimplemented in Cloudflare's S3
  #          compatibility matrix (PULLFM-RISK-008).
  #      State is still the only artifact here that cannot be rebuilt from this
  #      repository, so it is protected by verified pre-apply snapshots:
  #        infra/lib/tfstate-snapshot.sh snapshot <this-root>
  #      That copies state to a timestamped key, reads it back, compares
  #      digests, and exits non-zero if it cannot, so a failed backup stops the
  #      apply instead of being discovered during a recovery.
  #   2. Create an R2 API token scoped to Object Read & Write on that bucket
  #      only, and store it in 1Password. Bucket-scoped, not account-scoped:
  #      the current pair is account-scoped and also reaches the backups
  #      bucket, which is PULLFM-RISK-009.
  #   3. Copy backend.hcl.example to backend.hcl (gitignored), fill it in, then:
  #        export AWS_ACCESS_KEY_ID=$(op read 'op://MCP/r2/pull-fm-tfstate/ACCESS_KEY_ID')
  #        export AWS_SECRET_ACCESS_KEY=$(op read 'op://MCP/r2/pull-fm-tfstate/SECRET_ACCESS_KEY')
  #        terraform init -backend-config=backend.hcl
  #   4. Uncomment the block below and re-run init to migrate local state up.
  #
  # R2 has no DynamoDB equivalent, so locking uses Terraform 1.10+ native S3
  # lockfiles (use_lockfile, set in backend.hcl) rather than dynamodb_table.
  #
  # backend "s3" {
  #   key = "prod/terraform.tfstate"
  # }
}
