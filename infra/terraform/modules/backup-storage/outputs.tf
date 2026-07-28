output "bucket_name" {
  description = "Name of the pgBackRest R2 bucket."
  value       = cloudflare_r2_bucket.backups.name
}

output "s3_endpoint" {
  description = "S3-compatible endpoint for the bucket. Jurisdiction-scoped buckets live on a different host than default ones, which is the usual cause of a 401 during pgBackRest setup."
  value = var.jurisdiction == "default" ? (
    "https://${var.account_id}.r2.cloudflarestorage.com"
    ) : (
    "https://${var.account_id}.${var.jurisdiction}.r2.cloudflarestorage.com"
  )
}

output "s3_region" {
  description = "Region string R2 expects from S3 clients."
  value       = "auto"
}
