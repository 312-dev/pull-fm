# Shaped for the monitoring and config-management layers. Nothing here is
# secret: public IPs, private IPs inside our own network, and resource IDs.

output "environment" {
  description = "Environment name."
  value       = local.environment
}

output "load_balancer_ipv4" {
  description = "Public IPv4 of the load balancer."
  value       = module.compute.load_balancer_ipv4
}

output "load_balancer_ipv6" {
  description = "Public IPv6 of the load balancer."
  value       = module.compute.load_balancer_ipv6
}

output "load_balancer_id" {
  description = "Hetzner load balancer ID."
  value       = module.compute.load_balancer_id
}

output "app_server_ids" {
  description = "IDs of the BFF nodes."
  value       = module.compute.app_server_ids
}

output "app_server_names" {
  description = "Names of the BFF nodes."
  value       = module.compute.app_server_names
}

output "app_egress_ipv4" {
  description = "Public IPv4 of each BFF node. These are the addresses MusicBrainz, iTunes and Deezer apply per-IP rate limits to, so the capacity model in docs/PLAN.md section 3 is a function of this list."
  value       = module.compute.app_public_ipv4
}

output "app_private_ips" {
  description = "Private IPs of the BFF nodes."
  value       = module.compute.app_private_ips
}

output "db_server_id" {
  description = "ID of the Postgres node."
  value       = module.compute.db_server_id
}

output "db_private_ip" {
  description = "Private IP of the Postgres node. The only address Postgres should ever answer on."
  value       = module.compute.db_private_ip
}

output "db_data_volume_device" {
  description = "Device path of the Postgres data volume, or null when not provisioned."
  value       = module.compute.db_data_volume_device
}

output "network_id" {
  description = "Private network ID."
  value       = module.network.network_id
}

output "network_ip_range" {
  description = "Private network CIDR."
  value       = module.network.network_ip_range
}

output "cloudflare_allowlist_size" {
  description = "Number of Cloudflare edge CIDRs in the origin firewall. A change here means Cloudflare published new ranges."
  value       = module.firewall.cloudflare_cidr_count
}

output "backup_bucket_name" {
  description = "R2 bucket holding the pgBackRest repository."
  value       = module.backup_storage.bucket_name
}

output "backup_s3_endpoint" {
  description = "S3-compatible endpoint for pgbackrest.conf (repo1-s3-endpoint)."
  value       = module.backup_storage.s3_endpoint
}

output "hostnames" {
  description = "Public hostnames published for this environment."
  value       = module.dns.hostnames
}
