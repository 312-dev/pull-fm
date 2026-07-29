# The image name must be resolved to an architecture-specific image ID. Passing
# "ubuntu-24.04" straight through picks the x86 build, which then fails to boot
# on a CAX (Ampere ARM64) type with "image has wrong architecture".
#
# Architecture is derived from the server type rather than configured
# separately, so the two cannot drift: CAX is arm, everything else is x86.
data "hcloud_image" "app" {
  name              = var.image_name
  with_architecture = startswith(var.app_server_type, "cax") ? "arm" : "x86"
}

data "hcloud_image" "cache" {
  name              = var.image_name
  with_architecture = startswith(var.cache_server_type, "cax") ? "arm" : "x86"
}

locals {
  # Deterministic private addressing. The Redis URLs in the BFF environment and
  # Nomad retry_join both reference these; DHCP-assigned addresses would turn
  # every node rebuild into a config change across three other files.
  #
  # The .21 slot keeps its name across the Neon migration even though Postgres
  # no longer answers there. Renumbering would have been churn for its own sake,
  # and an address that moved would have invalidated every runbook that quotes
  # it while changing nothing about what is reachable.
  lb_private_ip    = cidrhost(var.subnet_ip_range, 5)
  app_private_ips  = [for i in range(var.app_node_count) : cidrhost(var.subnet_ip_range, 11 + i)]
  cache_private_ip = cidrhost(var.subnet_ip_range, 21)

  ssh_key_ids        = [for k in hcloud_ssh_key.operators : k.id]
  tailscale_auth_key = var.tailscale_auth_key == null ? "" : var.tailscale_auth_key
}

resource "hcloud_ssh_key" "operators" {
  for_each = var.ssh_public_keys

  name       = "${var.name_prefix}-${each.key}"
  public_key = each.value
  labels     = var.labels
}

# Spread placement keeps the two BFF nodes off the same physical host. Without
# it Hetzner is free to co-locate them and the second node buys nothing against
# a host failure, which is the main thing it exists for.
resource "hcloud_placement_group" "app" {
  name   = "${var.name_prefix}-app"
  type   = "spread"
  labels = var.labels
}

# --- BFF nodes ---------------------------------------------------------------
resource "hcloud_server" "app" {
  count = var.app_node_count

  name        = "${var.name_prefix}-app-${count.index + 1}"
  server_type = var.app_server_type
  image       = data.hcloud_image.app.id
  location    = var.location
  ssh_keys    = local.ssh_key_ids
  backups     = var.enable_app_backups

  placement_group_id = hcloud_placement_group.app.id

  labels = merge(var.labels, { role = "bff" })

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    hostname           = "${var.name_prefix}-app-${count.index + 1}"
    role               = "app"
    admin_user         = var.admin_user
    ssh_public_keys    = values(var.ssh_public_keys)
    tailscale_auth_key = local.tailscale_auth_key
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = var.network_id
    ip         = local.app_private_ips[count.index]
  }

  lifecycle {
    # hcloud_image resolves to whatever the newest matching snapshot is, so a
    # Hetzner base-image refresh would otherwise show up as a plan that
    # replaces both BFF nodes. Rolling onto a new image is a deliberate act:
    # bump image_name, then terraform apply -replace one node at a time.
    ignore_changes = [image]
  }
}

