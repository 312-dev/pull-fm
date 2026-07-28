resource "cloudflare_dns_record" "this" {
  for_each = var.records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  proxied = each.value.proxied

  # Cloudflare requires ttl = 1 ("automatic") on proxied records and rejects
  # anything else, so the explicit ttl only applies to unproxied ones.
  ttl = each.value.proxied ? 1 : each.value.ttl

  comment = "pull-fm ${var.environment} / terraform"
}
