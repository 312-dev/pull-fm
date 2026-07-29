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

  app_server_type = var.app_server_type
  db_server_type  = var.db_server_type
  app_node_count  = var.app_node_count

  app_firewall_id = module.firewall.app_firewall_id
  db_firewall_id  = module.firewall.db_firewall_id

  ssh_public_keys    = var.ssh_public_keys
  tailscale_auth_key = var.tailscale_auth_key

  enable_app_backups  = var.enable_app_backups
  enable_db_backups   = var.enable_db_backups
  db_data_volume_size = var.db_data_volume_size

  enable_proxy_protocol = var.enable_proxy_protocol

  db_delete_protection = var.db_delete_protection
  lb_delete_protection = var.lb_delete_protection

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
      content = module.compute.load_balancer_ipv4
    }
    api-aaaa = {
      name    = var.api_hostname
      type    = "AAAA"
      content = module.compute.load_balancer_ipv6
    }
    app-a = {
      name    = var.app_hostname
      type    = "A"
      content = module.compute.load_balancer_ipv4
    }
    app-aaaa = {
      name    = var.app_hostname
      type    = "AAAA"
      content = module.compute.load_balancer_ipv6
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
