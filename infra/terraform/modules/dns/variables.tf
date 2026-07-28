variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for pull.fm. A public identifier, visible on the zone overview page; not a credential."
}

variable "environment" {
  type        = string
  description = "Environment name, used in the record comment so a human reading the Cloudflare UI knows which state file owns the record."
}

variable "records" {
  type = map(object({
    name    = string
    type    = string
    content = string
    proxied = optional(bool, true)
    ttl     = optional(number, 1)
  }))
  description = "Records to manage, keyed by a stable logical name (for example api-a). The key is the Terraform address, so renaming it destroys and recreates the record; the name field is what appears in DNS."

  validation {
    condition     = alltrue([for r in var.records : contains(["A", "AAAA", "CNAME"], r.type)])
    error_message = "This module only manages A, AAAA and CNAME records. TXT records for domain verification are intentionally excluded: they are issued out of band and would fight with whoever created them."
  }
}
