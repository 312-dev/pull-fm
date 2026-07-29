# Pull.fm - staging composition root.
#
# Phase 0 builds staging only. prod is the same module graph with different
# variables (see ../prod), not a fork of it: any change that cannot be
# expressed as a variable belongs in the module, not here.

locals {
  environment = "staging"
  name_prefix = "pullfm-${local.environment}"

  labels = {
    project     = "pull-fm"
    environment = local.environment
    managed_by  = "terraform"
  }

  # ---------------------------------------------------------------------------
  # THE NETWORK ZONE IS DERIVED FROM THE LOCATION, AND IT USED TO BE AN UNSET
  # MODULE DEFAULT.
  # ---------------------------------------------------------------------------
  #
  # WHAT WAS WRONG. `module "network"` never passed `network_zone`, so
  # modules/network's default of "eu-central" applied. That was invisible and
  # correct while every accepted location was in eu-central, and it becomes a
  # failed apply the moment one is not: a Hetzner server can only attach to a
  # subnet in ITS OWN network zone, so an `ash` node and an `eu-central` subnet
  # do not compose. The error arrives during apply, after the old node has
  # already been destroyed.
  #
  # WHY A DERIVATION AND NOT A SECOND VARIABLE. Two variables that must agree
  # are two variables that will eventually disagree, and the disagreement here
  # costs a half-destroyed environment. Hetzner's site-to-zone mapping is a fact
  # about the vendor, not a choice, so it belongs in a lookup rather than in a
  # tfvars file somebody has to remember to edit twice. Read from
  # GET /v1/locations on 2026-07-29.
  #
  # NOTE THAT CHANGING THIS REPLACES THE SUBNET. `network_zone` is ForceNew on
  # hcloud_network_subnet, so a location move across zones destroys and recreates
  # the subnet, and therefore every server attachment hanging off it. That is
  # part of what makes the US move a destructive apply rather than a resize.
  network_zone = {
    fsn1 = "eu-central"
    nbg1 = "eu-central"
    hel1 = "eu-central"
    ash  = "us-east"
    hil  = "us-west"
  }[var.location]
}

# Cloudflare publishes its edge ranges here. Reading them live means a new
# Cloudflare range does not silently become a 15 percent packet loss on the
# origin. It also means the firewall can drift when Cloudflare publishes,
# which is the intended trade: Gate 0's zero-drift assertion is run against a
# fresh checkout, and a genuine upstream change should show up as a plan.
data "cloudflare_ip_ranges" "cloudflare" {}

module "network" {
  source = "../../modules/network"

  name_prefix     = local.name_prefix
  ip_range        = var.network_ip_range
  subnet_ip_range = var.subnet_ip_range
  network_zone    = local.network_zone
  labels          = local.labels

  delete_protection = var.network_delete_protection
}

module "firewall" {
  source = "../../modules/firewall"

  name_prefix           = local.name_prefix
  labels                = local.labels
  cloudflare_ipv4_cidrs = data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs
  cloudflare_ipv6_cidrs = data.cloudflare_ip_ranges.cloudflare.ipv6_cidrs
  restrict_egress       = var.restrict_egress
  ssh_allowlist_cidrs   = var.ssh_allowlist_cidrs
}

module "compute" {
  source = "../../modules/compute"

  name_prefix     = local.name_prefix
  labels          = local.labels
  location        = var.location
  network_id      = module.network.network_id
  subnet_ip_range = module.network.subnet_ip_range

  app_server_type   = var.app_server_type
  cache_server_type = var.cache_server_type
  app_node_count    = var.app_node_count

  # Both default FALSE, which is what makes this environment one node with Redis
  # co-located on it and no load balancer. Raising app_node_count without also
  # setting enable_cache_node is a plan-time error, on purpose: see the
  # validation in ../../modules/compute/variables.tf.
  enable_cache_node    = var.enable_cache_node
  enable_load_balancer = var.enable_load_balancer

  app_firewall_id   = module.firewall.app_firewall_id
  cache_firewall_id = module.firewall.cache_firewall_id

  ssh_public_keys    = var.ssh_public_keys
  tailscale_auth_key = var.tailscale_auth_key

  enable_app_backups   = var.enable_app_backups
  enable_cache_backups = var.enable_cache_backups

  enable_proxy_protocol = var.enable_proxy_protocol

  cache_delete_protection = var.cache_delete_protection
  lb_delete_protection    = var.lb_delete_protection

  # Servers cannot join a network before its subnet exists, and the subnet is
  # not in the servers' own dependency chain.
  depends_on = [module.network]
}

module "backup_storage" {
  source = "../../modules/backup-storage"

  account_id  = var.cloudflare_account_id
  bucket_name = var.backup_bucket_name
}

locals {
  # Keys are Terraform addresses and must stay stable; the name field is what
  # is actually published.
  dns_records = {
    api-a = {
      name    = var.api_hostname
      type    = "A"
      content = module.compute.ingress_ipv4
    }
    api-aaaa = {
      name    = var.api_hostname
      type    = "AAAA"
      content = module.compute.ingress_ipv6
    }
    app-a = {
      name    = var.app_hostname
      type    = "A"
      content = module.compute.ingress_ipv4
    }
    app-aaaa = {
      name    = var.app_hostname
      type    = "AAAA"
      content = module.compute.ingress_ipv6
    }
  }
}

module "dns" {
  source = "../../modules/dns"

  zone_id     = var.cloudflare_zone_id
  environment = local.environment

  # Every record is proxied. Unproxied would publish the Hetzner origin IP in
  # public DNS, which defeats the Cloudflare-only firewall rule entirely and
  # hands an attacker a direct path around WAF and rate limiting.
  records = { for k, r in local.dns_records : k => merge(r, { proxied = true }) }
}
