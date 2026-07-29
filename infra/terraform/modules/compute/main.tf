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
  count = var.enable_cache_node ? 1 : 0

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

  # Where the BFF and the scheduled jobs find Redis. With a separate cache node
  # it is that node's private address; without one, Redis runs on the
  # application node itself and the answer is THAT NODE'S OWN PRIVATE ADDRESS,
  # not the loopback. This is an output rather than something the
  # config-management layer infers, because a wrong answer here is not a
  # connection error: it is a SECOND token bucket, and the MusicBrainz budget is
  # global. See the guard on app_node_count.
  #
  # IT SAID 127.0.0.1 UNTIL THE FIRST TIME ANYTHING WAS DEPLOYED AGAINST IT, and
  # the loopback cannot work here for a reason that is invisible on the host and
  # fatal in the container. The BFF runs under Compose on a bridge network, so
  # its 127.0.0.1 is its own namespace: a Redis published on the host loopback is
  # not merely firewalled off from it, it is a different interface entirely. The
  # symptom is the confusing one - /healthz answers 200 and /readyz reports redis
  # down, because the process started fine and only the dependency is missing.
  #
  # The node's private address fixes it without widening exposure. Redis
  # publishes on an interface that exists only inside the Hetzner private
  # network, which carries our own nodes and nothing else, and still never on
  # the public interface, which is the property the binding is there to keep.
  redis_host = var.enable_cache_node ? local.cache_private_ip : local.app_private_ips[0]

  ssh_key_ids        = [for k in hcloud_ssh_key.operators : k.id]
  tailscale_auth_key = var.tailscale_auth_key == null ? "" : var.tailscale_auth_key
}

resource "hcloud_ssh_key" "operators" {
  for_each = var.ssh_public_keys

  name       = "${var.name_prefix}-${each.key}"
  public_key = each.value
  labels     = var.labels
}

# Spread placement keeps the BFF nodes off the same physical host. Without it
# Hetzner is free to co-locate them and the second node buys nothing against a
# host failure, which is the main thing it exists for. Kept unconditionally even
# at one node: placement groups are free, and a group created later would mean
# rebuilding the running node to join it.
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
# THE OBVIOUS QUESTION IS WHY THIS NODE EXISTS AT ALL, since folding two Redis
# instances onto the BFF node deletes a whole server and its IPv4 from the bill.
# The answer depends entirely on the node count, which is why it is now optional
# rather than always-on:
#
#   AT ONE APP NODE the separate node buys nothing. There is exactly one process
#   holding the counters either way, so co-locating changes where Redis runs and
#   nothing about what it guarantees. That is EUR 6.99 plus an address for a
#   network hop, and it is off by default (enable_cache_node = false).
#
#   AT MORE THAN ONE APP NODE it is mandatory, and the reason is not tidiness:
#
#     - Quota and rate-limit counters must be counted ONCE across every BFF
#       node. Per-node counters multiply every published limit by the node count
#       without changing a line of the code that enforces them.
#     - The MusicBrainz egress budget is the sharp edge. docs/PLAN.md section 3
#       records 1 req/s as a GLOBAL PER-IP ceiling and Gate 1 asserts "<=1.0
#       req/s egress at the network layer" for the whole service. The token
#       bucket that holds us to it lives in Redis. Two BFF nodes with their own
#       buckets each honour 1 req/s and the service emits 2, which is how API
#       access gets revoked without appeal, while both nodes report compliance.
#
# So the variable is not a preference. `app_node_count > 1` with this false is a
# hard error at plan time; see the validation in variables.tf.
#
# The node also no longer needs a database server type, a data volume,
# whole-machine backups, or delete protection, because it holds nothing that a
# restart cannot rebuild.
resource "hcloud_server" "cache" {
  count = var.enable_cache_node ? 1 : 0

  name        = "${var.name_prefix}-cache-1"
  server_type = var.cache_server_type
  image       = data.hcloud_image.cache[0].id
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
  count = var.enable_cache_node ? 1 : 0

  firewall_id = var.cache_firewall_id
  server_ids  = [hcloud_server.cache[0].id]
}

# --- Load balancer -----------------------------------------------------------
#
# OPTIONAL, AND OFF PRE-LAUNCH. At one application node this is EUR 8.49/mo to
# round-robin across a single target, and the things a load balancer is actually
# for (spreading load, surviving a node, draining during a rolling deploy) all
# need a second node that does not exist yet.
#
# WHAT REPLACES IT AT ONE NODE, since ingress still has to work:
#
#   The proxied Cloudflare records point straight at the application node's own
#   public addresses instead of at the LB. nginx keeps terminating TLS with the
#   Cloudflare Origin CA certificate and keeps requiring Authenticated Origin
#   Pulls, so the "SSL mode strict end to end" property is unchanged.
#
#   WHAT CHANGES: the node's public interface becomes the ingress path, so it is
#   nginx WITHOUT PROXY protocol, and the Cloudflare-only allowlist keys on
#   $remote_addr rather than $proxy_protocol_addr. Both are handled by
#   infra/staging/app; see PULLFM_INGRESS in its bootstrap.sh.
#
#   WHAT IT COSTS, stated because it is the part worth checking: nothing on
#   client IP. The PROXY header never carried the client's address in this
#   design; it carried the CLOUDFLARE EDGE address, because Cloudflare is the
#   only L3 peer the load balancer ever sees. The real client IP has always come
#   from the CF-Connecting-IP header, forwarded to the BFF as X-Forwarded-For
#   and X-Real-IP, and that header is trusted only after mTLS and the allowlist
#   have both proved the peer is a Cloudflare edge. Per-IP rate limiting and the
#   ip column in audit_log therefore see exactly the same values before and
#   after. What is genuinely lost is one layer of L3 defence in depth: with the
#   LB the origin took traffic on the private interface only, and now the node
#   answers 443 on its public interface, guarded by the Hetzner firewall's
#   Cloudflare-only rule, which at one node finally protects the path it is
#   written for rather than only the direct-to-origin case.
resource "hcloud_load_balancer" "this" {
  count = var.enable_load_balancer ? 1 : 0

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
  count = var.enable_load_balancer ? 1 : 0

  load_balancer_id        = hcloud_load_balancer.this[0].id
  network_id              = var.network_id
  ip                      = local.lb_private_ip
  enable_public_interface = true
}

resource "hcloud_load_balancer_target" "app" {
  count = var.enable_load_balancer ? var.app_node_count : 0

  type             = "server"
  load_balancer_id = hcloud_load_balancer.this[0].id
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
  count = var.enable_load_balancer ? 1 : 0

  load_balancer_id = hcloud_load_balancer.this[0].id
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
  count = var.enable_load_balancer ? 1 : 0

  load_balancer_id = hcloud_load_balancer.this[0].id
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
