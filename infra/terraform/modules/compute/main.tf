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

data "hcloud_image" "db" {
  name              = var.image_name
  with_architecture = startswith(var.db_server_type, "cax") ? "arm" : "x86"
}

locals {
  # Deterministic private addressing. pg_hba.conf, PgBouncer's host list and
  # Nomad retry_join all reference these; DHCP-assigned addresses would turn
  # every node rebuild into a config change across three other files.
  lb_private_ip   = cidrhost(var.subnet_ip_range, 5)
  app_private_ips = [for i in range(var.app_node_count) : cidrhost(var.subnet_ip_range, 11 + i)]
  db_private_ip   = cidrhost(var.subnet_ip_range, 21)

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

# --- Postgres node -----------------------------------------------------------
resource "hcloud_server" "db" {
  name        = "${var.name_prefix}-db-1"
  server_type = var.db_server_type
  image       = data.hcloud_image.db.id
  location    = var.location
  ssh_keys    = local.ssh_key_ids
  backups     = var.enable_db_backups

  labels = merge(var.labels, { role = "postgres" })

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    hostname           = "${var.name_prefix}-db-1"
    role               = "db"
    admin_user         = var.admin_user
    ssh_public_keys    = values(var.ssh_public_keys)
    tailscale_auth_key = local.tailscale_auth_key
  })

  # Postgres has no public IPv4 at all. A firewall rule is one careless edit
  # away from being wrong; a network interface that does not exist is not.
  # IPv6 stays on purely for egress - apt mirrors and the R2 endpoint are both
  # dual stack - which avoids standing up a NAT hop for one machine.
  public_net {
    ipv4_enabled = var.db_public_ipv4_enabled
    ipv6_enabled = var.db_public_ipv6_enabled
  }

  network {
    network_id = var.network_id
    ip         = local.db_private_ip
  }

  # Hetzner-side delete protection, enforced by the API.
  #
  # This replaced Terraform's prevent_destroy, which is a static meta-argument
  # and therefore cannot differ per environment: keeping it would make an
  # ephemeral staging environment impossible to tear down. delete_protection is
  # variable-driven and strictly stronger anyway, because it also blocks
  # deletion through the console, the CLI, and the raw API, not just this repo.
  delete_protection  = var.db_delete_protection
  rebuild_protection = var.db_delete_protection

  lifecycle {
    # The single most expensive mistake available in this repo is destroying
    # the database node. Gate 4 proves a restore works; it does not make the
    # restore free (30 minutes of downtime plus up to 5 minutes of RPO loss).
    # Removing this line must be a reviewed, deliberate commit.

    # user_data is ignored here but not on the BFF nodes: replacing a stateless
    # node to pick up a cloud-init change is routine, replacing the database to
    # do the same is never the right move.
    #
    # A LIVE node therefore keeps the cloud-init it booted with, which is
    # correct and is also why `converge` re-applies the bootstrap script rather
    # than trusting that cloud-init already did. A REBUILT node - the case Gate
    # 4 measures - gets the current template, because it is created rather than
    # updated and this argument only suppresses updates.
    ignore_changes = [image, user_data]
  }
}

# --- Postgres data volume (optional) -----------------------------------------
# Decoupling the data from the server is what makes the machine disposable. With
# the volume in place, a bricked DB node is a rebuild-and-reattach; without it,
# it is a restore from R2.
resource "hcloud_volume" "db_data" {
  count = var.db_data_volume_size > 0 ? 1 : 0

  name     = "${var.name_prefix}-db-data"
  size     = var.db_data_volume_size
  location = var.location
  format   = "ext4"
  labels   = merge(var.labels, { role = "postgres-data" })

  delete_protection = var.db_delete_protection
}

resource "hcloud_volume_attachment" "db_data" {
  count = var.db_data_volume_size > 0 ? 1 : 0

  volume_id = hcloud_volume.db_data[0].id
  server_id = hcloud_server.db.id

  # automount writes an fstab entry at attach time and races with the Postgres
  # unit on boot. Config management owns the mount, with the DB unit ordered
  # after it.
  automount = false
}

# --- Firewall attachment -----------------------------------------------------
# Attachments rather than the server's own firewall_ids argument: the two are
# mutually exclusive, and attachments keep firewall ownership in the firewall
# module instead of splitting it across two modules.
resource "hcloud_firewall_attachment" "app" {
  firewall_id = var.app_firewall_id
  server_ids  = hcloud_server.app[*].id
}

resource "hcloud_firewall_attachment" "db" {
  firewall_id = var.db_firewall_id
  server_ids  = [hcloud_server.db.id]
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
