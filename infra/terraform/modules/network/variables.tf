variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names, e.g. pullfm-staging."
}

variable "ip_range" {
  type        = string
  description = "CIDR for the whole private network. Must not overlap another environment: overlapping ranges make a future network peering impossible."
}

variable "subnet_ip_range" {
  type        = string
  description = "CIDR of the single node subnet, carved out of ip_range."
}

variable "network_zone" {
  type        = string
  description = "Hetzner network zone. fsn1, nbg1 and hel1 all live in eu-central."
  default     = "eu-central"
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to every resource in this module."
}

variable "delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the network."
  default     = true
}
