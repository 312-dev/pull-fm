# Outputs are shaped for two consumers: DNS records in the calling root, and the
# monitoring/config-management layer that needs stable addresses and IDs.

output "load_balancer_id" {
  description = "Hetzner load balancer ID."
  value       = hcloud_load_balancer.this.id
}

output "load_balancer_ipv4" {
  description = "Public IPv4 of the load balancer. This is the A record target."
  value       = hcloud_load_balancer.this.ipv4
}

output "load_balancer_ipv6" {
  description = "Public IPv6 of the load balancer. This is the AAAA record target."
  value       = hcloud_load_balancer.this.ipv6
}

output "load_balancer_private_ip" {
  description = "Private IP of the load balancer inside the node subnet."
  value       = local.lb_private_ip
}

output "app_server_ids" {
  description = "IDs of the BFF nodes."
  value       = hcloud_server.app[*].id
}

output "app_server_names" {
  description = "Names of the BFF nodes."
  value       = hcloud_server.app[*].name
}

output "app_public_ipv4" {
  description = "Public IPv4 of each BFF node. Egress addresses: these are the IPs upstream APIs rate limit us on, so they belong in the capacity model."
  value       = hcloud_server.app[*].ipv4_address
}

output "app_private_ips" {
  description = "Private IPs of the BFF nodes."
  value       = local.app_private_ips
}

output "cache_server_id" {
  description = "ID of the shared Redis node."
  value       = hcloud_server.cache.id
}

output "cache_server_name" {
  description = "Name of the shared Redis node."
  value       = hcloud_server.cache.name
}

output "cache_private_ip" {
  description = "Private IP of the Redis node. The only address Redis should ever be reachable on; there is no public IPv4 and Hetzner firewalls do not filter the private network, so the binding in the compose file is the control."
  value       = local.cache_private_ip
}

output "cache_public_ipv6" {
  description = "Public IPv6 of the Redis node, used for egress only. Empty when IPv6 is disabled."
  value       = var.cache_public_ipv6_enabled ? hcloud_server.cache.ipv6_address : ""
}

output "placement_group_id" {
  description = "ID of the BFF spread placement group."
  value       = hcloud_placement_group.app.id
}
