variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names, e.g. pullfm-staging."
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to every resource in this module."
}

variable "location" {
  type        = string
  description = "Hetzner location. Must be an EU site: Pull.fm processes EU personal data and the GDPR posture assumes EU-only hosting."

  validation {
    condition     = contains(["fsn1", "nbg1", "hel1"], var.location)
    error_message = "location must be an EU Hetzner site (fsn1, nbg1 or hel1). US and APAC sites would break the EU-only data residency assumption."
  }
}

variable "network_id" {
  type        = string
  description = "ID of the private network to attach every node to."
}

variable "subnet_ip_range" {
  type        = string
  description = "CIDR of the node subnet. Private addresses are derived from it so they stay stable across rebuilds."
}

variable "image_name" {
  type        = string
  description = "Base image name. Resolved to an ARM64 image ID by the hcloud_image data source."
  default     = "ubuntu-24.04"
}

# --- sizing ------------------------------------------------------------------

variable "app_server_type" {
  type        = string
  description = "Server type for BFF nodes. Default cax11 (2 vCPU ARM / 4 GB), down from cax21 (8 GB), because the node was provisioned for traffic that does not exist. The 4 GB has to hold more than it used to, since Redis is co-located pre-launch: a 768 MB BFF, two Redis instances capped at 256 MB and 128 MB, nginx, and at most one 384 MB scheduled-job container at a time. That is about 1.6 GB, so half the machine is still free. Going back to cax21 is the right move the first time real load arrives, and it is a variable rather than an edit for exactly that reason."
  default     = "cax11"

  validation {
    # CAX (ARM) remains preferred on price/perf, but as of 2026-07-28 it is out
    # of stock in every EU datacenter, so the allowlist also admits the cpx_1_
    # series. The 150-210 percent June 2026 increase applied to the US region
    # and to the cpx_2_ generation; in nbg1/hel1 cpx21 is EUR 10.99 and cpx31 is
    # EUR 20.49, which is within the original CAX budget. The cpx_2_ and ccx
    # families stay excluded because they are 2-3x the price for the same specs.
    condition = anytrue([
      startswith(var.app_server_type, "cax"),
      contains(["cpx11", "cpx12", "cpx21", "cpx22", "cpx31", "cpx41", "cpx51"], var.app_server_type),
    ])
    error_message = "app_server_type must be a CAX (ARM) type or one of the legacy-priced cpx_1_ types. The cpx_2_ and ccx families cost 2-3x for identical specs; see docs/PLAN.md section 2."
  }
}

variable "cache_server_type" {
  type        = string
  description = "Server type for the shared Redis node. Sized DOWN from the cax31 the Postgres node used, because the workload is now two Redis instances capped at 256 MB and 128 MB rather than a database with a page cache: 384 MB of data plus the OS fits inside the smallest type in the allowlist with room to spare. See modules/compute/main.tf for why this node was not folded into the BFF nodes altogether."
  default     = "cax11"

  validation {
    condition = anytrue([
      startswith(var.cache_server_type, "cax"),
      contains(["cpx11", "cpx12", "cpx21", "cpx22", "cpx31", "cpx41", "cpx51"], var.cache_server_type),
    ])
    error_message = "cache_server_type must be a CAX (ARM) type or one of the legacy-priced cpx_1_ types. See docs/PLAN.md section 2."
  }
}

variable "app_node_count" {
  type        = number
  description = "Number of BFF nodes. ONE pre-launch. Two is the minimum that survives a single host failure and permits a rolling deploy with zero non-2xx (Gate 6), and going there is a deliberate scale step with two prerequisites, both enforced below."
  default     = 1

  validation {
    condition     = var.app_node_count >= 1 && var.app_node_count <= 8
    error_message = "app_node_count must be between 1 and 8."
  }

  # ---------------------------------------------------------------------------
  # THE GUARD. This is the one validation in this repository that exists to stop
  # a cost decision from silently becoming a terms violation.
  #
  # Redis holds the token bucket that keeps the whole service under MusicBrainz's
  # limit. That limit is ONE REQUEST PER SECOND FOR THE ENTIRE SERVICE, per IP,
  # and Gate 1 asserts it at the network layer. With one app node and Redis
  # co-located on it there is exactly ONE bucket, so the invariant holds by
  # construction. With two app nodes each running their own local Redis there are
  # TWO buckets, each of which correctly honours 1 req/s, and the service emits
  # 2 req/s while every node's own metrics show perfect compliance. MetaBrainz
  # revokes API access for that, without appeal and without a second chance, and
  # no part of the product works without MusicBrainz.
  #
  # The same argument applies to every published rate limit and quota, which are
  # counted in the same Redis: per-node counters multiply every limit by the node
  # count without changing a line of the code that enforces them.
  #
  # So scaling out is not "set the count to 2". It is "externalize Redis first,
  # then set the count to 2", and this makes the wrong order a plan-time error
  # rather than a discovery made by email from MetaBrainz.
  # ---------------------------------------------------------------------------
  validation {
    condition     = var.app_node_count <= 1 || var.enable_cache_node
    error_message = "app_node_count > 1 requires enable_cache_node = true. Redis holds the MusicBrainz token bucket, and MusicBrainz permits 1 request per second for the ENTIRE service per IP (Gate 1 asserts it). With Redis co-located on each app node, N nodes means N independent buckets and the service emits N req/s while each node reports compliance; MetaBrainz revokes API access for that. Externalize Redis onto the cache node first, then raise the node count."
  }

  # Ingress at one node is a proxied Cloudflare record pointed straight at that
  # node's public address (see modules/compute/main.tf). That has exactly one
  # target, so a second node added without a load balancer would be provisioned,
  # billed, and never sent a request.
  validation {
    condition     = var.app_node_count <= 1 || var.enable_load_balancer
    error_message = "app_node_count > 1 requires enable_load_balancer = true. At one node the DNS records point directly at that node's public IP, which can only name one target, so additional nodes would receive no traffic at all."
  }
}

