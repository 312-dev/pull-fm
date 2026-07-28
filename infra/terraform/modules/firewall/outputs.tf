output "app_firewall_id" {
  description = "ID of the BFF node firewall."
  value       = hcloud_firewall.app.id
}

output "db_firewall_id" {
  description = "ID of the Postgres node firewall."
  value       = hcloud_firewall.db.id
}

output "cloudflare_cidr_count" {
  description = "Number of Cloudflare edge CIDRs currently allowlisted. Useful as a drift canary: this changing means Cloudflare published new ranges."
  value       = length(local.cloudflare_cidrs)
}
