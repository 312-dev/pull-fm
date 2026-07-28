output "record_ids" {
  description = "Map of logical record key to Cloudflare record ID."
  value       = { for k, r in cloudflare_dns_record.this : k => r.id }
}

output "hostnames" {
  description = "Map of logical record key to the hostname it publishes."
  value       = { for k, r in cloudflare_dns_record.this : k => r.name }
}