variable "enable_cache_node" {
  type        = bool
  description = <<-EOT
    Provision a SEPARATE node for the shared Redis instances.

    FALSE pre-launch, which is the change that removes a whole server and its
    IPv4 from the bill. Redis then runs on the application node itself, which is
    correct at ONE node and catastrophic at more than one: see the guard on
    app_node_count. The two Redis instances are capped at 256 MB and 128 MB, so
    they fit beside nginx and a 768 MB BFF on the app node with room left.

    TRUE is the documented scale step and the only supported way to run more than
    one application node. Nothing about the node was deleted to make this
    optional: the server resource, the firewall attachment, the private address
    and the bootstrap script in infra/staging/cache all still exist and still
    work. What changed is which value is the default.
  EOT
  default     = false
}

variable "enable_load_balancer" {
  type        = bool
  description = <<-EOT
    Provision the Hetzner load balancer and point ingress at it.

    FALSE pre-launch. At one application node a load balancer is EUR 8.49/mo to
    round-robin across a single target, and Cloudflare is already in front of the
    origin doing the part that matters. With it false, the proxied Cloudflare DNS
    records point straight at the application node's public addresses.

    TRUE is required for more than one application node and is what Gate 6's
    rolling deploy needs. Turning it on is not only a Terraform change: the
    origin's nginx must switch to PROXY protocol in the same step, because the LB
    runs TCP passthrough with proxyprotocol enabled and a listener that does not
    expect a PROXY header answers 400 to every connection. See
    infra/staging/README.md for the two-sided procedure.
  EOT
  default     = false
}

variable "load_balancer_type" {
  type        = string
  description = "Hetzner load balancer type. Only used when enable_load_balancer is true."
  default     = "lb11"
}

# --- access ------------------------------------------------------------------

variable "ssh_public_keys" {
  type        = map(string)
  description = "Map of operator name to OpenSSH public key. Public keys are not secrets; the matching private keys never appear anywhere in this repo."
  default     = {}
}

variable "app_firewall_id" {
  type        = string
  description = "Firewall to attach to BFF nodes."
}

variable "cache_firewall_id" {
  type        = string
  description = "Firewall to attach to the shared Redis node."
}

variable "tailscale_auth_key" {
  type        = string
  description = "Optional single-use, pre-authorized, ephemeral Tailscale auth key used once at first boot. Prefer leaving this null and enrolling out of band: cloud-init is stored in Terraform state and is readable from the Hetzner API for the life of the server, so any key placed here should be treated as burned after first boot."
  sensitive   = true
  default     = null
}

variable "admin_user" {
  type        = string
  description = "Unprivileged sudo account created by cloud-init. Root login over SSH is disabled."
  default     = "pullfm"
}

# --- durability --------------------------------------------------------------

variable "enable_app_backups" {
  type        = bool
  description = "Hetzner automatic backups on BFF nodes. BFF nodes are stateless and rebuilt from config management, so this is normally wasted spend."
  default     = false
}

variable "enable_cache_backups" {
  type        = bool
  description = "Hetzner automatic backups on the Redis node. FALSE now, where the Postgres node had it TRUE. A whole-machine snapshot was the cheap rollback for a database whose state could not be rebuilt; a cache node's state is a cache and a set of counters with a window measured in minutes, so a snapshot of one is a snapshot of nothing worth restoring."
  default     = false
}

variable "cache_delete_protection" {
  type        = bool
  description = "Hetzner-side delete and rebuild protection on the Redis node. Defaults FALSE, where the Postgres node defaulted TRUE: destroying it costs a cold cache and a reset rate-limit window, not data. The protection was there to stop somebody deleting the only copy of the users' data, and the only copy of the users' data is now Neon's problem."
  default     = false
}

variable "lb_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the load balancer. Destroying the LB changes its public IP, which invalidates the DNS records and every cached A record downstream."
  default     = true
}

# --- public addressing -------------------------------------------------------

variable "cache_public_ipv4_enabled" {
  type        = bool
  description = "Give the Redis node a public IPv4. Default false: an interface that does not exist cannot be exposed by a mistaken firewall edit. Also saves the IPv4 surcharge."
  default     = false
}

variable "cache_public_ipv6_enabled" {
  type        = bool
  description = "Give the Redis node a public IPv6. Default true so apt and the Tailscale coordination server are reachable without a NAT hop. Both are dual-stack."
  default     = true
}

# --- load balancer behaviour -------------------------------------------------

variable "enable_proxy_protocol" {
  type        = bool
  description = "Enable PROXY protocol on LB services. Only has any effect when enable_load_balancer is true, because it configures the LB listeners and nothing else. Required on that path for the origin to see the true L3 peer, which is what lets nginx reject any connection that did not come from a Cloudflare edge address. The origin MUST be configured to parse it before this is enabled or every connection fails with a 400; on the direct path nginx must NOT be configured to parse it, for the same reason in reverse. See PULLFM_INGRESS in infra/staging/app/bootstrap.sh."
  default     = true
}

variable "health_check_path" {
  type        = string
  description = "HTTP path the LB polls to decide target health."
  default     = "/healthz"
}

variable "health_check_port" {
  type        = number
  description = "Port the LB polls for health. Kept on plain HTTP so a certificate problem does not masquerade as an application outage."
  default     = 80
}
