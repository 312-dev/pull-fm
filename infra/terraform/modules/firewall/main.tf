locals {
  anywhere = ["0.0.0.0/0", "::/0"]

  # Only Cloudflare may speak HTTP to an origin node.
  #
  # Caveat worth knowing before reviewing this: Hetzner Cloud Firewalls cannot
  # be attached to a Load Balancer, and Hetzner LBs have no source-IP allowlist
  # of their own. So the "Cloudflare only" rule cannot be enforced at the LB.
  # It is enforced in the three places that ARE available:
  #   1. here, on the origin nodes, so a node is unreachable even if DNS is
  #      ever pointed straight at it or the LB is bypassed;
  #   2. PROXY protocol on the LB service, so the app sees the true L3 peer and
  #      can reject anything that is not a Cloudflare edge address;
  #   3. Cloudflare Authenticated Origin Pulls (mTLS) at the TLS layer.
  # See README.md, "Ingress posture", for the full argument.
  cloudflare_cidrs = concat(var.cloudflare_ipv4_cidrs, var.cloudflare_ipv6_cidrs)

  # Outbound allowlist shared by both firewalls. TCP/UDP only: ICMP takes no
  # port and is declared as its own static rule below.
  #
  # A Hetzner Cloud Firewall with ANY outbound rule drops everything else, so
  # this list is exhaustive rather than illustrative and an omission is a
  # dependency the node cannot reach at all.
  egress_ports = var.restrict_egress ? [
    { protocol = "tcp", port = "80", description = "HTTP to package mirrors and upstreams that still 301 from :80" },
    { protocol = "tcp", port = "443", description = "HTTPS to music upstreams, WorkOS, R2 backups, Tailscale DERP" },
    # POSTGRES, AND IT WAS MISSING UNTIL THE FIRST NODE WAS ACTUALLY DEPLOYED.
    #
    # This list was written when the database was a node inside the private
    # network, where Hetzner Cloud Firewalls do not filter and no rule was
    # needed. The Neon migration moved the database to the public internet and
    # to a hostname the node dials on 5432, and nothing about that migration
    # touched this file - so the firewall said "443 is enough" while the
    # application's most important dependency had moved to a port the firewall
    # dropped. It is invisible in review because both halves are individually
    # correct, and invisible in `terraform plan` because a plan cannot know what
    # the node will dial. It surfaces as the migration step of the first deploy
    # hanging until its connect timeout.
    { protocol = "tcp", port = "5432", description = "Postgres to the Neon pooled and direct endpoints. Not a private-network hop any more: see docs/runbooks/neon-migration.md" },
    { protocol = "tcp", port = "53", description = "DNS over TCP for truncated or DNSSEC-signed answers" },
    { protocol = "udp", port = "53", description = "DNS" },
    { protocol = "udp", port = "123", description = "NTP. Token expiry and JWT validation both fail closed on clock skew" },
    # Tailscale dials peers on ephemeral UDP ports chosen by the far side, so a
    # narrow rule here silently degrades every session to DERP relay.
    { protocol = "udp", port = "1024-65535", description = "WireGuard/Tailscale NAT traversal to arbitrary peer ports" },
  ] : []
}

# --- BFF / application nodes -------------------------------------------------
resource "hcloud_firewall" "app" {
  name   = "${var.name_prefix}-app"
  labels = merge(var.labels, { role = "bff" })

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = local.cloudflare_cidrs
    description = "HTTP from Cloudflare edge only"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = local.cloudflare_cidrs
    description = "HTTPS from Cloudflare edge only"
  }

  # There is deliberately no inbound rule for 22. SSH is reached over Tailscale,
  # which arrives as WireGuard-encapsulated UDP, so opening 22 would add public
  # attack surface without adding any access the operator actually uses.
  rule {
    direction   = "in"
    protocol    = "udp"
    port        = tostring(var.tailscale_udp_port)
    source_ips  = local.anywhere
    description = "Tailscale direct WireGuard endpoint (no public SSH)"
  }

  # Break-glass SSH. Empty in every committed configuration; see the variable's
  # own documentation. Rendered as zero rules when the list is empty, so the
  # normal posture is byte-identical to having no such rule at all.
  dynamic "rule" {
    for_each = length(var.ssh_allowlist_cidrs) > 0 ? [1] : []
    content {
      direction   = "in"
      protocol    = "tcp"
      port        = "22"
      source_ips  = var.ssh_allowlist_cidrs
      description = "BREAK-GLASS SSH from operator allowlist. Must be removed after bootstrap."
    }
  }

  # Dropping ICMP wholesale black-holes path MTU discovery, which shows up much
  # later as large TLS responses hanging rather than as an obvious firewall bug.
  rule {
    direction   = "in"
    protocol    = "icmp"
    source_ips  = local.anywhere
    description = "ICMP for PMTUD and reachability checks"
  }

  dynamic "rule" {
    for_each = local.egress_ports
    content {
      direction       = "out"
      protocol        = rule.value.protocol
      port            = rule.value.port
      destination_ips = local.anywhere
      description     = rule.value.description
    }
  }

  dynamic "rule" {
    for_each = var.restrict_egress ? [1] : []
    content {
      direction       = "out"
      protocol        = "icmp"
      destination_ips = local.anywhere
      description     = "ICMP for PMTUD and diagnostics"
    }
  }
}

# --- Cache node --------------------------------------------------------------
# Was the Postgres node's firewall. Postgres moved to Neon; this now guards the
# shared Redis instances, and the posture is unchanged because it never depended
# on which daemon was listening.
resource "hcloud_firewall" "cache" {
  name   = "${var.name_prefix}-cache"
  labels = merge(var.labels, { role = "cache" })

  # No inbound rule for 6379 or 6380 exists, and adding one would be
  # meaningless: Hetzner Cloud Firewalls filter the public interface only, and
  # private-network traffic is never inspected. Redis is kept unreachable by
  # three independent mechanisms instead:
  #   1. the node has no public IPv4 at all (see modules/compute);
  #   2. the compose port bindings publish to the private address only;
  #   3. requirepass on both instances.
  # Items 2 and 3 belong to config management, not Terraform.
  rule {
    direction   = "in"
    protocol    = "udp"
    port        = tostring(var.tailscale_udp_port)
    source_ips  = local.anywhere
    description = "Tailscale direct WireGuard endpoint (no public SSH)"
  }

  # Break-glass SSH. Empty in every committed configuration; see the variable's
  # own documentation. Rendered as zero rules when the list is empty, so the
  # normal posture is byte-identical to having no such rule at all.
  dynamic "rule" {
    for_each = length(var.ssh_allowlist_cidrs) > 0 ? [1] : []
    content {
      direction   = "in"
      protocol    = "tcp"
      port        = "22"
      source_ips  = var.ssh_allowlist_cidrs
      description = "BREAK-GLASS SSH from operator allowlist. Must be removed after bootstrap."
    }
  }

  rule {
    direction   = "in"
    protocol    = "icmp"
    source_ips  = local.anywhere
    description = "ICMP for PMTUD and reachability checks"
  }

  dynamic "rule" {
    for_each = local.egress_ports
    content {
      direction       = "out"
      protocol        = rule.value.protocol
      port            = rule.value.port
      destination_ips = local.anywhere
      description     = rule.value.description
    }
  }

  dynamic "rule" {
    for_each = var.restrict_egress ? [1] : []
    content {
      direction       = "out"
      protocol        = "icmp"
      destination_ips = local.anywhere
      description     = "ICMP for PMTUD and diagnostics"
    }
  }
}
