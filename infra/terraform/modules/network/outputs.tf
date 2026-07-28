output "network_id" {
  description = "ID of the private network."
  value       = hcloud_network.this.id
}

output "network_ip_range" {
  description = "CIDR of the private network."
  value       = hcloud_network.this.ip_range
}

output "subnet_id" {
  description = "Composite ID of the node subnet."
  value       = hcloud_network_subnet.nodes.id
}

output "subnet_ip_range" {
  description = "CIDR of the node subnet."
  value       = hcloud_network_subnet.nodes.ip_range
}