# --- Cache node --------------------------------------------------------------
#
# THIS USED TO BE THE POSTGRES NODE. Postgres now lives in Neon (infra/neon), so
# what is left on this machine is Redis: the evictable cache and the
# must-not-evict quota instance.
#
# THE OBVIOUS QUESTION IS WHY THIS NODE STILL EXISTS AT ALL, since folding two
# Redis instances into the BFF nodes would delete a whole server from the bill.
# The answer is that Redis here is shared state, not a local cache:
#
#   - The quota and rate-limit counters must be counted ONCE across every BFF
#     node. Per-node counters would multiply every published limit by
#     app_node_count without changing a line of the code that enforces them.
#   - The MusicBrainz egress budget is the sharp edge. docs/PLAN.md section 3
#     records 1 req/s as a GLOBAL PER-IP ceiling, and Gate 1 asserts "<=1.0
#     req/s egress at the network layer" for the whole service. The token bucket
#     that holds us to it lives in Redis. Two BFF nodes with their own buckets
#     would each honour 1 req/s and the service would emit 2, which is how API
#     access gets revoked without appeal.
#
# So the node shrank rather than disappearing. It no longer needs a database
# server type, a data volume, whole-machine backups, or delete protection,
# because it holds nothing that a restart cannot rebuild.
resource "hcloud_server" "cache" {
  name        = "${var.name_prefix}-cache-1"
  server_type = var.cache_server_type
  image       = data.hcloud_image.cache.id
  location    = var.location
  ssh_keys    = local.ssh_key_ids
  backups     = var.enable_cache_backups

  labels = merge(var.labels, { role = "cache" })

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    hostname           = "${var.name_prefix}-cache-1"
    role               = "cache"
    admin_user         = var.admin_user
    ssh_public_keys    = values(var.ssh_public_keys)
    tailscale_auth_key = local.tailscale_auth_key
  })

  # No public IPv4 at all, unchanged from when Postgres lived here. A firewall
  # rule is one careless edit away from being wrong; a network interface that
  # does not exist is not. IPv6 stays on purely for egress, so apt and the
  # Tailscale coordination server are reachable without a NAT hop.
  public_net {
    ipv4_enabled = var.cache_public_ipv4_enabled
    ipv6_enabled = var.cache_public_ipv6_enabled
  }

  network {
    network_id = var.network_id
    ip         = local.cache_private_ip
  }

  lifecycle {
    # user_data is NOT ignored here any more, and that is the substantive change
    # rather than an oversight. It was ignored while this was the database node,
    # because replacing the database to pick up a cloud-init edit is never the
    # right move. A cache node holds nothing, so it is as replaceable as a BFF
    # node and should pick up config the same way they do.
    ignore_changes = [image]
  }
}

# --- Firewall attachment -----------------------------------------------------
# Attachments rather than the server's own firewall_ids argument: the two are
# mutually exclusive, and attachments keep firewall ownership in the firewall
# module instead of splitting it across two modules.
resource "hcloud_firewall_attachment" "app" {
  firewall_id = var.app_firewall_id
  server_ids  = hcloud_server.app[*].id
}

resource "hcloud_firewall_attachment" "cache" {
  firewall_id = var.cache_firewall_id
  server_ids  = [hcloud_server.cache.id]
}

# --- Load balancer -----------------------------------------------------------
resource "hcloud_load_balancer" "this" {
  name               = "${var.name_prefix}-lb"
  load_balancer_type = var.load_balancer_type
  location           = var.location
  labels             = var.labels
  delete_protection  = var.lb_delete_protection

  algorithm {
    type = "round_robin"
  }
}

resource "hcloud_load_balancer_network" "this" {
  load_balancer_id        = hcloud_load_balancer.this.id
  network_id              = var.network_id
  ip                      = local.lb_private_ip
  enable_public_interface = true
}

resource "hcloud_load_balancer_target" "app" {
  count = var.app_node_count

  type             = "server"
  load_balancer_id = hcloud_load_balancer.this.id
  server_id        = hcloud_server.app[count.index].id

  # Traffic to the origin stays on the private network, so the BFF nodes never
  # need to accept HTTP on their public interface at all. The Cloudflare-only
  # public rule in the firewall module is belt and braces on top of this.
  use_private_ip = true

  depends_on = [hcloud_load_balancer_network.this]
}

# TCP passthrough, not HTTP termination. Hetzner managed certificates require
# the hostname to resolve to the LB, and it resolves to Cloudflare instead.
# Terminating TLS at the origin with a Cloudflare Origin CA certificate is what
# permits SSL mode "strict" end to end.
resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.this.id
  protocol         = "tcp"
  listen_port      = 443
  destination_port = 443
  proxyprotocol    = var.enable_proxy_protocol

  health_check {
    protocol = "http"
    port     = var.health_check_port
    interval = 10
    timeout  = 5
    retries  = 3

    http {
      path         = var.health_check_path
      status_codes = ["2??"]
      tls          = false
    }
  }
}

resource "hcloud_load_balancer_service" "http" {
  load_balancer_id = hcloud_load_balancer.this.id
  protocol         = "tcp"
  listen_port      = 80
  destination_port = 80
  proxyprotocol    = var.enable_proxy_protocol

  health_check {
    protocol = "http"
    port     = var.health_check_port
    interval = 10
    timeout  = 5
    retries  = 3

    http {
      path         = var.health_check_path
      status_codes = ["2??"]
      tls          = false
    }
  }
}
