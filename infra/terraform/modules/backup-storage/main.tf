# pgBackRest repository for Postgres full backups and WAL archive.
#
# Deliberately NOT managed here:
#
#   * R2 access key pairs. The Cloudflare provider can mint an account API
#     token, but the resulting secret is written to Terraform state in
#     plaintext. A backup credential is the one credential that must survive
#     the loss of everything else, so it is created by hand and stored in
#     1Password. See README.md, "Credentials that Terraform does not manage".
#
#   * A lifecycle expiry rule. Retention is pgBackRest's job
#     (repo1-retention-full / repo1-retention-archive). An object expiry rule
#     running underneath it deletes WAL segments the manifest still references
#     and turns a working repository into an unrestorable one. The failure is
#     silent until the restore drill in Gate 4.
resource "cloudflare_r2_bucket" "backups" {
  account_id   = var.account_id
  name         = var.bucket_name
  jurisdiction = var.jurisdiction

  lifecycle {
    # The backup bucket outranks everything else in this repo. If the compute
    # side is destroyed the service is down; if this is destroyed the service
    # is gone. Deleting it must not be possible as a side effect of any plan.
    prevent_destroy = true
  }
}
