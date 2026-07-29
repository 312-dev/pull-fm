# Assertions about the connection hostnames.
#
# These exist because of a real bug rather than as a formality. An earlier
# revision derived the staging pooled host by appending "-pooler" to
# `neon_endpoint.staging.host`. That attribute is the DIRECT host while pooling
# is off and the POOLED host once it is on, because the provider rewrites it
# (see the long comment on `locals` in main.tf), so after the pooler was enabled
# the module wanted to publish:
#
#   staging_host_direct   ep-super-wind-asbuczm7-pooler.c-4...          (pooled, mislabelled)
#   staging_host_pooled   ep-super-wind-asbuczm7-pooler-pooler.c-4...   (does not resolve)
#
# Neither is visible as an error at plan time. Both fail at connect time, which
# means in production, at whatever hour production notices. The whole class is
# worth a permanent assertion.
#
# WHY A `check` BLOCK AND NOT ONLY POSTCONDITIONS. A failed `check` is a
# WARNING: it does not stop a plan or an apply. That is the right severity here
# and the wrong one there, so the guards are layered:
#
#   postcondition on neon_endpoint.staging  ERRORS. Guards the two raw inputs
#                                           (endpoint id, proxy_host).
#   precondition on the *_host_pooled       ERRORS. Guards the derivation at the
#   outputs                                 point the value is published, so a
#                                           wrong hostname cannot be read out of
#                                           `terraform output` at all.
#   check block below                       WARNS on every plan, covering both
#                                           branches together in one named
#                                           place, including the main-branch
#                                           attributes that come from the
#                                           provider and have no output of their
#                                           own to hang a precondition on.
#
# The invariant, stated once: the pooled host is the direct host with "-pooler"
# appended to its first label. Exactly one such marker, on exactly one side.
#
# ALL THREE ASSERTIONS ARE NEEDED, and the middle one is the weakest. Evaluated
# against the exact values the buggy revision wanted to publish:
#
#   assertion                  correct pair   buggy pair
#   direct contains no -pooler  pass          FAIL
#   pooled is direct + one      pass          pass   <- does not catch it
#   pooled has no -pooler-pooler pass         FAIL
#
# The middle assertion passes on the broken pair because both sides were shifted
# by one "-pooler", so their RELATIONSHIP still held while both values were
# wrong. A relative check cannot detect an error applied uniformly to both
# operands; that is what the two absolute checks are for.

check "endpoint_hostname_derivation" {
  # --- staging, derived by this module -------------------------------------

  assert {
    condition     = !strcontains(local.staging_direct_host, "-pooler")
    error_message = "staging_host_direct is '${local.staging_direct_host}', which contains '-pooler'. The direct host must not: that is the pooled name, and anything using it for migrations would be running DDL and session advisory locks through a transaction pooler, which fails silently rather than loudly."
  }

  assert {
    condition     = local.staging_pooled_host == replace(local.staging_direct_host, "/^([^.]+)\\./", "$1-pooler.")
    error_message = "The staging hosts do not differ by exactly one '-pooler' on the first label. direct='${local.staging_direct_host}' pooled='${local.staging_pooled_host}'. They are meant to be the same endpoint reached two ways; if they have diverged, one of them is a hostname that does not exist."
  }

  assert {
    condition     = !strcontains(local.staging_pooled_host, "-pooler-pooler")
    error_message = "staging_host_pooled is '${local.staging_pooled_host}'. A doubled '-pooler' does not resolve in DNS. This is the exact regression that shipped once: it means the pooled host was derived from an attribute that was already pooled."
  }

  # --- main, derived by the provider ----------------------------------------
  #
  # `neon_project` computes database_host and database_host_pooler from the raw
  # API host, so this pair has never been wrong. Asserted anyway, because it is
  # the same invariant and because the cost of noticing a provider regression
  # here is one line.

  assert {
    condition     = !strcontains(neon_project.pullfm.database_host, "-pooler")
    error_message = "main_host_direct is '${neon_project.pullfm.database_host}', which contains '-pooler'. DATABASE_URL_DIRECT is built from this and the migration runner needs a real direct endpoint."
  }

  assert {
    condition     = neon_project.pullfm.database_host_pooler == replace(neon_project.pullfm.database_host, "/^([^.]+)\\./", "$1-pooler.")
    error_message = "The main-branch hosts do not differ by exactly one '-pooler'. direct='${neon_project.pullfm.database_host}' pooled='${neon_project.pullfm.database_host_pooler}'. Both come from the provider, so this indicates a provider change rather than a mistake in this configuration."
  }

  assert {
    condition     = !strcontains(neon_project.pullfm.database_host_pooler, "-pooler-pooler")
    error_message = "main_host_pooled is '${neon_project.pullfm.database_host_pooler}', which has a doubled '-pooler' and does not resolve."
  }
}
