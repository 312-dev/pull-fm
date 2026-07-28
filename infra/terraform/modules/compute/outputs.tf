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

output "db_server_id" {
  description = "ID of the Postgres node."
  value       = hcloud_server.db.id
}

output "db_server_name" {
  description = "Name of the Postgres node."
  value       = hcloud_server.db.name
}

output "db_private_ip" {
  description = "Private IP of the Postgres node. This is the only address Postgres should ever be reachable on."
  value       = local.db_private_ip
}

output "db_public_ipv6" {
  description = "Public IPv6 of the Postgres node, used for egress only. Empty when IPv6 is disabled."
  value       = var.db_public_ipv6_enabled ? hcloud_server.db.ipv6_address : ""
}

output "db_data_volume_id" {
  description = "ID of the dedicated Postgres data volume, or null when not provisioned."
  value       = var.db_data_volume_size > 0 ? hcloud_volume.db_data[0].id : null
}

output "db_data_volume_device" {
  description = "Stable device path of the Postgres data volume, for the config-management mount unit."
  value       = var.db_data_volume_size > 0 ? hcloud_volume.db_data[0].linux_device : null
}

output "placement_group_id" {
  description = "ID of the BFF spread placement group."
  value       = hcloud_placement_group.app.id
}
