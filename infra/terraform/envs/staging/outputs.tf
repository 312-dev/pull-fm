# Shaped for the monitoring and config-management layers. Nothing here is
# secret: public IPs, private IPs inside our own network, and resource IDs.

output "environment" {
  description = "Environment name."
  value       = local.environment
}

# --- ingress -----------------------------------------------------------------
#
# Read by infra/staging-env.sh, which uses ingress_mode to decide what to
# configure on the node. That is the whole reason these are published: the
# Terraform side and the nginx side of the PROXY-protocol decision must come
# from ONE value, because a disagreement answers 400 to every connection and
# looks like an application bug.
output "ingress_mode" {
  description = "Which ingress path is provisioned: 'load-balancer' (nginx must expect PROXY protocol) or 'direct' (it must not). Passed to bootstrap.sh as PULLFM_INGRESS."
  value       = module.compute.ingress_mode
}

output "ingress_ipv4" {
  description = "Public IPv4 the proxied Cloudflare A records target: the load balancer if there is one, otherwise the single application node."
  value       = module.compute.ingress_ipv4
}

output "ingress_ipv6" {
  description = "Public IPv6 the proxied Cloudflare AAAA records target."
  value       = module.compute.ingress_ipv6
}

output "redis_host" {
  description = "Host the BFF and the scheduled jobs reach Redis on: the cache node's private address when one exists, otherwise the loopback on the application node. A wrong value here is a second MusicBrainz token bucket, not a connection error."
  value       = module.compute.redis_host
}

output "load_balancer_ipv4" {
  description = "Public IPv4 of the load balancer, or null when there is no load balancer. Use ingress_ipv4 for DNS."
  value       = module.compute.load_balancer_ipv4
}

output "load_balancer_ipv6" {
  description = "Public IPv6 of the load balancer, or null when there is no load balancer. Use ingress_ipv6 for DNS."
  value       = module.compute.load_balancer_ipv6
}

output "load_balancer_id" {
  description = "Hetzner load balancer ID, or null when enable_load_balancer is false."
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

output "cache_server_id" {
  description = "ID of the shared Redis node, or null when Redis is co-located on the application node."
  value       = module.compute.cache_server_id
}

output "cache_private_ip" {
  description = "Private IP the Redis node takes when enable_cache_node is true. Reserved either way. Use redis_host for the address REDIS_URL and REDIS_QUOTA_URL should actually carry, because that one is correct in both shapes. There is no longer a Postgres address to publish: the database is Neon, and its connection strings are sensitive outputs of infra/neon."
  value       = module.compute.cache_private_ip
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
