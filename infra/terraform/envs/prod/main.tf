# Pull.fm - production composition root.
#
# NOT APPLIED YET. Phase 0 (docs/PLAN.md section 7) builds staging only; prod is
# cut over in Phase 6 behind Gate 6. This root exists now so that cutover is a
# terraform apply with a different tfvars file rather than a rushed copy of
# whatever staging happened to look like on the day.
#
# It is a byte-for-byte identical module graph to ../staging. Any difference
# between the two environments must be expressible as a variable; if it is not,
# the fix belongs in the module, not in a fork of this file.

locals {
  environment = "prod"
  name_prefix = "pullfm-${local.environment}"

  labels = {
    project     = "pull-fm"
    environment = local.environment
    managed_by  = "terraform"
  }

  # ---------------------------------------------------------------------------
  # THE NETWORK ZONE IS DERIVED FROM THE LOCATION. THIS ROOT DID NOT HAVE THIS
  # AND ../staging DID, WHICH MADE THE "IDENTICAL MODULE GRAPH" CLAIM ABOVE
  # FALSE IN THE ONE PLACE IT COSTS AN APPLY.
  # ---------------------------------------------------------------------------
  #
  # WHAT WAS WRONG. `module "network"` never passed `network_zone`, so
  # modules/network's default of "eu-central" applied. That is invisible and
  # correct while `var.location` is one of fsn1, nbg1 or hel1, and it becomes a
  # FAILED APPLY the moment it is not: a Hetzner server can only attach to a
  # subnet in its own network zone, so an `ash` node and an `eu-central` subnet do
  # not compose, and the error arrives during apply rather than during plan. The
  # US cutover made that reachable - modules/compute now accepts ash and hil, and
  # ../staging is running in ash - so this root was one tfvars line away from a
  # half-built production environment.
  #
  # It is added here with `var.location` still defaulting to fsn1, so today it
  # resolves to the same "eu-central" the module default was already supplying and
  # changes nothing. That is the point: the landmine is removed while it is still
  # free to remove, rather than on the day somebody sets location = "ash" during a
  # Phase 6 cutover. Whether prod's location SHOULD move to ash is a separate
  # decision with a server-type consequence (cax11 is ARM and EU-only), and it is
  # not made here.
  #
  # WHY A DERIVATION AND NOT A SECOND VARIABLE. Two variables that must agree are
  # two variables that will eventually disagree, and the disagreement here costs a
  # half-destroyed environment. Hetzner's site-to-zone mapping is a fact about the
  # vendor, not a choice. Read from GET /v1/locations on 2026-07-29. Kept
  # character-for-character identical to the ../staging local on purpose: two
  # copies that have drifted are worse than one copy in a module, and the next
  # person to touch either should be able to diff them.
  #
  # NOTE THAT CHANGING THIS REPLACES THE SUBNET. `network_zone` is ForceNew on
  # hcloud_network_subnet, so a location move across zones destroys and recreates
  # the subnet, and therefore every server attachment hanging off it.
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

  # ---------------------------------------------------------------------------
  # THIS ROOT IS NOT APPLIED, WHICH IS EXACTLY WHY THIS ARGUMENT IS HERE NOW
  # RATHER THAN LATER.
  # ---------------------------------------------------------------------------
  #
  # WHAT WAS WRONG. This call omitted `jurisdiction`, so
  # modules/backup-storage's old default of "eu" applied. Nothing had gone wrong
  # yet, because nothing here has ever been applied: `pull-fm-backups-prod` does
  # not exist in either jurisdiction (both R2 endpoints enumerated on
  # 2026-07-29). But the first Phase 6 apply would have CREATED an EU-pinned
  # bucket, under a residency posture that legal/privacy-policy.md now states as
  # United States only, and a jurisdiction is fixed at creation. The recovery from
  # that is a new bucket and a backup repository migration, on the day production
  # is being cut over.
  #
  # The module no longer has a default for this, so leaving it out is now a
  # plan-time error rather than a silent inheritance. It is written out anyway,
  # because "the module makes you say it" and "this root says it" are different
  # facts and a reviewer should be able to read the second one here.
  #
  # `default` is not a claim that the objects are in the United States. R2 offers
  # only `eu` and `fedramp`; `default` means Cloudflare may store them anywhere,
  # the location hint is a preference, and the control doing the real work is that
  # the objects are encrypted before upload under a key that has never been at
  # Cloudflare. See envs/staging/variables.tf above `backup_bucket_name`.
  jurisdiction = "default"
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
