# The private network is the security boundary that actually matters here.
# Hetzner Cloud Firewalls only filter the PUBLIC interface, so anything that
# must never be internet-reachable (Postgres, PgBouncer, Nomad RPC) is reached
# exclusively over these addresses and binds only to them.
resource "hcloud_network" "this" {
  name     = "${var.name_prefix}-net"
  ip_range = var.ip_range
  labels   = var.labels

  # Changing ip_range replaces the network, which cascades into replacing every
  # attached server and the load balancer. The Hetzner-side flag makes that
  # fail at the API rather than halfway through an apply.
  delete_protection = var.delete_protection
}

resource "hcloud_network_subnet" "nodes" {
  network_id   = hcloud_network.this.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = var.subnet_ip_range
}
