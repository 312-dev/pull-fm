# Adoption of the pre-existing Neon project.
#
# ---------------------------------------------------------------------------
# NO LIVE IDENTIFIER IS WRITTEN IN THIS FILE ANY MORE, AND IT USED TO BE FULL OF
# THEM. READ THIS BEFORE PUTTING ONE BACK.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. Every import id below used to be a string literal: the live
# branch ids and endpoint ids, in a tracked file, in a PUBLIC repository.
# `tools/check-public-identifiers.mjs` has a detector for each of those two
# shapes, because a Neon endpoint hostname is reachable from the internet with the
# credential as the only network control, and a branch id addresses a restorable
# copy of production data through the control plane. Eleven of the findings in that
# check's baseline came from this one file. The head of README.md meanwhile said
# the ids were "deliberately not written here; ask the control plane for them",
# which was true of every file except this one.
#
# The US cutover forced the issue rather than creating it. The baseline only
# shrinks, so replacing the EU literals with US literals could not be baselined:
# it would have been eleven NEW findings and a red gate.
#
# WHAT REPLACED THEM. Four variables with no defaults - `main_branch_id`,
# `main_endpoint_id`, `staging_branch_id`, `staging_endpoint_id` - supplied from
# `terraform.tfvars`, which `.gitignore` already covers. See the long block above
# them in variables.tf for why an import id cannot come from a data source or an
# output, and why deleting these blocks after the first apply was considered and
# rejected.
#
# THE SHORT VERSION OF THAT REJECTION, because it is the thing most likely to be
# undone by somebody tidying up: these blocks are INERT while state is intact.
# Their whole value is what happens when it is not. A plan against empty or
# rolled-back state with no import blocks does not fail - it proposes CREATING A
# SECOND NEON PROJECT, and `prevent_destroy` does not catch a create.
#
# ---------------------------------------------------------------------------
# HOW TO REBUILD terraform.tfvars FROM THE CONTROL PLANE
# ---------------------------------------------------------------------------
#
# This is the authority for these values, not a note somebody wrote down. An id
# transcribed by hand is an id that can be stale, and this root has already been
# repointed from one project to another once.
#
#   source ../lib/credentials.sh && pullfm_load_credentials neon
#   P=<project_id, the default of var.project_id in variables.tf>
#
#   curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
#     "https://console.neon.tech/api/v2/projects/$P/branches" |
#     python3 -c 'import json,sys; [print(("main_branch_id" if b["default"] else "staging_branch_id"), "=", repr(b["id"]), "#", b["name"]) for b in json.load(sys.stdin)["branches"]]'
#
#   curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
#     "https://console.neon.tech/api/v2/projects/$P/endpoints" |
#     python3 -c 'import json,sys; [print(e["id"], e["branch_id"], e["type"]) for e in json.load(sys.stdin)["endpoints"]]'
#
# Match each endpoint to its branch by `branch_id`. There is exactly one
# `read_write` endpoint per branch. terraform.tfvars.example carries the same
# commands next to the empty assignments.
#
# ---------------------------------------------------------------------------
# WHAT WAS ADOPTED, AND WHAT CHANGED ABOUT THAT ON 2026-07-29
# ---------------------------------------------------------------------------
#
# This root adopted the EU project `steep-frost-83698289` (`pull-fm`,
# aws-eu-central-1) with FOUR import blocks: the project, its database, its owner
# role and its main-branch endpoint. `neon_branch.staging` and
# `neon_endpoint.staging` had none, because on the EU project they were genuinely
# CREATED by the first apply.
#
# It now adopts `cold-brook-02833828` (`pull-fm-us`, aws-us-east-1) with SIX. Read
# back from the live control plane on 2026-07-29 - names and non-identifying
# properties only, since the ids belong in terraform.tfvars:
#
#   GET /projects/<project_id>
#     org_id      org-tiny-leaf-89756764   ("312.dev LLC", subscription launch_v3)
#     name        pull-fm-us
#     region_id   aws-us-east-1            (Northern Virginia)
#     pg_version  18
#     provisioner k8s-neonvm
#     history_retention_seconds 604800     (7 days)
#     store_passwords true
#     branches_limit 5000, branch_logical_size_limit 16 TiB
#     default_endpoint_settings 0.25 to 8 CU, suspend_timeout_seconds 0
#
#   GET /projects/<project_id>/branches
#     "main"     default true,  protected false
#     "staging"  default false, protected false, parent is main
#
#   GET /projects/<project_id>/branches/<main_branch_id>/{databases,roles}
#     neondb owned by neondb_owner; role neondb_owner
#
#   GET /projects/<project_id>/endpoints
#     one read_write endpoint per branch, both pooler_enabled FALSE,
#     both 0.25 to 8 CU, both suspend_timeout_seconds 0
#
# WHY REPOINTING COULD NOT BE DONE BY EDITING `var.project_id`. A Neon project's
# region is immutable and `region_id` is ForceNew, so "the same resource in a
# different region" is not something Terraform can express. Pointing the
# configuration at a new project id with the old project still in state plans a
# destroy-and-create of `neon_project`, which for this resource means deleting a
# live database, and `prevent_destroy` then fails the plan. That lock working is
# what forced a state operation:
#
#   terraform state rm neon_project.pullfm neon_database.main neon_role.owner \
#                      neon_endpoint.main neon_branch.staging neon_endpoint.staging
#
# `state rm` forgets a resource without touching the object, so nothing in either
# project was destroyed by it. The applied plan was 6 imported, 0 added, 3
# changed, 0 destroyed.
#
# THE TRAP, AND IT IS THE ONLY REASON THIS FILE GREW BY TWO BLOCKS. On the US
# project the staging branch and its endpoint ALREADY EXISTED: cut by hand during
# the cutover, migrated, and serving api-staging.pull.fm. Repointing with only the
# original four import blocks produces a plan that reads "2 to add" and looks
# entirely reasonable, and applying it cuts a SECOND `staging` branch with a
# second endpoint, leaving the live one unmanaged and every connection string in
# 1Password pointing at the copy Terraform does not know about. Nothing errors.
# Neon does not require branch names to be unique.
#
# `pooler_enabled FALSE` on both endpoints was real drift and not a transcription
# error: both were created outside Terraform, and NEON IGNORES `pooler_enabled` AT
# CREATION while honouring it on update. main.tf documents that from the first EU
# apply. Both `-pooler` hostnames were nonetheless verified to accept connections
# before the repoint, so the first apply corrected what Neon REPORTS rather than
# switching a working path on.
#
# BRANCH NAMING CONVENTION: `main` is the default branch and is what production
# connects to. Every environment branch is a CHILD of `main` and is named after
# the environment it serves, so today that is exactly `staging`. The convention
# is recorded in docs/runbooks/neon-migration.md as well, because a naming
# scheme that only exists in one file drifts the first time somebody adds a
# branch from the console.
#
# The default branch is deliberately NOT imported as a `neon_branch` resource.
# It is the project's own default branch, already represented by the project
# resource, and managing it twice would put two resources in a fight over one
# object. A consequence worth knowing: because this configuration never declares
# the default branch's name, renaming it in the console is invisible to
# `terraform plan`. The main_branch_name output exists so the name is at least
# visible in `terraform output` when it changes.
#
# Import blocks rather than `terraform import`: they are declarative, they show
# up in `terraform plan` before anything is written to state, and they are
# reviewable in a pull request.

import {
  to = neon_project.pullfm
  id = var.project_id
}

# Composite identifier: <project_id>/<branch_id>/<name>.
import {
  to = neon_database.main
  id = "${var.project_id}/${var.main_branch_id}/${var.database_name}"
}

import {
  to = neon_role.owner
  id = "${var.project_id}/${var.main_branch_id}/${var.owner_role_name}"
}

# Composite identifier: <project_id>/<endpoint_id>.
import {
  to = neon_endpoint.main
  id = "${var.project_id}/${var.main_endpoint_id}"
}

# --- the two blocks that did not exist before ---------------------------------
#
# Without these, a repointed apply adds a SECOND staging branch and a SECOND
# endpoint on the US project instead of adopting the live ones. See the long
# note above; this is not a defensive extra, it is the difference between
# adopting production and forking it.

# Composite identifier: <project_id>/<branch_id>.
import {
  to = neon_branch.staging
  id = "${var.project_id}/${var.staging_branch_id}"
}

# Composite identifier: <project_id>/<endpoint_id>.
import {
  to = neon_endpoint.staging
  id = "${var.project_id}/${var.staging_endpoint_id}"
}
