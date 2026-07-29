# Adoption of the US backup bucket.
#
# ---------------------------------------------------------------------------
# WHY THIS FILE EXISTS AT ALL. EVERY OTHER RESOURCE IN THIS ROOT WAS CREATED BY
# TERRAFORM. THIS ONE COULD NOT BE.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. `module.backup_storage.cloudflare_r2_bucket.backups` managed
# `pull-fm-backups-staging`, the EU-jurisdiction bucket, while
# infra/lib/backup-common.sh had already been repointed to
# `pull-fm-backups-staging-us`. Terraform and the tooling were pointed at two
# different buckets, and Terraform's one was the retired half.
#
# WHY IT COULD NOT BE FIXED BY CHANGING `backup_bucket_name`. Both `name` and
# `jurisdiction` are ForceNew on `cloudflare_r2_bucket`, and
# modules/backup-storage marks the resource `prevent_destroy = true` on the
# grounds that "if the compute side is destroyed the service is down; if this is
# destroyed the service is gone". So editing the variable plans a DESTROY AND
# CREATE of the bucket holding every database backup and then fails the plan on
# the lifecycle lock. The create half would have failed regardless, because
# `pull-fm-backups-staging-us` already existed - it was created by hand during
# the cutover, in the DEFAULT jurisdiction with an ENAM location hint, since R2
# has no `us` jurisdiction and jurisdiction is fixed at creation.
#
# WHAT WAS DONE INSTEAD, on 2026-07-29, after a verified snapshot from
# infra/lib/tfstate-snapshot.sh (R2 cannot version objects, so that snapshot is
# the only rollback):
#
#   terraform state rm module.backup_storage.cloudflare_r2_bucket.backups
#
# then this import block, plus `jurisdiction = "default"` on the module call in
# main.tf. `state rm` forgets the EU bucket without touching the object, so the
# rollback stayed intact until it was deleted deliberately and separately.
#
# ---------------------------------------------------------------------------
# THE IMPORT ID HAS THREE PARTS AND THE THIRD ONE IS NOT OPTIONAL HERE
# ---------------------------------------------------------------------------
#
# cloudflare/cloudflare v5 imports this resource as
#
#     <account_id>/<bucket_name>/<jurisdiction>
#
# An R2 jurisdiction is not a property the API will tell you about a bucket by
# name: a jurisdiction endpoint only sees buckets created in that jurisdiction,
# so `pull-fm-backups-staging-us` is visible on the default endpoint and absent
# from the `.eu.` one, and the EU bucket is the other way round. Verified by
# enumerating both with `cf-r2-jurisdiction` on 2026-07-29:
#
#     default   pull-fm-backups-staging-us, pull-fm-ledger-staging-us,
#               pull-fm-ledger-drill-us, pull-fm-tfstate
#     eu        pull-fm-backups-staging, pull-fm-ledger-staging,
#               pull-fm-ledger-drill
#
# Getting the third part wrong does not import the other bucket; it imports
# nothing and says so. That is the good failure mode, and it is the reason the
# jurisdiction is stated twice - once here to find the object, once on the module
# call so the configuration agrees with what was found.
#
# The account id is interpolated from the variable rather than written out
# because it is the same value the provider is configured with, and two copies of
# an id in one root is one copy too many. It is a public identifier, not a
# credential.
#
# Left in place after the apply on purpose: an import block costs nothing to keep
# and it is the only artifact in this root that records that this bucket was
# adopted rather than created.

import {
  to = module.backup_storage.cloudflare_r2_bucket.backups
  id = "${var.cloudflare_account_id}/${var.backup_bucket_name}/default"
}
