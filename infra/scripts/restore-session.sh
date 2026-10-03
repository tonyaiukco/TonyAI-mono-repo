# Source from the repository root in Bash or zsh. No shell option changes.
_tonyai_restore_session() {
  local subscription="${1:-}" group="${2:-}" exports
  # Invalidate the previous session first; a failed restore must not leave usable targets.
  unset AZURE_SUBSCRIPTION_ID RESOURCE_GROUP GROUP_ID PREFIX RELEASE_SHA GITHUB_REPOSITORY
  unset ACR_NAME ACR_HOST VAULT_NAME VAULT_ID API_IDENTITY_ID LOGS_NAME ACA_DEFAULT_DOMAIN
  unset WEB_ORIGIN API_ORIGIN AZURE_TENANT_ID SUPABASE_PROJECT_REF SUPABASE_URL
  unset AZURE_CLIENT_ID DEPLOYER_OBJECT_ID API_DIGEST WEB_DIGEST CANDIDATE_API_DIGEST CANDIDATE_WEB_DIGEST
  unset DATABASE_SECRET_VERSION BACKEND_SECRET_VERSION
  if [[ -z "$subscription" || -z "$group" ]]; then
    printf '%s\n' 'Usage: source infra/scripts/restore-session.sh <subscription-id> <group>' >&2
    return 1
  fi
  exports=$(python3 "${TONYAI_INFRA_SCRIPTS:-infra/scripts}/session_resources.py" "$subscription" "$group") || return 1
  az account set --subscription "$subscription" || return 1
  eval "$exports"
  printf '%s\n' 'PASS: staging session restored. Empty optional IDs mean their setup step is still pending.'
}
foundation_output() {
  case "$1" in
    vaultId) printf '%s\n' "${VAULT_ID:?Restore the staging session first}" ;;
    apiIdentityId) printf '%s\n' "${API_IDENTITY_ID:?Restore the staging session first}" ;;
    logsName) printf '%s\n' "${LOGS_NAME:?Restore the staging session first}" ;;
    *) printf '%s\n' 'Unsupported resource lookup' >&2; return 1 ;;
  esac
}
_tonyai_restore_session "$@"
