# Outputs are shaped for two consumers: DNS records in the calling root, and the
# monitoring/config-management layer that needs stable addresses and IDs.

output "load_balancer_id" {
  description = "Hetzner load balancer ID, or null when enable_load_balancer is false."
  value       = one(hcloud_load_balancer.this[*].id)
}

output "load_balancer_ipv4" {
  description = "Public IPv4 of the load balancer, or null when there is no load balancer. Use ingress_ipv4 for DNS: it resolves to whichever of the two is actually serving."
  value       = one(hcloud_load_balancer.this[*].ipv4)
}

output "load_balancer_ipv6" {
  description = "Public IPv6 of the load balancer, or null when there is no load balancer. Use ingress_ipv6 for DNS."
  value       = one(hcloud_load_balancer.this[*].ipv6)
}

output "load_balancer_private_ip" {
  description = "Private IP the load balancer would take inside the node subnet. Reserved whether or not the load balancer exists, so turning it on later does not renumber anything."
  value       = local.lb_private_ip
}

# --- ingress -----------------------------------------------------------------
#
# THE DNS TARGET, and the only address the calling root should publish. With a
# load balancer it is the load balancer; without one it is the single
# application node's own public address. Making the roots read this rather than
# load_balancer_ipv4 is what lets enable_load_balancer be a real switch instead
# of a change that silently leaves DNS pointing at a destroyed resource.
#
# The multi-node case cannot arrive here with the load balancer off: see the
# validation on app_node_count. A record can name one target, and the guard is
# what stops a second node being billed for traffic it can never receive.
output "ingress_ipv4" {
  description = "Public IPv4 that the proxied Cloudflare A records must target: the load balancer when it exists, otherwise the first application node."
  value       = var.enable_load_balancer ? one(hcloud_load_balancer.this[*].ipv4) : hcloud_server.app[0].ipv4_address
}

output "ingress_ipv6" {
  description = "Public IPv6 that the proxied Cloudflare AAAA records must target."
  value       = var.enable_load_balancer ? one(hcloud_load_balancer.this[*].ipv6) : hcloud_server.app[0].ipv6_address
}

output "ingress_mode" {
  description = "Which ingress path is configured. 'load-balancer' means nginx must expect PROXY protocol; 'direct' means it must not. The two must be changed together or every connection to the origin fails."
  value       = var.enable_load_balancer ? "load-balancer" : "direct"
}

output "redis_host" {
  description = "Host the BFF and the scheduled jobs must use for Redis: the cache node's private address when one exists, otherwise the loopback on the application node. A wrong value here is a second rate-limit bucket, not a connection error."
  value       = local.redis_host
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
  description = "ID of the shared Redis node, or null when Redis is co-located on the application node."
  value       = one(hcloud_server.cache[*].id)
}

output "cache_server_name" {
  description = "Name of the shared Redis node, or null when there is not one."
  value       = one(hcloud_server.cache[*].name)
}

output "cache_private_ip" {
  description = "Private IP the Redis node takes when enable_cache_node is true. Reserved either way so turning the node on does not renumber anything. There is no public IPv4 and Hetzner firewalls do not filter the private network, so the binding in the compose file is the control."
  value       = local.cache_private_ip
}

output "cache_public_ipv6" {
  description = "Public IPv6 of the Redis node, used for egress only. Empty when there is no cache node or IPv6 is disabled."
  value       = var.enable_cache_node && var.cache_public_ipv6_enabled ? one(hcloud_server.cache[*].ipv6_address) : ""
}

output "placement_group_id" {
  description = "ID of the BFF spread placement group."
  value       = hcloud_placement_group.app.id
}
